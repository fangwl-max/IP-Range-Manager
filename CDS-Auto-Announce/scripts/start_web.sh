#!/usr/bin/env bash
# Linux / macOS 启动 Web 控制台（先结束旧进程，默认开发自动重载）
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

CONFIG_PATH="${IP_ANNOUNCE_CONFIG:-$ROOT_DIR/config.yaml}"
VENV_PY="$ROOT_DIR/.venv/bin/python"
PORT="${IP_ANNOUNCE_PORT:-9010}"

if [[ ! -x "$VENV_PY" ]]; then
  echo "未找到虚拟环境，请先执行: bash deploy/ubuntu22.04/install.sh"
  exit 1
fi

if [[ ! -f "$CONFIG_PATH" ]]; then
  echo "配置文件不存在: $CONFIG_PATH"
  echo "可复制模板: cp config.example.yaml config.yaml"
  exit 1
fi

stop_old_web() {
  local killed=0
  if command -v pkill >/dev/null 2>&1; then
    if pkill -f "web_app.py" 2>/dev/null; then
      killed=1
    fi
  fi
  if command -v fuser >/dev/null 2>&1; then
    fuser -k "${PORT}/tcp" 2>/dev/null && killed=1 || true
  elif command -v lsof >/dev/null 2>&1; then
    local pids
    pids="$(lsof -ti:"${PORT}" -sTCP:LISTEN 2>/dev/null || true)"
    if [[ -n "$pids" ]]; then
      kill $pids 2>/dev/null || true
      killed=1
    fi
  fi
  if [[ "$killed" -eq 1 ]]; then
    echo "已结束占用端口 ${PORT} 的旧 Web 进程"
    sleep 1
  fi
}

stop_old_web

HOST="${IP_ANNOUNCE_HOST:-}"
ARGS=(--config "$CONFIG_PATH")
if [[ -n "$HOST" ]]; then
  ARGS+=(--host "$HOST")
fi
if [[ -n "${IP_ANNOUNCE_PORT:-}" ]]; then
  ARGS+=(--port "$PORT")
fi

if [[ "${IP_ANNOUNCE_NO_RELOAD:-}" == "1" ]]; then
  echo "IP_ANNOUNCE_NO_RELOAD=1，未启用自动重载"
else
  ARGS+=(--reload)
  echo "开发模式：保存代码/模板后自动重载（禁用请设 IP_ANNOUNCE_NO_RELOAD=1）"
fi

exec "$VENV_PY" "$ROOT_DIR/web_app.py" "${ARGS[@]}"
