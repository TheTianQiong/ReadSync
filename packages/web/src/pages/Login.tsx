import { APP_NAME, APP_NAME_CN, VERSION, type SessionUser } from '@readsync/shared';
import { BookOpen, Eye, EyeOff, Fingerprint, KeyRound, LogIn, Mail, UserPlus } from 'lucide-react';
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { Alert } from '../components/ui/Alert';
import { Button } from '../components/ui/Button';
import { Card, CardBody } from '../components/ui/Card';
import { Checkbox, Field, Input } from '../components/ui/Input';
import { Segmented } from '../components/ui/Segmented';
import { useAuth } from '../contexts/AuthContext';
import { ApiError, api } from '../lib/api';
import { isEncryptionAvailable } from '../lib/crypto';
import {
  isConditionalUiSupported,
  isPasskeySupported,
  maskAccount,
  readLastAccount,
  rememberLastAccount,
  type LastAccount,
} from '../lib/webauthn';
import {
  checkPasswordStrength,
  emailField,
  loginIdentifierField,
  passwordSchema,
  usernameField,
  validateAll,
} from '../lib/validation';

type Mode = 'login' | 'register';

/**
 * 登录 / 注册页（README 要求 2、4）。
 *
 * 未登录时 App 会把所有受保护路由重定向到这里；登录成功后回到用户原本想去的路径
 * （存在 location.state.from）。
 *
 * 「忘记密码」入口只有在站点开启了邮件重置时才展示 —— 没配邮件服务时点了也收不到信，
 * 那不是帮助而是误导。
 */
