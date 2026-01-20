# Codex Telegram Bot

Telegram-frontend for Codex CLI using the Codex SDK.

## Quick start

```bash
npm install
cp .env.example .env
npm run dev
```

## Environment

- `TELEGRAM_BOT_TOKEN` (required)
- `TELEGRAM_ALLOWED_USER_IDS` (optional, comma/space separated numeric user IDs; when set, only these users can use the bot in any chat)
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
