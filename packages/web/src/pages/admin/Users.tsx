import {
  USER_ROLES,
  USER_STATUSES,
  type AdminUserSummary,
  type ListUsersQuery,
  type Paginated,
} from '@readsync/shared';
import { KeyRound, Pencil, Plus, RefreshCw, Search, Trash2 } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Alert } from '../../components/ui/Alert';
import { Badge, StatusBadge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Card, CardBody, CardHeader } from '../../components/ui/Card';
import { EmptyState } from '../../components/ui/EmptyState';
import { Field, Input, Select } from '../../components/ui/Input';
import { ConfirmDialog, Modal } from '../../components/ui/Modal';
import { Pagination } from '../../components/ui/Pagination';
import { PageSpinner } from '../../components/ui/Spinner';
import { Table, TBody, TD, TH, THead, TR } from '../../components/ui/Table';
import { useToast } from '../../components/ui/Toast';
import { api } from '../../lib/api';
import { encryptPassword } from '../../lib/crypto';
import { useAsync, useDebounced } from '../../lib/hooks';
import { formatBytes, formatDateTime, formatRelative } from '../../lib/utils';

const PAGE_SIZE = 20;

/**
 * 用户管理（README 要求 9：创建、删除、重置密码、设置/取消权限）。
 *
 * README 提到「密码通过不对称加密的方式存储，私钥存在服务器本地」——
 * 实际实现是：传输用 RSA-OAEP 加密、落库用 Argon2id 单向哈希；
 * 管理员创建/重置密码时同样只把新密码交给服务端一次，之后无法再查看。
 */
