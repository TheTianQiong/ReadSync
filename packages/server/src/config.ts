import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { z } from 'zod';

/**
 * 运行时配置。
 *
 * 全部通过环境变量注入（见 .env.example），Docker 与 install.sh 都依赖这份定义。
 * 校验在进程启动最早期执行，配置错误立即退出并给出可读提示，避免带着坏配置跑起来。
 */

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),

  /** 监听端口 */
  READSYNC_PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  /** 监听地址；容器内需要 0.0.0.0 */
  READSYNC_HOST: z.string().default('0.0.0.0'),
  /** 对外访问地址，用于生成邮件里的重置链接、WebAuthn 的 origin 等 */
  READSYNC_BASE_URL: z.string().default('http://localhost:3000'),

  /** 数据目录：数据库、RSA 私钥、上传缓存、插件、本地存储都在这下面 */
  READSYNC_DATA_DIR: z.string().default('./data'),

  /**
   * 主密钥，用于加密存储后端凭据（WebDAV 密码、S3 SecretKey）等敏感字段。
   * 留空时首次启动自动生成并写入 {DATA_DIR}/secret.key（权限 0600）。
   * 生产环境建议显式设置，且务必与数据目录一起备份——丢失后已加密的凭据无法恢复。
   */
  READSYNC_SECRET: z.string().optional(),

  /** 日志级别 */
  READSYNC_LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  /** 开发环境下用 pino-pretty 输出彩色日志；生产环境输出 JSON 便于采集 */
  READSYNC_LOG_PRETTY: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),

  /** 反向代理场景下信任 X-Forwarded-* 头，用于拿到真实客户端 IP */
  READSYNC_TRUST_PROXY: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),

  /** 允许的跨域来源，逗号分隔；留空表示仅同源（生产推荐前端由本服务托管） */
  READSYNC_CORS_ORIGINS: z.string().default(''),

  /** access token 有效期（秒），默认 2 小时 */
  READSYNC_ACCESS_TOKEN_TTL: z.coerce.number().int().min(60).default(2 * 60 * 60),
  /** refresh token 有效期（秒），默认 30 天 */
  READSYNC_REFRESH_TOKEN_TTL: z.coerce.number().int().min(300).default(30 * 24 * 60 * 60),
  /** 「记住我」时的 refresh token 有效期（秒），默认 90 天 */
  READSYNC_REMEMBER_TTL: z.coerce.number().int().min(300).default(90 * 24 * 60 * 60),

  /** 登录失败允许次数，超过后临时锁定 */
  READSYNC_LOGIN_MAX_ATTEMPTS: z.coerce.number().int().min(1).default(10),
  /** 登录失败计数窗口（秒） */
  READSYNC_LOGIN_WINDOW: z.coerce.number().int().min(10).default(15 * 60),

  /** 是否在启动时自动执行数据库迁移 */
  READSYNC_AUTO_MIGRATE: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),

  /** 是否托管前端静态文件（由本服务同时提供 Web 界面） */
  READSYNC_SERVE_WEB: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),

  /** 插件目录，默认 {DATA_DIR}/plugins */
  READSYNC_PLUGIN_DIR: z.string().optional(),
});

export type RawEnv = z.infer<typeof envSchema>;

export interface AppConfig extends Omit<RawEnv, 'READSYNC_CORS_ORIGINS' | 'READSYNC_PLUGIN_DIR'> {
  /** 解析后的绝对路径 */
  dataDir: string;
  databaseFile: string;
  /** 主密钥（可能是自动生成的） */
  secret: string;
  /** 主密钥是否为本次启动自动生成 */
  secretGenerated: boolean;
  /** 插件目录绝对路径 */
  pluginDir: string;
  /** 上传缓存目录（文件中转用） */
  tmpDir: string;
  /** 本地存储根目录 */
  localStorageDir: string;
  /** RSA 私钥文件路径 */
  privateKeyFile: string;
  /** RSA 公钥文件路径 */
  publicKeyFile: string;
  /** 前端构建产物目录 */
  webDistDir: string;
  corsOrigins: string[];
}

/** 配置错误：启动阶段抛出，由入口打印友好提示后退出 */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

/** 确保目录存在，并尽量收紧权限（Windows 上 chmod 语义有限，忽略失败） */
function ensureDir(dir: string): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
}

/**
 * 读取或生成主密钥。
 * 优先用环境变量，其次读文件，最后随机生成并持久化，保证重启后仍能解密既有凭据。
 */
function resolveSecret(dataDir: string, fromEnv: string | undefined): { secret: string; generated: boolean } {
  if (fromEnv && fromEnv.length >= 16) {
    return { secret: fromEnv, generated: false };
  }

  const secretFile = path.join(dataDir, 'secret.key');
  if (existsSync(secretFile)) {
    const existing = readFileSync(secretFile, 'utf8').trim();
    if (existing.length >= 16) {
      return { secret: existing, generated: false };
    }
  }

  const generated = randomBytes(48).toString('base64url');
  writeFileSync(secretFile, generated, { mode: 0o600 });
  return { secret: generated, generated: true };
}

let cached: AppConfig | null = null;

/** 加载并校验配置；同一进程内只解析一次 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  if (cached) return cached;

  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new ConfigError(`环境变量配置有误：\n${details}`);
  }

  const raw = parsed.data;
  const dataDir = path.resolve(raw.READSYNC_DATA_DIR);

  ensureDir(dataDir);
  const tmpDir = path.join(dataDir, 'tmp');
  const localStorageDir = path.join(dataDir, 'storage');
  const pluginDir = path.resolve(raw.READSYNC_PLUGIN_DIR ?? path.join(dataDir, 'plugins'));
  ensureDir(tmpDir);
  ensureDir(localStorageDir);
  ensureDir(pluginDir);

  const { secret, generated } = resolveSecret(dataDir, raw.READSYNC_SECRET);

  cached = {
    ...raw,
    dataDir,
    databaseFile: path.join(dataDir, 'readsync.db'),
    secret,
    secretGenerated: generated,
    pluginDir,
    tmpDir,
    localStorageDir,
    privateKeyFile: path.join(dataDir, 'keys', 'private.pem'),
    publicKeyFile: path.join(dataDir, 'keys', 'public.pem'),
    // 前端产物：monorepo 内为 packages/web/dist，容器镜像里为 /app/web
    webDistDir: path.resolve(process.env.READSYNC_WEB_DIST ?? path.join(process.cwd(), 'packages', 'web', 'dist')),
    corsOrigins: raw.READSYNC_CORS_ORIGINS.split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  };

  return cached;
}

/** 测试用：清空缓存以便用不同 env 重新加载 */
export function resetConfigCache(): void {
  cached = null;
}

export const isProduction = (): boolean => loadConfig().NODE_ENV === 'production';
export const isDevelopment = (): boolean => loadConfig().NODE_ENV === 'development';
