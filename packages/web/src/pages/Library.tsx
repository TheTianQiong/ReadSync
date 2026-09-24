import {
  BOOK_FORMATS,
  READING_STATUSES,
  type BookSummary,
  type ListBooksQuery,
  type Paginated,
} from '@readsync/shared';
import { BookOpen, BookPlus, Download, Plus, RefreshCw, Search, Trash2 } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { BookRegisterDialog } from '../components/BookRegisterDialog';
import { BookUploadDialog } from '../components/BookUploadDialog';
import { useAuth } from '../contexts/AuthContext';
import { Alert } from '../components/ui/Alert';
import { Badge, StatusBadge } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { Card, CardBody } from '../components/ui/Card';
import { EmptyState } from '../components/ui/EmptyState';
import { Input, Select } from '../components/ui/Input';
import { ConfirmDialog } from '../components/ui/Modal';
import { Pagination } from '../components/ui/Pagination';
import { PageSpinner } from '../components/ui/Spinner';
import { Table, TBody, TD, TH, THead, TR } from '../components/ui/Table';
import { useToast } from '../components/ui/Toast';
import { api } from '../lib/api';
import { downloadBookFile } from '../lib/download';
import { useAsync, useDebounced } from '../lib/hooks';
import { formatBytes, formatRelative } from '../lib/utils';

const STATUS_LABELS: Record<string, string> = {
  unread: '未读',
  reading: '在读',
  finished: '已读完',
  paused: '搁置',
  abandoned: '弃读',
};

const SORT_OPTIONS = [
  { value: 'createdAt', label: '入库时间' },
  { value: 'updatedAt', label: '更新时间' },
  { value: 'title', label: '书名' },
  { value: 'author', label: '作者' },
  { value: 'size', label: '文件大小' },
  { value: 'lastReadAt', label: '最近阅读' },
] as const;

const PAGE_SIZE = 20;

/**
 * 个人书库（README 要求 7）。
 *
 * 列表、搜索、过滤、排序、下载、删除都在本页；上传走 BookUploadDialog。
 * 书籍详情与版本历史在 /library/:id，点击行进入。
 */
