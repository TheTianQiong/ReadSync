import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { and, asc, count, desc, eq, gte, inArray, like, lte, or, sql, type AnyColumn, type SQL } from 'drizzle-orm';
import {
  VERSION,
  type AdminUserSummary,
  type AuditLogEntry,
  type InviteCode,
  type ListAuditQuery,
  type ListUsersQuery,
  type Paginated,
  type SystemInfo,
} from '@readsync/shared';
import { loadConfig } from '../../config.js';
import { hashPassword, md5Hex } from '../../crypto/password.js';
import { getDb } from '../../db/index.js';
import {
  auditLogs,
  books,
  emailCodes,
  inviteCodes,
  passkeys,
  plugins,
  readingPlatforms,
  readingSessions,
  recoveryCodes,
  sessions,
  storages,
  syncEntries,
  syncTokens,
  users,
  type AuditLogRow,
  type InviteCodeRow,
  type UserRow,
} from '../../db/schema.js';
import { badRequest, notFound } from '../../errors.js';
import { getPublicKeyFingerprintSafe } from '../../lib/settings.js';

/**
 * 管理后台的业务逻辑。
 *
 * 抽到 service.ts 是因为这些查询（用户 + 统计、级联删除、磁盘体积统计）
 * 逻辑较重，路由文件只负责参数校验与响应封装，便于分别阅读与测试。
 */

/* ------------------------------ 用户管理 ------------------------------ */

interface UserStats {
  storageCount: number;
  bookCount: number;
  usedBytes: number;
  passkeyCount: number;
}

const EMPTY_STATS: UserStats = { storageCount: 0, bookCount: 0, usedBytes: 0, passkeyCount: 0 };

/**
 * 批量统计用户的书/存储/容量/通行密钥数量。
 *
 * 用「一次分组聚合 + 内存归并」而不是逐个用户查询：管理后台列表一页 20 条，
 * N+1 查询在 SQLite 上虽不致命，但毫无必要。
 */
function loadUserStats(ids: number[]): Map<number, UserStats> {
  const map = new Map<number, UserStats>();
  for (const id of ids) map.set(id, { ...EMPTY_STATS });
  if (ids.length === 0) return map;

  const db = getDb();

  const storageRows = db
    .select({
      userId: storages.userId,
      total: count(),
      used: sql<number>`coalesce(sum(${storages.usedBytes}), 0)`,
    })
    .from(storages)
    .where(inArray(storages.userId, ids))
    .groupBy(storages.userId)
    .all();
  for (const row of storageRows) {
    const stats = map.get(row.userId);
    if (stats) {
      stats.storageCount = row.total;
      stats.usedBytes = Number(row.used ?? 0);
    }
  }

  const bookRows = db
    .select({ userId: books.ownerId, total: count() })
    .from(books)
    .where(inArray(books.ownerId, ids))
    .groupBy(books.ownerId)
    .all();
  for (const row of bookRows) {
    const stats = map.get(row.userId);
    if (stats) stats.bookCount = row.total;
  }

  const passkeyRows = db
    .select({ userId: passkeys.userId, total: count() })
    .from(passkeys)
    .where(inArray(passkeys.userId, ids))
    .groupBy(passkeys.userId)
    .all();
  for (const row of passkeyRows) {
    const stats = map.get(row.userId);
    if (stats) stats.passkeyCount = row.total;
  }

  return map;
}

/** 数据库行 → 管理后台用户摘要 */
export function toAdminUserSummary(row: UserRow, stats: UserStats): AdminUserSummary {
  return {
    id: row.id,
    username: row.username,
    email: row.email,
    displayName: row.displayName,
    role: row.role,
    status: row.status,
    totpEnabled: row.totpEnabled,
    passkeyCount: stats.passkeyCount,
    storageCount: stats.storageCount,
    bookCount: stats.bookCount,
    usedBytes: stats.usedBytes,
    createdAt: row.createdAt.toISOString(),
    lastLoginAt: row.lastLoginAt ? row.lastLoginAt.toISOString() : null,
  };
}

/** 单个用户摘要；不存在时返回 null（由路由决定抛 404 还是别的语义） */
export function getAdminUserSummary(userId: number): AdminUserSummary | null {
  const db = getDb();
  const row = db.select().from(users).where(eq(users.id, userId)).get();
  if (!row) return null;
  const stats = loadUserStats([userId]).get(userId) ?? EMPTY_STATS;
  return toAdminUserSummary(row, stats);
}

