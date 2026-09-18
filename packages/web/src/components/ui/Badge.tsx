import type { ReactNode } from 'react';
import { cn } from '../../lib/utils';

export type BadgeTone = 'neutral' | 'accent' | 'ochre' | 'danger' | 'outline';

const TONES: Record<BadgeTone, string> = {
  neutral: 'bg-raised text-ink-soft border-line',
  accent: 'bg-accent-soft text-accent border-accent/30',
  ochre: 'bg-ochre-soft text-ochre border-ochre/30',
  danger: 'bg-danger-soft text-danger border-danger/30',
  outline: 'bg-transparent text-muted border-line',
};

export function Badge({
  children,
  tone = 'neutral',
  className,
}: {
  children: ReactNode;
  tone?: BadgeTone;
  className?: string;
}): ReactNode {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-sm border px-1.5 py-0.5 font-sans text-[11px] leading-none whitespace-nowrap',
        TONES[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

/** 阅读状态等枚举 → 中文标签 + 色调 */
const STATUS_META: Record<string, { label: string; tone: BadgeTone }> = {
  unread: { label: '未读', tone: 'outline' },
  reading: { label: '在读', tone: 'accent' },
  finished: { label: '已读完', tone: 'ochre' },
  paused: { label: '搁置', tone: 'neutral' },
  abandoned: { label: '弃读', tone: 'danger' },
  active: { label: '正常', tone: 'ochre' },
  disabled: { label: '已停用', tone: 'danger' },
  enabled: { label: '已启用', tone: 'ochre' },
  error: { label: '异常', tone: 'danger' },
  admin: { label: '管理员', tone: 'accent' },
  user: { label: '普通用户', tone: 'neutral' },
};

export function StatusBadge({ value, className }: { value: string; className?: string }): ReactNode {
  const meta = STATUS_META[value] ?? { label: value, tone: 'neutral' as BadgeTone };
  return (
    <Badge tone={meta.tone} className={className}>
      {meta.label}
    </Badge>
  );
}
