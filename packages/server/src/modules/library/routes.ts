import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  checkBookExistsSchema,
  chunkedUploadInitSchema,
  createBookSchema,
  listBooksQuerySchema,
  updateBookSchema,
  type ApiSuccess,
  type BookDetail,
  type BookSummary,
  type BookVersion,
  type CheckBookExistsResult,
  type ChunkedUploadInitResult,
  type ChunkedUploadPartResult,
  type Paginated,
} from '@readsync/shared';
import { badRequest, validationFailed } from '../../errors.js';
import { auditContextFrom, recordAudit } from '../../lib/audit.js';
import { currentUser, requireAuth } from '../../middleware/auth.js';
import { completeSession, createSession, discardSession, writeChunk } from './chunked.js';
import {
  checkBookExists,
  createBook,
  deleteBook,
  getBookDetail,
  listBooks,
  listBookVersions,
  prepareBookDownload,
  restoreBookVersion,
  updateBook,
  uploadBook,
  uploadBookVersion,
} from './service.js';

/**
 * 个人书库路由（/api/books）。
 *
 * 全部要求登录，数据按 currentUser.id 隔离：
 * 每个 service 调用都会带 userId，越权访问统一得到 404（不泄漏资源是否存在）。
 * 错误一律抛 AppError，由 app.ts 的全局处理器产出统一响应信封。
 */
