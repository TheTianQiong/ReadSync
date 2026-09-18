import { eq } from 'drizzle-orm';
import {
  DASHBOARD_WIDGETS,
  PLATFORM_LABELS,
  dashboardLayoutSchema,
  type DashboardData,
  type DashboardLayout,
  type DashboardWidget,
  type LibraryOverview,
  type Paginated,
  type PlatformDistribution,
  type ReadingHeatmap,
  type ReadingSessionDetail,
  type ReadingStatusSummary,
  type ReadingTimeTrend,
  type StatGranularity,
  type StatsQuery,
  type TimeSeriesPoint,
} from '@readsync/shared';
import { getDb, getRawDb } from '../../db/index.js';
import { users } from '../../db/schema.js';
import { badRequest } from '../../errors.js';
import { getModuleLogger } from '../../logger.js';

/**
 * 阅读统计的聚合查询。
 *
 * 权威数据源是 reading_sessions：写入方（sync 模块）已经按用户时区把会话归集到
 * `day`（YYYY-MM-DD）、并预计算了 `hour` / `weekday`，所以这里的分组聚合
 * **直接使用 day/hour/weekday 字段即可，绝不能再做一次时区换算**，否则会把
 * 已经归一化的日期又搬移一次，出现「跨天错位」。
 *
 * 所有聚合都下推到 SQLite 用原生 SQL 完成（getRawDb），只把聚合结果带回 JS；
 * 唯一回 JS 处理的是「补齐缺失时间点」和「连续天数」这类需要序列语义的逻辑。
 * 所有外部输入一律用 `?` 绑定，绝不拼接字符串。
 */

const log = getModuleLogger('stats');

/** 用户未设置时区时的缺省值（中文用户为主） */
const DEFAULT_TIMEZONE = 'Asia/Shanghai';

/** 生成连续时间轴时的桶数量上限，防止用户传入 from=1970 造成长时间循环 */
const MAX_BUCKETS = 5000;

/** 计算连续阅读天数时最多回溯的天数（10 年，远超现实使用场景） */
const MAX_STREAK_LOOKBACK_DAYS = 3661;

/* ------------------------------ 行类型 ------------------------------ */

interface TrendRow {
  bucket: string;
  seconds: number | null;
  bookCount: number | null;
  syncCount: number | null;
}

interface PlatformRow {
  platform: string;
  seconds: number | null;
  bookCount: number | null;
}

interface HeatmapRow {
  weekday: number;
  hour: number;
  seconds: number | null;
}

interface FormatRow {
  format: string;
  count: number | null;
  bytes: number | null;
}

interface StatusRow {
  status: string;
  count: number | null;
}

interface TotalsRow {
  totalBooks: number | null;
  totalBytes: number | null;
}

interface SummaryRow {
  todaySeconds: number | null;
  weekSeconds: number | null;
  monthSeconds: number | null;
  totalSeconds: number | null;
  lastReadAt: number | null;
}

interface CurrentBookRow {
  id: number;
  title: string;
  author: string | null;
  coverUrl: string | null;
  progressPercent: number | null;
  lastReadAt: number | null;
  totalSeconds: number | null;
}

interface SessionRow {
  id: number;
  bookId: number | null;
  bookTitle: string | null;
  platform: string;
  device: string;
  seconds: number | null;
  startedAt: number;
  endedAt: number | null;
  progressPercent: number | null;
}

/* ------------------------------ 工具函数 ------------------------------ */

/** SQLite 的 SUM/COUNT 在无数据时返回 null，统一兜底为 0 */
function num(value: unknown): number {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

/** 把 Date 按指定时区格式化成 YYYY-MM-DD */
function formatDayInTimeZone(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const pick = (type: string): string => parts.find((p) => p.type === type)?.value ?? '';
  return `${pick('year')}-${pick('month')}-${pick('day')}`;
}

/**
 * 校验并回退时区。
 *
 * `users.preferences.timezone` 是用户自由填写的字符串，非法值会让
 * Intl.DateTimeFormat 直接抛异常。这里回退到默认时区而不是让整个统计接口 500，
 * 否则用户改错一次时区就再也打不开首页了。
 */
function safeTimeZone(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0) return DEFAULT_TIMEZONE;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return value;
  } catch {
    log.warn({ timeZone: value }, '用户时区非法，统计按默认时区计算');
    return DEFAULT_TIMEZONE;
  }
}

