import { z } from 'zod';
import { AUTH_METHODS, USER_ROLES, USER_STATUSES } from '../constants.js';

/** 用户名规则：字母开头，允许字母数字下划线连字符，3-32 位 */
export const usernameSchema = z
  .string()
  .min(3, '用户名至少 3 个字符')
  .max(32, '用户名最多 32 个字符')
  .regex(/^[a-zA-Z][a-zA-Z0-9_-]*$/, '用户名需以字母开头，只能包含字母、数字、下划线和连字符');

/** 密码强度规则；实际校验在服务端与前端共用同一份 schema */
export const passwordSchema = z
  .string()
  .min(8, '密码至少 8 个字符')
  .max(128, '密码最多 128 个字符')
  .regex(/[a-z]/, '密码需包含小写字母')
  .regex(/[A-Z]/, '密码需包含大写字母')
  .regex(/[0-9]/, '密码需包含数字');

/**
 * 加密载荷。
 *
 * README 要求「用户的密码不可明文传递」「私钥存在服务器本地」。
 * 实现方式：前端用服务端下发的 RSA 公钥做 RSA-OAEP(SHA-256) 加密，
 * 只把密文发给服务端；服务端用本地私钥解密后再用 Argon2id 哈希入库。
 *
 * 注意：这不是「用非对称加密存储密码」——密码落库始终是单向哈希，
 * 私钥仅用于传输解密。详见 docs/security.md。
 */
export const encryptedPayloadSchema = z.object({
  /** Base64 编码的 RSA-OAEP 密文 */
  ciphertext: z.string().min(1, '密文不能为空'),
  /** 本次加密使用的公钥指纹，用于服务端在密钥轮换后识别过期密文 */
  keyFingerprint: z.string().optional(),
  /** 是否已使用公钥加密。为 false 时服务端仅接受 HTTPS 明文传输（不推荐） */
  encrypted: z.boolean().default(true),
});

export type EncryptedPayload = z.infer<typeof encryptedPayloadSchema>;

/** 注册请求 */
export const registerSchema = z.object({
  username: usernameSchema,
  email: z.email('邮箱格式不正确'),
  /** 密码密文（RSA-OAEP） */
  password: encryptedPayloadSchema,
  /** 邀请码；当后台开启「邀请码注册」时必填 */
  inviteCode: z.string().trim().min(1).max(64).optional(),
  /** 显示名称，可选 */
  displayName: z.string().trim().max(64).optional(),
});
export type RegisterInput = z.infer<typeof registerSchema>;

/**
 * 两步验证凭据：6 位 TOTP 验证码，或一次性恢复码。
 *
 * 恢复码形如 `A1B2-C3D4-E5F6`（由 generateRecoveryCodes 生成，12 位字母数字，
 * 展示时带连字符）。用户丢失验证器时用它登录，因此这里必须放行 —— 只允许
 * 6 位数字会让恢复码永远无法使用。
 *
 * 允许省略连字符与大小写差异，服务端统一归一化后再比对。
 */
export const twoFactorCodeSchema = z
  .string()
  .trim()
  .min(6, '验证码至少 6 位')
  .max(14, '验证码过长')
  .regex(/^[0-9A-Za-z-]+$/, '验证码格式不正确');

/** 判断是否为 6 位数字 TOTP 验证码（否则按恢复码处理） */
export function isTotpCode(code: string): boolean {
  return /^[0-9]{6}$/.test(code.trim());
}

/** 登录请求 */
export const loginSchema = z.object({
  username: usernameSchema.or(z.email()),
  password: encryptedPayloadSchema,
  /** 两步验证凭据：TOTP 验证码或恢复码，当账号开启 TOTP 时需要 */
  totpCode: twoFactorCodeSchema.optional(),
  /** 是否记住登录状态（延长会话有效期） */
  remember: z.boolean().default(false),
});
export type LoginInput = z.infer<typeof loginSchema>;

/** 刷新令牌请求 */
export const refreshTokenSchema = z.object({
  refreshToken: z.string().min(1),
});

/** 忘记密码：请求发送验证码 */
export const forgotPasswordSchema = z.object({
  email: z.email('邮箱格式不正确'),
});

/** 重置密码：校验验证码 + 设置新密码 */
export const resetPasswordSchema = z.object({
  email: z.email('邮箱格式不正确'),
  code: z.string().regex(/^[0-9]{6}$/, '验证码为 6 位数字'),
  /** 新密码同样以密文提交：明文密码不应出现在任何请求体里 */
  newPassword: encryptedPayloadSchema,
});

/** 修改密码（已登录） */
export const changePasswordSchema = z.object({
  oldPassword: encryptedPayloadSchema,
  newPassword: encryptedPayloadSchema,
});

/** 当前登录用户信息 */
export interface SessionUser {
  id: number;
  username: string;
  email: string;
  displayName: string | null;
  role: (typeof USER_ROLES)[number];
  status: (typeof USER_STATUSES)[number];
  /** 是否已开启 TOTP 两步验证 */
  totpEnabled: boolean;
  /** 已注册的通行密钥数量 */
  passkeyCount: number;
  /** 头像地址（可为空） */
  avatarUrl: string | null;
  createdAt: string;
  lastLoginAt: string | null;
}

/** 登录成功返回 */
export interface AuthResult {
  user: SessionUser;
  accessToken: string;
  refreshToken: string;
  /** accessToken 过期时间（秒） */
  expiresIn: number;
  /** 是否需要二次验证（当账号开启 TOTP 且本次未提供验证码时） */
  requires2fa?: boolean;
}

/** 服务端公钥信息，供前端加密密码 */
export interface PublicKeyInfo {
  /** PEM 格式公钥（SPKI） */
  publicKey: string;
  /** 公钥指纹（SHA-256 前 16 位十六进制） */
  fingerprint: string;
  /** 加密算法标识，前端据此选择 WebCrypto 参数 */
  algorithm: 'RSA-OAEP-256';
}

/** 2FA 相关 */
export const totpVerifySchema = z.object({
  code: z.string().regex(/^[0-9]{6}$/, '验证码为 6 位数字'),
});

export const totpDisableSchema = z.object({
  code: z.string().regex(/^[0-9]{6}$/, '验证码为 6 位数字'),
  password: encryptedPayloadSchema,
});

/** 开启 2FA 时返回的绑定信息 */
export interface TotpSetupResult {
  /** Base32 密钥，供用户手动输入 */
  secret: string;
  /** otpauth:// URI，用于生成二维码 */
  otpauthUrl: string;
  /** 恢复码（一次性使用），仅在开启成功时返回一次 */
  recoveryCodes?: string[];
}

/** 通行密钥（WebAuthn）相关 */
export const passkeyRegisterVerifySchema = z.object({
  response: z.any(),
  /** 用户为该通行密钥起的名字，便于在设备列表中区分 */
  name: z.string().trim().max(64).optional(),
});

export const passkeyLoginVerifySchema = z.object({
  username: usernameSchema.or(z.email()).optional(),
  response: z.any(),
});

export interface PasskeySummary {
  id: number;
  name: string | null;
  deviceType: string | null;
  backedUp: boolean;
  createdAt: string;
  lastUsedAt: string | null;
}

/** 认证方式汇总，用于前端「账号安全」页 */
export const AUTH_METHOD_LABELS: Record<(typeof AUTH_METHODS)[number], string> = {
  password: '密码',
  totp: '验证器 (TOTP)',
  passkey: '通行密钥',
};
