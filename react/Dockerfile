# === 第一阶段：构建构建产物 ===
FROM node:18-alpine AS builder

WORKDIR /app

# 复制 package.json 和 package-lock.json 先安装依赖 (利用缓存)
COPY package*.json ./
RUN npm ci

# 复制前端代码并打包
COPY . .
RUN npm run build

# === 第二阶段：使用 Nginx 部署 ===
FROM nginx:alpine

# 将构建产物从 builder 阶段复制到 Nginx 的默认静态文件目录
# 注意：Vite 默认的打包输出目录是 dist，如果是 build 请自行替换
COPY --from=builder /app/dist /usr/share/nginx/html

# 暴露 80 端口
EXPOSE 80

# 启动 Nginx
CMD ["nginx", "-g", "daemon off;"]