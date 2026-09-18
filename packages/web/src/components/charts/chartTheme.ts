/**
 * 图表统一视觉参数。
 *
 * 颜色一律走 CSS 变量（index.css 里 :root / .dark 两套值），
 * 这样主题切换不需要让 recharts 重渲染，也不会在代码里散落十六进制色值。
 */

export const CHART_COLORS = [
  'var(--rs-chart-1)',
  'var(--rs-chart-2)',
  'var(--rs-chart-3)',
  'var(--rs-chart-4)',
  'var(--rs-chart-5)',
  'var(--rs-chart-6)',
] as const;

export function chartColor(index: number): string {
  return CHART_COLORS[index % CHART_COLORS.length] ?? CHART_COLORS[0];
}

export const CHART_GRID = 'var(--rs-chart-grid)';
export const CHART_AXIS = 'var(--rs-chart-axis)';
export const CHART_ACCENT = 'var(--rs-chart-1)';

/** 坐标轴文字：小字号无衬线，颜色淡到只作参考 */
export const AXIS_TICK_STYLE = {
  fontSize: 11,
  fontFamily: 'var(--font-sans)',
  fill: CHART_AXIS,
} as const;

/** 极小圆角，与卡片的 2px 圆角体系一致 */
export const BAR_RADIUS: [number, number, number, number] = [1, 1, 0, 0];
