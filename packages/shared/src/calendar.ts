/**
 * 全年日历的排布计算（一天一格，一列一周）。
 *
 * 为什么放在 shared 而不是图表组件里：这段是**纯日期数学** —— 闰年、区间起点
 * 落在周几、第一列前面要留几个空位、末尾要不要补齐、哪些格子属于区间之外。
 * 它错了不会报错，只会让整张图悄悄错位（「我明明周三读的，怎么画在周二」），
 * 而且只靠肉眼看图很难发现。放在这里，服务端的测试脚本就能直接断言它。
 *
 * 与 koreader.ts 同一个道理：跨端共用的、可测的纯逻辑，不塞进 DOM 组件。
 */

export interface CalendarDay {
  /** YYYY-MM-DD */
  date: string;
  seconds: number;
  /** 还在未来（截至今天的区间里不会有；按自然年看时才会有剩余的日子） */
  future: boolean;
}

/** 日期加减天数（纯日历运算，用 UTC 避免夏令时导致的 23/25 小时） */
export function shiftDay(day: string, deltaDays: number): string {
  const [y, m, d] = day.split('-').map(Number);
  const shifted = new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, (d ?? 1) + deltaDays));
  const mm = String(shifted.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(shifted.getUTCDate()).padStart(2, '0');
  return `${shifted.getUTCFullYear()}-${mm}-${dd}`;
}

/**
 * 「近一年」的区间：**以今天为基准往前推 365 天**（含今天），共 365 个格子。
 *
 * 不用自然年：用户想看的是「我最近一年读得怎么样」，跨年这件事跟他没关系；
 * 而且自然年在年初只有几天数据，图画出来大半是空的。
 */
export function recentYearRange(today: string): { from: string; to: string } {
  return { from: shiftDay(today, -364), to: today };
}

/**
 * 把 `[from, to]` 切成「周列」：每列 7 格（周一到周日）。
 *
 * 列的边界向外扩到整周：第一列从 `from` 所在周的周一开始，最后一列到 `to`
 * 所在周的周日结束。落在 `[from, to]` 之外的那些格子是 **null 占位**（画成透明），
 * 与「这一天在区间内但没读」（`seconds: 0`）是两回事 —— 混在一起会让区间首尾
 * 冒出一排假的「没读」。
 *
 * 一周从**周一**开始，与后端 `startOfWeek` 的口径一致（中文习惯）。
 */
export function buildCalendarWeeks(
  from: string,
  to: string,
  secondsByDay: Map<string, number>,
  today: string,
): Array<Array<CalendarDay | null>> {
  const start = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || start > end) return [];

  // 对齐到「from 所在周的周一」
  const mondayOffset = (start.getUTCDay() + 6) % 7;
  let cursor = new Date(start.getTime() - mondayOffset * 86_400_000);

  const weeks: Array<Array<CalendarDay | null>> = [];
  let week: Array<CalendarDay | null> = [];

  while (cursor <= end) {
    const date = `${cursor.getUTCFullYear()}-${String(cursor.getUTCMonth() + 1).padStart(2, '0')}-${String(
      cursor.getUTCDate(),
    ).padStart(2, '0')}`;

    if (date < from || date > to) {
      week.push(null);
    } else {
      week.push({ date, seconds: secondsByDay.get(date) ?? 0, future: date > today });
    }

    if (week.length === 7) {
      weeks.push(week);
      week = [];
    }
    cursor = new Date(cursor.getTime() + 86_400_000);
  }

  if (week.length > 0) {
    while (week.length < 7) week.push(null);
    weeks.push(week);
  }
  return weeks;
}

/** 每天的秒数 → 查表用的 Map（趋势接口返回的点直接喂进来） */
export function calendarSecondsMap(
  points: Array<{ date: string; seconds: number }>,
): Map<string, number> {
  const map = new Map<string, number>();
  for (const point of points) map.set(point.date, point.seconds);
  return map;
}
