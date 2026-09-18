import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  idParamSchema,
  storageInputSchema,
  storageUpdateSchema,
  type ApiSuccess,
  type StorageSummary,
  type StorageTestResult,
} from '@readsync/shared';
import type { ListResult } from './types.js';
import { auditContextFrom, recordAudit } from '../../lib/audit.js';
import { currentUser, requireAuth } from '../../middleware/auth.js';
import {
  browseStorage,
  createStorage,
  deleteStorage,
  getStorageRow,
  listStorages,
  mkdirStorage,
  testStorage,
  toStorageSummary,
  updateStorage,
} from './service.js';

/**
 * 存储管理接口（/api/storages）。
 *
 * 全部要求登录，且只能操作属于自己的存储（service 层按 userId 过滤）。
 * 请求/响应结构与前端「存储管理」页面一一对应。
 */

/**
 * 浏览参数与建目录用的 schema 就地定义。
 * 按 CONVENTIONS 本应放进 @readsync/shared，但本次任务约定不修改 shared 包，
 * 且这两个结构目前只有本模块使用，故暂放这里；后续前端需要复用时再上移。
 */
const browseQuerySchema = z.object({
  prefix: z.string().max(1024).optional(),
  limit: z.coerce.number().int().min(1).max(1000).optional(),
  cursor: z.string().max(4096).optional(),
});

const mkdirBodySchema = z.object({
  /** 目录路径（POSIX 风格相对路径），如 books/2026 */
  path: z.string().trim().min(1).max(1024),
});

export async function registerStorageRoutes(app: FastifyInstance): Promise<void> {
  /** 列表：当前用户的全部存储（凭据已脱敏） */
  app.get('/api/storages', { preHandler: requireAuth }, async (req) => {
    const user = currentUser(req);
    return { ok: true, data: listStorages(user.id) } satisfies ApiSuccess<StorageSummary[]>;
  });

  /** 创建存储配置 */
  app.post('/api/storages', { preHandler: requireAuth }, async (req) => {
    const user = currentUser(req);
    const input = storageInputSchema.parse(req.body);

    const summary = createStorage(user, input);

    recordAudit('storage.create', auditContextFrom(req), {
      target: summary.name,
      // 只记驱动与 id，绝不记录配置内容（可能含凭据）
      meta: { storageId: summary.id, driver: summary.driver, isDefault: summary.isDefault },
    });

    return { ok: true, data: summary } satisfies ApiSuccess<StorageSummary>;
  });

  /** 单个详情 */
  app.get('/api/storages/:id', { preHandler: requireAuth }, async (req) => {
    const user = currentUser(req);
    const { id } = idParamSchema.parse(req.params);
    const row = getStorageRow(id, user.id);
    // 复用 service 的映射逻辑，保证详情与列表口径一致
    return { ok: true, data: toStorageSummary(row) } satisfies ApiSuccess<StorageSummary>;
  });

  /** 部分更新（敏感字段为掩码时保留原密文，见 service.mergeConfig） */
  app.patch('/api/storages/:id', { preHandler: requireAuth }, async (req) => {
    const user = currentUser(req);
    const { id } = idParamSchema.parse(req.params);
    const patch = storageUpdateSchema.parse(req.body);

    const summary = updateStorage(id, user, patch);

    recordAudit('storage.update', auditContextFrom(req), {
      target: summary.name,
      meta: { storageId: summary.id, fields: Object.keys(patch) },
    });

    return { ok: true, data: summary } satisfies ApiSuccess<StorageSummary>;
  });

  /** 删除；仍有书籍引用时抛 409 CONFLICT 并说明数量 */
  app.delete('/api/storages/:id', { preHandler: requireAuth }, async (req) => {
    const user = currentUser(req);
    const { id } = idParamSchema.parse(req.params);

    // 先取名字用于审计（删除后就查不到了）
    const row = getStorageRow(id, user.id);
    deleteStorage(id, user.id);

    recordAudit('storage.delete', auditContextFrom(req), {
      target: row.name,
      meta: { storageId: id, driver: row.driver },
    });

    return { ok: true, data: { id, deleted: true } } satisfies ApiSuccess<{ id: number; deleted: boolean }>;
  });

  /** 测试连通性，并把结果写回 lastCheck* 字段 */
  app.post('/api/storages/:id/test', { preHandler: requireAuth }, async (req) => {
    const user = currentUser(req);
    const { id } = idParamSchema.parse(req.params);
    const result = await testStorage(id, user.id);
    return { ok: true, data: result } satisfies ApiSuccess<StorageTestResult>;
  });

  /** 浏览远端目录，供「存储管理」页面查看文件 */
  app.get('/api/storages/:id/browse', { preHandler: requireAuth }, async (req) => {
    const user = currentUser(req);
    const { id } = idParamSchema.parse(req.params);
    const query = browseQuerySchema.parse(req.query);

    const result = await browseStorage(id, user.id, {
      prefix: query.prefix ?? '',
      limit: query.limit ?? 100,
      ...(query.cursor ? { cursor: query.cursor } : {}),
    });

    return { ok: true, data: result } satisfies ApiSuccess<ListResult>;
  });

  /** 创建目录（WebDAV / 本地生效；对象存储与不支持的驱动按空操作成功返回） */
  app.post('/api/storages/:id/mkdir', { preHandler: requireAuth }, async (req) => {
    const user = currentUser(req);
    const { id } = idParamSchema.parse(req.params);
    const body = mkdirBodySchema.parse(req.body);

    await mkdirStorage(id, user.id, body.path);

    return { ok: true, data: { path: body.path, created: true } } satisfies ApiSuccess<{
      path: string;
      created: boolean;
    }>;
  });
}