/** 读取用户的完整偏好对象（不做 schema 校验，缺失字段由调用方兜底） */
function getUserPreferences(userId: number): Record<string, unknown> {
  const row = getDb()
    .select({ preferences: users.preferences })
    .from(users)
    .where(eq(users.id, userId))
    .get();
  const prefs = row?.preferences;
  return prefs && typeof prefs === 'object' ? (prefs as Record<string, unknown>) : {};
}

/** 用户时区（缺省 Asia/Shanghai） */
export function getUserTimezone(userId: number): string {
  return safeTimeZone(getUserPreferences(userId).timezone);
}

/**
 * 当前日期（用户时区）。
 *
 * 必须用 Intl 配合 timeZone 求，**不能用服务器本地时间的 getDate()/getMonth()**：
 * 服务器可能部署在 UTC 或任意区域，而「今日/本周/本月」是用户视角的概念，
 * 服务器时区与用户不一致时会算错一整天的边界。
 */
export function todayInTimezone(timeZone: string): string {
  return formatDayInTimeZone(new Date(), timeZone);
}

/** 把 YYYY-MM-DD 解析成 UTC 毫秒（仅用于日期运算，不涉及任何时区语义） */
function dayToUtcMillis(day: string): number {
  const [y, m, d] = day.split('-').map(Number);
  return Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1);
}

/** UTC 毫秒 → YYYY-MM-DD */
function utcMillisToDay(ms: number): string {
  const dt = new Date(ms);
  const y = dt.getUTCFullYear();
  const m = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const d = String(dt.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** 日期加减天数（纯日历运算，用 UTC 避免夏令时导致的 23/25 小时问题） */
function addDays(day: string, delta: number): string {
  return utcMillisToDay(dayToUtcMillis(day) + delta * 86_400_000);
}

/** 日期加减月份（锚定到 1 号，避免「1 月 31 日 + 1 月 = 3 月 3 日」这类溢出） */
function addMonths(day: string, delta: number): string {
  const [y, m] = day.split('-').map(Number);
  const dt = new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1 + delta, 1));
  const yy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, '0');
  return `${yy}-${mm}-01`;
}

/**
 * 某日期所在周的周一。
 *
 * JS 的 `getUTCDay()` 里 0 是周日，而中文用户习惯以**周一**为一周起点，
 * 所以先把 0（周日）映射成 6、周一映射成 0：`(w + 6) % 7` 就是「距离本周一的天数」。
 * 不换算的话周日会被算进下一周，导致「本周阅读时长」和连续天数整体错位。
 */
export function startOfWeek(day: string): string {
  const w = new Date(dayToUtcMillis(day)).getUTCDay();
  return addDays(day, -((w + 6) % 7));
}

/** 起始月 */
function startOfMonth(day: string): string {
  return `${day.slice(0, 7)}-01`;
}

/** 起始年 */
function startOfYear(day: string): string {
  return `${day.slice(0, 4)}-01-01`;
}

/** 区间内的日历天数（含首尾），用于计算日均 */
function daysInclusive(from: string, to: string): number {
  const diff = Math.round((dayToUtcMillis(to) - dayToUtcMillis(from)) / 86_400_000) + 1;
  return Math.max(1, diff);
}

/**
 * 把查询参数里的 from/to 归一成用户时区下的 YYYY-MM-DD。
 * - 纯日期（YYYY-MM-DD）：用户写的就是他想要的日期，直接字面采用；
 * - 带时间的 RFC3339：按用户时区换算，避免 UTC 午夜被算成前一天。
 */
function normalizeDay(value: string, timeZone: string): string | null {
  const trimmed = value.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed;
  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) return null;
  return formatDayInTimeZone(parsed, timeZone);
}

/** 未显式给 from/to 时按粒度给一个合理默认区间，保证图表开箱有内容 */
function defaultRange(granularity: StatGranularity, today: string): { from: string; to: string } {
  switch (granularity) {
    case 'day':
      return { from: addDays(today, -29), to: today };
    case 'week':
      return { from: addDays(startOfWeek(today), -11 * 7), to: today };
    case 'month':
      return { from: addMonths(startOfMonth(today), -11), to: today };
    case 'year':
      return { from: `${Number(today.slice(0, 4)) - 4}-01-01`, to: today };
  }
}

interface DayRange {
  from: string;
  to: string;
}

