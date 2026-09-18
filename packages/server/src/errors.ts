import { ERROR_CODES, type ErrorCode } from '@readsync/shared';

/**
 * 转出错误码常量。
 *
 * errors.ts 是后端错误处理的统一入口，业务模块（crypto/keys、crypto/secret-box、
 * lib/mail 等）会同时用到 AppError 与 ERROR_CODES，从这里一并导出可以少写一行 import。
 */
export { ERROR_CODES };
export type { ErrorCode };

/**
 * 统一错误类型。
 *
 * 业务代码只抛 AppError，由 app.ts 里的错误处理器转换成统一响应信封，
 * 避免每个路由各写一套 try/catch 与状态码映射。
 */
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly statusCode: number;
  readonly details?: unknown;
  /** 是否把 message 原样返回给客户端（false 时对外只返回通用文案，避免泄漏内部信息） */
  readonly expose: boolean;

  constructor(
    code: ErrorCode,
    message: string,
    statusCode?: number,
    options?: { details?: unknown; expose?: boolean; cause?: unknown },
  ) {
    super(message, options?.cause ? { cause: options.cause } : undefined);
    this.name = 'AppError';
    this.code = code;
    this.statusCode = statusCode ?? defaultStatusFor(code);
    this.details = options?.details;
    this.expose = options?.expose ?? true;
  }
}

function defaultStatusFor(code: ErrorCode): number {
  switch (code) {
    case ERROR_CODES.BAD_REQUEST:
    case ERROR_CODES.VALIDATION_FAILED:
      return 400;
    case ERROR_CODES.UNAUTHORIZED:
      return 401;
    case ERROR_CODES.FORBIDDEN:
      return 403;
    case ERROR_CODES.NOT_FOUND:
      return 404;
    case ERROR_CODES.CONFLICT:
      return 409;
    case ERROR_CODES.PAYLOAD_TOO_LARGE:
      return 413;
    case ERROR_CODES.UNSUPPORTED_MEDIA_TYPE:
      return 415;
    case ERROR_CODES.RATE_LIMITED:
      return 429;
    case ERROR_CODES.STORAGE_ERROR:
    case ERROR_CODES.PLUGIN_ERROR:
    case ERROR_CODES.INTERNAL_ERROR:
      return 500;
    default:
      return 500;
  }
}

/* --------------------------- 常用错误的快捷构造 --------------------------- */

export const badRequest = (message: string, details?: unknown): AppError =>
  new AppError(ERROR_CODES.BAD_REQUEST, message, 400, { details });

export const validationFailed = (message: string, details?: unknown): AppError =>
  new AppError(ERROR_CODES.VALIDATION_FAILED, message, 400, { details });

export const unauthorized = (message = '未登录或登录已过期'): AppError =>
  new AppError(ERROR_CODES.UNAUTHORIZED, message, 401);

export const forbidden = (message = '没有权限执行该操作'): AppError =>
  new AppError(ERROR_CODES.FORBIDDEN, message, 403);

export const notFound = (message = '资源不存在'): AppError =>
  new AppError(ERROR_CODES.NOT_FOUND, message, 404);

export const conflict = (message: string, details?: unknown): AppError =>
  new AppError(ERROR_CODES.CONFLICT, message, 409, { details });

export const rateLimited = (message = '操作过于频繁，请稍后再试'): AppError =>
  new AppError(ERROR_CODES.RATE_LIMITED, message, 429);

export const payloadTooLarge = (message: string): AppError =>
  new AppError(ERROR_CODES.PAYLOAD_TOO_LARGE, message, 413);

export const unsupportedMediaType = (message: string): AppError =>
  new AppError(ERROR_CODES.UNSUPPORTED_MEDIA_TYPE, message, 415);

export const storageError = (message: string, cause?: unknown): AppError =>
  new AppError(ERROR_CODES.STORAGE_ERROR, message, 500, { cause, expose: true });

export const pluginError = (message: string, cause?: unknown): AppError =>
  new AppError(ERROR_CODES.PLUGIN_ERROR, message, 500, { cause });

export const internal = (message = '服务器内部错误', cause?: unknown): AppError =>
  new AppError(ERROR_CODES.INTERNAL_ERROR, message, 500, { cause, expose: false });

/** 判断是否为 AppError，用于错误处理器分支 */
export function isAppError(err: unknown): err is AppError {
  return err instanceof AppError;
}
