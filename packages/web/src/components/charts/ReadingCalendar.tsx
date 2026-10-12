import type { CalendarDay } from '@readsync/shared';
import { buildCalendarWeeks, calendarSecondsMap, recentYearRange, shiftDay } from '@readsync/shared';
import type { ReactNode } from 'react';
import { useState } from 'react';
import { cn, formatDuration } from '../../lib/utils';
import { EmptyState } from '../ui/EmptyState';

/**
 * 全年阅读日历（GitHub 贡献图那种：一天一格，一列一周）。
 *
 * 与「星期 × 小时」那张热力图分工不同：
 *  - 那张看**作息**（我通常在周几几点读），是长期习惯的画像；
 *  - 这张看**坚持**（今年哪天读了、断了没有、最长连读多久），是时间轴。
 *
 * 数据来自 `/stats/trend?granularity=day&from=年初&to=年末` —— 那条接口会把
 * 没读的日子补成 0，正好是一格一天要的形状，不必再为日历加一个端点。
 *
 * 格子强度与热力图用同一套表达式（强调色 + 透明度 + 开方），两张图并排看不会打架。
 * 「哪一天落在哪一列」那套日期数学在 shared（可被服务端测试断言，见 calendar.ts）。
 */

export { buildCalendarWeeks, calendarSecondsMap, recentYearRange, shiftDay };

/** 行序：周一到周日（与 startOfWeek 的口径一致：中文习惯一周从周一算） */
const WEEKDAY_ROWS = ['一', '二', '三', '四', '五', '六', '日'];
/** 左侧只标这三天，七天全标会把列挤散（GitHub 也是这么干的） */
const LABELED_ROWS = new Set([0, 2, 4]);

const MONTH_LABELS = ['1月', '2月', '3月', '4月', '5月', '6月', '7月', '8月', '9月', '10月', '11月', '12月'];

/** 每月的第一周落在第几列（用来把月份标签摆在左边） */
function monthStarts(weeks: Array<Array<CalendarDay | null>>): Array<{ key: string; label: string; weekIndex: number }> {
  const out: Array<{ key: string; label: string; weekIndex: number }> = [];
  let lastMonth = '';

  weeks.forEach((week, weekIndex) => {
    // 一周只看第一格在区间内的日子：跨月的那周不该被算两次
    const first = week.find((cell): cell is CalendarDay => cell !== null);
    if (!first) return;

    const month = first.date.slice(0, 7);
    if (month === lastMonth) return;
    lastMonth = month;
    out.push({
      // key 用「年-月」：跨年的区间（近一年）里 1 月会出现两次，只按月会撞 key
      key: month,
      label: MONTH_LABELS[Number(month.slice(5, 7)) - 1] ?? month,
      weekIndex,
    });
  });
  return out;
}

