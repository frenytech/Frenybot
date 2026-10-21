# FRENYTECH BOT — Node.js 22

## Railway
Set the service start command to `npm start` (or leave Railway's detected start command if it runs `npm start`).

Add these variables to the **Frenybot service**:
- `TG_TOKEN` — your current Telegram bot token from @BotFather
- `BOT_NAME` — `FRENYTECH BOT`
- `PREFIX` — `.`
- `SESSIONS_DIR` — `/data/sessions`
- `UPTIME_FILE` — `/data/uptime.json`

Attach a Railway Volume mounted at `/data` so WhatsApp session files persist.

The project uses Node.js `22.x`, configured in `package.json`.

## Commands
Telegram:
- `/start`
- `/menu`
- `/ping`
- `/uptime`
- `/link qr`
- `/link 2348012345678`
- `/status`
- `/unlink`

WhatsApp command text currently handled by the Telegram control chat:
- `.menu`
- `.ping`
- `.uptime`

## Security
- Never commit `.env`, Telegram tokens, WhatsApp sessions, or uptime data.
- If a token has been pasted into chat or a public repository, revoke it through @BotFather and update Railway.
- This is a starter implementation. Test linking and reconnect behavior before relying on it in production.
