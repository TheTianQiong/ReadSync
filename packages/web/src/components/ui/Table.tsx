import type { ReactNode, ThHTMLAttributes, TdHTMLAttributes } from 'react';
import { cn } from '../../lib/utils';

/**
 * 表格。
 * 只保留横向分隔线，没有竖线与斑马纹 —— 墨水屏上多余的线条会变成视觉噪声。
 */
export function Table({ children, className }: { children: ReactNode; className?: string }): ReactNode {
  return (
    <div className="w-full overflow-x-auto">
      <table className={cn('w-full border-collapse text-left font-sans text-sm', className)}>{children}</table>
    </div>
  );
}

export function THead({ children }: { children: ReactNode }): ReactNode {
  return <thead className="border-b border-line-strong">{children}</thead>;
}

export function TBody({ children }: { children: ReactNode }): ReactNode {
  return <tbody className="divide-y divide-line">{children}</tbody>;
}

export function TR({
  children,
  className,
  onClick,
}: {
  children: ReactNode;
  className?: string;
  onClick?: () => void;
}): ReactNode {
  return (
    <tr
      className={cn(onClick ? 'cursor-pointer transition-colors hover:bg-raised' : undefined, className)}
      onClick={onClick}
    >
      {children}
    </tr>
  );
}

export function TH({ children, className, ...props }: ThHTMLAttributes<HTMLTableCellElement>): ReactNode {
  return (
    <th
      {...props}
      className={cn('px-3 py-2 text-xs font-medium tracking-wide whitespace-nowrap text-muted', className)}
    >
      {children}
    </th>
  );
}

export function TD({ children, className, ...props }: TdHTMLAttributes<HTMLTableCellElement>): ReactNode {
  return (
    <td {...props} className={cn('px-3 py-2 align-middle text-ink-soft', className)}>
      {children}
    </td>
  );
}
