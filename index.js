// ===================================================================
// TimeTravel Bot - Упрощенная версия (только Groq)
// ===================================================================

require('dotenv').config();
const fs = require('fs');
const { Telegraf } = require('telegraf');
const fetch = require('node-fetch');
const sqlite3 = require('sqlite3').verbose();

// Загружаем персонажей и источники
const characters = JSON.parse(fs.readFileSync('characters.json', 'utf8'));
const sources = JSON.parse(fs.readFileSync('sources.json', 'utf8'));

// Инициализируем бота и БД
const bot = new Telegraf(process.env.BOT_TOKEN);
const dbPath = process.env.DATA_DIR ? `${process.env.DATA_DIR}/users.db` : './users.db';
const db = new sqlite3.Database(dbPath);

// Создаем таблицу в БД, если ее нет
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS users (
    user_id INTEGER PRIMARY KEY,
    messages INTEGER DEFAULT 0,
    unlocked TEXT DEFAULT 'einstein',
    current_char TEXT DEFAULT NULL,
    history TEXT DEFAULT '[]'
  )`);
  console.log('База данных готова к работе.');
});

// ===================================================================
// ФУНКЦИИ
// ===================================================================

// Функция для обращения к Groq
async function askAI(history, system) {
  const messages = [
    { role: "system", content: system },
    ...history
  ];

  console.log(`Запрос в Groq →`, JSON.stringify(messages).substring(0, 200) + '...');

  try {
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

  } catch (error) {
    console.error('Ошибка при запросе к Groq:', error.message);
    return 'Произошла ошибка связи с ИИ-сервисом.';
  }
}

// Функции для работы с БД
async function getUser(userId) {
  return new Promise((resolve) => {
    db.get(`SELECT * FROM users WHERE user_id = ?`, [userId], (err, row) => {
      if (err) {
        console.error('ОШИБКА БД:', err.message);
        resolve({ user_id: userId, messages: 0, unlocked: ['einstein'], current_char: null, history: [] });
        return;
      }
      if (row) {
        row.unlocked = row.unlocked ? row.unlocked.split(',') : ['einstein'];
        row.history = row.history ? JSON.parse(row.history) : [];
        resolve(row);
      } else {
        db.run(`INSERT INTO users (user_id) VALUES (?)`, [userId]);
        resolve({ user_id: userId, messages: 0, unlocked: ['einstein'], current_char: null, history: [] });
      }
    });
  });
}

function updateUser(userId, data) {
  db.run(
    `UPDATE users SET messages = ?, unlocked = ?, current_char = ?, history = ? WHERE user_id = ?`,
    [data.messages, data.unlocked.join(','), data.current_char || null, JSON.stringify(data.history), userId],
    (err) => {
      if (err) console.error('ОШИБКА БД:', err.message);
    }
  );
}

// ===================================================================
// ОБРАБОТЧИКИ
// ===================================================================

bot.start(async (ctx) => {
  const user = await getUser(ctx.from.id);
  const keyboard = characters.map(ch => [{
    text: (user.unlocked.includes(ch.id) ? '✅ ' : '🔒 ') + ch.name,
    callback_data: ch.id
  }]);

  ctx.reply(
    `*Добро пожаловать в TimeTravel Chat!*\nВыбери собеседника из прошлого:`,
    { parse_mode: 'Markdown', reply_markup: { inline_keyboard: keyboard } }
  );
});

bot.on('callback_query', async (ctx) => {
  const action = ctx.callbackQuery.data;
  const user = await getUser(ctx.from.id);

  if (action.startsWith('einstein_')) {
    await ctx.answerCbQuery();
    let promptForAI = "";
    if (action === 'einstein_paradox') {
      promptForAI = "Расскажи мне о самых известных парадоксах теории относительности.";
    } else if (action === 'einstein_proof') {
      promptForAI = "Как экспериментально доказали формулу E=mc²?";
    } else if (action === 'einstein_change_topic') {
      promptForAI = "Давай сменим тему. Расскажи мне что-нибудь интересное о твоей жизни в Принстоне.";
    }

    user.history.push({ role: 'user', content: promptForAI });
    const char = characters.find(c => c.id === user.current_char);
    const answer = await askAI(user.history, char.system);
    user.history.push({ role: 'assistant', content: answer });
    updateUser(ctx.from.id, user);

    await ctx.reply(answer);
    return;
  }

  const character = characters.find(c => c.id === action);
  if (!character) return ctx.answerCbQuery('Ошибка');
  if (!user.unlocked.includes(character.id)) return ctx.answerCbQuery('Этот персонаж еще не разблокирован!');

  user.current_char = action;
  user.history = [];
  updateUser(ctx.from.id, user);

  await ctx.answerCbQuery(`Выбран: ${character.name}`);
  await ctx.reply(`Ты общаешься с *${character.name}*\n\n${character.greeting || "Пиши что угодно!"}`, { parse_mode: 'Markdown' });
});

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

    let finalMessage = answer;
    if (char.id === 'einstein') {
      if (answer.toLowerCase().includes('поделиться ссылкой') || answer.toLowerCase().includes('подробный материал')) {
        for (const topic in sources) {
          if (answer.toLowerCase().includes(topic)) {
            finalMessage += `\n\n🔗 Вот полезная ссылка по теме: ${sources[topic]}`;
            break;
          }
        }
      }
    }
    
    let keyboard = null;
    if (answer.includes('[OFFER_BUTTONS]')) {
      finalMessage = answer.replace('[OFFER_BUTTONS]', '').trim();
      keyboard = {
        reply_markup: {
          inline_keyboard: [
            [{ text: "🤔 Расскажи про парадоксы", callback_data: "einstein_paradox" }, { text: "🧪 А как это доказали?", callback_data: "einstein_proof" }],
            [{ text: "Достаточно, давай другое", callback_data: "einstein_change_topic" }]
          ]
        }
      };
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

    await ctx.reply(finalMessage, keyboard);

  } catch (error) {
    console.error('Критическая ошибка при обработке сообщения:', error);
    await ctx.reply('Упс, что-то пошло не так. Попробуй задать вопрос еще раз.');
  }
});

// ===================================================================
// ЗАПУСК
// ===================================================================

bot.launch();

const PORT = process.env.PORT || 3000;
const http = require('http');
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Bot is running');
});

server.listen(PORT, () => {
  console.log(`Сервер для health-check'ов запущен на порту ${PORT}`);
});

process.once('SIGINT', () => {
  console.log("\nПолучен SIGINT. Останавливаю бота...");
  db.close((err) => {
    if (err) console.error(err.message);
    console.log('Соединение с БД закрыто.');
    bot.stop('SIGINT');
    server.close(() => console.log('Сервер остановлен.'));
  });
});

console.log('TimeTravel Bot запущен! Иди в Telegram → /start');