import {
  S3_ADDRESSING_STYLES,
  STORAGE_DRIVERS,
  type StorageInput,
  type StorageSummary,
  type StorageTestResult,
} from '@readsync/shared';
import { Cloud, FolderOpen, HardDrive, Pencil, Plug, Plus, Server, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Alert } from '../../components/ui/Alert';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Card, CardBody, CardHeader } from '../../components/ui/Card';
import { EmptyState } from '../../components/ui/EmptyState';
import { Field, Input, Select } from '../../components/ui/Input';
import { ConfirmDialog, Modal } from '../../components/ui/Modal';
import { PageSpinner } from '../../components/ui/Spinner';
import { Switch } from '../../components/ui/Switch';
import { Table, TBody, TD, TH, THead, TR } from '../../components/ui/Table';
import { useToast } from '../../components/ui/Toast';
import { api } from '../../lib/api';
import { useAsync } from '../../lib/hooks';
import { formatBytes, formatRelative } from '../../lib/utils';

const DRIVER_LABELS: Record<string, string> = {
  local: '服务器本地',
  webdav: 'WebDAV',
  s3: '对象存储 (S3)',
  plugin: '插件提供',
};

const DRIVER_ICONS: Record<string, ReactNode> = {
  local: <HardDrive size={14} />,
  webdav: <Cloud size={14} />,
  s3: <Server size={14} />,
  plugin: <Plug size={14} />,
};

interface BrowseEntry {
  name: string;
  path?: string;
  isDir?: boolean;
  directory?: boolean;
  size?: number;
}

/**
 * 存储管理（README 要求 7、8）。
 *
 * 本地磁盘容量有限，书库文件通常放在 WebDAV / 对象存储上，
 * 因此这里支持配置多个后端并指定默认存储。
 * 凭据由服务端加密落库，接口返回的 config 已脱敏，编辑时留空表示「保持原值不变」。
 */
