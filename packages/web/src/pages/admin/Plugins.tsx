import type { PluginConfigField, PluginSummary } from '@readsync/shared';
import { Plug, RefreshCw, Settings2, Trash2, Upload } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Alert } from '../../components/ui/Alert';
import { Badge, StatusBadge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Card, CardBody, CardHeader } from '../../components/ui/Card';
import { EmptyState } from '../../components/ui/EmptyState';
import { Field, Input, Select } from '../../components/ui/Input';
import { ConfirmDialog, Modal } from '../../components/ui/Modal';
import { PageSpinner } from '../../components/ui/Spinner';
import { Switch } from '../../components/ui/Switch';
import { useToast } from '../../components/ui/Toast';
import { api } from '../../lib/api';
import { useAsync } from '../../lib/hooks';
import { formatRelative } from '../../lib/utils';

const CAPABILITY_LABELS: Record<string, string> = {
  storage: '存储驱动',
  sync: '同步协议',
  auth: '认证方式',
  notification: '通知',
  metadata: '元数据',
  dashboard: '首页图表',
};

/**
 * 插件管理（README 要求 1「其他不支持的协议可以后续通过插件的形式实现」）。
 *
 * 插件是 zip 包，根目录含 plugin.json 清单；服务端在安装时校验清单与 apiVersion，
 * 因此这里只需要把文件传上去，校验结果由响应或列表里的 status/error 反映。
 *
 * 配置表单完全由插件的 configFields 驱动渲染 —— 前端不需要知道任何具体插件的字段。
 */
