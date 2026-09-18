import { eq } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  SYNC_CONFLICT_STRATEGIES,
  idParamSchema,
  paginationQuerySchema,
  syncBatchInputSchema,
  syncEntryInputSchema,
  type ApiSuccess,
  type Paginated,
  type SyncBatchResult,
  type SyncConflictStrategy,
  type SyncEntry,
  type SyncPullResult,
  type SyncPushResult,
  type SyncToken,
} from '@readsync/shared';
import { generateToken, sha256Hex } from '../../crypto/password.js';
import { getDb } from '../../db/index.js';
import { syncTokens, type SyncTokenRow } from '../../db/schema.js';
import { forbidden, notFound } from '../../errors.js';
import { auditContextFrom, recordAudit } from '../../lib/audit.js';
import { currentUser, requireScope } from '../../middleware/auth.js';
import { deleteProgress, getProgress, listEntries, upsertProgress } from './service.js';

/**
 * ReadSync 统一同步接口（供第三方阅读软件开发者接入）。
 *
 * 与 KOSync 端点相反，这里走标准 ApiResponse 信封 + Bearer 认证。
 * 认证既接受网页登录的 JWT，也接受 `rs_` 开头的同步令牌（见 middleware/auth.ts），
 * 统一用 requireScope('sync') 把关：JWT 天然全权限，令牌必须显式带 sync scope。
 *
 * 所有路径挂在 /api/sync 前缀下，并在模块内声明 prefix（CONVENTIONS 约定）。
 */
export async function registerSyncRoutes(app: FastifyInstance): Promise<void> {
  const authSync = requireScope('sync');

  /** 推送单条进度 */
  app.put('/api/sync/progress', { preHandler: authSync }, async (req) => {
    const user = currentUser(req);
    const input = syncEntryInputSchema.parse(req.body);
    const strategy = resolveStrategy(req);

    const result = upsertProgress(user.id, input, strategy);

    recordAudit('sync.push', auditContextFrom(req, user), {
      target: input.document,
      meta: {
        protocol: 'readsync',
        accepted: result.accepted,
        platform: input.platform,
        readingSeconds: input.readingSeconds,
      },
    });

    return { ok: true, data: result } satisfies ApiSuccess<SyncPushResult>;
  });

  /** 拉取单个文档的进度 */
  app.get<{ Params: { document: string } }>(
    '/api/sync/progress/:document',
    { preHandler: authSync },
    async (req) => {
      const user = currentUser(req);
      const entry = getProgress(user.id, req.params.document);
      return { ok: true, data: { entry } } satisfies ApiSuccess<SyncPullResult>;
    },
  );

  /** 分页列出全部同步条目（第三方客户端首次接入时用于全量拉取） */
  app.get('/api/sync/entries', { preHandler: authSync }, async (req) => {
    const user = currentUser(req);
    const pagination = paginationQuerySchema.parse(req.query);
    const result = listEntries(user.id, pagination);
    return { ok: true, data: result } satisfies ApiSuccess<Paginated<SyncEntry>>;
  });

  /** 批量推送（离线补传场景） */
  app.post('/api/sync/batch', { preHandler: authSync }, async (req) => {
    const user = currentUser(req);
    const input = syncBatchInputSchema.parse(req.body);
    const strategy = resolveStrategy(req);

    const results: SyncBatchResult['results'] = [];
    let accepted = 0;

    for (const entry of input.entries) {
      const result = upsertProgress(user.id, entry, strategy);
      if (result.accepted) accepted += 1;
      results.push({ document: entry.document, accepted: result.accepted, current: result.current });
    }

    recordAudit('sync.push', auditContextFrom(req, user), {
      target: 'batch',
      meta: {
        protocol: 'readsync',
        total: input.entries.length,
        accepted,
        rejected: input.entries.length - accepted,
      },
    });

    return {
      ok: true,
      data: { accepted, rejected: input.entries.length - accepted, results },
    } satisfies ApiSuccess<SyncBatchResult>;
  });

  /** 删除某文档的同步记录 */
  app.delete<{ Params: { document: string } }>(
    '/api/sync/progress/:document',
    { preHandler: authSync },
    async (req) => {
      const user = currentUser(req);
      const deleted = deleteProgress(user.id, req.params.document);
      if (!deleted) throw notFound('该文档没有同步记录');

      return {
        ok: true,
        data: { document: req.params.document, deleted: true },
      } satisfies ApiSuccess<{ document: string; deleted: boolean }>;
    },
  );

  /* --------------------------- 同步令牌管理 --------------------------- */

  /** 列出当前用户的同步令牌；绝不返回 token 明文（库里只有 SHA-256） */
  app.get('/api/sync/tokens', { preHandler: authSync }, async (req) => {
    const user = currentUser(req);
    const rows = getDb()
      .select()
      .from(syncTokens)
      .where(eq(syncTokens.userId, user.id))
      .orderBy(syncTokens.id)
      .all();

    return { ok: true, data: rows.map(toSyncToken) } satisfies ApiSuccess<SyncToken[]>;
  });

  /** 创建同步令牌：明文只在本次响应里出现一次 */
  app.post('/api/sync/tokens', { preHandler: authSync }, async (req) => {
    const user = currentUser(req);
    const input = createSyncTokenSchema.parse(req.body);

    // 前缀 rs_ 让 auth 中间件能在解析阶段就与 JWT 区分开，无需试错
    const raw = `rs_${generateToken(32)}`;

    const row = getDb()
      .insert(syncTokens)
      .values({
        userId: user.id,
        name: input.name,
        // 只存哈希：数据库泄露时令牌不可被还原使用（与 refresh token 同一策略）
        tokenHash: sha256Hex(raw),
        // 明文前缀仅供用户在列表里辨认是哪一个令牌
        tokenPrefix: raw.slice(0, 11),
        scopes: input.scopes,
        lastUsedAt: null,
        expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
        createdAt: new Date(),
      })
      .returning()
      .get();

    if (!row) throw new Error('同步令牌创建失败');

    return { ok: true, data: { ...toSyncToken(row), token: raw } } satisfies ApiSuccess<SyncToken>;
  });

  /** 删除同步令牌 */
  app.delete<{ Params: { id: string } }>(
    '/api/sync/tokens/:id',
    { preHandler: authSync },
    async (req) => {
      const user = currentUser(req);
      const { id } = idParamSchema.parse(req.params);

      const row = getDb()
        .select({ id: syncTokens.id, userId: syncTokens.userId })
        .from(syncTokens)
        .where(eq(syncTokens.id, id))
        .get();

      if (!row) throw notFound('同步令牌不存在');
      // 越权访问别人的令牌一律按「不存在」处理，避免暴露 id 是否有效
      if (row.userId !== user.id) throw forbidden('无权删除该令牌');

      getDb().delete(syncTokens).where(eq(syncTokens.id, id)).run();

      return { ok: true, data: { id, deleted: true } } satisfies ApiSuccess<{ id: number; deleted: boolean }>;
    },
  );
}

