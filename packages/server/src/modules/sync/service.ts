import { and, count, desc, eq, sql } from 'drizzle-orm';
import type {
  Paginated,
  PaginationQuery,
  SyncConflictStrategy,
  SyncEntry,
  SyncEntryInput,
} from '@readsync/shared';
import { getDb } from '../../db/index.js';
import { books, readingSessions, syncEntries, users, type SyncEntryRow } from '../../db/schema.js';
import { getModuleLogger } from '../../logger.js';

/**
 * 同步模块的核心业务逻辑，被两套协议共用：
 *  - KOSync 兼容端点（modules/sync/kosync.ts）
 *  - ReadSync 统一同步接口（modules/sync/routes.ts）
 *
 * 之所以把逻辑抽到这里而不是写在各自路由里，是因为两套协议虽然字段名与响应格式
 * 不同（KOSync 用 document/device_id/Unix 秒，统一接口用 deviceId/RFC3339），
 * 但「写入哪张表、怎么判冲突、怎么换算精度、怎么累计时长」必须完全一致，
 * 否则同一本书在两种客户端上会互相覆盖出错误结果。
 */

const log = getModuleLogger('sync');

/** 用户未设置偏好时区时的兜底值（项目主要面向中文用户） */
const DEFAULT_TIMEZONE = 'Asia/Shanghai';

/** 进度百分比的放大倍数：0-1 的小数 × 10000 存成整数 */
const PERCENTAGE_SCALE = 10000;

export interface UpsertProgressResult {
  /** 服务端是否接受了本次写入；false 表示服务端已有更新的进度 */
  accepted: boolean;
  /** 服务端当前最新条目（无论是否接受，都是写完/冲突后的权威值） */
  current: SyncEntry;
}

/* ------------------------------------------------------------------ *
 * 读取
 * ------------------------------------------------------------------ */

/** 把数据库行转换成对外的 SyncEntry（percentage 还原成 0-1 小数） */
export function toSyncEntry(row: SyncEntryRow): SyncEntry {
  return {
    id: row.id,
    userId: row.userId,
    document: row.document,
    title: row.title,
    progress: row.progress,
    // 库里存的是放大 10000 倍后的整数，对外一律还原成 0-1，与 KOSync 语义对齐
    percentage: row.percentage / PERCENTAGE_SCALE,
    platform: row.platform,
    device: row.device,
    deviceId: row.deviceId,
    updatedAt: row.updatedAt.toISOString(),
    clientTime: row.clientTime ? row.clientTime.toISOString() : null,
  };
}

/** 读取某文档的同步条目；不存在返回 null（调用方决定是 404 还是空对象） */
export function getProgress(userId: number, document: string): SyncEntry | null {
  const row = findByDocument(userId, document);
  return row ? toSyncEntry(row) : null;
}

/** 分页列出当前用户的全部同步条目，按最近更新倒序（前端列表默认顺序） */
export function listEntries(userId: number, pagination: PaginationQuery): Paginated<SyncEntry> {
  const db = getDb();
  const { page, pageSize } = pagination;

  const total = db.select({ value: count() }).from(syncEntries).where(eq(syncEntries.userId, userId)).get()?.value ?? 0;

  const rows = db
    .select()
    .from(syncEntries)
    .where(eq(syncEntries.userId, userId))
    .orderBy(desc(syncEntries.updatedAt))
    .limit(pageSize)
    .offset((page - 1) * pageSize)
    .all();

  return {
    items: rows.map(toSyncEntry),
    total,
    page,
    pageSize,
    totalPages: Math.ceil(total / pageSize),
  };
}

/** 删除某文档的同步记录；返回是否真的删掉了（路由据此决定要不要 404） */
export function deleteProgress(userId: number, document: string): boolean {
  const result = getDb()
    .delete(syncEntries)
    .where(and(eq(syncEntries.userId, userId), eq(syncEntries.document, document)))
    .run();
  return result.changes > 0;
}

/* ------------------------------------------------------------------ *
 * 写入
 * ------------------------------------------------------------------ */

/**
 * 写入/更新一条阅读进度。
 *
 * 冲突策略：
 *  - latest-wins（默认）：比较客户端上报时间与库里的 updatedAt，服务端更新则拒绝写入，
 *    把服务端条目回给客户端，由客户端决定是否覆盖。离线补传场景必须用它，
 *    否则一台设备的旧进度会覆盖另一台设备的新进度。
 *  - client-wins：无条件写入（客户端明确要求以本地为准）。
 *  - server-wins：只要服务端已有记录就拒绝（只允许首次写入）。
 */
