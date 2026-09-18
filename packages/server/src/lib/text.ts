/**
 * 终端显示宽度计算。
 *
 * JS 的 `String.length` 数的是 UTF-16 码元个数，而终端里中文、日文、韩文等
 * 全角字符占 **两列**。直接用 padEnd 对齐含中文的表格或边框，会出现参差不齐的
 * 锯齿（本项目 CLI 与启动横幅大量使用中文，因此必须处理）。
 *
 * 这里采用实用主义实现：覆盖常见的宽字符区间，不做完整的 Unicode East Asian
 * Width 表（那需要引入依赖，收益不成正比）。emoji 与部分生僻字可能仍会偏差，
 * 属于可接受的折衷。
 */

/** 宽字符（占两列）的码点区间 */
const WIDE_RANGES: Array<[number, number]> = [
  [0x1100, 0x115f], // 谚文字母
  [0x2e80, 0x303e], // 中日韩部首、标点（含全角空格 U+3000）
  [0x3041, 0x33ff], // 平假名、片假名、注音、中日韩兼容符号
  [0x3400, 0x4dbf], // 中日韩扩展 A
  [0x4e00, 0x9fff], // 中日韩统一表意文字
  [0xa000, 0xa4cf], // 彝文
  [0xac00, 0xd7a3], // 谚文音节
  [0xf900, 0xfaff], // 中日韩兼容表意文字
  [0xfe10, 0xfe19], // 竖排标点
  [0xfe30, 0xfe6f], // 中日韩兼容形式
  [0xff00, 0xff60], // 全角 ASCII
  [0xffe0, 0xffe6], // 全角符号
  [0x1f300, 0x1f64f], // emoji（终端通常渲染为两列）
  [0x1f900, 0x1f9ff],
  [0x20000, 0x2fffd], // 中日韩扩展 B 及以上
  [0x30000, 0x3fffd],
];

/** 零宽字符：组合记号、变体选择符等不占列 */
const ZERO_WIDTH_RANGES: Array<[number, number]> = [
  [0x0300, 0x036f], // 组合用附加符号
  [0x200b, 0x200f], // 零宽空格、方向标记
  [0xfe00, 0xfe0f], // 变体选择符
  [0xfeff, 0xfeff], // BOM
];

function inRanges(cp: number, ranges: Array<[number, number]>): boolean {
  for (const [start, end] of ranges) {
    if (cp >= start && cp <= end) return true;
  }
  return false;
}

/** 计算字符串在终端中占用的列数 */
export function displayWidth(text: string): number {
  let width = 0;
  // 用 for...of 按码点遍历，避免把代理对拆成两个字符重复计数
  for (const char of text) {
    const cp = char.codePointAt(0);
    if (cp === undefined) continue;
    if (inRanges(cp, ZERO_WIDTH_RANGES)) continue;
    width += inRanges(cp, WIDE_RANGES) ? 2 : 1;
  }
  return width;
}

/** 按显示宽度右侧补空格 */
export function padDisplayEnd(text: string, targetWidth: number): string {
  const pad = targetWidth - displayWidth(text);
  return pad > 0 ? text + ' '.repeat(pad) : text;
}

/** 按显示宽度左侧补空格 */
export function padDisplayStart(text: string, targetWidth: number): string {
  const pad = targetWidth - displayWidth(text);
  return pad > 0 ? ' '.repeat(pad) + text : text;
}

/**
 * 按显示宽度截断，超出部分用省略号替代。
 * 截断时保证不会把一个全角字符劈成两半。
 */
export function truncateDisplay(text: string, maxWidth: number, ellipsis = '…'): string {
  if (displayWidth(text) <= maxWidth) return text;

  const ellipsisWidth = displayWidth(ellipsis);
  const budget = maxWidth - ellipsisWidth;
  if (budget <= 0) return ellipsis;

  let out = '';
  let width = 0;
  for (const char of text) {
    const cp = char.codePointAt(0);
    const charWidth = cp === undefined || inRanges(cp, ZERO_WIDTH_RANGES) ? 0 : inRanges(cp, WIDE_RANGES) ? 2 : 1;
    if (width + charWidth > budget) break;
    out += char;
    width += charWidth;
  }
  return out + ellipsis;
}

/** 生成一条指定显示宽度的水平线，用于表格与边框 */
export function hLine(width: number, char = '─'): string {
  // 制表符与中文一样是宽字符，这里统一按 2 列算
  return char.repeat(Math.max(0, Math.floor(width / displayWidth(char))));
}
