#!/bin/bash
# ============================================================
# Docker 部署：初始化 data/ 目录（首次部署或重建时执行）
# 用法：bash init-data.sh
# 在 docker-compose.yml 同级目录下执行
# ============================================================

set -e

DATA_DIR="./data"

echo "[init-data] 初始化 data/ 目录..."
mkdir -p "$DATA_DIR/backups" "$DATA_DIR/exports" "$DATA_DIR/loa" "$DATA_DIR/cds-data"

# ── CDS 配置文件（含代理和 IPXO）─────────────────────────────
if [ ! -f "$DATA_DIR/cds-app-config.yaml" ]; then
  cat > "$DATA_DIR/cds-app-config.yaml" << 'EOF'
api:
  access_key_id: "5485521e7b6f11f1a367d62cb262bc36"
  access_key_secret: "6acdad0f623e0508ccd308b6207e007a"
  version: "2019-08-08"
  network_base_url: "https://cdsapi.capitalonline.net/network"
  wan_service_base_url: "https://api.capitalonline.net/wan_service"
  ccs_base_url: "https://cdsapi.capitalonline.net/ccs"
  timeout_seconds: 20
  connect_timeout_seconds: 30
  read_timeout_seconds: 90
  max_retries: 2

web:
  host: "127.0.0.1"
  port: 9010
  secret_key: "ip-announce-dashboard-change-me"
  withdraw_admin_user: "admin"
  withdraw_admin_password: "admin"
  loa_dir: "./loa"
  default_ip_number: 4
  default_purchase_ip_number: 128
  auto_create_on_announce: true
  auto_delete_when_withdrawn: false
  project_id: "0-0"
  bgp_tools_proxy: "http://7272975-c887d6c9:40b27aff-DE-08057865@gate.kookeey.info:1000"

ipxo:
  enabled: true
  client_id: "102100b8-3796-4e9f-a87f-92def116ea49"
  client_secret: "9PZ96Dsa9CaIMNfBcTqV1A8Ot5"
  tenant_uuid: "b4efc435-f89e-4361-b668-4b32afab65d9"
  auto_fetch_on_announce: true

automation:
  interval_seconds: 300
  dry_run: false
  desired_prefixes: []
EOF
  echo "  [OK] 已创建 cds-app-config.yaml"
else
  echo "  [SKIP] cds-app-config.yaml 已存在"
fi

# ── CDS 启用配置 ──────────────────────────────────────────────
if [ ! -f "$DATA_DIR/cds-config.json" ]; then
  cat > "$DATA_DIR/cds-config.json" << 'EOF'
{
  "enabled": true,
  "port": 9010,
  "configPath": ""
}
EOF
  echo "  [OK] 已创建 cds-config.json"
else
  echo "  [SKIP] cds-config.json 已存在"
fi

# ── 其他配置文件初始化 ─────────────────────────────────────────
if [ ! -f "$DATA_DIR/zen-config.json" ]; then
  cat > "$DATA_DIR/zen-config.json" << 'EOF'
{
  "accessKeyId": "请填写你的 Zenlayer AccessKeyId",
  "accessKeySecret": "请填写你的 Zenlayer AccessKeySecret",
  "apiVersion": "2024-09-01"
}
EOF
  echo "  [OK] 已创建 zen-config.json（需编辑填写 API Key）"
else
  echo "  [SKIP] zen-config.json 已存在"
fi

if [ ! -f "$DATA_DIR/users.json" ]; then
  DEFAULT_PASS=$(echo -n "admin123" | sha256sum | cut -d' ' -f1)
  cat > "$DATA_DIR/users.json" << EOF
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
  echo "  [OK] 已创建 users.json（默认账号 admin / admin123）"
else
  echo "  [SKIP] users.json 已存在"
fi

# 空数据文件（避免容器启动时报错）
for f in ip-data.json ipxo-config.json notify-config.json ipxo-cache.json ipxo-upcoming-status.json asn-standby-groups.json; do
  if [ ! -f "$DATA_DIR/$f" ]; then
    echo '{}' > "$DATA_DIR/$f"
    echo "  [OK] 已创建 $f"
  fi
done

echo ""
echo "[init-data] 完成！可执行 docker compose up -d 启动服务"
