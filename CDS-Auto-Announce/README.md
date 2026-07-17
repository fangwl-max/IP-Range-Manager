# IP段自动宣告与撤播系统（首云 OpenAPI）

本项目基于你指定的 7、8、23、24、25、26、27、28 号接口实现自动化：

- 7 `AddPublicIp`
- 8 `DeletePublicIp`
- 23 `DescribeBYOIPSiteCreateOptions`
- 24 `CreateBYOIPOneStep`
- 25 `DeleteBYOIP`
- 26 `BroadcastBYOIP`
- 27 `UndoBroadcastBYOIP`
- 28 `DescribeBYOIPList`

并在“撤播”链路中补充调用 `DescribeVdc` 用来定位公网段 `SegmentId`（因为 `DeletePublicIp` 必须传 `SegmentId`）。

## 1. 安装

### Windows（开发机）

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
copy config.example.yaml config.yaml
```

### Ubuntu 22.04（虚拟机部署）

```bash
cd /home/ubuntu/IP段自动宣告-20260602   # 项目实际目录
bash deploy/ubuntu22.04/install.sh
cp config.example.yaml config.yaml
# 编辑 config.yaml，填写 AK/SK、网段与 LOA 路径
```

安装脚本会自动创建 `.venv`、安装 `gunicorn`，并生成 `config.yaml`（若不存在）。

## 2. 配置

复制模板并填写：

```bash
copy config.example.yaml config.yaml
```

关键配置说明：

- `dry_run: true` 时只打印动作，不真正调用接口。
- `desired_state`:
  - `announced`：自动创建（可选）→ 广播 → 挂载到公网
  - `withdrawn`：公网解绑 → 撤播 → 删除BYOIP（可选）

## 3. 使用方式

### 3.1 查询可创建节点（接口23）

```bash
python ip_announce_system.py --config .\config.yaml --mode check-options
```

等价命令（输出更直观）：

```bash
python ip_announce_system.py --config .\config.yaml --mode list-create-options
```

### 3.1.1 查询公网资源 ID（PublicId / SegmentId）

```bash
python ip_announce_system.py --config .\config.yaml --mode list-public-network
```

按可用区过滤：

```bash
python ip_announce_system.py --config .\config.yaml --mode list-public-network --region-id CN_Beijing_A
```

JSON 输出（便于脚本解析）：

```bash
python ip_announce_system.py --config .\config.yaml --mode list-create-options --output json
python ip_announce_system.py --config .\config.yaml --mode list-public-network --output json
```

JSON 成功示例字段：

- `list-create-options`：`sites[].site_id`、`sites[].pipes[].pipe_id`、`sites[].pipes[].asn`
- `list-public-network`：`public_networks[].public_id`、`public_networks[].segments[].segment_id`

### 3.2 执行一轮自动对账（推荐先 dry-run）

```bash
python ip_announce_system.py --config .\config.yaml --mode once
```

### 3.3 按间隔循环执行

```bash
python ip_announce_system.py --config .\config.yaml --mode loop
```

### 3.4 启动网页控制台

**Windows（推荐）：**

```powershell
.\scripts\start_web.ps1
# 或一键重启（会先结束占用 9010 的旧进程）
.\scripts\restart_web.ps1
```

脚本会：① 结束已在跑的 `web_app.py` / 占用 9010 的进程；② 以 **自动重载** 模式启动（改 `.py`、模板保存后无需手动杀进程）。

直接 `python web_app.py` 时，本机 `127.0.0.1` 也会默认开启重载；生产环境请用 gunicorn + `IP_ANNOUNCE_NO_RELOAD=1`。

**Ubuntu 22.04：**

```bash
bash scripts/start_web.sh
# 或
source .venv/bin/activate
python web_app.py --config ./config.yaml
```

启动后访问：

- Windows 本机：`http://127.0.0.1:9010`
- Ubuntu 虚拟机（内网）：`http://<虚拟机IP>:9010`（`config.web.host` 建议 `0.0.0.0`）

页面分为三个主要入口：

- `/` 批量宣告：输入 IP 前缀、选择区域、填写 ASN，可一次添加多条并顺序宣告。
- `/announced` 已宣告IP段：从首云 `DescribeBYOIPList` 拉取「自有公网IP上云」列表并展示状态。
- `/withdraw` 批量撤播：须先登录；未登录时网段文本框与撤播按钮不可操作。
- `/login` 管理员登录：首次启动会从 `config.web.withdraw_admin_user/password` 初始化账号库。
- `/admin/accounts` 账号管理：超级管理员可增删账号、分配权限；操作员仅可修改自己的密码。
- 权限：`admin`（超级管理员）、`operator`（撤播操作员，无账号管理权限）。

