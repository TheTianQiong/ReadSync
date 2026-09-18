import { existsSync } from 'node:fs';
import path from 'node:path';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyError, type FastifyInstance, type FastifyServerOptions } from 'fastify';
import { ZodError } from 'zod';
import { ERROR_CODES, type ApiFailure } from '@readsync/shared';
import { loadConfig } from './config.js';
import { AppError, isAppError } from './errors.js';
import { getLogger } from './logger.js';
import { resolveAuth } from './middleware/auth.js';
import { registerAdminRoutes } from './modules/admin/routes.js';
import { registerAuthRoutes } from './modules/auth/routes.js';
import { registerLibraryRoutes } from './modules/library/routes.js';
import { registerPluginRoutes } from './modules/plugins/routes.js';
import { registerKosyncRoutes } from './modules/sync/kosync.js';
import { registerSyncRoutes } from './modules/sync/routes.js';
import { registerSystemRoutes } from './modules/system/routes.js';
import { registerStatsRoutes } from './modules/stats/routes.js';
import { registerStorageRoutes } from './modules/storage/routes.js';
import { registerUserRoutes } from './modules/users/routes.js';

/**
 * Fastify 应用组装。
 *
 * 路由模块的约定：每个模块导出 `registerXxxRoutes(app)`，
 * 内部自行声明 prefix，便于把 prefix 与模块放在一起维护。
 * 所有 /api/* 接口统一返回 ApiResponse 信封；KOSync 兼容端点例外，
 * 它必须保持上游 KOReader 的原始响应格式（详见 docs/sync-api.md）。
 */

export interface BuildAppOptions {
  /** 覆盖 Fastify 选项（测试时可关掉日志） */
  fastify?: FastifyServerOptions;
  /** 是否注册静态前端托管，默认取配置 */
  serveWeb?: boolean;
}

