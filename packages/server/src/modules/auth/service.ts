import { and, eq, isNull, sql } from 'drizzle-orm';
import type { FastifyRequest } from 'fastify';
import { OTP } from 'otplib';
import type { AuthResult, PasswordPayload } from '@readsync/shared';
import { loadConfig } from '../../config.js';
import { resolvePassword } from '../../crypto/keys.js';
import { generateToken, hashPassword, sha256Hex, verifyPassword } from '../../crypto/password.js';
import { getDb } from '../../db/index.js';
import { inviteCodes, recoveryCodes, sessions, users, type SessionRow, type UserRow } from '../../db/schema.js';
import { forbidden, internal } from '../../errors.js';
import { accessTokenTtl, signAccessToken } from '../../lib/jwt.js';
import { getSiteSettings } from '../../lib/settings.js';
import { findUserByLogin, toSessionUser } from '../../lib/users.js';

/**
 * 认证模块的可复用原语。
 *
 * 路由层只做「解析请求 → 调用这里 → 组装响应」，把会话签发、TOTP 校验、
 * 通行密钥 challenge 管理这些容易写错的安全逻辑集中在一处，
 * 避免在多个路由里各写一遍导致行为漂移。
 */

/* -------------------------------------------------------------------------- */
/* 会话（refresh token 轮换与吊销）                                            */
/* -------------------------------------------------------------------------- */

/** 与当前请求绑定的会话元信息，用于设备管理与「登录设备列表」展示 */
export interface SessionContext {
  device: string | null;
  userAgent: string | null;
  ip: string | null;
}

/** 从请求头提取会话元信息；仅用于展示，不作为安全判据 */
export function sessionContextFrom(req: FastifyRequest): SessionContext {
  const device = req.headers['x-device-name'];
  return {
    device: typeof device === 'string' ? device.slice(0, 128) : null,
    userAgent: typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'].slice(0, 512) : null,
    ip: req.ip ?? null,
  };
}

export interface CreateSessionOptions {
  /** 同一登录链条（轮换）共用的家族 id；缺省时新建一个家族 */
  familyId?: string;
  /** 「记住我」延长 refresh token 有效期 */
  remember?: boolean;
  /**
   * 指定绝对过期时间。
   * 轮换时必须沿用旧会话的过期时间：否则攻击者只要不断刷新，
   * 就能把会话无限续期，「30 天后必须重新登录」形同虚设。
   */
  expiresAt?: Date;
}

/**
 * 创建一条会话并返回明文 refresh token。
 *
 * 明文只在本次响应里出现一次，库里只存 SHA-256——数据库被读走也无法直接冒用会话。
 */
export function createSession(
  userId: number,
  ctx: SessionContext,
  options: CreateSessionOptions = {},
): { session: SessionRow; refreshToken: string } {
  const db = getDb();
  const config = loadConfig();

  const refreshToken = generateToken(32);
  const ttlSeconds = options.remember ? config.READSYNC_REMEMBER_TTL : config.READSYNC_REFRESH_TOKEN_TTL;

  const session = db
    .insert(sessions)
    .values({
      userId,
      tokenHash: sha256Hex(refreshToken),
      familyId: options.familyId ?? generateToken(16),
      device: ctx.device,
      userAgent: ctx.userAgent,
      ip: ctx.ip,
      expiresAt: options.expiresAt ?? new Date(Date.now() + ttlSeconds * 1000),
      // 新会话未撤销；显式写出避免依赖默认值带来的歧义
      revokedAt: null,
      lastUsedAt: new Date(),
      createdAt: new Date(),
    })
    .returning()
    .get();

  if (!session) {
    throw internal('会话创建失败');
  }

  return { session, refreshToken };
}

/** 签发 access token + 新建会话，得到一次完整登录的返回体 */
export async function issueAuthResult(
  user: UserRow,
  ctx: SessionContext,
  options: CreateSessionOptions = {},
): Promise<{ auth: AuthResult; session: SessionRow }> {
  const { session, refreshToken } = createSession(user.id, ctx, options);
  const accessToken = await signAccessToken({
    sub: String(user.id),
    username: user.username,
    role: user.role,
    tv: user.tokenVersion,
  });

  return {
    auth: {
      user: toSessionUser(user),
      accessToken,
      refreshToken,
      expiresIn: accessTokenTtl(),
    },
    session,
  };
}

