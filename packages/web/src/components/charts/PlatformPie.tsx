import type { PlatformDistribution } from '@readsync/shared';
import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from 'recharts';
import type { ReactNode } from 'react';
import { formatDuration, formatPercent } from '../../lib/utils';
import { chartColor, CHART_GRID } from './chartTheme';
import { renderChartTooltip } from './ChartTooltip';
import { EmptyState } from '../ui/EmptyState';

/**
 * 阅读平台分布。
 *
 * 用环形图而不是实心饼图：中间的留白让占比标签更好读，
 * 也让整块图表更接近墨水屏上「空心圆环」的克制观感。
 * 点击扇区回调该平台的明细，用于下钻。
 */
export function PlatformPie({
  data,
  height = 220,
  onSelect,
}: {
  data: PlatformDistribution | null;
  height?: number;
  onSelect?: (platform: string) => void;
}): ReactNode {
  const items = data?.items ?? [];

  if (items.length === 0) {
    return <EmptyState title="暂无阅读平台数据" description="同步一次阅读进度后这里会出现分布情况" />;
  }

  return (
    <div className="flex flex-col items-center gap-3 sm:flex-row">
      <div style={{ width: '100%', maxWidth: 260, height }}>
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie
              data={items}
              dataKey="seconds"
              nameKey="label"
              innerRadius="52%"
              outerRadius="82%"
              paddingAngle={1}
              stroke={CHART_GRID}
              strokeWidth={1}
              className={onSelect ? 'cursor-pointer' : undefined}
              onClick={(entry: unknown) => {
                // 扇区点击回传原始数据项，取其中的 platform 标识
                const payload = (entry as { payload?: { platform?: string } } | null)?.payload;
                if (payload?.platform && onSelect) onSelect(payload.platform);
              }}
            >
              {items.map((item, index) => (
                <Cell key={item.platform} fill={chartColor(index)} />
              ))}
            </Pie>
            <Tooltip content={renderChartTooltip({ formatter: (value) => formatDuration(value) })} />
          </PieChart>
        </ResponsiveContainer>
      </div>

      {/* 自绘图例：recharts 的 Legend 排版在窄容器里容易换行错位 */}
      <ul className="flex w-full min-w-0 flex-col gap-1.5">
        {items.map((item, index) => (
          <li key={item.platform}>
            <button
              type="button"
              onClick={() => onSelect?.(item.platform)}
              disabled={!onSelect}
              className="flex w-full cursor-pointer items-center gap-2 rounded-sm px-1.5 py-1 text-left transition-colors hover:bg-raised disabled:cursor-default"
            >
              <span
                className="size-2.5 shrink-0 rounded-[1px]"
                style={{ backgroundColor: chartColor(index) }}
              />
              <span className="min-w-0 flex-1 truncate font-sans text-xs text-ink-soft">{item.label}</span>
              <span className="shrink-0 font-sans text-xs text-muted">
                {formatDuration(item.seconds, { compact: true })}
              </span>
              <span className="w-11 shrink-0 text-right font-sans text-xs text-ink">
                {formatPercent(item.percent)}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
