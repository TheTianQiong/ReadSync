import type { UserPluginSummary } from '@readsync/shared';
import { Plug, RefreshCw, Trash2 } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import {
  ConfigFieldControl,
  collectConfig,
  initialValues,
  visibleFields,
  type FieldValues,
} from '../../components/PluginConfigFields';
import { Alert } from '../../components/ui/Alert';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Card, CardBody, CardHeader } from '../../components/ui/Card';
import { EmptyState } from '../../components/ui/EmptyState';
import { Field } from '../../components/ui/Input';
import { ConfirmDialog } from '../../components/ui/Modal';
import { PageSpinner } from '../../components/ui/Spinner';
import { useToast } from '../../components/ui/Toast';
import { api } from '../../lib/api';
import { useAsync } from '../../lib/hooks';
import { formatRelative } from '../../lib/utils';

/**
 * 插件自助配置（设置 → 插件）。
 *
 * 有些插件干的事天然属于个人：「把我自己网盘上的阅读记录导进来」。这类配置
 * 如果只能由管理员填，一个插件就只有一份，第二个用户要么用不了，要么就得
 * 把自己的网盘密码交给管理员 —— 两条路都不通。
 *
 * 所以配置分了两层：管理员填 `scope: 'site'` 的部分（多久跑一次之类），
 * 每个用户在这里填 `scope: 'user'` 的部分（他自己的地址与凭据）。
 * **导入写进哪个账号由服务端决定**，这里根本没有「用户名」这个字段可填。
 */
export function PluginSettings(): ReactNode {
  const toast = useToast();
  const { data, loading, error, reload } = useAsync(
    () => api.get<UserPluginSummary[]>('/plugins/mine'),
    [],
  );

  const plugins = data ?? [];

  if (loading) return <PageSpinner label="正在读取插件…" />;

  return (
    <div className="flex flex-col gap-3">
      <Card>
        <CardHeader
          title="插件"
          description="需要你自己填写的插件配置"
          actions={
            <Button size="sm" variant="ghost" icon={<RefreshCw size={13} />} onClick={reload}>
              刷新
            </Button>
          }
        />
        <CardBody className="p-0">
          {error && !error.isMissing ? (
            <div className="p-4">
              <Alert tone="danger">{error.message}</Alert>
            </div>
          ) : plugins.length === 0 ? (
            <EmptyState
              icon={<Plug size={22} />}
              title="没有需要你配置的插件"
              description="插件由管理员安装；只有需要你自己填写配置的插件才会出现在这里"
              className="border-0"
            />
          ) : (
            <ul className="divide-y divide-line">
              {plugins.map((plugin) => (
                <PluginConfigCard
                  key={plugin.id}
                  plugin={plugin}
                  onSaved={(message) => {
                    toast.success(message);
                    reload();
                  }}
                />
              ))}
            </ul>
          )}
        </CardBody>
      </Card>

      <p className="font-sans text-xs leading-relaxed text-muted">
        插件由管理员安装与启用。这里填写的配置只属于你自己的账号，其他用户看不到；
        <br />
        数据导入的目标账号由服务端在导入时确定，插件无法把数据写进别人的账号。
      </p>
    </div>
  );
}

/** 单个插件的配置卡片：一份由清单字段驱动的表单 + 保存/清空 */
function PluginConfigCard({
  plugin,
  onSaved,
}: {
  plugin: UserPluginSummary;
  onSaved: (message: string) => void;
}): ReactNode {
  const [values, setValues] = useState<FieldValues>(() => initialValues(plugin.configFields, plugin.config));
  const [saving, setSaving] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSave = async (): Promise<void> => {
    setSaving(true);
    setError(null);
    try {
      await api.put(`/plugins/${plugin.id}/my-config`, { config: collectConfig(plugin.configFields, values) });
      onSaved(`「${plugin.name}」配置已保存`);
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存失败');
    } finally {
      setSaving(false);
    }
  };

  const handleClear = async (): Promise<void> => {
    setClearing(true);
    try {
      await api.del(`/plugins/${plugin.id}/my-config`);
      setValues(initialValues(plugin.configFields, {}));
      setConfirmClear(false);
      onSaved(`已清空「${plugin.name}」的配置`);
    } catch (err) {
      setError(err instanceof Error ? err.message : '清空失败');
    } finally {
      setClearing(false);
    }
  };

  return (
    <li className="flex flex-col gap-3 px-4 py-4">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="font-sans text-sm text-ink">{plugin.name}</span>
        <Badge tone="outline">v{plugin.version}</Badge>
        {plugin.configured ? (
          <Badge tone="accent">已配置</Badge>
        ) : (
          <Badge tone="neutral">未配置</Badge>
        )}
      </div>

      {plugin.description ? (
        <p className="font-sans text-xs leading-relaxed text-muted">{plugin.description}</p>
      ) : null}

      <div className="flex flex-col gap-3.5">
        {visibleFields(plugin.configFields, values).map((field) => (
          <Field key={field.key} label={field.label} required={field.required} hint={field.description}>
            <ConfigFieldControl
              field={field}
              value={values[field.key]}
              onChange={(value) => setValues((prev) => ({ ...prev, [field.key]: value }))}
            />
          </Field>
        ))}

        {error ? <Alert tone="danger">{error}</Alert> : null}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2">
        {/* 上次运行结果是插件自己写的，它才是回答「到底跑没跑」的唯一来源 */}
        <span className="font-sans text-xs text-muted">
          {describeLastRun(plugin.lastRun)}
        </span>

        <div className="flex items-center gap-1">
          <Button
            size="sm"
            variant="quiet"
            className="hover:text-danger"
            disabled={!plugin.configured}
            title={plugin.configured ? '清空我的配置' : '尚未配置'}
            icon={<Trash2 size={13} />}
            onClick={() => setConfirmClear(true)}
          >
            清空
          </Button>
          <Button size="sm" variant="primary" loading={saving} onClick={() => void handleSave()}>
            保存
          </Button>
        </div>
      </div>

      <ConfirmDialog
        open={confirmClear}
        onClose={() => setConfirmClear(false)}
        onConfirm={() => void handleClear()}
        loading={clearing}
        title="清空插件配置"
        confirmText="清空"
        message={
          <>
            确定清空「{plugin.name}」的配置吗？
            <br />
            清空后该插件不再处理你的账号，已导入的数据不会被删除。
          </>
        }
      />
    </li>
  );
}

/** 把插件写下的运行结果转成一句人话；插件没写过就如实说「还没有记录」 */
function describeLastRun(lastRun: unknown): string {
  if (!lastRun || typeof lastRun !== 'object') return '还没有运行记录';

  const record = lastRun as { at?: unknown; message?: unknown; days?: unknown; inserted?: unknown };
  const at = typeof record.at === 'string' ? formatRelative(record.at) : null;
  const detail =
    typeof record.message === 'string'
      ? record.message
      : typeof record.inserted === 'number'
        ? `导入 ${record.inserted} 条记录`
        : null;

  if (at && detail) return `上次运行：${at} · ${detail}`;
  if (at) return `上次运行：${at}`;
  return detail ?? '还没有运行记录';
}
