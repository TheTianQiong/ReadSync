import { APP_NAME, APP_NAME_CN, VERSION } from '@readsync/shared';
import { ArrowLeft, KeyRound, MailCheck } from 'lucide-react';
import { useState, type FormEvent, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Alert } from '../components/ui/Alert';
import { Button } from '../components/ui/Button';
import { Card, CardBody } from '../components/ui/Card';
import { Field, Input } from '../components/ui/Input';
import { useAuth } from '../contexts/AuthContext';
import { ApiError, api } from '../lib/api';
import { emailField, passwordSchema, resetCodeField, validateAll } from '../lib/validation';

/**
 * 忘记密码（README 要求 4）。
 *
 * 两步：先发验证码，再用「邮箱 + 验证码 + 新密码」重置。
 * 与后端契约一致 —— forgot-password 无论邮箱是否存在都返回相同文案（防用户枚举），
 * 因此这里不做「邮箱不存在」这类提示。
 *
 * 注意：按 shared 的 resetPasswordSchema，newPassword 是明文字符串字段，
 * 该端点的密码不走 RSA 加密载荷（与登录/注册不同）。
 */
export function ForgotPassword(): ReactNode {
  const navigate = useNavigate();
  const { settings } = useAuth();

  const [step, setStep] = useState<'request' | 'reset'>('request');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const handleRequest = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    setError(null);

    const invalid = validateAll([[emailField, email]]);
    if (invalid) {
      setError(invalid);
      return;
    }

    setSubmitting(true);
    try {
      await api.post('/auth/forgot-password', { email }, { auth: false, skipAuthRedirect: true });
      setStep('reset');
      setNotice('若该邮箱已注册，验证码已发送，请查收（含垃圾邮件箱）。验证码 10 分钟内有效。');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '发送失败，请稍后重试');
    } finally {
      setSubmitting(false);
    }
  };

  const handleReset = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    setError(null);

    if (newPassword !== confirm) {
      setError('两次输入的新密码不一致');
      return;
    }

    const invalid = validateAll([
      [emailField, email],
      [resetCodeField, code],
      [passwordSchema, newPassword],
    ]);
    if (invalid) {
      setError(invalid);
      return;
    }

    setSubmitting(true);
    try {
      await api.post(
        '/auth/reset-password',
        { email, code, newPassword },
        { auth: false, skipAuthRedirect: true },
      );
      navigate('/login', { replace: true, state: { notice: '密码已重置，请用新密码登录' } });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '重置失败，请稍后重试');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-paper px-4 py-10">
      <div className="w-full max-w-md">
        <div className="mb-6 flex flex-col items-center gap-2 text-center">
          <KeyRound size={24} className="text-ink" />
          <h1 className="font-serif text-xl text-ink">找回密码</h1>
          <p className="font-sans text-xs text-muted">
            {settings?.siteName ?? APP_NAME_CN} · 通过邮箱验证码重置
          </p>
        </div>

        <Card>
          <CardBody className="flex flex-col gap-4 py-5">
            {notice ? (
              <Alert tone="success" className="items-start">
                <span className="flex items-start gap-1.5">
                  <MailCheck size={13} className="mt-px shrink-0" />
                  {notice}
                </span>
              </Alert>
            ) : null}

            {step === 'request' ? (
              <form className="flex flex-col gap-3.5" onSubmit={(event) => void handleRequest(event)}>
                <Field label="注册邮箱" required hint="我们会向该邮箱发送 6 位验证码">
                  <Input
                    type="email"
                    value={email}
                    onChange={(event) => setEmail(event.target.value)}
                    autoComplete="email"
                    autoFocus
                    required
                  />
                </Field>

                {error ? <Alert tone="danger">{error}</Alert> : null}

                <Button type="submit" variant="primary" size="lg" loading={submitting} className="w-full">
                  发送验证码
                </Button>
              </form>
            ) : (
              <form className="flex flex-col gap-3.5" onSubmit={(event) => void handleReset(event)}>
                <Field label="邮箱">
                  <Input type="email" value={email} onChange={(event) => setEmail(event.target.value)} required />
                </Field>

                <Field label="验证码" required>
                  <Input
                    value={code}
                    onChange={(event) => setCode(event.target.value.replace(/\D/g, '').slice(0, 6))}
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    placeholder="000000"
                    className="font-mono tracking-[0.3em]"
                    autoFocus
                    required
                  />
                </Field>

                <Field label="新密码" required hint="至少 8 位，需含大小写字母与数字">
                  <Input
                    type="password"
                    value={newPassword}
                    onChange={(event) => setNewPassword(event.target.value)}
                    autoComplete="new-password"
                    required
                  />
                </Field>

                <Field label="确认新密码" required>
                  <Input
                    type="password"
                    value={confirm}
                    onChange={(event) => setConfirm(event.target.value)}
                    autoComplete="new-password"
                    required
                  />
                </Field>

                {error ? <Alert tone="danger">{error}</Alert> : null}

                <Button type="submit" variant="primary" size="lg" loading={submitting} className="w-full">
                  重置密码
                </Button>

                <Button
                  variant="quiet"
                  size="sm"
                  onClick={() => {
                    setStep('request');
                    setError(null);
                    setNotice(null);
                  }}
                >
                  没收到验证码？重新发送
                </Button>
              </form>
            )}
          </CardBody>
        </Card>

        <div className="mt-4 flex flex-col items-center gap-1.5">
          <Link
            to="/login"
            className="flex items-center gap-1 font-sans text-xs text-muted underline-offset-2 hover:text-ink hover:underline"
          >
            <ArrowLeft size={12} />
            返回登录
          </Link>
          <p className="font-mono text-[11px] text-faint">
            {APP_NAME} v{settings?.version ?? VERSION}
          </p>
        </div>
      </div>
    </div>
  );
}
