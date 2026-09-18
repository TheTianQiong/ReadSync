import type { FastifyInstance } from 'fastify';
import {
  dashboardLayoutSchema,
  paginationQuerySchema,
  statsQuerySchema,
  type ApiSuccess,
  type DashboardData,
  type DashboardLayout,
  type LibraryOverview,
  type Paginated,
  type PaginationQuery,
  type PlatformDistribution,
  type ReadingHeatmap,
  type ReadingSessionDetail,
  type ReadingStatusSummary,
  type ReadingTimeTrend,
  type StatsQuery,
} from '@readsync/shared';
import { badRequest, validationFailed } from '../../errors.js';
import { currentUser, requireAuth } from '../../middleware/auth.js';
import {
  getDashboardData,
  getDashboardLayout,
  getLibraryOverview,
  getPlatformDistribution,
  getReadingHeatmap,
  getReadingStatusSummary,
  getReadingTimeTrend,
  getUserTimezone,
  listReadingSessions,
  saveDashboardLayout,
  todayInTimezone,
} from './service.js';

/**
 * 阅读统计路由（前缀 /api/stats）。
 *
 * 所有接口都要登录，且查询条件里始终带上 `user_id = 当前用户`，
 * 保证用户之间绝对看不到对方的阅读数据。
 * 错误统一抛 AppError，由 app.ts 的全局错误处理器转成响应信封。
 */
export async function registerStatsRoutes(app: FastifyInstance): Promise<void> {
  /**
   * zod 解析失败时抛 AppError 而不是让 ZodError 冒泡成 500。
   * 这里不用 schema.parse()，是为了让「参数非法」得到正确的 400 语义。
   *
   * 用结构化类型而不是从 'zod' 导入 ZodType：server 包并未直接依赖 zod，
   * 直接 import 会引入未声明的依赖；shared 导出的 schema 结构上完全满足这个约束。
   */
  type SafeParseResult<T> = { success: true; data: T } | { success: false; error: { issues: unknown } };
  interface SchemaLike<T> {
    safeParse(value: unknown): SafeParseResult<T>;
  }

  function parseOrThrow<T>(schema: SchemaLike<T>, value: unknown, message = '请求参数校验失败'): T {
    const result = schema.safeParse(value);
    if (!result.success) throw validationFailed(message, result.error.issues);
    return result.data;
  }

  /** weekday/hour 只在下钻接口里使用，shared 未定义对应 schema，这里做有界校验 */
  function parseBoundedInt(value: unknown, min: number, max: number, field: string): number | undefined {
    if (value === undefined || value === null || value === '') return undefined;
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
      throw badRequest(`${field} 必须是 ${min}-${max} 之间的整数`);
    }
    return parsed;
  }

  /* ------------------------- 阅读时长趋势 ------------------------- */

  app.get('/api/stats/trend', { preHandler: requireAuth }, async (req) => {
    const user = currentUser(req);
    const query = parseOrThrow<StatsQuery>(statsQuerySchema, req.query);
    const timezone = getUserTimezone(user.id);

    const data = getReadingTimeTrend(user.id, query, timezone, todayInTimezone(timezone));
    return { ok: true, data } satisfies ApiSuccess<ReadingTimeTrend>;
  });

  /* ------------------------- 平台分布 ------------------------- */

  app.get('/api/stats/platforms', { preHandler: requireAuth }, async (req) => {
    const user = currentUser(req);
    const query = parseOrThrow<StatsQuery>(statsQuerySchema, req.query);
    const timezone = getUserTimezone(user.id);

    const data = getPlatformDistribution(user.id, query, timezone, todayInTimezone(timezone));
    return { ok: true, data } satisfies ApiSuccess<PlatformDistribution>;
  });

  /* ------------------------- 热力图 ------------------------- */

  app.get('/api/stats/heatmap', { preHandler: requireAuth }, async (req) => {
    const user = currentUser(req);
    const query = parseOrThrow<StatsQuery>(statsQuerySchema, req.query);
    const timezone = getUserTimezone(user.id);

    const data = getReadingHeatmap(user.id, query, timezone, todayInTimezone(timezone));
    return { ok: true, data } satisfies ApiSuccess<ReadingHeatmap>;
  });

  /* ------------------------- 书库概览 ------------------------- */

  app.get('/api/stats/library', { preHandler: requireAuth }, async (req) => {
    const user = currentUser(req);
    return { ok: true, data: getLibraryOverview(user.id) } satisfies ApiSuccess<LibraryOverview>;
  });

  /* ------------------------- 阅读状态卡片 ------------------------- */

  app.get('/api/stats/status', { preHandler: requireAuth }, async (req) => {
    const user = currentUser(req);
    const timezone = getUserTimezone(user.id);

    const data = getReadingStatusSummary(user.id, timezone, todayInTimezone(timezone));
    return { ok: true, data } satisfies ApiSuccess<ReadingStatusSummary>;
  });

  /* ------------------------- 首页聚合 ------------------------- */

  app.get('/api/stats/dashboard', { preHandler: requireAuth }, async (req) => {
    const user = currentUser(req);
    // 首页也允许带 from/to 等条件，用于「自定义时间范围」的看图需求
    const query = parseOrThrow<StatsQuery>(statsQuerySchema, req.query);
    const timezone = getUserTimezone(user.id);

    const data = getDashboardData(user.id, query, timezone, todayInTimezone(timezone));
    return { ok: true, data } satisfies ApiSuccess<DashboardData>;
  });

  /* ------------------------- 图表下钻明细 ------------------------- */

  app.get('/api/stats/sessions', { preHandler: requireAuth }, async (req) => {
    const user = currentUser(req);
    const query = parseOrThrow<StatsQuery>(statsQuerySchema, req.query);
    const { page, pageSize } = parseOrThrow<PaginationQuery>(paginationQuerySchema, req.query);
    const timezone = getUserTimezone(user.id);

    // 点击热力图格子 → weekday + hour；点击趋势图某点 → from = to = 该点日期
    const weekday = parseBoundedInt((req.query as Record<string, unknown>).weekday, 0, 6, 'weekday');
    const hour = parseBoundedInt((req.query as Record<string, unknown>).hour, 0, 23, 'hour');

    const data = listReadingSessions(user.id, query, { weekday, hour }, page, pageSize, timezone);
    return { ok: true, data } satisfies ApiSuccess<Paginated<ReadingSessionDetail>>;
  });

  /* ------------------------- 首页布局偏好 ------------------------- */

  app.get('/api/stats/preferences', { preHandler: requireAuth }, async (req) => {
    const user = currentUser(req);
    return { ok: true, data: getDashboardLayout(user.id) } satisfies ApiSuccess<DashboardLayout>;
  });

  app.put('/api/stats/preferences', { preHandler: requireAuth }, async (req) => {
    const user = currentUser(req);
    // 用 shared 的 dashboardLayoutSchema 校验，前后端对布局结构的理解保持一致
    const layout = parseOrThrow<DashboardLayout>(dashboardLayoutSchema, req.body, '首页布局格式不正确');

    const saved = saveDashboardLayout(user.id, layout);
    return { ok: true, data: saved } satisfies ApiSuccess<DashboardLayout>;
  });
}
