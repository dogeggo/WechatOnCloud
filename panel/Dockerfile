# 面板镜像：前端 Vite 打包 + 后端 Fastify 网关（多架构 amd64/arm64）

# --- 1) 构建前端 ---
FROM node:22-slim AS web
WORKDIR /web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

# --- 2) 后端运行时 ---
FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev
COPY server/ ./
COPY --from=web /web/dist ./web-dist

ENV STATIC_DIR=/app/web-dist \
    PORT=8080
EXPOSE 8080
CMD ["npm", "run", "start"]
