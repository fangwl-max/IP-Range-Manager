#!/bin/bash
# ============================================================
# Docker 部署初始化脚本
# 将宿主机现有配置文件复制到 ./data/ 目录
# 用法：bash docker-init.sh
# ============================================================

set -e

DEPLOY_DIR="$(cd "$(dirname "$0")" && pwd)"
DATA_DIR="$DEPLOY_DIR/data"

echo "=============================="
echo " 初始化 Docker 数据目录"
echo "=============================="

mkdir -p "$DATA_DIR/backups" "$DATA_DIR/exports" "$DATA_DIR/loa" "$DATA_DIR/cds-data"

# 从旧部署目录复制配置和数据文件（如果存在）
OLD_DIR="/opt/IP-Range-Manager"

copy_if_exists() {
  local src="$1"
  local dst="$2"
  if [ -f "$src" ]; then
    cp "$src" "$dst"
    echo "  ✓ 复制 $src → $dst"
  else
    echo "  ⚠ 未找到 $src，请手动创建 $dst"
    touch "$dst"
  fi
}

echo "[1/2] 复制配置文件..."
copy_if_exists "$OLD_DIR/zen-config.json"           "$DATA_DIR/zen-config.json"
copy_if_exists "$OLD_DIR/users.json"                "$DATA_DIR/users.json"
copy_if_exists "$OLD_DIR/ipxo-config.json"          "$DATA_DIR/ipxo-config.json"
copy_if_exists "$OLD_DIR/notify-config.json"        "$DATA_DIR/notify-config.json"
copy_if_exists "$OLD_DIR/cds-config.json"           "$DATA_DIR/cds-config.json"
copy_if_exists "$OLD_DIR/CDS-Auto-Announce/config.yaml" "$DATA_DIR/cds-app-config.yaml"

echo "[2/2] 复制数据文件..."
copy_if_exists "$OLD_DIR/ip-data.json"              "$DATA_DIR/ip-data.json"
copy_if_exists "$OLD_DIR/ipxo-cache.json"           "$DATA_DIR/ipxo-cache.json"
copy_if_exists "$OLD_DIR/ipxo-upcoming-status.json" "$DATA_DIR/ipxo-upcoming-status.json"
copy_if_exists "$OLD_DIR/asn-standby-groups.json"   "$DATA_DIR/asn-standby-groups.json"

# 复制备份和导出目录
if [ -d "$OLD_DIR/backups" ]; then
  cp -r "$OLD_DIR/backups/." "$DATA_DIR/backups/"
  echo "  ✓ 复制 backups/"
fi
if [ -d "$OLD_DIR/exports" ]; then
  cp -r "$OLD_DIR/exports/." "$DATA_DIR/exports/"
  echo "  ✓ 复制 exports/"
fi
if [ -d "$OLD_DIR/CDS-Auto-Announce/loa" ]; then
  cp -r "$OLD_DIR/CDS-Auto-Announce/loa/." "$DATA_DIR/loa/"
  echo "  ✓ 复制 CDS loa/"
fi
if [ -d "$OLD_DIR/CDS-Auto-Announce/data" ]; then
  cp -r "$OLD_DIR/CDS-Auto-Announce/data/." "$DATA_DIR/cds-data/"
  echo "  ✓ 复制 CDS data/"
fi

echo ""
echo "=============================="
echo " 初始化完成！"
echo "=============================="
echo " 数据目录：$DATA_DIR"
echo ""
echo " 下一步："
echo "   1. 检查 $DATA_DIR 下的配置文件内容是否正确"
echo "   2. 构建并启动容器："
echo "      docker compose build"
echo "      docker compose up -d"
echo "   3. 查看日志："
echo "      docker compose logs -f"
echo "=============================="
