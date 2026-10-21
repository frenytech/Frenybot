const fs = require('fs');
const path = require('path');
const pino = require('pino');
const QRCode = require('qrcode');
const TelegramBot = require('node-telegram-bot-api');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
} = require('@whiskeysockets/baileys');

const TG_TOKEN = (process.env.TG_TOKEN || '').trim();
const BOT_NAME = process.env.BOT_NAME || 'FRENYTECH BOT';
const PREFIX = process.env.PREFIX || '.';
const SESSIONS_DIR = process.env.SESSIONS_DIR || './sessions';
const UPTIME_FILE = process.env.UPTIME_FILE || './uptime.json';

if (!TG_TOKEN) {
  console.error('[FRENYTECH BOT] TG_TOKEN is missing from this process environment.');
  console.error('[FRENYTECH BOT] On Railway, set TG_TOKEN in the Frenybot service Variables, then redeploy.');
  process.exit(1);
}

console.log('[FRENYTECH BOT] TG_TOKEN detected (value hidden).');
console.log(`[FRENYTECH BOT] Node.js ${process.version}`);

fs.mkdirSync(SESSIONS_DIR, { recursive: true });
try {
  if (!fs.existsSync(UPTIME_FILE)) {
    fs.mkdirSync(path.dirname(path.resolve(UPTIME_FILE)), { recursive: true });
    fs.writeFileSync(UPTIME_FILE, JSON.stringify({ startedAt: Date.now() }, null, 2));
  }
} catch (error) {
  console.error('[FRENYTECH BOT] Could not initialize uptime file:', error.message);
}

const bot = new TelegramBot(TG_TOKEN, { polling: true });
const logger = pino({ level: process.env.LOG_LEVEL || 'warn' });
const sockets = new Map();
const pendingPairings = new Map();
const startedAt = Date.now();

const safeChatId = (chatId) => String(chatId).replace(/[^0-9-]/g, '');
const sessionPathFor = (chatId) => path.join(SESSIONS_DIR, safeChatId(chatId));

function formatUptime(ms) {
  const totalSeconds = Math.floor(ms / 1000);
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return `${days}d ${hours}h ${minutes}m ${seconds}s`;
}

function menuText() {
  return [
    `🤖 *${BOT_NAME}*`,
    '',
    '*Telegram commands*',
    '/start — Start the bot',
    '/menu — Show this menu',
    '/link — Link WhatsApp using a QR code',
    '/link 2348012345678 — Request a phone pairing code',
    '/status — Check WhatsApp connection',
    '/unlink — Log out and remove your WhatsApp session',
    '/ping — Check bot response',
    '/uptime — Show uptime',
    '',
    '*WhatsApp text commands*',
    '`.menu` — Show commands',
    '`.ping` — Check response',
    '`.uptime` — Show uptime',
    '`.❤️` — Send one heart',
    '`.❤️❤️` — Send two hearts',
    '',
    'Keep your Telegram bot token private.',
  ].join('\n');
}

async function sendTelegram(chatId, text, options = {}) {
  try {
    await bot.sendMessage(chatId, text, options);
  } catch (error) {
    console.error('[Telegram send error]', error.message);
  }
}

async function connectWhatsApp(chatId, phoneNumber = '') {
  const id = safeChatId(chatId);
  const existing = sockets.get(id);
  if (existing) {
    try { existing.end(undefined); } catch (_) {}
    sockets.delete(id);
  }

  const authDir = sessionPathFor(chatId);
  fs.mkdirSync(authDir, { recursive: true });
  const { state, saveCreds } = await useMultiFileAuthState(authDir);

  let versionOptions = {};
  try {
    const latest = await fetchLatestBaileysVersion();
    versionOptions = { version: latest.version };
  } catch (error) {
    console.warn('[WhatsApp] Could not fetch latest version; using library default:', error.message);
  }

  const sock = makeWASocket({
    ...versionOptions,
    auth: state,
    logger,
    printQRInTerminal: false,
    browser: ['FRENYTECH BOT', 'Chrome', '1.0.0'],
    markOnlineOnConnect: false,
    syncFullHistory: false,
  });

  sockets.set(id, sock);
  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      try {
        const png = await QRCode.toBuffer(qr, { type: 'png', width: 640, margin: 2 });
        await bot.sendPhoto(chatId, png, {
          caption: 'Scan this QR code in WhatsApp → Linked devices → Link a device. It expires quickly; use /link again if needed.',
        });
      } catch (error) {
        await sendTelegram(chatId, `Could not create QR code: ${error.message}`);
      }
    }

    if (connection === 'open') {
      await sendTelegram(chatId, '✅ WhatsApp connected successfully to FRENYTECH BOT.');
    }

    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      sockets.delete(id);
      if (statusCode === DisconnectReason.loggedOut) {
        await sendTelegram(chatId, 'WhatsApp session logged out. Use /link to connect again.');
      } else {
        await sendTelegram(chatId, 'WhatsApp connection closed. The bot will try to reconnect.');
        setTimeout(() => {
          connectWhatsApp(chatId).catch((err) => console.error('[WhatsApp reconnect]', err.message));
        }, 3000);
      }
    }
  });

  if (phoneNumber && !state.creds.registered) {
    const normalized = phoneNumber.replace(/\D/g, '');
    if (normalized.length < 8 || normalized.length > 15) {
      await sendTelegram(chatId, 'Enter a valid international phone number including country code, without + or spaces. Example: /link 2348012345678');
      return;
    }
    try {
      const code = await sock.requestPairingCode(normalized);
      await sendTelegram(chatId, `🔐 WhatsApp pairing code: *${code}*\n\nOpen WhatsApp → Linked devices → Link with phone number, then enter this code.`, { parse_mode: 'Markdown' });
    } catch (error) {
      await sendTelegram(chatId, `Could not generate a pairing code: ${error.message}`);
    }
  } else if (state.creds.registered) {
    await sendTelegram(chatId, 'A saved WhatsApp session was loaded. Waiting for connection…');
  } else if (!phoneNumber) {
    await sendTelegram(chatId, 'Preparing your WhatsApp QR code. Keep this chat open and wait for the QR image.');
  }
}

