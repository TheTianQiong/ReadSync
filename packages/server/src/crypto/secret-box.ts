import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { SENSITIVE_CONFIG_KEYS } from '@readsync/shared';
import { loadConfig } from '../config.js';
import { AppError, ERROR_CODES } from '../errors.js';

/**
 * 对称加密盒子，用于保护「需要还原成明文使用」的第三方凭据：
 * WebDAV 密码、S3 SecretKey、Resend API Key、TOTP 密钥等。
 *
 * 与密码的区别：密码只需单向校验（用 Argon2id），而这些凭据服务端必须能还原
 * 出明文去登录第三方服务，所以用 AES-256-GCM 可逆加密。
 *
 * 密钥派生：scrypt(主密钥, 固定盐) → 32 字节。
 * 密文格式：v1.<iv-b64>.<tag-b64>.<ciphertext-b64>，带版本号便于将来轮换算法。
 */

const VERSION = 'v1';
/** 固定盐可接受：主密钥本身是高熵随机值，scrypt 在这里的作用是伸展而非抗字典 */
const SALT = Buffer.from('readsync-secret-box-v1', 'utf8');
const KEY_LENGTH = 32;
const IV_LENGTH = 12; // GCM 推荐 96 位

let cachedKey: Buffer | null = null;

function deriveKey(): Buffer {
  if (cachedKey) return cachedKey;
  const { secret } = loadConfig();
  cachedKey = scryptSync(secret, SALT, KEY_LENGTH);
  return cachedKey;
}

/** 加密任意字符串 */
export function encryptString(plain: string): string {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv('aes-256-gcm', deriveKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString('base64'), tag.toString('base64'), ciphertext.toString('base64')].join('.');
}

/** 解密字符串；密文格式不对或认证标签校验失败时抛错 */
export function decryptString(payload: string): string {
  const parts = payload.split('.');
  if (parts.length !== 4 || parts[0] !== VERSION) {
    throw new AppError(ERROR_CODES.INTERNAL_ERROR, '密文格式不正确', 500);
  }

  const [, ivB64, tagB64, dataB64] = parts as [string, string, string, string];
  try {
    const decipher = createDecipheriv('aes-256-gcm', deriveKey(), Buffer.from(ivB64, 'base64'));
    decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]).toString('utf8');
  } catch (err) {
    throw new AppError(
      ERROR_CODES.INTERNAL_ERROR,
      '凭据解密失败，主密钥可能已变更（数据目录中的 secret.key 是否被替换？）',
      500,
      { cause: err },
    );
  }
}

/** 判断字符串是否已是本盒子产出的密文 */
export function isEncrypted(value: unknown): boolean {
  return typeof value === 'string' && value.startsWith(`${VERSION}.`) && value.split('.').length === 4;
}

/**
 * 加密配置对象里的敏感字段，其余字段原样保留。
 * 幂等：已是密文的字段不会二次加密（避免更新配置时把密文再加密一层）。
 */
export function encryptConfig(config: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(config)) {
    if (SENSITIVE_CONFIG_KEYS.includes(key as (typeof SENSITIVE_CONFIG_KEYS)[number])) {
      if (typeof value === 'string' && value.length > 0 && !isEncrypted(value)) {
        out[key] = encryptString(value);
      } else {
        out[key] = value;
      }
    } else {
      out[key] = value;
    }
  }
  return out;
}

/** 解密配置对象里的敏感字段，得到可直接用于连接第三方的明文配置 */
export function decryptConfig(config: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(config)) {
    if (SENSITIVE_CONFIG_KEYS.includes(key as (typeof SENSITIVE_CONFIG_KEYS)[number]) && isEncrypted(value)) {
      try {
        out[key] = decryptString(value as string);
      } catch {
        // 解密失败时置空而非抛错，让「测试连接」能给出可读的失败原因
        out[key] = '';
      }
    } else {
      out[key] = value;
    }
  }
  return out;
}

/**
 * 生成给前端展示的脱敏配置。
 * 敏感字段保留首尾各 2 个字符，便于用户确认「填的是哪一串」而不泄漏内容。
 */
export function maskConfig(config: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(config)) {
    if (SENSITIVE_CONFIG_KEYS.includes(key as (typeof SENSITIVE_CONFIG_KEYS)[number])) {
      if (typeof value === 'string' && value.length > 0) {
        // 已加密的字段无法展示局部，统一显示掩码
        out[key] = isEncrypted(value) ? '••••••••' : maskValue(value);
      } else {
        out[key] = '';
      }
    } else {
      out[key] = value;
    }
  }
  return out;
}

function maskValue(value: string): string {
  if (value.length <= 4) return '••••';
  return `${value.slice(0, 2)}${'•'.repeat(Math.min(8, value.length - 4))}${value.slice(-2)}`;
}

/** 测试用：重置派生密钥缓存 */
export function resetSecretBoxCache(): void {
  cachedKey = null;
}
