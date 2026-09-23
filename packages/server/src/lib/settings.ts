import { eq, inArray } from 'drizzle-orm';
import {
  siteSettingsSchema,
  type MailSettingsSummary,
  type PublicSettings,
  type SiteSettings,
} from '@readsync/shared';
import { VERSION } from '@readsync/shared';
import { allowPlaintextPassword } from '../crypto/keys.js';
import { getDb } from '../db/index.js';
import { serverSettings } from '../db/schema.js';
import { getPublicKeyFingerprintSafe } from './fingerprint.js';

/**
 * 站点设置的读写。
 *
 * 存储方式为 server_settings 表的单行 key-value（value 为 JSON），
 * 好处是新增设置项不需要数据库迁移。读取时与默认值合并后过一遍 zod，
 * 保证历史数据缺字段时也能得到完整、合法的配置对象。
 */

const SITE_SETTINGS_KEY = 'site';
const MAIL_SETTINGS_KEY = 'mail';

/** 站点设置默认值：从 schema 解析空对象得到 */
function defaultSiteSettings(): SiteSettings {
  return siteSettingsSchema.parse({});
}

/** 读取站点设置（已与默认值合并） */
export function getSiteSettings(): SiteSettings {
  const db = getDb();
  const row = db.select().from(serverSettings).where(eq(serverSettings.key, SITE_SETTINGS_KEY)).get();

  const defaults = defaultSiteSettings();
  if (!row?.value || typeof row.value !== 'object') {
    return defaults;
  }

  // 部分字段可能来自旧版本，合并后再校验；校验失败时回退默认值而不是让服务起不来
  const merged = deepMerge(defaults as unknown as Record<string, unknown>, row.value as Record<string, unknown>);
  const parsed = siteSettingsSchema.safeParse(merged);
  return parsed.success ? parsed.data : defaults;
}

/** 写入站点设置（整体覆盖，调用方传入完整对象） */
export function saveSiteSettings(settings: SiteSettings): SiteSettings {
  const validated = siteSettingsSchema.parse(settings);
  writeSetting(SITE_SETTINGS_KEY, validated);
  return validated;
}

/** 部分更新站点设置 */
export function patchSiteSettings(patch: Partial<SiteSettings>): SiteSettings {
  const current = getSiteSettings();
  return saveSiteSettings(deepMerge(current as unknown as Record<string, unknown>, patch as Record<string, unknown>) as unknown as SiteSettings);
}

/** 未登录用户可见的公开设置（登录页需要知道是否开放注册、站点名与版本号） */
export function getPublicSettings(): PublicSettings {
  const s = getSiteSettings();
  return {
    siteName: s.siteName,
    registrationEnabled: s.registrationEnabled,
    inviteRequired: s.inviteRequired,
    passwordResetEnabled: s.passwordResetEnabled,
    defaultTheme: s.defaultTheme,
    footerText: s.footerText,
    version: VERSION,
    // 前端据此决定：无法使用 WebCrypto 时是报错还是降级为明文提交
    allowPlaintextPassword: allowPlaintextPassword(),
    // 前端据此在上传前预检大小与扩展名，避免白传一场
    upload: {
      maxFileSize: s.upload.maxFileSize,
      allowedExtensions: [...s.upload.allowedExtensions],
    },
  };
}

/** 邮件设置原始值（含密文，仅供内部使用） */
export function getMailSettingsRaw(): Record<string, unknown> | null {
  const db = getDb();
  const row = db.select().from(serverSettings).where(eq(serverSettings.key, MAIL_SETTINGS_KEY)).get();
  return (row?.value as Record<string, unknown> | undefined) ?? null;
}

/** 写入邮件设置（调用方负责先加密敏感字段） */
export function saveMailSettingsRaw(value: Record<string, unknown>): void {
  writeSetting(MAIL_SETTINGS_KEY, value);
}

/** 邮件设置对外表示（脱敏），供管理后台展示 */
export function getMailSettingsSummary(): MailSettingsSummary {
  const raw = getMailSettingsRaw();
  if (!raw) {
    return {
      enabled: false,
      provider: 'console',
      from: null,
      detail: {},
      lastTestAt: null,
      lastTestOk: null,
      lastTestMessage: null,
    };
  }

  const provider = (raw.provider as MailSettingsSummary['provider']) ?? 'console';
  const detail: Record<string, unknown> = {};
  if (typeof raw.host === 'string') detail.host = raw.host;
  if (typeof raw.port === 'number') detail.port = raw.port;
  if (typeof raw.username === 'string') detail.username = maskTail(raw.username);
  if (typeof raw.apiKey === 'string') detail.apiKey = '••••••••';
  if (typeof raw.password === 'string') detail.password = '••••••••';

  return {
    enabled: raw.enabled === true,
    provider,
    from: typeof raw.from === 'string' ? raw.from : null,
    detail,
    lastTestAt: typeof raw.lastTestAt === 'string' ? raw.lastTestAt : null,
    lastTestOk: typeof raw.lastTestOk === 'boolean' ? raw.lastTestOk : null,
    lastTestMessage: typeof raw.lastTestMessage === 'string' ? raw.lastTestMessage : null,
  };
}

/** 记录邮件测试结果 */
export function recordMailTestResult(ok: boolean, message: string): void {
  const raw = getMailSettingsRaw();
  if (!raw) return;
  writeSetting(MAIL_SETTINGS_KEY, {
    ...raw,
    lastTestAt: new Date().toISOString(),
    lastTestOk: ok,
    lastTestMessage: message,
  });
}

/* ------------------------------- 通用读写 ------------------------------- */

/** 批量读取多个设置项，返回 key → value */
export function getSettings<T = unknown>(keys: string[]): Record<string, T | undefined> {
  if (keys.length === 0) return {};
  const db = getDb();
  const rows = db.select().from(serverSettings).where(inArray(serverSettings.key, keys)).all();
  const out: Record<string, T | undefined> = {};
  for (const key of keys) out[key] = undefined;
  for (const row of rows) out[row.key] = row.value as T;
  return out;
}

/** 读取单个设置项 */
export function getSetting<T = unknown>(key: string): T | undefined {
  return getSettings<T>([key])[key];
}

/** 写入单个设置项（upsert） */
export function writeSetting(key: string, value: unknown): void {
  const db = getDb();
  db.insert(serverSettings)
    .values({ key, value, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: serverSettings.key,
      set: { value, updatedAt: new Date() },
    })
    .run();
}

/* -------------------------------- 工具 -------------------------------- */

function maskTail(value: string): string {
  if (value.length <= 4) return '••••';
  return `${'•'.repeat(Math.min(8, value.length - 2))}${value.slice(-2)}`;
}

/** 深合并（仅处理普通对象，数组整体替换） */
function deepMerge(base: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    const prev = out[key];
    if (isPlainObject(prev) && isPlainObject(value)) {
      out[key] = deepMerge(prev, value);
    } else if (value !== undefined) {
      out[key] = value;
    }
  }
  return out;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export { getPublicKeyFingerprintSafe };