export function Storages(): ReactNode {
  const toast = useToast();
  const { data, loading, error, reload } = useAsync(() => api.get<StorageSummary[]>('/storages'), []);

  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState<StorageSummary | null>(null);
  const [pendingDelete, setPendingDelete] = useState<StorageSummary | null>(null);
  const [busy, setBusy] = useState(false);
  const [testingId, setTestingId] = useState<number | null>(null);
  const [browsing, setBrowsing] = useState<StorageSummary | null>(null);

  const storages = data ?? [];

  const handleTest = async (storage: StorageSummary): Promise<void> => {
    setTestingId(storage.id);
    try {
      const result = await api.post<StorageTestResult>(`/storages/${storage.id}/test`);
      if (result.ok) {
        toast.success(result.message || `连接正常${result.latencyMs ? `（${result.latencyMs}ms）` : ''}`);
      } else {
        toast.error(result.message || '连接失败');
      }
      reload();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '测试失败');
    } finally {
      setTestingId(null);
    }
  };

  const handleDelete = async (): Promise<void> => {
    if (!pendingDelete) return;
    setBusy(true);
    try {
      await api.del(`/storages/${pendingDelete.id}`);
      toast.success('存储已删除');
      setPendingDelete(null);
      reload();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '删除失败');
    } finally {
      setBusy(false);
    }
  };

  /** 切换默认存储。服务端要求整份 config 一起提交，因此直接复用脱敏后的配置 */
  const handleSetDefault = async (storage: StorageSummary): Promise<void> => {
    try {
      await api.patch(`/storages/${storage.id}`, { isDefault: true });
      toast.success(`已将「${storage.name}」设为默认存储`);
      reload();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '设置失败');
    }
  };

  const handleToggleEnabled = async (storage: StorageSummary, enabled: boolean): Promise<void> => {
    try {
      await api.patch(`/storages/${storage.id}`, { enabled });
      reload();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '更新失败');
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <Card>
        <CardHeader
          title="存储后端"
          description="书籍文件实际存放的位置；本地磁盘建议仅作中转与缓存"
          actions={
            <Button
              size="sm"
              variant="secondary"
              icon={<Plus size={13} />}
              onClick={() => {
                setEditing(null);
                setEditorOpen(true);
              }}
            >
              新增存储
            </Button>
          }
        />
        <CardBody className="p-0">
          {loading ? (
            <PageSpinner label="正在读取存储配置…" />
          ) : error && !error.isMissing ? (
            <div className="p-4">
              <Alert tone="danger">{error.message}</Alert>
            </div>
          ) : storages.length === 0 ? (
            <EmptyState
              icon={<Cloud size={22} />}
              title="还没有配置存储后端"
              description="新增一个 WebDAV 或对象存储后，上传的书籍会保存到那里"
              className="border-0"
              action={
                <Button
                  size="sm"
                  variant="primary"
                  icon={<Plus size={13} />}
                  onClick={() => {
                    setEditing(null);
                    setEditorOpen(true);
                  }}
                >
                  新增存储
                </Button>
              }
            />
          ) : (
            <Table>
              <THead>
                <TR>
                  <TH>名称</TH>
                  <TH>类型</TH>
                  <TH>状态</TH>
                  <TH>连通性</TH>
                  <TH className="text-right">已用容量</TH>
                  <TH className="text-right">操作</TH>
                </TR>
              </THead>
              <TBody>
                {storages.map((storage) => (
                  <TR key={storage.id}>
                    <TD>
                      <span className="flex items-center gap-1.5">
                        <span className="text-muted">{DRIVER_ICONS[storage.driver]}</span>
                        <span className="font-sans text-sm text-ink">{storage.name}</span>
                        {storage.isDefault ? <Badge tone="accent">默认</Badge> : null}
                        {storage.readOnly ? <Badge tone="outline">只读</Badge> : null}
                      </span>
                    </TD>
                    <TD className="whitespace-nowrap">{DRIVER_LABELS[storage.driver] ?? storage.driver}</TD>
                    <TD>
                      <Switch
                        checked={storage.enabled}
                        onChange={(next) => void handleToggleEnabled(storage, next)}
                      />
                    </TD>
                    <TD className="whitespace-nowrap">
                      {storage.lastCheckOk === null ? (
                        <span className="text-muted">未测试</span>
                      ) : storage.lastCheckOk ? (
                        <Badge tone="ochre">正常 · {formatRelative(storage.lastCheckAt)}</Badge>
                      ) : (
                        <Badge tone="danger">失败 · {formatRelative(storage.lastCheckAt)}</Badge>
                      )}
                    </TD>
                    <TD className="text-right whitespace-nowrap">{formatBytes(storage.usedBytes)}</TD>
                    <TD className="text-right">
                      <div className="flex justify-end gap-0.5">
                        <Button
                          size="sm"
                          variant="quiet"
                          loading={testingId === storage.id}
                          onClick={() => void handleTest(storage)}
                        >
                          测试
                        </Button>
                        <Button
                          size="sm"
                          variant="quiet"
                          aria-label={`浏览 ${storage.name}`}
                          icon={<FolderOpen size={13} />}
                          onClick={() => setBrowsing(storage)}
                        />
                        <Button
                          size="sm"
                          variant="quiet"
                          aria-label={`编辑 ${storage.name}`}
                          icon={<Pencil size={13} />}
                          onClick={() => {
                            setEditing(storage);
                            setEditorOpen(true);
                          }}
                        />
                        <Button
                          size="sm"
                          variant="quiet"
                          className="hover:text-danger"
                          aria-label={`删除 ${storage.name}`}
                          icon={<Trash2 size={13} />}
                          onClick={() => setPendingDelete(storage)}
                        />
                      </div>
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          )}
        </CardBody>
      </Card>

      {storages.length > 1 ? (
        <Card>
          <CardHeader title="默认存储" description="上传新书时若未指定，将使用该存储" />
          <CardBody>
            <div className="flex flex-wrap gap-1.5">
              {storages.map((storage) => (
                <Button
                  key={storage.id}
                  size="sm"
                  variant={storage.isDefault ? 'primary' : 'secondary'}
                  disabled={storage.isDefault}
                  onClick={() => void handleSetDefault(storage)}
                >
                  {storage.name}
                  {storage.isDefault ? ' · 当前默认' : ''}
                </Button>
              ))}
            </div>
          </CardBody>
        </Card>
      ) : null}

      <StorageEditor
        open={editorOpen}
        editing={editing}
        onClose={() => setEditorOpen(false)}
        onSaved={() => {
          toast.success(editing ? '存储已更新' : '存储已添加');
          reload();
        }}
      />

      <BrowseDialog storage={browsing} onClose={() => setBrowsing(null)} />

      <ConfirmDialog
        open={pendingDelete !== null}
        onClose={() => setPendingDelete(null)}
        onConfirm={() => void handleDelete()}
        loading={busy}
        title="删除存储"
        confirmText="删除"
        message={
          <>
            确定要删除「{pendingDelete?.name}」吗？
            <br />
            该存储上的书籍文件不会被主动删除，但书库中将无法再访问它们。
          </>
        }
      />
    </div>
  );
}

/* ------------------------------ 新增 / 编辑 ------------------------------ */

type ConfigForm = Record<string, string | boolean>;

const DEFAULT_CONFIG: Record<string, ConfigForm> = {
  local: { path: 'storage', quotaBytes: '0' },
  webdav: { url: '', username: '', password: '', basePath: '/', allowSelfSigned: false },
  s3: {
    endpoint: '',
    region: 'us-east-1',
    bucket: '',
    accessKeyId: '',
    secretAccessKey: '',
    prefix: '',
    forcePathStyle: true,
    addressingStyle: 'path',
  },
};

function StorageEditor({
  open,
  editing,
  onClose,
  onSaved,
}: {
  open: boolean;
  editing: StorageSummary | null;
  onClose: () => void;
  onSaved: () => void;
}): ReactNode {
  const [name, setName] = useState('');
  const [driver, setDriver] = useState<StorageInput['driver']>('webdav');
  const [config, setConfig] = useState<ConfigForm>({});
  const [isDefault, setIsDefault] = useState(false);
  const [readOnly, setReadOnly] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;

    setError(null);

    if (editing) {
      setName(editing.name);
      setDriver(editing.driver);
      // 脱敏后的配置直接回填；带 ****** 的字段留空，表示不修改
      const masked = Object.fromEntries(
        Object.entries(editing.config ?? {}).map(([key, value]) => [
          key,
          typeof value === 'string' && value.includes('*') ? '' : String(value ?? ''),
        ]),
      );
      setConfig({ ...(DEFAULT_CONFIG[editing.driver] ?? {}), ...masked });
      setIsDefault(editing.isDefault);
      setReadOnly(editing.readOnly);
    } else {
      setName('');
      setDriver('webdav');
      setConfig({ ...DEFAULT_CONFIG.webdav });
      setIsDefault(false);
      setReadOnly(false);
    }
  }, [open, editing]);

  const changeDriver = (next: StorageInput['driver']): void => {
    setDriver(next);
    setConfig({ ...(DEFAULT_CONFIG[next] ?? {}) });
  };

  const set = useCallback((key: string, value: string | boolean): void => {
    setConfig((prev) => ({ ...prev, [key]: value }));
  }, []);

  const handleSave = async (): Promise<void> => {
    setError(null);
    if (!name.trim()) {
      setError('请填写名称');
      return;
    }

    const payloadConfig: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(config)) {
      // 编辑时留空的敏感字段表示「沿用原值」，不提交，避免把 ****** 写回数据库
      if (editing && value === '') continue;
      if (typeof value === 'string' && key === 'quotaBytes') {
        payloadConfig[key] = Number(value) || 0;
      } else {
        payloadConfig[key] = value;
      }
    }

    setSaving(true);
    try {
      if (editing) {
        await api.patch(`/storages/${editing.id}`, {
          name: name.trim(),
          config: payloadConfig,
          isDefault,
          readOnly,
        });
      } else {
        await api.post('/storages', {
          driver,
          config: payloadConfig,
          name: name.trim(),
          isDefault,
          readOnly,
        });
      }
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
      title={editing ? `编辑存储 · ${editing.name}` : '新增存储'}
      description={editing ? '留空敏感字段表示保持原值不变' : '凭据将由服务端加密后保存'}
      size="lg"
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={onClose}>
            取消
          </Button>
          <Button variant="primary" size="sm" loading={saving} onClick={() => void handleSave()}>
            保存
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3.5">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="名称" required hint="仅用于区分，例如「坚果云」">
            <Input value={name} onChange={(event) => setName(event.target.value)} maxLength={64} />
          </Field>

          <Field label="类型" required>
            <Select
              value={driver}
              disabled={editing !== null}
              onChange={(event) => changeDriver(event.target.value as StorageInput['driver'])}
            >
              {STORAGE_DRIVERS.map((item) => (
                <option key={item} value={item}>
                  {DRIVER_LABELS[item] ?? item}
                </option>
              ))}
            </Select>
          </Field>
        </div>

        {driver === 'webdav' ? (
          <>
            <Field label="服务器地址" required hint="例如 https://dav.jianguoyun.com/dav/">
              <Input value={String(config.url ?? '')} onChange={(e) => set('url', e.target.value)} />
            </Field>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field label="用户名" required>
                <Input value={String(config.username ?? '')} onChange={(e) => set('username', e.target.value)} />
              </Field>
              <Field label="密码 / 应用授权码" required={!editing}>
                <Input
                  type="password"
                  value={String(config.password ?? '')}
                  onChange={(e) => set('password', e.target.value)}
                  autoComplete="new-password"
                />
              </Field>
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field label="根目录" hint="留空表示账号根目录">
                <Input value={String(config.basePath ?? '/')} onChange={(e) => set('basePath', e.target.value)} />
              </Field>
              <div className="flex items-end pb-2">
                <Switch
                  checked={config.allowSelfSigned === true}
                  onChange={(next) => set('allowSelfSigned', next)}
                  label="允许自签名证书"
                  description="自建 Nextcloud 常见"
                />
              </div>
            </div>
          </>
        ) : null}

        {driver === 's3' ? (
          <>
            <Field label="Endpoint" required hint="例如 https://s3.oss-cn-hangzhou.aliyuncs.com">
              <Input value={String(config.endpoint ?? '')} onChange={(e) => set('endpoint', e.target.value)} />
            </Field>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field label="Region">
                <Input value={String(config.region ?? '')} onChange={(e) => set('region', e.target.value)} />
              </Field>
              <Field label="Bucket" required>
                <Input value={String(config.bucket ?? '')} onChange={(e) => set('bucket', e.target.value)} />
              </Field>
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field label="Access Key" required={!editing}>
                <Input value={String(config.accessKeyId ?? '')} onChange={(e) => set('accessKeyId', e.target.value)} />
              </Field>
              <Field label="Secret Key" required={!editing}>
                <Input
                  type="password"
                  value={String(config.secretAccessKey ?? '')}
                  onChange={(e) => set('secretAccessKey', e.target.value)}
                  autoComplete="new-password"
                />
              </Field>
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field label="对象前缀" hint="可选，例如 readsync/books">
                <Input value={String(config.prefix ?? '')} onChange={(e) => set('prefix', e.target.value)} />
              </Field>
              <Field label="寻址风格">
                <Select
                  value={String(config.addressingStyle ?? 'path')}
                  onChange={(e) => set('addressingStyle', e.target.value)}
                >
                  {S3_ADDRESSING_STYLES.map((style) => (
                    <option key={style} value={style}>
                      {style === 'path' ? 'path（MinIO / 阿里云 OSS）' : 'virtual-host（AWS S3 / R2）'}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
            <Switch
              checked={config.forcePathStyle !== false}
              onChange={(next) => set('forcePathStyle', next)}
              label="强制 Path 风格"
              description="MinIO、阿里云 OSS 通常需要开启"
            />
          </>
        ) : null}

        {driver === 'local' ? (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="相对路径" required hint="相对于服务器数据目录，禁止绝对路径与 ..">
              <Input value={String(config.path ?? 'storage')} onChange={(e) => set('path', e.target.value)} />
            </Field>
            <Field label="容量配额（字节）" hint="0 表示不限制">
              <Input
                type="number"
                min={0}
                value={String(config.quotaBytes ?? '0')}
                onChange={(e) => set('quotaBytes', e.target.value)}
              />
            </Field>
          </div>
        ) : null}

        {driver === 'plugin' ? (
          <Alert tone="info">插件存储驱动的参数由插件自行定义，请到「插件管理」中配置。</Alert>
        ) : null}

        <div className="flex flex-col gap-3 border-t border-line pt-3">
          <Switch
            checked={isDefault}
            onChange={setIsDefault}
            label="设为默认存储"
            description="上传新书时若未指定则使用它"
          />
          <Switch
            checked={readOnly}
            onChange={setReadOnly}
            label="只读"
            description="只读取文件，不写入新上传的内容"
          />
        </div>

        {error ? <Alert tone="danger">{error}</Alert> : null}
      </div>
    </Modal>
  );
}

/* -------------------------------- 目录浏览 -------------------------------- */

function BrowseDialog({
  storage,
  onClose,
}: {
  storage: StorageSummary | null;
  onClose: () => void;
}): ReactNode {
  const [path, setPath] = useState('/');
  const [entries, setEntries] = useState<BrowseEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [newDir, setNewDir] = useState('');

  const load = useCallback(
    async (target: string): Promise<void> => {
      if (!storage) return;
      setLoading(true);
      setError(null);
      try {
        const result = await api.get<{ items?: BrowseEntry[]; entries?: BrowseEntry[] } | BrowseEntry[]>(
          `/storages/${storage.id}/browse`,
          { path: target },
        );
        const items = Array.isArray(result) ? result : (result.items ?? result.entries ?? []);
        setEntries(items);
      } catch (err) {
        setError(err instanceof Error ? err.message : '浏览失败');
        setEntries([]);
      } finally {
        setLoading(false);
      }
    },
    [storage],
  );

  useEffect(() => {
    if (!storage) return;
    setPath('/');
    setNewDir('');
    void load('/');
  }, [storage, load]);

  const handleMkdir = async (): Promise<void> => {
    if (!storage || !newDir.trim()) return;
    try {
      await api.post(`/storages/${storage.id}/mkdir`, { path: `${path.replace(/\/$/, '')}/${newDir.trim()}` });
      setNewDir('');
      void load(path);
    } catch (err) {
      setError(err instanceof Error ? err.message : '创建目录失败');
    }
  };

  return (
    <Modal
      open={storage !== null}
      onClose={onClose}
      title={`浏览目录 · ${storage?.name ?? ''}`}
      description="查看远端存储上的实际文件结构"
      size="lg"
    >
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <Input
            value={path}
            onChange={(event) => setPath(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void load(path);
            }}
            className="font-mono text-xs"
          />
          <Button size="md" variant="secondary" onClick={() => void load(path)}>
            前往
          </Button>
          <Button
            size="md"
            variant="ghost"
            onClick={() => {
              const parent = path.replace(/\/[^/]+\/?$/, '') || '/';
              setPath(parent);
              void load(parent);
            }}
          >
            上一级
          </Button>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Input
            value={newDir}
            onChange={(event) => setNewDir(event.target.value)}
            placeholder="新目录名称"
            className="min-w-40 flex-1"
          />
          <Button size="md" variant="secondary" onClick={() => void handleMkdir()} disabled={!newDir.trim()}>
            新建目录
          </Button>
        </div>

        {error ? <Alert tone="danger">{error}</Alert> : null}

        {loading ? (
          <PageSpinner label="正在读取目录…" />
        ) : entries.length === 0 ? (
          <EmptyState title="目录为空或接口尚未就绪" />
        ) : (
          <ul className="flex flex-col divide-y divide-line rounded-sm border border-line">
            {entries.map((entry) => {
              const isDir = entry.isDir ?? entry.directory ?? false;
              const entryPath = entry.path ?? `${path.replace(/\/$/, '')}/${entry.name}`;
              return (
                <li key={entryPath} className="flex items-center justify-between gap-2 px-3 py-1.5">
                  <span className="flex min-w-0 items-center gap-2">
                    {isDir ? <FolderOpen size={13} className="shrink-0 text-muted" /> : <Cloud size={13} className="shrink-0 text-faint" />}
                    <span className="truncate font-sans text-xs text-ink-soft">{entry.name}</span>
                  </span>
                  {isDir ? (
                    <Button
                      size="sm"
                      variant="quiet"
                      onClick={() => {
                        setPath(entryPath);
                        void load(entryPath);
                      }}
                    >
                      打开
                    </Button>
                  ) : (
                    <span className="shrink-0 font-sans text-xs text-muted">{formatBytes(entry.size)}</span>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </Modal>
  );
}
