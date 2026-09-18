import type { FastifyRequest } from 'fastify';
import type { AuditAction } from '@readsync/shared';
import { getDb } from '../db/index.js';
import { auditLogs } from '../db/schema.js';
import { getModuleLogger } from '../logger.js';

/**
 * 审计日志。
 *
 * 写库失败不应影响主流程（审计是旁路），因此这里吞掉异常只记 warn。
 */

export interface AuditContext {
  userId?: number | null;
  username?: string | null;
  ip?: string | null;
  userAgent?: string | null;
}

/** 从请求中提取审计上下文 */
export function auditContextFrom(req: FastifyRequest, user?: { id: number; username: string } | null): AuditContext {
  return {
    userId: user?.id ?? (req.currentUser?.id ?? null),
    username: user?.username ?? (req.currentUser?.username ?? null),
    ip: req.ip ?? null,
    userAgent: typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'].slice(0, 512) : null,
  };
}

/** 记录一条审计日志 */
export function recordAudit(
  action: AuditAction | string,
  ctx: AuditContext,
  options?: { target?: string | null; meta?: Record<string, unknown> | null; success?: boolean },
): void {
  try {
    getDb()
      .insert(auditLogs)
      .values({
        userId: ctx.userId ?? null,
        username: ctx.username ?? null,
        action,
        target: options?.target ?? null,
        ip: ctx.ip ?? null,
        userAgent: ctx.userAgent ?? null,
        meta: options?.meta ?? null,
        success: options?.success ?? true,
        createdAt: new Date(),
      })
      .run();
  } catch (err) {
    getModuleLogger('audit').warn({ err, action }, '写入审计日志失败');
  }
}