bot.onText(/^\/start(?:@\w+)?$/, async (msg) => {
  await sendTelegram(msg.chat.id, `Welcome to ${BOT_NAME}!\n\nUse /menu to see commands and /link to connect WhatsApp.`);
});

bot.onText(/^\/menu(?:@\w+)?$/, async (msg) => {
  await sendTelegram(msg.chat.id, menuText(), { parse_mode: 'Markdown' });
});

bot.onText(/^\/ping(?:@\w+)?$/, async (msg) => {
  await sendTelegram(msg.chat.id, '🏓 Pong! FRENYTECH BOT is responding.');
});

bot.onText(/^\/uptime(?:@\w+)?$/, async (msg) => {
  await sendTelegram(msg.chat.id, `⏱️ Uptime: ${formatUptime(Date.now() - startedAt)}`);
});

bot.onText(/^\/status(?:@\w+)?$/, async (msg) => {
  const sock = sockets.get(safeChatId(msg.chat.id));
  const connected = Boolean(sock?.user);
  await sendTelegram(msg.chat.id, connected ? `✅ WhatsApp connected as ${sock.user.id}` : 'ℹ️ No active WhatsApp connection detected. Use /link to connect.');
});

bot.onText(/^\/link(?:@\w+)?(?:\s+(.+))?$/, async (msg, match) => {
  const chatId = msg.chat.id;
  const arg = (match?.[1] || '').trim();
  if (arg.toLowerCase() === 'qr') {
    await connectWhatsApp(chatId);
    return;
  }
  if (arg) {
    await connectWhatsApp(chatId, arg);
    return;
  }
  await sendTelegram(chatId, 'Choose a linking method:\n\nSend /link qr to request a QR code, or /link followed by your international phone number for a pairing code.\nExample: /link 2348012345678');
});

bot.onText(/^\/unlink(?:@\w+)?$/, async (msg) => {
  const id = safeChatId(msg.chat.id);
  const sock = sockets.get(id);
  if (sock) {
    try { await sock.logout(); } catch (_) {}
    try { sock.end(undefined); } catch (_) {}
    sockets.delete(id);
  }
  const dir = sessionPathFor(msg.chat.id);
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  await sendTelegram(msg.chat.id, 'WhatsApp session data removed for this Telegram chat. Use /link to connect again.');
});

bot.on('message', async (msg) => {
  if (!msg.text || msg.text.startsWith('/')) return;
  const id = safeChatId(msg.chat.id);
  const sock = sockets.get(id);
  if (!sock || !sock.user) return;

  const text = msg.text.trim();
  if (text === `${PREFIX}ping`) {
    await sendTelegram(msg.chat.id, 'WhatsApp is connected. 🏓');
  } else if (text === `${PREFIX}menu`) {
    await sendTelegram(msg.chat.id, menuText(), { parse_mode: 'Markdown' });
  } else if (text === `${PREFIX}uptime`) {
    await sendTelegram(msg.chat.id, `⏱️ Uptime: ${formatUptime(Date.now() - startedAt)}`);
  }
});

bot.on('polling_error', (error) => {
  console.error('[Telegram polling error]', error.message);
});

bot.on('error', (error) => {
  console.error('[Telegram bot error]', error.message);
});

console.log(`[FRENYTECH BOT] Starting Telegram polling as ${BOT_NAME}…`);

process.on('SIGINT', async () => {
  console.log('[FRENYTECH BOT] Shutting down…');
  try { await bot.stopPolling(); } catch (_) {}
  for (const sock of sockets.values()) {
    try { sock.end(undefined); } catch (_) {}
  }
  process.exit(0);
});

process.on('SIGTERM', async () => {
  try { await bot.stopPolling(); } catch (_) {}
  for (const sock of sockets.values()) {
    try { sock.end(undefined); } catch (_) {}
  }
  process.exit(0);
});