/**
 * 创建令牌的请求体。
 *
 * 本应放进 @readsync/shared（CONVENTIONS 第 3 条），但当前任务冻结了 shared 包，
 * 且该结构只被这一个端点使用、前端「同步设置」页尚未定稿，故先就地定义。
 * 后续前端接入时应迁移到 packages/shared/src/schemas/sync.ts。
 */
const createSyncTokenSchema = z.object({
  name: z.string().trim().min(1).max(64).default('未命名令牌'),
  /** 令牌权限；默认只给 sync，最小权限原则 */
  scopes: z.array(z.string().trim().min(1).max(32)).max(16).default(['sync']),
  expiresAt: z.iso.datetime().optional(),
});

/** 数据库行 → 对外 DTO；刻意不包含 token 字段（明文只存在过一次） */
function toSyncToken(row: SyncTokenRow): SyncToken {
  return {
    id: row.id,
    name: row.name,
    tokenPrefix: row.tokenPrefix,
    scopes: row.scopes ?? [],
    lastUsedAt: row.lastUsedAt ? row.lastUsedAt.toISOString() : null,
    expiresAt: row.expiresAt ? row.expiresAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * 从 query 里取冲突策略。
 * 非法值静默回退 latest-wins，而不是报错：该参数是可选优化项，
 * 老客户端不会传，前端也不会因为拼错一个词就同步失败。
 */
function resolveStrategy(req: FastifyRequest): SyncConflictStrategy {
  const raw = (req.query as Record<string, unknown> | undefined)?.strategy;
  if (typeof raw === 'string' && (SYNC_CONFLICT_STRATEGIES as readonly string[]).includes(raw)) {
    return raw as SyncConflictStrategy;
  }
  return 'latest-wins';
}
