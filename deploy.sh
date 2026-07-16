#!/bin/bash
# ============================================================
# IP-Range-Manager 首次部署脚本（完整重装版）
# 适用于 Ubuntu / Debian / CentOS
# 用法：bash deploy.sh
# ============================================================

set -e

REPO_URL="https://github.com/fangwl-max/IP-Range-Manager.git"
APP_DIR="/opt/IP-Range-Manager"
APP_PORT=8081
APP_NAME="ip-range-manager"

echo "=============================="
echo " IP-Range-Manager 首次部署"
echo "=============================="

# ── 1. 停止并删除旧进程 ────────────────────────────────────
echo "[1/7] 清理旧进程..."
pm2 delete all 2>/dev/null || true

# ── 2. 删除旧目录 ──────────────────────────────────────────
if [ -d "$APP_DIR" ]; then
  echo "[2/7] 删除旧目录 $APP_DIR..."
  rm -rf "$APP_DIR"
else
  echo "[2/7] 无旧目录，跳过"
fi

# ── 3. 安装 Node.js（如果未安装）──────────────────────────
if ! command -v node &> /dev/null; then
  echo "[3/7] 安装 Node.js 20..."
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs 2>/dev/null || yum install -y nodejs 2>/dev/null
else
  echo "[3/7] Node.js 已安装: $(node --version)"
fi

# ── 4. 安装 PM2（如果未安装）──────────────────────────────
if ! command -v pm2 &> /dev/null; then
  echo "[4/7] 安装 PM2..."
  npm install -g pm2
else
  echo "[4/7] PM2 已安装: $(pm2 --version)"
fi

# ── 5. 克隆代码 ────────────────────────────────────────────
echo "[5/7] 克隆代码到 $APP_DIR..."
git clone "$REPO_URL" "$APP_DIR"
cd "$APP_DIR"

# 修复目录权限（确保当前用户可读写）
chown -R $(whoami):$(whoami) "$APP_DIR"

# ── 6. 安装依赖 ────────────────────────────────────────────
echo "[6/7] 安装 npm 依赖..."
npm install

# ── 7. 初始化配置文件 ──────────────────────────────────────
echo "[7/7] 初始化配置文件..."

if [ ! -f "zen-config.json" ]; then
  cat > zen-config.json << 'EOF'
{
  "accessKeyId": "请填写你的 Zenlayer AccessKeyId",
  "accessKeySecret": "请填写你的 Zenlayer AccessKeySecret",
  "apiVersion": "2024-09-01"
}
EOF
  echo "  ⚠ 已创建 zen-config.json，请编辑填写真实的 API Key"
fi

if [ ! -f "users.json" ]; then
  DEFAULT_PASS=$(echo -n "admin123" | sha256sum | cut -d' ' -f1)
  cat > users.json << EOF
{
  "users": [
    {
      "id": "1",
      "username": "admin",
      "password": "$DEFAULT_PASS",
      "role": "admin"
    }
  ]
}
EOF
  echo "  ✓ 已创建 users.json，默认账号 admin / admin123"
fi

# ── 启动服务 ───────────────────────────────────────────────
echo "启动服务..."
pm2 start npm --name "$APP_NAME" -- run dev
pm2 save
pm2 startup 2>/dev/null || true

# ── 完成 ───────────────────────────────────────────────────
SERVER_IP=$(curl -s ifconfig.me 2>/dev/null || hostname -I | awk '{print $1}')
echo ""
echo "=============================="
echo " 部署完成！"
echo "=============================="
echo " 访问地址: http://$SERVER_IP:$APP_PORT"
echo " 默认账号: admin / admin123"
echo ""
echo " 配置 Zenlayer API Key："
echo "   nano $APP_DIR/zen-config.json"
echo "   pm2 restart $APP_NAME"
echo "=============================="
