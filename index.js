require('dotenv').config();
const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    makeCacheableSignalKeyStore,
    fetchLatestBaileysVersion,
    generateWAMessageFromContent,
    proto,
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const path = require('path');
const fs = require('fs-extra');
const TelegramBot = require('node-telegram-bot-api');
const QRCode = require('qrcode');

// ================= CONFIGURATION =================
const TG_TOKEN = process.env.TG_TOKEN || '';
const SESSIONS_DIR = process.env.SESSIONS_DIR || './sessions';
const BOT_NAME = process.env.BOT_NAME || 'FRENYTECH BOT';
const PREFIX = process.env.PREFIX || '.';

if (!TG_TOKEN) {
    console.error('Missing TG_TOKEN environment variable. Add your Telegram bot token in your hosting environment.');
    process.exit(1);
}

// ================= UPTIME (persistent) =================
const UPTIME_FILE = process.env.UPTIME_FILE || './uptime.json';
let startMs;
if (fs.existsSync(UPTIME_FILE)) {
    try { startMs = JSON.parse(fs.readFileSync(UPTIME_FILE, 'utf8')).startMs; } catch { startMs = null; }
}
if (!startMs) {
    startMs = Date.now();
    fs.writeFileSync(UPTIME_FILE, JSON.stringify({ startMs }));
}
const getUptime = () => {
    const t = Math.floor((Date.now() - startMs) / 1000);
    return `${Math.floor(t / 86400)}d ${Math.floor((t % 86400) / 3600)}h ${Math.floor((t % 3600) / 60)}m ${t % 60}s`;
};

// ================= ERROR HELPERS =================
function isBadMac(err) {
    const t = String(err?.message || err || '');
    return t.includes('Bad MAC') || t.includes('decrypt') || t.includes('Session error');
}
function resetSession(sessionPath) {
    try {
        if (fs.existsSync(sessionPath)) fs.removeSync(sessionPath);
        fs.mkdirSync(sessionPath, { recursive: true });
        console.log('[SESSION RESET] Reset session directory:', sessionPath);
    } catch (e) {
        console.error('[SESSION RESET FAILED]', e.message);
    }
}
process.on('uncaughtException', (err) => {
    console.error(isBadMac(err) ? '[BAD MAC exception]' : '[CRITICAL EXCEPTION]', err);
});
process.on('unhandledRejection', (reason) => {
    console.error(isBadMac(reason) ? '[BAD MAC rejection]' : '[CRITICAL REJECTION]', reason);
});

// ================= TELEGRAM SETUP =================
const telegram = new TelegramBot(TG_TOKEN, { polling: true });
fs.ensureDirSync(SESSIONS_DIR);

const qrMessages = new Map();
const activeSockets = new Map();
const userState = new Map();

// ==============================================================================
// AUTO-RESUME ON STARTUP
// ==============================================================================
(async () => {
    console.log('[SYSTEM] Scanning saved WhatsApp sessions...');
    const items = fs.readdirSync(SESSIONS_DIR);
    let found = false;
    for (const name of items) {
        const fullPath = path.join(SESSIONS_DIR, name);
        if (!fs.lstatSync(fullPath).isDirectory()) continue;
        if (!fs.existsSync(path.join(fullPath, 'creds.json'))) continue;
        found = true;
        console.log(`[SYSTEM] Resuming session: ${name}`);
        startWhatsAppSession(null, name, false);
    }
    if (!found) console.log('[SYSTEM] No saved sessions. Use /link in Telegram.');
})();

// ==============================================================================
// TELEGRAM HANDLERS
// ==============================================================================
telegram.onText(/^\/start(?:@\w+)?(?:\s|$)/, (msg) => {
    telegram.sendMessage(msg.chat.id,
        `👋 *${BOT_NAME} Manager*\n\nLink your WhatsApp account using one of the options below.`,
        {
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [
                    [{ text: '🔗 Link WhatsApp (QR)', callback_data: 'link_qr' }],
                    [{ text: '📱 Link with Phone Number', callback_data: 'link_pair' }],
                    [{ text: '❓ Help', callback_data: 'help' }],
                ],
            },
        }
    );
});

telegram.onText(/^\/link(?:@\w+)?(?:\s|$)/, (msg) => handleQRLink(msg.chat.id));

