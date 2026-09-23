import { eq } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  kosyncCreateUserSchema,
  kosyncProgressUpdateSchema,
  type KosyncProgressResponse,
} from '@readsync/shared';
import { hashPassword, safeEqualHex } from '../../crypto/password.js';
import { getDb } from '../../db/index.js';
import { users, type UserRow } from '../../db/schema.js';
import { auditContextFrom, recordAudit } from '../../lib/audit.js';
import { getSiteSettings } from '../../lib/settings.js';
import { getModuleLogger } from '../../logger.js';
import { getProgress, upsertProgress } from './service.js';

/**
 * KOSync 兼容协议（KOReader 原生）。
 *
 * 端点挂在根路径（没有 /api 前缀），并且**响应格式必须与上游一致**：
 *  - 成功：纯文本 `OK`、裸 JSON 对象、未找到时返回空对象 `{}`；
 *  - 失败：带 message 字段的 JSON，形如 `{"message":"..."}`。
 *
 * 这里不用 ApiResponse 信封，也不能抛 AppError —— 全局错误处理器会把任何
 * 异常转成 `{ ok:false, error:{...} }`，KOReader 读不到 message，只会显示
 * 「未知服务器错误」。因此所有失败路径都在本文件内直接 reply 上述格式。
 *
 * 协议本身的限制（客户端固定，服务端改不了）：
 *  - 认证只有 `x-auth-user` + `x-auth-key`，key 是密码的 MD5，不支持 JWT/OAuth；
 *  - 没有阅读时长字段，所以 KOSync 写入的条目 readingSeconds 恒为 0。
 */

const log = getModuleLogger('sync');

const KOSYNC_PLATFORM = 'koreader';

/**
 * KOSync 的失败响应。
 *
 * 必须返回带 `message` 字段的 JSON，而不是纯文本：
 * KOReader 客户端的代码是
 *     text = body and body.message or _("Unknown server error")
 * 若拿不到 message，界面上只会显示「未知服务器错误」—— 用户完全无从判断
 * 是密码错了、账号被禁用，还是服务端出了问题。
 * 官方 sync.koreader.rocks 同样返回 {"message": "..."}。
 *
 * 成功路径不受影响：`/users/auth` 仍返回纯文本 `OK`（这是协议规定）。
 */
function kosyncError(reply: FastifyReply, status: number, message: string): FastifyReply {
  return reply.status(status).type('application/json; charset=utf-8').send({ message });
}