/** 按 refresh token 明文吊销单条会话；返回是否命中当前用户的会话 */
export function revokeSessionByRefreshToken(refreshToken: string, userId: number): boolean {
  const db = getDb();
  const result = db
    .update(sessions)
    .set({ revokedAt: new Date() })
    .where(and(eq(sessions.tokenHash, sha256Hex(refreshToken)), eq(sessions.userId, userId), isNull(sessions.revokedAt)))
    .run();
  return result.changes > 0;
}

/**
 * 按「设备指纹」吊销会话。
 *
 * access token 是无状态 JWT，里面没有会话 id，因此客户端未提交 refresh token 时
 * 只能退而求其次按 userId + UA + IP 匹配「当前设备」。这是尽力而为的近似，
 * 但比「静默什么都不做」更符合「登出」的语义（refresh token 不会继续存活到过期）。
 */
export function revokeSessionsForDevice(userId: number, ctx: SessionContext): number {
  const db = getDb();
  const conditions = [eq(sessions.userId, userId), isNull(sessions.revokedAt)];
  if (ctx.userAgent) conditions.push(eq(sessions.userAgent, ctx.userAgent));
  if (ctx.ip) conditions.push(eq(sessions.ip, ctx.ip));

  const result = db
    .update(sessions)
    .set({ revokedAt: new Date() })
    .where(and(...conditions))
    .run();
  return result.changes;
}

/** 吊销用户全部会话（登出所有设备 / 改密 / 重置密码） */
export function revokeAllSessions(userId: number): number {
  const db = getDb();
  const result = db
    .update(sessions)
    .set({ revokedAt: new Date() })
    .where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt)))
    .run();
  return result.changes;
}

/** 整族吊销：检测到 refresh token 重放时使用 */
export function revokeSessionFamily(familyId: string): number {
  const db = getDb();
  const result = db
    .update(sessions)
    .set({ revokedAt: new Date() })
    .where(and(eq(sessions.familyId, familyId), isNull(sessions.revokedAt)))
    .run();
  return result.changes;
}

/** 自增 tokenVersion：middleware 会比对 JWT 里的 tv，旧 access token 立即全部失效 */
export function bumpTokenVersion(userId: number): number {
  const db = getDb();
  const row = db
    .update(users)
    .set({ tokenVersion: sql`${users.tokenVersion} + 1`, updatedAt: new Date() })
    .where(eq(users.id, userId))
    .returning()
    .get();
  return row?.tokenVersion ?? 0;
}

/** 刷新成功后更新最后登录信息（改密等场景不调用） */
export function touchLastLogin(userId: number, ip: string | null): void {
  getDb()
    .update(users)
    .set({ lastLoginAt: new Date(), lastLoginIp: ip, updatedAt: new Date() })
    .where(eq(users.id, userId))
    .run();
}

export type RefreshResult =
  | { status: 'ok'; auth: AuthResult }
  | { status: 'invalid' }
  /** 检测到已撤销的 token 被再次使用，整族已吊销，调用方需要写审计 */
  | { status: 'reused'; userId: number; familyId: string };

/**
 * refresh token 轮换。
 *
 * 不变量：一个 refresh token 只能被消费一次。正常客户端每次刷新都会用新令牌
 * 替换本地旧令牌，所以「已撤销的令牌再次出现」只有两种可能——令牌被窃取，
 * 或者客户端状态被回滚。两种情况下都应当把整个家族吊销：宁可让真实用户重新
 * 登录一次，也不能让攻击者继续沿着令牌链刷新。
 */
