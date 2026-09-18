import { and, eq, ne } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import {
  adminCreateUserSchema,
  adminResetPasswordSchema,
  adminUpdateUserSchema,
  createInviteSchema,
  idParamSchema,
  listAuditQuerySchema,
  listUsersQuerySchema,
  mailSettingsSchema,
  mailTestSchema,
  siteSettingsSchema,
  type AdminUserSummary,
  type ApiSuccess,
  type AuditLogEntry,
  type InviteCode,
  type MailSettings,
  type MailSettingsSummary,
  type Paginated,
  type SiteSettings,
  type SystemInfo,
} from '@readsync/shared';
import { encryptConfig } from '../../crypto/secret-box.js';
import { generateInviteCode } from '../../crypto/password.js';
import { getDb } from '../../db/index.js';
import { inviteCodes, users } from '../../db/schema.js';
import { badRequest, conflict, forbidden, internal, notFound } from '../../errors.js';
import { auditContextFrom, recordAudit } from '../../lib/audit.js';
import { resetMailCache, sendTestMail } from '../../lib/mail.js';
import { resolveNewPassword } from '../../lib/password-input.js';
import {
  getMailSettingsRaw,
  getMailSettingsSummary,
  getSiteSettings,
  patchSiteSettings,
  saveMailSettingsRaw,
} from '../../lib/settings.js';
import { createUser } from '../../lib/users.js';
import { currentUser, requireAdmin } from '../../middleware/auth.js';
import {
  computeSystemInfo,
  deleteUserCascade,
  getAdminUserSummary,
  inviteCodeExists,
  listAdminUsers,
  listAuditLogs,
  listInviteCodes,
  resetUserPassword,
  toInviteCode,
} from './service.js';

/**
 * 管理后台（README 前端要求 9：设置管理后台）。
 *
 * 整个模块一律 requireAdmin；站点管理、用户管理、邀请码、审计、系统信息
 * 都在这里。错误处理统一交给 app.ts 的全局 setErrorHandler，这里只抛 AppError。
 */
