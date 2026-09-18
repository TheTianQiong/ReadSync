import type { Paginated, ReadingSessionDetail } from '@readsync/shared';
import { useMemo, useState, type ReactNode } from 'react';
import { useAsync } from '../lib/hooks';
import { api, type QueryValue } from '../lib/api';
import { formatDateTime, formatDuration, formatPercent } from '../lib/utils';
import { EmptyState, ErrorNote } from './ui/EmptyState';
import { Modal } from './ui/Modal';
import { Pagination } from './ui/Pagination';
import { PageSpinner } from './ui/Spinner';
import { Table, TBody, TD, TH, THead, TR } from './ui/Table';

const PAGE_SIZE = 20;

/**
 * 图表下钻明细（README 要求 5：「点击任意图表可以显示详细信息」）。
 *
 * 统一走 GET /api/stats/sessions，由调用方传入过滤条件：
 *  - 点趋势图的柱子 → { from: 该日, to: 该日 }
 *  - 点平台扇区     → { platform }
 *  - 点热力图格子   → 后端不一定支持星期/小时维度，因此额外用 clientFilter 在前端筛
 *
 * 端点尚未实现时（404）展示空状态，不让整页崩掉。
 */
export function SessionsModal({
  open,
  onClose,
  title,
  description,
  filters,
  clientFilter,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: ReactNode;
  filters?: Record<string, QueryValue>;
  clientFilter?: (session: ReadingSessionDetail) => boolean;
}): ReactNode {
  const [page, setPage] = useState(1);
  const filterKey = JSON.stringify(filters ?? {});

  const { data, loading, error } = useAsync(
    () =>
      api.get<Paginated<ReadingSessionDetail> | ReadingSessionDetail[]>('/stats/sessions', {
        ...(filters ?? {}),
        page,
        pageSize: PAGE_SIZE,
      }),
    [filterKey, page],
    { immediate: open },
  );

  const normalized = useMemo(() => normalizeSessions(data), [data]);

  const items = useMemo(
    () => (clientFilter ? normalized.items.filter(clientFilter) : normalized.items),
    [normalized.items, clientFilter],
  );

  const totalSeconds = items.reduce((sum, item) => sum + item.seconds, 0);

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      description={description}
      size="xl"
      footer={
        <span className="mr-auto font-sans text-xs text-muted">
          本页共 {items.length} 条 · 合计 {formatDuration(totalSeconds)}
        </span>
      }
    >
      {loading ? (
        <PageSpinner label="正在拉取阅读明细…" />
      ) : error && !error.isMissing ? (
        <ErrorNote message={error.message} />
      ) : items.length === 0 ? (
        <EmptyState title="该条件下没有阅读记录" description="换一个时间范围或平台再试试" />
      ) : (
        <div className="flex flex-col gap-3">
          <Table>
            <THead>
              <TR>
                <TH>开始时间</TH>
                <TH>书籍</TH>
                <TH>平台</TH>
                <TH>设备</TH>
                <TH className="text-right">时长</TH>
                <TH className="text-right">进度</TH>
              </TR>
            </THead>
            <TBody>
              {items.map((session) => (
                <TR key={session.id}>
                  <TD className="whitespace-nowrap">{formatDateTime(session.startedAt)}</TD>
                  <TD className="max-w-56 truncate">{session.bookTitle ?? '未关联书籍'}</TD>
                  <TD className="whitespace-nowrap">{session.platform}</TD>
                  <TD className="max-w-40 truncate">{session.device || '—'}</TD>
                  <TD className="text-right whitespace-nowrap">{formatDuration(session.seconds)}</TD>
                  <TD className="text-right whitespace-nowrap">
                    {session.progressPercent === null ? '—' : formatPercent(session.progressPercent)}
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>

          {normalized.totalPages > 1 ? (
            <Pagination
              page={page}
              totalPages={normalized.totalPages}
              total={normalized.total}
              pageSize={PAGE_SIZE}
              onChange={setPage}
            />
          ) : null}
        </div>
      )}
    </Modal>
  );
}

/** 后端返回分页信封，但端点未定稿前也可能直接给数组，两种都接住 */
function normalizeSessions(
  data: Paginated<ReadingSessionDetail> | ReadingSessionDetail[] | null,
): { items: ReadingSessionDetail[]; total: number; totalPages: number } {
  if (!data) return { items: [], total: 0, totalPages: 0 };

  if (Array.isArray(data)) {
    return { items: data, total: data.length, totalPages: 1 };
  }

  return {
    items: data.items ?? [],
    total: data.total ?? 0,
    totalPages: data.totalPages ?? 0,
  };
}