/** 分页查询用户列表，支持关键词、角色、状态过滤与排序 */
export function listAdminUsers(query: ListUsersQuery): Paginated<AdminUserSummary> {
  const db = getDb();

  const conditions: SQL[] = [];
  if (query.q) {
    const pattern = `%${query.q}%`;
    conditions.push(
      or(like(users.username, pattern), like(users.email, pattern), like(users.displayName, pattern))!,
    );
  }
  if (query.role) conditions.push(eq(users.role, query.role));
  if (query.status) conditions.push(eq(users.status, query.status));
  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const sortColumns: Record<ListUsersQuery['sortBy'], AnyColumn> = {
    username: users.username,
    email: users.email,
    createdAt: users.createdAt,
    lastLoginAt: users.lastLoginAt,
  };
  const column = sortColumns[query.sortBy];
  const orderBy = query.sortOrder === 'asc' ? asc(column) : desc(column);

  const total = db.select({ value: count() }).from(users).where(where).get()?.value ?? 0;
  const rows = db
    .select()
    .from(users)
    .where(where)
    .orderBy(orderBy)
    .limit(query.pageSize)
    .offset((query.page - 1) * query.pageSize)
    .all();

  const stats = loadUserStats(rows.map((r) => r.id));
  return {
    items: rows.map((row) => toAdminUserSummary(row, stats.get(row.id) ?? EMPTY_STATS)),
    total,
    page: query.page,
    pageSize: query.pageSize,
    totalPages: Math.ceil(total / query.pageSize),
  };
}

/**
 * 删除用户及其全部数据。
 *
 * 虽然外键都声明了 onDelete: cascade，这里仍显式按依赖顺序删除：
 * books.storage_id 对 storages 是 onDelete: restrict，如果 SQLite 先级联删
 * storages 再删 books，restrict 约束会直接让整个删除失败。显式「先删书、
 * 再删存储」可以绕开这个问题，同时把删除范围写清楚，避免将来新增表时
 * 误以为 cascade 覆盖了一切。
 */
export function deleteUserCascade(userId: number): UserRow {
  const db = getDb();
  const row = db.select().from(users).where(eq(users.id, userId)).get();
  if (!row) throw notFound('用户不存在');

  db.transaction((tx) => {
    tx.delete(books).where(eq(books.ownerId, userId)).run(); // 级联删除 book_versions
    tx.delete(storages).where(eq(storages.userId, userId)).run();
    tx.delete(syncEntries).where(eq(syncEntries.userId, userId)).run();
    tx.delete(readingSessions).where(eq(readingSessions.userId, userId)).run();
    tx.delete(readingPlatforms).where(eq(readingPlatforms.userId, userId)).run();
    tx.delete(syncTokens).where(eq(syncTokens.userId, userId)).run();
    tx.delete(sessions).where(eq(sessions.userId, userId)).run();
    tx.delete(passkeys).where(eq(passkeys.userId, userId)).run();
    tx.delete(recoveryCodes).where(eq(recoveryCodes.userId, userId)).run();
    tx.delete(inviteCodes).where(eq(inviteCodes.createdBy, userId)).run();
    // 邮箱验证码按邮箱而非 userId 关联，顺手清理，避免遗留可用的重置码
    tx.delete(emailCodes).where(eq(emailCodes.email, row.email)).run();
    tx.delete(users).where(eq(users.id, userId)).run();
  });

  return row;
}

/**
 * 管理员重置密码。
 *
 * 自增 tokenVersion 是这里的关键：管理员改密往往发生在账号被盗场景，
 * 必须在改密的同时把该用户所有已签发的 access token 立即作废（认证中间件
 * 每次请求都会比对 tokenVersion），否则旧令牌还能继续用到过期。
 */
export async function resetUserPassword(
  userId: number,
  newPassword: string,
  resetKosyncKey: boolean,
): Promise<void> {
  const db = getDb();
  const passwordHash = await hashPassword(newPassword);

  db.update(users)
    .set({
      passwordHash,
      // KOSync 客户端发的是 md5(密码)，重置主密码时必须同步，否则旧 md5 仍能同步
      ...(resetKosyncKey ? { kosyncKey: md5Hex(newPassword) } : {}),
      tokenVersion: sql`${users.tokenVersion} + 1`,
      updatedAt: new Date(),
    })
    .where(eq(users.id, userId))
    .run();
}

/* ------------------------------ 邀请码 ------------------------------ */

/** 邀请码行 → 对外 DTO，exhausted 由用尽/过期两种失效方式共同决定 */
export function toInviteCode(row: InviteCodeRow): InviteCode {
  const exhaustedByUse = row.maxUses > 0 && row.usedCount >= row.maxUses;
  const exhaustedByTime = row.expiresAt !== null && row.expiresAt.getTime() <= Date.now();
  return {
    id: row.id,
    code: row.code,
    maxUses: row.maxUses,
    usedCount: row.usedCount,
    expiresAt: row.expiresAt ? row.expiresAt.toISOString() : null,
    note: row.note,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    exhausted: exhaustedByUse || exhaustedByTime,
  };
}