export function Library(): ReactNode {
  const navigate = useNavigate();
  const toast = useToast();

  const [search, setSearch] = useState('');
  const debouncedSearch = useDebounced(search, 300);
  const [format, setFormat] = useState('');
  const [readingStatus, setReadingStatus] = useState('');
  const [sortBy, setSortBy] = useState<ListBooksQuery['sortBy']>('createdAt');
  const [page, setPage] = useState(1);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [registerOpen, setRegisterOpen] = useState(false);
  // 管理员可以关掉文件上传（站点设置），关闭后只保留「登记书目」
  const { settings } = useAuth();
  const uploadEnabled = settings?.uploadEnabled !== false;
  const [pendingDelete, setPendingDelete] = useState<BookSummary | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [downloadingId, setDownloadingId] = useState<number | null>(null);

  const { data, loading, error, reload } = useAsync(
    () =>
      api.get<Paginated<BookSummary>>('/books', {
        page,
        pageSize: PAGE_SIZE,
        q: debouncedSearch || undefined,
        format: format || undefined,
        readingStatus: readingStatus || undefined,
        sortBy,
        sortOrder: 'desc',
      }),
    [page, debouncedSearch, format, readingStatus, sortBy],
  );

  const books = data?.items ?? [];

  /** 筛选条件变化时回到第一页，否则会出现「第 3 页没有结果」的假空状态 */
  const resetToFirstPage = (): void => setPage(1);

  const handleDownload = async (book: BookSummary): Promise<void> => {
    setDownloadingId(book.id);
    try {
      await downloadBookFile(book.id, `${book.title}.${book.format}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '下载失败');
    } finally {
      setDownloadingId(null);
    }
  };

  const handleDelete = async (): Promise<void> => {
    if (!pendingDelete) return;
    setDeleting(true);
    try {
      await api.del(`/books/${pendingDelete.id}`);
      toast.success(`已删除《${pendingDelete.title}》`);
      setPendingDelete(null);
      reload();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '删除失败');
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-serif text-xl text-ink">个人书库</h1>
          <p className="mt-0.5 font-sans text-xs text-muted">
            共 {data?.total ?? 0} 本 · 文件保存在你配置的存储后端，本地仅做中转
          </p>
        </div>

        <div className="flex items-center gap-1.5">
          <Button size="sm" variant="ghost" icon={<RefreshCw size={13} />} onClick={reload}>
            刷新
          </Button>
          {uploadEnabled ? (
            <Button size="sm" variant="primary" icon={<Plus size={13} />} onClick={() => setUploadOpen(true)}>
              上传书籍
            </Button>
          ) : null}
          <Button
            size="sm"
            variant={uploadEnabled ? 'secondary' : 'primary'}
            icon={<BookPlus size={13} />}
            onClick={() => setRegisterOpen(true)}
          >
            登记书目
          </Button>
        </div>
      </header>

      <Card>
        <CardBody className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-52 flex-1">
            <Search size={13} className="absolute top-1/2 left-2.5 -translate-y-1/2 text-faint" />
            <Input
              value={search}
              onChange={(event) => {
                setSearch(event.target.value);
                resetToFirstPage();
              }}
              placeholder="搜索书名或作者…"
              className="pl-7"
            />
          </div>

          <Select
            value={format}
            onChange={(event) => {
              setFormat(event.target.value);
              resetToFirstPage();
            }}
            className="w-32"
          >
            <option value="">全部格式</option>
            {BOOK_FORMATS.map((item) => (
              <option key={item} value={item}>
                {item.toUpperCase()}
              </option>
            ))}
          </Select>

          <Select
            value={readingStatus}
            onChange={(event) => {
              setReadingStatus(event.target.value);
              resetToFirstPage();
            }}
            className="w-32"
          >
            <option value="">全部状态</option>
            {READING_STATUSES.map((item) => (
              <option key={item} value={item}>
                {STATUS_LABELS[item] ?? item}
              </option>
            ))}
          </Select>

          <Select
            value={sortBy}
            onChange={(event) => setSortBy(event.target.value as ListBooksQuery['sortBy'])}
            className="w-32"
          >
            {SORT_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                按{option.label}
              </option>
            ))}
          </Select>
        </CardBody>
      </Card>

      {loading ? (
        <PageSpinner label="正在读取书库…" />
      ) : error && !error.isMissing ? (
        <Alert tone="danger">{error.message}</Alert>
      ) : books.length === 0 ? (
        <EmptyState
          icon={<BookOpen size={22} />}
          title={debouncedSearch || format || readingStatus ? '没有匹配的书籍' : '书库还是空的'}
          description={
            debouncedSearch || format || readingStatus
              ? '试试调整搜索词或筛选条件'
              : uploadEnabled
                ? '支持 EPUB、PDF、MOBI、TXT、ZIP 等常见格式，上传后可在阅读器中通过同步接口关联'
                : '本站已关闭文件上传，填写书名与 MD5 即可登记 —— 阅读进度同步与统计都能正常工作'
          }
          action={
            uploadEnabled ? (
              <Button size="sm" variant="primary" icon={<Plus size={13} />} onClick={() => setUploadOpen(true)}>
                上传第一本书
              </Button>
            ) : (
              <Button
                size="sm"
                variant="primary"
                icon={<BookPlus size={13} />}
                onClick={() => setRegisterOpen(true)}
              >
                登记第一本书
              </Button>
            )
          }
        />
      ) : (
        <Card>
          <Table>
            <THead>
              <TR>
                <TH>书名</TH>
                <TH>格式</TH>
                <TH className="text-right">大小</TH>
                <TH>状态</TH>
                <TH className="text-right">进度</TH>
                <TH>最近阅读</TH>
                <TH className="text-right">操作</TH>
              </TR>
            </THead>
            <TBody>
              {books.map((book) => (
                <TR key={book.id} onClick={() => navigate(`/library/${book.id}`)}>
                  <TD className="max-w-64">
                    <div className="truncate font-serif text-sm text-ink">{book.title}</div>
                    <div className="truncate font-sans text-xs text-muted">
                      {book.author || '佚名'}
                      {book.currentVersion > 1 ? ` · v${book.currentVersion}` : ''}
                    </div>
                  </TD>
                  <TD>
                    <Badge tone="outline">{book.format.toUpperCase()}</Badge>
                  </TD>
                  <TD className="text-right whitespace-nowrap">{formatBytes(book.size)}</TD>
                  <TD>
                    <StatusBadge value={book.readingStatus} />
                  </TD>
                  <TD className="text-right whitespace-nowrap">{Math.round(book.progressPercent)}%</TD>
                  <TD className="whitespace-nowrap">{formatRelative(book.lastReadAt)}</TD>
                  <TD className="text-right">
                    {/* 阻止冒泡，否则点下载/删除会同时触发行跳转 */}
                    <div className="flex justify-end gap-1" onClick={(event) => event.stopPropagation()}>
                      {/* 只登记书目的书没有文件可下，按钮直接不给 —— 
                          点了必然 404，不如一开始就别让用户白点 */}
                      {book.hasFile ? (
                        <Button
                          size="sm"
                          variant="quiet"
                          aria-label={`下载 ${book.title}`}
                          loading={downloadingId === book.id}
                          icon={<Download size={13} />}
                          onClick={() => void handleDownload(book)}
                        />
                      ) : null}
                      <Button
                        size="sm"
                        variant="quiet"
                        aria-label={`删除 ${book.title}`}
                        className="hover:text-danger"
                        icon={<Trash2 size={13} />}
                        onClick={() => setPendingDelete(book)}
                      />
                    </div>
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>

          <div className="border-t border-line px-3 py-2">
            <Pagination
              page={data?.page ?? page}
              totalPages={data?.totalPages ?? 1}
              total={data?.total ?? 0}
              pageSize={data?.pageSize ?? PAGE_SIZE}
              onChange={setPage}
            />
          </div>
        </Card>
      )}

      <BookUploadDialog open={uploadOpen} onClose={() => setUploadOpen(false)} onUploaded={reload} />
      <BookRegisterDialog open={registerOpen} onClose={() => setRegisterOpen(false)} onRegistered={reload} />

      <ConfirmDialog
        open={pendingDelete !== null}
        onClose={() => setPendingDelete(null)}
        onConfirm={() => void handleDelete()}
        loading={deleting}
        title="删除书籍"
        confirmText="删除"
        message={
          <>
            确定要删除《{pendingDelete?.title}》吗？
            <br />
            该书的元数据、版本记录都会被移除，存储后端上的文件也会一并清理，此操作不可撤销。
          </>
        }
      />
    </div>
  );
}
