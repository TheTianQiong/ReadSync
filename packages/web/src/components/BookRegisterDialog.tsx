import { BOOK_FORMATS, type BookDetail } from '@readsync/shared';
import { BookPlus } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { api } from '../lib/api';
import { parseTags } from '../lib/utils';
import { Alert } from './ui/Alert';
import { Button } from './ui/Button';
import { Field, Input, Select, Textarea } from './ui/Input';
import { Modal } from './ui/Modal';
import { useToast } from './ui/Toast';

/**
 * 登记书目 —— 只记录书籍信息与 MD5，**不上传任何文件**。
 *
 * 存在的理由：本项目的阅读进度同步与统计完全不依赖文件，只有下载与版本回滚
 * 需要。所以当服务器在 CDN/代理后面传大文件总失败、而用户其实只要同步时，
 * 「不上传文件」是一条完全可用的路径 —— 管理员在站点设置里关掉上传后，
 * 书库页就会显示这个入口而不是上传入口。
 */
export function BookRegisterDialog({
  open,
  onClose,
  onRegistered,
}: {
  open: boolean;
  onClose: () => void;
  onRegistered: () => void;
}): ReactNode {
  const toast = useToast();

  const [title, setTitle] = useState('');
  const [author, setAuthor] = useState('');
  const [format, setFormat] = useState<string>('epub');
  const [md5, setMd5] = useState('');
  const [sizeMb, setSizeMb] = useState('');
  const [tags, setTags] = useState('');
  const [description, setDescription] = useState('');
  const [totalPages, setTotalPages] = useState('');

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setTitle('');
    setAuthor('');
    setFormat('epub');
    setMd5('');
    setSizeMb('');
    setTags('');
    setDescription('');
    setTotalPages('');
    setError(null);
  }, [open]);

  const handleSubmit = async (): Promise<void> => {
    if (!title.trim()) {
      setError('请填写书名');
      return;
    }
    // MD5 必须是真的：同步接口正是靠它把进度挂到这本书上，随便填一个
    // 等于这本书永远收不到进度，而且要等到用起来才会发现
    if (!/^[a-fA-F0-9]{32}$/.test(md5.trim())) {
      setError('请填写 32 位十六进制的 MD5（就是阅读器里显示的那个文档标识）');
      return;
    }

    setSaving(true);
    setError(null);
    try {
      await api.post<BookDetail>('/books', {
        title: title.trim(),
        ...(author.trim() ? { author: author.trim() } : {}),
        format,
        md5: md5.trim().toLowerCase(),
        // 不传 objectKey ⇒ 服务端落库为一本「没有文件」的书
        size: Math.max(0, Math.round((Number(sizeMb) || 0) * 1024 * 1024)),
        tags: parseTags(tags),
        ...(description.trim() ? { description: description.trim() } : {}),
        ...(Number(totalPages) > 0 ? { totalPages: Math.round(Number(totalPages)) } : {}),
      });
      toast.success('已登记书目');
      onRegistered();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : '登记失败');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="登记书目"
      description="只记录书籍信息与 MD5，不上传文件。阅读进度同步与统计都能正常工作，但不能下载。"
      size="lg"
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={onClose} disabled={saving}>
            取消
          </Button>
          <Button
            variant="primary"
            size="sm"
            loading={saving}
            onClick={() => void handleSubmit()}
            icon={<BookPlus size={13} />}
          >
            登记
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3.5">
        <Alert tone="info">
          下载与版本回滚需要文件，其余功能不受影响。同一本书在阅读器里同步进度时，
          服务端会拿进度里的文档标识与这里的 MD5 比对，比对成功才会把进度挂到这本书上。
        </Alert>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="书名" required>
            <Input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={256} />
          </Field>
          <Field label="作者">
            <Input value={author} onChange={(e) => setAuthor(e.target.value)} maxLength={128} />
          </Field>
        </div>

        <Field
          label="MD5"
          required
          hint="32 位十六进制。填阅读器里显示的那个文档标识，填错会导致同步进度挂不到这本书上"
        >
          <Input
            value={md5}
            onChange={(e) => setMd5(e.target.value)}
            placeholder="d41d8cd98f00b204e9800998ecf8427e"
            className="font-mono"
            maxLength={32}
          />
        </Field>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Field label="格式">
            <Select value={format} onChange={(e) => setFormat(e.target.value)}>
              {BOOK_FORMATS.map((f) => (
                <option key={f} value={f}>
                  {f}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="文件大小（MB）" hint="可选，仅用于展示">
            <Input
              type="number"
              min={0}
              value={sizeMb}
              onChange={(e) => setSizeMb(e.target.value)}
              placeholder="0"
            />
          </Field>
          <Field label="总页数" hint="可选，用于进度换算">
            <Input
              type="number"
              min={0}
              value={totalPages}
              onChange={(e) => setTotalPages(e.target.value)}
              placeholder="0"
            />
          </Field>
        </div>

        <Field label="标签" hint="逗号或空格分隔">
          <Input value={tags} onChange={(e) => setTags(e.target.value)} placeholder="科幻 长篇" />
        </Field>

        <Field label="简介">
          <Textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={3} />
        </Field>

        {error ? <Alert tone="danger">{error}</Alert> : null}
      </div>
    </Modal>
  );
}
