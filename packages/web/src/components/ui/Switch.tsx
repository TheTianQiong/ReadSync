import type { ReactNode } from 'react';
import { cn } from '../../lib/utils';

/**
 * 开关。
 *
 * 用 role="switch" 而不是伪装成 div 的 checkbox，键盘与读屏都能正确操作。
 * 滑块位置靠 justify 切换实现，不做位移动画（墨水屏刷新率低，动画只会显得拖影）。
 */
export function Switch({
  checked,
  onChange,
  disabled = false,
  label,
  description,
  className,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  label?: ReactNode;
  description?: ReactNode;
  className?: string;
}): ReactNode {
  const control = (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={typeof label === 'string' ? label : undefined}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        'inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-sm border p-0.5 transition-colors',
        checked ? 'justify-end border-accent bg-accent' : 'justify-start border-line-strong bg-raised',
        disabled && 'cursor-not-allowed opacity-50',
      )}
    >
      <span
        className={cn(
          'block size-3.5 rounded-[1px]',
          checked ? 'bg-accent-ink' : 'bg-surface dark:bg-muted',
        )}
      />
    </button>
  );

  if (!label && !description) return <span className={className}>{control}</span>;

  return (
    <div className={cn('flex items-start justify-between gap-3', className)}>
      <div className="min-w-0">
        <div className="font-sans text-sm text-ink">{label}</div>
        {description ? <div className="mt-0.5 font-sans text-xs text-muted">{description}</div> : null}
      </div>
      {control}
    </div>
  );
}
