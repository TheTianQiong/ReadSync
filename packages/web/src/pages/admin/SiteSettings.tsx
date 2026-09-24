import type { MailSettingsSummary, SiteSettings as SiteSettingsData, SystemInfo } from '@readsync/shared';
import { Save, Send } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { Alert } from '../../components/ui/Alert';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Card, CardBody, CardFooter, CardHeader, StatTile } from '../../components/ui/Card';
import { Field, Input, Select, Textarea } from '../../components/ui/Input';
import { PageSpinner } from '../../components/ui/Spinner';
import { Switch } from '../../components/ui/Switch';
import { useToast } from '../../components/ui/Toast';
import { api } from '../../lib/api';
import { useAsync } from '../../lib/hooks';
import { formatBytes, formatDuration } from '../../lib/utils';

/**
 * 网站管理（README 要求 9）。
 *
 * 站点设置、邮件服务、系统信息三块。
 * 上传限制与注册开关直接决定登录页与上传对话框的行为，
 * 因此保存后由服务端下发新的公开设置，前端下次拉取即可生效。
 */
export function SiteSettings(): ReactNode {
  const toast = useToast();

  const settings = useAsync(() => api.get<SiteSettingsData>('/admin/settings'), []);
  const system = useAsync(() => api.get<SystemInfo>('/admin/system'), []);

  const [form, setForm] = useState<SiteSettingsData | null>(null);
  const [savingSettings, setSavingSettings] = useState(false);
  const [settingsError, setSettingsError] = useState<string | null>(null);

  const [extensions, setExtensions] = useState('');

  useEffect(() => {
    if (!settings.data) return;
    setForm(settings.data);
    setExtensions((settings.data.upload?.allowedExtensions ?? []).join(', '));
  }, [settings.data]);

  const patch = (updates: Partial<SiteSettingsData>): void => {
    setForm((prev) => (prev ? { ...prev, ...updates } : prev));
  };

  const handleSaveSettings = async (): Promise<void> => {
    if (!form) return;
    setSavingSettings(true);
    setSettingsError(null);
    try {
      await api.patch('/admin/settings', {
        ...form,
        upload: {
          maxFileSize: form.upload.maxFileSize,
          allowedExtensions: extensions
            .split(/[,，\s]+/)
            .map((item) => item.trim().toLowerCase().replace(/^\./, ''))
            .filter(Boolean),
          strategy: form.upload.strategy,
          baseUrl: form.upload.baseUrl.trim(),
        },
      });
      toast.success('站点设置已保存');
      settings.reload();
    } catch (err) {
      setSettingsError(err instanceof Error ? err.message : '保存失败');
    } finally {
      setSavingSettings(false);
    }
  };

  if (settings.loading || !form) {
    return settings.error && !settings.error.isMissing ? (
      <Alert tone="danger">{settings.error.message}</Alert>
    ) : (
      <PageSpinner label="正在读取站点设置…" />
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <Card>
        <CardHeader title="站点" description="站点名称会显示在导航栏、登录页与邮件标题中" />
        <CardBody className="flex flex-col gap-3.5">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="站点名称" required>
              <Input
                value={form.siteName}
                onChange={(event) => patch({ siteName: event.target.value })}
                maxLength={64}
              />
            </Field>

            <Field label="默认主题" hint="新访客首次打开时使用的主题">
              <Select
                value={form.defaultTheme}
                onChange={(event) => patch({ defaultTheme: event.target.value as SiteSettingsData['defaultTheme'] })}
              >
                <option value="system">跟随系统</option>
                <option value="light">白天</option>
                <option value="dark">夜晚</option>
              </Select>
            </Field>
          </div>

          <Field label="页脚文本" hint="留空则显示「© 年份 站点名」">
            <Textarea
              value={form.footerText}
              onChange={(event) => patch({ footerText: event.target.value })}
              maxLength={256}
              rows={2}
            />
          </Field>
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="注册与账号" description="控制新用户如何加入本站" />
        <CardBody className="flex flex-col gap-3">
          <Switch
            checked={form.registrationEnabled}
            onChange={(next) => patch({ registrationEnabled: next })}
            label="开放自助注册"
            description="关闭后只能由管理员在「用户管理」中创建账号"
          />
          <Switch
            checked={form.inviteRequired}
            onChange={(next) => patch({ inviteRequired: next })}
            label="需要邀请码"
            description="开启后注册必须填写有效邀请码"
          />
          <Switch
            checked={form.passwordResetEnabled}
            onChange={(next) => patch({ passwordResetEnabled: next })}
            label="允许邮件找回密码"
            description="需要先在下方配置可用的邮件服务"
          />
          <Switch
            checked={form.allowUserStorage}
            onChange={(next) => patch({ allowUserStorage: next })}
            label="允许用户自行配置存储后端"
            description="关闭后用户只能使用管理员配置的存储"
          />
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="上传限制" description="README 要求：可限制用户上传文件的大小与类型" />
        <CardBody className="flex flex-col gap-3.5">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="单文件上限（字节）" hint={`当前约 ${formatBytes(form.upload.maxFileSize)}`}>
              <Input
                type="number"
                min={0}
                value={String(form.upload.maxFileSize)}
                onChange={(event) =>
                  patch({ upload: { ...form.upload, maxFileSize: Number(event.target.value) || 0 } })
                }
              />
            </Field>

            <Field label="单用户容量配额（字节）" hint="0 表示不限制">
              <Input
                type="number"
                min={0}
                value={String(form.userQuotaBytes)}
                onChange={(event) => patch({ userQuotaBytes: Number(event.target.value) || 0 })}
              />
            </Field>
          </div>

          <Switch
            checked={form.uploadEnabled}
            onChange={(next) => patch({ uploadEnabled: next })}
            label="允许上传书籍文件"
            description="关闭后所有上传入口与上传接口都会被拒绝，但「登记书目」（只填书名、作者、MD5，不传文件）仍然可用。阅读进度同步与统计不依赖文件，只有下载与版本回滚需要 —— 若服务器在 CDN 后面传大文件总失败，而你只需要同步，可以关掉它。"
          />

          <Field label="允许的文件扩展名" hint="逗号分隔，不带点；涵盖 epub、pdf、zip、json 等">
            <Textarea
              value={extensions}
              onChange={(event) => setExtensions(event.target.value)}
              rows={2}
              className="font-mono text-xs"
            />
          </Field>

          <Field
            label="上传方式"
            hint={
              form.upload.strategy === 'chunked'
                ? '分片上传：每个请求都很小，能穿过 Nginx、Cloudflare 等对请求体大小与请求时长的限制。有反向代理时选它。'
                : form.upload.strategy === 'presigned'
                  ? '预签名直传：浏览器凭服务端签发的链接把文件直接传给对象存储，数据完全不经过本服务器 —— 不占服务器带宽与磁盘，也不受任何前置代理/CDN 限制。仅对象存储（R2/OSS/COS/MinIO）可用，且需在桶上配置 CORS；不支持时会自动回退到分片上传。'
                  : '整体上传：一次 POST 发完，请求数最少。仅在客户端与服务器之间没有代理限制时可靠（内网直连、本机访问）。'
            }
          >
            <Select
              value={form.upload.strategy}
              onChange={(event) =>
                patch({
                  upload: {
                    ...form.upload,
                    strategy: event.target.value as 'chunked' | 'direct' | 'presigned',
                  },
                })
              }
            >
              <option value="chunked">分片上传（推荐，兼容反向代理）</option>
              <option value="presigned">预签名直传（对象存储，不经过服务器）</option>
              <option value="direct">整体上传（无代理时更快）</option>
            </Select>
          </Field>

          <Field
            label="上传专用地址"
            hint="留空表示与本站同源。填了之后上传请求会发往该地址 —— 用于「主站走 CDN、上传另开一个直连子域以绕开 CDN 的请求体与超时限制」。必须是 http(s) 的源地址，不带路径。配置方法见 docs/https-setup.md。"
          >
            <Input
              value={form.upload.baseUrl}
              placeholder="https://upload.example.com:8443"
              onChange={(event) => patch({ upload: { ...form.upload, baseUrl: event.target.value } })}
            />
          </Field>
        </CardBody>
        <CardFooter>
          <Button
            variant="primary"
            size="sm"
            loading={savingSettings}
            icon={<Save size={13} />}
            onClick={() => void handleSaveSettings()}
          >
            保存设置
          </Button>
        </CardFooter>
      </Card>

      {settingsError ? <Alert tone="danger">{settingsError}</Alert> : null}

      <MailSettingsCard />

      <Card>
        <CardHeader
          title="系统信息"
          description="版本、运行时与数据量"
          actions={system.error?.isMissing ? <span className="font-sans text-xs text-muted">接口未就绪</span> : null}
        />
        <CardBody>
          {system.loading ? (
            <PageSpinner label="正在读取系统信息…" />
          ) : system.data ? (
            <div className="flex flex-col gap-3">
              <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
                <StatTile label="版本" value={system.data.version} />
                <StatTile label="Node" value={system.data.nodeVersion} />
                <StatTile label="运行时长" value={formatDuration(system.data.uptimeSeconds)} />
                <StatTile label="数据目录" value={formatBytes(system.data.dataDirSize)} />
              </div>

              <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
                <StatTile label="用户" value={system.data.counts.users} />
                <StatTile label="书籍" value={system.data.counts.books} />
                <StatTile label="存储" value={system.data.counts.storages} />
                <StatTile label="同步条目" value={system.data.counts.syncEntries} />
              </div>

              <p className="font-sans text-xs text-muted">
                平台 {system.data.platform} · 公钥指纹{' '}
                <span className="font-mono">{system.data.publicKeyFingerprint}</span>
              </p>
            </div>
          ) : (
            <p className="font-sans text-xs text-muted">暂无系统信息</p>
          )}
        </CardBody>
      </Card>
    </div>
  );
}

/** 邮件服务配置（Resend / SMTP / 控制台），README 要求用于验证码与通知发送 */
function MailSettingsCard(): ReactNode {
  const toast = useToast();
  const current = useAsync(() => api.get<MailSettingsSummary>('/admin/mail'), []);

  const [provider, setProvider] = useState<'resend' | 'smtp' | 'console'>('console');
  const [enabled, setEnabled] = useState(false);
  const [from, setFrom] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [host, setHost] = useState('');
  const [port, setPort] = useState('587');
  const [secure, setSecure] = useState(false);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [testTo, setTestTo] = useState('');
  const [testing, setTesting] = useState(false);

  useEffect(() => {
    const data = current.data;
    if (!data) return;
    setProvider(data.provider);
    setEnabled(data.enabled);
    setFrom(data.from ?? '');
    const detail = data.detail ?? {};
    if (typeof detail.host === 'string') setHost(detail.host);
    if (detail.port !== undefined) setPort(String(detail.port));
  }, [current.data]);

  const handleSave = async (): Promise<void> => {
    setSaving(true);
    setError(null);
    try {
      const base = {
        enabled,
        provider,
        ...(provider === 'console' ? { from: from || 'noreply@localhost' } : { from }),
      };
      const payload =
        provider === 'resend'
          ? { ...base, apiKey }
          : provider === 'smtp'
            ? { ...base, host, port: Number(port) || 587, secure, username, password }
            : base;

      // 编辑时留空密钥表示沿用原值
      if (provider !== 'console' && !from.trim()) {
        setError('请填写发件人地址');
        setSaving(false);
        return;
      }

      await api.put('/admin/mail', payload);
      toast.success('邮件设置已保存');
      current.reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存失败');
    } finally {
      setSaving(false);
    }
  };

  const handleTest = async (): Promise<void> => {
    if (!testTo.trim()) {
      setError('请填写测试收件人');
      return;
    }
    setTesting(true);
    setError(null);
    try {
      await api.post('/admin/mail/test', { to: testTo.trim() });
      toast.success('测试邮件已发送，请查收');
      current.reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : '发送失败');
    } finally {
      setTesting(false);
    }
  };

  return (
    <Card>
      <CardHeader
        title="邮件服务"
        description="用于发送验证码、密码重置与安全通知"
        actions={
          current.data ? (
            current.data.lastTestOk === null || current.data.lastTestOk === undefined ? (
              <Badge tone="outline">未测试</Badge>
            ) : current.data.lastTestOk ? (
              <Badge tone="ochre">最近测试成功</Badge>
            ) : (
              <Badge tone="danger">最近测试失败</Badge>
            )
          ) : null
        }
      />
      <CardBody className="flex flex-col gap-3.5">
        {current.error?.isMissing ? (
          <Alert tone="info">邮件配置接口尚未就绪（/api/admin/mail 返回 404）。</Alert>
        ) : null}

        <Switch checked={enabled} onChange={setEnabled} label="启用邮件发送" />

        <Field label="服务商">
          <Select value={provider} onChange={(event) => setProvider(event.target.value as typeof provider)}>
            <option value="console">控制台输出（仅开发调试）</option>
            <option value="resend">Resend</option>
            <option value="smtp">SMTP</option>
          </Select>
        </Field>

        {provider === 'resend' ? (
          <Field label="API Key" hint="留空表示保持原值不变">
            <Input
              type="password"
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
              autoComplete="new-password"
            />
          </Field>
        ) : null}

        {provider === 'smtp' ? (
          <>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <Field label="主机" className="sm:col-span-2">
                <Input value={host} onChange={(event) => setHost(event.target.value)} />
              </Field>
              <Field label="端口">
                <Input type="number" value={port} onChange={(event) => setPort(event.target.value)} />
              </Field>
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field label="用户名">
                <Input value={username} onChange={(event) => setUsername(event.target.value)} />
              </Field>
              <Field label="密码" hint="留空表示保持原值不变">
                <Input
                  type="password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  autoComplete="new-password"
                />
              </Field>
            </div>
            <Switch checked={secure} onChange={setSecure} label="使用 TLS（465 端口通常需要）" />
          </>
        ) : null}

        <Field label="发件人地址" hint="例如 ReadSync <noreply@example.com>">
          <Input value={from} onChange={(event) => setFrom(event.target.value)} />
        </Field>

        {error ? <Alert tone="danger">{error}</Alert> : null}
      </CardBody>
      <CardFooter className="justify-between">
        <div className="flex flex-1 items-center gap-2">
          <Input
            value={testTo}
            onChange={(event) => setTestTo(event.target.value)}
            placeholder="测试收件人邮箱"
            className="max-w-60"
          />
          <Button size="sm" variant="secondary" loading={testing} icon={<Send size={13} />} onClick={() => void handleTest()}>
            发送测试
          </Button>
        </div>
        <Button variant="primary" size="sm" loading={saving} icon={<Save size={13} />} onClick={() => void handleSave()}>
          保存邮件设置
        </Button>
      </CardFooter>
    </Card>
  );
}
