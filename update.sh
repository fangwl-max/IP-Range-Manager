#!/bin/bash
# ============================================================
# IP-Range-Manager 更新部署脚本
# 用法：bash update.sh
# ============================================================

set -e

APP_DIR="/opt/IP-Range-Manager"
APP_NAME="ip-range-manager"

echo "=============================="
echo " IP-Range-Manager 更新部署"
echo "=============================="

cd "$APP_DIR"

# ── 1. 拉取最新代码 ────────────────────────────────────────
echo "[1/3] 拉取最新代码..."
git pull origin main

# ── 2. 更新依赖（如果 package.json 有变化）────────────────
if git diff HEAD@{1} --name-only 2>/dev/null | grep -q "package.json\|package-lock.json"; then
  echo "[2/3] 检测到依赖变化，重新安装..."
  npm install --production=false
else
  echo "[2/3] 依赖无变化，跳过安装"
fi

# ── 3. 重启服务 ────────────────────────────────────────────
echo "[3/3] 重启服务..."
pm2 restart "$APP_NAME"

# ── 完成 ───────────────────────────────────────────────────
echo ""
echo "=============================="
echo " 更新完成！"
echo "=============================="
echo " 查看日志: pm2 logs $APP_NAME"
echo " 查看状态: pm2 status"
echo "=============================="
