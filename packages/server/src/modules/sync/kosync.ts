import { eq, or, sql } from 'drizzle-orm';
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
import { findUserByLoginLoose } from '../../lib/users.js';
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
   * 健康检查 —— 客户端用它判断「这个地址是不是 KOReader 同步服务器」。
   *
   * 官方 koreader-sync-server 暴露了 `GET /healthcheck`，其自带的探活脚本正是
   * 靠它判定的：
   *     curl -H "Accept: application/vnd.koreader.v1+json" .../healthcheck \
   *       | grep -q '"state":"OK"'
   *
   * 部分第三方客户端（如 Reeden）在填写自定义同步地址时也做同样的探测，
   * 探测失败就报「该地址不是 KOReader 同步服务器，请检查服务器地址」——
   * 与账号密码无关。缺这个端点会让人完全摸不着头脑。
   *
   * 无需认证：它只回答「服务在不在」。
   */
  app.get('/healthcheck', async (_req, reply) => {
    return reply.status(200).send({ state: 'OK' });
  });

  /**
   * 校验 KOSync 头。
   *
   * 恒定时间比较（safeEqualHex）是必须的：x-auth-key 是 32 位十六进制，
   * 普通字符串比较会在首个不同字符处提前返回，攻击者可以据此逐字节爆破。
   */
  app.get('/users/auth', async (req, reply) => {
    const auth = authenticateKosync(req);
    if (!auth.ok) {
      return kosyncAuthFailed(req, reply, auth);
    }
    // 与官方一致返回 {"authorized":"OK"}（而不是纯文本）。
    // KOReader 只看状态码，但部分第三方客户端会解析响应体，
    // 拿到非 JSON 就判定「这不是 KOSync 服务器」。
    return reply.status(200).send({ authorized: 'OK' });
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

    // 与官方一致：返回 {"username": "..."}，而不是纯文本
    return reply.status(201).send({ username: parsed.data.username });
  });

  /** 上报进度。响应是裸 JSON，timestamp 为 Unix 秒 */
  app.put('/syncs/progress', async (req, reply) => {
    const auth = authenticateKosync(req);
    if (!auth.ok) {
      return kosyncAuthFailed(req, reply, auth);
    }
    const user = auth.user;

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
    const auth = authenticateKosync(req);
    if (!auth.ok) {
      return kosyncAuthFailed(req, reply, auth);
    }
    const user = auth.user;

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

  /**
   * 修改同步密码。
   *
   * 官方服务器用它让客户端在 App 内改密码，请求头带当前凭据、body 带新密码的
   * md5（{ "password": "<md5>" }），成功返回 {"updated": true}。
   *
   * 我们的取舍：**只更新 KOSync 同步密码，不影响网页登录的主密码**。
   * 两者在本项目里本就是分离的（见 docs/security.md），让一个阅读器客户端
   * 改掉站点主密码既不符合预期，也会把用户锁在网页端之外。
   */
  app.put('/users/password', async (req, reply) => {
    const auth = authenticateKosync(req);
    if (!auth.ok) {
      return kosyncAuthFailed(req, reply, auth);
    }

    const body = req.body as { password?: unknown } | undefined;
    const newKey = typeof body?.password === 'string' ? body.password.trim().toLowerCase() : '';

    // 客户端发的是 md5(新密码)，必须是 32 位十六进制
    if (!/^[a-f0-9]{32}$/.test(newKey)) {
      return kosyncError(reply, 403, '新密码格式不正确（应为密码的 MD5 十六进制串）');
    }

    getDb()
      .update(users)
      .set({ kosyncKey: newKey, updatedAt: new Date() })
      .where(eq(users.id, auth.user.id))
      .run();

    recordAudit('user.password_change', auditContextFrom(req, auth.user), {
      target: auth.user.username,
      meta: { protocol: 'kosync', scope: 'sync-password-only' },
    });

    return reply.status(200).send({ updated: true });
  });

  /**
   * 官方还有一个 `DELETE /users/me`（注销账号），这里**有意不实现**。
   *
   * 官方服务器里的账号就等于同步账号，删掉只影响同步数据；而本项目的账号
   * 还持有网页登录、书库元数据、存储配置、阅读统计等。让阅读器里一次
   * 「删除同步账号」把整站账号连同书库一起抹掉，影响远超用户预期，
   * 且不可恢复。这里返回 501 并说明去哪里操作，而不是默默照做。
   */
  app.delete('/users/me', async (_req, reply) => {
    return kosyncError(
      reply,
      501,
      '为避免阅读器里误操作导致整站账号（含书库与存储配置）被删除，本服务器不支持通过 KOSync 注销账号。如需删除请登录网页端操作。',
    );
  });

  /** 部分客户端（含某些反向代理后的 WebView）会先发 OPTIONS 预检 */
  app.options('/syncs/progress', async (_req, reply) => {
    reply.header('Allow', 'GET, PUT, OPTIONS');
    return reply.status(204).send();
  });
}

/**
 * 从 x-auth-user / x-auth-key 头校验用户。
 *
 * 只支持这一种认证方式：KOSync 协议里没有 Authorization 头的位置，
 * 也没有令牌刷新机制，JWT 在此无从谈起。
 *
 * 返回失败原因而不是 null，是为了让调用方能把「用户名不存在」「没设过
 * 同步密码」「密码不匹配」区分开 —— 这些对使用者是完全不可见的，
 * 只有把原因回传并在日志里记下来才可能排查。
 */
export type KosyncAuthFailure =
  | 'missing_headers'
  | 'user_not_found'
  | 'user_disabled'
  | 'no_sync_key'
  | 'key_mismatch';

export type KosyncAuthResult =
  | { ok: true; user: UserRow }
  | { ok: false; reason: KosyncAuthFailure; username: string };

/**
 * 每种失败原因对应的提示文案。
 *
 * 之所以区分得这么细：认证失败的原因对使用者来说完全不可见 ——
 * KOReader 只会把服务端给的 message 原样显示。统一回一句「密码不正确」
 * 会让「用户名填成了邮箱」「根本没设过同步密码」这些情况无从判断，
 * 用户只能反复猜。这里直接说清是哪一环。
 *
 * 是否算用户枚举：/users/create 本身就会以 402 暴露用户名是否被占用，
 * 因此这里给出具体原因并不额外泄露信息，换来的是可诊断性。
 */
function kosyncAuthMessage(reason: KosyncAuthFailure): string {
  switch (reason) {
    case 'missing_headers':
      return '请求缺少认证信息（客户端未发送 x-auth-user / x-auth-key）';
    case 'user_not_found':
      return '用户名不存在：请填写 ReadSync 的用户名或邮箱（注意大小写）';
    case 'user_disabled':
      return '该账号已被禁用，请联系管理员';
    case 'no_sync_key':
      return '该账号尚未设置同步密码，请在网页端「设置 → 账号安全 → KOSync 同步密码」中生成一个';
    case 'key_mismatch':
      return '同步密码不正确，可在网页端「设置 → 账号安全」中重新设置或随机生成';
  }
}

export function authenticateKosync(req: FastifyRequest): KosyncAuthResult {
  const identifier = headerValue(req.headers['x-auth-user']);
  const key = headerValue(req.headers['x-auth-key']);
  if (!identifier || !key) return { ok: false, reason: 'missing_headers', username: identifier };

  // 宽容查找：支持邮箱、忽略大小写差异（设备上输入很容易打错大小写）
  const user = findUserByLoginLoose(identifier);
  if (!user) return { ok: false, reason: 'user_not_found', username: identifier };
  if (user.status !== 'active') return { ok: false, reason: 'user_disabled', username: identifier };
  if (!user.kosyncKey) return { ok: false, reason: 'no_sync_key', username: identifier };

  // 大小写统一后再比较：safeEqualHex 按 hex 解析，大写 MD5 也能正确比较，
  // 但长度判断要求一致，先归一化成小写更稳妥
  if (!safeEqualHex(user.kosyncKey.toLowerCase(), key.toLowerCase())) {
    return { ok: false, reason: 'key_mismatch', username: identifier };
  }

  return { ok: true, user };
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

/**
 * 统一的 KOSync 认证失败处理。
 *
 * 除了返回可读提示，还会把失败原因写进日志 —— 用户在 KOReader 上看到的
 * 只有一句话，服务端日志才是排查的落脚点（用户名、具体是哪一环）。
 * 日志里**不记录密钥本身**，避免把密码摘要带进日志。
 */
function kosyncAuthFailed(
  req: FastifyRequest,
  reply: FastifyReply,
  auth: Extract<KosyncAuthResult, { ok: false }>,
): FastifyReply {
  log.warn(
    {
      username: auth.username || '(未提供)',
      reason: auth.reason,
      hasKey: Boolean(headerValue(req.headers['x-auth-key'])),
      ip: req.ip,
    },
    'KOSync 认证失败',
  );
  return kosyncError(reply, 401, kosyncAuthMessage(auth.reason));
}
