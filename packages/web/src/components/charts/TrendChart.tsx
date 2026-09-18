import type { TimeSeriesPoint } from '@readsync/shared';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { ReactNode } from 'react';
import { formatDuration, formatShortDate } from '../../lib/utils';
import { AXIS_TICK_STYLE, BAR_RADIUS, CHART_ACCENT, CHART_GRID } from './chartTheme';
import { renderChartTooltip } from './ChartTooltip';

export type TrendMetric = 'seconds' | 'bookCount' | 'syncCount';
export type TrendVariant = 'bar' | 'line';

export const METRIC_LABELS: Record<TrendMetric, string> = {
  seconds: '阅读时长',
  bookCount: '书籍数',
  syncCount: '同步次数',
};

/**
 * 阅读时长趋势。
 *
 * 两种形态服务不同粒度：
 *  - 柱状：日/周这类离散区间，柱子更适合表达「每段各读了多少」；
 *  - 折线：月/年这类连续趋势，折线更能看出走势。
 * 默认柱状，因为墨水屏上灰度块比细线更容易辨认。
 *
 * 点击数据点会把该点回调出去，由页面拉取 /api/stats/sessions 做下钻。
 */
export function TrendChart({
  points,
  metric = 'seconds',
  variant = 'bar',
  height = 220,
  onSelect,
}: {
  points: TimeSeriesPoint[];
  metric?: TrendMetric;
  variant?: TrendVariant;
  height?: number;
  onSelect?: (point: TimeSeriesPoint) => void;
}): ReactNode {
  const handleClick = (state: unknown): void => {
    const point = pickPoint(state);
    if (point && onSelect) onSelect(point);
  };

  const axes = (
    <>
      {/* 网格线极淡，只保留横向参考线 */}
      <CartesianGrid stroke={CHART_GRID} strokeDasharray="2 4" vertical={false} />
      <XAxis
        dataKey="date"
        tick={AXIS_TICK_STYLE}
        tickFormatter={(value: string) => formatShortDate(value)}
        tickLine={false}
        axisLine={{ stroke: CHART_GRID }}
        minTickGap={16}
      />
      <YAxis
        tick={AXIS_TICK_STYLE}
        tickLine={false}
        axisLine={false}
        width={52}
        tickFormatter={(value: number) =>
          metric === 'seconds' ? formatDuration(value, { compact: true }) : String(value)
        }
      />
      <Tooltip
        cursor={variant === 'bar' ? { fill: 'var(--rs-raised)' } : { stroke: CHART_GRID }}
        content={renderChartTooltip({
          labelFormatter: (label) => formatShortDate(String(label)),
          formatter: (value, name) => (name === METRIC_LABELS.seconds ? formatDuration(value) : String(value)),
        })}
      />
    </>
  );

  return (
    <div style={{ width: '100%', height }}>
      <ResponsiveContainer width="100%" height="100%">
        {variant === 'bar' ? (
          <BarChart data={points} margin={{ top: 8, right: 8, bottom: 0, left: -18 }} onClick={handleClick}>
            {axes}
            <Bar
              dataKey={metric}
              name={METRIC_LABELS[metric]}
              fill={CHART_ACCENT}
              radius={BAR_RADIUS}
              maxBarSize={28}
              className={onSelect ? 'cursor-pointer' : undefined}
            />
          </BarChart>
        ) : (
          <LineChart data={points} margin={{ top: 8, right: 8, bottom: 0, left: -18 }} onClick={handleClick}>
            {axes}
            <Line
              type="monotone"
              dataKey={metric}
              name={METRIC_LABELS[metric]}
              stroke={CHART_ACCENT}
              strokeWidth={1.5}
              // 数据点做小、去描边，避免密集数据时糊成一片
              dot={{ r: 1.5, fill: CHART_ACCENT, strokeWidth: 0 }}
              activeDot={{ r: 3.5, fill: CHART_ACCENT, stroke: 'var(--rs-paper)', strokeWidth: 1 }}
              className={onSelect ? 'cursor-pointer' : undefined}
            />
          </LineChart>
        )}
      </ResponsiveContainer>
    </div>
  );
}

/** recharts 的 onClick 回调形态在不同图表类型下不一致，这里统一从 state 里取出被点的数据 */
export function pickPoint(state: unknown): TimeSeriesPoint | null {
  if (!state || typeof state !== 'object') return null;
  const activePayload = (state as { activePayload?: Array<{ payload?: unknown }> }).activePayload;
  const payload = activePayload?.[0]?.payload;
  if (!payload || typeof payload !== 'object') return null;
  return payload as TimeSeriesPoint;
}
