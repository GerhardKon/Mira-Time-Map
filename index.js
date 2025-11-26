require('dotenv').config();
const fs = require('fs');
const { Telegraf } = require('telegraf');
const fetch = require('node-fetch');
const sqlite3 = require('sqlite3').verbose();

// Загружаем данные из JSON-файлов
const characters = JSON.parse(fs.readFileSync('characters.json', 'utf8'));
const sources = JSON.parse(fs.readFileSync('sources.json', 'utf8'));

const bot = new Telegraf(process.env.BOT_TOKEN);
const dbPath = process.env.DATA_DIR ? `${process.env.DATA_DIR}/users.db` : './users.db';
const db = new sqlite3.Database(dbPath);

// Универсальная функция для обращения к разным AI
async function askAI(history, system) {
  const provider = process.env.AI_PROVIDER || 'groq'; // По умолчанию Groq

  const messages = [
    { role: "system", content: system },
    ...history
  ];

  console.log(`Запрос в ${provider} →`, JSON.stringify(messages).substring(0, 200) + '...');

  try {
    if (provider === 'openai') {
      // Проверяем, есть ли ключ
      if (!process.env.OPENAI_API_KEY) {
        console.error('КРИТИЧЕСКАЯ ОШИБКА: AI_PROVIDER=openai, но OPENAI_API_KEY не найден!');
        return 'Ошибка конфигурации: ключ OpenAI не найден.';
      }
      
      // СОЗДАЕМ КЛИЕНТ OPENAI ТОЛЬКО СЕЙЧАС, ВНУТРИ IF
      const { OpenAI } = require('openai');
      const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

      const response = await openai.chat.completions.create({
        model: 'gpt-4o',
        messages: messages,
        temperature: 0.7,
        max_tokens: 300,
      });
      return response.choices[0].message.content.trim();

    } else {
      // --- ЛОГИКА ДЛЯ GROQ (по умолчанию) ---
      const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${process.env.GROQ_API_KEY}`
        },
        body: JSON.stringify({
          model: 'llama-3.1-8b-instant',
          messages: messages,
          temperature: 0.7,
          max_tokens: 300,
        })
      });

      if (!response.ok) {
        const errorData = await response.json();
        console.error('Groq API ошибка:', response.status, errorData);
        return 'ИИ-сервис временно недоступен. Попробуй позже.';
      }

      const data = await response.json();
      return data.choices[0].message.content.trim();
    }

  } catch (error) {
    console.error(`Ошибка при запросе к ${provider}:`, error.message);
    return 'Произошла ошибка связи с ИИ-сервисом.';
  }
}


// /start
bot.start(async (ctx) => {
  const user = await getUser(ctx.from.id);
  const keyboard = characters.map(ch => [{
    text: (user.unlocked.includes(ch.id) ? '✅ ' : '🔒 ') + ch.name, // Небольшое улучшение UI
    callback_data: ch.id
  }]);

  ctx.reply(
    `*Добро пожаловать в TimeTravel Chat!*\nВыбери собеседника из прошлого:`,
    { parse_mode: 'Markdown', reply_markup: { inline_keyboard: keyboard } }
  );
});

// Выбор персонажа
bot.on('callback_query', async (ctx) => {
  const charId = ctx.callbackQuery.data;
  const character = characters.find(c => c.id === charId);
  const user = await getUser(ctx.from.id);

  if (!character) return ctx.answerCbQuery('Ошибка');
  // ИСПРАВЛЕНИЕ 1: Проверяем ID, а не весь объект
  if (!user.unlocked.includes(character.id)) return ctx.answerCbQuery('Этот персонаж еще не разблокирован!');

  user.current_char = charId;
  user.history = []; // Сбрасываем историю при смене персонажа
  updateUser(ctx.from.id, user);

  await ctx.answerCbQuery(`Выбран: ${character.name}`);
  // ИСПРАВЛЕНИЕ 2: Используем правильное имя переменной 'character'
  await ctx.reply(`Ты общаешься с *${character.name}*\n\n${character.greeting || "Пиши что угодно!"}`, { parse_mode: 'Markdown' });
});

// Сообщения
// Сообщения
// Сообщения
bot.on('text', async (ctx) => {
  try {
    const user = await getUser(ctx.from.id);

    if (!user.current_char) {
      return ctx.reply('Сначала выбери персонажа через /start');
    }

    const char = characters.find(c => c.id === user.current_char);
    
    user.history.push({ role: 'user', content: ctx.message.text });
    const answer = await askAI(user.history, char.system);
    user.history.push({ role: 'assistant', content: answer });

    if (user.history.length > 10) {
        user.history = user.history.slice(-10);
    }

    user.messages += 1;
    let newUnlock = null;
    for (const ch of characters) {
      if (!user.unlocked.includes(ch.id) && ch.unlock_after_messages && user.messages >= ch.unlock_after_messages) {
        user.unlocked.push(ch.id);
        newUnlock = ch.name;
      }
    }

    updateUser(ctx.from.id, user);

    if (newUnlock) {
      await ctx.reply(`Поздравляю! Ты разблокировал нового персонажа: *${newUnlock}*!`, { parse_mode: 'Markdown' });
    }

    // --- НОВАЯ ЛОГИКА ДЛЯ ССЫЛОК ---
    let finalMessage = answer;
    if (char.id === 'einstein') {
      // Проверяем, содержит ли ответ ключевую фразу
      if (answer.toLowerCase().includes('поделиться ссылкой') || answer.toLowerCase().includes('подробный материал')) {
        // Ищем, какая тема из нашего словаря есть в ответе
        for (const topic in sources) {
          if (answer.toLowerCase().includes(topic)) {
            finalMessage += `\n\n🔗 Вот полезная ссылка по теме: ${sources[topic]}`;
            break; // Добавляем только одну ссылку
          }
        }
      }
    }

    await ctx.reply(finalMessage);

  } catch (error) {
    console.error('Критическая ошибка при обработке сообщения:', error);
    await ctx.reply('Вынужден отлучиться ненадолго.');
  }
});

// ЗАПУСК с корректным завершением
bot.launch();

process.once('SIGINT', () => {
  console.log("\nПолучен SIGINT. Останавливаю бота...");
  db.close((err) => {
    if (err) {
      console.error(err.message);
    }
    console.log('Соединение с БД закрыто.');
    bot.stop('SIGINT');
  });
});

process.once('SIGTERM', () => {
  console.log("\nПолучен SIGTERM. Останавливаю бота...");
  db.close((err) => {
    if (err) {
      console.error(err.message);
    }
    console.log('Соединение с БД закрыто.');
    bot.stop('SIGTERM');
  });
});


console.log('TimeTravel Bot запущен! Иди в Telegram → /start');