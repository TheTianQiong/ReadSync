import {
  DASHBOARD_WIDGETS,
  DASHBOARD_WIDGET_META,
  type BookSummary,
  type DashboardData,
  type DashboardWidget,
  type Paginated,
  type ReadingSessionDetail,
  type StatGranularity,
  type SyncEntry,
} from '@readsync/shared';
import { ChevronDown, ChevronUp, LayoutGrid, RefreshCw, Settings2 } from 'lucide-react';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { PlatformPie } from '../components/charts/PlatformPie';
import { ReadingHeatmap } from '../components/charts/ReadingHeatmap';
import { TrendChart, type TrendMetric, type TrendVariant } from '../components/charts/TrendChart';
import { SessionsModal } from '../components/SessionsModal';
import { Alert } from '../components/ui/Alert';
import { Button } from '../components/ui/Button';
import { Card, CardBody, CardHeader, StatTile } from '../components/ui/Card';
import { EmptyState, ErrorNote } from '../components/ui/EmptyState';
import { Modal } from '../components/ui/Modal';
import { Segmented } from '../components/ui/Segmented';
import { PageSpinner } from '../components/ui/Spinner';
import { Switch } from '../components/ui/Switch';
import { Table, TBody, TD, TH, THead, TR } from '../components/ui/Table';
import { useAuth } from '../contexts/AuthContext';
import { useToast } from '../components/ui/Toast';
import { api } from '../lib/api';
import { useAsync } from '../lib/hooks';
import { formatBytes, formatDateTime, formatDuration, formatRelative, toDate } from '../lib/utils';

const GRANULARITY_OPTIONS: ReadonlyArray<{ value: StatGranularity; label: string }> = [
  { value: 'day', label: '日' },
  { value: 'week', label: '周' },
  { value: 'month', label: '月' },
  { value: 'year', label: '年' },
];