export async function buildApp(options: BuildAppOptions = {}): Promise<FastifyInstance> {
  const config = loadConfig();
  const logger = getLogger();

  const app = Fastify({
    loggerInstance: logger,
    trustProxy: config.READSYNC_TRUST_PROXY,
    // KOSync 的 progress 字段可能很长，放宽 body 限制
    bodyLimit: 8 * 1024 * 1024,
    // 生成请求 id，便于把一次请求的所有日志串起来
    genReqId: () => crypto.randomUUID(),
    ...options.fastify,
  });

  /* ----------------------------- 基础插件 ----------------------------- */

  await app.register(helmet, {
    // 前端是 SPA，需要允许内联样式（Tailwind 运行时注入）与 data: 图片
    contentSecurityPolicy: config.NODE_ENV === 'production'
      ? {
          directives: {
            defaultSrc: ["'self'"],
            styleSrc: ["'self'", "'unsafe-inline'"],
            imgSrc: ["'self'", 'data:', 'blob:', 'https:'],
            scriptSrc: ["'self'"],
            connectSrc: ["'self'"],
            objectSrc: ["'none'"],
            frameAncestors: ["'none'"],
          },
        }
      : false,
    // 允许跨域携带图片资源
    crossOriginResourcePolicy: { policy: 'cross-origin' },
  });

  await app.register(cors, {
    origin: config.corsOrigins.length > 0 ? config.corsOrigins : true,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'PROPFIND'],
  });

  await app.register(cookie, {
    secret: config.secret,
    hook: 'onRequest',
  });

  await app.register(rateLimit, {
    global: false, // 按路由单独开启，避免 KOSync 高频同步被误伤
    max: 100,
    timeWindow: '1 minute',
    // 限流计数按「客户端 IP + 路由」分桶。
    // 若只用 IP，登录接口的 10 次/分钟会与注册、找回密码等共享同一配额，
    // 用户在登录页试错几次后就再也收不到重置邮件了。
    keyGenerator: (req) => `${req.ip}:${req.routeOptions?.url ?? req.url.split('?')[0]}`,
  });

  await app.register(multipart, {
    limits: {
      // 实际的上传上限在书籍上传路由里按站点设置二次校验
      fileSize: Math.max(config.READSYNC_PORT > 0 ? 2 * 1024 * 1024 * 1024 : 0, 1024 * 1024),
      files: 1,
    },
  });

  /* --------------------------- 认证信息解析 --------------------------- */

  // 所有请求先尝试解析登录态；是否强制登录由各路由的 preHandler 决定
  app.addHook('onRequest', async (req) => {
    await resolveAuth(req);
  });

  /* ----------------------------- 错误处理 ----------------------------- */

  app.setErrorHandler((error: FastifyError, req, reply) => {
    // 请求体校验失败（Fastify 内置 schema 校验）
    if (error.validation) {
      const body: ApiFailure = {
        ok: false,
        error: {
          code: ERROR_CODES.VALIDATION_FAILED,
          message: '请求参数校验失败',
          details: error.validation,
        },
      };
      return reply.status(400).send(body);
    }

    /**
     * 路由里 `schema.parse(req.body)` 抛出的 ZodError。
     *
     * 各模块的参数校验都用 @readsync/shared 的 zod schema 直接 parse，
     * 抛出的 ZodError 不是 AppError，若不在这里兜住就会变成 500 ——
     * 把「用户填错了字段」误报成「服务器故障」，也会污染错误日志。
     */
    if (error instanceof ZodError) {
      const issues = error.issues.map((i) => ({
        path: i.path.join('.'),
        message: i.message,
      }));
      const first = issues[0];

      req.log.info({ issues }, '请求参数校验失败');

      const body: ApiFailure = {
        ok: false,
        error: {
          code: ERROR_CODES.VALIDATION_FAILED,
          message: first ? `${first.path ? `${first.path}: ` : ''}${first.message}` : '请求参数校验失败',
          details: issues,
        },
      };
      return reply.status(400).send(body);
    }

    if (error.statusCode === 413) {
      const body: ApiFailure = {
        ok: false,
        error: { code: ERROR_CODES.PAYLOAD_TOO_LARGE, message: '请求体过大' },
      };
      return reply.status(413).send(body);
    }

    if (isAppError(error)) {
      // 4xx 用 info，5xx 用 error，避免日志级别失真
      const level = error.statusCode >= 500 ? 'error' : 'info';
      req.log[level]({ err: error, code: error.code }, error.message);

      const body: ApiFailure = {
        ok: false,
        error: {
          code: error.code,
          message: error.expose ? error.message : '服务器内部错误，请查看服务端日志',
          ...(error.details !== undefined ? { details: error.details } : {}),
        },
      };
      return reply.status(error.statusCode).send(body);
    }

    // 未预期的异常：记录完整堆栈，对外只给通用文案
    req.log.error({ err: error }, '未处理的异常');
    const body: ApiFailure = {
      ok: false,
      error: {
        code: ERROR_CODES.INTERNAL_ERROR,
        message: '服务器内部错误，请查看服务端日志',
      },
    };
    return reply.status(500).send(body);
  });

  app.setNotFoundHandler((req, reply) => {
    // 前端路由（非 /api）交给 SPA 处理
    if (!req.url.startsWith('/api') && !req.url.startsWith('/users') && !req.url.startsWith('/syncs')) {
      if (webIndexExists()) {
        return reply.type('text/html').sendFile('index.html');
      }
    }
    const body: ApiFailure = {
      ok: false,
      error: { code: ERROR_CODES.NOT_FOUND, message: `接口不存在: ${req.method} ${req.url}` },
    };
    return reply.status(404).send(body);
  });

  /* ------------------------------ 业务路由 ------------------------------ */

  await registerSystemRoutes(app);
  await registerAuthRoutes(app);
  await registerUserRoutes(app);
  await registerStorageRoutes(app);
  await registerLibraryRoutes(app);
  await registerSyncRoutes(app);
  await registerStatsRoutes(app);
  await registerPluginRoutes(app);
  await registerAdminRoutes(app);
  // KOSync 兼容端点挂在根路径（/users/auth、/syncs/progress），不能加 /api 前缀
  await registerKosyncRoutes(app);

  /* ---------------------------- 前端静态托管 ---------------------------- */

  const serveWeb = options.serveWeb ?? config.READSYNC_SERVE_WEB;
  if (serveWeb && webIndexExists()) {
    await app.register(fastifyStatic, {
      root: config.webDistDir,
      prefix: '/',
      // SPA 的客户端路由由 notFoundHandler 兜底到 index.html
      wildcard: false,
      index: ['index.html'],
      // 带 hash 的构建产物可长期缓存，index.html 不缓存（否则用户会一直拿到旧版本）
      setHeaders(res, filePath) {
        if (filePath.endsWith('index.html')) {
          res.header('Cache-Control', 'no-cache');
        } else if (/\.[0-9a-f]{8,}\.(js|css|woff2?|png|svg)$/i.test(filePath)) {
          res.header('Cache-Control', 'public, max-age=31536000, immutable');
        }
      },
    });
    app.log.info({ webDistDir: config.webDistDir }, '已启用前端静态托管');
  }

  return app;
}

/** 前端构建产物是否存在 */
function webIndexExists(): boolean {
  const config = loadConfig();
  try {
    return existsSync(path.join(config.webDistDir, 'index.html'));
  } catch {
    return false;
  }
}