export async function rotateRefreshToken(rawToken: string, ctx: SessionContext): Promise<RefreshResult> {
  const db = getDb();
  const session = db.select().from(sessions).where(eq(sessions.tokenHash, sha256Hex(rawToken))).get();

  if (!session) return { status: 'invalid' };

  if (session.revokedAt) {
    revokeSessionFamily(session.familyId);
    return { status: 'reused', userId: session.userId, familyId: session.familyId };
  }

  if (session.expiresAt.getTime() <= Date.now()) {
    db.update(sessions).set({ revokedAt: new Date() }).where(eq(sessions.id, session.id)).run();
    return { status: 'invalid' };
  }

  const user = db.select().from(users).where(eq(users.id, session.userId)).get();
  // 用户被删除/禁用后，即使 refresh token 未过期也不能再换取 access token
  if (!user || user.status !== 'active') return { status: 'invalid' };

  const rotated = createSession(user.id, ctx, {
    familyId: session.familyId,
    expiresAt: session.expiresAt,
  });

  db.update(sessions)
    .set({ revokedAt: new Date(), lastUsedAt: new Date() })
    .where(eq(sessions.id, session.id))
    .run();

  const accessToken = await signAccessToken({
    sub: String(user.id),
    username: user.username,
    role: user.role,
    tv: user.tokenVersion,
  });

  return {
    status: 'ok',
    auth: {
      user: toSessionUser(user),
      accessToken,
      refreshToken: rotated.refreshToken,
      expiresIn: accessTokenTtl(),
    },
  };
}

/* -------------------------------------------------------------------------- */
/* 密码校验                                                                    */
/* -------------------------------------------------------------------------- */

let dummyHashPromise: Promise<string> | null = null;

/** 用户不存在时用来「陪跑」一次哈希校验，抹平响应时间差 */
function dummyPasswordHash(): Promise<string> {
  dummyHashPromise ??= hashPassword(generateToken(16));
  return dummyHashPromise;
}

/**
 * 校验用户名/邮箱 + 密码。
 *
 * 返回 null 一律表示「凭证无效」，不区分用户不存在与密码错误——否则登录接口
 * 就成了用户名/邮箱枚举器。用户不存在时依然执行一次 RSA 解密与 Argon2 校验，
 * 让两条分支的耗时接近（否则响应时间本身也会泄漏账号是否存在）。
 */
export async function verifyCredentials(login: string, password: PasswordPayload): Promise<UserRow | null> {
  const plain = resolvePassword(password);
  const user = findUserByLogin(login);

  if (!user) {
    await verifyPassword(await dummyPasswordHash(), plain);
    return null;
  }

  const ok = await verifyPassword(user.passwordHash, plain);
  return ok ? user : null;
}

/* -------------------------------------------------------------------------- */
/* TOTP                                                                        */
/* -------------------------------------------------------------------------- */

/** otplib v13 的 OTP 实例无状态，进程内共用一个即可 */
const otp = new OTP({ strategy: 'totp' });

/**
 * 允许的时间漂移：±1 个 30 秒时间步。
 * 客户端时钟偏差很常见，不容忍会导致用户频繁验证失败；容差再放大则会显著
 * 缩短 6 位码的有效穷举成本（10^6 次尝试 / 时间窗口）。
 */
const TOTP_TOLERANCE_SECONDS = 30;

export function generateTotpSecret(): string {
  return otp.generateSecret();
}

/** 生成 otpauth:// URI，供前端渲染二维码 */
export function buildTotpUri(secret: string, label: string): string {
  return otp.generateURI({ issuer: getSiteSettings().siteName, label, secret });
}

export interface TotpCheckResult {
  valid: boolean;
  /** 命中的 RFC 6238 时间步，用于防重放；未通过时为 null */
  timeStep: number | null;
}

/**
 * 校验 TOTP 码。
 *
 * 把上次成功的时间步作为 afterTimeStep 传给 otplib，使同一个时间步（以及更早的）
 * 令牌无法二次使用——否则攻击者只要在窗口内截获到验证码就能重放。
 */
export async function checkTotp(
  secret: string,
  token: string,
  lastTimeStep: number | null,
): Promise<TotpCheckResult> {
  try {
    const result = await otp.verify({
      secret,
      token,
      epochTolerance: TOTP_TOLERANCE_SECONDS,
      ...(lastTimeStep !== null ? { afterTimeStep: lastTimeStep } : {}),
    });

    if (!result.valid) return { valid: false, timeStep: null };
    // OTP 类的 verify 返回 TOTP | HOTP 两种结果的联合（两者的 valid 都是 true，
    // 无法靠布尔字面量区分），用 timeStep 字段的存在性收窄到 TOTP 结果
    if (!('timeStep' in result)) return { valid: false, timeStep: null };
    return { valid: true, timeStep: result.timeStep };
  } catch {
    // 密钥被篡改、Base32 非法等情况不应变成 500，统一按「验证失败」处理
    return { valid: false, timeStep: null };
  }
}

