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
# .npmrc 一并拷入：国内网络下默认走国内镜像源（可用 NPM_REGISTRY 构建参数覆盖）
COPY package.json package-lock.json* .npmrc ./
COPY packages/shared/package.json ./packages/shared/
COPY packages/server/package.json ./packages/server/
COPY packages/web/package.json ./packages/web/

# --ignore-scripts 是必须的，且语义正确：
# 本项目用到的原生模块（better-sqlite3、@node-rs/argon2、esbuild、rolldown）
# 都在 npm 包里自带各平台预编译产物，无需在安装时编译。
# 反之若允许脚本执行，npm 会因 better-sqlite3 带 binding.gyp 而调用 node-gyp，
# 而 slim 镜像不含 python3/make/g++，构建会直接失败（已实测）。
RUN npm ci --include=dev --ignore-scripts

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

# 这里刻意不执行 apt-get。
#
# 原先安装 tini + ca-certificates，但：
#   1) Node 自带 Mozilla 根证书，不依赖系统 CA（已实测：无 ca-certificates 时
#      https 请求照常成功），因此应用调用 Resend / WebDAV / S3 不受影响；
#   2) 信号转发由 docker-compose 的 `init: true` 提供（见 docker-compose.yml），
#      单独 docker run 时 Node 自己处理 SIGTERM 也足够（服务已注册处理器）。
# 去掉这一步后，构建不再访问 Debian 源 —— 国内网络下 apt-get update 实测要
# 7 分钟（22 kB/s），是构建慢的主因。

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

# npm workspaces 会把 node_modules/@readsync/shared 做成指向 ../../packages/shared
# 的符号链接。必须让该真实路径存在，否则运行时解析不到共享包 ——
# 直接往符号链接里 COPY 是不可靠的（目标目录在本阶段尚不存在）。
COPY --from=builder --chown=readsync:readsync /build/packages/shared/package.json ./packages/shared/package.json
COPY --from=builder --chown=readsync:readsync /build/packages/shared/dist ./packages/shared/dist

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

# 直接以 node 启动。作为 PID 1 时由服务自身的 SIGTERM/SIGINT 处理器完成优雅退出；
# 通过 docker-compose 启动时会由 `init: true` 提供 init 进程转发信号。
CMD ["node", "server/index.js"]