export async function registerLibraryRoutes(app: FastifyInstance): Promise<void> {
  const auth = { preHandler: requireAuth };

  /** 书库列表：搜索 / 过滤 / 排序 / 分页 */
  app.get('/api/books', auth, async (req) => {
    const user = currentUser(req);
    const query = parseOrThrow(() => listBooksQuerySchema.parse(req.query));
    return { ok: true, data: listBooks(user.id, query) } satisfies ApiSuccess<Paginated<BookSummary>>;
  });

  /** 书籍详情（含版本历史） */
  app.get('/api/books/:id', auth, async (req) => {
    const user = currentUser(req);
    const bookId = parseIdParam(req.params);
    return { ok: true, data: getBookDetail(user.id, bookId) } satisfies ApiSuccess<BookDetail>;
  });

  /** 登记书籍（文件已由上传接口或客户端直传存好） */
  app.post('/api/books', auth, async (req) => {
    const user = currentUser(req);
    const input = parseOrThrow(() => createBookSchema.parse(req.body));
    const detail = await createBook(user.id, input);

    recordAudit('book.upload', auditContextFrom(req), {
      target: detail.title,
      meta: { bookId: detail.id, size: detail.size, md5: detail.md5, mode: 'register' },
    });

    return { ok: true, data: detail } satisfies ApiSuccess<BookDetail>;
  });

  /** 更新书籍元数据 */
  app.patch('/api/books/:id', auth, async (req) => {
    const user = currentUser(req);
    const bookId = parseIdParam(req.params);
    const input = parseOrThrow(() => updateBookSchema.parse(req.body));
    return { ok: true, data: updateBook(user.id, bookId, input) } satisfies ApiSuccess<BookDetail>;
  });

  /** 删除书籍及其所有版本文件 */
  app.delete('/api/books/:id', auth, async (req) => {
    const user = currentUser(req);
    const bookId = parseIdParam(req.params);
    const result = await deleteBook(user.id, bookId);

    recordAudit('book.delete', auditContextFrom(req), {
      target: result.title,
      meta: { bookId: result.id, deletedFiles: result.deletedFiles, failedFiles: result.failedFiles },
    });

    return { ok: true, data: result } satisfies ApiSuccess<typeof result>;
  });

  /**
   * 秒传检查：上传前先按 MD5 询问服务端是否已有。
   * 注意它只是优化，真正的去重仍由 books(owner_id, md5) 唯一索引保证。
   */
  app.post('/api/books/check', auth, async (req) => {
    const user = currentUser(req);
    const input = parseOrThrow(() => checkBookExistsSchema.parse(req.body));
    return {
      ok: true,
      data: checkBookExists(user.id, input.md5),
    } satisfies ApiSuccess<CheckBookExistsResult>;
  });

  /** 上传并登记新书（核心接口，multipart） */
  app.post('/api/books/upload', auth, async (req) => {
    const user = currentUser(req);
    const file = await takeUploadedFile(req);
    const { book, deduped } = await uploadBook(user.id, file);

    recordAudit('book.upload', auditContextFrom(req), {
      target: book.title,
      meta: { bookId: book.id, size: book.size, md5: book.md5, storageId: book.storageId, deduped },
    });

    return { ok: true, data: book } satisfies ApiSuccess<BookDetail>;
  });

  /** 下载 / 中转：预签名重定向优先，否则流式回源 */
  app.get('/api/books/:id/download', auth, async (req, reply) => {
    const user = currentUser(req);
    const bookId = parseIdParam(req.params);
    const target = await prepareBookDownload(user.id, bookId);

    recordAudit('book.download', auditContextFrom(req), {
      target: target.filename,
      meta: { bookId, mode: target.kind, size: target.size },
    });

    if (target.kind === 'redirect') {
      return reply.redirect(target.url, 302);
    }

    reply.header('Content-Type', target.contentType);
    if (target.size > 0) {
      reply.header('Content-Length', String(target.size));
    }
    // 中文书名需要 RFC 5987 编码，见 contentDisposition
    reply.header('Content-Disposition', contentDisposition(target.filename));

    // 流式响应期间出错时无法再改状态码，只能记录日志并断开连接
    target.stream.on('error', (err) => {
      req.log.error({ err, bookId }, '下载流传输失败');
      target.stream.destroy();
    });

    return reply.send(target.stream);
  });

  /** 版本历史 */
  app.get('/api/books/:id/versions', auth, async (req) => {
    const user = currentUser(req);
    const bookId = parseIdParam(req.params);
    return { ok: true, data: listBookVersions(user.id, bookId) } satisfies ApiSuccess<BookVersion[]>;
  });

  /** 上传新版本 */
  app.post('/api/books/:id/versions', auth, async (req) => {
    const user = currentUser(req);
    const bookId = parseIdParam(req.params);
    const file = await takeUploadedFile(req);
    const detail = await uploadBookVersion(user.id, bookId, file);

    recordAudit('book.upload', auditContextFrom(req), {
      target: detail.title,
      meta: { bookId: detail.id, version: detail.currentVersion, size: detail.size, mode: 'new_version' },
    });

    return { ok: true, data: detail } satisfies ApiSuccess<BookDetail>;
  });

  /* ---------------------------- 分片上传 ---------------------------- */

  /**
   * 建分片上传会话。
   *
   * 存在的理由：整份文件一次 POST 时，请求体大小与请求耗时都受中间层约束
   * （Nginx client_max_body_size 默认 1 MB、Cloudflare 橙云与 Tunnel 的体积
   * 与超时上限），这些都调不了。切成小块后每个请求都很小很快，限制自然不触发。
   */
  app.post('/api/uploads', auth, async (req) => {
    const user = currentUser(req);
    const input = parseOrThrow(() => chunkedUploadInitSchema.parse(req.body));

    if (input.mode === 'version' && input.bookId === undefined) {
      throw badRequest('为已有书籍上传新版本时必须提供 bookId');
    }
    // 版本模式下先确认书籍归属，避免为一个不存在的书白传几百 MB
    if (input.mode === 'version' && input.bookId !== undefined) {
      getBookDetail(user.id, input.bookId);
    }

    const session = await createSession({
      userId: user.id,
      mode: input.mode,
      bookId: input.bookId,
      filename: input.filename,
      size: input.size,
      md5: input.md5,
      fields: input.fields as Record<string, string | undefined>,
      chunkSize: input.chunkSize,
    });

    recordAudit('book.upload', auditContextFrom(req, user), {
      target: input.filename,
      meta: { mode: 'chunked-init', size: input.size, totalChunks: session.totalChunks },
    });

    return {
      ok: true,
      data: {
        uploadId: session.uploadId,
        chunkSize: session.chunkSize,
        totalChunks: session.totalChunks,
      },
    } satisfies ApiSuccess<ChunkedUploadInitResult>;
  });

  /**
   * 上传单个分片。
   *
   * body 是原始二进制（application/octet-stream），不再包一层 multipart ——
   * 每片都包 multipart 只是白白增加开销，而这里没有任何附带字段。
   */
  app.put<{ Params: { uploadId: string; index: string } }>(
    '/api/uploads/:uploadId/parts/:index',
    auth,
    async (req) => {
      const user = currentUser(req);
      const index = Number(req.params.index);
      if (!Number.isInteger(index) || index < 0) throw badRequest('分片序号不合法');

      const body = req.body;
      if (!Buffer.isBuffer(body) || body.length === 0) {
        throw badRequest('分片内容为空（请以 application/octet-stream 发送原始字节）');
      }

      const result = await writeChunk(req.params.uploadId, index, user.id, body);
      return { ok: true, data: result } satisfies ApiSuccess<ChunkedUploadPartResult>;
    },
  );

  /** 合并分片并入库；成功后会话目录被清理，uploadId 随即失效 */
  app.post<{ Params: { uploadId: string } }>(
    '/api/uploads/:uploadId/complete',
    auth,
    async (req) => {
      const user = currentUser(req);
      const outcome = await completeSession(req.params.uploadId, user.id);

      if (outcome.kind === 'version') {
        recordAudit('book.upload', auditContextFrom(req, user), {
          target: outcome.result.title,
          meta: { mode: 'chunked-version', bookId: outcome.result.id, size: outcome.result.size },
        });
        return { ok: true, data: outcome.result } satisfies ApiSuccess<BookDetail>;
      }

      recordAudit('book.upload', auditContextFrom(req, user), {
        target: outcome.result.book.title,
        meta: {
          mode: 'chunked-create',
          bookId: outcome.result.book.id,
          size: outcome.result.book.size,
          deduped: outcome.result.deduped,
        },
      });
      return { ok: true, data: outcome.result.book } satisfies ApiSuccess<BookDetail>;
    },
  );

  /** 放弃上传并清理已落盘的分片 */
  app.delete<{ Params: { uploadId: string } }>(
    '/api/uploads/:uploadId',
    auth,
    async (req) => {
      const user = currentUser(req);
      await discardSession(req.params.uploadId, user.id);
      return { ok: true, data: { discarded: true } } satisfies ApiSuccess<{ discarded: boolean }>;
    },
  );

  /**
   * 回滚到指定历史版本。
   * :versionId 为 book_versions 行的 id（版本历史接口返回的 id 字段）。
   */
  app.post('/api/books/:id/versions/:versionId/restore', auth, async (req) => {
    const user = currentUser(req);
    const bookId = parseIdParam(req.params, 'id');
    const versionId = parseIdParam(req.params, 'versionId');
    const detail = restoreBookVersion(user.id, bookId, versionId);

    recordAudit('book.upload', auditContextFrom(req), {
      target: detail.title,
      meta: { bookId: detail.id, versionId, mode: 'restore', currentVersion: detail.currentVersion },
    });

    return { ok: true, data: detail } satisfies ApiSuccess<BookDetail>;
  });
}

