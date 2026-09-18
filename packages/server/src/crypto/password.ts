import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { hash as argonHash, verify as argonVerify, Algorithm } from '@node-rs/argon2';

/**
 * 密码哈希与各类令牌摘要。
 *
 * 密码一律用 Argon2id 单向哈希后入库（README 要求「密码通过不对称加密的方式
 * 进行存储」在实现上落为「传输用 RSA、存储用 Argon2id」，理由见 docs/security.md
 * —— 密码存储必须是单向的，否则私钥泄露即等于全部密码泄露）。
 */

/** Argon2id 参数：平衡安全与自托管设备的性能（树莓派也能在 100ms 内完成） */
const ARGON_OPTIONS = {
  algorithm: Algorithm.Argon2id,
  memoryCost: 19456, // 19 MiB，OWASP 推荐的最小值
  timeCost: 2,
  parallelism: 1,
  outputLen: 32,
} as const;

/** 生成密码哈希 */
export async function hashPassword(plain: string): Promise<string> {
  return argonHash(plain, ARGON_OPTIONS);
}

/** 校验密码；哈希串损坏时返回 false 而不是抛错，避免登录接口 500 */
export async function verifyPassword(storedHash: string, plain: string): Promise<boolean> {
  try {
    return await argonVerify(storedHash, plain);
  } catch {
    return false;
  }
}

/**
 * KOSync 专用密钥。
 *
 * KOReader 客户端固定发送 md5(密码) 作为 x-auth-key，服务端无法要求它改用
 * Argon2 或 RSA。因此单独保存一份 md5 供该协议校验。
 * 用户在设置页可设置独立的「同步密码」，避免主密码的 md5 外泄后被撞库。
 */
export function md5Hex(input: string): string {
  return createHash('md5').update(input, 'utf8').digest('hex');
}

/** 恒定时间比较两个十六进制摘要，避免通过响应时间侧信道推断 */
export function safeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
  } catch {
    return false;
  }
}

/** SHA-256 十六进制摘要，用于令牌落库（refresh token、同步令牌、验证码） */
export function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/** 生成 URL 安全的随机令牌 */
export function generateToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/** 生成 n 位数字验证码（邮箱验证码用），使用 CSPRNG */
export function generateNumericCode(digits = 6): string {
  const max = 10 ** digits;
  // 用拒绝采样消除取模偏置
  const limit = Math.floor(0xffffffff / max) * max;
  let value: number;
  do {
    value = randomBytes(4).readUInt32BE(0);
  } while (value >= limit);
  return String(value % max).padStart(digits, '0');
}

/** 生成人类可读的邀请码，剔除容易混淆的 0/O/1/I/l */
export function generateInviteCode(length = 12): string {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const bytes = randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i += 1) {
    out += alphabet[bytes[i]! % alphabet.length];
  }
  return out;
}

/** 生成 KOSync 同步密码（用户不指定时随机生成，展示给用户一次） */
export function generateSyncPassword(): string {
  return randomBytes(16).toString('base64url');
}

/** 生成恢复码，形如 A1B2-C3D4-E5F6 */
export function generateRecoveryCodes(count = 8): string[] {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const codes: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const bytes = randomBytes(12);
    let raw = '';
    for (let j = 0; j < 12; j += 1) {
      raw += alphabet[bytes[j]! % alphabet.length];
    }
    codes.push(`${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}`);
  }
  return codes;
}
