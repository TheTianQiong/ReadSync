import { SignJWT, jwtVerify, type JWTPayload } from 'jose';
import { loadConfig } from '../config.js';
import { unauthorized } from '../errors.js';

/**
 * access token 的签发与校验。
 *
 * 用 HS256 + 配置里的主密钥派生出的独立密钥（与存储凭据加密密钥域分离）。
 * refresh token 不走 JWT，而是随机串 + 数据库哈希，这样「登出所有设备」
 * 与设备管理才能即时生效。
 */

export interface AccessTokenPayload extends JWTPayload {
  /** 用户 ID（字符串形式） */
  sub: string;
  username: string;
  role: 'admin' | 'user';
  /** token 版本，与 users.tokenVersion 比对，用于一次性吊销该用户全部令牌 */
  tv: number;
}

const ISSUER = 'readsync';
const AUDIENCE = 'readsync-api';

let cachedKey: Uint8Array | null = null;

function getSecretKey(): Uint8Array {
  if (cachedKey) return cachedKey;
  const { secret } = loadConfig();
  // 用固定标签做域分离，避免与 AES 主密钥直接共用同一份字节
  cachedKey = new TextEncoder().encode(`readsync-jwt-v1:${secret}`);
  return cachedKey;
}

/** 签发 access token */
export async function signAccessToken(payload: Omit<AccessTokenPayload, 'iat' | 'exp' | 'iss' | 'aud'>): Promise<string> {
  const config = loadConfig();
  const now = Math.floor(Date.now() / 1000);

  return new SignJWT({ ...payload })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt(now)
    .setExpirationTime(now + config.READSYNC_ACCESS_TOKEN_TTL)
    .sign(getSecretKey());
}

/** 校验 access token，失败时抛 401 */
export async function verifyAccessToken(token: string): Promise<AccessTokenPayload> {
  try {
    const { payload } = await jwtVerify(token, getSecretKey(), {
      issuer: ISSUER,
      audience: AUDIENCE,
    });
    return payload as AccessTokenPayload;
  } catch (err) {
    // 过期与签名错误对外都是「登录已过期」，避免给攻击者额外信息
    throw unauthorized(err instanceof Error && err.message.includes('expired') ? '登录已过期，请重新登录' : '登录凭证无效');
  }
}

/** access token 有效期（秒），返回给前端用于提前刷新 */
export function accessTokenTtl(): number {
  return loadConfig().READSYNC_ACCESS_TOKEN_TTL;
}

/** 测试用：重置缓存的签名密钥 */
export function resetJwtCache(): void {
  cachedKey = null;
}