function resolveRange(query: StatsQuery, timeZone: string, today: string): DayRange {
  const fallback = defaultRange(query.granularity, today);
  const from = query.from ? normalizeDay(query.from, timeZone) : fallback.from;
  const to = query.to ? normalizeDay(query.to, timeZone) : fallback.to;
  if (!from || !to) throw badRequest('from/to 不是有效的日期');
  if (from > to) throw badRequest('from 不能晚于 to');
  return { from, to };
}

/* --------------------------- 分桶（趋势图） --------------------------- */

/** SQL 侧的桶表达式：直接产出该桶的起始日期，省得回 JS 再算一遍 */
function bucketExpr(granularity: StatGranularity): string {
  switch (granularity) {
    case 'day':
      return 's.day';
    case 'week':
      // (strftime('%w') + 6) % 7 = 距本周一的天数，见 startOfWeek 的说明
      return "date(s.day, '-' || ((CAST(strftime('%w', s.day) AS INTEGER) + 6) % 7) || ' days')";
    case 'month':
      return "substr(s.day, 1, 7) || '-01'";
    case 'year':
      return "substr(s.day, 1, 4) || '-01-01'";
  }
}

/** 把日期对齐到所在桶的起始日 */
function alignToBucket(day: string, granularity: StatGranularity): string {
  switch (granularity) {
    case 'day':
      return day;
    case 'week':
      return startOfWeek(day);
    case 'month':
      return startOfMonth(day);
    case 'year':
      return startOfYear(day);
  }
}

/** 下一个桶的起始日 */
function nextBucket(day: string, granularity: StatGranularity): string {
  switch (granularity) {
    case 'day':
      return addDays(day, 1);
    case 'week':
      return addDays(day, 7);
    case 'month':
      return addMonths(day, 1);
    case 'year':
      return `${Number(day.slice(0, 4)) + 1}-01-01`;
  }
}

/** 生成连续的桶序列：图表时间轴不能有断点，否则折线会跨过缺失日直接相连 */
function generateBuckets(fromAligned: string, to: string, granularity: StatGranularity): string[] {
  const buckets: string[] = [];
  let cursor = fromAligned;
  while (cursor <= to && buckets.length < MAX_BUCKETS) {
    buckets.push(cursor);
    cursor = nextBucket(cursor, granularity);
  }
  if (buckets.length === 0) buckets.push(fromAligned);
  return buckets;
}

/* ------------------------------ 过滤条件 ------------------------------ */

interface SessionFilters {
  from?: string | undefined;
  to?: string | undefined;
  platform?: string | undefined;
  bookId?: number | undefined;
  weekday?: number | undefined;
  hour?: number | undefined;
}

/**
 * 组装 reading_sessions 的 WHERE 子句。
 * 全部用占位符绑定，返回值里的 params 与 clause 顺序严格对应。
 */
function buildSessionWhere(userId: number, filters: SessionFilters): { clause: string; params: unknown[] } {
  const conditions = ['s.user_id = ?'];
  const params: unknown[] = [userId];

  if (filters.from) {
    conditions.push('s.day >= ?');
    params.push(filters.from);
  }
  if (filters.to) {
    conditions.push('s.day <= ?');
    params.push(filters.to);
  }
  if (filters.platform) {
    conditions.push('s.platform = ?');
    params.push(filters.platform);
  }
  if (filters.bookId !== undefined) {
    conditions.push('s.book_id = ?');
    params.push(filters.bookId);
  }
  if (filters.weekday !== undefined) {
    conditions.push('s.weekday = ?');
    params.push(filters.weekday);
  }
  if (filters.hour !== undefined) {
    conditions.push('s.hour = ?');
    params.push(filters.hour);
  }

  return { clause: conditions.join(' AND '), params };
}

/* ------------------------------ 1. 趋势 ------------------------------ */

