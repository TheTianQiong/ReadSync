import { Inbox } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '../../lib/utils';

/**
 * 空状态 / 降级占位。
 *
 * 后端模块并行开发期间，部分端点会返回 404，此时页面应该显示这个组件
 * 而不是抛错或留白，因此 instructions 与 description 都允许传具体原因。
 */
export function EmptyState({
  title = '暂无数据',
  description,
  action,
  icon,
  className,
}: {
  title?: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  icon?: ReactNode;
  className?: string;
}): ReactNode {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center gap-2 rounded-sm border border-dashed border-line px-6 py-12 text-center',
        className,
      )}
    >
      <div className="text-faint">{icon ?? <Inbox size={22} />}</div>
      <p className="font-sans text-sm text-ink-soft">{title}</p>
      {description ? <p className="max-w-md font-sans text-xs text-muted">{description}</p> : null}
      {action ? <div className="mt-1.5">{action}</div> : null}
    </div>
  );
}

/** 行内错误提示（列表拉取失败但页面仍可用时使用） */
export function ErrorNote({
  message,
  action,
  className,
}: {
  message: ReactNode;
  action?: ReactNode;
  className?: string;
}): ReactNode {
  return (
    <div
      className={cn(
        'flex flex-wrap items-center justify-between gap-2 rounded-sm border border-danger/30 bg-danger-soft px-3 py-2 font-sans text-xs text-danger',
        className,
      )}
    >
      <span>{message}</span>
      {action}
    </div>
  );
}