telegram.on('callback_query', async (q) => {
    const chatId = q.message?.chat?.id;
    if (!chatId) return;
    await telegram.answerCallbackQuery(q.id).catch(() => {});
    if (q.data === 'link_qr') return handleQRLink(chatId);
    if (q.data === 'link_pair') {
        userState.set(chatId, 'WAITING_NUM');
        return telegram.sendMessage(chatId, '📱 Send your WhatsApp number with country code, digits only.\nExample: `2348012345678`', { parse_mode: 'Markdown' });
    }
    if (q.data === 'help') {
        return telegram.sendMessage(chatId,
            `*${BOT_NAME} Help*\n\n1. Tap *Link WhatsApp (QR)* and scan the QR from WhatsApp → Linked devices.\n2. Or choose *Link with Phone Number* and enter your number with country code.\n3. Once connected, send *.menu* in WhatsApp.\n\nCommands: *.ping*, *.uptime*, *.runtime*, *.menu*, *.help*`,
            { parse_mode: 'Markdown' }
        );
    }
    if (q.data === 'cancel') {
        const sessionId = String(chatId);
        const sock = activeSockets.get(sessionId);
        if (sock) {
            try { sock.ev.removeAllListeners(); sock.end(undefined); } catch (_) {}
            activeSockets.delete(sessionId);
        }
        const previousMessage = qrMessages.get(chatId);
        if (previousMessage) {
            telegram.deleteMessage(chatId, previousMessage).catch(() => {});
            qrMessages.delete(chatId);
        }
        return telegram.sendMessage(chatId, '❌ Pairing cancelled.');
    }
});

telegram.on('message', (msg) => {
    const chatId = msg.chat.id;
    if (msg.text?.startsWith('/')) return;
    if (userState.get(chatId) !== 'WAITING_NUM' || !msg.text) return;

    const number = msg.text.replace(/\D/g, '');
    if (number.length < 10 || number.length > 15) {
        return telegram.sendMessage(chatId, 'Invalid number. Include your country code, digits only.');
    }

    userState.delete(chatId);
    const sessionPath = path.join(SESSIONS_DIR, number);
    if (fs.existsSync(sessionPath)) fs.removeSync(sessionPath);

    telegram.sendMessage(chatId,
        `🔄 Preparing pairing for +${number}...\n\n1. Open WhatsApp.\n2. Go to Linked Devices → Link a Device.\n3. Choose the phone-number linking option.\n4. Enter the code sent here.`,
    );
    startWhatsAppSession(chatId, number, true);
});

async function handleQRLink(chatId) {
    const sessionId = String(chatId);
    const oldSocket = activeSockets.get(sessionId);
    if (oldSocket) {
        try { oldSocket.ev.removeAllListeners(); oldSocket.end(undefined); } catch (_) {}
        activeSockets.delete(sessionId);
    }
    const previousMessage = qrMessages.get(chatId);
    if (previousMessage) {
        telegram.deleteMessage(chatId, previousMessage).catch(() => {});
        qrMessages.delete(chatId);
    }

    const sessionPath = path.join(SESSIONS_DIR, sessionId);
    if (fs.existsSync(sessionPath)) fs.removeSync(sessionPath);
    await telegram.sendMessage(chatId, '⏳ Generating a new WhatsApp QR code...');
    startWhatsAppSession(chatId, sessionId, false);
}

