#!/bin/bash
# ============================================================
# CDS-Auto-Announce Flask 服务部署脚本
# 依附于 IP-Range-Manager 项目，在服务器上独立运行
# 用法：bash /opt/IP-Range-Manager/CDS-Auto-Announce/deploy-cds.sh
# ============================================================

set -e

APP_DIR="/opt/IP-Range-Manager/CDS-Auto-Announce"
APP_NAME="cds-auto-announce"
APP_PORT=9010

echo "=============================="
echo " CDS-Auto-Announce 部署"
echo "=============================="

cd "$APP_DIR"

# ── 1. 安装 Python 依赖 ────────────────────────────────────
echo "[1/3] 安装 Python 依赖..."
if [ ! -d ".venv" ]; then
  python3 -m venv .venv
fi
.venv/bin/pip install -q --upgrade pip
.venv/bin/pip install -q -r requirements.txt

# ── 2. 初始化配置文件 ──────────────────────────────────────
echo "[2/3] 检查配置文件..."
if [ ! -f "config.yaml" ]; then
  cp config.example.yaml config.yaml
  echo "  ⚠ 已从 config.example.yaml 创建 config.yaml，请编辑填写真实配置："
  echo "    nano $APP_DIR/config.yaml"
else
  echo "  config.yaml 已存在，跳过"
fi

# ── 3. 启动服务 ────────────────────────────────────────────
echo "[3/3] 启动服务..."
pm2 delete "$APP_NAME" 2>/dev/null || true
pm2 start "$APP_DIR/.venv/bin/python" \
  --name "$APP_NAME" \
  --cwd "$APP_DIR" \
  -- web_app.py
pm2 save

echo ""
echo "=============================="
echo " CDS-Auto-Announce 已启动！"
echo " 内部地址: http://127.0.0.1:$APP_PORT"
echo " 通过主服务访问: http://服务器IP:8081 → 首都在线宣告"
echo "=============================="
