import {
  READING_STATUSES,
  type BookDetail as BookDetailData,
  type BookDocumentIds,
  type BookVersion,
} from '@readsync/shared';
import { ArrowLeft, Download, Fingerprint, History, Pencil, Plus, RotateCcw, Save, Trash2, Upload, X } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { BookUploadDialog } from '../components/BookUploadDialog';
import { Alert } from '../components/ui/Alert';
import { Badge, StatusBadge } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { Card, CardBody, CardHeader, StatTile } from '../components/ui/Card';
import { EmptyState } from '../components/ui/EmptyState';
import { Field, Input, Select, Textarea } from '../components/ui/Input';
import { ConfirmDialog, Modal } from '../components/ui/Modal';
import { PageSpinner } from '../components/ui/Spinner';
import { Table, TBody, TD, TH, THead, TR } from '../components/ui/Table';
import { useToast } from '../components/ui/Toast';
import { api } from '../lib/api';
import { downloadBookFile } from '../lib/download';
import { useAsync } from '../lib/hooks';
import { formatBytes, formatDateTime, formatDuration, parseTags } from '../lib/utils';

const STATUS_LABELS: Record<string, string> = {
  unread: '未读',
  reading: '在读',
  finished: '已读完',
  paused: '搁置',
  abandoned: '弃读',
};

/**
 * 书籍详情 + 版本历史（README 要求 7）。
 *
 * 服务端在 GET /api/books/:id 里已经返回 versions，因此版本历史不需要单独请求。
 * 回滚会把历史版本的内容重新复制成最新版本（服务端语义），所以回滚后仍需 reload。
 */