/** 列出全部邀请码（数量天然很小，不做分页），新创建的排前面 */
export function listInviteCodes(): InviteCode[] {
  const db = getDb();
  return db.select().from(inviteCodes).orderBy(desc(inviteCodes.createdAt)).all().map(toInviteCode);
}

/** 判断邀请码是否已存在（创建前查重，避免撞唯一索引报 500） */
export function inviteCodeExists(code: string): boolean {
  const db = getDb();
  return Boolean(db.select({ id: inviteCodes.id }).from(inviteCodes).where(eq(inviteCodes.code, code)).get());
}

/* ------------------------------ 审计日志 ------------------------------ */

/** 分页查询审计日志 */
export function listAuditLogs(query: ListAuditQuery): Paginated<AuditLogEntry> {
  const db = getDb();

  const conditions: SQL[] = [];
  if (query.action) conditions.push(eq(auditLogs.action, query.action));
  if (query.userId) conditions.push(eq(auditLogs.userId, query.userId));
  if (query.from) conditions.push(gte(auditLogs.createdAt, parseDate(query.from, 'from')));
  if (query.to) conditions.push(lte(auditLogs.createdAt, parseDate(query.to, 'to')));
  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const total = db.select({ value: count() }).from(auditLogs).where(where).get()?.value ?? 0;
  const rows = db
    .select()
    .from(auditLogs)
    .where(where)
    .orderBy(desc(auditLogs.createdAt))
    .limit(query.pageSize)
    .offset((query.page - 1) * query.pageSize)
    .all();

  return {
    items: rows.map(toAuditLogEntry),
    total,
    page: query.page,
    pageSize: query.pageSize,
    totalPages: Math.ceil(total / query.pageSize),
  };
}

function toAuditLogEntry(row: AuditLogRow): AuditLogEntry {
  return {
    id: row.id,
    userId: row.userId,
    username: row.username,
    action: row.action,
    target: row.target,
    ip: row.ip,
    userAgent: row.userAgent,
    meta: row.meta ?? null,
    success: row.success,
    createdAt: row.createdAt.toISOString(),
  };
}

function parseDate(value: string, field: string): Date {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw badRequest(`${field} 不是合法的时间`);
  }
  return date;
}

/* ------------------------------ 系统信息 ------------------------------ */

/** 递归统计文件/目录体积，返回字节数 */
async function pathSize(target: string): Promise<number> {
  const stack: string[] = [target];
  let total = 0;

  while (stack.length > 0) {
    const current = stack.pop()!;
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      // 不是目录（或不存在）：按文件处理，不存在则忽略
      total += await fileSize(current);
      continue;
    }

    for (const entry of entries) {
      const child = join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(child);
      } else if (entry.isFile()) {
        total += await fileSize(child);
      }
      // 符号链接跳过：避免随链接跑出数据目录或形成环
    }
  }

  return total;
}

async function fileSize(file: string): Promise<number> {
  try {
    return (await stat(file)).size;
  } catch {
    return 0;
  }
}

/** 汇总系统信息（版本、计数、磁盘占用、公钥指纹） */
export async function computeSystemInfo(): Promise<SystemInfo> {
  const db = getDb();
  const config = loadConfig();

  // 数据库是 WAL 模式，真实占用 = 主库 + -wal + -shm，只算主文件会明显偏小
  const databaseSize =
    (await fileSize(config.databaseFile)) +
    (await fileSize(`${config.databaseFile}-wal`)) +
    (await fileSize(`${config.databaseFile}-shm`));

  return {
    version: VERSION,
    nodeVersion: process.version,
    platform: `${process.platform} ${process.arch}`,
    uptimeSeconds: Math.floor(process.uptime()),
    databaseSize,
    dataDirSize: await pathSize(config.dataDir),
    counts: {
      users: db.select({ value: count() }).from(users).get()?.value ?? 0,
      books: db.select({ value: count() }).from(books).get()?.value ?? 0,
      storages: db.select({ value: count() }).from(storages).get()?.value ?? 0,
      plugins: db.select({ value: count() }).from(plugins).get()?.value ?? 0,
      syncEntries: db.select({ value: count() }).from(syncEntries).get()?.value ?? 0,
    },
    publicKeyFingerprint: getPublicKeyFingerprintSafe(),
  };
}
