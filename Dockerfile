# LastMile —— 生产镜像
# 关键点：必须 Node 24（server/db.js 用的是内置 node:sqlite，Node 22 及以下需要 --experimental-sqlite 甚至没有该模块）

# ---------- 构建阶段：装全量依赖并把前端打包 ----------
FROM node:24-alpine AS build
WORKDIR /app

COPY package.json package-lock.json ./
# 这里必须带 devDeps，vite 在 devDependencies 里
RUN npm ci --include=dev

COPY . .
RUN npm run build

# ---------- 运行阶段：只留服务端需要的东西 ----------
FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# 运行时要读的：server/ 代码、docs/schema.sql、public/ 静态产物
COPY --from=build /app/server ./server
COPY --from=build /app/docs ./docs
COPY --from=build /app/public ./public

# SQLite 落盘目录（Railway 建议挂一个 volume 到这里，否则每次部署会被清空）
RUN mkdir -p /app/data

# Railway 会注入 PORT，server/index.js 读 process.env.PORT 并监听 0.0.0.0
EXPOSE 3000
CMD ["node", "server/index.js"]