export function getReadingTimeTrend(
  userId: number,
  query: StatsQuery,
  timeZone: string,
  today: string,
): ReadingTimeTrend {
  const { from, to } = resolveRange(query, timeZone, today);
  const granularity = query.granularity;

  // 先对齐到桶起点，再生成连续序列；SQL 侧用同一套桶表达式保证 key 完全一致
  const buckets = generateBuckets(alignToBucket(from, granularity), to, granularity);

  const { clause, params } = buildSessionWhere(userId, {
    from,
    to,
    platform: query.platform,
    bookId: query.bookId,
  });

  // syncCount 用会话行数近似：每一行都对应一次携带时长上报，等价于该桶内的同步次数
  const rows = getRawDb()
    .prepare(
      `SELECT ${bucketExpr(granularity)} AS bucket,
              SUM(s.seconds) AS seconds,
              COUNT(DISTINCT s.book_id) AS bookCount,
              COUNT(*) AS syncCount
         FROM reading_sessions s
        WHERE ${clause}
        GROUP BY bucket`,
    )
    .all(...params) as unknown as TrendRow[];

  const byBucket = new Map<string, TrendRow>();
  for (const row of rows) byBucket.set(String(row.bucket), row);

  const points: TimeSeriesPoint[] = buckets.map((bucket) => {
    const row = byBucket.get(bucket);
    return {
      date: bucket,
      seconds: num(row?.seconds),
      bookCount: num(row?.bookCount),
      syncCount: num(row?.syncCount),
    };
  });

  const totalSeconds = points.reduce((sum, point) => sum + point.seconds, 0);
  // averageSeconds 语义是「日均」，所以分母用日历天数而非桶数（周/月粒度下桶数会小很多）
  const averageSeconds = Math.round(totalSeconds / daysInclusive(from, to));

  return { granularity, points, totalSeconds, averageSeconds };
}

/* --------------------------- 2. 平台分布 --------------------------- */

/** 平台显示名：内置平台 → 用户自定义 → 原始 id */
function resolvePlatformLabels(userId: number): Map<string, string> {
  const rows = getRawDb()
    .prepare('SELECT platform_id AS platformId, label FROM reading_platforms WHERE user_id = ?')
    .all(userId) as unknown as Array<{ platformId: string; label: string }>;

  const custom = new Map<string, string>();
  for (const row of rows) custom.set(row.platformId, row.label);
  return custom;
}

export function getPlatformDistribution(
  userId: number,
  query: StatsQuery,
  timeZone: string,
  today: string,
): PlatformDistribution {
  const filters: SessionFilters = {
    platform: query.platform,
    bookId: query.bookId,
  };
  // 平台分布默认看全部历史（不传 from/to 时不做日期限制），更能反映长期使用习惯
  if (query.from) filters.from = normalizeDay(query.from, timeZone) ?? undefined;
  if (query.to) filters.to = normalizeDay(query.to, timeZone) ?? undefined;

  const { clause, params } = buildSessionWhere(userId, filters);

  const rows = getRawDb()
    .prepare(
      `SELECT s.platform AS platform,
              SUM(s.seconds) AS seconds,
              COUNT(DISTINCT s.book_id) AS bookCount
         FROM reading_sessions s
        WHERE ${clause}
        GROUP BY s.platform
        ORDER BY seconds DESC`,
    )
    .all(...params) as unknown as PlatformRow[];

  const customLabels = resolvePlatformLabels(userId);
  const totalSeconds = rows.reduce((sum, row) => sum + num(row.seconds), 0);

  const items = rows.map((row) => {
    const seconds = num(row.seconds);
    const label =
      (PLATFORM_LABELS as Record<string, string>)[row.platform] ??
      customLabels.get(row.platform) ??
      row.platform;
    return {
      platform: row.platform,
      label,
      seconds,
      // 占比保留两位小数，避免前端出现 33.33333333333333% 这种噪声
      percent: totalSeconds > 0 ? Math.round((seconds / totalSeconds) * 10_000) / 100 : 0,
      bookCount: num(row.bookCount),
    };
  });

  return { items, totalSeconds };
}

/* ------------------------------ 3. 热力图 ------------------------------ */

function buildHeatmapCells(rows: HeatmapRow[]): Array<{ weekday: number; hour: number; seconds: number }> {
  const byKey = new Map<string, number>();
  for (const row of rows) byKey.set(`${row.weekday}-${row.hour}`, num(row.seconds));

  // 无数据的格子也必须返回 seconds: 0，前端才能画出完整的 7×24 网格
  const cells: Array<{ weekday: number; hour: number; seconds: number }> = [];
  for (let weekday = 0; weekday < 7; weekday += 1) {
    for (let hour = 0; hour < 24; hour += 1) {
      cells.push({ weekday, hour, seconds: byKey.get(`${weekday}-${hour}`) ?? 0 });
    }
  }
  return cells;
}

