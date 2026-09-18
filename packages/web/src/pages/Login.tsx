import { APP_NAME, APP_NAME_CN, VERSION } from '@readsync/shared';
import { BookOpen, Eye, EyeOff, KeyRound, LogIn, Mail, UserPlus } from 'lucide-react';
import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { Alert } from '../components/ui/Alert';
import { Button } from '../components/ui/Button';
import { Card, CardBody } from '../components/ui/Card';
import { Checkbox, Field, Input } from '../components/ui/Input';
import { Segmented } from '../components/ui/Segmented';
import { useAuth } from '../contexts/AuthContext';
import { ApiError } from '../lib/api';
import { isEncryptionAvailable } from '../lib/crypto';
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
  const { login, register, settings, user } = useAuth();

  const [mode, setMode] = useState<Mode>('login');
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [inviteCode, setInviteCode] = useState('');
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

    setSubmitting(true);
    try {
      await register({
        username,
        email,
        password,
        inviteCode: inviteCode.trim() || undefined,
        displayName: displayName.trim() || undefined,
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
                <Field label="用户名或邮箱" required>
                  <Input
                    value={username}
                    onChange={(event) => setUsername(event.target.value)}
                    autoComplete="username"
                    autoFocus
                    required
                  />
                </Field>

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