// ==============================================================================
// WHATSAPP SESSION CORE
// ==============================================================================
async function startWhatsAppSession(tgChatId, identifier, usePairing) {
    // Avoid opening duplicate sockets for the same session identifier.
    const existing = activeSockets.get(identifier);
    if (existing) {
        try { existing.end(undefined); } catch (_) {}
        activeSockets.delete(identifier);
    }

    const sessionPath = path.join(SESSIONS_DIR, identifier);
    console.log(`[INIT] Starting WhatsApp session: ${identifier}`);

    try {
        const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
        let version;
        try {
            version = (await fetchLatestBaileysVersion()).version;
        } catch {
            version = undefined;
        }

        const sock = makeWASocket({
            ...(version ? { version } : {}),
            logger: pino({ level: 'silent' }),
            printQRInTerminal: false,
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'fatal' })),
            },
            browser: ['FrenyTech', 'Chrome', '1.0.0'],
            markOnlineOnConnect: false,
            generateHighQualityLinkPreview: true,
            syncFullHistory: false,
            connectTimeoutMs: 60000,
        });

        activeSockets.set(identifier, sock);

        if (usePairing && !sock.authState.creds.registered && tgChatId) {
            setTimeout(async () => {
                try {
                    if (activeSockets.get(identifier) !== sock) return;
                    const code = await sock.requestPairingCode(identifier);
                    const formattedCode = code?.match(/.{1,4}/g)?.join('-') || code;
                    await telegram.sendMessage(tgChatId, `🔑 *Your pairing code:*\n\`${formattedCode}\`\n\nEnter this code in WhatsApp.`, { parse_mode: 'Markdown' });
                } catch (e) {
                    console.error('[PAIRING ERROR]', e);
                    telegram.sendMessage(tgChatId, 'Could not generate a pairing code. Try /link for QR pairing.').catch(() => {});
                }
            }, 6000);
        }

        let qrCount = 0;
        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;

            if (qr && tgChatId && !usePairing) {
                qrCount++;
                if (qrCount > 5) {
                    telegram.sendMessage(tgChatId, 'QR refresh limit reached. Send /link to start again.').catch(() => {});
                    return;
                }
                try {
                    const qrBuffer = await QRCode.toBuffer(qr, { type: 'png', width: 512, margin: 2 });
                    const previousMessage = qrMessages.get(tgChatId);
                    if (previousMessage) telegram.deleteMessage(tgChatId, previousMessage).catch(() => {});
                    const sent = await telegram.sendPhoto(tgChatId, qrBuffer, {
                        caption: `📱 Scan with WhatsApp → Linked Devices\nQR refresh ${qrCount}/5`,
                        reply_markup: { inline_keyboard: [[{ text: '❌ Cancel', callback_data: 'cancel' }]] },
                    });
                    qrMessages.set(tgChatId, sent.message_id);
                } catch (e) {
                    console.error('[QR ERROR]', e.message);
                }
            }

            if (connection === 'close') {
                if (activeSockets.get(identifier) === sock) activeSockets.delete(identifier);
                const reason = lastDisconnect?.error?.output?.statusCode;
                const err = lastDisconnect?.error;

                if (isBadMac(err)) {
                    console.log(`[${identifier}] Session encryption error; resetting auth files.`);
                    resetSession(sessionPath);
                    if (tgChatId) telegram.sendMessage(tgChatId, 'Session data appears corrupted and was reset. Send /link to pair again.').catch(() => {});
                    return;
                }

                console.log(`[${identifier}] Connection closed: ${reason}`);
                if (reason !== DisconnectReason.loggedOut && reason !== 401) {
                    setTimeout(() => {
                        if (!activeSockets.has(identifier)) startWhatsAppSession(tgChatId, identifier, false);
                    }, 3000);
                } else {
                    if (tgChatId) telegram.sendMessage(tgChatId, 'WhatsApp logged out. Send /link to connect again.').catch(() => {});
                    fs.removeSync(sessionPath);
                }
            } else if (connection === 'open') {
                console.log(`[${identifier}] WhatsApp connected.`);
                if (tgChatId) {
                    const previousMessage = qrMessages.get(tgChatId);
                    if (previousMessage) {
                        telegram.deleteMessage(tgChatId, previousMessage).catch(() => {});
                        qrMessages.delete(tgChatId);
                    }
                    telegram.sendMessage(tgChatId, `✅ *Connected!*\nSend *.menu* on WhatsApp.`, { parse_mode: 'Markdown' }).catch(() => {});
                }
            }
        });

        sock.ev.on('creds.update', saveCreds);

        // MESSAGE HANDLER: ping / menu / uptime only
        sock.ev.on('messages.upsert', async (chatUpdate) => {
            try {
                if (chatUpdate.type !== 'notify') return;
                const mek = chatUpdate.messages?.[0];
                if (!mek?.message || mek.key.fromMe) return;
                if (mek.key.remoteJid === 'status@broadcast') return;

                const timestamp = Number(mek.messageTimestamp || 0);
                if (timestamp && timestamp < (Date.now() / 1000) - 60) return;

                const from = mek.key.remoteJid;
                const sender = mek.key.participant || from;
                let body =
                    mek.message.conversation ||
                    mek.message.extendedTextMessage?.text ||
                    mek.message.imageMessage?.caption ||
                    mek.message.videoMessage?.caption || '';

                if (mek.message?.interactiveResponseMessage?.nativeFlowResponseMessage) {
                    try {
                        body = JSON.parse(mek.message.interactiveResponseMessage.nativeFlowResponseMessage.paramsJson).id || body;
                    } catch (_) {}
                }

                if (!body.startsWith(PREFIX)) return;
                const args = body.slice(PREFIX.length).trim().split(/\s+/);
                const command = (args.shift() || '').toLowerCase();
                const reply = (text) => sock.sendMessage(from, { text }, { quoted: mek });

                if (command === 'ping') {
                    const started = Date.now();
                    await sock.sendMessage(from, { react: { text: '⚡', key: mek.key } });
                    const latency = Date.now() - started;
                    await reply(`┏ ❑ ⌜ *SYSTEM PING* ⌟\n┣ ◆ Latency: ${latency}ms\n┣ ◆ Status: Online 🟢\n┗ ◆ © ${BOT_NAME}`);
                } else if (command === 'runtime' || command === 'uptime') {
                    await sock.sendMessage(from, { react: { text: '⏱️', key: mek.key } });
                    await reply(`┏ ❑ ⌜ *BOT UPTIME* ⌟\n┣ ◆ Active for: ${getUptime()}\n┣ ◆ Engine: Node.js\n┗ ◆ © ${BOT_NAME}`);
                } else if (command === 'menu' || command === 'help') {
                    await sock.sendMessage(from, { react: { text: '⏳', key: mek.key } });
                    try {
                        const categories = [
                            { title: '🏓 BOT PING', desc: 'Check the bot response speed and latency.', id: '.ping', btnText: '⚡ Check Ping' },
                            { title: '⏱️ BOT UPTIME', desc: 'See how long the bot has been online.', id: '.uptime', btnText: '⏳ Check Uptime' },
                        ];

                        const cards = categories.map((cat) => ({
                            body: proto.Message.InteractiveMessage.Body.create({
                                text: `*${cat.title}*\n${cat.desc}\n\n© ${BOT_NAME}`,
                            }),
                            header: proto.Message.InteractiveMessage.Header.create({ title: ' ' }),
                            nativeFlowMessage: proto.Message.InteractiveMessage.NativeFlowMessage.create({
                                buttons: [{
                                    name: 'quick_reply',
                                    buttonParamsJson: JSON.stringify({ display_text: cat.btnText, id: cat.id }),
                                }],
                            }),
                        }));

                        const interactiveMessage = proto.Message.InteractiveMessage.create({
                            body: proto.Message.InteractiveMessage.Body.create({
                                text: `© ${BOT_NAME}\n\nHey @${sender.split('@')[0]}!\nSwipe to explore the command menu.`,
                            }),
                            carouselMessage: proto.Message.InteractiveMessage.CarouselMessage.create({
                                cards,
                                messageVersion: 1,
                            }),
                        });

                        const generated = generateWAMessageFromContent(from, {
                            viewOnceMessage: {
                                message: {
                                    messageContextInfo: { deviceListMetadata: {}, deviceListMetadataVersion: 2 },
                                    interactiveMessage,
                                },
                            },
                        }, { quoted: mek, mentions: [sender] });

                        await sock.relayMessage(from, generated.message, { messageId: generated.key.id });
                        await sock.sendMessage(from, { react: { text: '✅', key: mek.key } });
                    } catch (e) {
                        await sock.sendMessage(from, { react: { text: '❌', key: mek.key } });
                        await reply(`Menu error: ${e.message}`);
                    }
                }
            } catch (e) {
                console.error('[MESSAGE ERROR]', e.message);
            }
        });
    } catch (e) {
        console.error(`[FATAL] ${identifier}:`, e.message);
    }
}

telegram.on('polling_error', (err) => console.error('[TELEGRAM POLLING ERROR]', err.message));
process.on('SIGTERM', () => {
    console.log('SIGTERM received; closing WhatsApp sockets...');
    for (const sock of activeSockets.values()) {
        try { sock.end(undefined); } catch (_) {}
    }
    telegram.stopPolling().catch(() => {});
    process.exit(0);
});
