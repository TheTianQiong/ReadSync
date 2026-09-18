import type { Paginated, SyncEntry, SyncToken } from '@readsync/shared';
import { Copy, Link2, Plus, Trash2 } from 'lucide-react';
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
 * 同步账号与接入令牌（README 要求 8，及「统一同步接口」要求）。
 *
 * 三部分：
 *  1. KOSync 接入说明 —— KOReader 用固定的 x-auth-user / x-auth-key 头，
 *     这里只做引导，配置在阅读器端完成；
 *  2. 接入令牌 —— 给第三方阅读软件调用 /api/sync/* 用，明文只在创建时出现一次；
 *  3. 同步条目 —— 已同步的文档列表，可删除单条记录。
 */
export function SyncAccount(): ReactNode {
  const toast = useToast();

  const [createOpen, setCreateOpen] = useState(false);
  const [tokenName, setTokenName] = useState('');
  const [scopes, setScopes] = useState('sync');
  const [expiresAt, setExpiresAt] = useState('');
  const [creating, setCreating] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [issuedToken, setIssuedToken] = useState<SyncToken | null>(null);

  const [pendingDelete, setPendingDelete] = useState<SyncToken | null>(null);
  const [pendingEntryDelete, setPendingEntryDelete] = useState<SyncEntry | null>(null);
  const [busy, setBusy] = useState(false);
  const [entryPage, setEntryPage] = useState(1);

  const tokens = useAsync(() => api.get<SyncToken[]>('/sync/tokens'), []);
  const entries = useAsync(
    () => api.get<Paginated<SyncEntry>>('/sync/entries', { page: entryPage, pageSize: PAGE_SIZE }),
    [entryPage],
  );

  const origin = typeof window !== 'undefined' ? window.location.origin : '';

  const handleCreate = async (): Promise<void> => {
    setFormError(null);
    if (!tokenName.trim()) {
      setFormError('请填写令牌名称');
      return;
    }

    setCreating(true);
    try {
      const created = await api.post<SyncToken>('/sync/tokens', {
        name: tokenName.trim(),
        scopes: scopes
          .split(/[,，\s]+/)
          .map((item) => item.trim())
          .filter(Boolean),
        ...(expiresAt ? { expiresAt: new Date(expiresAt).toISOString() } : {}),
      });
      // 明文只在这里出现一次，必须让用户看见后再关闭
      setIssuedToken(created);
      setCreateOpen(false);
      setTokenName('');
      setExpiresAt('');
      tokens.reload();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : '创建失败');
    } finally {
      setCreating(false);
    }
  };

  const handleDeleteToken = async (): Promise<void> => {
    if (!pendingDelete) return;
    setBusy(true);
    try {
      await api.del(`/sync/tokens/${pendingDelete.id}`);
      toast.success('令牌已删除');
      setPendingDelete(null);
      tokens.reload();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '删除失败');
    } finally {
      setBusy(false);
    }
  };

  const handleDeleteEntry = async (): Promise<void> => {
    if (!pendingEntryDelete) return;
    setBusy(true);
    try {
      await api.del(`/sync/progress/${encodeURIComponent(pendingEntryDelete.document)}`);
      toast.success('同步记录已删除');
      setPendingEntryDelete(null);
      entries.reload();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '删除失败');
    } finally {
      setBusy(false);
    }
  };

  const handleCopy = async (text: string, label: string): Promise<void> => {
    const ok = await copyText(text);
    if (ok) toast.success(`${label}已复制`);
    else toast.error('复制失败，请手动选择文本');
  };

  return (
    <div className="flex flex-col gap-3">
      {/* KOSync 接入说明 */}
      <Card>
        <CardHeader
          title="KOReader / KOSync"
          description="KOReader 内置的进度同步协议，服务端已兼容"
          actions={<Badge tone="ochre">协议已启用</Badge>}
        />
        <CardBody className="flex flex-col gap-3">
          <ol className="flex list-decimal flex-col gap-1.5 pl-4 font-sans text-xs leading-relaxed text-ink-soft">
            <li>在 KOReader 中打开「工具 → 云存储 → 进度同步」。</li>
            <li>
              自定义同步服务器填写：
              <code className="mx-1 rounded-sm border border-line bg-raised px-1.5 py-0.5 font-mono text-[11px]">
                {origin}
              </code>
            </li>
            <li>用户名与密码填写本站账号（或下方说明的独立同步密码）。</li>
          </ol>

          <Alert tone="info">
            KOSync 由客户端固定使用「密码的 MD5」作为认证凭据，无法改为更安全的方案。
            建议在「账号安全」中设置一个与主密码不同的同步密码，避免主密码的 MD5 泄露后危及账号。
          </Alert>
        </CardBody>
      </Card>

      {/* 接入令牌 */}
      <Card>
        <CardHeader
          title="接入令牌"
          description="供第三方阅读软件调用统一同步接口（/api/sync/*）使用"
          actions={
            <Button size="sm" variant="secondary" icon={<Plus size={13} />} onClick={() => setCreateOpen(true)}>
              新建令牌
            </Button>
          }
        />
        <CardBody className="p-0">
          {tokens.loading ? (
            <PageSpinner label="正在读取令牌…" />
          ) : tokens.error && !tokens.error.isMissing ? (
            <div className="p-4">
              <Alert tone="danger">{tokens.error.message}</Alert>
            </div>
          ) : (tokens.data?.length ?? 0) === 0 ? (
            <EmptyState
              icon={<Link2 size={22} />}
              title="还没有接入令牌"
              description="创建后把令牌填进阅读软件的同步设置里即可"
              className="border-0"
            />
          ) : (
            <Table>
              <THead>
                <TR>
                  <TH>名称</TH>
                  <TH>前缀</TH>
                  <TH>权限</TH>
                  <TH>最后使用</TH>
                  <TH>过期时间</TH>
                  <TH className="text-right">操作</TH>
                </TR>
              </THead>
              <TBody>
                {tokens.data?.map((token) => (
                  <TR key={token.id}>
                    <TD className="font-sans text-sm text-ink">{token.name}</TD>
                    <TD className="font-mono text-xs">{token.tokenPrefix}…</TD>
                    <TD>
                      <span className="flex flex-wrap gap-1">
                        {token.scopes.map((scope) => (
                          <Badge key={scope} tone="outline">
                            {scope}
                          </Badge>
                        ))}
                      </span>
                    </TD>
                    <TD className="whitespace-nowrap">{formatRelative(token.lastUsedAt)}</TD>
                    <TD className="whitespace-nowrap">
                      {token.expiresAt ? formatDateTime(token.expiresAt) : '永不过期'}
                    </TD>
                    <TD className="text-right">
                      <Button
                        size="sm"
                        variant="quiet"
                        className="hover:text-danger"
                        icon={<Trash2 size={13} />}
                        onClick={() => setPendingDelete(token)}
                      />
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          )}
        </CardBody>
      </Card>

      {/* 同步条目 */}
      <Card>
        <CardHeader title="同步条目" description="服务端当前保存的阅读进度快照" />
        <CardBody className="p-0">
          {entries.loading ? (
            <PageSpinner label="正在读取同步记录…" />
          ) : entries.error && !entries.error.isMissing ? (
            <div className="p-4">
              <Alert tone="danger">{entries.error.message}</Alert>
            </div>
          ) : (entries.data?.items.length ?? 0) === 0 ? (
            <EmptyState title="还没有同步记录" description="在阅读器中推送一次进度后即可看到" className="border-0" />
          ) : (
            <>
              <Table>
                <THead>
                  <TR>
                    <TH>文档</TH>
                    <TH>书名</TH>
                    <TH>平台</TH>
                    <TH>设备</TH>
                    <TH className="text-right">进度</TH>
                    <TH>更新时间</TH>
                    <TH className="text-right">操作</TH>
                  </TR>
                </THead>
                <TBody>
                  {entries.data?.items.map((entry) => (
                    <TR key={entry.id}>
                      <TD className="max-w-48 truncate font-mono text-xs">{entry.document}</TD>
                      <TD className="max-w-40 truncate">{entry.title || '—'}</TD>
                      <TD className="whitespace-nowrap">{entry.platform}</TD>
                      <TD className="max-w-32 truncate">{entry.device || '—'}</TD>
                      <TD className="text-right whitespace-nowrap">{Math.round(entry.percentage * 100)}%</TD>
                      <TD className="whitespace-nowrap">{formatRelative(entry.updatedAt)}</TD>
                      <TD className="text-right">
                        <Button
                          size="sm"
                          variant="quiet"
                          className="hover:text-danger"
                          icon={<Trash2 size={13} />}
                          onClick={() => setPendingEntryDelete(entry)}
                        />
                      </TD>
                    </TR>
                  ))}
                </TBody>
              </Table>

              <div className="border-t border-line px-3 py-2">
                <Pagination
                  page={entries.data?.page ?? entryPage}
                  totalPages={entries.data?.totalPages ?? 1}
                  total={entries.data?.total ?? 0}
                  pageSize={entries.data?.pageSize ?? PAGE_SIZE}
                  onChange={setEntryPage}
                />
              </div>
            </>
          )}
        </CardBody>
      </Card>

      {/* 新建令牌 */}
      <Modal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        title="新建接入令牌"
        description="令牌只在创建时显示一次，请立即保存"
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
          <Field label="名称" required hint="用于区分不同设备或软件">
            <Input
              value={tokenName}
              onChange={(event) => setTokenName(event.target.value)}
              maxLength={64}
              placeholder="Kindle 上的 KOReader"
            />
          </Field>

          <Field label="权限范围" hint="空格或逗号分隔，默认 sync 即可">
            <Input value={scopes} onChange={(event) => setScopes(event.target.value)} />
          </Field>

          <Field label="过期时间" hint="留空表示永不过期">
            <Input type="datetime-local" value={expiresAt} onChange={(event) => setExpiresAt(event.target.value)} />
          </Field>

          {formError ? <Alert tone="danger">{formError}</Alert> : null}
        </div>
      </Modal>

      {/* 令牌明文（一次性） */}
      <Modal
        open={issuedToken !== null}
        onClose={() => setIssuedToken(null)}
        title="令牌创建成功"
        description="关闭后无法再次查看，请立即复制保存"
        footer={
          <Button variant="primary" size="sm" onClick={() => setIssuedToken(null)}>
            我已保存
          </Button>
        }
      >
        <div className="flex flex-col gap-3">
          <Alert tone="warning">服务端只保存令牌的哈希值，遗失后只能删除并重新创建。</Alert>

          <Field label="令牌">
            <div className="flex gap-2">
              <Input readOnly value={issuedToken?.token ?? ''} className="font-mono text-xs" />
              <Button
                size="md"
                variant="secondary"
                icon={<Copy size={13} />}
                onClick={() => void handleCopy(issuedToken?.token ?? '', '令牌')}
              />
            </div>
          </Field>

          <div className="rounded-sm border border-line bg-raised p-3">
            <p className="mb-1.5 font-sans text-xs text-muted">把它填进阅读软件的同步设置：</p>
            <pre className="overflow-x-auto font-mono text-[11px] leading-relaxed text-ink-soft">
{`服务器地址：${origin}
认证方式：Authorization: Bearer <令牌>
推送进度：PUT /api/sync/progress
拉取进度：GET  /api/sync/progress/{document}`}
            </pre>
          </div>
        </div>
      </Modal>

      <ConfirmDialog
        open={pendingDelete !== null}
        onClose={() => setPendingDelete(null)}
        onConfirm={() => void handleDeleteToken()}
        loading={busy}
        title="删除令牌"
        confirmText="删除"
        message={`确定删除令牌「${pendingDelete?.name}」吗？使用它的阅读软件将立即无法同步。`}
      />

      <ConfirmDialog
        open={pendingEntryDelete !== null}
        onClose={() => setPendingEntryDelete(null)}
        onConfirm={() => void handleDeleteEntry()}
        loading={busy}
        title="删除同步记录"
        confirmText="删除"
        message={
          <>
            确定删除文档「{pendingEntryDelete?.title || pendingEntryDelete?.document}」的同步记录吗？
            <br />
            阅读器下次同步时会重新上传该文档的进度。
          </>
        }
      />
    </div>
  );
}