export function BookDetail(): ReactNode {
  const params = useParams<{ id: string }>();
  const bookId = Number(params.id);
  const navigate = useNavigate();
  const toast = useToast();

  const [editOpen, setEditOpen] = useState(false);
  const [versionOpen, setVersionOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [pendingRestore, setPendingRestore] = useState<BookVersion | null>(null);
  const [busy, setBusy] = useState(false);
  const [downloading, setDownloading] = useState(false);

  // 文档标识：补充 / 移除
  const [newDocumentId, setNewDocumentId] = useState('');
  const [newDocumentLabel, setNewDocumentLabel] = useState('');
  const [addingDocumentId, setAddingDocumentId] = useState(false);
  const [documentError, setDocumentError] = useState<string | null>(null);
  const [documentNotice, setDocumentNotice] = useState<string | null>(null);
  const [editingPrimary, setEditingPrimary] = useState(false);
  const [primaryDraft, setPrimaryDraft] = useState('');
  const [savingPrimary, setSavingPrimary] = useState(false);

  const { data: book, loading, error, reload } = useAsync(
    () => api.get<BookDetailData>(`/books/${bookId}`),
    [bookId],
    { immediate: Number.isFinite(bookId) && bookId > 0 },
  );

  if (!Number.isFinite(bookId) || bookId <= 0) {
    return (
      <EmptyState
        title="无效的书籍 ID"
        action={
          <Button size="sm" onClick={() => navigate('/library')}>
            返回书库
          </Button>
        }
      />
    );
  }

  if (loading) return <PageSpinner label="正在读取书籍信息…" />;

  if (error || !book) {
    return (
      <EmptyState
        title={error?.isMissing ? '这本书不存在' : (error?.message ?? '加载失败')}
        description="它可能已被删除，或者你没有访问权限"
        action={
          <Button size="sm" onClick={() => navigate('/library')}>
            返回书库
          </Button>
        }
      />
    );
  }

  /**
   * 补充一个文档标识。
   *
   * 服务端会顺带回填该标识下已有的进度与会话，所以补完要 reload ——
   * 否则页面上的进度还是补之前的旧值，用户会以为没生效。
   */
  const handleAddDocumentId = async (): Promise<void> => {
    const value = newDocumentId.trim();
    if (!/^[a-fA-F0-9]{32}$/.test(value)) {
      setDocumentError('文档标识是 32 位十六进制，请照抄阅读器里显示的那个值');
      return;
    }

    setAddingDocumentId(true);
    setDocumentError(null);
    setDocumentNotice(null);
    try {
      const result = await api.post<{
        relinked: { syncEntries: number; sessions: number };
        documents: BookDocumentIds;
      }>(`/books/${bookId}/documents`, {
        documentId: value,
        ...(newDocumentLabel.trim() ? { label: newDocumentLabel.trim() } : {}),
      });

      const { syncEntries, sessions } = result.relinked;
      setNewDocumentId('');
      setNewDocumentLabel('');
      setDocumentNotice(
        syncEntries > 0 || sessions > 0
          ? `已添加，并认领回 ${syncEntries} 条进度记录、${sessions} 条阅读会话`
          : '已添加。这台设备下次上报进度时就会挂到这本书上',
      );
      reload();
    } catch (err) {
      setDocumentError(err instanceof Error ? err.message : '添加失败');
    } finally {
      setAddingDocumentId(false);
    }
  };

  /**
   * 设置或清空主标识（传 null 清空）。
   *
   * 主标识是服务端从存储里的文件算出来的，而那份文件未必与阅读器上的副本
   * 一致。算出来对不上任何设备时，留着它只会让人误以为「已经配好了」。
   */
  const handleSavePrimary = async (value?: string | null): Promise<void> => {
    const next = value === undefined ? primaryDraft.trim() : value;
    if (next !== null && next !== '' && !/^[a-fA-F0-9]{32}$/.test(next)) {
      setDocumentError('文档标识是 32 位十六进制，请照抄阅读器里显示的那个值');
      return;
    }

    setSavingPrimary(true);
    setDocumentError(null);
    setDocumentNotice(null);
    try {
      const result = await api.put<{ relinked: { syncEntries: number; sessions: number } | null }>(
        `/books/${bookId}/documents/primary`,
        { documentId: next === '' ? null : next },
      );
      setEditingPrimary(false);
      const relinked = result.relinked;
      setDocumentNotice(
        next === null || next === ''
          ? '已清空主标识。这本书仍会通过下面补充的标识接收进度。'
          : relinked && (relinked.syncEntries > 0 || relinked.sessions > 0)
            ? `已设为主标识，并认领回 ${relinked.syncEntries} 条进度记录、${relinked.sessions} 条阅读会话`
            : '已设为主标识',
      );
      reload();
    } catch (err) {
      setDocumentError(err instanceof Error ? err.message : '保存失败');
    } finally {
      setSavingPrimary(false);
    }
  };

  const handleRemoveDocumentId = async (aliasId: number): Promise<void> => {
    setDocumentError(null);
    setDocumentNotice(null);
    try {
      await api.del(`/books/${bookId}/documents/${aliasId}`);
      setDocumentNotice('已移除。该标识下已有的进度不会再显示在这本书上');
      reload();
    } catch (err) {
      setDocumentError(err instanceof Error ? err.message : '移除失败');
    }
  };

  const handleDownload = async (): Promise<void> => {
    setDownloading(true);
    try {
      await downloadBookFile(book.id, `${book.title}.${book.format}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '下载失败');
    } finally {
      setDownloading(false);
    }
  };

  const handleDelete = async (): Promise<void> => {
    setBusy(true);
    try {
      await api.del(`/books/${book.id}`);
      toast.success('已删除');
      navigate('/library', { replace: true });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '删除失败');
    } finally {
      setBusy(false);
      setDeleteOpen(false);
    }
  };

  const handleRestore = async (): Promise<void> => {
    if (!pendingRestore) return;
    setBusy(true);
    try {
      await api.post(`/books/${book.id}/versions/${pendingRestore.id}/restore`);
      toast.success(`已回滚到 v${pendingRestore.version}`);
      setPendingRestore(null);
      reload();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '回滚失败');
    } finally {
      setBusy(false);
    }
  };

  const versions = [...(book.versions ?? [])].sort((a, b) => b.version - a.version);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Link
          to="/library"
          className="flex items-center gap-1 font-sans text-xs text-muted underline-offset-2 hover:text-ink hover:underline"
        >
          <ArrowLeft size={12} />
          返回书库
        </Link>

        <div className="flex items-center gap-1.5">
          <Button size="sm" variant="ghost" icon={<Download size={13} />} loading={downloading} onClick={() => void handleDownload()}>
            下载
          </Button>
          <Button size="sm" variant="secondary" icon={<Upload size={13} />} onClick={() => setVersionOpen(true)}>
            上传新版本
          </Button>
          <Button size="sm" variant="secondary" icon={<Pencil size={13} />} onClick={() => setEditOpen(true)}>
            编辑信息
          </Button>
          <Button size="sm" variant="danger" icon={<Trash2 size={13} />} onClick={() => setDeleteOpen(true)}>
            删除
          </Button>
        </div>
      </div>

      <Card>
        <CardBody className="flex flex-col gap-4 sm:flex-row">
          <div className="flex h-40 w-28 shrink-0 items-center justify-center overflow-hidden rounded-sm border border-line bg-raised">
            {book.coverUrl ? (
              <img src={book.coverUrl} alt={`${book.title} 封面`} className="size-full object-cover" />
            ) : (
              <span className="font-serif text-xs text-faint">暂无封面</span>
            )}
          </div>

          <div className="flex min-w-0 flex-1 flex-col gap-2">
            <div>
              <h1 className="font-serif text-xl text-ink">{book.title}</h1>
              <p className="mt-0.5 font-sans text-xs text-muted">
                {book.author || '佚名'}
                {book.publisher ? ` · ${book.publisher}` : ''}
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-1.5">
              <Badge tone="outline">{book.format.toUpperCase()}</Badge>
              <StatusBadge value={book.readingStatus} />
              <Badge tone="neutral">v{book.currentVersion}</Badge>
              {book.tags.map((tag) => (
                <Badge key={tag} tone="accent">
                  {tag}
                </Badge>
              ))}
            </div>

            {book.description ? (
              <p className="font-serif text-sm leading-relaxed text-ink-soft">{book.description}</p>
            ) : (
              <p className="font-sans text-xs text-muted">暂无简介</p>
            )}
          </div>
        </CardBody>
      </Card>

      <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
        <StatTile label="文件大小" value={formatBytes(book.size)} />
        <StatTile label="阅读进度" value={`${Math.round(book.progressPercent)}%`} />
        <StatTile label="累计阅读" value={formatDuration(book.totalReadingSeconds)} />
        <StatTile
          label="最近阅读"
          value={book.lastReadAt ? formatDateTime(book.lastReadAt) : '从未'}
        />
      </div>

      {/*
        文档标识卡片：阅读器上报进度时带的那个值。同一本书在不同平台各下一份、
        或格式/版本不同时，采样算出的标识往往互不相同 —— 补进来之后，
        那台设备上报的进度才会挂到这本书上。
      */}
      <Card>
        <CardHeader
          title="文档标识"
          description="阅读器用它标识这本书。同一本书的不同副本（不同平台、不同版本）标识可能不同，都补上即可，补完会立刻把已有的进度认领回来"
          actions={<Fingerprint size={14} className="text-muted" />}
        />
        <CardBody className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between gap-2 rounded-sm border border-line bg-surface-2 px-3 py-2">
              {editingPrimary ? (
                <span className="flex flex-1 flex-col gap-1.5">
                  <span className="flex items-center gap-2">
                    <Input
                      value={primaryDraft}
                      onChange={(event) => setPrimaryDraft(event.target.value)}
                      placeholder="粘贴阅读器里显示的标识，留空则清空"
                      className="font-mono text-xs"
                      maxLength={32}
                    />
                    <Button
                      size="sm"
                      variant="primary"
                      loading={savingPrimary}
                      onClick={() => void handleSavePrimary()}
                    >
                      保存
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        setEditingPrimary(false);
                        setDocumentError(null);
                      }}
                    >
                      取消
                    </Button>
                  </span>
                  {/*
                    有些第三方客户端直接把整文件 MD5 当文档标识上报。
                    与其让人跑去别处查这个值，不如直接给个填入口 ——
                    服务端本来就拿它当第二档匹配键，填进来只会更稳。
                  */}
                  <span className="flex items-center gap-2 font-sans text-[11px] text-muted">
                    <span className="truncate">本书整文件 MD5：{book.md5}</span>
                    <Button
                      size="sm"
                      variant="quiet"
                      className="shrink-0 underline"
                      onClick={() => setPrimaryDraft(book.md5)}
                    >
                      填入
                    </Button>
                  </span>
                </span>
              ) : (
                <>
                  <span className="flex min-w-0 flex-col">
                    <span className="truncate font-sans text-xs text-ink-soft">
                      {book.documentId ?? '（未设置）'}
                    </span>
                    <span className="font-sans text-[11px] text-muted">
                      {book.documentId
                        ? '服务端从文件算出 · 对不上设备时可改可删'
                        : '没有可算的文件；这本书只靠下面补充的标识匹配'}
                    </span>
                  </span>
                  <span className="flex shrink-0 items-center gap-1">
                    {book.documentId ? <Badge tone="accent">主标识</Badge> : null}
                    <Button
                      size="sm"
                      variant="quiet"
                      aria-label="修改主标识"
                      icon={<Pencil size={13} />}
                      onClick={() => {
                        setPrimaryDraft(book.documentId ?? '');
                        setEditingPrimary(true);
                        setDocumentError(null);
                        setDocumentNotice(null);
                      }}
                    />
                    {book.documentId ? (
                      <Button
                        size="sm"
                        variant="quiet"
                        aria-label="清空主标识"
                        className="hover:text-danger"
                        icon={<X size={13} />}
                        onClick={() => void handleSavePrimary(null)}
                      />
                    ) : null}
                  </span>
                </>
              )}
            </div>

            {(book.documents?.aliases ?? []).map((alias) => (
              <div
                key={alias.id}
                className="flex items-center justify-between gap-2 rounded-sm border border-line px-3 py-2"
              >
                <span className="flex min-w-0 flex-col">
                  <span className="truncate font-sans text-xs text-ink-soft">{alias.documentId}</span>
                  <span className="font-sans text-[11px] text-muted">
                    {alias.label || '手工补充'} · {formatDateTime(alias.createdAt)}
                  </span>
                </span>
                <Button
                  size="sm"
                  variant="quiet"
                  aria-label={`移除 ${alias.documentId}`}
                  icon={<X size={13} />}
                  onClick={() => void handleRemoveDocumentId(alias.id)}
                />
              </div>
            ))}
          </div>

          <div className="flex flex-wrap items-end gap-2">
            <Field label="补充标识" className="min-w-52 flex-1">
              <Input
                value={newDocumentId}
                onChange={(event) => setNewDocumentId(event.target.value)}
                placeholder="c8a8c738d279b04550626c6536890776"
                className="font-mono text-xs"
                maxLength={32}
              />
            </Field>
            <Field label="备注（可选）" className="min-w-36 flex-1">
              <Input
                value={newDocumentLabel}
                onChange={(event) => setNewDocumentLabel(event.target.value)}
                placeholder="Kindle 上的那份"
                maxLength={64}
              />
            </Field>
            <Button
              size="md"
              variant="secondary"
              icon={<Plus size={13} />}
              loading={addingDocumentId}
              disabled={!newDocumentId.trim()}
              onClick={() => void handleAddDocumentId()}
            >
              添加
            </Button>
          </div>

          {documentError ? <Alert tone="danger">{documentError}</Alert> : null}
          {documentNotice ? <Alert tone="success">{documentNotice}</Alert> : null}
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title="版本历史"
          description={`共 ${versions.length} 个版本 · 回滚会把该版本重新发布为最新版本`}
          actions={<History size={14} className="text-muted" />}
        />
        <CardBody className="p-0">
          {versions.length === 0 ? (
            <EmptyState title="暂无版本记录" className="border-0" />
          ) : (
            <Table>
              <THead>
                <TR>
                  <TH>版本</TH>
                  <TH>备注</TH>
                  <TH className="text-right">大小</TH>
                  <TH>MD5</TH>
                  <TH>上传时间</TH>
                  <TH className="text-right">操作</TH>
                </TR>
              </THead>
              <TBody>
                {versions.map((version) => (
                  <TR key={version.id}>
                    <TD>
                      <span className="flex items-center gap-1.5">
                        v{version.version}
                        {version.version === book.currentVersion ? <Badge tone="ochre">当前</Badge> : null}
                      </span>
                    </TD>
                    <TD className="max-w-40 truncate">{version.note || '—'}</TD>
                    <TD className="text-right whitespace-nowrap">{formatBytes(version.size)}</TD>
                    <TD className="font-mono text-xs">{version.md5.slice(0, 12)}…</TD>
                    <TD className="whitespace-nowrap">{formatDateTime(version.createdAt)}</TD>
                    <TD className="text-right">
                      <Button
                        size="sm"
                        variant="quiet"
                        icon={<RotateCcw size={12} />}
                        disabled={version.version === book.currentVersion}
                        onClick={() => setPendingRestore(version)}
                      >
                        回滚
                      </Button>
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          )}
        </CardBody>
      </Card>

      <EditBookDialog
        open={editOpen}
        book={book}
        onClose={() => setEditOpen(false)}
        onSaved={() => {
          toast.success('已保存');
          reload();
        }}
      />

      <BookUploadDialog
        open={versionOpen}
        onClose={() => setVersionOpen(false)}
        onUploaded={reload}
        mode="version"
        bookId={book.id}
        bookTitle={book.title}
      />

      <ConfirmDialog
        open={pendingRestore !== null}
        onClose={() => setPendingRestore(null)}
        onConfirm={() => void handleRestore()}
        loading={busy}
        danger={false}
        confirmText="确认回滚"
        title="回滚版本"
        message={
          <>
            确定回滚到 v{pendingRestore?.version} 吗？
            <br />
            当前版本不会被删除，可以在版本历史中再次切回。
          </>
        }
      />

      <ConfirmDialog
        open={deleteOpen}
        onClose={() => setDeleteOpen(false)}
        onConfirm={() => void handleDelete()}
        loading={busy}
        title="删除书籍"
        confirmText="删除"
        message={
          <>
            确定要删除《{book.title}》吗？
            <br />
            全部 {versions.length} 个版本与存储后端上的文件都会被清理，此操作不可撤销。
          </>
        }
      />
    </div>
  );
}

/** 元数据编辑。阅读状态与进度也在这里改（服务端 PATCH /api/books/:id 一并接受） */
function EditBookDialog({
  open,
  book,
  onClose,
  onSaved,
}: {
  open: boolean;
  book: BookDetailData;
  onClose: () => void;
  onSaved: () => void;
}): ReactNode {
  const [title, setTitle] = useState(book.title);
  const [author, setAuthor] = useState(book.author ?? '');
  const [publisher, setPublisher] = useState(book.publisher ?? '');
  const [isbn, setIsbn] = useState(book.isbn ?? '');
  const [description, setDescription] = useState(book.description ?? '');
  const [tags, setTags] = useState(book.tags.join(', '));
  const [language, setLanguage] = useState(book.language ?? '');
  const [readingStatus, setReadingStatus] = useState(book.readingStatus);
  const [progressPercent, setProgressPercent] = useState(String(Math.round(book.progressPercent)));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 每次打开时用最新的服务端数据重置表单，避免展示上一次编辑的残留
  useEffect(() => {
    if (!open) return;
    setTitle(book.title);
    setAuthor(book.author ?? '');
    setPublisher(book.publisher ?? '');
    setIsbn(book.isbn ?? '');
    setDescription(book.description ?? '');
    setTags(book.tags.join(', '));
    setLanguage(book.language ?? '');
    setReadingStatus(book.readingStatus);
    setProgressPercent(String(Math.round(book.progressPercent)));
    setError(null);
  }, [open, book]);

  const handleSave = async (): Promise<void> => {
    if (!title.trim()) {
      setError('书名不能为空');
      return;
    }

    setSaving(true);
    setError(null);
    try {
      await api.patch(`/books/${book.id}`, {
        title: title.trim(),
        author: author.trim(),
        publisher: publisher.trim(),
        isbn: isbn.trim(),
        description: description.trim(),
        tags: parseTags(tags),
        language: language.trim(),
        readingStatus,
        progressPercent: Number(progressPercent) || 0,
      });
      onSaved();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存失败');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="编辑书籍信息"
      size="lg"
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={onClose}>
            取消
          </Button>
          <Button
            variant="primary"
            size="sm"
            loading={saving}
            icon={<Save size={13} />}
            onClick={() => void handleSave()}
          >
            保存
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3.5">
        <Field label="书名" required>
          <Input value={title} onChange={(event) => setTitle(event.target.value)} maxLength={256} />
        </Field>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="作者">
            <Input value={author} onChange={(event) => setAuthor(event.target.value)} maxLength={128} />
          </Field>
          <Field label="出版社">
            <Input value={publisher} onChange={(event) => setPublisher(event.target.value)} maxLength={128} />
          </Field>
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="ISBN">
            <Input value={isbn} onChange={(event) => setIsbn(event.target.value)} maxLength={32} />
          </Field>
          <Field label="语言">
            <Input
              value={language}
              onChange={(event) => setLanguage(event.target.value)}
              maxLength={16}
              placeholder="zh-CN"
            />
          </Field>
        </div>

        <Field label="标签" hint="用逗号或空格分隔">
          <Input value={tags} onChange={(event) => setTags(event.target.value)} />
        </Field>

        <Field label="简介">
          <Textarea
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            maxLength={4096}
            rows={3}
          />
        </Field>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="阅读状态">
            <Select
              value={readingStatus}
              onChange={(event) => setReadingStatus(event.target.value as typeof readingStatus)}
            >
              {READING_STATUSES.map((status) => (
                <option key={status} value={status}>
                  {STATUS_LABELS[status] ?? status}
                </option>
              ))}
            </Select>
          </Field>

          <Field label="阅读进度 (%)" hint="0–100，可手动校正">
            <Input
              type="number"
              min={0}
              max={100}
              value={progressPercent}
              onChange={(event) => setProgressPercent(event.target.value)}
            />
          </Field>
        </div>

        {error ? <Alert tone="danger">{error}</Alert> : null}
      </div>
    </Modal>
  );
}