export function getReadingHeatmap(
  userId: number,
  query: StatsQuery,
  timeZone: string,
  today: string,
): ReadingHeatmap {
  const filters: SessionFilters = {
    platform: query.platform,
    bookId: query.bookId,
  };
  // 热力图默认统计全部历史：它表达的是「作息习惯」，样本越多越稳定
  if (query.from) filters.from = normalizeDay(query.from, timeZone) ?? undefined;
  if (query.to) filters.to = normalizeDay(query.to, timeZone) ?? undefined;

  const { clause, params } = buildSessionWhere(userId, filters);

  const rows = getRawDb()
    .prepare(
      `SELECT s.weekday AS weekday, s.hour AS hour, SUM(s.seconds) AS seconds
         FROM reading_sessions s
        WHERE ${clause}
        GROUP BY s.weekday, s.hour`,
    )
    .all(...params) as unknown as HeatmapRow[];

  const cells = buildHeatmapCells(rows);
  const maxSeconds = cells.reduce((max, cell) => (cell.seconds > max ? cell.seconds : max), 0);

  return { cells, maxSeconds };
}

/* ---------------------------- 4. 书库概览 ---------------------------- */

export function getLibraryOverview(userId: number): LibraryOverview {
  const raw = getRawDb();

  const totals = raw
    .prepare('SELECT COUNT(*) AS totalBooks, COALESCE(SUM(size), 0) AS totalBytes FROM books WHERE owner_id = ?')
    .get(userId) as unknown as TotalsRow | undefined;

  const formats = raw
    .prepare(
      `SELECT format AS format, COUNT(*) AS count, COALESCE(SUM(size), 0) AS bytes
         FROM books WHERE owner_id = ?
        GROUP BY format
        ORDER BY count DESC`,
    )
    .all(userId) as unknown as FormatRow[];

  const statuses = raw
    .prepare(
      `SELECT reading_status AS status, COUNT(*) AS count
         FROM books WHERE owner_id = ?
        GROUP BY reading_status
        ORDER BY count DESC`,
    )
    .all(userId) as unknown as StatusRow[];

  return {
    totalBooks: num(totals?.totalBooks),
    totalBytes: num(totals?.totalBytes),
    byFormat: formats.map((row) => ({
      format: row.format,
      count: num(row.count),
      bytes: num(row.bytes),
    })),
    byStatus: statuses.map((row) => ({
      status: row.status,
      count: num(row.count),
    })),
  };
}

/* ---------------------------- 5. 阅读状态 ---------------------------- */

/** 连续阅读天数：从今天往前逐日检查 */
function computeStreak(readDays: Set<string>, today: string): number {
  let cursor = today;
  // 允许「今天还没读」时从昨天起算，否则用户每天早上打开首页都会看到 streak 归零
  if (!readDays.has(today)) {
    cursor = addDays(today, -1);
  }

  let streak = 0;
  while (readDays.has(cursor)) {
    streak += 1;
    cursor = addDays(cursor, -1);
  }
  return streak;
}

function queryCurrentBook(userId: number, onlyReadingStatus: boolean): CurrentBookRow | undefined {
  // statusFilter 是内部常量而非用户输入，不涉及注入风险
  const statusFilter = onlyReadingStatus ? "AND b.reading_status = 'reading'" : '';
  // 用最近一次会话时间排序，比依赖 books.last_read_at 更可靠（冗余字段可能未及时更新）
  const row = getRawDb()
    .prepare(
      `SELECT b.id AS id,
              b.title AS title,
              b.author AS author,
              b.cover_url AS coverUrl,
              b.progress_percent AS progressPercent,
              COALESCE((SELECT MAX(s2.started_at) FROM reading_sessions s2
                         WHERE s2.book_id = b.id AND s2.user_id = b.owner_id),
                       b.last_read_at) AS lastReadAt,
              COALESCE((SELECT SUM(s3.seconds) FROM reading_sessions s3
                         WHERE s3.book_id = b.id AND s3.user_id = b.owner_id), 0) AS totalSeconds
         FROM books b
        WHERE b.owner_id = ?
              ${statusFilter}
              AND EXISTS (SELECT 1 FROM reading_sessions sx WHERE sx.book_id = b.id AND sx.user_id = b.owner_id)
        ORDER BY lastReadAt DESC
        LIMIT 1`,
    )
    .get(userId) as unknown as CurrentBookRow | undefined;

  return row ?? undefined;
}

