import type { SessionUser, UserPreferences } from '@readsync/shared';
import { Save, Upload } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Alert } from '../../components/ui/Alert';
import { Button } from '../../components/ui/Button';
import { Card, CardBody, CardFooter, CardHeader } from '../../components/ui/Card';
import { Field, Input, Select } from '../../components/ui/Input';
import { PageSpinner } from '../../components/ui/Spinner';
import { Switch } from '../../components/ui/Switch';
import { useToast } from '../../components/ui/Toast';
import { useAuth } from '../../contexts/AuthContext';
import { useTheme } from '../../contexts/ThemeContext';
import { api } from '../../lib/api';
import { useAsync } from '../../lib/hooks';
import { THEME_LABELS } from '../../lib/theme';

/** 常见时区；用户也可以直接手填 IANA 名称 */
const TIMEZONE_PRESETS = [
  'Asia/Shanghai',
  'Asia/Hong_Kong',
  'Asia/Taipei',
  'Asia/Tokyo',
  'Asia/Singapore',
  'Europe/London',
  'America/New_York',
  'UTC',
] as const;

/**
 * 基础设置。
 *
 * 资料（/api/users/me）与偏好（/api/users/me/preferences）是两个端点，
 * 分成两张卡片分别保存，避免一次请求里混入两种错误来源不好定位。
 */
