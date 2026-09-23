import { z } from 'zod';
import { MAIL_PROVIDERS, USER_ROLES, USER_STATUSES } from '../constants.js';
import { passwordPayloadSchema } from './auth.js';
import { DEFAULT_ALLOWED_EXTENSIONS, DEFAULT_MAX_FILE_SIZE } from './book.js';
import { paginationQuerySchema } from './common.js';

/**
 * 管理后台（README 前端要求 9）：站点管理、用户管理、邀请码、插件管理。
 * 所有接口都要求 admin 角色。
 */

/* ---------------------------- 站点设置 ---------------------------- */

export const siteSettingsSchema = z.object({
  /** 站点名称，展示在前端导航栏与邮件标题 */
  siteName: z.string().trim().min(1).max(64).default('读记服务器'),
  /** 是否允许新用户自助注册 */
  registrationEnabled: z.boolean().default(true),
  /** 是否开启邀请码注册 */
  inviteRequired: z.boolean().default(false),
  /** 是否允许通过邮件找回密码 */
  passwordResetEnabled: z.boolean().default(true),
  /** 上传限制 */
  upload: z
    .object({
      maxFileSize: z.coerce.number().int().min(0).default(DEFAULT_MAX_FILE_SIZE),
      allowedExtensions: z
        .array(z.string().trim().toLowerCase().regex(/^[a-z0-9]+$/))
        .default([...DEFAULT_ALLOWED_EXTENSIONS]),
    })
    .default({
      maxFileSize: DEFAULT_MAX_FILE_SIZE,
      allowedExtensions: [...DEFAULT_ALLOWED_EXTENSIONS],
    }),
  /** 单用户书库容量上限（字节），0 表示不限制 */
  userQuotaBytes: z.coerce.number().int().min(0).default(0),
  /** 是否允许用户自行配置存储后端 */
  allowUserStorage: z.boolean().default(true),
  /** 默认主题 */
  defaultTheme: z.enum(['light', 'dark', 'system']).default('system'),
  /** 页面底部自定义页脚文本 */
  footerText: z.string().max(256).default(''),
});

export type SiteSettings = z.infer<typeof siteSettingsSchema>;

/** 站点设置的公开子集，未登录用户也能读取（登录页需要知道是否开放注册） */
export interface PublicSettings {
  siteName: string;
  registrationEnabled: boolean;
  inviteRequired: boolean;
  passwordResetEnabled: boolean;
  defaultTheme: 'light' | 'dark' | 'system';
  footerText: string;
  version: string;
  /**
   * 上传限制，公开给前端做**上传前预检**。
   *
   * 必须暴露：否则用户选中一个 300 MB 的文件、传了十分钟，才在最后被服务端
   * 拒绝（或在反向代理那一层被掐断，浏览器只报「网络连接中断」）。
   * 提前知道上限就能立刻给出「超过本站单文件上限 200 MB」这种可行动的错误。
   */
  upload: {
    /** 单文件上限（字节），0 表示不限制 */
    maxFileSize: number;
    allowedExtensions: string[];
  };
  /**
   * 服务端是否接受明文密码。
   *
   * 背景：密码加密依赖浏览器的 WebCrypto，而它只在安全上下文（HTTPS 或
   * localhost）可用。只通过 http://<内网IP> 访问时，前端无法加密 ——
   * 此时若服务端显式开启了 READSYNC_ALLOW_PLAINTEXT_PASSWORD，
   * 前端才降级为明文提交，并展示醒目警告。
   *
   * 默认 false：服务端只接受密文，前端在非安全上下文下明确报错而不是悄悄降级。
   */
  allowPlaintextPassword: boolean;
}

/* ---------------------------- 邮件设置 ---------------------------- */

export const mailSettingsSchema = z
  .discriminatedUnion('provider', [
    z.object({
      provider: z.literal('resend'),
      apiKey: z.string().min(1, '请填写 Resend API Key'),
      from: z.string().min(1, '请填写发件人'),
    }),
    z.object({
      provider: z.literal('smtp'),
      host: z.string().min(1, '请填写 SMTP 主机'),
      port: z.coerce.number().int().min(1).max(65535).default(587),
      secure: z.boolean().default(false),
      username: z.string().min(1),
      password: z.string().min(1),
      from: z.string().min(1, '请填写发件人'),
    }),
    z.object({
      provider: z.literal('console'),
      from: z.string().default('noreply@localhost'),
    }),
  ])
  .and(z.object({ enabled: z.boolean().default(false) }));

export type MailSettings = z.infer<typeof mailSettingsSchema>;

/** 邮件设置对外表示（密钥脱敏） */
export interface MailSettingsSummary {
  enabled: boolean;
  provider: (typeof MAIL_PROVIDERS)[number];
  from: string | null;
  /** 脱敏后的连接信息，例如 { host: 'smtp.qq.com', port: 587, username: 'ab***' } */
  detail: Record<string, unknown>;
  lastTestAt: string | null;
  lastTestOk: boolean | null;
  lastTestMessage: string | null;
}