/* ------------------------------- 辅助函数 ------------------------------- */

/**
 * 统一取 multipart 文件。
 * 非 multipart 请求直接 400，避免 req.file() 抛出底层解析错误变成 500。
 */
async function takeUploadedFile(req: FastifyRequest) {
  if (!req.isMultipart()) {
    throw badRequest('请使用 multipart/form-data 上传文件');
  }
  const file = await req.file();
  if (!file) {
    throw badRequest('未找到上传的文件');
  }
  return file;
}

/** 解析路径参数中的自增 id */
function parseIdParam(params: unknown, key = 'id'): number {
  const raw = (params as Record<string, unknown>)[key];
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw badRequest(`无效的 ${key}`);
  }
  return value;
}

/**
 * 把 zod 的解析错误转成 AppError。
 *
 * 直接用 schema.parse 时 ZodError 不是 AppError，会被全局处理器当成 500；
 * 这里统一转成 VALIDATION_FAILED(400)，并保留字段级 details 供前端展示。
 */
function parseOrThrow<T>(parse: () => T): T {
  try {
    return parse();
  } catch (err) {
    if (err instanceof Error && err.name === 'ZodError') {
      throw validationFailed('请求参数校验失败', (err as { issues?: unknown }).issues);
    }
    throw err;
  }
}

/**
 * 生成 Content-Disposition。
 *
 * 中文/特殊字符文件名不能直接放进 header（且必须防 CRLF 注入），
 * 因此按 RFC 5987 给出 filename*=UTF-8''...，同时保留一个 ASCII 回退名
 * 供老客户端使用。
 */
function contentDisposition(filename: string): string {
  // 去掉控制字符（含 \r\n），防止响应头注入
  const safe = filename.replace(/[\u0000-\u001f\u007f]/g, '');
  // ASCII 回退：非可打印字符替换为下划线，并转义引号与反斜杠
  const fallback = safe.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  const encoded = encodeURIComponent(safe).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}
