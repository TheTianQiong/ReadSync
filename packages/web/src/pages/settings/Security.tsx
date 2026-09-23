import {
  AUTH_METHOD_LABELS,
  type PasskeySummary,
  type SyncPasswordResetResult,
  type SyncPasswordStatus,
  type TotpSetupResult,
} from '@readsync/shared';
import { Copy, Fingerprint, KeyRound, Plus, ShieldCheck, ShieldOff, Smartphone, Trash2 } from 'lucide-react';
import { useCallback, useState, type ReactNode } from 'react';
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
import { useAuth } from '../../contexts/AuthContext';
import { api } from '../../lib/api';
import { buildPasswordPayload } from '../../lib/crypto';
import { useAsync } from '../../lib/hooks';
import { copyText, formatRelative } from '../../lib/utils';
import { isPasskeySupported, registerPasskey } from '../../lib/webauthn';

/** 共享类型里没有登录设备 DTO（后端模块尚未定稿），这里按最可能的字段声明并做容错渲染 */
interface LoginSession {
  id: number;
  device?: string | null;
  deviceName?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  current?: boolean;
  createdAt?: string | null;
  lastUsedAt?: string | null;
  expiresAt?: string | null;
}

/**
 * 账号安全（README 要求 8：基础设置、2FA（验证器/通行密钥））。
 *
 * 四块：修改密码、验证器（TOTP）、通行密钥、登录设备。
 * 每一块独立成败，互不影响 —— 安全设置页面因某个接口未就绪而整页不可用是不可接受的。
 */
