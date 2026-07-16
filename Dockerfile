FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .
EXPOSE 8081

# 数据文件持久化目录（运行时需挂载）
VOLUME ["/app/ip-data.json"]

CMD ["npm", "run", "dev"]
