import { AUDIT_ACTIONS, type AuditLogEntry, type Paginated } from '@readsync/shared';
import { RefreshCw, Search } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Alert } from '../../components/ui/Alert';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Card, CardBody, CardHeader } from '../../components/ui/Card';
import { EmptyState } from '../../components/ui/EmptyState';
import { Input, Select } from '../../components/ui/Input';
import { Modal } from '../../components/ui/Modal';
import { Pagination } from '../../components/ui/Pagination';
import { PageSpinner } from '../../components/ui/Spinner';
import { Table, TBody, TD, TH, THead, TR } from '../../components/ui/Table';
import { api } from '../../lib/api';
import { useAsync, useDebounced } from '../../lib/hooks';
import { formatDateTime } from '../../lib/utils';

const PAGE_SIZE = 30;

/** 审计动作的中文说明；未收录的自定义动作直接显示原始 key */
const ACTION_LABELS: Record<string, string> = {
  'user.register': '用户注册',
  'user.login': '登录',
  'user.login_failed': '登录失败',
  'user.logout': '退出登录',
  'user.password_change': '修改密码',
  'user.password_reset': '重置密码',
  'user.update': '更新资料',
  'user.disable': '停用账号',
  'user.enable': '启用账号',
  'user.delete': '删除用户',
  'user.role_change': '变更角色',
  'auth.2fa_enable': '开启两步验证',
  'auth.2fa_disable': '关闭两步验证',
  'auth.passkey_add': '添加通行密钥',
  'auth.passkey_remove': '删除通行密钥',
  'storage.create': '新增存储',
  'storage.update': '更新存储',
  'storage.delete': '删除存储',
  'book.upload': '上传书籍',
  'book.download': '下载书籍',
  'book.delete': '删除书籍',
  'sync.push': '推送进度',
  'sync.pull': '拉取进度',
  'admin.settings_update': '更新站点设置',
  'admin.invite_create': '创建邀请码',
  'admin.invite_revoke': '吊销邀请码',
  'plugin.install': '安装插件',
  'plugin.enable': '启用插件',
  'plugin.disable': '停用插件',
  'plugin.uninstall': '卸载插件',
};

/**
 * 审计日志（README 要求 9「其他未说明的内容，请自行添加」）。
 *
 * 所有敏感操作都会落库，这里提供按动作/用户/时间范围的检索，
 * 排查「谁在什么时候改了站点设置」这类问题时是唯一的依据。
 */