export async function registerKosyncRoutes(app: FastifyInstance): Promise<void> {
  /**
   * 校验 KOSync 头。
   *
   * 恒定时间比较（safeEqualHex）是必须的：x-auth-key 是 32 位十六进制，
   * 普通字符串比较会在首个不同字符处提前返回，攻击者可以据此逐字节爆破。
   */
  app.get('/users/auth', async (req, reply) => {
    const user = authenticateKosync(req);
    if (!user) {
      return kosyncError(reply, 401, '用户名或同步密码不正确（KOSync 使用独立同步密码，可在「设置 → 账号安全」中查看或重置）');
    }
    return reply.status(200).type('text/plain').send('OK');
  });

  /**
   * KOReader 首次注册。
   *
   * body 里的 password 已经是密码的 MD5，服务端拿不到明文，因此：
   *  - kosyncKey 直接落这个 MD5（绝不能再 md5 一次，否则客户端认证永远失败）；
   *  - passwordHash 用「该 MD5 串」当作明文去 Argon2，只为满足非空约束，
   *    这导致此类账号无法用网页端密码登录（除非之后在设置页重设密码）。
   *    这是协议限制下的取舍，已在 docs/sync-api.md 说明。
   */
  app.post('/users/create', async (req, reply) => {
    const settings = getSiteSettings();
    if (!settings.registrationEnabled) {
      // 站点关闭注册时拒绝，但为了兼容 KOReader 的错误提示不做成 5xx
      return kosyncError(reply, 403, '本站已关闭注册，请联系管理员开通账号');
    }

    const parsed = kosyncCreateUserSchema.safeParse(req.body);
    if (!parsed.success) {
      return kosyncError(reply, 400, '请求格式不正确（需要 username 与 password 字段）');
    }

    const db = getDb();
    const existing = db.select({ id: users.id }).from(users).where(eq(users.username, parsed.data.username)).get();
    if (existing) {
      // 上游约定：用户名已存在返回 402
      return kosyncError(reply, 402, '该用户名已被占用');
    }

    const kosyncKey = parsed.data.password.toLowerCase();

    try {
      db.insert(users)
        .values({
          username: parsed.data.username,
          // KOSync 协议不提供邮箱，用保留域合成一个占位地址满足唯一非空约束
          email: `${parsed.data.username}@kosync.local`,
          passwordHash: await hashPassword(kosyncKey),
          kosyncKey,
          role: 'user',
          status: 'active',
          preferences: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        })
        .run();
    } catch (err) {
      // 唯一索引冲突（并发注册）同样按「已存在」处理
      log.warn({ err, username: parsed.data.username }, 'KOSync 注册失败');
      return kosyncError(reply, 402, '该用户名已被占用');
    }

    recordAudit('user.register', auditContextFrom(req), {
      target: parsed.data.username,
      meta: { protocol: 'kosync' },
    });

    return reply.status(201).type('text/plain').send('OK');
  });

  /** 上报进度。响应是裸 JSON，timestamp 为 Unix 秒 */
  app.put('/syncs/progress', async (req, reply) => {
    const user = authenticateKosync(req);
    if (!user) {
      return kosyncError(reply, 401, '用户名或同步密码不正确（KOSync 使用独立同步密码，可在「设置 → 账号安全」中查看或重置）');
    }

    const parsed = kosyncProgressUpdateSchema.safeParse(req.body);
    if (!parsed.success) {
      return kosyncError(reply, 400, '进度数据格式不正确（需要 document、progress、percentage 等字段）');
    }

    const input = parsed.data;
    const result = upsertProgress(
      user.id,
      {
        document: input.document,
        progress: input.progress,
        percentage: input.percentage,
        platform: KOSYNC_PLATFORM,
        device: input.device,
        deviceId: input.device_id,
        // KOSync 协议没有这两个字段：不上报阅读时长，冲突判定按服务端接收时间
        readingSeconds: 0,
        clientTime: undefined,
      },
      'latest-wins',
    );

    recordAudit('sync.push', auditContextFrom(req, user), {
      target: input.document,
      meta: {
        protocol: 'kosync',
        accepted: result.accepted,
        device: input.device,
      },
    });

    return reply.status(200).send({
      document: result.current.document,
      timestamp: unixSeconds(result.current.updatedAt),
    });
  });

  /**
   * 拉取进度。
   * 未找到时返回 200 + `{}`（而不是 404）：KOReader 把 404 当成网络/服务异常，
   * 会不断重试并提示同步失败，只有空对象才被它理解为「这本书服务端还没有记录」。
   */
  app.get<{ Params: { document: string } }>('/syncs/progress/:document', async (req, reply) => {
    const user = authenticateKosync(req);
    if (!user) {
      return kosyncError(reply, 401, '用户名或同步密码不正确（KOSync 使用独立同步密码，可在「设置 → 账号安全」中查看或重置）');
    }

    const entry = getProgress(user.id, req.params.document);
    if (!entry) {
      return reply.status(200).send({});
    }

    const body: KosyncProgressResponse = {
      document: entry.document,
      progress: entry.progress,
      // KOSync 语义是 0-1 的小数（不是 0-100），service 已还原
      percentage: entry.percentage,
      device: entry.device,
      device_id: entry.deviceId,
      timestamp: unixSeconds(entry.updatedAt),
    };
    return reply.status(200).send(body);
  });

  /** 部分客户端（含某些反向代理后的 WebView）会先发 OPTIONS 预检 */
  app.options('/syncs/progress', async (_req, reply) => {
    reply.header('Allow', 'GET, PUT, OPTIONS');
    return reply.status(204).send();
  });
}

/**
 * 从 x-auth-user / x-auth-key 头校验用户，失败返回 null。
 *
 * 只支持这一种认证方式：KOSync 协议里没有 Authorization 头的位置，
 * 也没有令牌刷新机制，JWT 在此无从谈起。
 */
export function authenticateKosync(req: FastifyRequest): UserRow | null {
  const username = headerValue(req.headers['x-auth-user']);
  const key = headerValue(req.headers['x-auth-key']);
  if (!username || !key) return null;

  const db = getDb();
  const user = db.select().from(users).where(eq(users.username, username)).get();
  if (!user || user.status !== 'active') return null;
  if (!user.kosyncKey) return null;

  // 大小写统一后再比较：safeEqualHex 按 hex 解析，大写 MD5 也能正确比较，
  // 但长度判断要求一致，先归一化成小写更稳妥
  if (!safeEqualHex(user.kosyncKey.toLowerCase(), key.toLowerCase())) return null;

  return user;
}

/** Fastify 的头可能是 string | string[]，统一取第一个值 */
function headerValue(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] ?? '';
  return value ?? '';
}

/** 协议对外的 timestamp 一律是 Unix 秒 */
function unixSeconds(iso: string): number {
  return Math.floor(new Date(iso).getTime() / 1000);
}
