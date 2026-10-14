import type { DeleteReadingSessionsResult, Paginated, ReadingSessionDetail } from '@readsync/shared';
import { Trash2 } from 'lucide-react';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useAsync } from '../lib/hooks';
import { api, ApiError, type QueryValue } from '../lib/api';
import { formatDate, formatDateTime, formatDuration, formatPercent } from '../lib/utils';
import { Button } from './ui/Button';
import { EmptyState, ErrorNote } from './ui/EmptyState';
import { Checkbox } from './ui/Input';
import { ConfirmDialog, Modal } from './ui/Modal';
import { Pagination } from './ui/Pagination';
import { PageSpinner } from './ui/Spinner';
import { Table, TBody, TD, TH, THead, TR } from './ui/Table';
import { useToast } from './ui/Toast';

const PAGE_SIZE = 20;

/**
 * 图表下钻明细（README 要求 5：「点击任意图表可以显示详细信息」）。
 *
 * 统一走 GET /api/stats/sessions，过滤条件**全部交给后端**：
 *  - 点趋势图的柱子 → { from: 该日, to: 该日 }
 *  - 点平台扇区     → { platform }
 *  - 点热力图格子   → { weekday, hour }（可能再带某个年份的 from/to）
 *
 * 这里曾经收一个 `clientFilter` 回调在前端筛，热力图用它按星期/小时过滤 ——
 * 那是个坑：**筛的只是当前这一页**（20 条，按时间倒序），而「周三 15 点」的
 * 会话几乎永远落不进最新 20 条里，于是点开永远是空列表。要筛就筛全部，
 * 那就只能交给后端；所以这个回调已删除，别再加回来。
 *
 * 记录可以删（单条或多条）：导入来的错误时长、自己误报的记录都得能清掉。
 * 删除只影响本账号，删完会通知调用方刷新图表 —— 图表的口径是「读时聚合」，
 * 不刷新的话屏幕上还留着刚删掉的时长。
 *
 * 端点尚未实现时（404）展示空状态，不让整页崩掉。
 */
export function SessionsModal({
  open,
  onClose,
  title,
  description,
  filters,
  onChanged,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: ReactNode;
  filters?: Record<string, QueryValue>;
  /** 删除成功后调用：让外面的图表重新取数 */
  onChanged?: () => void;
}): ReactNode {
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<ReadonlySet<number>>(() => new Set());
  const [pending, setPending] = useState<{ ids: number[]; label: string } | null>(null);
  const [deleting, setDeleting] = useState(false);
  const toast = useToast();
  const filterKey = JSON.stringify(filters ?? {});

  const { data, loading, error, reload } = useAsync(
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
  const items = normalized.items;

  // 换页或换筛选条件后，上一页的勾选不该跟过来（它们的 id 已经不在屏幕上了）
  useEffect(() => {
    setSelected(new Set());
  }, [filterKey, page]);

  const totalSeconds = items.reduce((sum, item) => sum + item.seconds, 0);
  const selectedSeconds = items
    .filter((item) => selected.has(item.id))
    .reduce((sum, item) => sum + item.seconds, 0);
  const allSelected = items.length > 0 && items.every((item) => selected.has(item.id));

  const toggleAll = (): void => {
    setSelected(allSelected ? new Set() : new Set(items.map((item) => item.id)));
  };

  const toggleOne = (id: number): void => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleDelete = async (): Promise<void> => {
    if (!pending) return;
    setDeleting(true);
    try {
      const result = await api.post<DeleteReadingSessionsResult>('/stats/sessions/delete', {
        ids: pending.ids,
      });
      toast.success(
        `已删除 ${result.deleted} 条阅读记录` + (result.books > 0 ? `，书目时长同步扣减` : ''),
      );
      setPending(null);
      setSelected(new Set());
      /*
       * 整页被删空时退回上一页，否则会停在一个空列表上 ——
       * 看起来像「记录全没了」，其实只是页码越界了。
       */
      if (result.deleted >= items.length && page > 1) setPage(page - 1);
      else reload();
      onChanged?.();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : '删除失败，请稍后重试');
    } finally {
      setDeleting(false);
    }
  };

  return (
    <>
      <Modal
        open={open}
        onClose={onClose}
        title={title}
        description={description}
        size="xl"
        footer={
          <>
            <span className="mr-auto font-sans text-xs text-muted">
              本页共 {items.length} 条 · 合计 {formatDuration(totalSeconds)}
              {selected.size > 0 ? (
                <span className="ml-2 text-ink-soft">
                  已选 {selected.size} 条（{formatDuration(selectedSeconds)}）
                </span>
              ) : null}
            </span>

            <Button
              variant="danger"
              size="sm"
              icon={<Trash2 size={13} />}
              disabled={selected.size === 0}
              onClick={() =>
                setPending({ ids: [...selected], label: `选中的 ${selected.size} 条记录` })
              }
            >
              删除选中
            </Button>
          </>
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
                  <TH className="w-8">
                    <Checkbox
                      checked={allSelected}
                      onChange={toggleAll}
                      aria-label="选中本页全部记录"
                    />
                  </TH>
                  <TH>开始时间</TH>
                  <TH>书籍</TH>
                  <TH>平台</TH>
                  <TH>设备</TH>
                  <TH className="text-right">时长</TH>
                  <TH className="text-right">进度</TH>
                  <TH className="w-10" />
                </TR>
              </THead>
              <TBody>
                {items.map((session) => (
                  <TR key={session.id}>
                    <TD>
                      <Checkbox
                        checked={selected.has(session.id)}
                        onChange={() => toggleOne(session.id)}
                        aria-label="选中这条记录"
                      />
                    </TD>
                    <TD className="whitespace-nowrap">
                      {/*
                        只有日粒度的数据源（Anx Reader 只记到「哪天」）不知道具体时刻，
                        这时如实说「时间未知」—— 显示 00:00 会被当成真的半夜读过书。
                      */}
                      {session.hourKnown ? (
                        formatDateTime(session.startedAt)
                      ) : (
                        <span className="text-muted">
                          {formatDate(session.startedAt)}
                          <span className="ml-1 text-faint">时间未知</span>
                        </span>
                      )}
                    </TD>
                    <TD className="max-w-56 truncate">{session.bookTitle ?? '未关联书籍'}</TD>
                    <TD className="whitespace-nowrap">{session.platform}</TD>
                    <TD className="max-w-40 truncate">{session.device || '—'}</TD>
                    <TD className="text-right whitespace-nowrap">{formatDuration(session.seconds)}</TD>
                    <TD className="text-right whitespace-nowrap">
                      {session.progressPercent === null ? '—' : formatPercent(session.progressPercent)}
                    </TD>
                    <TD className="text-right">
                      <Button
                        variant="quiet"
                        size="sm"
                        aria-label="删除这条记录"
                        icon={<Trash2 size={13} />}
                        onClick={() =>
                          setPending({
                            ids: [session.id],
                            label: `${session.bookTitle ?? '未关联书籍'} · ${formatDuration(session.seconds)}`,
                          })
                        }
                      />
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

      <ConfirmDialog
        open={pending !== null}
        onClose={() => setPending(null)}
        onConfirm={() => void handleDelete()}
        loading={deleting}
        title="删除阅读记录"
        confirmText="删除"
        message={
          <>
            确定删除{pending?.label ?? '这条记录'}吗？删除后无法恢复。
            <br />
            这些记录若来自同步导入，上游那天的数据不变就不会自己回来。
          </>
        }
      />
    </>
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
