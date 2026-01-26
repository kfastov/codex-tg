# Codex Telegram Bot

Telegram-frontend for Codex CLI using the Codex SDK.

## Quick start

```bash
npm install
cp .env.example .env
npm run dev
```

## Run as a service (systemd, recommended)

This project includes a user-level systemd service so you can run it like a daemon
and start/stop it cleanly. User services run under your user account and have access
to your home directory by default.

### One-time setup

```bash
npm install
npm run build
./scripts/install-user-service.sh
```

Edit your service environment file:

```bash
${HOME}/.config/codex-telegram/.env
```

### Start/stop

```bash
systemctl --user enable --now codex-telegram
systemctl --user status codex-telegram
systemctl --user stop codex-telegram
```

### Update after pulling changes

```bash
npm install
npm run build
systemctl --user restart codex-telegram
```

### Uninstall

```bash
./scripts/uninstall-user-service.sh
```

If you need a system-wide unit instead, see `systemd/codex-telegram.service` and
adapt the paths (run it as a dedicated user via `User=...`).

## Environment

- `TELEGRAM_BOT_TOKEN` (required)
- `TELEGRAM_ALLOWED_USER_IDS` (comma/space separated numeric user IDs; whitelist is always enforced, so an empty value denies everyone)
- `CODEX_API_KEY` (optional, if not using ChatGPT auth)
- `OPENAI_BASE_URL` (optional)
- `CODEX_WORKDIR` (optional, defaults to current directory)
- `CODEX_MODEL` (optional)
- `CODEX_SANDBOX_MODE` (optional)
- `CODEX_APPROVAL_POLICY` (optional)
- `STATUS_UPDATE_INTERVAL_MS` (optional, default `1000`)

## Supported commands

- `/new` start a new session
- `/status` show current session/config
- `/model <id>` set model for next turns
- `/approvals <never|on-request|on-failure|untrusted>` set approval policy
- `/compact` ask Codex to summarize/compact the session
- `/diff` show git diff for the working directory
- `/review` run Codex review on the working tree
- `/resume [thread-id]` list or resume a previous thread
- `/mcp` ask Codex to list MCP tools

Commands that require CLI-specific features are acknowledged but may be no-ops for now: `/fork`, `/init`, `/logout`, `/feedback`, `/quit`, `/exit`.

The bot responds in the same chat where the message was sent (private or group) as long as the sender is whitelisted.