/** 发送测试邮件 */
export const mailTestSchema = z.object({
  to: z.email('收件人邮箱格式不正确'),
});

/* ---------------------------- 用户管理 ---------------------------- */

export const listUsersQuerySchema = paginationQuerySchema.extend({
  q: z.string().trim().max(128).optional(),
  role: z.enum(USER_ROLES).optional(),
  status: z.enum(USER_STATUSES).optional(),
  sortBy: z.enum(['username', 'email', 'createdAt', 'lastLoginAt']).default('createdAt'),
  sortOrder: z.enum(['asc', 'desc']).default('desc'),
});
export type ListUsersQuery = z.infer<typeof listUsersQuerySchema>;

/** 管理员创建用户 */
export const adminCreateUserSchema = z.object({
  username: z.string().min(3).max(32),
  email: z.email(),
  /** 密码载荷；管理员输入的是别人的密码，更不应明文过网 */
  password: passwordPayloadSchema,
  displayName: z.string().trim().max(64).optional(),
  role: z.enum(USER_ROLES).default('user'),
});

/** 管理员修改用户 */
export const adminUpdateUserSchema = z.object({
  email: z.email().optional(),
  displayName: z.string().trim().max(64).optional(),
  role: z.enum(USER_ROLES).optional(),
  status: z.enum(USER_STATUSES).optional(),
});

/** 管理员重置用户密码（直接指定新密码，无需旧密码） */
export const adminResetPasswordSchema = z.object({
  newPassword: passwordPayloadSchema,
  /** 是否同时重置该用户的 KOSync 同步密钥 */
  resetKosyncKey: z.boolean().default(true),
});

/** 用户对外表示（管理后台列表用） */
export interface AdminUserSummary {
  id: number;
  username: string;
  email: string;
  displayName: string | null;
  role: (typeof USER_ROLES)[number];
  status: (typeof USER_STATUSES)[number];
  totpEnabled: boolean;
  passkeyCount: number;
  storageCount: number;
  bookCount: number;
  usedBytes: number;
  createdAt: string;
  lastLoginAt: string | null;
}

/* ---------------------------- 邀请码 ---------------------------- */

export const createInviteSchema = z.object({
  /** 自定义邀请码；不传则自动生成 */
  code: z
    .string()
    .trim()
    .min(4)
    .max(64)
    .regex(/^[A-Za-z0-9_-]+$/, '邀请码只能包含字母、数字、下划线和连字符')
    .optional(),
  /** 可注册次数，0 表示不限 */
  maxUses: z.coerce.number().int().min(0).default(1),
  /** 过期时间（RFC3339）；不传表示永不过期 */
  expiresAt: z.iso.datetime().optional(),
  note: z.string().trim().max(128).optional(),
});
export type CreateInviteInput = z.infer<typeof createInviteSchema>;

export interface InviteCode {
  id: number;
  code: string;
  maxUses: number;
  usedCount: number;
  expiresAt: string | null;
  note: string | null;
  /** 创建者用户 ID */
  createdBy: number;
  createdAt: string;
  /** 是否已失效（用尽或过期） */
  exhausted: boolean;
}

/* ---------------------------- 审计日志 ---------------------------- */

export const listAuditQuerySchema = paginationQuerySchema.extend({
  action: z.string().max(64).optional(),
  userId: z.coerce.number().int().positive().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
});
export type ListAuditQuery = z.infer<typeof listAuditQuerySchema>;

export interface AuditLogEntry {
  id: number;
  userId: number | null;
  username: string | null;
  action: string;
  /** 操作对象描述，例如书籍名、存储名 */
  target: string | null;
  /** 客户端 IP */
  ip: string | null;
  userAgent: string | null;
  /** 附加信息（JSON） */
  meta: Record<string, unknown> | null;
  success: boolean;
  createdAt: string;
}

/* ---------------------------- 系统信息 ---------------------------- */

export interface SystemInfo {
  version: string;
  nodeVersion: string;
  platform: string;
  uptimeSeconds: number;
  /** 数据库文件大小（字节） */
  databaseSize: number;
  /** 数据目录大小（字节） */
  dataDirSize: number;
  /** 用户数、书籍数等汇总 */
  counts: {
    users: number;
    books: number;
    storages: number;
    plugins: number;
    syncEntries: number;
  };
  /** 服务器本地 RSA 公钥指纹，用于确认前端加密对接的是哪把密钥 */
  publicKeyFingerprint: string;
}

/** 初始化引导：站点首次启动且无任何管理员时可用 */
export const bootstrapSchema = z.object({
  username: z.string().min(3).max(32),
  email: z.email(),
  /** 密码载荷，与登录/注册保持一致 */
  password: passwordPayloadSchema,
  siteName: z.string().trim().min(1).max(64).default('读记服务器'),
});

export interface BootstrapStatus {
  /** 是否已完成初始化（存在至少一个管理员账号） */
  initialized: boolean;
}
