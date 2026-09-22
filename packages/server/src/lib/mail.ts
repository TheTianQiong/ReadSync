import { createTransport, type Transporter } from 'nodemailer';
import type { MailProvider } from '@readsync/shared';
import { decryptString, isEncrypted } from '../crypto/secret-box.js';
import { AppError, ERROR_CODES } from '../errors.js';
import { http } from './http.js';
import { getModuleLogger } from '../logger.js';
import { getMailSettingsRaw, getSiteSettings, recordMailTestResult } from './settings.js';

/**
 * 邮件发送（README 前端要求 9：添加开发者邮件 API 设置，例如 Resend 等类似网站，
 * 实现验证码发送、通知的邮件发送）。
 *
 * 支持三种 provider：
 *  - resend  : 调 Resend REST API（国内可用，配置最简单）
 *  - smtp    : 任意 SMTP 服务器（QQ 邮箱、Gmail、自建 Postfix）
 *  - console : 不真正发送，把邮件内容打到日志里，供本地开发调试
 */

export interface MailMessage {
  to: string;
  subject: string;
  html: string;
  text?: string;
}

export interface MailSendResult {
  ok: boolean;
  message: string;
}

/** 解密后的邮件配置 */
interface ResolvedMailConfig {
  enabled: boolean;
  provider: MailProvider;
  from: string;
  apiKey?: string;
  host?: string;
  port?: number;
  secure?: boolean;
  username?: string;
  password?: string;
}

let cachedTransport: { key: string; transporter: Transporter } | null = null;

/** 读取并解密邮件配置 */
function resolveMailConfig(): ResolvedMailConfig | null {
  const raw = getMailSettingsRaw();
  if (!raw) return null;

  const provider = (raw.provider as MailProvider) ?? 'console';
  const decrypted: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === 'string' && isEncrypted(value)) {
      // 解密失败说明主密钥变了，此时应当让用户重新填写而不是静默失败
      decrypted[key] = decryptString(value);
    } else {
      decrypted[key] = value;
    }
  }

  return {
    enabled: raw.enabled === true,
    provider,
    from: typeof decrypted.from === 'string' ? decrypted.from : 'noreply@localhost',
    apiKey: typeof decrypted.apiKey === 'string' ? decrypted.apiKey : undefined,
    host: typeof decrypted.host === 'string' ? decrypted.host : undefined,
    port: typeof decrypted.port === 'number' ? decrypted.port : 587,
    secure: decrypted.secure === true,
    username: typeof decrypted.username === 'string' ? decrypted.username : undefined,
    password: typeof decrypted.password === 'string' ? decrypted.password : undefined,
  };
}

/** 构造发件人显示名，例如 "读记服务器 <noreply@example.com>" */
function buildFromAddress(from: string): string {
  const siteName = getSiteSettings().siteName;
  // 已经带显示名时不重复添加
  if (from.includes('<')) return from;
  return `${siteName} <${from}>`;
}

/** 获取（并缓存）SMTP 传输器 */
function getSmtpTransport(config: ResolvedMailConfig): Transporter {
  const key = `${config.host}:${config.port}:${config.secure}:${config.username}`;
  if (cachedTransport && cachedTransport.key === key) {
    return cachedTransport.transporter;
  }

  const transporter = createTransport({
    host: config.host,
    port: config.port ?? 587,
    secure: config.secure ?? false,
    auth: config.username ? { user: config.username, pass: config.password ?? '' } : undefined,
    // 自建邮件服务器常见自签证书，这里不强制校验（内网场景）
    tls: { rejectUnauthorized: false },
  });

  cachedTransport = { key, transporter };
  return transporter;
}

/** 通过 Resend REST API 发送 */
async function sendViaResend(config: ResolvedMailConfig, message: MailMessage): Promise<MailSendResult> {
  if (!config.apiKey) {
    return { ok: false, message: '未配置 Resend API Key' };
  }

  const res = await http('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: buildFromAddress(config.from),
      to: [message.to],
      subject: message.subject,
      html: message.html,
      ...(message.text ? { text: message.text } : {}),
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    return { ok: false, message: `Resend 返回 ${res.status}: ${body.slice(0, 300)}` };
  }

  return { ok: true, message: 'Resend 已接受投递' };
}

/** 通过 SMTP 发送 */
async function sendViaSmtp(config: ResolvedMailConfig, message: MailMessage): Promise<MailSendResult> {
  if (!config.host) {
    return { ok: false, message: '未配置 SMTP 主机' };
  }

  const transporter = getSmtpTransport(config);
  await transporter.sendMail({
    from: buildFromAddress(config.from),
    to: message.to,
    subject: message.subject,
    html: message.html,
    ...(message.text ? { text: message.text } : {}),
  });

  return { ok: true, message: 'SMTP 已接受投递' };
}

