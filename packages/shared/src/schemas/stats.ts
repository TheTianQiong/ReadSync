import { z } from 'zod';
import { DASHBOARD_WIDGETS, STAT_GRANULARITIES } from '../constants.js';

/**
 * 阅读统计。
 *
 * 首页（README 前端要求 5）与阅读状态页（要求 6）的图表都消费这里的类型。
 * 每个图表接口都支持下钻：点击图表后按 granularity 拉取明细列表。
 */

/** 统计查询的公共参数 */
export const statsQuerySchema = z.object({
  granularity: z.enum(STAT_GRANULARITIES).default('day'),
  /** 起始日期（含），RFC3339 或 YYYY-MM-DD */
  from: z.string().optional(),
  /** 结束日期（含） */
  to: z.string().optional(),
  /** 按平台过滤 */
  platform: z.string().max(64).optional(),
  /** 按书籍过滤 */
  bookId: z.coerce.number().int().positive().optional(),
});
export type StatsQuery = z.infer<typeof statsQuerySchema>;

/** 时间序列上的一个数据点 */
export interface TimeSeriesPoint {
  /** 该点对应的日期，YYYY-MM-DD */
  date: string;
  /** 阅读秒数 */
  seconds: number;
  /** 该区间内阅读的书籍数量 */
  bookCount: number;
  /** 该区间内的翻页/同步次数 */
  syncCount: number;
}

/** 阅读时长趋势图 */
export interface ReadingTimeTrend {
  granularity: (typeof STAT_GRANULARITIES)[number];
  points: TimeSeriesPoint[];
  /** 区间内总阅读秒数 */
  totalSeconds: number;
  /** 日均阅读秒数 */
  averageSeconds: number;
}

/** 平台分布图 */
export interface PlatformDistribution {
  items: Array<{
    platform: string;
    /** 平台显示名，取自 PLATFORM_LABELS 或用户自定义名 */
    label: string;
    seconds: number;
    /** 占比 0-100 */
    percent: number;
    bookCount: number;
  }>;
  totalSeconds: number;
}

/** 热力图（按星期几 × 小时聚合） */
export interface ReadingHeatmap {
  /** 7 行（周日→周六）× 24 列 */
  cells: Array<{ weekday: number; hour: number; seconds: number }>;
  maxSeconds: number;
}

/** 书库概览 */
export interface LibraryOverview {
  totalBooks: number;
  totalBytes: number;
  byFormat: Array<{ format: string; count: number; bytes: number }>;
  byStatus: Array<{ status: string; count: number }>;
}

/** 阅读状态页顶部卡片（README 前端要求 6） */
export interface ReadingStatusSummary {
  /** 当前正在阅读的书籍 */
  currentBook: {
    id: number;
    title: string;
    author: string | null;
    coverUrl: string | null;
    progressPercent: number;
    lastReadAt: string | null;
    /** 该书累计阅读秒数 */
    totalSeconds: number;
  } | null;
  /** 今日阅读秒数 */
  todaySeconds: number;
  /** 本周阅读秒数 */
  weekSeconds: number;
  /** 本月阅读秒数 */
  monthSeconds: number;
  /** 累计阅读秒数 */
  totalSeconds: number;
  /** 最后一次阅读时间 */
  lastReadAt: string | null;
  /** 连续阅读天数 */
  streakDays: number;
  /** 正在阅读的书本数 */
  readingBookCount: number;
  /** 已读完的书本数 */
  finishedBookCount: number;
}

/** 图表下钻明细：一条阅读会话记录 */
export interface ReadingSessionDetail {
  id: number;
  bookId: number | null;
  bookTitle: string | null;
  platform: string;
  device: string;
  seconds: number;
  /** 会话开始时间 */
  startedAt: string;
  endedAt: string | null;
  /** 会话结束时的进度百分比 */
  progressPercent: number | null;
}

/** 首页可配置的组件布局 */
export const dashboardLayoutSchema = z.object({
  widgets: z
    .array(
      z.object({
        id: z.enum(DASHBOARD_WIDGETS),
        enabled: z.boolean().default(true),
        /** 排序权重，越小越靠前 */
        order: z.coerce.number().int().default(0),
      }),
    )
    .max(DASHBOARD_WIDGETS.length),
});

export type DashboardLayout = z.infer<typeof dashboardLayoutSchema>;

/** 首页聚合响应，一次拉齐所有启用的组件数据 */
export interface DashboardData {
  layout: DashboardLayout;
  trend: ReadingTimeTrend;
  platforms: PlatformDistribution;
  heatmap: ReadingHeatmap;
  overview: LibraryOverview;
  status: ReadingStatusSummary;
}

/** 首页可选组件的显示名与说明，前端设置面板使用 */
export const DASHBOARD_WIDGET_META: Record<
  (typeof DASHBOARD_WIDGETS)[number],
  { label: string; description: string }
> = {
  reading_time_trend: { label: '阅读时长趋势', description: '按日/周/月展示阅读时长变化' },
  platform_distribution: { label: '阅读平台分布', description: '各阅读平台的时长占比' },
  reading_heatmap: { label: '阅读热力图', description: '一周内各时段的阅读强度' },
  recent_books: { label: '最近在读', description: '最近有阅读记录的书籍' },
  library_overview: { label: '书库概览', description: '书籍数量、容量与格式分布' },
  sync_status: { label: '同步状态', description: '各设备与存储的同步情况' },
};