区域下拉中「新加坡 B/C/D/E/F」为禁止选择；点击「刷新区域与 ASN」会强制拉取最新 ASN 列表。  
宣告页支持 LOA 文件上传到临时目录（`web.loa_temp_dir`），并可一键转正式目录（`web.loa_dir`）。  
若配置了 `ipxo` 段且 `enabled: true`，批量宣告时本地无 LOA 会自动从 IPXO 下载 PDF（需网段在 IPXO 有 Active/Pending 的 LOA）。

### 3.5 Ubuntu 生产部署（gunicorn + systemd）

```bash
source .venv/bin/activate
export IP_ANNOUNCE_CONFIG=/home/ubuntu/IP段自动宣告-20260602/config.yaml
gunicorn -w 2 -b 0.0.0.0:9010 --timeout 900 --graceful-timeout 120 --chdir /home/ubuntu/IP段自动宣告-20260602 wsgi:app
```

开机自启：

```bash
sudo cp deploy/ubuntu22.04/ip-announce-web.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now ip-announce-web
sudo systemctl status ip-announce-web
```

**新购 /25 耗时较长**（单次可达数分钟），gunicorn 必须设置 `--timeout 900`，否则浏览器会报 `network error` 且进度中断。更新代码后请同步 service 文件并重启。

**上游接收（bgp.tools）**：机房 IP 常被 Cloudflare 限流，服务器上可能无法实时查询。可将 Windows 开发机上的 `data/bgp_upstream_cache.json` 复制到服务器项目 `data/` 目录，已接受的结果会长期缓存展示。

```bash
# Windows 上传到服务器示例（在本机 PowerShell 执行，替换服务器 IP）
scp ".\data\bgp_upstream_cache.json" ubuntu@你的服务器IP:/home/ubuntu/IP段自动宣告-20260602/data/
```

### 3.6 跨平台环境变量

| 变量 | 说明 |
|------|------|
| `IP_ANNOUNCE_CONFIG` | 配置文件绝对/相对路径 |
| `IP_ANNOUNCE_HOST` | 覆盖监听地址 |
| `IP_ANNOUNCE_PORT` | 覆盖监听端口（默认 9010） |
| `IP_ANNOUNCE_SECRET_KEY` | 覆盖 Flask 会话密钥 |
| `IPXO_CLIENT_ID` | 覆盖 IPXO Client ID |
| `IPXO_CLIENT_SECRET` | 覆盖 IPXO APP API Key |
| `IPXO_TENANT_UUID` | 覆盖 IPXO Company UUID |

## 4. 自动化逻辑

### 宣告链路（`desired_state=announced`）

1. `DescribeBYOIPList` 查询该网段是否存在。
2. 不存在且 `auto_create=true` 时，`CreateBYOIPOneStep` 创建 BYOIP（上传 LOA PDF）。
3. BYOIP 非已广播状态时，调用 `BroadcastBYOIP`。
4. 通过 `DescribeVdc` 检查公网是否已挂载该段；未挂载则调用 `AddPublicIp`。

### 撤播链路（`desired_state=withdrawn`）

1. `DescribeVdc` 找到公网 `SegmentId` 后调用 `DeletePublicIp` 解绑网段。
2. `DescribeBYOIPList` 查询 BYOIP 状态。
3. 若处于广播态，则调用 `UndoBroadcastBYOIP`。
4. 若开启 `auto_delete_when_withdrawn=true`，调用 `DeleteBYOIP` 删除资源。

## 5. 跨平台兼容说明

- 路径统一用 `pathlib` 解析，`loa_file` 支持相对路径（相对配置文件目录或项目根目录）。
- Windows 默认监听 `127.0.0.1`；Linux 默认 `0.0.0.0`，便于虚拟机内网访问。
- 行尾符：脚本 `*.sh` 使用 LF，在 Ubuntu 上可直接执行。
- 防火墙：Ubuntu 需放行 `9010/tcp`（`sudo ufw allow 9010/tcp`）。

## 6. 注意事项

- `CreateBYOIPOneStep` 必须提供 LOA PDF 文件，且字段名固定为 `file`。
- 当前已实现 LOA 本地上传、临时存放和转正式；首云 OpenAPI 暂无可用的 LOA 下载接口，无法直接从官网自动回拉 LOA 原文件。
- `AddPublicIp` 的 `Number` 需使用平台支持档位（如 4/8/16/32/64）。
- 所有变更接口都是异步任务下发，脚本当前以“提交成功”为目标，不轮询任务完成状态。
- 建议先小流量、单网段验证，再扩大到全量规则。
- Web 页面会读取 `automation.desired_prefixes[].provider` 字段，当前支持：
  - `capitalonline`（已实现）
  - 其他供应商可后续按相同接口扩展
