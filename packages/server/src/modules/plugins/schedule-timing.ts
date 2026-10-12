/**
 * 插件周期任务的触发时刻。
 *
 * 原来的做法是「注册时起一个 setInterval」：服务在 10:03:17 启动，那个插件就
 * 永远在 :03:17 跑。两件事都因此变糟：
 *
 *  1. **所有插件挤在同一瞬间**。它们都在服务启动那一刻注册，于是一起触发 ——
 *     几个导入插件同时去连网盘、同时写库，白白制造一个尖峰。
 *  2. **触发时刻取决于重启时间**。重启一次，全站的同步时刻就整体挪一次，
 *     用户看到的「每天 8 点同步」其实从来没落在 8 点附近。
 *
 * 现在按「整点对齐 + 每个插件固定偏移」来排：
 *
 *     触发时刻 = k × 周期 + 偏移（k 为整数）
 *
 * 60 分钟的任务于是落在每小时的 HH:00±偏移，24 小时的任务落在每天同一时刻。
 * 偏移由 **插件 id + 任务名** 哈希而来，所以：不同插件错开（缓解尖峰），
 * 同一个插件每次重启都落在同一个时刻（不会漂）。
 *
 * 这两个函数都是纯函数，方便断言 —— 定时器本身的正确性很难等到真跑一轮。
 */

/**
 * 偏移窗口半径（分钟）：允许在整点前 3 分钟到整点后 3 分钟之间。
 *
 * 取值要小：偏移的用途是「把同时触发的任务摊开」，不是「随便挑个时间」。
 * 摊在 ±3 分钟内既能分开几个插件，又不会让「每小时同步一次」变成
 * 「每小时的 57 分同步」那种让人看不懂的时刻。
 */
export const SCHEDULE_OFFSET_WINDOW_MINUTES = 3;

/** 字符串 → 稳定的非负整数（FNV-1a）。用来给插件 id + 任务名派一个固定的偏移 */
function hashString(value: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    // 乘 16777619，用移位相加避免 32 位溢出后丢精度
    hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0;
  }
  return hash >>> 0;
}

/**
 * 这个任务的固定偏移（分钟，可能为负）。
 *
 * 确定性是刻意的：随机偏移会让「重启后触发时刻变了」这件事变得无法解释，
 * 而固定偏移最多是「这个插件就在 :02 跑」，用户看两次就记住了。
 */
export function scheduleOffsetMinutes(
  pluginId: string,
  taskName: string,
  windowMinutes: number = SCHEDULE_OFFSET_WINDOW_MINUTES,
): number {
  const window = Math.max(0, Math.floor(windowMinutes));
  if (window === 0) return 0;
  // 取值区间：[-window, +window]，共 2*window+1 个可能
  return (hashString(`${pluginId}:${taskName}`) % (window * 2 + 1)) - window;
}

/**
 * 距离下一次触发还有多少毫秒。
 *
 * `periodMs` 必须为正。返回的延迟严格大于 0 且不超过一个周期 —— 对齐之后
 * 时间点可能刚好落在「现在」，那种情况下要取下一个周期，否则会立刻触发，
 * 接着又立刻触发（每次重排都命中同一个过去的时间点）。
 *
 * 最小延迟留了 1 秒：任务跑完再重排时，如果算出来的目标时刻就是这一瞬间，
 * 不留余量会变成忙等。
 */
export function nextAlignedDelayMs(
  nowMs: number,
  periodMs: number,
  offsetMs: number,
  minDelayMs = 1000,
): number {
  if (!Number.isFinite(periodMs) || periodMs <= 0) {
    throw new Error('周期必须为正数');
  }

  // 目标时刻 t 满足 t ≡ offsetMs (mod periodMs)。上面那个对齐点到「现在」的
  // 距离正好是「周期 - 已过去的部分」，所以延迟 = periodMs - mod(now - offset, period)。
  let delay = periodMs - mod(nowMs - offsetMs, periodMs);

  // 已经贴到触发点（或只剩几百毫秒）时，等下一个周期 —— 否则会立刻触发，
  // 重排后又立刻命中同一瞬间，变成忙等
  if (delay < minDelayMs) delay += periodMs;
  return delay;
}

/** 取模，结果恒为非负（JS 的 % 对负数返回负值） */
function mod(value: number, divisor: number): number {
  const rest = value % divisor;
  return rest < 0 ? rest + divisor : rest;
}

/** 把偏移渲染成人读的样子：0 → 「整点」；+2 → 「整点后 2 分」；-1 → 「整点前 1 分」 */
export function describeOffset(offsetMinutes: number): string {
  if (offsetMinutes === 0) return '整点';
  return offsetMinutes > 0 ? `整点后 ${offsetMinutes} 分` : `整点前 ${-offsetMinutes} 分`;
}
