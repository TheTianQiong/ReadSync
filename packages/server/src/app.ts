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

  /**
   * 对外访问地址是否为 HTTPS。
   *
   * 决定要不要下发 upgrade-insecure-requests 与 HSTS —— 这两条指令都假设
   * 站点跑在 HTTPS 上，对自托管的 HTTP 部署是有害的（见下方注释）。
   * READSYNC_BASE_URL 可能被填成非法值，因此解析失败时按 HTTP 处理。
   */
  const publicUrlIsHttps = ((): boolean => {
    try {
      return new URL(config.READSYNC_BASE_URL).protocol === 'https:';
    } catch {
      return false;
    }
  })();

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

            /*
             * upgrade-insecure-requests 是 helmet 的默认指令，会把页面内
             * **所有子资源请求**升级为 https。
             *
             * 自托管场景普遍是 http://<内网IP>:3000，而 IP 地址不属于浏览器
             * 定义的「可信来源」（只有 https 与 localhost/127.0.0.1 是），
             * 于是浏览器会真的去请求 https://<ip>:3000/assets/index-xxx.js。
             * 服务端只有 HTTP、不做 TLS，请求必然失败 —— JS 一行都不会执行，
             * 页面只剩空的 <div id="root">，表现为「全空白、F12 里没几个元素」。
             *
             * 而在 localhost 上测试是正常的（可信来源不升级），所以这个坑
             * 只在通过 IP/域名访问时暴露。
             */
            upgradeInsecureRequests: publicUrlIsHttps ? [] : null,
          },
        }
      : false,

    // 同理：HTTP 部署下发 HSTS 没有意义（浏览器只认 HTTPS 响应里的 HSTS），
    // 反而会给将来切到 HTTPS 埋下「把自己锁死」的隐患。
    // 注意这是 helmet 的顶层选项，不是 CSP 指令。
    strictTransportSecurity: publicUrlIsHttps
      ? { maxAge: 31536000, includeSubDomains: true }
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

  /**
   * 分片上传的原始二进制 body。
   *
   * 分片走 application/octet-stream 而不是 multipart：每片再包一层 multipart
   * 只是白白增加开销，而分片请求没有任何附带字段。没有这个解析器 Fastify 会对
   * 未知 content-type 直接返回 415。
   *
   * bodyLimit 取 64 MB：分片大小默认 4 MiB（可用 READSYNC_UPLOAD_CHUNK_SIZE 调大），
   * 这里留足余量，真正的分片大小校验在 writeChunk 里按会话参数做。
   * 注意 Fastify 的默认 bodyLimit（下面 8 MB）不适用于自定义解析器之外的场景，
   * 所以必须在这里显式给一个够大的值。
   */
  app.addContentTypeParser(
    'application/octet-stream',
    { bodyLimit: 64 * 1024 * 1024 },
    (_req, body, done) => {
      const chunks: Buffer[] = [];
      let size = 0;
      body.on('data', (chunk: Buffer) => {
        size += chunk.length;
        chunks.push(chunk);
      });
      body.on('end', () => {
        if (size === 0) {
          done(new Error('请求体为空'), undefined);
          return;
        }
        done(null, Buffer.concat(chunks));
      });
      body.on('error', (err: Error) => done(err, undefined));
    },
  );

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

    /**
     * Fastify 自身抛出的 4xx（请求解析、媒体类型等）。
     *
     * 典型例子：客户端带了 `Content-Type: application/json` 却发了空 body，
     * Fastify 抛 FST_ERR_CTP_EMPTY_JSON_BODY（statusCode 400）。这类错误原本会
     * 落到最后的 500 分支，让「客户端把请求写错了」显示成「服务器内部错误」，
     * 既误导使用者，也污染错误日志。
     */
    if (error.statusCode && error.statusCode >= 400 && error.statusCode < 500) {
      req.log.info({ err: error, code: error.code }, '请求不合法（Fastify 解析层）');
      const body: ApiFailure = {
        ok: false,
        error: {
          code: error.statusCode === 415 ? ERROR_CODES.UNSUPPORTED_MEDIA_TYPE : ERROR_CODES.BAD_REQUEST,
          message: error.message,
        },
      };
      return reply.status(error.statusCode).send(body);
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
    /*
     * 只把「页面导航」交给 SPA 兜底，不要兜静态资源。
     *
     * 原先只要路径不以 /api、/users、/syncs 开头就返回 index.html，
     * 结果是 /favicon.ico 或任何拼错的 .js/.css 都会拿到一份 HTML 且状态码 200。
     * 浏览器随后会以 "Unexpected token '<'" 之类的报错收场 —— 排查方向完全被带偏。
     *
     * 判定方式：
     *   - 带文件扩展名的路径（/assets/x.js、/favicon.ico）→ 不是导航，走 404
     *   - 其余无扩展名的路径（/library、/settings/profile）→ 是 SPA 客户端路由，交给 index.html
     * 另外要求 Accept 含 text/html，进一步排除 fetch/XHR 打到未知路径的情况。
     */
    const isApiPath =
      req.url.startsWith('/api') || req.url.startsWith('/users') || req.url.startsWith('/syncs');
    const pathname = req.url.split('?')[0] ?? '';
    const hasFileExtension = /\.[a-zA-Z0-9]{1,8}$/.test(pathname);
    const acceptsHtml = typeof req.headers.accept === 'string' && req.headers.accept.includes('text/html');

    if (!isApiPath && !hasFileExtension && acceptsHtml) {
      if (webIndexExists()) {
        return reply.type('text/html').sendFile('index.html');
      }

      // 前端产物不存在时，若直接返回 404 JSON，用户只会看到一个空页面或一段
      // 报错文本，完全不知道是「没构建前端」。这里给出可操作的说明。
      return reply
        .status(503)
        .type('text/html; charset=utf-8')
        .send(
          `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<title>前端尚未构建 · ReadSync</title>
<style>body{font-family:system-ui,sans-serif;max-width:44rem;margin:12vh auto;padding:0 1.5rem;line-height:1.8;color:#1a1a1a}
code{background:#f0f0ee;padding:.15em .4em;border-radius:3px}pre{background:#f0f0ee;padding:1rem;border-radius:4px;overflow-x:auto}</style>
</head><body>
<h1>前端尚未构建</h1>
<p>后端已经启动，但没有找到前端构建产物，因此页面无法显示。</p>
<p>请在项目根目录执行：</p>
<pre>npm run build</pre>
<p>然后重启服务。若只想使用 API，可忽略本提示。</p>
<p style="color:#666;font-size:.9em">期望的产物路径：<code>${config.webDistDir}/index.html</code></p>
</body></html>`,
        );
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
  } else if (serveWeb) {
    // 这是很容易踩的坑：构建在 build:server 阶段失败时 build:web 根本没执行，
    // 前端产物不存在，访问首页只会看到一个空页面。启动时就明确说出来。
    app.log.warn(
      { webDistDir: config.webDistDir },
      '未找到前端构建产物，Web 界面不可用。请在项目根目录执行 npm run build 后重启服务。',
    );
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