export function upsertProgress(
  userId: number,
  input: SyncEntryInput,
  conflictStrategy: SyncConflictStrategy = 'latest-wins',
): UpsertProgressResult {
  const db = getDb();
  const now = new Date();

  // clientTime 缺失时用服务端当前时间：KOSync 协议本身不上报客户端时间，
  // 此时「最新写入即最新进度」是唯一合理的解释。
  const clientDate = input.clientTime ? new Date(input.clientTime) : now;
  const clientMs = Number.isNaN(clientDate.getTime()) ? now.getTime() : clientDate.getTime();

  const existing = findByDocument(userId, input.document);

  if (existing) {
    const serverMs = existing.updatedAt.getTime();
    if (conflictStrategy === 'server-wins' || (conflictStrategy === 'latest-wins' && serverMs > clientMs)) {
      return { accepted: false, current: toSyncEntry(existing) };
    }
  }

  // 浮点误差说明：0.1 + 0.2 这类小数在 IEEE754 下无法精确表示，
  // 若直接以 REAL 存 0-1 的百分比，多设备反复比较会出现 0.30000000000000004 > 0.3
  // 之类的伪冲突。统一放大 10000 倍取整（0-10000）后按整数存取，
  // 既保留了万分之一的分辨率，又保证比较与幂等写入的确定性。
  const scaledPercentage = clamp(Math.round(input.percentage * PERCENTAGE_SCALE), 0, PERCENTAGE_SCALE);

  const bookId = resolveBookId(userId, input.document, input.title) ?? existing?.bookId ?? null;

  const written = db
    .insert(syncEntries)
    .values({
      userId,
      document: input.document,
      title: input.title ?? null,
      progress: input.progress,
      percentage: scaledPercentage,
      platform: input.platform,
      device: input.device,
      deviceId: input.deviceId,
      bookId,
      clientTime: input.clientTime ? clientDate : null,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [syncEntries.userId, syncEntries.document],
      set: {
        // 客户端没带 title 时保留库里已有的，避免统一接口把 KOSync 写入的标题抹掉
        title: input.title ?? existing?.title ?? null,
        progress: input.progress,
        percentage: scaledPercentage,
        platform: input.platform,
        device: input.device,
        deviceId: input.deviceId,
        bookId,
        clientTime: input.clientTime ? clientDate : null,
        updatedAt: now,
      },
    })
    .returning()
    .get();

  if (!written) {
    // 理论上不会发生（SQLite 单写者），真出现时宁可让上层 500 也不要返回假成功
    throw new Error(`同步条目写入失败: ${input.document}`);
  }

  // 只有真正写入时才累计阅读时长：被冲突拒绝的重复补传若也累加，会把时长翻倍。
  accumulateReadingSeconds(userId, input, bookId, scaledPercentage, now);
  updateBookProgress(userId, bookId, scaledPercentage, input.readingSeconds, now);

  log.debug(
    { userId, document: input.document, platform: input.platform, accepted: true },
    '同步进度已写入',
  );

  return { accepted: true, current: toSyncEntry(written) };
}

/* ------------------------------------------------------------------ *
 * 内部工具
 * ------------------------------------------------------------------ */

function findByDocument(userId: number, document: string): SyncEntryRow | undefined {
  return getDb()
    .select()
    .from(syncEntries)
    .where(and(eq(syncEntries.userId, userId), eq(syncEntries.document, document)))
    .get();
}

/**
 * 把 document 关联到书库中的书。
 *
 * KOReader 的 document 通常是文件内容的部分 MD5，因此优先按 MD5 精确匹配；
 * 其他客户端可能只传一个自定义 id，此时退化为按标题匹配（同名书取任意一本，
 * 因为同步接口无法知道客户端指的是哪个版本）。匹配不上就不关联，不影响进度写入。
 */
function resolveBookId(userId: number, document: string, title: string | undefined): number | null {
  const db = getDb();

  const byMd5 = db
    .select({ id: books.id })
    .from(books)
    .where(and(eq(books.ownerId, userId), eq(books.md5, document.toLowerCase())))
    .get();
  if (byMd5) return byMd5.id;

  if (title) {
    const byTitle = db
      .select({ id: books.id })
      .from(books)
      .where(and(eq(books.ownerId, userId), eq(books.title, title)))
      .get();
    if (byTitle) return byTitle.id;
  }

  return null;
}