/* -------------------------------------------------------------------------- */
/* 恢复码                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * 恢复码归一化：去掉分隔符与空白并转大写。
 * 用户在纸上抄写后手工输入时大小写、连字符都会出错，归一化能显著降低无效失败。
 * 生成与校验两侧都调用它，保证哈希可比。
 */
function normalizeRecoveryCode(code: string): string {
  return code.toUpperCase().replace(/[\s-]/g, '');
}

/** 用新一批恢复码整体替换旧码（旧码在换新后必须立即失效） */
export async function replaceRecoveryCodes(userId: number, codes: string[]): Promise<void> {
  // Argon2 是异步的，先把哈希算完，再放进同步事务里做「删旧 + 插新」，
  // 避免出现「旧码已删、新码没写进去」的空窗导致用户彻底失去恢复手段。
  const hashes = await Promise.all(codes.map((code) => hashPassword(normalizeRecoveryCode(code))));

  getDb().transaction((tx) => {
    tx.delete(recoveryCodes).where(eq(recoveryCodes.userId, userId)).run();
    for (const codeHash of hashes) {
      tx.insert(recoveryCodes).values({ userId, codeHash, usedAt: null, createdAt: new Date() }).run();
    }
  });
}

/**
 * 校验并消费一个恢复码。恢复码是一次性的：命中后立刻标记 usedAt。
 *
 * 已知缺口：shared 里所有验证码入口（loginSchema.totpCode / totpVerifySchema /
 * totpDisableSchema）都被正则限定为「6 位数字」，而恢复码是 12 位字母数字，
 * 因此当前没有任何路由能收到恢复码 —— 本函数是为「用恢复码登录 / 关闭 2FA」
 * 预留的实现，需要先在 shared 里放宽对应字段的校验规则才能接线。
 * 在此之前，用户丢失验证器只能靠管理员在后台重置。
 */
export async function verifyRecoveryCode(userId: number, code: string): Promise<boolean> {
  const db = getDb();
  const candidates = db
    .select()
    .from(recoveryCodes)
    .where(and(eq(recoveryCodes.userId, userId), isNull(recoveryCodes.usedAt)))
    .all();

  const normalized = normalizeRecoveryCode(code);

  for (const candidate of candidates) {
    if (await verifyPassword(candidate.codeHash, normalized)) {
      db.update(recoveryCodes)
        .set({ usedAt: new Date() })
        .where(and(eq(recoveryCodes.id, candidate.id), isNull(recoveryCodes.usedAt)))
        .run();
      return true;
    }
  }

  return false;
}

export function clearRecoveryCodes(userId: number): void {
  getDb().delete(recoveryCodes).where(eq(recoveryCodes.userId, userId)).run();
}

/* -------------------------------------------------------------------------- */
/* 邀请码                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * 原子地占用一次邀请码名额。
 *
 * 用带条件的 UPDATE 而不是「先读后写」：SQLite 虽然是单写入者，但「读 usedCount →
 * 判断 → 写回」之间仍可能被其它请求插入，导致 maxUses 被突破。
 */
export function consumeInviteCode(code: string): void {
  const db = getDb();
  const row = db.select().from(inviteCodes).where(eq(inviteCodes.code, code)).get();
  if (!row) throw forbidden('邀请码无效');
  if (row.expiresAt && row.expiresAt.getTime() <= Date.now()) throw forbidden('邀请码已过期');

  const result = db
    .update(inviteCodes)
    .set({ usedCount: sql`${inviteCodes.usedCount} + 1` })
    .where(and(eq(inviteCodes.id, row.id), sql`${inviteCodes.usedCount} < ${inviteCodes.maxUses}`))
    .run();

  if (result.changes === 0) throw forbidden('邀请码已用尽');
}