export function Security(): ReactNode {
  const { user, logoutAll, refreshUser } = useAuth();
  const toast = useToast();

  /* ------------------------------ 修改密码 ------------------------------ */
  const [oldPassword, setOldPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [changingPassword, setChangingPassword] = useState(false);
  const [passwordError, setPasswordError] = useState<string | null>(null);

  /* -------------------------------- 2FA -------------------------------- */
  const [setupResult, setSetupResult] = useState<TotpSetupResult | null>(null);
  const [totpSetupOpen, setTotpSetupOpen] = useState(false);
  const [totpCode, setTotpCode] = useState('');
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);
  const [totpBusy, setTotpBusy] = useState(false);
  const [totpError, setTotpError] = useState<string | null>(null);
  const [disableOpen, setDisableOpen] = useState(false);
  const [disableCode, setDisableCode] = useState('');
  const [disablePassword, setDisablePassword] = useState('');

  /* ------------------------------ 通行密钥 ------------------------------ */
  const passkeys = useAsync(() => api.get<PasskeySummary[]>('/auth/passkeys'), []);
  const [passkeyName, setPasskeyName] = useState('');
  const [passkeyBusy, setPasskeyBusy] = useState(false);
  const [passkeyError, setPasskeyError] = useState<string | null>(null);
  const [pendingPasskeyDelete, setPendingPasskeyDelete] = useState<PasskeySummary | null>(null);

  /* --------------------------- KOSync 同步密码 --------------------------- */
  const syncPassword = useAsync(() => api.get<SyncPasswordStatus>('/users/me/sync-password'), []);
  const [syncPasswordInput, setSyncPasswordInput] = useState('');
  const [syncPasswordBusy, setSyncPasswordBusy] = useState(false);
  const [syncPasswordError, setSyncPasswordError] = useState<string | null>(null);
  const [generatedSyncPassword, setGeneratedSyncPassword] = useState<string | null>(null);

  const handleSetSyncPassword = async (): Promise<void> => {
    setSyncPasswordError(null);
    setGeneratedSyncPassword(null);

    if (syncPasswordInput.length < 8) {
      setSyncPasswordError('同步密码至少 8 位');
      return;
    }

    setSyncPasswordBusy(true);
    try {
      const payload = await buildPasswordPayload(syncPasswordInput);
      await api.put('/users/me/sync-password', { password: payload });
      toast.success('同步密码已设置，请在 KOReader 中使用它');
      setSyncPasswordInput('');
      syncPassword.reload();
    } catch (err) {
      setSyncPasswordError(err instanceof Error ? err.message : '设置失败');
    } finally {
      setSyncPasswordBusy(false);
    }
  };

  const handleRegenerateSyncPassword = async (): Promise<void> => {
    setSyncPasswordError(null);
    setSyncPasswordBusy(true);
    try {
      const result = await api.post<SyncPasswordResetResult>('/users/me/sync-password/regenerate');
      // 服务端只存 md5，无法回显，因此这个明文只出现这一次
      setGeneratedSyncPassword(result.password);
      syncPassword.reload();
    } catch (err) {
      setSyncPasswordError(err instanceof Error ? err.message : '生成失败');
    } finally {
      setSyncPasswordBusy(false);
    }
  };

  /* ------------------------------ 登录设备 ------------------------------ */
  const sessions = useAsync(() => api.get<LoginSession[]>('/users/me/sessions'), []);
  const [pendingSessionRevoke, setPendingSessionRevoke] = useState<LoginSession | null>(null);
  const [sessionBusy, setSessionBusy] = useState(false);

  const totpEnabled = user?.totpEnabled ?? false;

  const handleChangePassword = async (): Promise<void> => {
    setPasswordError(null);

    if (!oldPassword) {
      setPasswordError('请输入当前密码');
      return;
    }
    if (newPassword !== confirmPassword) {
      setPasswordError('两次输入的新密码不一致');
      return;
    }
    if (newPassword.length < 8 || !/[A-Z]/.test(newPassword) || !/[a-z]/.test(newPassword) || !/[0-9]/.test(newPassword)) {
      setPasswordError('新密码至少 8 位，且需包含大小写字母与数字');
      return;
    }

    setChangingPassword(true);
    try {
      // 旧密码与新密码都以 RSA 密文提交
      const oldPayload = await buildPasswordPayload(oldPassword);
      const newPayload = await buildPasswordPayload(newPassword);
      await api.post('/auth/change-password', { oldPassword: oldPayload, newPassword: newPayload });
      toast.success('密码已修改，其它设备已退出登录');
      setOldPassword('');
      setNewPassword('');
      setConfirmPassword('');
    } catch (err) {
      setPasswordError(err instanceof Error ? err.message : '修改失败');
    } finally {
      setChangingPassword(false);
    }
  };

  const handleStartTotpSetup = useCallback(async (): Promise<void> => {
    setTotpError(null);
    setTotpBusy(true);
    try {
      const result = await api.post<TotpSetupResult>('/auth/2fa/setup');
      setSetupResult(result);
      setTotpCode('');
      setRecoveryCodes(null);
      setTotpSetupOpen(true);
    } catch (err) {
      setTotpError(err instanceof Error ? err.message : '无法生成密钥');
    } finally {
      setTotpBusy(false);
    }
  }, []);

  const handleEnableTotp = async (): Promise<void> => {
    if (!/^[0-9]{6}$/.test(totpCode)) {
      setTotpError('请输入 6 位验证码');
      return;
    }

    setTotpBusy(true);
    setTotpError(null);
    try {
      const result = await api.post<TotpSetupResult>('/auth/2fa/enable', { code: totpCode });
      // 恢复码只在开启成功时返回一次，务必让用户当场保存
      setRecoveryCodes(result?.recoveryCodes ?? null);
      toast.success('两步验证已开启');
      await refreshUser();
      if (!result?.recoveryCodes?.length) setTotpSetupOpen(false);
    } catch (err) {
      setTotpError(err instanceof Error ? err.message : '验证码不正确');
    } finally {
      setTotpBusy(false);
    }
  };

  const handleDisableTotp = async (): Promise<void> => {
    setTotpError(null);
    if (!/^[0-9]{6}$/.test(disableCode)) {
      setTotpError('请输入 6 位验证码');
      return;
    }

    setTotpBusy(true);
    try {
      const payload = await buildPasswordPayload(disablePassword);
      await api.post('/auth/2fa/disable', { code: disableCode, password: payload });
      toast.success('两步验证已关闭');
      setDisableOpen(false);
      setDisableCode('');
      setDisablePassword('');
      await refreshUser();
    } catch (err) {
      setTotpError(err instanceof Error ? err.message : '关闭失败');
    } finally {
      setTotpBusy(false);
    }
  };

  const handleAddPasskey = async (): Promise<void> => {
    setPasskeyError(null);
    setPasskeyBusy(true);
    try {
      await registerPasskey(passkeyName);
      toast.success('通行密钥已添加');
      setPasskeyName('');
      passkeys.reload();
      await refreshUser();
    } catch (err) {
      setPasskeyError(err instanceof Error ? err.message : '添加失败');
    } finally {
      setPasskeyBusy(false);
    }
  };

  const handleDeletePasskey = async (): Promise<void> => {
    if (!pendingPasskeyDelete) return;
    try {
      await api.del(`/auth/passkeys/${pendingPasskeyDelete.id}`);
      toast.success('通行密钥已删除');
      setPendingPasskeyDelete(null);
      passkeys.reload();
      await refreshUser();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '删除失败');
    }
  };

  const handleRevokeSession = async (): Promise<void> => {
    if (!pendingSessionRevoke) return;
    setSessionBusy(true);
    try {
      await api.del(`/users/me/sessions/${pendingSessionRevoke.id}`);
      toast.success('该设备已退出登录');
      setPendingSessionRevoke(null);
      sessions.reload();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '撤销失败');
    } finally {
      setSessionBusy(false);
    }
  };

  const handleCopy = async (text: string, label: string): Promise<void> => {
    const ok = await copyText(text);
    if (ok) toast.success(`${label}已复制`);
    else toast.error('复制失败，请手动选择文本');
  };

  return (
    <div className="flex flex-col gap-3">
      {/* 认证方式总览 */}
      <Card>
        <CardHeader title="认证方式" description="可组合使用，任意一种都能登录你的账号" />
        <CardBody>
          <ul className="flex flex-wrap gap-1.5">
            <li>
              <Badge tone="accent">{AUTH_METHOD_LABELS.password} · 已启用</Badge>
            </li>
            <li>
              <Badge tone={totpEnabled ? 'ochre' : 'outline'}>
                {AUTH_METHOD_LABELS.totp} · {totpEnabled ? '已启用' : '未启用'}
              </Badge>
            </li>
            <li>
              <Badge tone={(user?.passkeyCount ?? 0) > 0 ? 'ochre' : 'outline'}>
                {AUTH_METHOD_LABELS.passkey} · {user?.passkeyCount ?? 0} 个
              </Badge>
            </li>
          </ul>
        </CardBody>
      </Card>

      {/* 修改密码 */}
      <Card>
        <CardHeader title="修改密码" description="修改后其它设备会被强制退出，并发送邮件通知" />
        <CardBody className="flex flex-col gap-3.5">
          <Field label="当前密码" required>
            <Input
              type="password"
              value={oldPassword}
              onChange={(event) => setOldPassword(event.target.value)}
              autoComplete="current-password"
            />
          </Field>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="新密码" required>
              <Input
                type="password"
                value={newPassword}
                onChange={(event) => setNewPassword(event.target.value)}
                autoComplete="new-password"
              />
            </Field>
            <Field label="确认新密码" required>
              <Input
                type="password"
                value={confirmPassword}
                onChange={(event) => setConfirmPassword(event.target.value)}
                autoComplete="new-password"
              />
            </Field>
          </div>

          {passwordError ? <Alert tone="danger">{passwordError}</Alert> : null}
        </CardBody>
        <CardFooter>
          <Button
            variant="primary"
            size="sm"
            loading={changingPassword}
            icon={<KeyRound size={13} />}
            onClick={() => void handleChangePassword()}
          >
            修改密码
          </Button>
        </CardFooter>
      </Card>

      {/* 验证器 */}
      <Card>
        <CardHeader
          title="验证器（TOTP）"
          description="使用 Google Authenticator、1Password、Aegis 等应用生成动态验证码"
          actions={
            totpEnabled ? (
              <Button
                size="sm"
                variant="danger"
                icon={<ShieldOff size={13} />}
                onClick={() => {
                  setTotpError(null);
                  setDisableOpen(true);
                }}
              >
                关闭
              </Button>
            ) : (
              <Button
                size="sm"
                variant="secondary"
                loading={totpBusy}
                icon={<ShieldCheck size={13} />}
                onClick={() => void handleStartTotpSetup()}
              >
                开启
              </Button>
            )
          }
        />
        <CardBody>
          {totpEnabled ? (
            <p className="font-sans text-xs text-muted">
              两步验证已开启。登录时需要额外输入验证器中的 6 位动态码。
              {user?.passkeyCount ? '' : ' 建议同时添加一个通行密钥作为备份登录方式。'}
            </p>
          ) : (
            <p className="font-sans text-xs text-muted">
              开启后，登录除密码外还需输入动态验证码，可显著降低密码泄露的风险。
            </p>
          )}
          {totpError && !totpSetupOpen && !disableOpen ? (
            <Alert tone="danger" className="mt-2">
              {totpError}
            </Alert>
          ) : null}
        </CardBody>
      </Card>

      {/* 通行密钥 */}
      <Card>
        <CardHeader
          title="通行密钥"
          description="基于 WebAuthn，用指纹、面容或安全密钥直接登录，无需输入密码"
          actions={passkeys.error?.isMissing ? <span className="font-sans text-xs text-muted">接口未就绪</span> : null}
        />
        <CardBody className="flex flex-col gap-3">
          {!isPasskeySupported() ? (
            <Alert tone="warning">当前浏览器或访问方式（非 HTTPS）不支持通行密钥。</Alert>
          ) : null}

          <div className="flex flex-wrap items-end gap-2">
            <Field label="名称" className="min-w-40 flex-1" hint="便于在列表中区分，例如「iPhone 16」">
              <Input
                value={passkeyName}
                onChange={(event) => setPasskeyName(event.target.value)}
                maxLength={64}
                placeholder="我的设备"
              />
            </Field>
            <Button
              variant="secondary"
              size="sm"
              loading={passkeyBusy}
              disabled={!isPasskeySupported()}
              icon={<Fingerprint size={13} />}
              onClick={() => void handleAddPasskey()}
            >
              添加通行密钥
            </Button>
          </div>

          {passkeyError ? <Alert tone="danger">{passkeyError}</Alert> : null}

          {passkeys.loading ? (
            <PageSpinner label="载入通行密钥…" />
          ) : (passkeys.data?.length ?? 0) === 0 ? (
            <EmptyState title="还没有通行密钥" description="添加后可以用系统生物识别快速登录" />
          ) : (
            <Table>
              <THead>
                <TR>
                  <TH>名称</TH>
                  <TH>类型</TH>
                  <TH>已备份</TH>
                  <TH>最后使用</TH>
                  <TH>添加时间</TH>
                  <TH className="text-right">操作</TH>
                </TR>
              </THead>
              <TBody>
                {passkeys.data?.map((passkey) => (
                  <TR key={passkey.id}>
                    <TD>{passkey.name || '未命名'}</TD>
                    <TD className="whitespace-nowrap">{passkey.deviceType || '—'}</TD>
                    <TD>
                      {passkey.backedUp ? <Badge tone="ochre">已同步</Badge> : <Badge tone="outline">仅本机</Badge>}
                    </TD>
                    <TD className="whitespace-nowrap">{formatRelative(passkey.lastUsedAt)}</TD>
                    <TD className="whitespace-nowrap">{formatRelative(passkey.createdAt)}</TD>
                    <TD className="text-right">
                      <Button
                        size="sm"
                        variant="quiet"
                        className="hover:text-danger"
                        icon={<Trash2 size={13} />}
                        onClick={() => setPendingPasskeyDelete(passkey)}
                      />
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          )}
        </CardBody>
      </Card>

      {/* KOSync 同步密码 */}
      <Card>
        <CardHeader
          title="KOSync 同步密码"
          description="KOReader 等阅读器用它同步进度；留空则由主密码派生"
        />
        <CardBody className="flex flex-col gap-3">
          <Alert tone={syncPassword.data?.configured ? 'info' : 'warning'}>
            {syncPassword.data?.configured ? (
              <>
                已设置同步密码。若 KOReader 报「用户名或同步密码不正确」，说明你填入的密码与这里设置的不一致
                —— 直接在此重新设置一个你记得住的密码即可，不必改动主密码。
              </>
            ) : (
              <>
                尚未设置同步密码，此时 KOReader 使用<strong>主密码</strong>登录。
                若主密码较复杂或你希望两者分离，建议在此单独设置一个。
              </>
            )}
          </Alert>

          {generatedSyncPassword ? (
            <Alert tone="warning">
              新同步密码（<strong>只显示这一次</strong>，请立即记下并填入 KOReader）：
              <div className="mt-2 flex items-center gap-2">
                <code className="rounded-sm bg-paper-2 px-2 py-1 font-mono text-sm break-all">
                  {generatedSyncPassword}
                </code>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    void copyText(generatedSyncPassword);
                    toast.success('已复制');
                  }}
                >
                  复制
                </Button>
              </div>
            </Alert>
          ) : null}

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="设置新同步密码" hint="至少 8 位，需含大小写字母与数字">
              <Input
                type="password"
                value={syncPasswordInput}
                onChange={(e) => setSyncPasswordInput(e.target.value)}
                autoComplete="new-password"
              />
            </Field>
            <div className="flex items-end gap-2">
              <Button
                variant="secondary"
                loading={syncPasswordBusy}
                onClick={() => void handleSetSyncPassword()}
              >
                保存
              </Button>
              <Button
                variant="quiet"
                loading={syncPasswordBusy}
                onClick={() => void handleRegenerateSyncPassword()}
              >
                随机生成
              </Button>
            </div>
          </div>

          {syncPasswordError ? <Alert tone="danger">{syncPasswordError}</Alert> : null}

          <p className="font-sans text-xs text-muted">
            KOReader 里填写「工具 → 云存储 → 进度同步」时，用户名填本站账号，
            密码填这里设置的同步密码（未设置时即为主密码）。
          </p>
        </CardBody>
      </Card>

      {/* 登录设备 */}
      <Card>
        <CardHeader
          title="登录设备"
          description="发现不认识的设备时，请立即撤销并修改密码"
          actions={
            <Button
              size="sm"
              variant="danger"
              onClick={() => {
                void logoutAll();
              }}
            >
              退出所有设备
            </Button>
          }
        />
        <CardBody className="p-0">
          {sessions.loading ? (
            <PageSpinner label="载入设备列表…" />
          ) : sessions.error && !sessions.error.isMissing ? (
            <div className="p-4">
              <Alert tone="danger">{sessions.error.message}</Alert>
            </div>
          ) : (sessions.data?.length ?? 0) === 0 ? (
            <EmptyState title="暂无登录设备记录" className="border-0" />
          ) : (
            <Table>
              <THead>
                <TR>
                  <TH>设备</TH>
                  <TH>IP</TH>
                  <TH>最近活动</TH>
                  <TH className="text-right">操作</TH>
                </TR>
              </THead>
              <TBody>
                {sessions.data?.map((session) => (
                  <TR key={session.id}>
                    <TD className="max-w-52">
                      <span className="flex items-center gap-1.5">
                        <Smartphone size={12} className="shrink-0 text-muted" />
                        <span className="truncate">
                          {session.device ?? session.deviceName ?? session.userAgent ?? '未知设备'}
                        </span>
                        {session.current ? <Badge tone="accent">当前</Badge> : null}
                      </span>
                    </TD>
                    <TD className="font-mono text-xs">{session.ip ?? '—'}</TD>
                    <TD className="whitespace-nowrap">
                      {formatRelative(session.lastUsedAt ?? session.createdAt ?? null)}
                    </TD>
                    <TD className="text-right">
                      <Button
                        size="sm"
                        variant="quiet"
                        className="hover:text-danger"
                        disabled={session.current}
                        title={session.current ? '当前设备请使用「退出登录」' : '撤销该设备'}
                        onClick={() => setPendingSessionRevoke(session)}
                      >
                        撤销
                      </Button>
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          )}
        </CardBody>
      </Card>

      {/* 2FA 开启向导 */}
      <Modal
        open={totpSetupOpen}
        onClose={() => setTotpSetupOpen(false)}
        title={recoveryCodes ? '请保存恢复码' : '开启两步验证'}
        description={
          recoveryCodes
            ? '这些恢复码只显示这一次，每个只能使用一次'
            : '用验证器应用扫描或手动输入下面的密钥'
        }
        footer={
          recoveryCodes ? (
            <Button variant="primary" size="sm" onClick={() => setTotpSetupOpen(false)}>
              我已保存
            </Button>
          ) : (
            <>
              <Button variant="ghost" size="sm" onClick={() => setTotpSetupOpen(false)}>
                取消
              </Button>
              <Button variant="primary" size="sm" loading={totpBusy} onClick={() => void handleEnableTotp()}>
                验证并开启
              </Button>
            </>
          )
        }
      >
        {recoveryCodes ? (
          <div className="flex flex-col gap-3">
            <Alert tone="warning">
              恢复码是丢失验证器后的唯一登录方式，请立即抄写或存入密码管理器。
            </Alert>
            <div className="grid grid-cols-2 gap-1.5 rounded-sm border border-line bg-raised p-3">
              {recoveryCodes.map((code) => (
                <span key={code} className="font-mono text-xs text-ink">
                  {code}
                </span>
              ))}
            </div>
            <Button
              size="sm"
              variant="secondary"
              icon={<Copy size={12} />}
              onClick={() => void handleCopy(recoveryCodes.join('\n'), '恢复码')}
            >
              复制全部
            </Button>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            {/* 未引入二维码库，先提供密钥与 otpauth 链接，验证器均支持手动录入 */}
            <Field label="密钥" hint="在验证器应用中选择「手动输入密钥」">
              <div className="flex gap-2">
                <Input readOnly value={setupResult?.secret ?? ''} className="font-mono" />
                <Button
                  size="md"
                  variant="secondary"
                  icon={<Copy size={13} />}
                  onClick={() => void handleCopy(setupResult?.secret ?? '', '密钥')}
                />
              </div>
            </Field>

            <Field label="otpauth 链接" hint="部分验证器可直接打开该链接完成绑定">
              <div className="flex gap-2">
                <Input readOnly value={setupResult?.otpauthUrl ?? ''} className="font-mono text-xs" />
                <Button
                  size="md"
                  variant="secondary"
                  icon={<Copy size={13} />}
                  onClick={() => void handleCopy(setupResult?.otpauthUrl ?? '', '链接')}
                />
              </div>
            </Field>

            <Field label="验证码" required hint="输入验证器当前显示的 6 位数字">
              <Input
                value={totpCode}
                onChange={(event) => setTotpCode(event.target.value.replace(/\D/g, '').slice(0, 6))}
                inputMode="numeric"
                maxLength={6}
                placeholder="000000"
                className="font-mono tracking-[0.3em]"
              />
            </Field>

            {totpError ? <Alert tone="danger">{totpError}</Alert> : null}
          </div>
        )}
      </Modal>

      {/* 关闭 2FA */}
      <Modal
        open={disableOpen}
        onClose={() => setDisableOpen(false)}
        title="关闭两步验证"
        description="需要验证码与当前密码双重确认"
        footer={
          <>
            <Button variant="ghost" size="sm" onClick={() => setDisableOpen(false)}>
              取消
            </Button>
            <Button variant="danger" size="sm" loading={totpBusy} onClick={() => void handleDisableTotp()}>
              确认关闭
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3.5">
          <Field label="验证码" required>
            <Input
              value={disableCode}
              onChange={(event) => setDisableCode(event.target.value.replace(/\D/g, '').slice(0, 6))}
              inputMode="numeric"
              maxLength={6}
              placeholder="000000"
              className="font-mono tracking-[0.3em]"
            />
          </Field>
          <Field label="当前密码" required>
            <Input
              type="password"
              value={disablePassword}
              onChange={(event) => setDisablePassword(event.target.value)}
              autoComplete="current-password"
            />
          </Field>
          {totpError ? <Alert tone="danger">{totpError}</Alert> : null}
        </div>
      </Modal>

      <ConfirmDialog
        open={pendingPasskeyDelete !== null}
        onClose={() => setPendingPasskeyDelete(null)}
        onConfirm={() => void handleDeletePasskey()}
        title="删除通行密钥"
        confirmText="删除"
        message={`确定删除通行密钥「${pendingPasskeyDelete?.name || '未命名'}」吗？删除后将无法再用它登录。`}
      />

      <ConfirmDialog
        open={pendingSessionRevoke !== null}
        onClose={() => setPendingSessionRevoke(null)}
        onConfirm={() => void handleRevokeSession()}
        loading={sessionBusy}
        title="撤销设备"
        confirmText="撤销"
        message="确定让该设备退出登录吗？该设备需要重新输入密码。"
      />
    </div>
  );
}
