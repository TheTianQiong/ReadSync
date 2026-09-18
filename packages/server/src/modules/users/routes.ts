import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
// 副作用导入：加载 @fastify/multipart 对 FastifyRequest.file / FastifyInstance.multipartErrors 的类型扩展
import '@fastify/multipart';
import { and, desc, eq, gt, isNull, ne } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import {
  BUILTIN_PLATFORMS,
  DASHBOARD_WIDGETS,
  PLATFORM_LABELS,
  THEME_PREFERENCES,
  dashboardLayoutSchema,
  idParamSchema,
  readingPlatformSchema,
  updatePreferencesSchema,
  updateProfileSchema,
  type ApiSuccess,
  type DashboardLayout,
  type ReadingPlatform,
  type SessionUser,
  type ThemePreference,
  type UpdatePreferencesInput,
  type UserPreferences,
} from '@readsync/shared';
import { loadConfig } from '../../config.js';
import { getDb } from '../../db/index.js';
import { readingPlatforms, sessions, users, type UserRow } from '../../db/schema.js';
import {
  badRequest,
  conflict,
  forbidden,
  notFound,
  payloadTooLarge,
  unsupportedMediaType,
} from '../../errors.js';
import { auditContextFrom, recordAudit } from '../../lib/audit.js';
import { toSessionUser } from '../../lib/users.js';
import { currentUser, requireAuth } from '../../middleware/auth.js';

/**
 * 用户个人设置（README 前端要求 8：设置页的「基础设置 / 阅读平台 / 账号安全」）。
 *
 * 所有 /api/users/me/* 都要求登录；头像读取接口是唯一例外，
 * 详见文件末尾的说明。
 */

/** 头像大小上限 2MB：头像只用于展示，没有必要接受更大文件 */
const AVATAR_MAX_BYTES = 2 * 1024 * 1024;

/** 允许的头像类型 → 落盘扩展名。故意不接受 SVG：SVG 可内嵌脚本，同源直接访问时有 XSS 风险 */
const AVATAR_MIME_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

const AVATAR_EXT_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
};

/** 当前用户的数据库行；用户可能刚被管理员删除，这里兜底 404 */
function loadUser(userId: number): UserRow {
  const row = getDb().select().from(users).where(eq(users.id, userId)).get();
  if (!row) throw notFound('用户不存在');
  return row;
}

/* ------------------------------ 偏好设置 ------------------------------ */

/** 首页默认布局：全部组件启用，顺序按常量声明顺序 */
function defaultDashboard(): DashboardLayout {
  return {
    widgets: DASHBOARD_WIDGETS.map((id, index) => ({ id, enabled: true, order: index })),
  };
}

function defaultPreferences(): UserPreferences {
  return {
    theme: 'system',
    dashboard: defaultDashboard(),
    pageSize: 20,
    timezone: 'Asia/Shanghai',
    emailNotifications: false,
  };
}

function isTheme(value: unknown): value is ThemePreference {
  return typeof value === 'string' && (THEME_PREFERENCES as readonly string[]).includes(value);
}

/**
 * 读取偏好并补全缺省值。
 *
 * preferences 列是自由 JSON，历史版本或手工改库都可能缺字段/类型不对，
 * 因此逐字段校验而不是直接断言，任何不合法字段回退默认值，保证前端拿到的
 * 一定是完整的 UserPreferences。
 */
function readPreferences(raw: Record<string, unknown> | null): UserPreferences {
  const defaults = defaultPreferences();
  const stored = raw ?? {};

  const dashboard = dashboardLayoutSchema.safeParse(stored.dashboard);
  const pageSize = stored.pageSize;

  return {
    theme: isTheme(stored.theme) ? stored.theme : defaults.theme,
    dashboard: dashboard.success ? dashboard.data : defaults.dashboard,
    pageSize:
      typeof pageSize === 'number' && Number.isInteger(pageSize) && pageSize >= 5 && pageSize <= 100
        ? pageSize
        : defaults.pageSize,
    timezone: typeof stored.timezone === 'string' && stored.timezone.length > 0 ? stored.timezone : defaults.timezone,
    emailNotifications:
      typeof stored.emailNotifications === 'boolean' ? stored.emailNotifications : defaults.emailNotifications,
  };
}

