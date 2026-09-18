import {
  type LibraryOverview,
  type ReadingHeatmap as ReadingHeatmapData,
  type ReadingSessionDetail,
  type ReadingStatusSummary,
  type ReadingTimeTrend,
  type PlatformDistribution,
  type StatGranularity,
} from '@readsync/shared';
import { BookOpen, Clock, Flame, Library, TrendingUp } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { PlatformPie } from '../components/charts/PlatformPie';
import { ReadingHeatmap } from '../components/charts/ReadingHeatmap';
import { TrendChart, type TrendMetric, type TrendVariant } from '../components/charts/TrendChart';
import { SessionsModal } from '../components/SessionsModal';
import { Alert } from '../components/ui/Alert';
import { Button } from '../components/ui/Button';
import { Card, CardBody, CardHeader, StatTile } from '../components/ui/Card';
import { EmptyState } from '../components/ui/EmptyState';
import { Segmented } from '../components/ui/Segmented';
import { PageSpinner } from '../components/ui/Spinner';
import { api } from '../lib/api';
import { useAsync } from '../lib/hooks';
import { formatBytes, formatDateTime, formatDuration, formatPercent, formatRelative, toDate } from '../lib/utils';

const GRANULARITY_OPTIONS: ReadonlyArray<{ value: StatGranularity; label: string }> = [
  { value: 'day', label: '日' },
  { value: 'week', label: '周' },
  { value: 'month', label: '月' },
  { value: 'year', label: '年' },
];

const METRIC_OPTIONS: ReadonlyArray<{ value: TrendMetric; label: string }> = [
  { value: 'seconds', label: '阅读时长' },
  { value: 'bookCount', label: '书籍数' },
  { value: 'syncCount', label: '同步次数' },
];

const VARIANT_OPTIONS: ReadonlyArray<{ value: TrendVariant; label: string }> = [
  { value: 'bar', label: '柱状' },
  { value: 'line', label: '折线' },
];

interface DrilldownState {
  open: boolean;
  title: string;
  description?: ReactNode;
  filters: Record<string, string | number>;
  clientFilter?: (session: ReadingSessionDetail) => boolean;
}

const CLOSED: DrilldownState = { open: false, title: '', filters: {} };

/**
 * 阅读状态页（README 要求 6）。
 *
 * 顶部回答「现在在读什么、读了多久、最后一次读是什么时候」，
 * 下方用趋势/平台/热力图/书库概览回答「总体读得怎么样」。
 * 每个接口独立拉取：某一个统计端点未就绪不会让整页空白。
 */
