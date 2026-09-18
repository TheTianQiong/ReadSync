import type { CreateInviteInput, InviteCode, Paginated } from '@readsync/shared';
import { Copy, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Alert } from '../../components/ui/Alert';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Card, CardBody, CardHeader } from '../../components/ui/Card';
import { EmptyState } from '../../components/ui/EmptyState';
import { Field, Input } from '../../components/ui/Input';
import { ConfirmDialog, Modal } from '../../components/ui/Modal';
import { Pagination } from '../../components/ui/Pagination';
import { PageSpinner } from '../../components/ui/Spinner';
import { Table, TBody, TD, TH, THead, TR } from '../../components/ui/Table';
import { useToast } from '../../components/ui/Toast';
import { api } from '../../lib/api';
import { useAsync } from '../../lib/hooks';
import { copyText, formatDateTime, formatRelative } from '../../lib/utils';

const PAGE_SIZE = 20;

/**
 * 邀请码管理（README 要求 9）。
 *
 * 邀请码是否生效由「网站管理 → 需要邀请码」开关决定；
 * 这里只负责发放与吊销，关闭开关后已发放的邀请码不会被删除。
 */
export function Invites(): ReactNode {
  const toast = useToast();

  const [page, setPage] = useState(1);
  const [createOpen, setCreateOpen] = useState(false);
  const [code, setCode] = useState('');
  const [maxUses, setMaxUses] = useState('1');
  const [expiresAt, setExpiresAt] = useState('');
  const [note, setNote] = useState('');
  const [creating, setCreating] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const [pendingDelete, setPendingDelete] = useState<InviteCode | null>(null);
  const [busy, setBusy] = useState(false);

  const { data, loading, error, reload } = useAsync(
    () => api.get<Paginated<InviteCode>>('/admin/invites', { page, pageSize: PAGE_SIZE }),
    [page],
  );

  const invites = data?.items ?? [];

  const handleCreate = async (): Promise<void> => {
    setFormError(null);
    if (code && !/^[A-Za-z0-9_-]{4,64}$/.test(code)) {
      setFormError('邀请码只能包含字母、数字、下划线和连字符，至少 4 位');
      return;
    }

    setCreating(true);
    try {
      const payload: CreateInviteInput = {
        maxUses: Number(maxUses) || 0,
        ...(code.trim() ? { code: code.trim() } : {}),
        ...(note.trim() ? { note: note.trim() } : {}),
        ...(expiresAt ? { expiresAt: new Date(expiresAt).toISOString() } : {}),
      };
      await api.post('/admin/invites', payload);
      toast.success('邀请码已创建');
      setCode('');
      setMaxUses('1');
      setExpiresAt('');
      setNote('');
      setCreateOpen(false);
      reload();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : '创建失败');
    } finally {
      setCreating(false);
    }
  };

  const handleDelete = async (): Promise<void> => {
    if (!pendingDelete) return;
    setBusy(true);
    try {
      await api.del(`/admin/invites/${pendingDelete.id}`);
      toast.success('邀请码已删除');
      setPendingDelete(null);
      reload();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '删除失败');
    } finally {
      setBusy(false);
    }
  };

  const handleCopy = async (value: string): Promise<void> => {
    const ok = await copyText(value);
    if (ok) toast.success('邀请码已复制');
    else toast.error('复制失败');
  };

  return (
    <div className="flex flex-col gap-3">
      <Card>
        <CardHeader
          title="邀请码"
          description="每个邀请码可限制使用次数与有效期"
          actions={
            <>
              <Button size="sm" variant="ghost" icon={<RefreshCw size={13} />} onClick={reload}>
                刷新
              </Button>
              <Button size="sm" variant="primary" icon={<Plus size={13} />} onClick={() => setCreateOpen(true)}>
                创建邀请码
              </Button>
            </>
          }
        />
        <CardBody className="p-0">
          {loading ? (
            <PageSpinner label="正在读取邀请码…" />
          ) : error && !error.isMissing ? (
            <div className="p-4">
              <Alert tone="danger">{error.message}</Alert>
            </div>
          ) : invites.length === 0 ? (
            <EmptyState title="还没有邀请码" description="创建后可在「网站管理」中开启邀请码注册" className="border-0" />
          ) : (
            <Table>
              <THead>
                <TR>
                  <TH>邀请码</TH>
                  <TH>使用情况</TH>
                  <TH>状态</TH>
                  <TH>备注</TH>
                  <TH>过期时间</TH>
                  <TH>创建时间</TH>
                  <TH className="text-right">操作</TH>
                </TR>
              </THead>
              <TBody>
                {invites.map((invite) => (
                  <TR key={invite.id}>
                    <TD>
                      <span className="flex items-center gap-1.5">
                        <span className="font-mono text-xs text-ink">{invite.code}</span>
                        <button
                          type="button"
                          aria-label="复制邀请码"
                          onClick={() => void handleCopy(invite.code)}
                          className="cursor-pointer p-0.5 text-muted transition-colors hover:text-ink"
                        >
                          <Copy size={11} />
                        </button>
                      </span>
                    </TD>
                    <TD className="whitespace-nowrap">
                      {invite.usedCount} / {invite.maxUses === 0 ? '不限' : invite.maxUses}
                    </TD>
                    <TD>
                      {invite.exhausted ? <Badge tone="danger">已失效</Badge> : <Badge tone="ochre">可用</Badge>}
                    </TD>
                    <TD className="max-w-40 truncate">{invite.note || '—'}</TD>
                    <TD className="whitespace-nowrap">
                      {invite.expiresAt ? formatDateTime(invite.expiresAt) : '永不过期'}
                    </TD>
                    <TD className="whitespace-nowrap">{formatRelative(invite.createdAt)}</TD>
                    <TD className="text-right">
                      <Button
                        size="sm"
                        variant="quiet"
                        className="hover:text-danger"
                        icon={<Trash2 size={13} />}
                        onClick={() => setPendingDelete(invite)}
                      />
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          )}

          {invites.length > 0 ? (
            <div className="border-t border-line px-3 py-2">
              <Pagination
                page={data?.page ?? page}
                totalPages={data?.totalPages ?? 1}
                total={data?.total ?? 0}
                pageSize={data?.pageSize ?? PAGE_SIZE}
                onChange={setPage}
              />
            </div>
          ) : null}
        </CardBody>
      </Card>

      <Modal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        title="创建邀请码"
        description="留空邀请码则由服务端自动生成"
        footer={
          <>
            <Button variant="ghost" size="sm" onClick={() => setCreateOpen(false)}>
              取消
            </Button>
            <Button variant="primary" size="sm" loading={creating} onClick={() => void handleCreate()}>
              创建
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3.5">
          <Field label="邀请码" hint="4–64 位字母、数字、下划线或连字符">
            <Input
              value={code}
              onChange={(event) => setCode(event.target.value)}
              placeholder="留空自动生成"
              className="font-mono"
              maxLength={64}
            />
          </Field>

          <div className="grid grid-cols-2 gap-3">
            <Field label="可注册次数" hint="0 表示不限次数">
              <Input type="number" min={0} value={maxUses} onChange={(event) => setMaxUses(event.target.value)} />
            </Field>
            <Field label="过期时间" hint="留空表示永不过期">
              <Input
                type="datetime-local"
                value={expiresAt}
                onChange={(event) => setExpiresAt(event.target.value)}
              />
            </Field>
          </div>

          <Field label="备注" hint="例如发给谁、用途">
            <Input value={note} onChange={(event) => setNote(event.target.value)} maxLength={128} />
          </Field>

          {formError ? <Alert tone="danger">{formError}</Alert> : null}
        </div>
      </Modal>

      <ConfirmDialog
        open={pendingDelete !== null}
        onClose={() => setPendingDelete(null)}
        onConfirm={() => void handleDelete()}
        loading={busy}
        title="删除邀请码"
        confirmText="删除"
        message={`确定删除邀请码「${pendingDelete?.code}」吗？删除后无法再用于注册。`}
      />
    </div>
  );
}
