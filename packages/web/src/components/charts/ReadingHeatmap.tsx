import type { ReadingHeatmap as ReadingHeatmapData } from '@readsync/shared';
import type { ReactNode } from 'react';
import { useState } from 'react';
import { formatDuration, WEEKDAY_LABELS } from '../../lib/utils';
import { EmptyState } from '../ui/EmptyState';

const HOURS = Array.from({ length: 24 }, (_, hour) => hour);
/** 每 3 小时标一次刻度，24 个标签会把轴挤成一团 */
const HOUR_TICKS = new Set([0, 3, 6, 9, 12, 15, 18, 21]);

const WEEKDAY_FULL = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

/** 年份切换器的取值：'all' 表示全部历史 */
export type HeatmapYear = 'all' | string;

/** 某个年份对应的查询范围（含首尾）；'all' 表示不限 */
export function heatmapYearRange(year: HeatmapYear): { from?: string; to?: string } {
  if (year === 'all') return {};
  return { from: `${year}-01-01`, to: `${year}-12-31` };
}

/** 年份切换器的选项，由接口返回的「有阅读记录的年份」拼出来 */
export function heatmapYearOptions(years: number[]): Array<{ value: HeatmapYear; label: string }> {
  return [
    { value: 'all', label: '全部' },
    ...[...years].sort((a, b) => b - a).map((year) => ({ value: String(year), label: String(year) })),
  ];
}

/** 格子的文案：星期 + 时段 + 时长；悬停提示、无障碍标签与下钻标题共用同一句话 */
export function heatmapCellLabel(weekday: number, hour: number, seconds: number): string {
  const time = `${String(hour).padStart(2, '0')}:00`;
  return `${WEEKDAY_FULL[weekday] ?? ''} ${time} · ${seconds > 0 ? formatDuration(seconds) : '无阅读'}`;
}

/**
 * 星期 × 小时阅读热力图。
 *
 * recharts 没有热力图，硬用 ScatterChart 反而更难控制格子对齐与交互，
 * 所以这里直接用 CSS Grid 实现 —— 每个格子仍走同一套 CSS 变量配色，
 * 视觉上与其它图表保持一个体系。
 *
 * 强度用「强调色 + 透明度」表达，而不是引入第二套色阶：
 * 只有一档明度变化的灰蓝，最接近真实墨水屏的观感。
 *
 * 悬停时把格子的信息显示在图上方的一行里，而不是只依赖 `title`：
 * 原生提示要悬停一秒才出来、位置也不受控，格子又小，很容易让人觉得
 * 「看不出这是什么」。那一行同时承担键盘聚焦（focus）与点击后的回显。
 */
export function ReadingHeatmap({
  data,
  onSelect,
}: {
  data: ReadingHeatmapData | null;
  onSelect?: (cell: { weekday: number; hour: number; seconds: number }) => void;
}): ReactNode {
  /** 当前被指着（或刚点过）的格子，用来显示那一行说明 */
  const [focused, setFocused] = useState<{ weekday: number; hour: number; seconds: number } | null>(null);

  const cells = data?.cells ?? [];
  const maxSeconds = data?.maxSeconds ?? 0;

  if (cells.length === 0) {
    return <EmptyState title="暂无热力图数据" description="阅读时长上报后这里会显示时段分布" />;
  }

  // 后端可能只返回有点的格子，这里补零成完整矩阵，保证网格不错位
  const lookup = new Map<string, number>();
  for (const cell of cells) lookup.set(`${cell.weekday}-${cell.hour}`, cell.seconds);

  const intensity = (seconds: number): number => {
    if (seconds <= 0 || maxSeconds <= 0) return 0;
    // 开方让低时长的格子也可见，否则少数高峰会把其余格子压成全白
    return Math.min(1, Math.sqrt(seconds / maxSeconds));
  };

  return (
    <div className="w-full overflow-x-auto">
      <div className="min-w-[560px]">
        {/*
          说明行。高度固定（h-4），这样悬停来悬停去时网格不会上下跳。
          没有指着任何格子时显示总计，空着等于浪费一行位置。
        */}
        <div className="mb-1 flex h-4 items-center gap-1.5 font-sans text-[11px]">
          {focused ? (
            <>
              <span className="text-ink">{heatmapCellLabel(focused.weekday, focused.hour, focused.seconds)}</span>
              {focused.seconds > 0 && onSelect ? (
                <span className="text-faint">· 点击查看该时段的明细</span>
              ) : null}
            </>
          ) : (
            <span className="text-muted">
              共 {formatDuration(data?.totalSeconds ?? 0)}
              {onSelect ? ' · 点击任意格子查看该时段明细' : ''}
            </span>
          )}
        </div>

        <div className="flex">
          <div className="w-8 shrink-0" />
          <div className="grid flex-1 grid-cols-24 gap-px">
            {HOURS.map((hour) => (
              <div key={hour} className="pb-1 text-center font-sans text-[10px] text-faint">
                {HOUR_TICKS.has(hour) ? hour : ''}
              </div>
            ))}
          </div>
        </div>

        {WEEKDAY_LABELS.map((label, weekday) => (
          <div key={label} className="flex items-center">
            <div className="w-8 shrink-0 pr-1.5 text-right font-sans text-[10px] text-muted">{label}</div>
            <div className="grid flex-1 grid-cols-24 gap-px">
              {HOURS.map((hour) => {
                const seconds = lookup.get(`${weekday}-${hour}`) ?? 0;
                const level = intensity(seconds);
                const title = heatmapCellLabel(weekday, hour, seconds);
                // 没有时长的格子点了也只会弹出空列表，索性不可点
                const clickable = seconds > 0 && !!onSelect;

                return (
                  <button
                    key={hour}
                    type="button"
                    title={title}
                    aria-label={title}
                    onMouseEnter={() => setFocused({ weekday, hour, seconds })}
                    onMouseLeave={() => setFocused(null)}
                    onFocus={() => setFocused({ weekday, hour, seconds })}
                    onBlur={() => setFocused(null)}
                    onClick={() => clickable && onSelect?.({ weekday, hour, seconds })}
                    disabled={!clickable}
                    className="h-4 cursor-pointer rounded-[1px] border border-line transition-colors disabled:cursor-default"
                    style={
                      level > 0
                        ? {
                            backgroundColor: `color-mix(in oklab, var(--rs-chart-1) ${Math.round(
                              level * 92 + 8,
                            )}%, transparent)`,
                          }
                        : { backgroundColor: 'var(--rs-raised)' }
                    }
                  />
                );
              })}
            </div>
          </div>
        ))}

        <div className="mt-2 flex items-center justify-end gap-1.5 font-sans text-[10px] text-muted">
          <span>少</span>
          {[0.08, 0.3, 0.5, 0.72, 1].map((level) => (
            <span
              key={level}
              className="size-3 rounded-[1px] border border-line"
              style={{
                backgroundColor: `color-mix(in oklab, var(--rs-chart-1) ${Math.round(
                  level * 92 + 8,
                )}%, transparent)`,
              }}
            />
          ))}
          <span>多</span>
        </div>
      </div>
    </div>
  );
}
