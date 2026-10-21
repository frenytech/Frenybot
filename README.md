# FRENYTECH BOT — Telegram + WhatsApp base

This package contains the supplied TELEXWA-style base adapted with FrenyTech branding and environment-based configuration.

## Included commands
- `.ping`
- `.uptime`
- `.runtime`
- `.menu`
- `.help`

The requested `.kick`, `.promote`, `.demote`, `.mute`, `.unmute`, `.tictactoe`, `.sticker`, `.attp`, `.ocr`, `.tts`, `.❤️`, and `.❤️❤️` commands are **not implemented in this base yet**.

## Required environment variable
- `TG_TOKEN`: Telegram bot token from BotFather. Add it as a secret/environment variable in the host. Do not paste it into `index.js` or commit it to GitHub.

Optional:
- `SESSIONS_DIR`: defaults to `./sessions`
- `BOT_NAME`: defaults to `FRENYTECH BOT`
- `PREFIX`: defaults to `.`
- `UPTIME_FILE`: defaults to `./uptime.json`

## Run locally
1. Install Node.js 20 or newer.
2. Run `npm install`.
3. Set `TG_TOKEN` in your shell/environment.
4. Run `npm start`.

Example PowerShell:
```powershell
$env:TG_TOKEN="YOUR_NEW_TELEGRAM_BOT_TOKEN"
npm install
npm start
```

## Hosting notes
Deploy as a long-running Node.js service, not a static website. The host must support outbound connections and persistent storage. Mount a persistent disk and set `SESSIONS_DIR` to a path on that disk; otherwise WhatsApp login sessions can be lost after restarts/redeployments. Telegram token and any future Supabase service-role key must remain server-side.

This code is a bot backend only; it does not yet include a website dashboard/API. A website that shares sessions with Telegram needs a backend API and a shared session manager, plus user authentication and authorization. Do not run a separate WhatsApp socket for the same account from the website.

Before public multi-user deployment, add authentication/authorization, per-user session isolation, rate limits, ownership checks, and robust reconnect/session locking. This base is not yet a production-ready multi-user platform.
