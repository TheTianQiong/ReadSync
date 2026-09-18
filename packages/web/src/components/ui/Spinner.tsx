import { cn } from '../../lib/utils';

/**
 * 加载指示器。
 * 墨水屏风格下不用彩色 spinner，只用一圈墨色细弧。
 */
export function Spinner({ className, size = 16 }: { className?: string; size?: number }): React.ReactNode {
  return (
    <svg
      className={cn('animate-spin text-muted', className)}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2" opacity="0.25" />
      <path
        d="M21 12a9 9 0 0 0-9-9"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  );
}

/** 整页/整块区域的加载占位 */
export function PageSpinner({ label = '载入中…' }: { label?: string }): React.ReactNode {
  return (
    <div className="flex min-h-40 flex-col items-center justify-center gap-3 py-16 text-muted">
      <Spinner size={22} />
      <span className="font-sans text-xs tracking-wide">{label}</span>
    </div>
  );
}
