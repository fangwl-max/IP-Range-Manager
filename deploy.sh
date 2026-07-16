#!/bin/bash
# ============================================================
# IP-Range-Manager 首次部署脚本
# 适用于 Ubuntu / Debian / CentOS
# 用法：chmod +x deploy.sh && sudo bash deploy.sh
# ============================================================

set -e

REPO_URL="https://github.com/fangwl-max/IP-Range-Manager.git"
APP_DIR="/opt/IP-Range-Manager"
APP_PORT=8081
APP_NAME="ip-range-manager"

echo "=============================="
echo " IP-Range-Manager 首次部署"
echo "=============================="

# ── 1. 安装 Node.js（如果未安装）──────────────────────────
if ! command -v node &> /dev/null; then
  echo "[1/6] 安装 Node.js 20..."
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs 2>/dev/null || yum install -y nodejs 2>/dev/null
else
  echo "[1/6] Node.js 已安装: $(node --version)"
fi

# ── 2. 安装 PM2（如果未安装）──────────────────────────────
if ! command -v pm2 &> /dev/null; then
  echo "[2/6] 安装 PM2..."
  npm install -g pm2
else
  echo "[2/6] PM2 已安装: $(pm2 --version)"
fi

# ── 3. 克隆代码 ────────────────────────────────────────────
echo "[3/6] 克隆代码到 $APP_DIR..."
if [ -d "$APP_DIR" ]; then
  echo "  目录已存在，跳过克隆（如需重新部署请先删除 $APP_DIR）"
else
  git clone "$REPO_URL" "$APP_DIR"
fi
cd "$APP_DIR"

# ── 4. 安装依赖 ────────────────────────────────────────────
echo "[4/6] 安装 npm 依赖..."
npm install --production=false

# ── 5. 初始化配置文件 ──────────────────────────────────────
echo "[5/6] 初始化配置文件..."

if [ ! -f "zen-config.json" ]; then
  cat > zen-config.json << 'EOF'
{
  "accessKeyId": "请填写你的 Zenlayer AccessKeyId",
  "accessKeySecret": "请填写你的 Zenlayer AccessKeySecret",
  "apiVersion": "2024-09-01"
}
EOF
  echo "  ⚠ 已创建 zen-config.json，请编辑填写真实的 API Key"
else
  echo "  zen-config.json 已存在，跳过"
fi

if [ ! -f "users.json" ]; then
  # 生成随机密码 hash（sha256）
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
  echo "  ⚠ 已创建 users.json，默认账号 admin / admin123，请及时修改密码"
else
  echo "  users.json 已存在，跳过"
fi

# ── 6. 启动服务 ────────────────────────────────────────────
echo "[6/6] 启动服务..."
pm2 delete "$APP_NAME" 2>/dev/null || true
pm2 start npm --name "$APP_NAME" -- run dev
pm2 save

# 设置开机自启（输出的命令需要手动执行一次）
pm2 startup 2>/dev/null || true

# ── 完成 ───────────────────────────────────────────────────
echo ""
echo "=============================="
echo " 部署完成！"
echo "=============================="
echo " 访问地址: http://$(hostname -I | awk '{print $1}'):$APP_PORT"
echo " 查看日志: pm2 logs $APP_NAME"
echo " 查看状态: pm2 status"
echo ""
echo " ⚠ 请记得编辑以下配置文件："
echo "   $APP_DIR/zen-config.json  (Zenlayer API Key)"
echo "   $APP_DIR/users.json       (登录账号密码)"
echo "=============================="
