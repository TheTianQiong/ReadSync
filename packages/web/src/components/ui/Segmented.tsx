import type { ReactNode } from 'react';
import { cn } from '../../lib/utils';

export interface SegmentedOption<T extends string> {
  value: T;
  label: ReactNode;
}

/**
 * 分段切换（图表时间粒度、设置页标签等）。
 * 选中态用纸面色反白 + 边框，而不是填充强调色，避免在灰阶页面上过于抢眼。
 */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
  size = 'md',
  className,
}: {
  options: ReadonlyArray<SegmentedOption<T>>;
  value: T;
  onChange: (value: T) => void;
  size?: 'sm' | 'md';
  className?: string;
}): ReactNode {
  return (
    <div
      role="tablist"
      className={cn('inline-flex items-center gap-px rounded-sm border border-line bg-raised p-px', className)}
    >
      {options.map((option) => {
        const active = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(option.value)}
            className={cn(
              'cursor-pointer rounded-[1px] font-sans transition-colors',
              size === 'sm' ? 'px-2 py-0.5 text-xs' : 'px-2.5 py-1 text-xs',
              active
                ? 'bg-surface text-ink shadow-none dark:bg-raised'
                : 'bg-transparent text-muted hover:text-ink',
            )}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