export function Users(): ReactNode {
  const toast = useToast();

  const [search, setSearch] = useState('');
  const debouncedSearch = useDebounced(search, 300);
  const [role, setRole] = useState('');
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);

  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<AdminUserSummary | null>(null);
  const [resetting, setResetting] = useState<AdminUserSummary | null>(null);
  const [pendingDelete, setPendingDelete] = useState<AdminUserSummary | null>(null);
  const [busy, setBusy] = useState(false);

  const { data, loading, error, reload } = useAsync(
    () =>
      api.get<Paginated<AdminUserSummary>>('/admin/users', {
        page,
        pageSize: PAGE_SIZE,
        q: debouncedSearch || undefined,
        role: role || undefined,
        status: status || undefined,
        sortBy: 'createdAt' as ListUsersQuery['sortBy'],
        sortOrder: 'desc',
      }),
    [page, debouncedSearch, role, status],
  );

  const users = data?.items ?? [];

  const handleDelete = async (): Promise<void> => {
    if (!pendingDelete) return;
    setBusy(true);
    try {
      await api.del(`/admin/users/${pendingDelete.id}`);
      toast.success(`已删除用户 ${pendingDelete.username}`);
      setPendingDelete(null);
      reload();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '删除失败');
    } finally {
      setBusy(false);
    }
  };

  const handleToggleStatus = async (user: AdminUserSummary): Promise<void> => {
    const next = user.status === 'active' ? 'disabled' : 'active';
    try {
      await api.patch(`/admin/users/${user.id}`, { status: next });
      toast.success(next === 'disabled' ? '已停用该账号' : '已启用该账号');
      reload();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '操作失败');
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <Card>
        <CardHeader
          title="用户列表"
          description={`共 ${data?.total ?? 0} 个账号`}
          actions={
            <>
              <Button size="sm" variant="ghost" icon={<RefreshCw size={13} />} onClick={reload}>
                刷新
              </Button>
              <Button size="sm" variant="primary" icon={<Plus size={13} />} onClick={() => setCreateOpen(true)}>
                创建用户
              </Button>
            </>
          }
        />
        <CardBody className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-52 flex-1">
            <Search size={13} className="absolute top-1/2 left-2.5 -translate-y-1/2 text-faint" />
            <Input
              value={search}
              onChange={(event) => {
                setSearch(event.target.value);
                setPage(1);
              }}
              placeholder="搜索用户名或邮箱…"
              className="pl-7"
            />
          </div>

          <Select
            value={role}
            onChange={(event) => {
              setRole(event.target.value);
              setPage(1);
            }}
            className="w-32"
          >
            <option value="">全部角色</option>
            {USER_ROLES.map((item) => (
              <option key={item} value={item}>
                {item === 'admin' ? '管理员' : '普通用户'}
              </option>
            ))}
          </Select>

          <Select
            value={status}
            onChange={(event) => {
              setStatus(event.target.value);
              setPage(1);
            }}
            className="w-32"
          >
            <option value="">全部状态</option>
            {USER_STATUSES.map((item) => (
              <option key={item} value={item}>
                {item === 'active' ? '正常' : '已停用'}
              </option>
            ))}
          </Select>
        </CardBody>
      </Card>

      {loading ? (
        <PageSpinner label="正在读取用户列表…" />
      ) : error && !error.isMissing ? (
        <Alert tone="danger">{error.message}</Alert>
      ) : users.length === 0 ? (
        <EmptyState title="没有匹配的用户" />
      ) : (
        <Card>
          <Table>
            <THead>
              <TR>
                <TH>用户名</TH>
                <TH>邮箱</TH>
                <TH>角色</TH>
                <TH>状态</TH>
                <TH>安全</TH>
                <TH className="text-right">书籍 / 容量</TH>
                <TH>最近登录</TH>
                <TH className="text-right">操作</TH>
              </TR>
            </THead>
            <TBody>
              {users.map((user) => (
                <TR key={user.id}>
                  <TD>
                    <div className="font-sans text-sm text-ink">{user.username}</div>
                    <div className="font-sans text-xs text-muted">{user.displayName || '未设置昵称'}</div>
                  </TD>
                  <TD className="max-w-48 truncate">{user.email}</TD>
                  <TD>
                    <StatusBadge value={user.role} />
                  </TD>
                  <TD>
                    <StatusBadge value={user.status} />
                  </TD>
                  <TD>
                    <span className="flex flex-wrap gap-1">
                      {user.totpEnabled ? <Badge tone="ochre">2FA</Badge> : null}
                      {user.passkeyCount > 0 ? <Badge tone="outline">密钥 {user.passkeyCount}</Badge> : null}
                      {!user.totpEnabled && user.passkeyCount === 0 ? (
                        <span className="font-sans text-xs text-muted">仅密码</span>
                      ) : null}
                    </span>
                  </TD>
                  <TD className="text-right whitespace-nowrap">
                    {user.bookCount} 本 · {formatBytes(user.usedBytes)}
                  </TD>
                  <TD className="whitespace-nowrap">{formatRelative(user.lastLoginAt)}</TD>
                  <TD className="text-right">
                    <div className="flex justify-end gap-0.5">
                      <Button
                        size="sm"
                        variant="quiet"
                        title={user.status === 'active' ? '停用账号' : '启用账号'}
                        onClick={() => void handleToggleStatus(user)}
                      >
                        {user.status === 'active' ? '停用' : '启用'}
                      </Button>
                      <Button
                        size="sm"
                        variant="quiet"
                        aria-label={`重置 ${user.username} 的密码`}
                        icon={<KeyRound size={13} />}
                        onClick={() => setResetting(user)}
                      />
                      <Button
                        size="sm"
                        variant="quiet"
                        aria-label={`编辑 ${user.username}`}
                        icon={<Pencil size={13} />}
                        onClick={() => setEditing(user)}
                      />
                      <Button
                        size="sm"
                        variant="quiet"
                        className="hover:text-danger"
                        aria-label={`删除 ${user.username}`}
                        icon={<Trash2 size={13} />}
                        onClick={() => setPendingDelete(user)}
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

      <CreateUserDialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onSaved={() => {
          toast.success('用户已创建');
          reload();
        }}
      />

      <EditUserDialog
        user={editing}
        onClose={() => setEditing(null)}
        onSaved={() => {
          toast.success('用户信息已更新');
          reload();
        }}
      />

      <ResetPasswordDialog
        user={resetting}
        onClose={() => setResetting(null)}
        onSaved={() => toast.success('密码已重置，请把新密码告知用户')}
      />

      <ConfirmDialog
        open={pendingDelete !== null}
        onClose={() => setPendingDelete(null)}
        onConfirm={() => void handleDelete()}
        loading={busy}
        title="删除用户"
        confirmText="删除"
        message={
          <>
            确定要删除用户「{pendingDelete?.username}」吗？
            <br />
            该用户的 {pendingDelete?.bookCount ?? 0} 本书、存储配置与同步记录都会被一并删除，且不可恢复。
          </>
        }
      />
    </div>
  );
}

function CreateUserDialog({
  open,
  onClose,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
}): ReactNode {
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [role, setRole] = useState<'admin' | 'user'>('user');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleCreate = async (): Promise<void> => {
    setError(null);
    if (username.trim().length < 3) {
      setError('用户名至少 3 个字符');
      return;
    }
    if (password.length < 8) {
      setError('密码至少 8 个字符');
      return;
    }

    setSaving(true);
    try {
      const payload = await encryptPassword(password);
      await api.post('/admin/users', {
        username: username.trim(),
        email: email.trim(),
        password: payload,
        role,
        ...(displayName.trim() ? { displayName: displayName.trim() } : {}),
      });
      setUsername('');
      setEmail('');
      setPassword('');
      setDisplayName('');
      setRole('user');
      onSaved();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : '创建失败');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="创建用户"
      description="管理员创建账号不受站点注册开关与邀请码限制"
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={onClose}>
            取消
          </Button>
          <Button variant="primary" size="sm" loading={saving} onClick={() => void handleCreate()}>
            创建
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3.5">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="用户名" required>
            <Input value={username} onChange={(event) => setUsername(event.target.value)} maxLength={32} />
          </Field>
          <Field label="显示名称">
            <Input value={displayName} onChange={(event) => setDisplayName(event.target.value)} maxLength={64} />
          </Field>
        </div>

        <Field label="邮箱" required>
          <Input type="email" value={email} onChange={(event) => setEmail(event.target.value)} />
        </Field>

        <Field label="初始密码" required hint="至少 8 位；请通过安全渠道告知用户并提醒尽快修改">
          <Input
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            autoComplete="new-password"
          />
        </Field>

        <Field label="角色">
          <Select value={role} onChange={(event) => setRole(event.target.value as 'admin' | 'user')}>
            <option value="user">普通用户</option>
            <option value="admin">管理员</option>
          </Select>
        </Field>

        {error ? <Alert tone="danger">{error}</Alert> : null}
      </div>
    </Modal>
  );
}

function EditUserDialog({
  user,
  onClose,
  onSaved,
}: {
  user: AdminUserSummary | null;
  onClose: () => void;
  onSaved: () => void;
}): ReactNode {
  const [email, setEmail] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [role, setRole] = useState<'admin' | 'user'>('user');
  const [status, setStatus] = useState<'active' | 'disabled'>('active');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // user 变化时用最新的服务端数据回填
  const [loadedFor, setLoadedFor] = useState<number | null>(null);
  if (user && loadedFor !== user.id) {
    setLoadedFor(user.id);
    setEmail(user.email);
    setDisplayName(user.displayName ?? '');
    setRole(user.role);
    setStatus(user.status);
    setError(null);
  }

  const handleSave = async (): Promise<void> => {
    if (!user) return;
    setSaving(true);
    setError(null);
    try {
      await api.patch(`/admin/users/${user.id}`, {
        email: email.trim(),
        displayName: displayName.trim(),
        role,
        status,
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
      open={user !== null}
      onClose={onClose}
      title={`编辑用户 · ${user?.username ?? ''}`}
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
        <Field label="邮箱" required>
          <Input type="email" value={email} onChange={(event) => setEmail(event.target.value)} />
        </Field>

        <Field label="显示名称">
          <Input value={displayName} onChange={(event) => setDisplayName(event.target.value)} maxLength={64} />
        </Field>

        <div className="grid grid-cols-2 gap-3">
          <Field label="角色">
            <Select value={role} onChange={(event) => setRole(event.target.value as 'admin' | 'user')}>
              <option value="user">普通用户</option>
              <option value="admin">管理员</option>
            </Select>
          </Field>
          <Field label="状态">
            <Select value={status} onChange={(event) => setStatus(event.target.value as 'active' | 'disabled')}>
              <option value="active">正常</option>
              <option value="disabled">停用</option>
            </Select>
          </Field>
        </div>

        <p className="font-sans text-xs text-muted">
          注册于 {formatDateTime(user?.createdAt)} · 最后登录 {formatRelative(user?.lastLoginAt)}
        </p>

        {error ? <Alert tone="danger">{error}</Alert> : null}
      </div>
    </Modal>
  );
}

function ResetPasswordDialog({
  user,
  onClose,
  onSaved,
}: {
  user: AdminUserSummary | null;
  onClose: () => void;
  onSaved: () => void;
}): ReactNode {
  const [newPassword, setNewPassword] = useState('');
  const [resetKosyncKey, setResetKosyncKey] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [loadedFor, setLoadedFor] = useState<number | null>(null);
  if (user && loadedFor !== user.id) {
    setLoadedFor(user.id);
    setNewPassword('');
    setResetKosyncKey(true);
    setError(null);
  }

  const handleReset = async (): Promise<void> => {
    if (!user) return;
    if (newPassword.length < 8) {
      setError('新密码至少 8 个字符');
      return;
    }

    setSaving(true);
    setError(null);
    try {
      const payload = await encryptPassword(newPassword);
      await api.post(`/admin/users/${user.id}/reset-password`, { newPassword: payload, resetKosyncKey });
      onSaved();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : '重置失败');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={user !== null}
      onClose={onClose}
      title={`重置密码 · ${user?.username ?? ''}`}
      description="重置后该用户的所有登录设备会被强制退出"
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={onClose}>
            取消
          </Button>
          <Button variant="danger" size="sm" loading={saving} onClick={() => void handleReset()}>
            重置密码
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3.5">
        <Field label="新密码" required hint="请通过安全渠道告知用户">
          <Input
            type="password"
            value={newPassword}
            onChange={(event) => setNewPassword(event.target.value)}
            autoComplete="new-password"
          />
        </Field>

        <label className="flex cursor-pointer items-start gap-2 font-sans text-xs text-ink-soft">
          <input
            type="checkbox"
            checked={resetKosyncKey}
            onChange={(event) => setResetKosyncKey(event.target.checked)}
            className="mt-0.5 size-4 cursor-pointer accent-accent"
          />
          <span>
            同时重置 KOSync 同步密钥
            <span className="mt-0.5 block text-muted">
              勾选后 KOReader 需要重新填写密码；不勾选则原有同步凭据继续有效。
            </span>
          </span>
        </label>

        {error ? <Alert tone="danger">{error}</Alert> : null}
      </div>
    </Modal>
  );
}