export function ReadingCalendar({
  label,
  from,
  to,
  weeks,
  onSelect,
}: {
  /** 区间名（「近一年」「2026 年」），只用在说明行里 */
  label: string;
  from: string;
  to: string;
  weeks: Array<Array<CalendarDay | null>>;
  onSelect?: (day: CalendarDay) => void;
}): ReactNode {
  const [focused, setFocused] = useState<CalendarDay | null>(null);

  const allDays = weeks.flat().filter((day): day is CalendarDay => day !== null);
  if (allDays.length === 0) {
    return <EmptyState title="暂无日历数据" description="阅读时长上报后这里会显示这段日期的打卡" />;
  }

  const maxSeconds = allDays.reduce((max, day) => (day.future ? max : Math.max(max, day.seconds)), 0);
  const activeDays = allDays.filter((day) => !day.future && day.seconds > 0).length;
  const totalSeconds = allDays.reduce((sum, day) => sum + (day.future ? 0 : day.seconds), 0);

  const intensity = (seconds: number): number => {
    if (seconds <= 0 || maxSeconds <= 0) return 0;
    return Math.min(1, Math.sqrt(seconds / maxSeconds));
  };

  // 说清覆盖了哪一段：用户看「读过几天」时必须知道这是哪一年的几天
  const summary = `${label}（${from} ~ ${to}）· 读过 ${activeDays} 天 · 合计 ${formatDuration(totalSeconds)}`;

  return (
    <div className="w-full overflow-x-auto">
      <div className="min-w-[720px]">
        {/* 说明行：悬停时显示那一天，否则显示全年小结（与热力图同一套做法） */}
        <div className="mb-1 flex h-4 items-center gap-1.5 font-sans text-[11px]">
          {focused ? (
            <>
              <span className="text-ink">
                {focused.date}
                {focused.future
                  ? ' · 还没到'
                  : ` · ${focused.seconds > 0 ? formatDuration(focused.seconds) : '没有阅读'}`}
              </span>
              {!focused.future && focused.seconds > 0 && onSelect ? (
                <span className="text-faint">· 点击查看当天明细</span>
              ) : null}
            </>
          ) : (
            <span className="text-muted">
              {summary}
              {onSelect ? ' · 点击有阅读的日子查看明细' : ''}
            </span>
          )}
        </div>

        {/* 月份标签：按列位置百分比摆，不依赖具体像素宽度 */}
        <div className="flex">
          <div className="w-5 shrink-0" />
          <div className="relative h-4 flex-1">
            {monthStarts(weeks).map((month) => (
              <span
                key={month.key}
                className="absolute font-sans text-[10px] text-muted"
                style={{ left: `${(month.weekIndex / Math.max(1, weeks.length)) * 100}%` }}
              >
                {month.label}
              </span>
            ))}
          </div>
        </div>

        <div className="flex">
          {/* 星期标签：只标一/三/五，且与格子行高对齐 */}
          <div className="flex w-5 shrink-0 flex-col gap-px pt-px">
            {WEEKDAY_ROWS.map((label, index) => (
              <span key={label} className="h-2.5 font-sans text-[9px] leading-none text-faint">
                {LABELED_ROWS.has(index) ? label : ''}
              </span>
            ))}
          </div>

          <div className="flex gap-px">
            {weeks.map((week, weekIndex) => (
              <div key={weekIndex} className="flex flex-col gap-px">
                {week.map((day, rowIndex) => {
                  if (!day) {
                    // 日历边界外的占位：透明，什么都不画
                    return <span key={rowIndex} className="size-2.5" />;
                  }

                  const level = intensity(day.seconds);
                  const title = day.future
                    ? `${day.date} · 还没到`
                    : `${day.date} · ${day.seconds > 0 ? formatDuration(day.seconds) : '没有阅读'}`;
                  const clickable = !day.future && day.seconds > 0 && !!onSelect;

                  return (
                    <button
                      key={rowIndex}
                      type="button"
                      title={title}
                      aria-label={title}
                      onMouseEnter={() => setFocused(day)}
                      onMouseLeave={() => setFocused(null)}
                      onFocus={() => setFocused(day)}
                      onBlur={() => setFocused(null)}
                      onClick={() => clickable && onSelect?.(day)}
                      disabled={!clickable}
                      className={cn(
                        'size-2.5 rounded-[1px] border transition-colors',
                        day.future ? 'border-transparent bg-transparent' : 'border-line',
                        clickable ? 'cursor-pointer' : 'cursor-default',
                      )}
                      style={
                        level > 0
                          ? {
                              backgroundColor: `color-mix(in oklab, var(--rs-chart-1) ${Math.round(
                                level * 92 + 8,
                              )}%, transparent)`,
                            }
                          : { backgroundColor: day.future ? 'transparent' : 'var(--rs-raised)' }
                      }
                    />
                  );
                })}
              </div>
            ))}
          </div>
        </div>

        <div className="mt-2 flex items-center justify-end gap-1.5 font-sans text-[10px] text-muted">
          <span>少</span>
          {[0.08, 0.3, 0.5, 0.72, 1].map((level) => (
            <span
              key={level}
              className="size-2.5 rounded-[1px] border border-line"
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