export function getReadingStatusSummary(
  userId: number,
  timeZone: string,
  today: string,
): ReadingStatusSummary {
  const raw = getRawDb();
  const weekStart = startOfWeek(today);
  const monthStart = startOfMonth(today);

  // 一次扫描算出今日/本周/本月/累计；上界一并限制，避免客户端时钟快而写入未来日期导致虚高
  const summary = raw
    .prepare(
      `SELECT
         COALESCE(SUM(CASE WHEN day = ? THEN seconds ELSE 0 END), 0) AS todaySeconds,
         COALESCE(SUM(CASE WHEN day >= ? AND day <= ? THEN seconds ELSE 0 END), 0) AS weekSeconds,
         COALESCE(SUM(CASE WHEN day >= ? AND day <= ? THEN seconds ELSE 0 END), 0) AS monthSeconds,
         COALESCE(SUM(seconds), 0) AS totalSeconds,
         MAX(COALESCE(ended_at, started_at)) AS lastReadAt
       FROM reading_sessions
      WHERE user_id = ?`,
    )
    .get(today, weekStart, today, monthStart, today, userId) as unknown as SummaryRow | undefined;

  // 连续天数需要「哪些天读过」这一序列信息，SQL 不好表达，取 distinct day 回 JS 递推；
  // 只取近 10 年且已按倒序，代价可控
  const dayRows = raw
    .prepare(
      `SELECT DISTINCT day AS day
         FROM reading_sessions
        WHERE user_id = ?
        ORDER BY day DESC
        LIMIT ?`,
    )
    .all(userId, MAX_STREAK_LOOKBACK_DAYS) as unknown as Array<{ day: string }>;
  const readDays = new Set(dayRows.map((row) => row.day));

  const statusRows = raw
    .prepare(
      `SELECT reading_status AS status, COUNT(*) AS count
         FROM books
        WHERE owner_id = ? AND reading_status IN ('reading', 'finished')
        GROUP BY reading_status`,
    )
    .all(userId) as unknown as StatusRow[];
  let readingBookCount = 0;
  let finishedBookCount = 0;
  for (const row of statusRows) {
    if (row.status === 'reading') readingBookCount = num(row.count);
    if (row.status === 'finished') finishedBookCount = num(row.count);
  }

  // 优先取「在读」状态里最近读过的书；用户没维护阅读状态时退化为「最近读过的那本」
  const bookRow = queryCurrentBook(userId, true) ?? queryCurrentBook(userId, false);

  const lastReadAtMillis = summary?.lastReadAt ?? bookRow?.lastReadAt ?? null;

  const currentBook: ReadingStatusSummary['currentBook'] = bookRow
    ? {
        id: bookRow.id,
        title: bookRow.title,
        author: bookRow.author,
        coverUrl: bookRow.coverUrl,
        progressPercent: num(bookRow.progressPercent),
        lastReadAt: bookRow.lastReadAt ? new Date(bookRow.lastReadAt).toISOString() : null,
        totalSeconds: num(bookRow.totalSeconds),
      }
    : null;

  return {
    currentBook,
    todaySeconds: num(summary?.todaySeconds),
    weekSeconds: num(summary?.weekSeconds),
    monthSeconds: num(summary?.monthSeconds),
    totalSeconds: num(summary?.totalSeconds),
    lastReadAt: lastReadAtMillis !== null ? new Date(lastReadAtMillis).toISOString() : null,
    streakDays: computeStreak(readDays, today),
    readingBookCount,
    finishedBookCount,
  };
}

/* --------------------------- 6. 会话明细下钻 --------------------------- */

export function listReadingSessions(
  userId: number,
  query: StatsQuery,
  extra: { weekday?: number | undefined; hour?: number | undefined },
  page: number,
  pageSize: number,
  timeZone: string,
): Paginated<ReadingSessionDetail> {
  const filters: SessionFilters = {
    platform: query.platform,
    bookId: query.bookId,
    weekday: extra.weekday,
    hour: extra.hour,
  };
  if (query.from) filters.from = normalizeDay(query.from, timeZone) ?? undefined;
  if (query.to) filters.to = normalizeDay(query.to, timeZone) ?? undefined;

  const { clause, params } = buildSessionWhere(userId, filters);
  const raw = getRawDb();

  const totalRow = raw
    .prepare(`SELECT COUNT(*) AS total FROM reading_sessions s WHERE ${clause}`)
    .get(...params) as unknown as { total: number | null } | undefined;
  const total = num(totalRow?.total);

  const offset = (page - 1) * pageSize;
  const rows = raw
    .prepare(
      `SELECT s.id AS id,
              s.book_id AS bookId,
              b.title AS bookTitle,
              s.platform AS platform,
              s.device AS device,
              s.seconds AS seconds,
              s.started_at AS startedAt,
              s.ended_at AS endedAt,
              s.progress_percent AS progressPercent
         FROM reading_sessions s
         LEFT JOIN books b ON b.id = s.book_id
        WHERE ${clause}
        ORDER BY s.started_at DESC
        LIMIT ? OFFSET ?`,
    )
    .all(...params, pageSize, offset) as unknown as SessionRow[];

  const items: ReadingSessionDetail[] = rows.map((row) => ({
    id: row.id,
    bookId: row.bookId,
    bookTitle: row.bookTitle,
    platform: row.platform,
    device: row.device,
    seconds: num(row.seconds),
    startedAt: new Date(row.startedAt).toISOString(),
    endedAt: row.endedAt !== null ? new Date(row.endedAt).toISOString() : null,
    progressPercent: row.progressPercent,
  }));

  return {
    items,
    total,
    page,
    pageSize,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
  };
}

