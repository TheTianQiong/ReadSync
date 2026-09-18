import type { ReactNode } from 'react';
import { cn } from '../../lib/utils';

/**
 * 卡片。
 * 1px 细边框 + 极浅的纸面色，不用阴影 —— 墨水屏上阴影会糊成一团灰。
 */
export function Card({
  className,
  children,
  ...props
}: { className?: string; children: ReactNode } & React.HTMLAttributes<HTMLDivElement>): ReactNode {
  return (
    <div {...props} className={cn('rounded-sm border border-line bg-surface', className)}>
      {children}
    </div>
  );
}

export interface CardHeaderProps {
  title: ReactNode;
  /** 标题下的一行说明 */
  description?: ReactNode;
  /** 右上角操作区（按钮、粒度切换等） */
  actions?: ReactNode;
  className?: string;
}

export function CardHeader({ title, description, actions, className }: CardHeaderProps): ReactNode {
  return (
    <div
      className={cn(
        'flex flex-wrap items-start justify-between gap-2 border-b border-line px-4 py-2.5',
        className,
      )}
    >
      <div className="min-w-0">
        <h3 className="font-sans text-sm font-medium text-ink">{title}</h3>
        {description ? <p className="mt-0.5 font-sans text-xs text-muted">{description}</p> : null}
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-1.5">{actions}</div> : null}
    </div>
  );
}

export function CardBody({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}): ReactNode {
  return <div className={cn('px-4 py-3', className)}>{children}</div>;
}

export function CardFooter({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}): ReactNode {
  return (
    <div className={cn('flex flex-wrap items-center justify-end gap-2 border-t border-line px-4 py-2.5', className)}>
      {children}
    </div>
  );
}

/** 关键数字卡片（首页/阅读状态的指标块） */
export function StatTile({
  label,
  value,
  sub,
  icon,
  className,
}: {
  label: ReactNode;
  value: ReactNode;
  sub?: ReactNode;
  icon?: ReactNode;
  className?: string;
}): ReactNode {
  return (
    <div className={cn('rounded-sm border border-line bg-surface px-3 py-3', className)}>
      <div className="flex items-center gap-1.5 font-sans text-xs text-muted">
        {icon}
        <span>{label}</span>
      </div>
      <div className="mt-1.5 font-serif text-2xl leading-none text-ink">{value}</div>
      {sub ? <div className="mt-1 font-sans text-xs text-muted">{sub}</div> : null}
    </div>
  );
}