/**
 * 发送邮件。
 *
 * 邮件未启用时不抛错而是返回失败结果：调用方（如忘记密码）需要据此给用户
 * 一个明确的提示，而不是让整个请求 500。
 */
export async function sendMail(message: MailMessage): Promise<MailSendResult> {
  const log = getModuleLogger('mail');
  const config = resolveMailConfig();

  if (!config) {
    log.warn({ to: message.to, subject: message.subject }, '邮件功能未配置，跳过发送');
    return { ok: false, message: '站点尚未配置邮件服务，请联系管理员' };
  }

  if (!config.enabled && config.provider !== 'console') {
    return { ok: false, message: '邮件服务未启用' };
  }

  try {
    if (config.provider === 'console') {
      // 开发模式下把邮件内容打到日志，方便本地验证验证码流程
      log.info(
        { to: message.to, subject: message.subject, text: message.text ?? stripHtml(message.html) },
        '【开发模式】邮件内容（未真实发送）',
      );
      return { ok: true, message: '开发模式：邮件已输出到日志' };
    }

    if (config.provider === 'resend') {
      return await sendViaResend(config, message);
    }

    return await sendViaSmtp(config, message);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error({ err, to: message.to }, '邮件发送失败');
    return { ok: false, message: `发送失败: ${msg}` };
  }
}

/** 发送测试邮件并记录结果，供管理后台展示 */
export async function sendTestMail(to: string): Promise<MailSendResult> {
  const siteName = getSiteSettings().siteName;
  const result = await sendMail({
    to,
    subject: `【${siteName}】邮件配置测试`,
    html: `
      <div style="font-family: system-ui, sans-serif; line-height: 1.7; color: #1a1a1a;">
        <h2 style="margin: 0 0 12px;">邮件配置测试成功</h2>
        <p>如果你收到这封邮件，说明 ${siteName} 的邮件服务已正确配置。</p>
        <p style="color: #666; font-size: 13px;">发送时间：${new Date().toLocaleString('zh-CN')}</p>
      </div>
    `,
    text: `邮件配置测试成功。如果你收到这封邮件，说明 ${siteName} 的邮件服务已正确配置。`,
  });

  recordMailTestResult(result.ok, result.message);
  return result;
}

/**
 * 发送密码重置验证码。
 * 返回发送结果；调用方无论成功与否都应对前端返回相同文案，避免暴露邮箱是否注册。
 */
export async function sendPasswordResetCode(to: string, code: string, ttlMinutes: number): Promise<MailSendResult> {
  const siteName = getSiteSettings().siteName;
  return sendMail({
    to,
    subject: `【${siteName}】密码重置验证码`,
    html: `
      <div style="font-family: system-ui, sans-serif; line-height: 1.7; color: #1a1a1a;">
        <h2 style="margin: 0 0 12px;">密码重置</h2>
        <p>你的验证码是：</p>
        <p style="font-size: 30px; font-weight: 700; letter-spacing: 6px; margin: 16px 0; color: #111;">
          ${code}
        </p>
        <p>验证码 ${ttlMinutes} 分钟内有效，请勿转发给他人。</p>
        <p style="color: #666; font-size: 13px;">如果这不是你本人的操作，请忽略本邮件。</p>
      </div>
    `,
    text: `你的 ${siteName} 密码重置验证码是 ${code}，${ttlMinutes} 分钟内有效。`,
  });
}

/** 发送「密码已变更」通知，让账号被盗时用户能及时察觉 */
export async function sendPasswordChangedNotice(to: string, ip: string | null): Promise<void> {
  const siteName = getSiteSettings().siteName;
  await sendMail({
    to,
    subject: `【${siteName}】密码已修改`,
    html: `
      <div style="font-family: system-ui, sans-serif; line-height: 1.7; color: #1a1a1a;">
        <p>你的账号密码刚刚被修改。</p>
        <p style="color: #666; font-size: 13px;">
          时间：${new Date().toLocaleString('zh-CN')}${ip ? `　IP：${ip}` : ''}
        </p>
        <p style="color: #b00;">如果不是你本人操作，请立即通过「忘记密码」重置并检查账号安全设置。</p>
      </div>
    `,
    text: `你的 ${siteName} 账号密码刚刚被修改。如非本人操作，请立即重置密码。`,
  });
}

/** 邮件服务是否可用（忘记密码入口据此决定是否展示） */
export function isMailConfigured(): boolean {
  const config = resolveMailConfig();
  return Boolean(config && (config.enabled || config.provider === 'console'));
}

/** 抛出统一的「邮件未配置」错误，供需要强依赖邮件的场景使用 */
export function assertMailConfigured(): void {
  if (!isMailConfigured()) {
    throw new AppError(ERROR_CODES.BAD_REQUEST, '站点尚未配置邮件服务，请联系管理员', 400);
  }
}

/** 重置传输器缓存（邮件配置变更后调用） */
export function resetMailCache(): void {
  cachedTransport = null;
}

function stripHtml(html: string): string {
  return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}