export function ReadingStatus(): ReactNode {
  const [granularity, setGranularity] = useState<StatGranularity>('day');
  const [metric, setMetric] = useState<TrendMetric>('seconds');
  const [variant, setVariant] = useState<TrendVariant>('bar');
  const [drilldown, setDrilldown] = useState<DrilldownState>(CLOSED);

  const summary = useAsync(() => api.get<ReadingStatusSummary>('/stats/status'), []);
  const trend = useAsync(
    () => api.get<ReadingTimeTrend>('/stats/trend', { granularity }),
    [granularity],
  );
  const platforms = useAsync(() => api.get<PlatformDistribution>('/stats/platforms'), []);
  const heatmap = useAsync(() => api.get<ReadingHeatmapData>('/stats/heatmap'), []);
  const library = useAsync(() => api.get<LibraryOverview>('/stats/library'), []);

  const status = summary.data;
  const current = status?.currentBook ?? null;
  const points = trend.data?.points ?? [];

  const openDrilldown = (next: Omit<DrilldownState, 'open'>): void => setDrilldown({ ...next, open: true });

  return (
    <div className="flex flex-col gap-4">
      <header>
        <h1 className="font-serif text-xl text-ink">阅读状态</h1>
        <p className="mt-0.5 font-sans text-xs text-muted">
          最后一次阅读：{status?.lastReadAt ? formatDateTime(status.lastReadAt) : '暂无记录'}
        </p>
      </header>

      {summary.loading ? (
        <PageSpinner label="正在读取阅读状态…" />
      ) : summary.error && !summary.error.isMissing ? (
        <Alert tone="danger">{summary.error.message}</Alert>
      ) : null}

      {/* 当前在读 */}
      {current ? (
        <Card>
          <CardBody className="flex flex-col gap-4 sm:flex-row">
            <div className="flex size-24 shrink-0 items-center justify-center overflow-hidden rounded-sm border border-line bg-raised">
              {current.coverUrl ? (
                <img
                  src={current.coverUrl}
                  alt={`${current.title} 封面`}
                  className="size-full object-cover"
                  loading="lazy"
                />
              ) : (
                <BookOpen size={26} className="text-faint" />
              )}
            </div>

            <div className="flex min-w-0 flex-1 flex-col gap-2">
              <div>
                <div className="flex items-center gap-1.5 font-sans text-xs text-muted">
                  <BookOpen size={12} />
                  当前在读
                </div>
                <Link
                  to={`/library/${current.id}`}
                  className="font-serif text-lg text-ink underline-offset-2 hover:underline"
                >
                  {current.title}
                </Link>
                <p className="font-sans text-xs text-muted">{current.author || '佚名'}</p>
              </div>

              {/* 进度条：细线 + 实心块，没有渐变 */}
              <div className="flex items-center gap-2">
                <span className="h-1.5 flex-1 rounded-[1px] bg-raised">
                  <span
                    className="block h-full rounded-[1px]"
                    style={{
                      width: `${Math.min(100, Math.max(0, current.progressPercent))}%`,
                      backgroundColor: 'var(--rs-chart-1)',
                    }}
                  />
                </span>
                <span className="shrink-0 font-sans text-xs text-ink-soft">
                  {formatPercent(current.progressPercent, 0)}
                </span>
              </div>

              <div className="flex flex-wrap gap-x-5 gap-y-1 font-sans text-xs text-muted">
                <span className="flex items-center gap-1">
                  <Clock size={11} />
                  累计 {formatDuration(current.totalSeconds)}
                </span>
                <span>最后阅读 {formatRelative(current.lastReadAt)}</span>
              </div>

              <div className="mt-0.5 flex gap-1.5">
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() =>
                    openDrilldown({
                      title: `《${current.title}》的阅读明细`,
                      description: '按书籍筛选的会话记录',
                      filters: { bookId: current.id },
                    })
                  }
                >
                  查看阅读明细
                </Button>
              </div>
            </div>
          </CardBody>
        </Card>
      ) : summary.loading ? null : (
        <EmptyState
          icon={<BookOpen size={22} />}
          title="当前没有正在阅读的书"
          description="同步一次阅读进度后，这里会显示最近在读的书籍"
        />
      )}

      {/* 阅读时长指标 */}
      <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
        <StatTile label="今日阅读" value={formatDuration(status?.todaySeconds ?? 0)} icon={<Clock size={12} />} />
        <StatTile label="本周阅读" value={formatDuration(status?.weekSeconds ?? 0)} />
        <StatTile label="本月阅读" value={formatDuration(status?.monthSeconds ?? 0)} />
        <StatTile
          label="累计阅读"
          value={formatDuration(status?.totalSeconds ?? 0)}
          icon={<TrendingUp size={12} />}
        />
      </div>

      <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
        <StatTile label="连续阅读" value={`${status?.streakDays ?? 0} 天`} icon={<Flame size={12} />} />
        <StatTile label="正在阅读" value={`${status?.readingBookCount ?? 0} 本`} icon={<Library size={12} />} />
        <StatTile label="已读完" value={`${status?.finishedBookCount ?? 0} 本`} />
        <StatTile
          label="书库容量"
          value={formatBytes(library.data?.totalBytes ?? 0)}
          sub={`共 ${library.data?.totalBooks ?? 0} 本`}
        />
      </div>

      {/* 趋势 */}
      <Card>
        <CardHeader
          title="阅读时长趋势"
          description="点击任意柱子查看当天的阅读明细"
          actions={<Segmented size="sm" value={granularity} onChange={setGranularity} options={GRANULARITY_OPTIONS} />}
        />
        <CardBody>
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <span className="font-sans text-xs text-muted">
              区间合计 {formatDuration(trend.data?.totalSeconds ?? 0)} · 日均{' '}
              {formatDuration(trend.data?.averageSeconds ?? 0)}
            </span>
            <div className="flex items-center gap-1.5">
              <Segmented size="sm" value={metric} onChange={setMetric} options={METRIC_OPTIONS} />
              <Segmented size="sm" value={variant} onChange={setVariant} options={VARIANT_OPTIONS} />
            </div>
          </div>

          {trend.loading ? (
            <PageSpinner label="载入趋势…" />
          ) : points.length === 0 ? (
            <EmptyState title="暂无趋势数据" description="还没有任何阅读时长上报记录" />
          ) : (
            <TrendChart
              points={points}
              metric={metric}
              variant={variant}
              height={260}
              onSelect={(point) =>
                openDrilldown({
                  title: `${point.date} 的阅读明细`,
                  description: `当日阅读 ${formatDuration(point.seconds)}，涉及 ${point.bookCount} 本书`,
                  filters: { from: point.date, to: point.date },
                })
              }
            />
          )}
        </CardBody>
      </Card>

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        <Card>
          <CardHeader
            title="阅读平台分布"
            description="点击扇区查看该平台的阅读明细"
            actions={platforms.error?.isMissing ? <span className="font-sans text-xs text-muted">接口未就绪</span> : null}
          />
          <CardBody>
            {platforms.loading ? (
              <PageSpinner label="载入分布…" />
            ) : (
              <PlatformPie
                data={platforms.data}
                onSelect={(platform) =>
                  openDrilldown({
                    title: `${platform} 的阅读明细`,
                    description: '按阅读平台筛选的会话记录',
                    filters: { platform },
                  })
                }
              />
            )}
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="书库概览" description="按格式与阅读状态统计" />
          <CardBody>
            {library.loading ? (
              <PageSpinner label="载入书库…" />
            ) : !library.data || library.data.totalBooks === 0 ? (
              <EmptyState title="书库还是空的" description="前往「个人书库」上传第一本书" />
            ) : (
              <div className="flex flex-col gap-3">
                <div className="grid grid-cols-2 gap-2">
                  <StatTile label="书籍总数" value={library.data.totalBooks} />
                  <StatTile label="占用容量" value={formatBytes(library.data.totalBytes)} />
                </div>

                {library.data.byStatus.length > 0 ? (
                  <div className="flex flex-wrap gap-1.5">
                    {library.data.byStatus.map((item) => (
                      <span
                        key={item.status}
                        className="rounded-sm border border-line px-2 py-1 font-sans text-xs text-ink-soft"
                      >
                        {READING_STATUS_LABELS[item.status] ?? item.status} {item.count}
                      </span>
                    ))}
                  </div>
                ) : null}

                {library.data.byFormat.length > 0 ? (
                  <ul className="flex flex-col gap-1.5">
                    {library.data.byFormat.slice(0, 6).map((item) => (
                      <li key={item.format} className="flex items-center gap-2 font-sans text-xs">
                        <span className="w-14 shrink-0 text-muted">{item.format.toUpperCase()}</span>
                        <span className="h-2 flex-1 rounded-[1px] bg-raised">
                          <span
                            className="block h-full rounded-[1px]"
                            style={{
                              width: `${Math.max(
                                2,
                                Math.round(
                                  (item.count /
                                    Math.max(...library.data!.byFormat.map((entry) => entry.count), 1)) *
                                    100,
                                ),
                              )}%`,
                              backgroundColor: 'var(--rs-chart-1)',
                            }}
                          />
                        </span>
                        <span className="w-20 shrink-0 text-right text-ink-soft">
                          {item.count} · {formatBytes(item.bytes)}
                        </span>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>
            )}
          </CardBody>
        </Card>
      </div>

      <Card>
        <CardHeader title="阅读热力图" description="星期 × 时段，点击格子查看该时段的阅读明细" />
        <CardBody>
          {heatmap.loading ? (
            <PageSpinner label="载入热力图…" />
          ) : (
            <ReadingHeatmap
              data={heatmap.data}
              onSelect={(cell) =>
                openDrilldown({
                  title: `${['周日', '周一', '周二', '周三', '周四', '周五', '周六'][cell.weekday] ?? ''} ${
                    cell.hour
                  }:00 的阅读明细`,
                  description: `该时段累计阅读 ${formatDuration(cell.seconds)}`,
                  filters: {},
                  clientFilter: (session) => {
                    const date = toDate(session.startedAt);
                    return !!date && date.getDay() === cell.weekday && date.getHours() === cell.hour;
                  },
                })
              }
            />
          )}
        </CardBody>
      </Card>

      <SessionsModal
        open={drilldown.open}
        onClose={() => setDrilldown(CLOSED)}
        title={drilldown.title}
        description={drilldown.description}
        filters={drilldown.filters}
        clientFilter={drilldown.clientFilter}
      />
    </div>
  );
}

const READING_STATUS_LABELS: Record<string, string> = {
  unread: '未读',
  reading: '在读',
  finished: '已读完',
  paused: '搁置',
  abandoned: '弃读',
};
