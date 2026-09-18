import { z } from 'zod';
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from '../constants.js';

/**
 * 统一响应信封。
 *
 * 所有 REST 接口（除 KOSync 兼容端点外，见 docs/sync-api.md）都返回该结构，
 * 便于前端与 CLI 用同一套逻辑处理错误。
 */
export interface ApiSuccess<T> {
  ok: true;
  data: T;
}

export interface ApiErrorBody {
  code: string;
  message: string;
  /** 字段级校验错误等附加信息 */
  details?: unknown;
}

export interface ApiFailure {
  ok: false;
  error: ApiErrorBody;
}

export type ApiResponse<T> = ApiSuccess<T> | ApiFailure;

/** 错误码常量，前端据此做国际化或特定跳转（如 UNAUTHORIZED 跳到登录页） */
export const ERROR_CODES = {
  BAD_REQUEST: 'BAD_REQUEST',
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  UNAUTHORIZED: 'UNAUTHORIZED',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',
  RATE_LIMITED: 'RATE_LIMITED',
  PAYLOAD_TOO_LARGE: 'PAYLOAD_TOO_LARGE',
  UNSUPPORTED_MEDIA_TYPE: 'UNSUPPORTED_MEDIA_TYPE',
  STORAGE_ERROR: 'STORAGE_ERROR',
  PLUGIN_ERROR: 'PLUGIN_ERROR',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
} as const;
export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

/** 分页查询参数 */
export const paginationQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
});
export type PaginationQuery = z.infer<typeof paginationQuerySchema>;

/** 分页结果 */
export interface Paginated<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

/** 排序方向 */
export const sortOrderSchema = z.enum(['asc', 'desc']).default('desc');
export type SortOrder = z.infer<typeof sortOrderSchema>;

/** 通用 ID 参数（自增整数主键序列化为字符串以防 JS 精度问题） */
export const idParamSchema = z.object({
  id: z.coerce.number().int().positive(),
});

/** RFC3339 时间字符串 */
export const timestampSchema = z.iso.datetime();

/** 十六进制 MD5 摘要 */
export const md5Schema = z
  .string()
  .regex(/^[a-f0-9]{32}$/i, '必须是 32 位十六进制 MD5 摘要');

/** 十六进制 SHA-256 摘要 */
export const sha256Schema = z
  .string()
  .regex(/^[a-f0-9]{64}$/i, '必须是 64 位十六进制 SHA-256 摘要');
