#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="${1:-$(pwd)}"
REPO_DIR="$(cd "${REPO_DIR}" && pwd)"
NODE_BIN="$(command -v node)"
SERVICE_NAME="codex-telegram"
SERVICE_DIR="${HOME}/.config/systemd/user"
ENV_DIR="${HOME}/.config/codex-telegram"
ENV_FILE="${ENV_DIR}/.env"
SERVICE_FILE="${SERVICE_DIR}/${SERVICE_NAME}.service"

mkdir -p "${SERVICE_DIR}" "${ENV_DIR}"

if [[ ! -f "${ENV_FILE}" ]]; then
  if [[ -f "${REPO_DIR}/.env" ]]; then
    cp "${REPO_DIR}/.env" "${ENV_FILE}"
  elif [[ -f "${REPO_DIR}/.env.example" ]]; then
    cp "${REPO_DIR}/.env.example" "${ENV_FILE}"
  else
    touch "${ENV_FILE}"
  fi
fi

cat > "${SERVICE_FILE}" <<SERVICE_EOF
[Unit]
Description=Codex Telegram Bot
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${REPO_DIR}
EnvironmentFile=${ENV_FILE}
ExecStart=${NODE_BIN} ${REPO_DIR}/dist/index.js
Restart=on-failure
RestartSec=2

[Install]
WantedBy=default.target
SERVICE_EOF

systemctl --user daemon-reload

if [[ ! -f "${REPO_DIR}/dist/index.js" ]]; then
  echo "Warning: ${REPO_DIR}/dist/index.js not found. Run 'npm run build' first." >&2
fi

echo "Installed user service at ${SERVICE_FILE}"
echo "Next steps:"
echo "  1) Edit ${ENV_FILE}"
echo "  2) systemctl --user enable --now ${SERVICE_NAME}"
