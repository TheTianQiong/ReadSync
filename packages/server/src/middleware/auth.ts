import { eq } from 'drizzle-orm';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { sha256Hex } from '../crypto/password.js';
import { getDb } from '../db/index.js';
import { syncTokens, users } from '../db/schema.js';
import { forbidden, unauthorized } from '../errors.js';
import { verifyAccessToken } from '../lib/jwt.js';

/**
 * 认证中间件。
 *
 * 每个请求都会回库校验一次用户状态与 tokenVersion：
 *  - 管理员禁用某用户后，该用户已签发的 token 立即失效，无需等过期；
 *  - 「登出所有设备」通过自增 tokenVersion 实现。
 * SQLite 是本地文件读，这次查询的开销可以忽略。
 */

export interface AuthUser {
  id: number;
  username: string;
  email: string;
  role: 'admin' | 'user';
  status: 'active' | 'disabled';
  tokenVersion: number;
}

/** 认证方式，便于审计与调试 */
export type AuthKind = 'jwt' | 'sync-token';

declare module 'fastify' {
  interface FastifyRequest {
    /** 已认证用户；未认证时为 null */
    currentUser: AuthUser | null;
    /** 本次请求的认证方式 */
    authKind: AuthKind | null;
    /** 同步令牌的 scope（使用同步令牌认证时存在） */
    syncScopes: string[] | null;
  }
}

/** 从 Authorization 头或 x-auth-token 中取出 Bearer 令牌 */
function extractBearer(req: FastifyRequest): string | null {
  const header = req.headers.authorization;
  if (typeof header === 'string' && header.startsWith('Bearer ')) {
    return header.slice(7).trim();
  }
  // 部分阅读器只方便设置自定义头
  const alt = req.headers['x-auth-token'];
  if (typeof alt === 'string' && alt.length > 0) return alt;
  return null;
}

/** 按 syncTokens 表校验第三方接入令牌（形如 rs_xxx） */
async function authenticateSyncToken(token: string): Promise<{ user: AuthUser; scopes: string[] } | null> {
  const db = getDb();
  const row = db.select().from(syncTokens).where(eq(syncTokens.tokenHash, sha256Hex(token))).get();
  if (!row) return null;

  if (row.expiresAt && row.expiresAt.getTime() < Date.now()) return null;

  const user = db.select().from(users).where(eq(users.id, row.userId)).get();
  if (!user || user.status !== 'active') return null;

  // 记录最近使用时间；失败不影响主流程
  try {
    db.update(syncTokens).set({ lastUsedAt: new Date() }).where(eq(syncTokens.id, row.id)).run();
  } catch {
    /* 忽略 */
  }

  return {
    user: {
      id: user.id,
      username: user.username,
      email: user.email,
      role: user.role,
      status: user.status,
      tokenVersion: user.tokenVersion,
    },
    scopes: row.scopes ?? [],
  };
}

/**
 * 解析认证信息并挂到 req 上，但不强制要求已登录。
 * 用于「登录可选」的接口（如公开设置接口上的个性化字段）。
 */
export async function resolveAuth(req: FastifyRequest): Promise<void> {
  req.currentUser = null;
  req.authKind = null;
  req.syncScopes = null;

  const token = extractBearer(req);
  if (!token) return;

  // 同步令牌以 rs_ 开头，与 JWT 明显区分，避免误判
  if (token.startsWith('rs_')) {
    const result = await authenticateSyncToken(token);
    if (result) {
      req.currentUser = result.user;
      req.authKind = 'sync-token';
      req.syncScopes = result.scopes;
    }
    return;
  }

  let payload;
  try {
    payload = await verifyAccessToken(token);
  } catch {
    // 这里不抛错：是否要求登录由 requireAuth 决定
    return;
  }

  const userId = Number(payload.sub);
  if (!Number.isInteger(userId)) return;

  const db = getDb();
  const user = db.select().from(users).where(eq(users.id, userId)).get();
  if (!user) return;

  // token 版本不匹配说明已被强制下线
  if (user.tokenVersion !== payload.tv) return;
  if (user.status !== 'active') return;

  req.currentUser = {
    id: user.id,
    username: user.username,
    email: user.email,
    role: user.role,
    status: user.status,
    tokenVersion: user.tokenVersion,
  };
  req.authKind = 'jwt';
}

/** 要求已登录，否则 401 */
export async function requireAuth(req: FastifyRequest, _reply: FastifyReply): Promise<void> {
  if (!req.currentUser) {
    await resolveAuth(req);
  }
  if (!req.currentUser) {
    throw unauthorized();
  }
}

/** 要求管理员权限，否则 403 */
export async function requireAdmin(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  await requireAuth(req, reply);
  if (req.currentUser?.role !== 'admin') {
    throw forbidden('该操作仅限管理员');
  }
}

/** 要求同步令牌具备指定 scope（统一同步接口用） */
export function requireScope(scope: string) {
  return async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    await requireAuth(req, reply);
    // JWT 登录态默认拥有全部权限；同步令牌需要显式授权
    if (req.authKind === 'jwt') return;
    const scopes = req.syncScopes ?? [];
    if (!scopes.includes(scope) && !scopes.includes('*')) {
      throw forbidden(`该令牌缺少 ${scope} 权限`);
    }
  };
}

/** 便捷取值：确定已登录时拿到用户（未登录会抛错，供 handler 内使用） */
export function currentUser(req: FastifyRequest): AuthUser {
  if (!req.currentUser) throw unauthorized();
  return req.currentUser;
}
