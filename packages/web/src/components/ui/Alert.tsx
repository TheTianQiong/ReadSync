import { CircleAlert, CircleCheck, Info, TriangleAlert } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '../../lib/utils';

export type AlertTone = 'info' | 'success' | 'warning' | 'danger';

const TONES: Record<AlertTone, { className: string; icon: ReactNode }> = {
  info: { className: 'border-line bg-raised text-ink-soft', icon: <Info size={14} /> },
  success: { className: 'border-ochre/30 bg-ochre-soft text-ochre', icon: <CircleCheck size={14} /> },
  warning: { className: 'border-ochre/30 bg-ochre-soft text-ochre', icon: <TriangleAlert size={14} /> },
  danger: { className: 'border-danger/30 bg-danger-soft text-danger', icon: <CircleAlert size={14} /> },
};

/** 表单级提示条。错误信息一律用 danger，成功用赭石色（低饱和，不刺眼） */
export function Alert({
  tone = 'info',
  children,
  className,
  actions,
}: {
  tone?: AlertTone;
  children: ReactNode;
  className?: string;
  actions?: ReactNode;
}): ReactNode {
  const meta = TONES[tone];

  return (
    <div
      role={tone === 'danger' ? 'alert' : undefined}
      className={cn(
        'flex items-start gap-2 rounded-sm border px-3 py-2 font-sans text-xs leading-relaxed',
        meta.className,
        className,
      )}
    >
      <span className="mt-px shrink-0">{meta.icon}</span>
      <div className="min-w-0 flex-1 break-words">{children}</div>
      {actions ? <div className="shrink-0">{actions}</div> : null}
    </div>
  );
}
