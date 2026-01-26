#!/usr/bin/env bash
set -euo pipefail

SERVICE_NAME="codex-telegram"
SERVICE_DIR="${HOME}/.config/systemd/user"
SERVICE_FILE="${SERVICE_DIR}/${SERVICE_NAME}.service"

if systemctl --user is-enabled --quiet "${SERVICE_NAME}"; then
  systemctl --user disable --now "${SERVICE_NAME}"
fi

if [[ -f "${SERVICE_FILE}" ]]; then
  rm -f "${SERVICE_FILE}"
  systemctl --user daemon-reload
  echo "Removed ${SERVICE_FILE}"
else
  echo "Service file not found: ${SERVICE_FILE}" >&2
fi