export async function registerAdminRoutes(app: FastifyInstance): Promise<void> {
  /* ------------------------------ 站点设置 ------------------------------ */

  app.get('/api/admin/settings', { preHandler: requireAdmin }, async () => {
    return { ok: true, data: getSiteSettings() } satisfies ApiSuccess<SiteSettings>;
  });

  /**
   * 部分更新站点设置。
   *
   * 用 siteSettingsSchema.partial() 而不是整体 parse：schema 里每个字段都带
   * default()，整体 parse 会把未提交的字段补成默认值，随后 patchSiteSettings
   * 的深合并会用这些默认值覆盖掉管理员之前保存的自定义值（例如接口白名单）。
   */
  app.patch('/api/admin/settings', { preHandler: requireAdmin }, async (req) => {
    const patch = siteSettingsSchema.partial().parse(req.body) as Partial<SiteSettings>;
    const updated = patchSiteSettings(patch);

    recordAudit('admin.settings_update', auditContextFrom(req), {
      target: 'site',
      meta: { keys: Object.keys(patch) },
    });

    return { ok: true, data: updated } satisfies ApiSuccess<SiteSettings>;
  });

  /* ------------------------------ 邮件设置 ------------------------------ */

  app.get('/api/admin/mail', { preHandler: requireAdmin }, async () => {
    return { ok: true, data: getMailSettingsSummary() } satisfies ApiSuccess<MailSettingsSummary>;
  });

  /**
   * 保存邮件配置。
   *
   * 两个要点：
   *  1. 密钥类字段（apiKey / password / username）用 encryptConfig 加密后落库，
   *     mail.ts 发送时再解密 —— 数据库文件泄漏不等于第三方账号失守。
   *  2. 前端回显的是脱敏值（形如 •••••••• 或 ab••••cd），管理员没改动该字段时
   *     会把掩码原样提交回来。这时必须保留原密文，否则一次无关的保存就会把
   *     已配置的密钥覆盖成字面量掩码字符串。
   */
  app.put('/api/admin/mail', { preHandler: requireAdmin }, async (req) => {
    const input = mailSettingsSchema.parse(req.body) as MailSettings;
    const raw = getMailSettingsRaw() ?? {};

    const next: Record<string, unknown> = {
      enabled: input.enabled,
      provider: input.provider,
      from: input.from,
      // 保留历史测试结果，避免保存配置后丢失「上次测试」信息
      ...(raw.lastTestAt !== undefined ? { lastTestAt: raw.lastTestAt } : {}),
      ...(raw.lastTestOk !== undefined ? { lastTestOk: raw.lastTestOk } : {}),
      ...(raw.lastTestMessage !== undefined ? { lastTestMessage: raw.lastTestMessage } : {}),
    };

    if (input.provider === 'resend') {
      next.apiKey = keepSecretIfMasked(input.apiKey, raw.apiKey, 'Resend API Key');
    } else if (input.provider === 'smtp') {
      next.host = input.host;
      next.port = input.port;
      next.secure = input.secure;
      next.username = keepSecretIfMasked(input.username, raw.username, 'SMTP 用户名');
      next.password = keepSecretIfMasked(input.password, raw.password, 'SMTP 密码');
    }

    saveMailSettingsRaw(encryptConfig(next));
    resetMailCache();

    recordAudit('admin.settings_update', auditContextFrom(req), {
      target: 'mail',
      meta: { provider: input.provider, enabled: input.enabled },
    });

    return { ok: true, data: getMailSettingsSummary() } satisfies ApiSuccess<MailSettingsSummary>;
  });

  app.post('/api/admin/mail/test', { preHandler: requireAdmin }, async (req) => {
    const input = mailTestSchema.parse(req.body);
    const result = await sendTestMail(input.to);
    // 不抛错：测试失败是预期结果之一，前端要展示具体原因
    return { ok: true, data: result } satisfies ApiSuccess<{ ok: boolean; message: string }>;
  });

  /* ------------------------------ 用户管理 ------------------------------ */

  app.get('/api/admin/users', { preHandler: requireAdmin }, async (req) => {
    const query = listUsersQuerySchema.parse(req.query);
    return { ok: true, data: listAdminUsers(query) } satisfies ApiSuccess<Paginated<AdminUserSummary>>;
  });

  app.post('/api/admin/users', { preHandler: requireAdmin }, async (req) => {
    const input = adminCreateUserSchema.parse(req.body);

    const created = await createUser({
      username: input.username,
      email: input.email,
      // 管理员为他人设置的密码同样以密文提交：管理员只是「被信任能设置它」，
      // 不代表这个密码可以明文穿过网络与日志
      plainPassword: resolveNewPassword(input.password, '新用户密码'),
      displayName: input.displayName,
      role: input.role,
    });

    recordAudit('user.register', auditContextFrom(req), {
      target: created.username,
      meta: { byAdmin: true, role: created.role },
    });

    const summary = getAdminUserSummary(created.id);
    if (!summary) throw internal('用户创建后读取摘要失败');
    return { ok: true, data: summary } satisfies ApiSuccess<AdminUserSummary>;
  });

  app.get('/api/admin/users/:id', { preHandler: requireAdmin }, async (req) => {
    const { id } = idParamSchema.parse(req.params);
    const summary = getAdminUserSummary(id);
    if (!summary) throw notFound('用户不存在');
    return { ok: true, data: summary } satisfies ApiSuccess<AdminUserSummary>;
  });

  app.patch('/api/admin/users/:id', { preHandler: requireAdmin }, async (req) => {
    const { id } = idParamSchema.parse(req.params);
    const input = adminUpdateUserSchema.parse(req.body);

    const db = getDb();
    const target = db.select().from(users).where(eq(users.id, id)).get();
    if (!target) throw notFound('用户不存在');

    const me = currentUser(req);

    /*
     * 安全约束：禁止管理员把自己降级或禁用。
     * 站点可能只有一个管理员，一旦自我降级/禁用就再没有任何账号能进入管理后台
     * （授权、改密、恢复都得靠管理员），属于不可逆的自锁。要退出管理只能由
     * 另一个管理员操作，或另建管理员后再降级。
     */
    if (id === me.id) {
      if (input.role !== undefined && input.role !== 'admin') {
        throw forbidden('不能撤销自己的管理员权限：站点一旦没有管理员将无法再进入管理后台');
      }
      if (input.status !== undefined && input.status !== 'active') {
        throw forbidden('不能禁用自己的账号：禁用后将无法登录管理系统');
      }
    }

    if (input.email !== undefined && input.email !== target.email) {
      const taken = db
        .select({ id: users.id })
        .from(users)
        .where(and(eq(users.email, input.email), ne(users.id, id)))
        .get();
      if (taken) throw conflict('该邮箱已被其他用户使用');
    }

    const roleChanged = input.role !== undefined && input.role !== target.role;
    const statusChanged = input.status !== undefined && input.status !== target.status;

    db.update(users)
      .set({
        ...(input.email !== undefined ? { email: input.email } : {}),
        ...(input.displayName !== undefined ? { displayName: input.displayName } : {}),
        ...(input.role !== undefined ? { role: input.role } : {}),
        ...(input.status !== undefined ? { status: input.status } : {}),
        updatedAt: new Date(),
      })
      .where(eq(users.id, id))
      .run();

    recordAudit(
      roleChanged ? 'user.role_change' : statusChanged ? (input.status === 'disabled' ? 'user.disable' : 'user.enable') : 'user.update',
      auditContextFrom(req),
      {
        target: target.username,
        meta: { changes: Object.keys(input) },
      },
    );

    const summary = getAdminUserSummary(id);
    if (!summary) throw notFound('用户不存在');
    return { ok: true, data: summary } satisfies ApiSuccess<AdminUserSummary>;
  });

  app.delete('/api/admin/users/:id', { preHandler: requireAdmin }, async (req) => {
    const { id } = idParamSchema.parse(req.params);
    const me = currentUser(req);

    // 同 PATCH：删除自己同样会让站点失去唯一管理员，且删除不可恢复，必须禁止
    if (id === me.id) {
      throw forbidden('不能删除自己的账号：删除后将无法再进入管理后台');
    }

    const removed = deleteUserCascade(id);

    recordAudit('user.delete', auditContextFrom(req), {
      target: removed.username,
      meta: { deletedUserId: removed.id },
    });

    return { ok: true, data: { id: removed.id } } satisfies ApiSuccess<{ id: number }>;
  });

  app.post('/api/admin/users/:id/reset-password', { preHandler: requireAdmin }, async (req) => {
    const { id } = idParamSchema.parse(req.params);
    const input = adminResetPasswordSchema.parse(req.body);

    const target = getDb().select({ id: users.id, username: users.username }).from(users).where(eq(users.id, id)).get();
    if (!target) throw notFound('用户不存在');

    await resetUserPassword(id, resolveNewPassword(input.newPassword, '新密码'), input.resetKosyncKey);

    recordAudit('user.password_reset', auditContextFrom(req), {
      target: target.username,
      meta: { byAdmin: true, resetKosyncKey: input.resetKosyncKey },
    });

    return { ok: true, data: { id, resetKosyncKey: input.resetKosyncKey } } satisfies ApiSuccess<{
      id: number;
      resetKosyncKey: boolean;
    }>;
  });

  /* ------------------------------ 邀请码 ------------------------------ */

  app.get('/api/admin/invites', { preHandler: requireAdmin }, async () => {
    return { ok: true, data: listInviteCodes() } satisfies ApiSuccess<InviteCode[]>;
  });

  app.post('/api/admin/invites', { preHandler: requireAdmin }, async (req) => {
    const input = createInviteSchema.parse(req.body);
    const me = currentUser(req);

    let code = input.code;
    if (code) {
      if (inviteCodeExists(code)) throw conflict('该邀请码已存在');
    } else {
      // 随机码理论上可能撞库（尤其站点已存在大量邀请码），重试几次即可
      for (let attempt = 0; attempt < 5 && !code; attempt += 1) {
        const candidate = generateInviteCode();
        if (!inviteCodeExists(candidate)) code = candidate;
      }
      if (!code) throw internal('邀请码生成失败，请重试');
    }

    const inserted = getDb()
      .insert(inviteCodes)
      .values({
        code,
        maxUses: input.maxUses,
        usedCount: 0,
        expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
        note: input.note ?? null,
        createdBy: me.id,
        createdAt: new Date(),
      })
      .returning()
      .get();

    if (!inserted) throw internal('邀请码创建失败，请重试');

    recordAudit('admin.invite_create', auditContextFrom(req), {
      target: inserted.code,
      meta: { maxUses: inserted.maxUses, expiresAt: inserted.expiresAt?.toISOString() ?? null },
    });

    return { ok: true, data: toInviteCode(inserted) } satisfies ApiSuccess<InviteCode>;
  });

  app.delete('/api/admin/invites/:id', { preHandler: requireAdmin }, async (req) => {
    const { id } = idParamSchema.parse(req.params);
    const db = getDb();

    const row = db.select().from(inviteCodes).where(eq(inviteCodes.id, id)).get();
    if (!row) throw notFound('邀请码不存在');

    db.delete(inviteCodes).where(eq(inviteCodes.id, id)).run();

    recordAudit('admin.invite_revoke', auditContextFrom(req), { target: row.code });

    return { ok: true, data: { id } } satisfies ApiSuccess<{ id: number }>;
  });

  /* ------------------------------ 审计与系统 ------------------------------ */

  app.get('/api/admin/audit', { preHandler: requireAdmin }, async (req) => {
    const query = listAuditQuerySchema.parse(req.query);
    return { ok: true, data: listAuditLogs(query) } satisfies ApiSuccess<Paginated<AuditLogEntry>>;
  });

  app.get('/api/admin/system', { preHandler: requireAdmin }, async () => {
    return { ok: true, data: await computeSystemInfo() } satisfies ApiSuccess<SystemInfo>;
  });
}

/**
 * 掩码值表示「管理员没有改动这个密钥字段」，此时保留库里的原值（已是密文）。
 * 若原值为空，说明字段从未配置过，掩码无从还原，直接报错让管理员填写真实值。
 */
function keepSecretIfMasked(value: string, existing: unknown, label: string): unknown {
  if (value.includes('•')) {
    if (typeof existing === 'string' && existing.length > 0) return existing;
    throw badRequest(`${label}尚未配置，请填写完整值`);
  }
  return value;
}
