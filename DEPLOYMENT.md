# IP 段管理平台 - 服务部署指南

本系统基于 Vite + React 开发，后端 API 集成在 Vite 开发服务器中。部署到服务器可采用以下方式。

---

## 方式一：使用 PM2 部署（推荐）

适用于 Linux 服务器，可持久运行并支持开机自启。

### 1. 环境准备

```bash
# 安装 Node.js（建议 v18+）
# Ubuntu/Debian
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

# 或使用 nvm
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.0/install.sh | bash
nvm install 20
```

### 2. 安装项目依赖

```bash
cd /path/to/IP段管理平台
npm install
```

### 3. 安装 PM2

```bash
npm install -g pm2
```

### 4. 启动服务

```bash
# 启动服务（包含完整 API 功能）
pm2 start npm --name "ip-management" -- run start

# 查看状态
pm2 status

# 查看日志
pm2 logs ip-management
```

### 5. 开机自启

```bash
pm2 startup
pm2 save
```

### 6. 防火墙配置

放行 8081 端口：

```bash
# Ubuntu (ufw)
sudo ufw allow 8081
sudo ufw reload

# CentOS/RHEL (firewalld)
sudo firewall-cmd --permanent --add-port=8081/tcp
sudo firewall-cmd --reload
```

### 7. 访问

- 本机：http://localhost:8081
- 局域网：http://服务器IP:8081
- 公网：http://公网IP:8081（若服务器有公网 IP）

---

## 方式二：使用 Docker 部署

### 1. 创建 Dockerfile

在项目根目录创建 `Dockerfile`：

```dockerfile
FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .
EXPOSE 8081

CMD ["npm", "run", "dev"]
```

### 2. 构建与运行

```bash
# 创建数据文件（首次部署）
touch ip-data.json

# 构建镜像
docker build -t ip-management .

# 运行容器（挂载数据文件以持久化）
docker run -d -p 8081:8081 -v $(pwd)/ip-data.json:/app/ip-data.json --name ip-management ip-management
```

`-v` 挂载数据文件，保证重启后数据不丢失。

### 3. 使用 docker-compose（可选）

创建 `docker-compose.yml`：

```yaml
version: '3'
services:
  ip-management:
    build: .
    ports:
      - "8081:8081"
    volumes:
      - ./ip-data.json:/app/ip-data.json   # 数据持久化
    restart: unless-stopped
```

首次运行前执行 `touch ip-data.json`，然后启动：`docker-compose up -d`

---

## 方式三：使用 systemd（Linux 服务）

### 1. 创建服务文件

```bash
sudo nano /etc/systemd/system/ip-management.service
```

内容：

```ini
[Unit]
Description=IP Segment Management Platform
After=network.target

[Service]
Type=simple
User=your-user
WorkingDirectory=/path/to/IP段管理平台
ExecStart=/usr/bin/npm run dev
Restart=on-failure
RestartSec=10
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

### 2. 启用并启动

```bash
sudo systemctl daemon-reload
sudo systemctl enable ip-management
sudo systemctl start ip-management
sudo systemctl status ip-management
```

---

## 数据持久化

- 数据保存在项目根目录的 `ip-data.json`
- 部署时请确保该文件可写
- 使用 Docker 时需挂载卷或目录，例如：
  ```bash
  docker run -d -p 8081:8081 -v $(pwd)/data:/app ip-management
  ```
  并将数据文件放在 `./data/ip-data.json`，或在首次运行后从容器内复制

---

## 使用 Nginx 反向代理（可选）

如需使用 80 端口或配置 HTTPS：

```nginx
server {
    listen 80;
    server_name your-domain.com;

    location / {
        proxy_pass http://127.0.0.1:8081;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
    }
}
```

---

## 常见问题

1. **端口被占用**：修改 `vite.config.ts` 中 `server.port` 为其他端口（如 8082）
2. **无法外网访问**：确认防火墙已放行端口，且 `server.host` 为 `0.0.0.0`（已配置）
3. **数据丢失**：确认 `ip-data.json` 路径正确且有写入权限