/** 注册失败时归还名额，避免用户填错邮箱就白白消耗一个邀请码 */
export function releaseInviteCode(code: string): void {
  getDb()
    .update(inviteCodes)
    .set({ usedCount: sql`max(${inviteCodes.usedCount} - 1, 0)` })
    .where(eq(inviteCodes.code, code))
    .run();
}

/* -------------------------------------------------------------------------- */
/* WebAuthn / 通行密钥                                                         */
/* -------------------------------------------------------------------------- */

/**
 * challenge 暂存。
 *
 * WebAuthn 的 challenge 必须由服务端签发并在校验时比对，否则签名可以被重放。
 * 存在内存里足够：challenge 生命周期只有几分钟，进程重启后未完成的注册/登录
 * 本来就应该重新发起。多实例部署时需换成共享存储（当前项目的定位是自托管单实例）。
 */
interface PendingChallenge {
  challenge: string;
  scope: 'register' | 'login';
  /** 已知的用户 id；注册流程必有，登录流程在未提供用户名时为 null */
  userId: number | null;
  expiresAt: number;
}

const pendingChallenges = new Map<string, PendingChallenge>();
const CHALLENGE_TTL_MS = 5 * 60 * 1000;

function pruneChallenges(): void {
  const now = Date.now();
  for (const [key, value] of pendingChallenges) {
    if (value.expiresAt <= now) pendingChallenges.delete(key);
  }
}

export function rememberChallenge(scope: PendingChallenge['scope'], challenge: string, userId: number | null): void {
  pruneChallenges();
  pendingChallenges.set(challenge, { challenge, scope, userId, expiresAt: Date.now() + CHALLENGE_TTL_MS });
}

/**
 * 取出并消费 challenge。
 *
 * 消费是必需的（一次性）：同一个 challenge 若能反复通过校验，攻击者录下
 * 一次签名响应就能无限重放。userId 的匹配规则：
 *  - 暂存时已知 userId（注册、或登录时提供了用户名）→ 必须完全一致；
 *  - 暂存时未知（免用户名的 discoverable credential 登录）→ 接受任意，
 *    因为此时用户身份是靠 credentialId 反查出来的。
 */
export function consumeChallenge(
  scope: PendingChallenge['scope'],
  challenge: string,
  userId: number | null,
): boolean {
  pruneChallenges();
  const entry = pendingChallenges.get(challenge);
  if (!entry) return false;
  pendingChallenges.delete(challenge);

  if (entry.scope !== scope) return false;
  if (entry.userId !== null && entry.userId !== userId) return false;
  return true;
}

export interface RelyingParty {
  rpID: string;
  origin: string;
  rpName: string;
}

/**
 * WebAuthn 的 RP ID 与 origin。
 *
 * RP ID 必须是域名（不含端口与协议），否则浏览器会拒绝；origin 必须完整，
 * 由 READSYNC_BASE_URL 推导，保证与用户实际访问的地址一致——
 * 反向代理场景下这里配置错了会导致所有通行密钥验证失败。
 */
export function relyingParty(): RelyingParty {
  const { READSYNC_BASE_URL } = loadConfig();
  const rpName = getSiteSettings().siteName;

  try {
    const url = new URL(READSYNC_BASE_URL);
    return { rpID: url.hostname, origin: url.origin, rpName };
  } catch {
    // 配置非法时退化为 localhost，至少让本地开发可用；生产环境应在启动时就发现
    return { rpID: 'localhost', origin: 'http://localhost', rpName };
  }
}

/** 通行密钥公钥以 base64url 存库（SQLite 没有二进制列，且 JSON 友好） */
export function encodePublicKey(key: Uint8Array): string {
  return Buffer.from(key).toString('base64url');
}

export function decodePublicKey(value: string): Uint8Array<ArrayBuffer> {
  const bytes = Buffer.from(value, 'base64url');
  // 复制到独立的 ArrayBuffer：WebAuthn 的 WebAuthnCredential.publicKey 要求
  // 底层不是 SharedArrayBuffer，直接复用 Node 的 Buffer 内存池会不满足类型与语义
  const out = new Uint8Array(bytes.byteLength);
  out.set(bytes);
  return out;
}