/** 累加到当天的阅读会话；按 (userId, day, platform, device) 聚合，而非每本书一行 */
function accumulateReadingSeconds(
  userId: number,
  input: SyncEntryInput,
  bookId: number | null,
  scaledPercentage: number,
  now: Date,
): void {
  const seconds = input.readingSeconds;
  if (seconds <= 0) return;

  const db = getDb();
  const timeZone = resolveUserTimeZone(userId);
  const { day, hour, weekday } = zonedParts(now, timeZone);
  // 以 0-100 存会话进度（schema 注释：progress_percent），与 books.progressPercent 一致
  const progressPercent = Math.round(scaledPercentage / 100);

  const existing = db
    .select({ id: readingSessions.id })
    .from(readingSessions)
    .where(
      and(
        eq(readingSessions.userId, userId),
        eq(readingSessions.day, day),
        eq(readingSessions.platform, input.platform),
        eq(readingSessions.device, input.device),
      ),
    )
    .get();

  if (existing) {
    db.update(readingSessions)
      .set({
        seconds: sql`${readingSessions.seconds} + ${seconds}`,
        endedAt: now,
        progressPercent,
        // 之前没关联上书籍、这次关联上了就补上
        ...(bookId !== null ? { bookId, document: input.document } : {}),
      })
      .where(eq(readingSessions.id, existing.id))
      .run();
    return;
  }

  db.insert(readingSessions)
    .values({
      userId,
      bookId,
      document: input.document,
      platform: input.platform,
      device: input.device,
      seconds,
      day,
      hour,
      weekday,
      progressPercent,
      startedAt: now,
      endedAt: now,
      createdAt: now,
    })
    .run();
}

/** 把进度与时长回写到关联书籍的冗余字段（书库列表排序依赖它们） */
function updateBookProgress(
  userId: number,
  bookId: number | null,
  scaledPercentage: number,
  readingSeconds: number,
  now: Date,
): void {
  if (bookId === null) return;

  const db = getDb();
  db.update(books)
    .set({
      // books.progress_percent 是 0-100 的整数，与 sync_entries 的 0-10000 不同
      progressPercent: Math.round(scaledPercentage / 100),
      lastReadAt: now,
      updatedAt: now,
      ...(readingSeconds > 0
        ? { totalReadingSeconds: sql`${books.totalReadingSeconds} + ${readingSeconds}` }
        : {}),
    })
    .where(and(eq(books.id, bookId), eq(books.ownerId, userId)))
    .run();
}

/**
 * 取用户偏好时区。
 *
 * 服务器所在时区未必等于用户时区（例如 Docker 容器默认 UTC、用户在东八区），
 * 因此绝不能用本地时区的 getHours()/getDate() 来归集「今天」——
 * 那会让 UTC 16:00 之后的阅读被算到第二天，热力图与连续天数都会错。
 */
function resolveUserTimeZone(userId: number): string {
  const db = getDb();
  const row = db.select({ preferences: users.preferences }).from(users).where(eq(users.id, userId)).get();
  const prefs = row?.preferences as Record<string, unknown> | null | undefined;
  const timeZone = prefs?.timezone;

  if (typeof timeZone !== 'string' || timeZone.length === 0) return DEFAULT_TIMEZONE;

  try {
    // 无效时区会让 Intl 抛 RangeError，先探测一次再缓存
    getZonedFormatter(timeZone);
    return timeZone;
  } catch {
    return DEFAULT_TIMEZONE;
  }
}

/** 星期缩写 → 0-6（0=周日），与 reading_sessions.weekday 的约定一致 */
const WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

// Intl.DateTimeFormat 构造开销较大，而同步接口调用频繁，按需缓存
const formatterCache = new Map<string, Intl.DateTimeFormat>();

function getZonedFormatter(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatterCache.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      // h23 保证 0-23 且不会出现 "24"；hour12:false 在部分 ICU 版本会给出 24
      hourCycle: 'h23',
      weekday: 'short',
    });
    formatterCache.set(timeZone, formatter);
  }
  return formatter;
}

/**
 * 按指定时区把某一时刻拆成 day / hour / weekday。
 * 用 Intl 的 formatToParts 而非 Date 的 getFullYear 等本地方法，
 * 因为后者只能按服务器时区计算（见 resolveUserTimeZone 的说明）。
 */
function zonedParts(date: Date, timeZone: string): { day: string; hour: number; weekday: number } {
  const parts = getZonedFormatter(timeZone).formatToParts(date);
  const pick = (type: Intl.DateTimeFormatPartTypes): string => parts.find((p) => p.type === type)?.value ?? '';

  const hour = Number(pick('hour'));

  return {
    day: `${pick('year')}-${pick('month')}-${pick('day')}`,
    hour: Number.isFinite(hour) && hour >= 0 && hour <= 23 ? hour : 0,
    weekday: WEEKDAY_INDEX[pick('weekday')] ?? 0,
  };
}

function clamp(value: number, min: number, max: number): number {
  if (Number.isNaN(value)) return min;
  return Math.min(max, Math.max(min, value));
}