export function Profile(): ReactNode {
  const { user, patchUser, refreshUser } = useAuth();
  const { theme, setTheme } = useTheme();
  const toast = useToast();
  const avatarInputRef = useRef<HTMLInputElement>(null);

  const preferences = useAsync(() => api.get<UserPreferences>('/users/me/preferences'), []);

  const [displayName, setDisplayName] = useState('');
  const [email, setEmail] = useState('');
  const [savingProfile, setSavingProfile] = useState(false);
  const [profileError, setProfileError] = useState<string | null>(null);

  const [pageSize, setPageSize] = useState('20');
  const [timezone, setTimezone] = useState('Asia/Shanghai');
  const [emailNotifications, setEmailNotifications] = useState(true);
  const [savingPrefs, setSavingPrefs] = useState(false);
  const [prefsError, setPrefsError] = useState<string | null>(null);

  const [uploadingAvatar, setUploadingAvatar] = useState(false);

  // 用户资料到货后回填表单
  useEffect(() => {
    if (!user) return;
    setDisplayName(user.displayName ?? '');
    setEmail(user.email);
  }, [user]);

  // 偏好到货后回填；端点未实现时保留默认值
  useEffect(() => {
    const prefs = preferences.data;
    if (!prefs) return;
    setPageSize(String(prefs.pageSize ?? 20));
    setTimezone(prefs.timezone ?? 'Asia/Shanghai');
    setEmailNotifications(prefs.emailNotifications ?? true);
  }, [preferences.data]);

  const handleSaveProfile = async (): Promise<void> => {
    setSavingProfile(true);
    setProfileError(null);
    try {
      const updated = await api.patch<SessionUser>('/users/me', {
        displayName: displayName.trim(),
        email: email.trim(),
      });
      // 后端可能只返回部分字段，兜底用本地值合并
      patchUser({ displayName: updated?.displayName ?? displayName.trim(), email: updated?.email ?? email.trim() });
      toast.success('资料已保存');
    } catch (err) {
      setProfileError(err instanceof Error ? err.message : '保存失败');
    } finally {
      setSavingProfile(false);
    }
  };

  const handleSavePreferences = async (): Promise<void> => {
    setSavingPrefs(true);
    setPrefsError(null);
    try {
      await api.patch<UserPreferences>('/users/me/preferences', {
        theme,
        pageSize: Number(pageSize) || 20,
        timezone,
        emailNotifications,
      });
      toast.success('偏好已保存');
    } catch (err) {
      setPrefsError(err instanceof Error ? err.message : '保存失败');
    } finally {
      setSavingPrefs(false);
    }
  };

  const handleAvatar = async (file: File | null): Promise<void> => {
    if (!file) return;
    setUploadingAvatar(true);
    try {
      const form = new FormData();
      form.append('file', file);
      await api.upload('/users/me/avatar', form);
      toast.success('头像已更新');
      // 头像 URL 由服务端生成，重新拉一次用户信息拿最新地址（并绕过浏览器缓存）
      await refreshUser();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '头像上传失败');
    } finally {
      setUploadingAvatar(false);
      if (avatarInputRef.current) avatarInputRef.current.value = '';
    }
  };

  if (!user) return <PageSpinner />;

  return (
    <div className="flex flex-col gap-3">
      <Card>
        <CardHeader title="个人资料" description="显示名称会出现在导航栏与审计日志中" />
        <CardBody className="flex flex-col gap-4 sm:flex-row">
          <div className="flex shrink-0 flex-col items-center gap-2">
            <div className="flex size-20 items-center justify-center overflow-hidden rounded-sm border border-line bg-raised">
              {user.avatarUrl ? (
                <img src={user.avatarUrl} alt="头像" className="size-full object-cover" />
              ) : (
                <span className="font-serif text-2xl text-faint">
                  {(user.displayName || user.username).slice(0, 1).toUpperCase()}
                </span>
              )}
            </div>
            <input
              ref={avatarInputRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={(event) => void handleAvatar(event.target.files?.[0] ?? null)}
            />
            <Button
              size="sm"
              variant="secondary"
              loading={uploadingAvatar}
              icon={<Upload size={12} />}
              onClick={() => avatarInputRef.current?.click()}
            >
              更换头像
            </Button>
          </div>

          <div className="flex min-w-0 flex-1 flex-col gap-3.5">
            <Field label="用户名" hint="用户名不可修改">
              <Input value={user.username} disabled />
            </Field>

            <Field label="显示名称">
              <Input
                value={displayName}
                onChange={(event) => setDisplayName(event.target.value)}
                maxLength={64}
                placeholder="留空则显示用户名"
              />
            </Field>

            <Field label="邮箱" hint="用于找回密码与接收系统通知">
              <Input
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                autoComplete="email"
              />
            </Field>

            {profileError ? <Alert tone="danger">{profileError}</Alert> : null}
          </div>
        </CardBody>
        <CardFooter>
          <Button
            variant="primary"
            size="sm"
            loading={savingProfile}
            icon={<Save size={13} />}
            onClick={() => void handleSaveProfile()}
          >
            保存资料
          </Button>
        </CardFooter>
      </Card>

      <Card>
        <CardHeader
          title="使用偏好"
          description="主题、分页大小与通知，登录后随账号同步"
          actions={preferences.error?.isMissing ? <span className="font-sans text-xs text-muted">接口未就绪</span> : null}
        />
        <CardBody className="flex flex-col gap-3.5">
          <Field label="主题" hint="也可用导航栏右上角的按钮快速切换">
            <Select value={theme} onChange={(event) => setTheme(event.target.value as typeof theme)}>
              {(Object.keys(THEME_LABELS) as Array<keyof typeof THEME_LABELS>).map((key) => (
                <option key={key} value={key}>
                  {THEME_LABELS[key]}
                </option>
              ))}
            </Select>
          </Field>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="每页条数" hint="5–100">
              <Input
                type="number"
                min={5}
                max={100}
                value={pageSize}
                onChange={(event) => setPageSize(event.target.value)}
              />
            </Field>

            <Field label="时区" hint="影响统计里「今天」的划分">
              <Input
                value={timezone}
                onChange={(event) => setTimezone(event.target.value)}
                list="timezone-presets"
                maxLength={64}
              />
            </Field>
          </div>

          <datalist id="timezone-presets">
            {TIMEZONE_PRESETS.map((zone) => (
              <option key={zone} value={zone} />
            ))}
          </datalist>

          <Switch
            checked={emailNotifications}
            onChange={setEmailNotifications}
            label="邮件通知"
            description="密码变更、异常登录等安全事件发送邮件提醒"
          />

          {prefsError ? <Alert tone="danger">{prefsError}</Alert> : null}
        </CardBody>
        <CardFooter>
          <Button
            variant="primary"
            size="sm"
            loading={savingPrefs}
            icon={<Save size={13} />}
            onClick={() => void handleSavePreferences()}
          >
            保存偏好
          </Button>
        </CardFooter>
      </Card>

      <Card>
        <CardHeader title="账号信息" />
        <CardBody>
          {/*
            两栏布局：左列固定宽度放标题，右列放内容。
            这里必须固定为 2 列（grid-cols-[...]）——
            之前写的 grid-cols-2 sm:grid-cols-3 会在宽屏下变成 3 列，
            而 dt/dd 是交替排列的，第 3 列会把下一个标题挤到上一行的末尾，
            整张表随之错位（表现为「标题与内容各自换行、对不上」）。
          */}
          <dl className="grid grid-cols-[5.5rem_1fr] gap-x-4 gap-y-2 font-sans text-xs">
            <dt className="text-muted">用户 ID</dt>
            <dd className="text-ink-soft">{user.id}</dd>
            <dt className="text-muted">角色</dt>
            <dd className="text-ink-soft">{user.role === 'admin' ? '管理员' : '普通用户'}</dd>
            <dt className="text-muted">注册时间</dt>
            <dd className="text-ink-soft">{new Date(user.createdAt).toLocaleString('zh-CN')}</dd>
            <dt className="text-muted">两步验证</dt>
            <dd className="text-ink-soft">{user.totpEnabled ? '已开启' : '未开启'}</dd>
            <dt className="text-muted">通行密钥</dt>
            <dd className="text-ink-soft">{user.passkeyCount} 个</dd>
            <dt className="text-muted">上次登录</dt>
            <dd className="text-ink-soft">
              {user.lastLoginAt ? new Date(user.lastLoginAt).toLocaleString('zh-CN') : '—'}
            </dd>
          </dl>
        </CardBody>
      </Card>
    </div>
  );
}
