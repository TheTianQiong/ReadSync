# ============================================================================
# ReadSync 多阶段构建
#
# 构建：docker build -f deploy/Dockerfile -t readsync:latest .
# 运行：docker run -d -p 3000:3000 -v readsync-data:/app/data readsync:latest
# ============================================================================

# ------------------------------ 构建阶段 ------------------------------
FROM node:22-bookworm-slim AS builder

WORKDIR /build

# 国内构建加速：通过 build-arg 注入镜像源，默认走官方源
ARG NPM_REGISTRY=https://registry.npmjs.org/
ARG NODE_MIRROR=

ENV npm_config_registry=${NPM_REGISTRY} \
    npm_config_audit=false \
    npm_config_fund=false

# 先只拷贝清单文件，让依赖层能被 Docker 缓存复用
COPY package.json package-lock.json* ./
COPY packages/shared/package.json ./packages/shared/
COPY packages/server/package.json ./packages/server/
COPY packages/web/package.json ./packages/web/

# 原生模块 better-sqlite3 需要预编译包；国内网络可指定二进制镜像
RUN npm ci --include=dev --ignore-scripts \
    && npm rebuild better-sqlite3

# 拷贝源码并构建
COPY tsconfig.base.json ./
COPY packages/shared ./packages/shared
COPY packages/server ./packages/server
COPY packages/web ./packages/web

RUN npm run build:shared \
    && npm run build:server \
    && npm run build:web

# 剔除 dev 依赖，只保留运行时需要的包
RUN npm prune --omit=dev

# ------------------------------ 运行阶段 ------------------------------
FROM node:22-bookworm-slim AS runtime

# tini 负责回收僵尸进程并正确转发信号（Node 作为 PID 1 时 docker stop 会超时）
RUN apt-get update \
    && apt-get install -y --no-install-recommends tini ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# 不用 root 运行
RUN groupadd --gid 10001 readsync \
    && useradd --uid 10001 --gid readsync --shell /usr/sbin/nologin --create-home readsync

WORKDIR /app

ENV NODE_ENV=production \
    READSYNC_PORT=3000 \
    READSYNC_HOST=0.0.0.0 \
    READSYNC_DATA_DIR=/app/data \
    READSYNC_SERVE_WEB=true \
    READSYNC_WEB_DIST=/app/web

# 依赖与构建产物
COPY --from=builder --chown=readsync:readsync /build/node_modules ./node_modules
COPY --from=builder --chown=readsync:readsync /build/package.json ./package.json
COPY --from=builder --chown=readsync:readsync /build/packages/shared/dist ./node_modules/@readsync/shared/dist
COPY --from=builder --chown=readsync:readsync /build/packages/shared/package.json ./node_modules/@readsync/shared/package.json
COPY --from=builder --chown=readsync:readsync /build/packages/server/dist ./server
COPY --from=builder --chown=readsync:readsync /build/packages/server/drizzle ./server/drizzle
COPY --from=builder --chown=readsync:readsync /build/packages/web/dist ./web

# 数据卷：数据库、密钥、插件、本地存储都在这里，务必持久化
RUN mkdir -p /app/data && chown -R readsync:readsync /app/data
VOLUME ["/app/data"]

USER readsync

EXPOSE 3000

# 健康检查直接用内置接口，避免额外装 curl
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.READSYNC_PORT||3000)+'/api/system/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "server/index.js"]
