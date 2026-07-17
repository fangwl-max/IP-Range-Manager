FROM node:20-slim

WORKDIR /app

# ── 安装 Python 和 pip（用于 CDS-Auto-Announce Flask 服务）────────────────
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-pip python3-venv \
    && rm -rf /var/lib/apt/lists/*

# ── 安装 Node.js 依赖 ─────────────────────────────────────────────────────
COPY package*.json ./
RUN npm install

# ── 安装 Python 依赖（CDS-Auto-Announce）────────────────────────────────
COPY CDS-Auto-Announce/requirements.txt ./CDS-Auto-Announce/
RUN python3 -m venv ./CDS-Auto-Announce/.venv \
    && ./CDS-Auto-Announce/.venv/bin/pip install --no-cache-dir \
       -r ./CDS-Auto-Announce/requirements.txt

# ── 复制源码 ──────────────────────────────────────────────────────────────
COPY . .

# ── 对外暴露端口 ──────────────────────────────────────────────────────────
EXPOSE 8081

# ── 启动命令 ──────────────────────────────────────────────────────────────
CMD ["npm", "run", "dev"]
