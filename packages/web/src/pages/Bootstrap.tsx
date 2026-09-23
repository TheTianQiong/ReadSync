import { APP_NAME_CN, VERSION, type BootstrapStatus } from '@readsync/shared';
import { BookOpen, Shield } from 'lucide-react';
import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { Alert } from '../components/ui/Alert';
import { Button } from '../components/ui/Button';
import { Card, CardBody } from '../components/ui/Card';
import { Field, Input } from '../components/ui/Input';
import { PageSpinner } from '../components/ui/Spinner';
import { useAuth } from '../contexts/AuthContext';
import { ApiError, api } from '../lib/api';
import { buildPasswordPayload, isEncryptionAvailable, isPlaintextFallbackActive } from '../lib/crypto';
import { emailField, passwordSchema, usernameField, validateAll } from '../lib/validation';

/**
 * 初始化引导页。
 *
 * README 要求 9：「网站初始化时，应注册管理员账号」。
 * App 在启动时读 GET /api/system/bootstrap，只要 initialized === false 就只渲染本页，
 * 其它路由一律不可达，避免在无管理员状态下出现半可用的站点。
 */
export function Bootstrap(): ReactNode {
  const navigate = useNavigate();
  const { refreshSite, login } = useAuth();

  const [siteName, setSiteName] = useState(APP_NAME_CN);
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(true);

  // 兜底：用户手动打开 /bootstrap 时，若站点已初始化就送回登录页
  useEffect(() => {
    let cancelled = false;
    api
      .get<BootstrapStatus>('/system/bootstrap', undefined, { auth: false })
      .then((status) => {
        if (cancelled) return;
        if (status.initialized) navigate('/login', { replace: true });
      })
      .catch(() => {
        /* 探测失败就继续展示表单，提交时后端会再校验一次 */
      })
      .finally(() => {
        if (!cancelled) setChecking(false);
      });
    return () => {
      cancelled = true;
    };
  }, [navigate]);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
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

    setSubmitting(true);
    try {
      // 与登录/注册一致：密码以 RSA 密文提交，明文不出浏览器
      const passwordPayload = await buildPasswordPayload(password);
      await api.post('/system/bootstrap', { username, email, password: passwordPayload, siteName }, { auth: false });

      // 初始化后站点进入正常模式，刷新引导状态再放行路由
      await refreshSite();

      // 顺手登录，省得管理员再输一遍刚设好的密码
      try {
        await login({ username, password, remember: true });
        navigate('/', { replace: true });
      } catch {
        navigate('/login', { replace: true, state: { notice: '管理员账号已创建，请登录' } });
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '初始化失败，请稍后重试');
    } finally {
      setSubmitting(false);
    }
  };

  if (checking) return <PageSpinner label="正在检查站点状态…" />;

  return (
    <div className="flex min-h-screen items-center justify-center bg-paper px-4 py-10">
      <div className="w-full max-w-md">
        <div className="mb-6 flex flex-col items-center gap-2 text-center">
          <BookOpen size={26} className="text-ink" />
          <h1 className="font-serif text-xl text-ink">{APP_NAME_CN}</h1>
          <p className="font-sans text-xs text-muted">站点尚未初始化，请创建第一个管理员账号</p>
        </div>

        <Card>
          <CardBody className="flex flex-col gap-4 py-5">
            <Alert tone="info">
              该账号拥有全部管理权限，请使用强密码并妥善保管。站点初始化完成后，此页面将永久关闭。
            </Alert>

            {isPlaintextFallbackActive() ? (
              <Alert tone="warning">
                当前通过 HTTP 访问，浏览器不提供 WebCrypto，密码将以<strong>明文</strong>提交。
                仅在内网或可信网络中这样使用；公网部署请改用 HTTPS
                （可参考 README 的 Cloudflare Tunnel 配置）。
              </Alert>
            ) : !isEncryptionAvailable() ? (
              <Alert tone="danger">
                当前页面不是安全上下文，浏览器不提供 WebCrypto，无法加密密码，因此无法完成初始化。
                请任选一种方式：
                <br />· 通过 <code>http://localhost:3000</code> 在本机访问；
                <br />· 配置 HTTPS（如 Cloudflare Tunnel，见 README）；
                <br />· 若确实只能走 HTTP，在服务端 <code>.env</code> 中设置{' '}
                <code>READSYNC_ALLOW_PLAINTEXT_PASSWORD=true</code> 后重启（密码将明文传输，仅限可信网络）。
              </Alert>
            ) : null}

            <form className="flex flex-col gap-3.5" onSubmit={(event) => void handleSubmit(event)}>
              <Field label="站点名称" required>
                <Input
                  value={siteName}
                  onChange={(event) => setSiteName(event.target.value)}
                  placeholder="读记服务器"
                  maxLength={64}
                  required
                />
              </Field>

              <Field label="管理员用户名" required hint="以字母开头，可含数字、下划线和连字符">
                <Input
                  value={username}
                  onChange={(event) => setUsername(event.target.value)}
                  autoComplete="username"
                  required
                />
              </Field>

              <Field label="邮箱" required hint="用于找回密码与接收通知">
                <Input
                  type="email"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  autoComplete="email"
                  required
                />
              </Field>

              <Field label="密码" required hint="至少 8 位，需含大小写字母与数字">
                <Input
                  type="password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  autoComplete="new-password"
                  required
                />
              </Field>

              <Field label="确认密码" required>
                <Input
                  type="password"
                  value={confirm}
                  onChange={(event) => setConfirm(event.target.value)}
                  autoComplete="new-password"
                  required
                />
              </Field>

              {error ? <Alert tone="danger">{error}</Alert> : null}

              <Button
                type="submit"
                variant="primary"
                size="lg"
                loading={submitting}
                icon={<Shield size={15} />}
                className="mt-1 w-full"
              >
                创建管理员并完成初始化
              </Button>
            </form>
          </CardBody>
        </Card>

        <p className="mt-4 text-center font-sans text-[11px] text-faint">
          密码经 RSA-OAEP 加密后传输，服务端以 Argon2id 单向哈希存储
        </p>
        <p className="mt-1.5 text-center font-mono text-[11px] text-faint">ReadSync v{VERSION}</p>
      </div>
    </div>
  );
}