/** 按组件 id 合并布局：补丁里出现的组件覆盖对应字段，未提及的组件保持原样 */
function mergeDashboard(current: DashboardLayout, patch: DashboardLayout): DashboardLayout {
  const merged = new Map(current.widgets.map((widget) => [widget.id, widget]));
  for (const widget of patch.widgets) {
    const previous = merged.get(widget.id);
    merged.set(widget.id, previous ? { ...previous, ...widget } : widget);
  }
  return { widgets: [...merged.values()].sort((a, b) => a.order - b.order) };
}

/**
 * 深合并偏好。
 * 关键点：dashboard 不能整体替换 —— 前端可能只提交某一两个组件的开关，
 * 整体替换会把其余组件的启用状态/排序悄悄重置。
 */
function mergePreferences(current: UserPreferences, patch: UpdatePreferencesInput): UserPreferences {
  return {
    theme: patch.theme ?? current.theme,
    dashboard: patch.dashboard ? mergeDashboard(current.dashboard, patch.dashboard) : current.dashboard,
    pageSize: patch.pageSize ?? current.pageSize,
    timezone: patch.timezone ?? current.timezone,
    emailNotifications: patch.emailNotifications ?? current.emailNotifications,
  };
}

/* ------------------------------ 阅读平台 ------------------------------ */

/** 内置平台列表（所有用户共享，非数据库行） */
function builtinPlatforms(): ReadingPlatform[] {
  return BUILTIN_PLATFORMS.map((id) => ({
    id,
    label: PLATFORM_LABELS[id],
    icon: null,
    color: null,
    builtin: true,
    // 内置平台没有创建时间，用空串占位（前端对内置项不展示该字段）
    createdAt: '',
  }));
}

function toReadingPlatform(row: typeof readingPlatforms.$inferSelect): ReadingPlatform {
  return {
    id: row.platformId,
    label: row.label,
    icon: row.icon,
    color: row.color,
    builtin: row.builtin,
    createdAt: row.createdAt.toISOString(),
  };
}

/* ------------------------------ 头像 ------------------------------ */

function avatarDir(): string {
  return path.join(loadConfig().dataDir, 'avatars');
}

/** 删除同一用户的旧头像（扩展名可能不同），避免残留多份文件 */
async function removeAvatarFiles(dir: string, userId: number): Promise<void> {
  try {
    const entries = await readdir(dir);
    await Promise.all(
      entries.filter((name) => name.startsWith(`${userId}.`)).map((name) => rm(path.join(dir, name), { force: true })),
    );
  } catch {
    // 目录还不存在，无需清理
  }
}

/** 会话对外表示：绝不包含 tokenHash / familyId，避免令牌摘要泄漏 */
interface SessionSummary {
  id: number;
  device: string | null;
  ip: string | null;
  userAgent: string | null;
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string;
}