const METRIC_OPTIONS: ReadonlyArray<{ value: TrendMetric; label: string }> = [
  { value: 'seconds', label: '时长' },
  { value: 'bookCount', label: '书籍' },
  { value: 'syncCount', label: '同步' },
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

const CLOSED_DRILLDOWN: DrilldownState = { open: false, title: '', filters: {} };

/**
 * 首页（README 要求 5）。
 *
 * 数据一次由 GET /api/stats/dashboard 拉齐（含 layout/trend/platforms/heatmap/overview/status），
 * 只有「最近在读」与「同步状态」没有聚合进该响应，单独查列表接口。
 *
 * 每张图表都可点击下钻：点击后带上过滤条件去查 /api/stats/sessions 并弹窗展示明细。
 */
export function Dashboard(): ReactNode {
  const { user } = useAuth();
  const toast = useToast();
  const navigate = useNavigate();

  const [granularity, setGranularity] = useState<StatGranularity>('day');
  const [metric, setMetric] = useState<TrendMetric>('seconds');
  const [variant, setVariant] = useState<TrendVariant>('bar');
  const [customizeOpen, setCustomizeOpen] = useState(false);
  const [drilldown, setDrilldown] = useState<DrilldownState>(CLOSED_DRILLDOWN);

  const { data, loading, error, reload } = useAsync(
    () => api.get<DashboardData>('/stats/dashboard', { granularity }),
    [granularity],
  );

  const recentBooks = useAsync(
    () =>
      api.get<Paginated<BookSummary>>('/books', {
        page: 1,
        pageSize: 5,
        sortBy: 'lastReadAt',
        sortOrder: 'desc',
      }),
    [],
  );

  const syncEntries = useAsync(
    () => api.get<Paginated<SyncEntry>>('/sync/entries', { page: 1, pageSize: 5 }),
    [],
  );

  /** 后端返回 null（端点未实现）时给一个全启用的默认布局，页面仍然可用 */
  const widgets = useMemo<DashboardWidget[]>(() => {
    const layout = data?.layout?.widgets;
    if (!layout || layout.length === 0) return [...DASHBOARD_WIDGETS];
    return [...layout]
      .filter((widget) => widget.enabled)
      .sort((a, b) => a.order - b.order)
      .map((widget) => widget.id);
  }, [data?.layout]);

  const trend = data?.trend;
  const hasTrendData = (trend?.points?.length ?? 0) > 0;

  const openDrilldown = (next: Omit<DrilldownState, 'open'>): void => setDrilldown({ ...next, open: true });

  const renderWidget = (widget: DashboardWidget): ReactNode => {
    switch (widget) {
      case 'reading_time_trend':
        return (
          <WidgetCard
            key={widget}
            title={DASHBOARD_WIDGET_META[widget].label}
            description={DASHBOARD_WIDGET_META[widget].description}
            actions={
              <Segmented size="sm" value={granularity} onChange={setGranularity} options={GRANULARITY_OPTIONS} />
            }
            className="lg:col-span-2"
          >
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <span className="font-sans text-xs text-muted">
                合计 {formatDuration(trend?.totalSeconds ?? 0)} · 日均{' '}
                {formatDuration(trend?.averageSeconds ?? 0)}
              </span>
              <div className="flex items-center gap-1.5">
                <Segmented size="sm" value={metric} onChange={setMetric} options={METRIC_OPTIONS} />
                <Segmented size="sm" value={variant} onChange={setVariant} options={VARIANT_OPTIONS} />
              </div>
            </div>
            {hasTrendData ? (
              <TrendChart
                points={trend?.points ?? []}
                metric={metric}
                variant={variant}
                onSelect={(point) =>
                  openDrilldown({
                    title: `${point.date} 的阅读明细`,
                    description: `当日阅读 ${formatDuration(point.seconds)}，涉及 ${point.bookCount} 本书`,
                    filters: { from: point.date, to: point.date },
                  })
                }
              />
            ) : (
              <EmptyState title="暂无阅读时长数据" description="阅读器同步进度后即可看到趋势" />
            )}
          </WidgetCard>
        );

      case 'platform_distribution':
        return (
          <WidgetCard
            key={widget}
            title={DASHBOARD_WIDGET_META[widget].label}
            description={DASHBOARD_WIDGET_META[widget].description}
          >
            <PlatformPie
              data={data?.platforms ?? null}
              onSelect={(platform) =>
                openDrilldown({
                  title: `${platform} 的阅读明细`,
                  description: '按阅读平台筛选的会话记录',
                  filters: { platform },
                })
              }
            />
          </WidgetCard>
        );

      case 'reading_heatmap':
        return (
          <WidgetCard
            key={widget}
            title={DASHBOARD_WIDGET_META[widget].label}
            description={DASHBOARD_WIDGET_META[widget].description}
            className="lg:col-span-2"
          >
            <ReadingHeatmap
              data={data?.heatmap ?? null}
              onSelect={(cell) =>
                openDrilldown({
                  title: `${['周日', '周一', '周二', '周三', '周四', '周五', '周六'][cell.weekday] ?? ''} ${
                    cell.hour
                  }:00 的阅读明细`,
                  description: `该时段累计阅读 ${formatDuration(cell.seconds)}`,
                  filters: {},
                  // 后端 stats/sessions 目前只按日期/平台过滤，星期与小时在前端筛
                  clientFilter: (session) => {
                    const date = toDate(session.startedAt);
                    return !!date && date.getDay() === cell.weekday && date.getHours() === cell.hour;
                  },
                })
              }
            />
          </WidgetCard>
        );

      case 'library_overview': {
        const overview = data?.overview;
        return (
          <WidgetCard
            key={widget}
            title={DASHBOARD_WIDGET_META[widget].label}
            description={DASHBOARD_WIDGET_META[widget].description}
            actions={
              <Link to="/library" className="font-sans text-xs text-accent underline-offset-2 hover:underline">
                进入书库
              </Link>
            }
          >
            {overview ? (
              <div className="flex flex-col gap-3">
                <div className="grid grid-cols-2 gap-2">
                  <StatTile label="书籍总数" value={overview.totalBooks} />
                  <StatTile label="占用容量" value={formatBytes(overview.totalBytes)} />
                </div>

                {overview.byFormat.length > 0 ? (
                  <div className="flex flex-col gap-1.5">
                    <span className="font-sans text-xs text-muted">按格式</span>
                    {overview.byFormat.slice(0, 5).map((item) => (
                      <FormatBar
                        key={item.format}
                        label={item.format.toUpperCase()}
                        value={item.count}
                        max={Math.max(...overview.byFormat.map((entry) => entry.count), 1)}
                        suffix={`${formatBytes(item.bytes)}`}
                      />
                    ))}
                  </div>
                ) : null}
              </div>
            ) : (
              <EmptyState title="暂无书库数据" />
            )}
          </WidgetCard>
        );
      }

      case 'recent_books':
        return (
          <WidgetCard
            key={widget}
            title={DASHBOARD_WIDGET_META[widget].label}
            description={DASHBOARD_WIDGET_META[widget].description}
            actions={
              <Link to="/library" className="font-sans text-xs text-accent underline-offset-2 hover:underline">
                全部
              </Link>
            }
          >
            {recentBooks.loading ? (
              <PageSpinner label="载入中…" />
            ) : (recentBooks.data?.items.length ?? 0) === 0 ? (
              <EmptyState title="还没有阅读记录" description="上传书籍并同步进度后会出现在这里" />
            ) : (
              <ul className="flex flex-col divide-y divide-line">
                {recentBooks.data?.items.map((book) => (
                  <li key={book.id}>
                    <button
                      type="button"
                      onClick={() => navigate(`/library/${book.id}`)}
                      className="flex w-full cursor-pointer items-center gap-2.5 py-2 text-left transition-colors hover:bg-raised"
                    >
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-serif text-sm text-ink">{book.title}</span>
                        <span className="block truncate font-sans text-xs text-muted">
                          {book.author || '佚名'} · {formatRelative(book.lastReadAt)}
                        </span>
                      </span>
                      <span className="shrink-0 font-sans text-xs text-ink-soft">
                        {Math.round(book.progressPercent)}%
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </WidgetCard>
        );

      case 'sync_status':
        return (
          <WidgetCard
            key={widget}
            title={DASHBOARD_WIDGET_META[widget].label}
            description={DASHBOARD_WIDGET_META[widget].description}
            actions={
              <Link
                to="/settings/sync"
                className="font-sans text-xs text-accent underline-offset-2 hover:underline"
              >
                管理同步
              </Link>
            }
          >
            {syncEntries.loading ? (
              <PageSpinner label="载入中…" />
            ) : syncEntries.error ? (
              <ErrorNote message={syncEntries.error.message} />
            ) : (syncEntries.data?.items.length ?? 0) === 0 ? (
              <EmptyState title="还没有同步记录" description="在阅读器中配置同步服务器后即可看到" />
            ) : (
              <Table>
                <THead>
                  <TR>
                    <TH>文档</TH>
                    <TH>平台</TH>
                    <TH className="text-right">进度</TH>
                    <TH className="text-right">更新时间</TH>
                  </TR>
                </THead>
                <TBody>
                  {syncEntries.data?.items.map((entry) => (
                    <TR key={entry.id}>
                      <TD className="max-w-40 truncate">{entry.title || entry.document}</TD>
                      <TD className="whitespace-nowrap">{entry.platform}</TD>
                      <TD className="text-right whitespace-nowrap">
                        {Math.round(entry.percentage * 100)}%
                      </TD>
                      <TD className="text-right whitespace-nowrap">{formatRelative(entry.updatedAt)}</TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            )}
          </WidgetCard>
        );

      default:
        return null;
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-serif text-xl text-ink">你好，{user?.displayName || user?.username}</h1>
          <p className="mt-0.5 font-sans text-xs text-muted">
            {formatDateTime(new Date())} · 今天是坚持阅读的第 {data?.status?.streakDays ?? 0} 天
          </p>
        </div>

        <div className="flex items-center gap-1.5">
          <Button size="sm" variant="ghost" icon={<RefreshCw size={13} />} onClick={reload}>
            刷新
          </Button>
          <Button
            size="sm"
            variant="secondary"
            icon={<Settings2 size={13} />}
            onClick={() => setCustomizeOpen(true)}
          >
            自定义首页
          </Button>
        </div>
      </header>

      {loading ? (
        <PageSpinner label="正在汇总阅读数据…" />
      ) : error && !error.isMissing ? (
        <Alert tone="danger">{error.message}</Alert>
      ) : (
        <>
          {/* 顶部指标条：即使某个图表组件被关闭，核心数字也始终可见 */}
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <StatTile label="今日阅读" value={formatDuration(data?.status?.todaySeconds ?? 0)} />
            <StatTile label="本周阅读" value={formatDuration(data?.status?.weekSeconds ?? 0)} />
            <StatTile label="连续阅读" value={`${data?.status?.streakDays ?? 0} 天`} />
            <StatTile label="在读 / 读完" value={`${data?.status?.readingBookCount ?? 0} / ${data?.status?.finishedBookCount ?? 0}`} />
          </div>

          {error?.isMissing ? (
            <Alert tone="info">
              统计接口尚未就绪（/api/stats/dashboard 返回 404），当前展示的是空数据。后端模块上线后会自动恢复。
            </Alert>
          ) : null}

          <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
            {widgets.map((widget) => renderWidget(widget))}
          </div>

          {widgets.length === 0 ? (
            <EmptyState
              icon={<LayoutGrid size={22} />}
              title="首页组件全部被关闭了"
              description="点击右上角「自定义首页」重新勾选要显示的图表"
              action={
                <Button size="sm" variant="secondary" onClick={() => setCustomizeOpen(true)}>
                  自定义首页
                </Button>
              }
            />
          ) : null}
        </>
      )}

      <CustomizeDialog
        open={customizeOpen}
        onClose={() => setCustomizeOpen(false)}
        onSaved={() => {
          toast.success('首页布局已保存');
          reload();
        }}
      />

      <SessionsModal
        open={drilldown.open}
        onClose={() => setDrilldown(CLOSED_DRILLDOWN)}
        title={drilldown.title}
        description={drilldown.description}
        filters={drilldown.filters}
        clientFilter={drilldown.clientFilter}
      />
    </div>
  );
}

/** 所有首页组件共用的外壳：统一处理加载/空/错误三种状态 */
function WidgetCard({
  title,
  description,
  actions,
  children,
  className,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}): ReactNode {
  return (
    <Card className={className}>
      <CardHeader title={title} description={description} actions={actions} />
      <CardBody>{children}</CardBody>
    </Card>
  );
}

/** 极简条形图：书库格式分布这类「少量分类 + 一个数值」用不上 recharts */
function FormatBar({
  label,
  value,
  max,
  suffix,
}: {
  label: string;
  value: number;
  max: number;
  suffix?: string;
}): ReactNode {
  const width = max > 0 ? Math.max(2, Math.round((value / max) * 100)) : 0;

  return (
    <div className="flex items-center gap-2">
      <span className="w-14 shrink-0 font-sans text-xs text-muted">{label}</span>
      <span className="h-2 flex-1 rounded-[1px] bg-raised">
        <span
          className="block h-full rounded-[1px]"
          style={{ width: `${width}%`, backgroundColor: 'var(--rs-chart-1)' }}
        />
      </span>
      <span className="w-20 shrink-0 text-right font-sans text-xs text-ink-soft">
        {value}
        {suffix ? ` · ${suffix}` : ''}
      </span>
    </div>
  );
}

/**
 * 首页组件自定义（README 要求 5）。
 *
 * 读 GET /api/stats/preferences 拿当前布局，PUT 回写。
 * 顺序调整用上下箭头而不是拖拽：拖拽在触屏墨水屏设备上体验很差，
 * 而且表格行拖拽实现成本高、无障碍支持也差。
 */
function CustomizeDialog({
  open,
  onClose,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
}): ReactNode {
  const [order, setOrder] = useState<DashboardWidget[]>([...DASHBOARD_WIDGETS]);
  const [enabled, setEnabled] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(DASHBOARD_WIDGETS.map((id) => [id, true])),
  );
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;

    let cancelled = false;
    setLoading(true);
    setError(null);

    api
      .get<{ widgets?: Array<{ id: DashboardWidget; enabled: boolean; order: number }> }>(
        '/stats/preferences',
      )
      .then((result) => {
        if (cancelled) return;
        const saved = result?.widgets ?? [];
        if (saved.length === 0) return;

        const sorted = [...saved].sort((a, b) => a.order - b.order);
        // 已保存的按 order 排前面，新版本新增的组件追加在后面，保证不会「消失」
        const savedIds = sorted
          .map((item) => item.id)
          .filter((id): id is DashboardWidget => (DASHBOARD_WIDGETS as readonly string[]).includes(id));
        const rest = DASHBOARD_WIDGETS.filter((id) => !savedIds.includes(id));
        setOrder([...savedIds, ...rest]);
        setEnabled({
          ...Object.fromEntries(DASHBOARD_WIDGETS.map((id) => [id, true])),
          ...Object.fromEntries(sorted.map((item) => [item.id, item.enabled])),
        });
      })
      .catch(() => {
        // 端点未实现时用默认顺序，用户仍可编辑并尝试保存
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [open]);

  const move = (index: number, delta: number): void => {
    const target = index + delta;
    if (target < 0 || target >= order.length) return;
    setOrder((prev) => {
      const next = [...prev];
      const [item] = next.splice(index, 1);
      if (item) next.splice(target, 0, item);
      return next;
    });
  };

  const handleSave = async (): Promise<void> => {
    setSaving(true);
    setError(null);
    try {
      await api.put('/stats/preferences', {
        widgets: order.map((id, index) => ({ id, enabled: enabled[id] ?? true, order: index })),
      });
      onSaved();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存失败');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="自定义首页"
      description="勾选要显示的图表，并用箭头调整顺序"
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={onClose}>
            取消
          </Button>
          <Button variant="primary" size="sm" loading={saving} onClick={() => void handleSave()}>
            保存
          </Button>
        </>
      }
    >
      {loading ? (
        <PageSpinner label="正在读取布局…" />
      ) : (
        <div className="flex flex-col gap-3">
          {error ? <Alert tone="danger">{error}</Alert> : null}

          <ul className="flex flex-col divide-y divide-line rounded-sm border border-line">
            {order.map((id, index) => {
              const meta = DASHBOARD_WIDGET_META[id];
              const isEnabled = enabled[id] ?? true;

              return (
                <li key={id} className="flex items-center gap-3 px-3 py-2">
                  <div className="min-w-0 flex-1">
                    <div className={isEnabled ? 'font-sans text-sm text-ink' : 'font-sans text-sm text-muted'}>
                      {meta.label}
                    </div>
                    <div className="font-sans text-xs text-muted">{meta.description}</div>
                  </div>

                  <div className="flex shrink-0 flex-col">
                    <button
                      type="button"
                      aria-label={`上移 ${meta.label}`}
                      disabled={index === 0}
                      onClick={() => move(index, -1)}
                      className="cursor-pointer p-0.5 text-muted transition-colors hover:text-ink disabled:cursor-not-allowed disabled:opacity-30"
                    >
                      <ChevronUp size={13} />
                    </button>
                    <button
                      type="button"
                      aria-label={`下移 ${meta.label}`}
                      disabled={index === order.length - 1}
                      onClick={() => move(index, 1)}
                      className="cursor-pointer p-0.5 text-muted transition-colors hover:text-ink disabled:cursor-not-allowed disabled:opacity-30"
                    >
                      <ChevronDown size={13} />
                    </button>
                  </div>

                  <Switch
                    checked={isEnabled}
                    aria-label={`显示 ${meta.label}`}
                    onChange={(next) => setEnabled((prev) => ({ ...prev, [id]: next }))}
                  />
                </li>
              );
            })}
          </ul>

          <p className="font-sans text-xs text-muted">
            关闭的组件不会出现在首页，但仍保留在列表中，随时可以重新打开。
          </p>
        </div>
      )}
    </Modal>
  );
}