export function Login(): ReactNode {
  const navigate = useNavigate();
  const location = useLocation();
  const { login, loginWithPasskey, register, settings, user } = useAuth();

  const [mode, setMode] = useState<Mode>('login');
  /** 本机上次登录过的账号（不含任何凭据）。有它就把账号字段收起来，只让填密码 */
  const [lastAccount, setLastAccount] = useState<LastAccount | null>(() => readLastAccount());
  const [useOtherAccount, setUseOtherAccount] = useState(false);
  const [passkeySupported, setPasskeySupported] = useState(false);
  const [conditionalReady, setConditionalReady] = useState(false);
  const [passkeyBusy, setPasskeyBusy] = useState(false);
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [inviteCode, setInviteCode] = useState('');
  const [emailCode, setEmailCode] = useState('');
  const [sendingCode, setSendingCode] = useState(false);
  const [codeNotice, setCodeNotice] = useState<string | null>(null);
  const [totpCode, setTotpCode] = useState('');
  const [remember, setRemember] = useState(true);
  const [showPassword, setShowPassword] = useState(false);

  const [needsTotp, setNeedsTotp] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(
    (location.state as { notice?: string } | null)?.notice ?? null,
  );

  const redirectTo = (location.state as { from?: string } | null)?.from ?? '/';
  const registrationEnabled = settings?.registrationEnabled ?? true;
  const inviteRequired = settings?.inviteRequired ?? false;
  // 站点开启邮箱验证时，注册必须先收验证码才能建号
  const emailCodeRequired = (settings?.emailVerification ?? 'off') !== 'off';
  const passwordResetEnabled = settings?.passwordResetEnabled ?? true;
  const encryptionReady = isEncryptionAvailable();

  // 已登录（例如直接敲 /login）就别停在这个页面
  useEffect(() => {
    if (user) navigate('/', { replace: true });
  }, [user, navigate]);

  // 站点关闭注册时强制回到登录态，避免停在一个不可用的表单上
  useEffect(() => {
    if (!registrationEnabled && mode === 'register') setMode('login');
  }, [registrationEnabled, mode]);

  /* ------------------------------ 通行密钥 ------------------------------ */

  useEffect(() => {
    setPasskeySupported(isPasskeySupported());
    let cancelled = false;
    void isConditionalUiSupported().then((ok) => {
      if (!cancelled) setConditionalReady(ok);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  /** 登录成功后记住这台设备用的是哪个账号（不存凭据），下次只让填密码 */
  const rememberAccount = (account: SessionUser | null | undefined): void => {
    if (!account) return;
    rememberLastAccount({
      username: account.username,
      displayName: account.displayName ?? null,
      avatarUrl: account.avatarUrl ?? null,
      hasPasskey: (account.passkeyCount ?? 0) > 0,
    });
  };

  /**
   * 条件式 UI：让浏览器把这台设备上的通行密钥填进「用户名」输入框。
   *
   * 必须在页面加载时就发起，并把 `mediation: 'conditional'` 交给浏览器 ——
   * 此时**不会弹系统框**，凭据出现在自动填充里，用户点一下才算数。
   * 用户完全可能改用密码登录，那个 Promise 就永远挂着，所以用 AbortController
   * 在离开页面（或已登录）时中止它。
   *
   * 只在输入框可见时启用：账号字段被收起来（本机已记住）时没有可填充的输入框，
   * 条件式 UI 无从触发。
   */
  const conditionalDoneRef = useRef(false);
  useEffect(() => {
    if (!conditionalReady || mode !== 'login' || user || conditionalDoneRef.current) return;
    if (lastAccount && !useOtherAccount) return;

    const controller = new AbortController();
    void loginWithPasskey({ conditional: true, signal: controller.signal })
      .then((result) => {
        if (!result?.accessToken) return;
        conditionalDoneRef.current = true;
        rememberAccount(result.user);
        navigate(redirectTo, { replace: true });
      })
      .catch((err: unknown) => {
        // 自动填充阶段出错不该打断用户（他可能压根没打算用通行密钥）
        console.warn('条件式通行密钥登录未完成', err);
      });

    return () => controller.abort();
  }, [conditionalReady, mode, user, lastAccount, useOtherAccount, loginWithPasskey, navigate, redirectTo]);

  /** 点按钮唤起通行密钥登录（本机账号有凭据就用它，否则走免账号的可发现凭据） */
  const handlePasskeyLogin = async (): Promise<void> => {
    setError(null);
    setPasskeyBusy(true);
    try {
      const scoped = lastAccount && !useOtherAccount ? { username: lastAccount.username } : {};
      const result = await loginWithPasskey(scoped);

      // null = 用户取消或系统里没有可用凭据；不是错误，别吓他
      if (!result) {
        setError('没有可用的通行密钥，或已取消。可以改用密码登录。');
        return;
      }
      if (!result.accessToken) {
        setError('通行密钥登录未完成，请重试或改用密码登录');
        return;
      }

      rememberAccount(result.user);
      navigate(redirectTo, { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : '通行密钥登录失败');
    } finally {
      setPasskeyBusy(false);
    }
  };

  /** 「使用其他账号」：把账号字段放回来，并忘掉本机记住的那个 */
  const switchAccount = (): void => {
    setUseOtherAccount(true);
    setUsername('');
    setPassword('');
    setError(null);
    setNeedsTotp(false);
  };

  const switchMode = (next: Mode): void => {
    setMode(next);
    setError(null);
    setNotice(null);
    setNeedsTotp(false);
  };

  /** 服务端要求二次验证时会返回「验证码」相关文案的 401，据此把验证码输入框显出来 */
  const is2faRequired = (err: unknown): boolean =>
    err instanceof ApiError &&
    err.code === 'UNAUTHORIZED' &&
    /2fa|totp|验证码|动态口令|两步/i.test(err.message);

  const handleLogin = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    setError(null);

    const invalid = validateAll([[loginIdentifierField, username]]);
    if (invalid) {
      setError(invalid);
      return;
    }
    if (!password) {
      setError('请输入密码');
      return;
    }
    if (needsTotp && !/^[0-9]{6}$/.test(totpCode)) {
      setError('请输入 6 位动态验证码');
      return;
    }

    setSubmitting(true);
    try {
      const result = await login({ username, password, totpCode: totpCode || undefined, remember });

      // 账号开启了 2FA 但本次未带验证码：服务端会返回 requires2fa 且不下发令牌
      if (result.requires2fa && !result.accessToken) {
        setNeedsTotp(true);
        setError('该账号已开启两步验证，请输入验证器中的 6 位验证码');
        return;
      }

      navigate(redirectTo, { replace: true });
    } catch (err) {
      if (is2faRequired(err)) {
        setNeedsTotp(true);
        setError('该账号已开启两步验证，请输入验证器中的 6 位验证码');
        return;
      }
      setError(err instanceof ApiError ? err.message : '登录失败，请稍后重试');
    } finally {
      setSubmitting(false);
    }
  };

  /** 注册前请求邮箱验证码 */
  const handleSendCode = async (): Promise<void> => {
    if (!email.trim()) {
      setError('请先填写邮箱');
      return;
    }
    setSendingCode(true);
    setError(null);
    setCodeNotice(null);
    try {
      const result = await api.post<{ message: string }>(
        '/auth/register/code',
        { email: email.trim(), purpose: 'register' },
        { auth: false, skipAuthRedirect: true },
      );
      setCodeNotice(result.message ?? '验证码已发送，请查收邮件');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '验证码发送失败，请稍后重试');
    } finally {
      setSendingCode(false);
    }
  };

  const handleRegister = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    setError(null);

    if (password !== confirm) {
      setError('两次输入的密码不一致');
      return;
    }

    const invalid = validateAll([
      [usernameField, username],
      [emailField, email],
      [passwordSchema, password],
    ]);
    if (invalid) {
      setError(invalid);
      return;
    }
    if (inviteRequired && !inviteCode.trim()) {
      setError('本站开启了邀请码注册，请填写邀请码');
      return;
    }
    if (emailCodeRequired && !/^[0-9]{6}$/.test(emailCode.trim())) {
      setError('请填写邮箱收到的 6 位验证码（点「发送验证码」获取）');
      return;
    }

    setSubmitting(true);
    try {
      await register({
        username,
        email,
        password,
        inviteCode: inviteCode.trim() || undefined,
        displayName: displayName.trim() || undefined,
        emailCode: emailCode.trim() || undefined,
      });
      navigate('/', { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '注册失败，请稍后重试');
    } finally {
      setSubmitting(false);
    }
  };

  const strength = checkPasswordStrength(password);

  return (
    <div className="flex min-h-screen items-center justify-center bg-paper px-4 py-10">
      <div className="w-full max-w-md">
        <div className="mb-6 flex flex-col items-center gap-2 text-center">
          <BookOpen size={26} className="text-ink" />
          <h1 className="font-serif text-xl text-ink">{settings?.siteName ?? APP_NAME_CN}</h1>
          <p className="font-sans text-xs text-muted">
            {mode === 'login' ? '登录以同步你的阅读进度' : '创建一个新账号'}
          </p>
        </div>

        <Card>
          <CardBody className="flex flex-col gap-4 py-5">
            {registrationEnabled ? (
              <Segmented
                className="self-center"
                value={mode}
                onChange={switchMode}
                options={[
                  { value: 'login', label: '登录' },
                  { value: 'register', label: '注册' },
                ]}
              />
            ) : null}

            {!encryptionReady ? (
              <Alert tone="warning">
                当前页面不是安全上下文（HTTPS 或 localhost），浏览器不提供 WebCrypto，
                无法加密密码，提交将会失败。请改用 HTTPS 或 localhost 访问本站。
              </Alert>
            ) : null}

            {notice ? <Alert tone="success">{notice}</Alert> : null}

            {mode === 'login' ? (
              <form className="flex flex-col gap-3.5" onSubmit={(event) => void handleLogin(event)}>
                {/*
                  本机登录过的账号：把账号字段收起来，只让填密码。
                  账号是打码显示的（`ti***ng`）—— 屏幕上可能还有别人看着，
                  但要打码到「自己一眼能认出来」为止，否则这个快捷路径就没意义。
                */}
                {lastAccount && !useOtherAccount ? (
                  <div className="flex items-center gap-2.5 rounded-sm border border-line bg-raised px-3 py-2">
                    {lastAccount.avatarUrl ? (
                      <img
                        src={lastAccount.avatarUrl}
                        alt=""
                        className="size-8 shrink-0 rounded-full border border-line object-cover"
                      />
                    ) : (
                      <span className="flex size-8 shrink-0 items-center justify-center rounded-full border border-line bg-surface text-muted">
                        <BookOpen size={14} />
                      </span>
                    )}

                    <div className="min-w-0 flex-1">
                      <div className="truncate font-sans text-sm text-ink">
                        {lastAccount.displayName || maskAccount(lastAccount.username)}
                      </div>
                      <div className="truncate font-mono text-[11px] text-muted">
                        {maskAccount(lastAccount.username)}
                      </div>
                    </div>

                    <button
                      type="button"
                      onClick={switchAccount}
                      className="shrink-0 cursor-pointer font-sans text-xs text-accent underline-offset-2 hover:underline"
                    >
                      使用其他账号
                    </button>
                  </div>
                ) : (
                  <Field
                    label="用户名或邮箱"
                    required
                    hint={
                      conditionalReady
                        ? '本机若存有通行密钥，点一下这个输入框就会出现在自动填充里'
                        : undefined
                    }
                  >
                    <Input
                      value={username}
                      onChange={(event) => setUsername(event.target.value)}
                      // `webauthn` 这个 token 是条件式 UI 的开关：没有它浏览器不会填充通行密钥
                      autoComplete={conditionalReady ? 'username webauthn' : 'username'}
                      autoFocus
                      required
                    />
                  </Field>
                )}

                <Field label="密码" required>
                  <div className="relative">
                    <Input
                      type={showPassword ? 'text' : 'password'}
                      value={password}
                      onChange={(event) => setPassword(event.target.value)}
                      autoComplete="current-password"
                      className="pr-9"
                      required
                    />
                    <button
                      type="button"
                      onClick={() => setShowPassword((value) => !value)}
                      aria-label={showPassword ? '隐藏密码' : '显示密码'}
                      className="absolute top-1/2 right-2 -translate-y-1/2 cursor-pointer p-1 text-muted transition-colors hover:text-ink"
                    >
                      {showPassword ? <EyeOff size={14} /> : <Eye size={14} />}
                    </button>
                  </div>
                </Field>

                {needsTotp ? (
                  <Field label="两步验证码" required hint="打开验证器应用，输入当前 6 位数字">
                    <Input
                      value={totpCode}
                      onChange={(event) => setTotpCode(event.target.value.replace(/\D/g, '').slice(0, 6))}
                      inputMode="numeric"
                      autoComplete="one-time-code"
                      placeholder="000000"
                      className="font-mono tracking-[0.3em]"
                      autoFocus
                      required
                    />
                  </Field>
                ) : null}

                <div className="flex items-center justify-between gap-3">
                  <label className="flex cursor-pointer items-center gap-1.5 font-sans text-xs text-ink-soft">
                    <Checkbox
                      checked={remember}
                      onChange={(event) => setRemember(event.target.checked)}
                    />
                    记住我
                  </label>

                  {passwordResetEnabled ? (
                    <Link
                      to="/forgot-password"
                      className="font-sans text-xs text-accent underline-offset-2 hover:underline"
                    >
                      忘记密码？
                    </Link>
                  ) : null}
                </div>

                {error ? <Alert tone="danger">{error}</Alert> : null}

                <Button
                  type="submit"
                  variant="primary"
                  size="lg"
                  loading={submitting}
                  icon={<LogIn size={15} />}
                  className="mt-1 w-full"
                >
                  登录
                </Button>

                {/*
                  通行密钥入口。三种情形都给得到：
                   - 本机记住了账号且它有通行密钥：按钮显眼一些（多数人点这个就走完了）；
                   - 本机记住了账号但它没有通行密钥（没开过、或已经删掉）：仍然给按钮，
                     「再次唤起」不该因为一次取消就消失；
                   - 新设备（没有记住的账号）：按钮就是唯一入口，走免账号的可发现凭据。
                */}
                {passkeySupported ? (
                  <div className="flex flex-col gap-2">
                    <div className="flex items-center gap-2">
                      <span className="h-px flex-1 bg-line" />
                      <span className="font-sans text-[11px] text-faint">或</span>
                      <span className="h-px flex-1 bg-line" />
                    </div>

                    <Button
                      type="button"
                      variant={lastAccount?.hasPasskey && !useOtherAccount ? 'secondary' : 'ghost'}
                      size="lg"
                      loading={passkeyBusy}
                      icon={<Fingerprint size={15} />}
                      className="w-full"
                      onClick={() => void handlePasskeyLogin()}
                    >
                      {lastAccount && !useOtherAccount
                        ? '用通行密钥登录'
                        : '用通行密钥登录（免账号）'}
                    </Button>

                    <p className="text-center font-sans text-[11px] leading-relaxed text-faint">
                      {lastAccount && !useOtherAccount
                        ? '用指纹 / 面容 / 设备 PIN 验证，不必输密码'
                        : '在这台设备上用指纹 / 面容 / 设备 PIN 直接登录，不必先输账号'}
                    </p>
                  </div>
                ) : null}
              </form>
            ) : (
              <form className="flex flex-col gap-3.5" onSubmit={(event) => void handleRegister(event)}>
                <Field label="用户名" required hint="以字母开头，3–32 位，可含数字、下划线和连字符">
                  <Input
                    value={username}
                    onChange={(event) => setUsername(event.target.value)}
                    autoComplete="username"
                    autoFocus
                    required
                  />
                </Field>

                <Field label="邮箱" required>
                  <Input
                    type="email"
                    value={email}
                    onChange={(event) => setEmail(event.target.value)}
                    autoComplete="email"
                    required
                  />
                </Field>

                {/*
                  邮箱验证码只属于**注册**：站点开了邮箱验证时，建号前要证明邮箱是你的。
                  登录不在这里 —— 登录该用账号自己的验证方式（开了两步验证就填 TOTP）。
                  这段曾经被摆在登录表单里，于是「注册+改密码」这一档会让**每次登录**
                  都弹出一个必填的验证码框（而登录接口根本不读它），白等一封邮件。
                */}
                {emailCodeRequired ? (
                  <Field label="邮箱验证码" required hint="本站要求先验证邮箱，验证码有效 10 分钟">
                    <div className="flex items-center gap-2">
                      <Input
                        value={emailCode}
                        onChange={(event) => setEmailCode(event.target.value.replace(/\D/g, ''))}
                        inputMode="numeric"
                        placeholder="6 位数字"
                        maxLength={6}
                        className="font-mono"
                        required
                      />
                      <Button
                        type="button"
                        variant="secondary"
                        size="md"
                        loading={sendingCode}
                        onClick={() => void handleSendCode()}
                        className="shrink-0 whitespace-nowrap"
                      >
                        发送验证码
                      </Button>
                    </div>
                  </Field>
                ) : null}

                {codeNotice ? <Alert tone="info">{codeNotice}</Alert> : null}

                <Field label="显示名称" hint="可选，展示在导航栏">
                  <Input
                    value={displayName}
                    onChange={(event) => setDisplayName(event.target.value)}
                    maxLength={64}
                  />
                </Field>

                <Field
                  label="密码"
                  required
                  hint={
                    password
                      ? `强度：${strength.label}（已满足 ${strength.met}/${strength.total} 项要求）`
                      : '至少 8 位，需含大小写字母与数字'
                  }
                >
                  <Input
                    type={showPassword ? 'text' : 'password'}
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    autoComplete="new-password"
                    required
                  />
                </Field>

                <Field label="确认密码" required>
                  <Input
                    type={showPassword ? 'text' : 'password'}
                    value={confirm}
                    onChange={(event) => setConfirm(event.target.value)}
                    autoComplete="new-password"
                    required
                  />
                </Field>

                {inviteRequired ? (
                  <Field label="邀请码" required hint="本站开启了邀请码注册">
                    <Input
                      value={inviteCode}
                      onChange={(event) => setInviteCode(event.target.value)}
                      maxLength={64}
                      required
                    />
                  </Field>
                ) : null}

                {error ? <Alert tone="danger">{error}</Alert> : null}

                <Button
                  type="submit"
                  variant="primary"
                  size="lg"
                  loading={submitting}
                  icon={<UserPlus size={15} />}
                  className="mt-1 w-full"
                >
                  注册并登录
                </Button>
              </form>
            )}

            {/* 站点关闭注册时给出明确说明，而不是让用户找不到入口 */}
            {mode === 'login' && !registrationEnabled ? (
              <p className="text-center font-sans text-xs text-muted">
                本站已关闭自助注册，请联系管理员创建账号
              </p>
            ) : null}
          </CardBody>
        </Card>

        <div className="mt-4 flex flex-col items-center gap-1.5">
          {passwordResetEnabled && mode === 'register' ? (
            <Link
              to="/forgot-password"
              className="flex items-center gap-1 font-sans text-xs text-muted underline-offset-2 hover:text-ink hover:underline"
            >
              <KeyRound size={12} />
              已有账号但忘记密码？
            </Link>
          ) : null}
          <p className="flex items-center gap-1 font-sans text-[11px] text-faint">
            <Mail size={11} />
            密码经 RSA-OAEP 加密传输，服务端以 Argon2id 单向哈希存储
          </p>
          {/* README 要求「版本号显示在前端网页底部」，未登录页面同样遵守 */}
          <p className="font-mono text-[11px] text-faint">
            {APP_NAME} v{settings?.version ?? VERSION}
          </p>
        </div>
      </div>
    </div>
  );
}
