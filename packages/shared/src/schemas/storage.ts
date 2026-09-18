import { z } from 'zod';
import { S3_ADDRESSING_STYLES, STORAGE_DRIVERS } from '../constants.js';

/**
 * 存储配置。
 *
 * 一个用户可以配置多个存储后端，其中一个标记为默认（isDefault）。
 * 敏感字段（密码、密钥）落库前用服务器本地密钥加密，接口返回时一律脱敏。
 */

/** WebDAV 连接参数 */
export const webdavConfigSchema = z.object({
  /** 例如 https://dav.jianguoyun.com/dav/ */
  url: z.url('WebDAV 地址格式不正确'),
  username: z.string().min(1, '请填写用户名'),
  password: z.string().min(1, '请填写密码或应用授权码'),
  /** 远端根目录，留空表示账号根目录 */
  basePath: z.string().trim().default('/'),
  /** 是否允许自签名证书（自建 Nextcloud 常见） */
  allowSelfSigned: z.boolean().default(false),
});

/** S3 兼容对象存储连接参数 */
export const s3ConfigSchema = z.object({
  endpoint: z.url('Endpoint 格式不正确'),
  region: z.string().trim().default('us-east-1'),
  bucket: z.string().min(1, '请填写 Bucket 名称'),
  accessKeyId: z.string().min(1, '请填写 Access Key'),
  secretAccessKey: z.string().min(1, '请填写 Secret Key'),
  /** 对象键前缀 */
  prefix: z.string().trim().default(''),
  /** 阿里云 OSS / MinIO 通常需要 path 风格 */
  forcePathStyle: z.boolean().default(true),
  addressingStyle: z.enum(S3_ADDRESSING_STYLES).default('path'),
});

/** 本地存储参数 */
export const localStorageConfigSchema = z.object({
  /** 相对于服务器数据目录的路径，禁止绝对路径与 .. 穿越 */
  path: z
    .string()
    .trim()
    .min(1)
    .default('storage')
    .refine((v) => !v.startsWith('/') && !v.includes('..'), '路径必须是数据目录下的相对路径'),
  /** 本地存储容量配额（字节），0 表示不限制 */
  quotaBytes: z.coerce.number().int().min(0).default(0),
});

/** 插件提供的存储驱动参数（由插件自定义 schema 校验） */
export const pluginStorageConfigSchema = z.object({
  pluginId: z.string().min(1),
  driverId: z.string().min(1),
  options: z.record(z.string(), z.unknown()).default({}),
});

/** 创建/更新存储配置 */
export const storageInputSchema = z
  .discriminatedUnion('driver', [
    z.object({ driver: z.literal('local'), config: localStorageConfigSchema }),
    z.object({ driver: z.literal('webdav'), config: webdavConfigSchema }),
    z.object({ driver: z.literal('s3'), config: s3ConfigSchema }),
    z.object({ driver: z.literal('plugin'), config: pluginStorageConfigSchema }),
  ])
  .and(
    z.object({
      name: z.string().trim().min(1, '请填写名称').max(64),
      isDefault: z.boolean().default(false),
      /** 是否仅作为书籍文件存储（否则也用于同步数据） */
      readOnly: z.boolean().default(false),
    }),
  );

export type StorageInput = z.infer<typeof storageInputSchema>;

/** 更新存储配置（所有字段可选） */
export const storageUpdateSchema = z.object({
  name: z.string().trim().min(1).max(64).optional(),
  config: z.record(z.string(), z.unknown()).optional(),
  isDefault: z.boolean().optional(),
  readOnly: z.boolean().optional(),
  enabled: z.boolean().optional(),
});

/** 存储配置的对外表示（敏感字段已脱敏） */
export interface StorageSummary {
  id: number;
  name: string;
  driver: (typeof STORAGE_DRIVERS)[number];
  isDefault: boolean;
  readOnly: boolean;
  enabled: boolean;
  /** 脱敏后的配置，例如 { url: 'https://...', username: 'ab***cd', password: '******' } */
  config: Record<string, unknown>;
  /** 最近一次连通性测试结果 */
  lastCheckAt: string | null;
  lastCheckOk: boolean | null;
  lastCheckMessage: string | null;
  /** 已用容量（字节），未知时为 null */
  usedBytes: number | null;
  createdAt: string;
  updatedAt: string;
}

/** 连通性测试结果 */
export interface StorageTestResult {
  ok: boolean;
  message: string;
  /** 往返延迟（毫秒） */
  latencyMs?: number;
}

/** 需要脱敏的字段名（值统一替换为 ******，仅保留首尾字符以便用户确认没填错） */
export const SENSITIVE_CONFIG_KEYS = [
  'password',
  'secretAccessKey',
  'accessKeyId',
  'token',
  'apiKey',
  'privateKey',
] as const;