/* --------------------------- 7. 首页布局 --------------------------- */

/** 默认布局：全部组件启用，顺序按 DASHBOARD_WIDGETS 声明顺序 */
export function defaultDashboardLayout(): DashboardLayout {
  return {
    widgets: DASHBOARD_WIDGETS.map((id, index) => ({ id, enabled: true, order: index })),
  };
}

export function getDashboardLayout(userId: number): DashboardLayout {
  const stored = getUserPreferences(userId).dashboard;
  const parsed = dashboardLayoutSchema.safeParse(stored);
  // 未设置过（或历史数据已损坏）时返回全部启用的默认布局，保证首页始终可用
  return parsed.success ? parsed.data : defaultDashboardLayout();
}

export function saveDashboardLayout(userId: number, layout: DashboardLayout): DashboardLayout {
  const validated = dashboardLayoutSchema.parse(layout);

  // preferences 是单个 JSON 列，存放主题、时区等多个偏好；
  // 必须读出旧值再合并，否则会把用户的其它设置一并覆盖掉
  const preferences = getUserPreferences(userId);
  getDb()
    .update(users)
    .set({ preferences: { ...preferences, dashboard: validated }, updatedAt: new Date() })
    .where(eq(users.id, userId))
    .run();

  return validated;
}

/** 布局里是否启用了某组件；未列出的组件视为用户主动移除，不参与计算 */
function isWidgetEnabled(layout: DashboardLayout, widget: DashboardWidget): boolean {
  return layout.widgets.find((item) => item.id === widget)?.enabled ?? false;
}

function emptyHeatmap(): ReadingHeatmap {
  return { cells: buildHeatmapCells([]), maxSeconds: 0 };
}

/* --------------------------- 8. 首页聚合 --------------------------- */

/**
 * 首页一次性聚合。
 * 按用户 layout 只计算启用的组件：统计聚合要走 SQL 全表扫描，
 * 关了的热力图/书库概览没必要每次进首页都算一遍。
 */
export function getDashboardData(
  userId: number,
  query: StatsQuery,
  timeZone: string,
  today: string,
): DashboardData {
  const layout = getDashboardLayout(userId);

  const trendEnabled = isWidgetEnabled(layout, 'reading_time_trend');
  const platformsEnabled = isWidgetEnabled(layout, 'platform_distribution');
  const heatmapEnabled = isWidgetEnabled(layout, 'reading_heatmap');
  const overviewEnabled = isWidgetEnabled(layout, 'library_overview');

  return {
    layout,
    trend: trendEnabled
      ? getReadingTimeTrend(userId, query, timeZone, today)
      : { granularity: query.granularity, points: [], totalSeconds: 0, averageSeconds: 0 },
    platforms: platformsEnabled
      ? getPlatformDistribution(userId, query, timeZone, today)
      : { items: [], totalSeconds: 0 },
    // 未启用时也返回完整的 0 值网格，前端无需对「无热力图」做特判
    heatmap: heatmapEnabled ? getReadingHeatmap(userId, query, timeZone, today) : emptyHeatmap(),
    overview: overviewEnabled
      ? getLibraryOverview(userId)
      : { totalBooks: 0, totalBytes: 0, byFormat: [], byStatus: [] },
    // 顶部状态卡片不属于可配置组件，且聚合开销很小，始终计算
    status: getReadingStatusSummary(userId, timeZone, today),
  };
}