export function Plugins(): ReactNode {
  const toast = useToast();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const { data, loading, error, reload } = useAsync(() => api.get<PluginSummary[]>('/plugins'), []);
  const [installing, setInstalling] = useState(false);
  const [configPlugin, setConfigPlugin] = useState<PluginSummary | null>(null);
  const [pendingDelete, setPendingDelete] = useState<PluginSummary | null>(null);
  const [busy, setBusy] = useState(false);

  const plugins = data ?? [];

  const handleInstall = async (file: File | null): Promise<void> => {
    if (!file) return;
    setInstalling(true);
    try {
      const form = new FormData();
      form.append('file', file);
      await api.upload('/plugins/install', form);
      toast.success('插件已安装');
      reload();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '安装失败，请检查插件包是否完整');
    } finally {
      setInstalling(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const handleToggle = async (plugin: PluginSummary): Promise<void> => {
    const action = plugin.status === 'enabled' ? 'disable' : 'enable';
    try {
      await api.post(`/plugins/${plugin.id}/${action}`);
      toast.success(action === 'enable' ? '插件已启用' : '插件已停用');
      reload();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '操作失败');
    }
  };

  const handleDelete = async (): Promise<void> => {
    if (!pendingDelete) return;
    setBusy(true);
    try {
      await api.del(`/plugins/${pendingDelete.id}`);
      toast.success('插件已卸载');
      setPendingDelete(null);
      reload();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '卸载失败');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <Card>
        <CardHeader
          title="已安装插件"
          description="插件可提供存储驱动、同步协议、认证方式与首页图表"
          actions={
            <>
              <Button size="sm" variant="ghost" icon={<RefreshCw size={13} />} onClick={reload}>
                刷新
              </Button>
              <input
                ref={fileInputRef}
                type="file"
                accept=".zip,application/zip"
                className="hidden"
                onChange={(event) => void handleInstall(event.target.files?.[0] ?? null)}
              />
              <Button
                size="sm"
                variant="primary"
                icon={<Upload size={13} />}
                loading={installing}
                onClick={() => fileInputRef.current?.click()}
              >
                上传插件包
              </Button>
            </>
          }
        />

        {loading ? (
          <PageSpinner label="正在读取插件列表…" />
        ) : error && !error.isMissing ? (
          <div className="p-4">
            <Alert tone="danger">{error.message}</Alert>
          </div>
        ) : plugins.length === 0 ? (
          <EmptyState
            icon={<Plug size={22} />}
            title="还没有安装插件"
            description="插件是一个 zip 包，根目录包含 plugin.json 清单与入口 JS 文件"
            className="border-0"
          />
        ) : (
          <ul className="divide-y divide-line">
            {plugins.map((plugin) => (
              <li key={plugin.id} className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-start">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="font-sans text-sm text-ink">{plugin.name}</span>
                    <Badge tone="outline">v{plugin.version}</Badge>
                    <StatusBadge value={plugin.status} />
                    {plugin.builtin ? <Badge tone="accent">内置</Badge> : null}
                  </div>

                  <p className="mt-1 font-sans text-xs text-muted">
                    <span className="font-mono">{plugin.id}</span>
                    {plugin.author ? ` · ${plugin.author}` : ''} · 兼容 API {plugin.apiVersion}
                  </p>

                  {plugin.description ? (
                    <p className="mt-1 font-sans text-xs leading-relaxed text-ink-soft">{plugin.description}</p>
                  ) : null}

                  {plugin.error ? (
                    <Alert tone="danger" className="mt-2">
                      {plugin.error}
                    </Alert>
                  ) : null}

                  <div className="mt-2 flex flex-wrap gap-1">
                    {plugin.capabilities.map((capability) => (
                      <Badge key={capability} tone="neutral">
                        {CAPABILITY_LABELS[capability] ?? capability}
                      </Badge>
                    ))}
                    {plugin.permissions.map((permission) => (
                      <Badge key={permission} tone="outline">
                        {permission}
                      </Badge>
                    ))}
                  </div>
                </div>

                <div className="flex shrink-0 items-center gap-1">
                  <span className="mr-1 hidden font-sans text-xs text-muted lg:inline">
                    {formatRelative(plugin.updatedAt)}
                  </span>

                  <Switch
                    checked={plugin.status === 'enabled'}
                    aria-label={`${plugin.status === 'enabled' ? '停用' : '启用'} ${plugin.name}`}
                    onChange={() => void handleToggle(plugin)}
                  />

                  <Button
                    size="sm"
                    variant="quiet"
                    aria-label={`配置 ${plugin.name}`}
                    icon={<Settings2 size={13} />}
                    onClick={() => setConfigPlugin(plugin)}
                  />
                  <Button
                    size="sm"
                    variant="quiet"
                    className="hover:text-danger"
                    disabled={plugin.builtin}
                    title={plugin.builtin ? '内置插件不可卸载' : '卸载插件'}
                    icon={<Trash2 size={13} />}
                    onClick={() => setPendingDelete(plugin)}
                  />
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <PluginConfigDialog
        plugin={configPlugin}
        onClose={() => setConfigPlugin(null)}
        onSaved={() => {
          toast.success('插件配置已保存');
          reload();
        }}
      />

      <ConfirmDialog
        open={pendingDelete !== null}
        onClose={() => setPendingDelete(null)}
        onConfirm={() => void handleDelete()}
        loading={busy}
        title="卸载插件"
        confirmText="卸载"
        message={
          <>
            确定卸载插件「{pendingDelete?.name}」吗？
            <br />
            若该插件提供了正在使用的存储或同步协议，相关数据将无法访问。
          </>
        }
      />
    </div>
  );
}

/** 配置表单由插件清单里的 configFields 驱动，字段类型与校验规则都来自服务端 */
function PluginConfigDialog({
  plugin,
  onClose,
  onSaved,
}: {
  plugin: PluginSummary | null;
  onClose: () => void;
  onSaved: () => void;
}): ReactNode {
  const [values, setValues] = useState<Record<string, string | boolean>>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [loadedFor, setLoadedFor] = useState<string | null>(null);

  useEffect(() => {
    if (!plugin) {
      setLoadedFor(null);
      return;
    }
    if (loadedFor === plugin.id) return;

    setLoadedFor(plugin.id);
    setError(null);

    // 已保存的值优先；脱敏字段（含 *）不回填，留空表示不修改
    const next: Record<string, string | boolean> = {};
    for (const field of plugin.configFields) {
      const saved = plugin.config?.[field.key];
      if (field.type === 'boolean') {
        next[field.key] = saved === true || saved === 'true' || saved === field.default;
        continue;
      }
      if (typeof saved === 'string' && saved.includes('*')) {
        next[field.key] = '';
        continue;
      }
      next[field.key] = saved === undefined || saved === null ? String(field.default ?? '') : String(saved);
    }
    setValues(next);
  }, [plugin, loadedFor]);

  const handleSave = async (): Promise<void> => {
    if (!plugin) return;

    setSaving(true);
    setError(null);
    try {
      const config: Record<string, unknown> = {};
      for (const field of plugin.configFields) {
        const value = values[field.key];
        // 留空的可选敏感字段不提交，避免把空串写进配置
        if (value === '' && !field.required) continue;
        config[field.key] = field.type === 'number' ? Number(value) : value;
      }
      await api.patch(`/plugins/${plugin.id}/config`, { config });
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
      open={plugin !== null}
      onClose={onClose}
      title={`插件配置 · ${plugin?.name ?? ''}`}
      description="配置项由插件清单定义"
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
      {!plugin || plugin.configFields.length === 0 ? (
        <EmptyState title="该插件没有可配置项" />
      ) : (
        <div className="flex flex-col gap-3.5">
          {plugin.configFields.map((field) => (
            <Field
              key={field.key}
              label={field.label}
              required={field.required}
              hint={field.description}
            >
              <ConfigFieldControl
                field={field}
                value={values[field.key]}
                onChange={(value) => setValues((prev) => ({ ...prev, [field.key]: value }))}
              />
            </Field>
          ))}

          {error ? <Alert tone="danger">{error}</Alert> : null}
        </div>
      )}
    </Modal>
  );
}

function ConfigFieldControl({
  field,
  value,
  onChange,
}: {
  field: PluginConfigField;
  value: string | boolean | undefined;
  onChange: (value: string | boolean) => void;
}): ReactNode {
  if (field.type === 'boolean') {
    return <Switch checked={value === true} onChange={onChange} />;
  }

  if (field.type === 'select') {
    return (
      <Select value={String(value ?? '')} onChange={(event) => onChange(event.target.value)}>
        <option value="">请选择</option>
        {(field.options ?? []).map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </Select>
    );
  }

  return (
    <Input
      type={field.type === 'password' ? 'password' : field.type === 'number' ? 'number' : 'text'}
      value={String(value ?? '')}
      onChange={(event) => onChange(event.target.value)}
      placeholder={field.placeholder ?? ''}
      autoComplete={field.type === 'password' ? 'new-password' : undefined}
    />
  );
}