export function Audit(): ReactNode {
  const [action, setAction] = useState('');
  const [userId, setUserId] = useState('');
  const debouncedUserId = useDebounced(userId, 400);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [page, setPage] = useState(1);
  const [detail, setDetail] = useState<AuditLogEntry | null>(null);

  const { data, loading, error, reload } = useAsync(
    () =>
      api.get<Paginated<AuditLogEntry>>('/admin/audit', {
        page,
        pageSize: PAGE_SIZE,
        action: action || undefined,
        userId: debouncedUserId || undefined,
        from: from || undefined,
        to: to || undefined,
      }),
    [page, action, debouncedUserId, from, to],
  );

  const entries = data?.items ?? [];

  const resetPage = (): void => setPage(1);

  return (
    <div className="flex flex-col gap-3">
      <Card>
        <CardHeader
          title="审计日志"
          description={`共 ${data?.total ?? 0} 条记录`}
          actions={
            <Button size="sm" variant="ghost" icon={<RefreshCw size={13} />} onClick={reload}>
              刷新
            </Button>
          }
        />
        <CardBody className="flex flex-wrap items-center gap-2">
          <Select
            value={action}
            onChange={(event) => {
              setAction(event.target.value);
              resetPage();
            }}
            className="w-44"
          >
            <option value="">全部动作</option>
            {AUDIT_ACTIONS.map((item) => (
              <option key={item} value={item}>
                {ACTION_LABELS[item] ?? item}
              </option>
            ))}
          </Select>

          <div className="relative w-40">
            <Search size={13} className="absolute top-1/2 left-2.5 -translate-y-1/2 text-faint" />
            <Input
              value={userId}
              onChange={(event) => {
                setUserId(event.target.value.replace(/\D/g, ''));
                resetPage();
              }}
              placeholder="用户 ID"
              className="pl-7"
            />
          </div>

          <Input
            type="date"
            value={from}
            onChange={(event) => {
              setFrom(event.target.value);
              resetPage();
            }}
            className="w-40"
          />
          <span className="font-sans text-xs text-muted">至</span>
          <Input
            type="date"
            value={to}
            onChange={(event) => {
              setTo(event.target.value);
              resetPage();
            }}
            className="w-40"
          />

          {action || userId || from || to ? (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setAction('');
                setUserId('');
                setFrom('');
                setTo('');
                resetPage();
              }}
            >
              清空筛选
            </Button>
          ) : null}
        </CardBody>
      </Card>

      {loading ? (
        <PageSpinner label="正在读取审计日志…" />
      ) : error && !error.isMissing ? (
        <Alert tone="danger">{error.message}</Alert>
      ) : entries.length === 0 ? (
        <EmptyState title="没有匹配的审计记录" description="调整筛选条件或时间范围再试试" />
      ) : (
        <Card>
          <Table>
            <THead>
              <TR>
                <TH>时间</TH>
                <TH>用户</TH>
                <TH>动作</TH>
                <TH>对象</TH>
                <TH>IP</TH>
                <TH>结果</TH>
                <TH className="text-right">详情</TH>
              </TR>
            </THead>
            <TBody>
              {entries.map((entry) => (
                <TR key={entry.id}>
                  <TD className="whitespace-nowrap">{formatDateTime(entry.createdAt)}</TD>
                  <TD className="whitespace-nowrap">
                    {entry.username ?? (entry.userId !== null ? `#${entry.userId}` : '系统')}
                  </TD>
                  <TD className="whitespace-nowrap">
                    <span className="flex items-center gap-1.5">
                      {ACTION_LABELS[entry.action] ?? entry.action}
                      <span className="font-mono text-[10px] text-faint">{entry.action}</span>
                    </span>
                  </TD>
                  <TD className="max-w-48 truncate">{entry.target || '—'}</TD>
                  <TD className="font-mono text-xs">{entry.ip || '—'}</TD>
                  <TD>
                    {entry.success ? <Badge tone="ochre">成功</Badge> : <Badge tone="danger">失败</Badge>}
                  </TD>
                  <TD className="text-right">
                    <Button
                      size="sm"
                      variant="quiet"
                      disabled={!entry.meta && !entry.userAgent}
                      onClick={() => setDetail(entry)}
                    >
                      查看
                    </Button>
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

      <Modal
        open={detail !== null}
        onClose={() => setDetail(null)}
        title="审计详情"
        description={detail ? `${ACTION_LABELS[detail.action] ?? detail.action} · ${formatDateTime(detail.createdAt)}` : ''}
        size="lg"
      >
        <div className="flex flex-col gap-3">
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 font-sans text-xs">
            <dt className="text-muted">用户</dt>
            <dd className="text-ink-soft">
              {detail?.username ?? '—'}
              {detail?.userId !== null && detail?.userId !== undefined ? ` (#${detail.userId})` : ''}
            </dd>
            <dt className="text-muted">对象</dt>
            <dd className="text-ink-soft">{detail?.target || '—'}</dd>
            <dt className="text-muted">IP</dt>
            <dd className="font-mono text-ink-soft">{detail?.ip || '—'}</dd>
            <dt className="text-muted">结果</dt>
            <dd className="text-ink-soft">{detail?.success ? '成功' : '失败'}</dd>
            <dt className="text-muted">User-Agent</dt>
            <dd className="break-all text-ink-soft">{detail?.userAgent || '—'}</dd>
          </dl>

          {detail?.meta ? (
            <div>
              <p className="mb-1 font-sans text-xs text-muted">附加信息</p>
              <pre className="overflow-x-auto rounded-sm border border-line bg-raised p-3 font-mono text-[11px] leading-relaxed text-ink-soft">
                {JSON.stringify(detail.meta, null, 2)}
              </pre>
            </div>
          ) : null}
        </div>
      </Modal>
    </div>
  );
}
