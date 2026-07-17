#!/usr/bin/env bash
# Ubuntu 22.04 一键安装（建议在项目根目录执行）
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

echo "[1/5] 安装系统依赖..."
sudo apt-get update -y
sudo apt-get install -y python3 python3-venv python3-pip

echo "[2/5] 创建 Python 虚拟环境..."
python3 -m venv .venv
source .venv/bin/activate

echo "[3/5] 安装 Python 依赖..."
pip install --upgrade pip
pip install -r requirements.txt -r requirements-prod.txt

echo "[4/5] 准备配置与目录..."
mkdir -p loa logs
if [[ ! -f config.yaml ]]; then
  cp config.example.yaml config.yaml
  echo "已生成 config.yaml，请填写 AK/SK 与网段参数。"
fi

chmod +x scripts/start_web.sh deploy/ubuntu22.04/install.sh 2>/dev/null || true

echo "[5/5] 安装完成。"
echo ""
echo "开发/测试启动:"
echo "  bash scripts/start_web.sh"
echo ""
echo "生产环境（gunicorn）:"
echo "  source .venv/bin/activate"
echo "  export IP_ANNOUNCE_CONFIG=$ROOT_DIR/config.yaml"
echo "  gunicorn -w 2 -b 0.0.0.0:9010 --timeout 900 --graceful-timeout 120 --chdir $ROOT_DIR wsgi:app"
echo ""
echo "systemd 开机自启:"
echo "  sudo cp deploy/ubuntu22.04/ip-announce-web.service /etc/systemd/system/"
echo "  sudo systemctl daemon-reload"
echo "  sudo systemctl enable --now ip-announce-web"
