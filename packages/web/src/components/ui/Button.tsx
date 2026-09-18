import type { ComponentPropsWithRef, ReactNode } from 'react';
import { cn } from '../../lib/utils';
import { Spinner } from './Spinner';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'quiet';
export type ButtonSize = 'sm' | 'md' | 'lg';

export interface ButtonProps extends ComponentPropsWithRef<'button'> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  /** 图标按钮只显示图标时，把文字留空但仍应传 aria-label */
  icon?: ReactNode;
}

/**
 * 按钮。
 *
 * hover 只改背景色，不做位移或阴影 —— 墨水屏的平面语言里没有「浮起」这一说。
 * primary 用低饱和靛青强调色，且全站只有关键操作会用到它。
 */
const VARIANTS: Record<ButtonVariant, string> = {
  primary: 'bg-accent text-accent-ink border border-accent hover:bg-accent/85',
  secondary: 'bg-surface text-ink border border-line hover:bg-raised',
  ghost: 'bg-transparent text-ink-soft border border-transparent hover:bg-raised hover:text-ink',
  quiet: 'bg-transparent text-muted border border-transparent hover:bg-raised hover:text-ink',
  danger: 'bg-transparent text-danger border border-danger/40 hover:bg-danger-soft hover:border-danger/70',
};

const SIZES: Record<ButtonSize, string> = {
  sm: 'h-7 gap-1 px-2 text-xs',
  md: 'h-9 gap-1.5 px-3 text-sm',
  lg: 'h-11 gap-2 px-5 text-sm',
};

export function Button({
  className,
  variant = 'secondary',
  size = 'md',
  loading = false,
  icon,
  children,
  disabled,
  type = 'button',
  ...props
}: ButtonProps): ReactNode {
  return (
    <button
      {...props}
      type={type}
      disabled={disabled || loading}
      className={cn(
        'inline-flex shrink-0 cursor-pointer items-center justify-center rounded-sm font-sans whitespace-nowrap transition-colors',
        'disabled:cursor-not-allowed disabled:opacity-45',
        VARIANTS[variant],
        SIZES[size],
        className,
      )}
    >
      {loading ? <Spinner size={size === 'sm' ? 12 : 14} /> : icon}
      {children}
    </button>
  );
}
