import { count } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import {
  APP_NAME,
  VERSION,
  bootstrapSchema,
  type ApiSuccess,
  type BootstrapStatus,
  type PublicKeyInfo,
  type PublicSettings,
  type SystemInfo,
} from '@readsync/shared';
import { getKeyFingerprint, getPublicKeyInfo } from '../../crypto/keys.js';
import { forbidden } from '../../errors.js';
import { resolveNewPassword } from '../../lib/password-input.js';
import { createUser, hasAdmin, toSessionUser } from '../../lib/users.js';
import { auditContextFrom, recordAudit } from '../../lib/audit.js';
import { getPublicSettings, patchSiteSettings } from '../../lib/settings.js';
import { requireAdmin, requireAuth } from '../../middleware/auth.js';
import { getDb } from '../../db/index.js';
import { books, plugins, storages, syncEntries, users } from '../../db/schema.js';

/**
 * 系统级公开接口：健康检查、版本、公钥、公开设置、初始化引导、系统信息。
 *
 * 除 /api/system/info 外都不需要登录：登录页要在未登录状态下拿到站点名、
 * 是否开放注册，以及用于加密密码的公钥。
 *
 * 错误处理统一交给 app.ts 的全局 setErrorHandler，这里不重复注册。
 */
export async function registerSystemRoutes(app: FastifyInstance): Promise<void> {
  /** 健康检查：供 Docker healthcheck 与反向代理探活 */
  app.get('/api/system/health', async () => {
    return {
      ok: true,
      data: {
        status: 'healthy',
        version: VERSION,
        uptime: Math.floor(process.uptime()),
        timestamp: new Date().toISOString(),
      },
    } satisfies ApiSuccess<{ status: string; version: string; uptime: number; timestamp: string }>;
  });

  /** 版本信息 */
  app.get('/api/system/version', async () => {
    return {
      ok: true,
      data: { name: APP_NAME, version: VERSION },
    } satisfies ApiSuccess<{ name: string; version: string }>;
  });

  /**
   * 公钥下发。
   *
   * 前端在登录/注册/改密前先取公钥，用 WebCrypto 做 RSA-OAEP(SHA-256) 加密密码，
   * 保证明文密码不出浏览器（README 要求「密码不可明文传递」）。
   */
  app.get('/api/system/public-key', async () => {
    return { ok: true, data: getPublicKeyInfo() } satisfies ApiSuccess<PublicKeyInfo>;
  });

  /** 公开设置：登录页与前端全局需要的最小集合 */
  app.get('/api/system/settings', async () => {
    return { ok: true, data: getPublicSettings() } satisfies ApiSuccess<PublicSettings>;
  });

  /** 初始化状态：前端据此决定是否跳转到「创建管理员」引导页 */
  app.get('/api/system/bootstrap', async () => {
    return { ok: true, data: { initialized: hasAdmin() } } satisfies ApiSuccess<BootstrapStatus>;
  });

  /**
   * 初始化管理员账号（README 前端要求 9：「网站初始化时，应注册管理员账号」）。
   * 一旦已存在管理员，该接口永久关闭，避免被用来提权。
   */
  app.post('/api/system/bootstrap', async (req) => {
    if (hasAdmin()) {
      throw forbidden('站点已完成初始化，无法重复执行');
    }

    const input = bootstrapSchema.parse(req.body);

    const user = await createUser({
      username: input.username,
      email: input.email,
      plainPassword: resolveNewPassword(input.password, '管理员密码'),
      role: 'admin',
    });

    // 首次初始化时把站点名一并写入设置
    patchSiteSettings({ siteName: input.siteName, registrationEnabled: true });

    recordAudit('user.register', auditContextFrom(req, { id: user.id, username: user.username }), {
      target: user.username,
      meta: { bootstrap: true, role: 'admin' },
    });

    return {
      ok: true,
      data: { user: toSessionUser(user) },
    } satisfies ApiSuccess<{ user: ReturnType<typeof toSessionUser> }>;
  });

  /**
   * 系统信息（管理员）：版本、运行时、数据量与公钥指纹。
   * 供管理后台「站点管理 → 系统信息」展示。
   */
  app.get('/api/system/info', { preHandler: requireAdmin }, async () => {
    const db = getDb();

    const info: SystemInfo = {
      version: VERSION,
      nodeVersion: process.version,
      platform: `${process.platform} ${process.arch}`,
      uptimeSeconds: Math.floor(process.uptime()),
      // 这两个体积统计需要读文件系统，放到 admin 模块的 /api/admin/system 里做，
      // 这里只返回廉价的计数信息
      databaseSize: 0,
      dataDirSize: 0,
      counts: {
        users: db.select({ value: count() }).from(users).get()?.value ?? 0,
        books: db.select({ value: count() }).from(books).get()?.value ?? 0,
        storages: db.select({ value: count() }).from(storages).get()?.value ?? 0,
        plugins: db.select({ value: count() }).from(plugins).get()?.value ?? 0,
        syncEntries: db.select({ value: count() }).from(syncEntries).get()?.value ?? 0,
      },
      publicKeyFingerprint: getKeyFingerprint(),
    };

    return { ok: true, data: info } satisfies ApiSuccess<SystemInfo>;
  });

  /** 便于前端在「关于」里展示；与 requireAuth 组合验证登录态是否有效 */
  app.get('/api/system/ping', { preHandler: requireAuth }, async (req) => {
    return {
      ok: true,
      data: { user: req.currentUser?.username ?? null, serverTime: new Date().toISOString() },
    } satisfies ApiSuccess<{ user: string | null; serverTime: string }>;
  });
}
