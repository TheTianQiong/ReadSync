import { z } from 'zod';
import { BOOK_FORMATS, READING_STATUSES } from '../constants.js';
import { md5Schema, paginationQuerySchema } from './common.js';

/**
 * 个人书库。
 *
 * README 前端要求 7：本地存储有限，书库文件通常放在 WebDAV / 对象存储上，
 * 本地仅保存 MD5、书籍信息、版本记录，并承担书籍文件中转。
 * 因此 Book 记录里的 storageId 指向实际的存储后端，服务器不保证本地有副本。
 */

export const bookFormatSchema = z.enum(BOOK_FORMATS);
export const readingStatusSchema = z.enum(READING_STATUSES);

/** 新增书籍（元数据 + 已上传的文件引用） */
export const createBookSchema = z.object({
  title: z.string().trim().min(1, '请填写书名').max(256),
  author: z.string().trim().max(128).optional(),
  /** 出版社 */
  publisher: z.string().trim().max(128).optional(),
  /** ISBN，用于元数据补全 */
  isbn: z.string().trim().max(32).optional(),
  format: bookFormatSchema.default('epub'),
  /** 文件字节数 */
  size: z.coerce.number().int().min(0),
  /** 文件 MD5，用于秒传与去重 */
  md5: md5Schema,
  /** 存放该文件的存储后端 ID；不传则用默认存储 */
  storageId: z.coerce.number().int().positive().optional(),
  /** 存储上的对象键 */
  objectKey: z.string().min(1),
  /** 封面图 URL 或 data URI */
  coverUrl: z.string().max(2048).optional(),
  /** 简介 */
  description: z.string().max(4096).optional(),
  /** 标签 */
  tags: z.array(z.string().trim().max(32)).max(20).default([]),
  language: z.string().trim().max(16).optional(),
  /** 总页数/总字数，用于阅读进度百分比换算 */
  totalPages: z.coerce.number().int().min(0).optional(),
  totalWords: z.coerce.number().int().min(0).optional(),
});
export type CreateBookInput = z.infer<typeof createBookSchema>;

/** 更新书籍元数据 */
export const updateBookSchema = z.object({
  title: z.string().trim().min(1).max(256).optional(),
  author: z.string().trim().max(128).optional(),
  publisher: z.string().trim().max(128).optional(),
  isbn: z.string().trim().max(32).optional(),
  coverUrl: z.string().max(2048).optional(),
  description: z.string().max(4096).optional(),
  tags: z.array(z.string().trim().max(32)).max(20).optional(),
  language: z.string().trim().max(16).optional(),
  readingStatus: readingStatusSchema.optional(),
  /** 手动校正阅读进度（0-100） */
  progressPercent: z.coerce.number().min(0).max(100).optional(),
  totalPages: z.coerce.number().int().min(0).optional(),
  totalWords: z.coerce.number().int().min(0).optional(),
});

/** 书库查询 */
export const listBooksQuerySchema = paginationQuerySchema.extend({
  /** 按书名/作者模糊搜索 */
  q: z.string().trim().max(128).optional(),
  format: bookFormatSchema.optional(),
  readingStatus: readingStatusSchema.optional(),
  tag: z.string().trim().max(32).optional(),
  sortBy: z.enum(['title', 'author', 'size', 'createdAt', 'updatedAt', 'lastReadAt']).default('createdAt'),
  sortOrder: z.enum(['asc', 'desc']).default('desc'),
});
export type ListBooksQuery = z.infer<typeof listBooksQuerySchema>;

/** 书籍文件的一个版本 */
export interface BookVersion {
  id: number;
  bookId: number;
  /** 版本号，从 1 递增 */
  version: number;
  size: number;
  md5: string;
  objectKey: string;
  storageId: number;
  /** 该版本的备注，例如「修正排版」「替换封面」 */
  note: string | null;
  /** 上传者用户 ID */
  uploadedBy: number;
  createdAt: string;
}

