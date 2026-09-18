import { BUILTIN_PLATFORMS, PLATFORM_LABELS, type ReadingPlatform } from '@readsync/shared';
import { Plus, Trash2 } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Alert } from '../../components/ui/Alert';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Card, CardBody, CardFooter, CardHeader } from '../../components/ui/Card';
import { EmptyState } from '../../components/ui/EmptyState';
import { Field, Input } from '../../components/ui/Input';
import { ConfirmDialog, Modal } from '../../components/ui/Modal';
import { PageSpinner } from '../../components/ui/Spinner';
import { Table, TBody, TD, TH, THead, TR } from '../../components/ui/Table';
import { useToast } from '../../components/ui/Toast';
import { api } from '../../lib/api';
import { useAsync } from '../../lib/hooks';
import { formatDate } from '../../lib/utils';

/**
 * 阅读平台管理（README 要求 8）。
 *
 * 内置平台由服务端随同步数据提供，不可删除；用户可新增自定义平台（例如某个小众阅读器），
 * 新增后在阅读器里把 platform 字段填成对应 id，统计即可正确归类。
 */
export function Platforms(): ReactNode {
  const toast = useToast();
  const { data, loading, error, reload } = useAsync(() => api.get<ReadingPlatform[]>('/users/me/platforms'), []);

  const [createOpen, setCreateOpen] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<ReadingPlatform | null>(null);
  const [deleting, setDeleting] = useState(false);

  const [id, setId] = useState('');
  const [label, setLabel] = useState('');
  const [icon, setIcon] = useState('');
  const [color, setColor] = useState('#46586a');
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const platforms = data ?? [];
  const customPlatforms = platforms.filter((platform) => !platform.builtin);

  const resetForm = (): void => {
    setId('');
    setLabel('');
    setIcon('');
    setColor('#46586a');
    setFormError(null);
  };

  const handleCreate = async (): Promise<void> => {
    setFormError(null);

    if (!/^[a-z0-9_-]{1,64}$/.test(id)) {
      setFormError('标识只能包含小写字母、数字、下划线和连字符');
      return;
    }
    if (!label.trim()) {
      setFormError('请填写显示名称');
      return;
    }
    if (!/^#[0-9a-fA-F]{6}$/.test(color)) {
      setFormError('颜色需为 #RRGGBB 格式');
      return;
    }

    setSaving(true);
    try {
      await api.post('/users/me/platforms', {
        id: id.trim(),
        label: label.trim(),
        ...(icon.trim() ? { icon: icon.trim() } : {}),
        color,
      });
      toast.success('平台已添加');
      resetForm();
      setCreateOpen(false);
      reload();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : '添加失败');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (): Promise<void> => {
    if (!pendingDelete) return;
    setDeleting(true);
    try {
      await api.del(`/users/me/platforms/${encodeURIComponent(pendingDelete.id)}`);
      toast.success('平台已删除');
      setPendingDelete(null);
      reload();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '删除失败');
    } finally {
      setDeleting(false);
    }
  };

  if (loading) return <PageSpinner label="正在读取阅读平台…" />;

  return (
    <div className="flex flex-col gap-3">
      <Card>
        <CardHeader
          title="我的阅读平台"
          description="同步数据里 platform 字段的取值来源"
          actions={
            <Button size="sm" variant="secondary" icon={<Plus size={13} />} onClick={() => setCreateOpen(true)}>
              添加自定义平台
            </Button>
          }
        />
        <CardBody className="p-0">
          {error && !error.isMissing ? (
            <div className="p-4">
              <Alert tone="danger">{error.message}</Alert>
            </div>
          ) : platforms.length === 0 ? (
            <EmptyState title="暂无平台记录" description="同步一次阅读进度后，内置平台会自动出现" className="border-0" />
          ) : (
            <Table>
              <THead>
                <TR>
                  <TH>标识</TH>
                  <TH>显示名称</TH>
                  <TH>来源</TH>
                  <TH>添加时间</TH>
                  <TH className="text-right">操作</TH>
                </TR>
              </THead>
              <TBody>
                {platforms.map((platform) => (
                  <TR key={platform.id}>
                    <TD className="font-mono text-xs">
                      <span className="flex items-center gap-1.5">
                        {platform.color ? (
                          <span
                            className="inline-block size-2.5 rounded-[1px] border border-line"
                            style={{ backgroundColor: platform.color }}
                          />
                        ) : null}
                        {platform.id}
                      </span>
                    </TD>
                    <TD>
                      {platform.icon ? <span className="mr-1">{platform.icon}</span> : null}
                      {platform.label}
                    </TD>
                    <TD>
                      {platform.builtin ? <Badge tone="outline">内置</Badge> : <Badge tone="accent">自定义</Badge>}
                    </TD>
                    <TD className="whitespace-nowrap">{formatDate(platform.createdAt)}</TD>
                    <TD className="text-right">
                      <Button
                        size="sm"
                        variant="quiet"
                        className="hover:text-danger"
                        disabled={platform.builtin}
                        title={platform.builtin ? '内置平台不可删除' : '删除该平台'}
                        icon={<Trash2 size={13} />}
                        onClick={() => setPendingDelete(platform)}
                      />
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="内置平台" description="这些标识由系统预置，可直接在阅读器中填写" />
        <CardBody>
          <ul className="flex flex-wrap gap-1.5">
            {BUILTIN_PLATFORMS.map((platform) => (
              <li key={platform}>
                <Badge tone="neutral">
                  <span className="font-mono">{platform}</span>
                  <span className="mx-1 text-faint">·</span>
                  {PLATFORM_LABELS[platform]}
                </Badge>
              </li>
            ))}
          </ul>
          <p className="mt-3 font-sans text-xs text-muted">
            自定义平台共 {customPlatforms.length} 个。若阅读器上报了未登记的 platform，
            统计里会按原始字符串显示，但不影响时长累计。
          </p>
        </CardBody>
      </Card>

      <Modal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        title="添加自定义平台"
        description="标识需与阅读器上报的 platform 字段完全一致"
        footer={
          <>
            <Button variant="ghost" size="sm" onClick={() => setCreateOpen(false)}>
              取消
            </Button>
            <Button variant="primary" size="sm" loading={saving} onClick={() => void handleCreate()}>
              添加
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3.5">
          <Field label="平台标识" required hint="小写字母、数字、下划线、连字符，例如 boox_neo">
            <Input
              value={id}
              onChange={(event) => setId(event.target.value.toLowerCase())}
              className="font-mono"
              maxLength={64}
            />
          </Field>

          <Field label="显示名称" required>
            <Input value={label} onChange={(event) => setLabel(event.target.value)} maxLength={64} />
          </Field>

          <div className="grid grid-cols-2 gap-3">
            <Field label="图标" hint="可填 emoji">
              <Input value={icon} onChange={(event) => setIcon(event.target.value)} maxLength={64} placeholder="📖" />
            </Field>

            <Field label="主题色" hint="#RRGGBB">
              <input
                type="color"
                value={color}
                onChange={(event) => setColor(event.target.value)}
                className="h-9 w-full cursor-pointer rounded-sm border border-line bg-surface px-1"
              />
            </Field>
          </div>

          {formError ? <Alert tone="danger">{formError}</Alert> : null}
        </div>
      </Modal>

      <ConfirmDialog
        open={pendingDelete !== null}
        onClose={() => setPendingDelete(null)}
        onConfirm={() => void handleDelete()}
        loading={deleting}
        title="删除阅读平台"
        confirmText="删除"
        message={
          <>
            确定要删除自定义平台「{pendingDelete?.label}」吗？
            <br />
            已产生的统计数据不会被删除，只是之后不能再选择该平台。
          </>
        }
      />
    </div>
  );
}
