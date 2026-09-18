import { ChevronLeft, ChevronRight } from 'lucide-react';
import type { ReactNode } from 'react';
import { Button } from './Button';

/**
 * 分页控件。
 * 后端所有列表接口都返回 { page, pageSize, total, totalPages }，直接消费该结构。
 */
export function Pagination({
  page,
  totalPages,
  total,
  pageSize,
  onChange,
  className,
}: {
  page: number;
  totalPages: number;
  total: number;
  pageSize?: number;
  onChange: (page: number) => void;
  className?: string;
}): ReactNode {
  if (total === 0) return null;

  const safeTotalPages = Math.max(1, totalPages);
  const start = pageSize ? (page - 1) * pageSize + 1 : null;
  const end = pageSize ? Math.min(page * pageSize, total) : null;

  return (
    <div className={`flex flex-wrap items-center justify-between gap-2 ${className ?? ''}`}>
      <span className="font-sans text-xs text-muted">
        {start && end ? `第 ${start}–${end} 条 / 共 ${total} 条` : `共 ${total} 条`}
      </span>

      <div className="flex items-center gap-1.5">
        <Button
          size="sm"
          variant="ghost"
          disabled={page <= 1}
          onClick={() => onChange(page - 1)}
          icon={<ChevronLeft size={13} />}
        >
          上一页
        </Button>
        <span className="font-sans text-xs text-ink-soft">
          {page} / {safeTotalPages}
        </span>
        <Button
          size="sm"
          variant="ghost"
          disabled={page >= safeTotalPages}
          onClick={() => onChange(page + 1)}
        >
          下一页
          <ChevronRight size={13} />
        </Button>
      </div>
    </div>
  );
}