/** 书籍的对外表示 */
export interface BookSummary {
  id: number;
  ownerId: number;
  title: string;
  author: string | null;
  publisher: string | null;
  isbn: string | null;
  format: (typeof BOOK_FORMATS)[number];
  size: number;
  md5: string;
  coverUrl: string | null;
  description: string | null;
  tags: string[];
  language: string | null;
  readingStatus: (typeof READING_STATUSES)[number];
  progressPercent: number;
  totalPages: number | null;
  totalWords: number | null;
  /** 当前版本号 */
  currentVersion: number;
  storageId: number;
  storageName: string | null;
  /** 该书累计阅读时长（秒） */
  totalReadingSeconds: number;
  lastReadAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** 书籍详情，附带版本历史 */
export interface BookDetail extends BookSummary {
  versions: BookVersion[];
}

/** 上传前的秒传/去重检查 */
export const checkBookExistsSchema = z.object({
  md5: md5Schema,
});
export type CheckBookExistsInput = z.infer<typeof checkBookExistsSchema>;

/* ------------------------------ 分片上传 ------------------------------ */

/**
 * 分片大小的取值区间与默认值。
 *
 * 放在 shared 是因为**前后端都得知道**：服务端用它夹取配置与客户端请求，
 * 客户端用它在「片太大导致超时」时逐级减半重试，且必须和服务端停在同一个
 * 下界 —— 否则客户端会一直尝试一个服务端根本不接受的更小值。
 *
 * 默认 4 MiB：正常宽带上单片几百毫秒完成，请求数也不至于太多。
 * 下界 256 KiB：即使上行只有 20 KB/s，一片也能在 13 秒内传完，
 * 仍在 Cloudflare 那类 100 秒超时之内（实测过 524 的链路需要降到这一档）。
 */
export const UPLOAD_CHUNK_SIZE_DEFAULT = 4 * 1024 * 1024;
export const UPLOAD_CHUNK_SIZE_MIN = 256 * 1024;
export const UPLOAD_CHUNK_SIZE_MAX = 64 * 1024 * 1024;

/** 把任意输入夹到合法区间；非法值回落到默认值 */
export function clampChunkSize(value: unknown): number {
  const n = typeof value === 'string' ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) return UPLOAD_CHUNK_SIZE_DEFAULT;
  return Math.min(Math.max(Math.floor(n), UPLOAD_CHUNK_SIZE_MIN), UPLOAD_CHUNK_SIZE_MAX);
}

/**
 * 分片上传（用于绕过反向代理的请求体大小与超时限制）。
 *
 * 流程：init 建会话 → 逐片 PUT parts/:index → complete 合并入库。
 * 分片走的是原始二进制（application/octet-stream），不是 multipart ——
 * 每片再包一层 multipart 只会白白增加开销。
 */
export const chunkedUploadInitSchema = z.object({
  /** 原始文件名，用于取扩展名做白名单校验与命名 */
  filename: z.string().trim().min(1).max(256),
  /** 文件总字节数；服务端据此算分片数并校验合并结果 */
  size: z.coerce.number().int().nonnegative(),
  /** 客户端算好的 MD5；给了就校验，不给则服务端自己算 */
  md5: z
    .string()
    .trim()
    .regex(/^[a-fA-F0-9]{32}$/, 'MD5 必须是 32 位十六进制串')
    .optional(),
  /** 登记新书时为 create，给已有书籍传新版本时为 version */
  mode: z.enum(['create', 'version']).default('create'),
  /** mode 为 version 时必填 */
  bookId: z.coerce.number().int().positive().optional(),
  /**
   * 期望的分片大小；省略则用服务端默认值。
   *
   * 客户端在「片太大、请求超时」时会逐级减半并重新建会话，
   * 因此这个字段是自适应重试的落点。服务端仍会按区间夹取。
   */
  chunkSize: z.coerce.number().int().positive().optional(),
  /**
   * 表单字段（title/author/format/storageId/note 等）。
   * 单独传是因为这些字段原先搭 multipart 的便车，分片上传没有 multipart 可搭。
   */
  fields: z.record(z.string(), z.string()).default({}),
});

export type ChunkedUploadInitInput = z.infer<typeof chunkedUploadInitSchema>;

/** 服务端保存的会话状态；前端不消费，仅用于服务端内部与调试 */
export interface ChunkedUploadSession {
  uploadId: string;
  mode: 'create' | 'version';
  bookId?: number;
  filename: string;
  size: number;
  md5?: string;
  fields: Record<string, string | undefined>;
  userId: number;
  chunkSize: number;
  totalChunks: number;
  createdAt: string;
}

/** init 的响应：告知客户端按多大切片、切几片 */
export interface ChunkedUploadInitResult {
  uploadId: string;
  chunkSize: number;
  totalChunks: number;
}

/** 单片上传结果，便于客户端确认进度 */
export interface ChunkedUploadPartResult {
  received: number;
  total: number;
}

export interface CheckBookExistsResult {
  /** 该 MD5 是否已存在于当前用户书库 */
  exists: boolean;
  book: BookSummary | null;
}

/** 上传限制，由管理员在后台配置（README 设置管理后台要求） */
export interface UploadLimits {
  /** 单文件最大字节数 */
  maxFileSize: number;
  /** 允许的文件扩展名白名单（小写，不含点） */
  allowedExtensions: string[];
  /** 是否允许用户自行修改 */
  allowUserOverride: boolean;
}

/** 允许的书籍文件扩展名默认值，覆盖 README 提到的 zip/json 等 */
export const DEFAULT_ALLOWED_EXTENSIONS = [
  'epub',
  'pdf',
  'mobi',
  'azw3',
  'azw',
  'fb2',
  'txt',
  'cbz',
  'cbr',
  'djvu',
  'zip',
  'json',
] as const;

/** 默认单文件上传上限：200MB */
export const DEFAULT_MAX_FILE_SIZE = 200 * 1024 * 1024;