export async function registerUserRoutes(app: FastifyInstance): Promise<void> {
  /* ------------------------------ 个人资料 ------------------------------ */

  app.get('/api/users/me', { preHandler: requireAuth }, async (req) => {
    const me = currentUser(req);
    const row = loadUser(me.id);
    return { ok: true, data: toSessionUser(row) } satisfies ApiSuccess<SessionUser>;
  });

  app.patch('/api/users/me', { preHandler: requireAuth }, async (req) => {
    const me = currentUser(req);
    const input = updateProfileSchema.parse(req.body);

    const db = getDb();
    const row = loadUser(me.id);

    // 邮箱同时是找回密码的凭据，必须保持全局唯一
    if (input.email !== undefined && input.email !== row.email) {
      const taken = db
        .select({ id: users.id })
        .from(users)
        .where(and(eq(users.email, input.email), ne(users.id, me.id)))
        .get();
      if (taken) throw conflict('该邮箱已被其他账号绑定');
    }

    const updated = db
      .update(users)
      .set({
        ...(input.displayName !== undefined ? { displayName: input.displayName } : {}),
        ...(input.email !== undefined ? { email: input.email } : {}),
        // 空串表示清除头像，落库统一存 null
        ...(input.avatarUrl !== undefined ? { avatarUrl: input.avatarUrl.length > 0 ? input.avatarUrl : null } : {}),
        updatedAt: new Date(),
      })
      .where(eq(users.id, me.id))
      .returning()
      .get();

    if (!updated) throw notFound('用户不存在');

    // 邮箱变更属于账号安全事件，单独留痕（改密码、2FA 等由 auth 模块负责）
    if (input.email !== undefined && input.email !== row.email) {
      recordAudit('user.update', auditContextFrom(req), {
        target: updated.username,
        meta: { field: 'email' },
      });
    }

    return { ok: true, data: toSessionUser(updated) } satisfies ApiSuccess<SessionUser>;
  });

  /* ------------------------------ 偏好设置 ------------------------------ */

  app.get('/api/users/me/preferences', { preHandler: requireAuth }, async (req) => {
    const me = currentUser(req);
    const row = loadUser(me.id);
    return { ok: true, data: readPreferences(row.preferences) } satisfies ApiSuccess<UserPreferences>;
  });

  app.patch('/api/users/me/preferences', { preHandler: requireAuth }, async (req) => {
    const me = currentUser(req);
    const patch = updatePreferencesSchema.parse(req.body);

    const row = loadUser(me.id);
    const next = mergePreferences(readPreferences(row.preferences), patch);

    getDb()
      .update(users)
      .set({ preferences: next as unknown as Record<string, unknown>, updatedAt: new Date() })
      .where(eq(users.id, me.id))
      .run();

    return { ok: true, data: next } satisfies ApiSuccess<UserPreferences>;
  });

  /* ------------------------------ 阅读平台 ------------------------------ */

  app.get('/api/users/me/platforms', { preHandler: requireAuth }, async (req) => {
    const me = currentUser(req);
    const custom = getDb()
      .select()
      .from(readingPlatforms)
      .where(eq(readingPlatforms.userId, me.id))
      .orderBy(readingPlatforms.createdAt)
      .all()
      .map(toReadingPlatform);

    // 内置平台在前，自定义平台在后，前端无需再排序
    return { ok: true, data: [...builtinPlatforms(), ...custom] } satisfies ApiSuccess<ReadingPlatform[]>;
  });

  app.post('/api/users/me/platforms', { preHandler: requireAuth }, async (req) => {
    const me = currentUser(req);
    const input = readingPlatformSchema.parse(req.body);

    // 内置 id 已被统计与同步协议引用，允许覆盖会导致同名不同义的混乱
    if ((BUILTIN_PLATFORMS as readonly string[]).includes(input.id)) {
      throw conflict('该标识已被内置平台占用，请换一个');
    }

    const db = getDb();
    const existing = db
      .select({ id: readingPlatforms.id })
      .from(readingPlatforms)
      .where(and(eq(readingPlatforms.userId, me.id), eq(readingPlatforms.platformId, input.id)))
      .get();
    if (existing) throw conflict('该平台标识已存在');

    const inserted = db
      .insert(readingPlatforms)
      .values({
        userId: me.id,
        platformId: input.id,
        label: input.label,
        icon: input.icon ?? null,
        color: input.color ?? null,
        builtin: false,
        createdAt: new Date(),
      })
      .returning()
      .get();

    if (!inserted) throw conflict('平台创建失败，请重试');
    return { ok: true, data: toReadingPlatform(inserted) } satisfies ApiSuccess<ReadingPlatform>;
  });

  app.delete('/api/users/me/platforms/:platformId', { preHandler: requireAuth }, async (req) => {
    const me = currentUser(req);
    const { platformId } = req.params as { platformId: string };

    if ((BUILTIN_PLATFORMS as readonly string[]).includes(platformId)) {
      throw forbidden('内置平台不可删除');
    }

    const db = getDb();
    const row = db
      .select({ id: readingPlatforms.id })
      .from(readingPlatforms)
      .where(and(eq(readingPlatforms.userId, me.id), eq(readingPlatforms.platformId, platformId)))
      .get();
    if (!row) throw notFound('平台不存在');

    db.delete(readingPlatforms).where(eq(readingPlatforms.id, row.id)).run();
    return { ok: true, data: { id: platformId } } satisfies ApiSuccess<{ id: string }>;
  });

  /* ------------------------------ 登录会话 ------------------------------ */

  app.get('/api/users/me/sessions', { preHandler: requireAuth }, async (req) => {
    const me = currentUser(req);
    const rows = getDb()
      .select({
        id: sessions.id,
        device: sessions.device,
        ip: sessions.ip,
        userAgent: sessions.userAgent,
        createdAt: sessions.createdAt,
        lastUsedAt: sessions.lastUsedAt,
        expiresAt: sessions.expiresAt,
      })
      .from(sessions)
      .where(and(eq(sessions.userId, me.id), isNull(sessions.revokedAt), gt(sessions.expiresAt, new Date())))
      .orderBy(desc(sessions.lastUsedAt))
      .all();

    const items: SessionSummary[] = rows.map((row) => ({
      id: row.id,
      device: row.device,
      ip: row.ip,
      userAgent: row.userAgent,
      createdAt: row.createdAt.toISOString(),
      lastUsedAt: row.lastUsedAt ? row.lastUsedAt.toISOString() : null,
      expiresAt: row.expiresAt.toISOString(),
    }));

    return { ok: true, data: items } satisfies ApiSuccess<SessionSummary[]>;
  });

  app.delete('/api/users/me/sessions/:id', { preHandler: requireAuth }, async (req) => {
    const me = currentUser(req);
    const { id } = idParamSchema.parse(req.params);

    const db = getDb();
    const row = db
      .select({ id: sessions.id, userId: sessions.userId })
      .from(sessions)
      .where(eq(sessions.id, id))
      .get();
    // 只能撤销自己的会话；他人的会话一律按「不存在」处理，避免探测他人会话 id
    if (!row || row.userId !== me.id) throw notFound('会话不存在');

    db.update(sessions).set({ revokedAt: new Date() }).where(eq(sessions.id, id)).run();

    // 撤销会话只吊销 refresh token；已签发的 access token 到期前仍有效（JWT 无状态），
    // 这是可接受的权衡，最长 2 小时后彻底失效
    recordAudit('user.logout', auditContextFrom(req), { meta: { sessionId: id, revokedByUser: true } });

    return { ok: true, data: { id } } satisfies ApiSuccess<{ id: number }>;
  });

  /* ------------------------------ 头像 ------------------------------ */

  app.post('/api/users/me/avatar', { preHandler: requireAuth }, async (req) => {
    const me = currentUser(req);

    // 全局 multipart 限制是 2GB（书籍上传需要），这里按 2MB 单独限制
    const file = await req.file({ limits: { fileSize: AVATAR_MAX_BYTES, files: 1 } });
    if (!file) throw badRequest('请选择要上传的头像文件');

    const ext = AVATAR_MIME_EXT[file.mimetype];
    if (!ext) throw unsupportedMediaType('仅支持 PNG / JPEG / WebP / GIF 格式的头像');

    let buffer: Buffer;
    try {
      buffer = await file.toBuffer();
    } catch (err) {
      if (err instanceof app.multipartErrors.RequestFileTooLargeError) {
        throw payloadTooLarge('头像大小不能超过 2MB');
      }
      throw err;
    }
    if (buffer.length === 0) throw badRequest('头像文件为空');
    if (buffer.length > AVATAR_MAX_BYTES) throw payloadTooLarge('头像大小不能超过 2MB');

    const dir = avatarDir();
    await mkdir(dir, { recursive: true });
    await removeAvatarFiles(dir, me.id);
    await writeFile(path.join(dir, `${me.id}.${ext}`), buffer);

    // 加时间戳参数避免浏览器按旧缓存渲染新头像
    const avatarUrl = `/api/users/avatar/${me.id}`;
    const updated = getDb()
      .update(users)
      .set({ avatarUrl, updatedAt: new Date() })
      .where(eq(users.id, me.id))
      .returning()
      .get();
    if (!updated) throw notFound('用户不存在');

    return { ok: true, data: { avatarUrl } } satisfies ApiSuccess<{ avatarUrl: string }>;
  });

  /**
   * 读取头像。
   *
   * 这是全站少数几个不套 ApiSuccess 信封的接口：它需要能直接放进 <img src>，
   * 返回二进制图片才有意义。只暴露「按用户 id 命名的图片文件」，不含任何
   * 私密信息，因此无需登录；路径完全由数字 id 拼接，不存在目录穿越。
   */
  app.get('/api/users/avatar/:userId', async (req, reply) => {
    const { id } = idParamSchema.parse({ id: (req.params as { userId: string }).userId });

    const dir = avatarDir();
    let filename: string | null = null;
    try {
      const entries = await readdir(dir);
      filename = entries.find((name) => name.startsWith(`${id}.`)) ?? null;
    } catch {
      filename = null;
    }
    if (!filename) throw notFound('头像不存在');

    const data = await readFile(path.join(dir, filename));
    const ext = filename.split('.').pop()?.toLowerCase() ?? '';
    reply.header('Cache-Control', 'public, max-age=300');
    return reply.type(AVATAR_EXT_MIME[ext] ?? 'application/octet-stream').send(data);
  });
}
