import { BOOK_FORMATS, DEFAULT_ALLOWED_EXTENSIONS, type BookSummary, type CheckBookExistsResult, type StorageSummary } from '@readsync/shared';
import { FileUp, ScanSearch } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { api } from '../lib/api';
import { useAsync } from '../lib/hooks';
import { fileExtension, formatBytes, md5OfFile, parseTags } from '../lib/utils';
import { Alert } from './ui/Alert';
import { Button } from './ui/Button';
import { Field, Input, Select, Textarea } from './ui/Input';
import { Modal } from './ui/Modal';
import { useToast } from './ui/Toast';

/**
 * 上传对话框。两种模式共用：
 *  - create ：登记一本新书（POST /api/books/upload）
 *  - version：给已有书籍上传新版本（POST /api/books/:id/versions）
 *
 * 上传用 XMLHttpRequest（见 lib/api.ts 的 upload），以便显示真实进度 ——
 * 大文件走 fetch 时用户完全无法判断是卡住了还是在传。
 */
export function BookUploadDialog({
  open,
  onClose,
  onUploaded,
  mode = 'create',
  bookId,
  bookTitle,
}: {
  open: boolean;
  onClose: () => void;
  onUploaded: () => void;
  mode?: 'create' | 'version';
  bookId?: number;
  bookTitle?: string;
}): ReactNode {
  const toast = useToast();
  const fileInputRef = useRef<HTMLInputElement>(null);
  // 站点单文件上限/允许的类型。选文件时就据此预检，避免传完才被拒
  const { settings } = useAuth();
  const maxFileSize = settings?.upload?.maxFileSize ?? 0;

  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState('');
  const [author, setAuthor] = useState('');
  const [format, setFormat] = useState<string>('epub');
  const [description, setDescription] = useState('');
  const [tags, setTags] = useState('');
  const [storageId, setStorageId] = useState('');
  const [note, setNote] = useState('');

  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const [notice, setNotice] = useState<string | null>(null);
  const [hashing, setHashing] = useState(false);
  const [hashProgress, setHashProgress] = useState(0);
  const [knownMd5, setKnownMd5] = useState<string | null>(null);
  const [duplicate, setDuplicate] = useState<BookSummary | null>(null);

  // 存储后端列表；接口未就绪时留空，后端会用默认存储
  const storages = useAsync(
    () => api.get<StorageSummary[]>('/storages'),
    [],
    { immediate: open && mode === 'create' },
  );

  // 每次打开都重置，避免上次的文件/进度残留造成误解
  useEffect(() => {
    if (!open) return;
    setFile(null);
    setTitle('');
    setAuthor('');
    setDescription('');
    setTags('');
    setNote('');
    setProgress(0);
    setError(null);
    setNotice(null);
    setKnownMd5(null);
    setDuplicate(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
  }, [open]);

  const handlePickFile = (picked: File | null): void => {
    setFile(picked);
    setKnownMd5(null);
    setDuplicate(null);
    setError(null);

    if (!picked) return;

    /*
     * 选文件时就拦下超限的文件。
     *
     * 不做这一步的话，用户会眼睁睁看着进度条爬到 100% 才收到失败提示 ——
     * 或者更糟：请求在反向代理那一层被掐断，浏览器只报「网络连接中断」，
     * 完全看不出是文件太大的缘故。上限由后端 /api/system/settings 下发。
     */
    if (maxFileSize > 0 && picked.size > maxFileSize) {
      setError(
        `文件大小 ${formatBytes(picked.size)}，超过本站单文件上限 ${formatBytes(maxFileSize)}。` +
          `请联系管理员在「站点设置 → 上传」中调高上限。`,
      );
      return;
    }

    if (mode === 'create') {
      // 文件名去掉扩展名作为默认书名，省一次输入
      const base = picked.name.replace(/\.[^.]+$/, '');
      setTitle((prev) => prev || base);
      const ext = fileExtension(picked.name);
      if ((BOOK_FORMATS as readonly string[]).includes(ext)) setFormat(ext);
    }
  };

  /** 秒传预检：先算 MD5，再问服务端是否已有同文件 */
  const handleCheckDuplicate = async (): Promise<void> => {
    if (!file) return;
    setHashing(true);
    setError(null);
    setDuplicate(null);

    try {
      const md5 = await md5OfFile(file, setHashProgress);
      setKnownMd5(md5);
      const result = await api.post<CheckBookExistsResult>('/books/check', { md5 });
      if (result.exists && result.book) {
        setDuplicate(result.book);
      } else {
        toast.push('该书尚未收录，可以正常上传');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : '秒传检测失败');
    } finally {
      setHashing(false);
    }
  };

  const handleUpload = async (): Promise<void> => {
    if (!file) {
      setError('请先选择文件');
      return;
    }
    if (mode === 'create' && !title.trim()) {
      setError('请填写书名');
      return;
    }
    // 兜底：文件可能是拖进来的，或设置在上传前刚被管理员改小
    if (maxFileSize > 0 && file.size > maxFileSize) {
      setError(
        `文件大小 ${formatBytes(file.size)}，超过本站单文件上限 ${formatBytes(maxFileSize)}。`,
      );
      return;
    }

    setUploading(true);
    setError(null);
    setNotice(null);
    setProgress(0);

    /*
     * 一律走分片上传，不再用整体 POST。
     *
     * 整体上传只在「客户端与服务端之间没有任何中间层」时才可靠：Nginx 的
     * client_max_body_size 默认 1 MB，Cloudflare 橙云与 Tunnel 对请求体大小和
     * 请求时长都有上限且免费版调不了。这些限制服务端绕不过去，只有把请求切小
     * 才能解决 —— 而小文件走分片也完全没问题，没必要为此维护两条代码路径。
     */
    const fields: Record<string, string> = {};
    if (mode === 'create') {
      fields.title = title.trim();
      if (author.trim()) fields.author = author.trim();
      fields.format = format;
      // 服务端会边传边算 MD5；用户点过秒传检测的话直接复用，省一次计算
      if (knownMd5) fields.md5 = knownMd5;
      if (description.trim()) fields.description = description.trim();
      const tagList = parseTags(tags);
      if (tagList.length > 0) fields.tags = tagList.join(',');
      if (storageId) fields.storageId = storageId;
    } else if (note.trim()) {
      fields.note = note.trim();
    }

    try {
      await api.uploadChunked(
        file,
        fields,
        mode === 'create' ? { mode: 'create' } : { mode: 'version', bookId: Number(bookId) },
        {
          onProgress: setProgress,
          // 链路慢而降级重试时得让用户看见，否则进度条归零会像是卡死了
          onNotice: setNotice,
        },
      );
      toast.success(mode === 'create' ? '上传完成' : '新版本已上传');
      onUploaded();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : '上传失败');
    } finally {
      setUploading(false);
    }
  };

  const allowedHint = `允许的类型：${DEFAULT_ALLOWED_EXTENSIONS.join('、')}`;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={mode === 'create' ? '上传书籍' : `上传新版本${bookTitle ? ` · ${bookTitle}` : ''}`}
      description={mode === 'create' ? '文件会存入默认存储后端，本地仅保留元数据与版本记录' : '上传后会生成一个新版本，可随时回滚'}
      size="lg"
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={onClose} disabled={uploading}>
            取消
          </Button>
          <Button
            variant="primary"
            size="sm"
            loading={uploading}
            onClick={() => void handleUpload()}
            icon={<FileUp size={13} />}
          >
            开始上传
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3.5">
        <Field label="选择文件" required hint={mode === 'create' ? allowedHint : '选择该书籍的新版本文件'}>
          <input
            ref={fileInputRef}
            type="file"
            onChange={(event) => handlePickFile(event.target.files?.[0] ?? null)}
            className="w-full cursor-pointer rounded-sm border border-line bg-surface px-2.5 py-2 font-sans text-xs text-ink-soft file:mr-2 file:cursor-pointer file:rounded-sm file:border file:border-line file:bg-raised file:px-2 file:py-0.5 file:font-sans file:text-xs file:text-ink-soft"
          />
        </Field>

        {file ? (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-sm border border-line bg-raised px-3 py-2 font-sans text-xs text-ink-soft">
            <span className="min-w-0 truncate">{file.name}</span>
            <span className="shrink-0 text-muted">{formatBytes(file.size)}</span>
          </div>
        ) : null}

        {/* 秒传：同一文件已在书库时无需重复上传 */}
        {mode === 'create' && file ? (
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              variant="secondary"
              icon={<ScanSearch size={13} />}
              loading={hashing}
              disabled={uploading}
              onClick={() => void handleCheckDuplicate()}
            >
              检测是否已存在（秒传）
            </Button>
            {hashing ? (
              <span className="font-sans text-xs text-muted">正在计算 MD5… {hashProgress}%</span>
            ) : knownMd5 ? (
              <span className="font-mono text-xs text-muted">MD5 {knownMd5.slice(0, 12)}…</span>
            ) : null}
          </div>
        ) : null}

        {duplicate ? (
          <Alert tone="warning">
            书库中已存在相同文件：
            <Link
              to={`/library/${duplicate.id}`}
              className="ml-1 underline underline-offset-2"
              onClick={onClose}
            >
              《{duplicate.title}》
            </Link>
            。可以直接使用已有记录，无需重复上传。
          </Alert>
        ) : null}

        {mode === 'create' ? (
          <>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field label="书名" required>
                <Input value={title} onChange={(event) => setTitle(event.target.value)} maxLength={256} />
              </Field>
              <Field label="作者">
                <Input value={author} onChange={(event) => setAuthor(event.target.value)} maxLength={128} />
              </Field>
            </div>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field label="格式">
                <Select value={format} onChange={(event) => setFormat(event.target.value)}>
                  {BOOK_FORMATS.map((item) => (
                    <option key={item} value={item}>
                      {item.toUpperCase()}
                    </option>
                  ))}
                </Select>
              </Field>

              <Field label="存储后端" hint="留空则使用默认存储">
                <Select value={storageId} onChange={(event) => setStorageId(event.target.value)}>
                  <option value="">默认存储</option>
                  {(storages.data ?? []).map((storage) => (
                    <option key={storage.id} value={String(storage.id)}>
                      {storage.name}
                      {storage.isDefault ? '（默认）' : ''}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>

            <Field label="标签" hint="用逗号或空格分隔，最多 20 个">
              <Input value={tags} onChange={(event) => setTags(event.target.value)} placeholder="小说, 已校对" />
            </Field>

            <Field label="简介">
              <Textarea
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                maxLength={4096}
                rows={3}
              />
            </Field>
          </>
        ) : (
          <Field label="版本备注" hint="例如「修正排版」「替换封面」">
            <Input value={note} onChange={(event) => setNote(event.target.value)} maxLength={128} />
          </Field>
        )}

        {/* 进度条：细线 + 实心块，与全站图表同一套语言 */}
        {uploading ? (
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between font-sans text-xs text-muted">
              <span>正在上传…</span>
              <span>{progress}%</span>
            </div>
            <span className="h-1.5 w-full rounded-[1px] bg-raised">
              <span
                className="block h-full rounded-[1px] transition-[width]"
                style={{ width: `${progress}%`, backgroundColor: 'var(--rs-chart-1)' }}
              />
            </span>
          </div>
        ) : null}

        {error ? <Alert tone="danger">{error}</Alert> : null}
        {!error && notice ? <Alert tone="info">{notice}</Alert> : null}
      </div>
    </Modal>
  );
}
