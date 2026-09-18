import type { ReactNode } from 'react';

/**
 * 图表 tooltip 的数据形状。
 *
 * 刻意不引用 recharts 的 TooltipContentProps：那个类型把 payload/active/coordinate
 * 等字段标成必填（它们由图表内部注入），一旦出现在组件 props 里，
 * `<Tooltip content={<ChartTooltip />} />` 这种写法就无法通过类型检查。
 * 这里只声明真正用得到的字段，把 recharts 的类型细节挡在图表组件内部。
 */
export interface ChartTooltipEntry {
  name?: unknown;
  value?: unknown;
  color?: string;
}

export interface ChartTooltipProps {
  active?: boolean;
  payload?: ChartTooltipEntry[];
  label?: unknown;
  /** 数值格式化，例如秒 → 「1 小时 5 分钟」 */
  formatter?: (value: number, name: string) => string;
  labelFormatter?: (label: unknown) => string;
}

/**
 * 图表 tooltip。
 *
 * recharts 默认的白底阴影气泡在墨水屏配色里很突兀，这里换成纸面色 + 细边框。
 */
export function ChartTooltip({
  active,
  payload,
  label,
  formatter,
  labelFormatter,
}: ChartTooltipProps): ReactNode {
  if (!active || !payload || payload.length === 0) return null;

  return (
    <div className="rounded-sm border border-line-strong bg-surface px-2.5 py-1.5 font-sans text-xs">
      {label !== undefined && label !== null ? (
        <div className="mb-1 text-ink">{labelFormatter ? labelFormatter(label) : String(label)}</div>
      ) : null}

      <div className="flex flex-col gap-0.5">
        {payload.map((entry, index) => {
          const value = typeof entry.value === 'number' ? entry.value : Number(entry.value ?? 0);
          const name = String(entry.name ?? '');

          return (
            <div key={`${name}-${index}`} className="flex items-center gap-1.5 text-ink-soft">
              <span
                className="inline-block size-2 shrink-0 rounded-[1px]"
                style={{ backgroundColor: entry.color ?? 'var(--rs-chart-1)' }}
              />
              {name ? <span className="text-muted">{name}</span> : null}
              <span>{formatter ? formatter(value, name) : String(value)}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/**
 * 生成 recharts 的 content 回调。
 *
 * 用函数形式而不是 JSX 元素：元素形式会被 TS 按 recharts 内部的 props 类型做上下文推断，
 * 参数写成 unknown 再自行收窄，既避开这层耦合，也保证 payload 缺失时不会崩。
 */
export function renderChartTooltip(options: {
  formatter?: (value: number, name: string) => string;
  labelFormatter?: (label: unknown) => string;
}): (props: unknown) => ReactNode {
  return (props: unknown) => {
    const { active, payload, label } = (props ?? {}) as ChartTooltipProps;
    return (
      <ChartTooltip
        active={active}
        payload={payload}
        label={label}
        formatter={options.formatter}
        labelFormatter={options.labelFormatter}
      />
    );
  };
}
