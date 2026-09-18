import { z } from 'zod';
import { SYNC_PROTOCOLS } from '../constants.js';
import { MAX_DOCUMENT_ID_LENGTH, MAX_SYNC_PROGRESS_LENGTH } from '../constants.js';

/**
 * 同步协议相关类型。
 *
 * 包含两部分：
 *  1. KOSync 兼容协议（KOReader 原生）—— 字段名与状态码必须与上游一致，
 *     不能套用本项目的 ApiResponse 信封，详见 docs/sync-api.md。
 *  2. ReadSync 统一同步接口 —— 本项目自定义，供其他阅读软件开发者接入。
 */

/* ------------------------------------------------------------------ *
 * 一、KOSync 兼容协议
 * ------------------------------------------------------------------ */

/**
 * KOReader 客户端用 password 的 MD5 作为 x-auth-key 发送。
 *
 * 安全说明：由于协议由客户端固定，服务端无法要求它做 RSA 加密或 Argon2。
 * 因此服务端为每个用户单独保存一个「KOSync 专用密钥」（见 users.kosync_key），
 * 默认在注册/改密时由明文密码派生，也允许用户在设置页单独设置一个
 * 与主密码不同的同步密码，避免主密码的 MD5 被用于撞库。详见 docs/security.md。
 */
export interface KosyncAuthHeaders {
  'x-auth-user': string;
  'x-auth-key': string;
}

/** PUT /syncs/progress 请求体 */
export const kosyncProgressUpdateSchema = z.object({
  /** KOReader 生成的文档标识，通常是文件路径或部分 MD5 */
  document: z.string().min(1).max(MAX_DOCUMENT_ID_LENGTH),
  /** 阅读位置字符串，格式由客户端决定（xpointer / CFI / 页码等） */
  progress: z.string().min(1).max(MAX_SYNC_PROGRESS_LENGTH),
  /** 阅读进度百分比，0-1 之间的小数（KOReader 语义，非 0-100） */
  percentage: z.coerce.number().min(0).max(1),
  /** 设备名，用于在冲突时区分 */
  device: z.string().max(128).default('unknown'),
  /** 设备唯一标识 */
  device_id: z.string().max(128).default('unknown'),
});
export type KosyncProgressUpdate = z.infer<typeof kosyncProgressUpdateSchema>;

/** GET /syncs/progress/{document} 响应体 */
export interface KosyncProgressResponse {
  document: string;
  progress: string;
  percentage: number;
  device: string;
  device_id: string;
  /** Unix 时间戳（秒），KOSync 上游用的就是这个格式 */
  timestamp: number;
}

/** POST /users/create 请求体（KOReader 首次注册） */
export const kosyncCreateUserSchema = z.object({
  username: z.string().min(3).max(32),
  /** 注意：这里是密码的 MD5 十六进制串，不是明文 */
  password: z.string().regex(/^[a-f0-9]{32}$/i, 'password 必须是密码的 MD5'),
});

/** POST /users/auth 请求体，与 create 相同 */
export const kosyncAuthSchema = kosyncCreateUserSchema;

/* ------------------------------------------------------------------ *
 * 二、ReadSync 统一同步接口
 * ------------------------------------------------------------------ */

/**
 * 同步条目：一个「用户 + 书籍/文档」的阅读进度快照。
 * 比 KOSync 多出 platform 与 readingSeconds 字段，便于统计阅读时长。
 */
export const syncEntryInputSchema = z.object({
  /** 文档标识，由客户端生成；同一本书在不同设备上必须一致 */
  document: z.string().min(1).max(MAX_DOCUMENT_ID_LENGTH),
  /** 书名，便于服务端首次见到该文档时自动建档 */
  title: z.string().max(256).optional(),
  /** 阅读位置，格式由客户端自定义 */
  progress: z.string().min(1).max(MAX_SYNC_PROGRESS_LENGTH),
  /** 进度百分比，0-1 */
  percentage: z.coerce.number().min(0).max(1),
  /** 平台标识，见 BUILTIN_PLATFORMS，也可自定义 */
  platform: z.string().max(64).default('other'),
  device: z.string().max(128).default('unknown'),
  deviceId: z.string().max(128).default('unknown'),
  /** 本次上报新增的阅读秒数，服务端累加到统计 */
  readingSeconds: z.coerce.number().int().min(0).max(86400).default(0),
  /** 客户端本地时间（RFC3339），用于离线补传 */
  clientTime: z.iso.datetime().optional(),
});
export type SyncEntryInput = z.infer<typeof syncEntryInputSchema>;

/** 同步条目 */
export interface SyncEntry {
  id: number;
  userId: number;
  document: string;
  title: string | null;
  progress: string;
  percentage: number;
  platform: string;
  device: string;
  deviceId: string;
  /** 服务端接收时间（RFC3339） */
  updatedAt: string;
  /** 客户端上报时间 */
  clientTime: string | null;
}

/** 推送结果 */
export interface SyncPushResult {
  /** 服务端是否接受了本次写入；false 表示服务端已有更新的进度 */
  accepted: boolean;
  /** 服务端当前最新条目，冲突时客户端据此决定是否覆盖 */
  current: SyncEntry | null;
}

/** 拉取结果 */
export interface SyncPullResult {
  entry: SyncEntry | null;
}

/** 批量同步（离线补传场景） */
export const syncBatchInputSchema = z.object({
  entries: z.array(syncEntryInputSchema).min(1).max(200),
});
export type SyncBatchInput = z.infer<typeof syncBatchInputSchema>;

export interface SyncBatchResult {
  accepted: number;
  rejected: number;
  results: Array<{ document: string; accepted: boolean; current: SyncEntry | null }>;
}

/** 同步冲突解决策略 */
export const SYNC_CONFLICT_STRATEGIES = ['latest-wins', 'client-wins', 'server-wins'] as const;
export type SyncConflictStrategy = (typeof SYNC_CONFLICT_STRATEGIES)[number];

/** 用户侧同步配置（设置页「同步链接/同步账号」） */
export interface SyncProfile {
  id: number;
  name: string;
  protocol: (typeof SYNC_PROTOCOLS)[number];
  /** 是否启用 */
  enabled: boolean;
  /** 冲突策略 */
  conflictStrategy: SyncConflictStrategy;
  /** 允许通过该配置同步的文档范围，空数组表示全部 */
  documentFilter: string[];
  lastSyncAt: string | null;
  createdAt: string;
}

/** 同步凭据（供第三方阅读器接入统一接口使用） */
export interface SyncToken {
  id: number;
  name: string;
  /** 仅在创建时返回一次明文，之后只存哈希 */
  token?: string;
  /** 形如 rs_xxxx 的前缀，用于列表展示 */
  tokenPrefix: string;
  scopes: string[];
  lastUsedAt: string | null;
  expiresAt: string | null;
  createdAt: string;
}
