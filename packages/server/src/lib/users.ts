import { eq, or } from 'drizzle-orm';
import type { SessionUser, UserRole } from '@readsync/shared';
import { hashPassword, md5Hex } from '../crypto/password.js';
import { getDb } from '../db/index.js';
import { passkeys, storages, users, type UserRow } from '../db/schema.js';
import { conflict } from '../errors.js';

/**
 * 用户创建的公共入口。
 *
 * 注册（auth）、管理员建号（admin）、初始化引导（system）三条路径都走这里，
 * 保证用户名/邮箱唯一性检查、密码哈希、KOSync 密钥派生这三件事只实现一次。
 */

export interface CreateUserInput {
  username: string;
  email: string;
  /** 明文密码（调用方已通过 RSA 解密或本身就是管理员直接指定） */
  plainPassword: string;
  displayName?: string | undefined;
  role?: UserRole | undefined;
  /** 是否同时派生 KOSync 同步密钥（默认派生，方便 KOReader 直接登录） */
  deriveKosyncKey?: boolean | undefined;
}

/** 创建用户；用户名或邮箱冲突时抛 CONFLICT */
export async function createUser(input: CreateUserInput): Promise<UserRow> {
  const db = getDb();

  const existing = db
    .select({ id: users.id, username: users.username, email: users.email })
    .from(users)
    .where(or(eq(users.username, input.username), eq(users.email, input.email)))
    .get();

  if (existing) {
    if (existing.username === input.username) {
      throw conflict('该用户名已被注册');
    }
    throw conflict('该邮箱已被注册');
  }

  const passwordHash = await hashPassword(input.plainPassword);

  const inserted = db
    .insert(users)
    .values({
      username: input.username,
      email: input.email,
      displayName: input.displayName ?? null,
      passwordHash,
      // KOSync 协议只能发送 md5(密码)，这里存一份供该协议校验
      kosyncKey: (input.deriveKosyncKey ?? true) ? md5Hex(input.plainPassword) : null,
      role: input.role ?? 'user',
      status: 'active',
      preferences: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    .returning()
    .get();

  if (!inserted) {
    throw conflict('用户创建失败，请重试');
  }

  return inserted;
}

/** 判断站点是否已完成初始化（是否存在至少一个管理员） */
export function hasAdmin(): boolean {
  const db = getDb();
  const row = db.select({ id: users.id }).from(users).where(eq(users.role, 'admin')).get();
  return Boolean(row);
}

/** 把数据库行转换成对外的 SessionUser；需要统计通行密钥数量 */
export function toSessionUser(row: UserRow, passkeyCount?: number): SessionUser {
  const db = getDb();
  const count =
    passkeyCount ??
    db.select({ id: passkeys.id }).from(passkeys).where(eq(passkeys.userId, row.id)).all().length;

  return {
    id: row.id,
    username: row.username,
    email: row.email,
    displayName: row.displayName,
    role: row.role,
    status: row.status,
    totpEnabled: row.totpEnabled,
    passkeyCount: count,
    avatarUrl: row.avatarUrl,
    createdAt: row.createdAt.toISOString(),
    lastLoginAt: row.lastLoginAt ? row.lastLoginAt.toISOString() : null,
  };
}

/** 统计用户已用的存储容量（所有存储配置的 usedBytes 之和） */
export function userUsedBytes(userId: number): number {
  const db = getDb();
  const rows = db.select({ used: storages.usedBytes }).from(storages).where(eq(storages.userId, userId)).all();
  return rows.reduce((sum, r) => sum + (r.used ?? 0), 0);
}

/** 按用户名或邮箱查找用户（登录时两者都允许） */
export function findUserByLogin(login: string): UserRow | undefined {
  const db = getDb();
  return db
    .select()
    .from(users)
    .where(or(eq(users.username, login), eq(users.email, login)))
    .get();
}
