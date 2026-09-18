import { generateAuthenticationOptions, generateRegistrationOptions, verifyAuthenticationResponse, verifyRegistrationResponse } from '@simplewebauthn/server';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import {
  changePasswordSchema,
  forgotPasswordSchema,
  idParamSchema,
  isTotpCode,
  loginSchema,
  passkeyLoginVerifySchema,
  passkeyRegisterVerifySchema,
  passwordSchema,
  refreshTokenSchema,
  registerSchema,
  resetPasswordSchema,
  totpDisableSchema,
  totpVerifySchema,
  type ApiSuccess,
  type AuthResult,
  type PasskeySummary,
  type SessionUser,
  type TotpSetupResult,
} from '@readsync/shared';
import { resolvePassword } from '../../crypto/keys.js';
import {
  generateNumericCode,
  generateRecoveryCodes,
  hashPassword,
  md5Hex,
  safeEqualHex,
  sha256Hex,
  verifyPassword,
} from '../../crypto/password.js';
import { decryptString, encryptString } from '../../crypto/secret-box.js';
import { getDb } from '../../db/index.js';
import { emailCodes, passkeys, users, type PasskeyRow } from '../../db/schema.js';
import { badRequest, conflict, forbidden, internal, notFound, rateLimited, unauthorized } from '../../errors.js';
import { auditContextFrom, recordAudit } from '../../lib/audit.js';
import { assertMailConfigured, sendPasswordChangedNotice, sendPasswordResetCode } from '../../lib/mail.js';
import { resolveNewPassword } from '../../lib/password-input.js';
import { getSiteSettings } from '../../lib/settings.js';
import { createUser, findUserByLogin, toSessionUser } from '../../lib/users.js';
import { getModuleLogger } from '../../logger.js';
import { currentUser, requireAuth } from '../../middleware/auth.js';
import {
  bumpTokenVersion,
  buildTotpUri,
  checkTotp,
  clearRecoveryCodes,
  consumeChallenge,
  consumeInviteCode,
  decodePublicKey,
  encodePublicKey,
  generateTotpSecret,
  issueAuthResult,
  releaseInviteCode,
  relyingParty,
  rememberChallenge,
  replaceRecoveryCodes,
  revokeAllSessions,
  revokeSessionByRefreshToken,
  revokeSessionsForDevice,
  verifyRecoveryCode,
  rotateRefreshToken,
  sessionContextFrom,
  touchLastLogin,
  verifyCredentials,
} from './service.js';

/**
 * 认证模块路由（全部挂在 /api/auth 下）。
 *
 * 设计原则：
 *  - 认证失败一律使用模糊文案（「用户名或密码错误」），不区分「用户不存在」与
 *    「密码错误」，否则登录接口会变成账号枚举器；
 *  - 密码只以 RSA-OAEP 密文形式进入服务端（resolvePassword 解密），
 *    落库永远只存 Argon2id 单向哈希；
 *  - refresh token 只存 SHA-256，并实现轮换 + 重放检测，见 service.ts。
 */

/** 密码重置验证码有效期：太短用户来不及收信，太长则给暴力猜码留出窗口 */
const RESET_CODE_TTL_MS = 10 * 60 * 1000;
/** 同一验证码允许的最大尝试次数，超过直接作废 */
const RESET_CODE_MAX_ATTEMPTS = 5;

/** 需要二次验证但本次未提交验证码时的返回体（此时不签发任何令牌） */
interface TwoFactorChallenge {
  requires2fa: true;
  user: SessionUser;
}

export async function registerAuthRoutes(app: FastifyInstance): Promise<void> {
  const log = getModuleLogger('auth');

  /**
   * 路由级限流配置。
   *
   * 必须显式提供 errorResponseBuilder：@fastify/rate-limit 默认抛的是普通 Error，
   * 而 app.ts 的错误处理器只对 AppError 保留 statusCode，普通 Error 会被当成
   * 未处理异常返回 500 —— 前端既拿不到 429 也拿不到 RATE_LIMITED 语义。
   */
  const limited = (max: number, timeWindow: string) => ({
    max,
    timeWindow,
    errorResponseBuilder: () => rateLimited('操作过于频繁，请稍后再试'),
  });

  /* ------------------------------- 注册 ------------------------------- */

  app.post('/api/auth/register', { config: { rateLimit: limited(10, '1 minute') } }, async (req) => {
    const settings = getSiteSettings();
    if (!settings.registrationEnabled) {
      throw forbidden('本站点已关闭注册');
    }

    const input = registerSchema.parse(req.body);

    // 先解密密码：密文非法（密钥轮换、页面停留过久）时应当直接失败，
    // 不能白白消耗掉一个邀请码名额。
    const plainPassword = resolvePassword(input.password);

    // registerSchema 里的 password 是密文（EncryptedPayload），zod 无法在密文上校验强度，
    // 因此解密后必须补一次 passwordSchema —— 否则绕过前端直接调接口就能注册出 1 位密码的账号。
    const strength = passwordSchema.safeParse(plainPassword);
    if (!strength.success) {
      throw badRequest(strength.error.issues[0]?.message ?? '密码强度不符合要求');
    }

    let inviteConsumed = false;
    if (settings.inviteRequired) {
      if (!input.inviteCode) throw forbidden('本站点需要邀请码才能注册');
      consumeInviteCode(input.inviteCode);
      inviteConsumed = true;
    }

    let user;
    try {
      user = await createUser({
        username: input.username,
        email: input.email,
        plainPassword,
        displayName: input.displayName,
      });
    } catch (err) {
      // 用户名/邮箱冲突等失败要归还名额，否则用户打错一个字就损失一个邀请码
      if (inviteConsumed && input.inviteCode) releaseInviteCode(input.inviteCode);
      throw err;
    }

    recordAudit('user.register', auditContextFrom(req, { id: user.id, username: user.username }), {
      target: user.username,
      meta: { email: user.email },
    });

    return { ok: true, data: { user: toSessionUser(user) } } satisfies ApiSuccess<{ user: SessionUser }>;
  });

  /* ------------------------------- 登录 ------------------------------- */

  app.post('/api/auth/login', { config: { rateLimit: limited(10, '1 minute') } }, async (req) => {
    const input = loginSchema.parse(req.body);
    const db = getDb();

    const user = await verifyCredentials(input.username, input.password);
    if (!user) {
      recordAudit('user.login_failed', auditContextFrom(req), {
        target: input.username,
        success: false,
        meta: { reason: 'invalid_credentials' },
      });
      throw unauthorized('用户名或密码错误');
    }

    if (user.status !== 'active') {
      // 走到这里密码已经校验通过，可以明确告知「被禁用」，否则用户会一直重试
      recordAudit('user.login_failed', auditContextFrom(req, { id: user.id, username: user.username }), {
        target: user.username,
        success: false,
        meta: { reason: 'disabled' },
      });
      throw forbidden('该账号已被禁用，请联系管理员');
    }

    if (user.totpEnabled) {
      if (!input.totpCode) {
        // 此时不签发任何令牌，前端据此切换到验证码输入步骤
        return {
          ok: true,
          data: { requires2fa: true, user: toSessionUser(user) },
        } satisfies ApiSuccess<TwoFactorChallenge>;
      }

      // 两步验证凭据可能是 6 位 TOTP，也可能是用户丢失验证器时用的一次性恢复码。
      // 恢复码是「备用钥匙」，没有它用户一旦丢失验证器就只能找管理员重置，因此必须支持。
      if (!isTotpCode(input.totpCode)) {
        const recovered = await verifyRecoveryCode(user.id, input.totpCode);
        if (!recovered) {
          recordAudit('user.login_failed', auditContextFrom(req, { id: user.id, username: user.username }), {
            target: user.username,
            success: false,
            meta: { reason: 'invalid_recovery_code' },
          });
          throw unauthorized('恢复码无效或已被使用');
        }

        // 恢复码登录成功也记一条审计：它意味着用户很可能丢失了验证器
        recordAudit('user.login', auditContextFrom(req, { id: user.id, username: user.username }), {
          target: user.username,
          meta: { via: 'recovery_code' },
        });
        log.warn({ userId: user.id }, '用户使用恢复码登录，建议提示其重新绑定验证器');
      } else {
        if (!user.totpSecretEncrypted) {
          // totpEnabled 与密钥不一致属于数据损坏，按服务端故障处理（对外不暴露细节）
          log.error({ userId: user.id }, '用户已开启两步验证但密钥缺失');
          throw internal('两步验证配置异常，请联系管理员');
        }

        const secret = decryptString(user.totpSecretEncrypted);
        const check = await checkTotp(secret, input.totpCode, user.totpLastTimeStep);
        if (!check.valid) {
          recordAudit('user.login_failed', auditContextFrom(req, { id: user.id, username: user.username }), {
            target: user.username,
            success: false,
            meta: { reason: 'invalid_totp' },
          });
          throw unauthorized('验证码不正确');
        }

        // 记录本次命中的时间步：同一个验证码无法被二次使用（防重放）
        db.update(users)
          .set({ totpLastTimeStep: check.timeStep })
          .where(eq(users.id, user.id))
          .run();
      }
    }

    const ctx = sessionContextFrom(req);
    touchLastLogin(user.id, ctx.ip);
    // 重新读取以拿到更新后的 lastLoginAt，保证返回的 SessionUser 与库内一致
    const fresh = db.select().from(users).where(eq(users.id, user.id)).get() ?? user;

    const { auth } = await issueAuthResult(fresh, ctx, { remember: input.remember });

    recordAudit('user.login', auditContextFrom(req, { id: user.id, username: user.username }), {
      target: user.username,
      meta: { method: 'password', remember: input.remember, totp: user.totpEnabled },
    });

    return { ok: true, data: auth } satisfies ApiSuccess<AuthResult>;
  });

  /* ---------------------------- 刷新与登出 ---------------------------- */

  app.post('/api/auth/refresh', { config: { rateLimit: limited(60, '1 minute') } }, async (req) => {
    const input = refreshTokenSchema.parse(req.body);
    const result = await rotateRefreshToken(input.refreshToken, sessionContextFrom(req));

    if (result.status === 'invalid') {
      throw unauthorized('登录已过期，请重新登录');
    }

    if (result.status === 'reused') {
      // service 已经整族吊销。这里记一条审计，方便事后排查「是真的被盗用还是客户端 bug」
      recordAudit('user.logout', { ...auditContextFrom(req), userId: result.userId }, {
        success: false,
        meta: { reason: 'refresh_token_reuse', familyId: result.familyId },
      });
      throw unauthorized('检测到会话异常，已注销该设备的全部登录，请重新登录');
    }

    return { ok: true, data: result.auth } satisfies ApiSuccess<AuthResult>;
  });

  app.post('/api/auth/logout', { preHandler: requireAuth }, async (req) => {
    const user = currentUser(req);
    const parsed = refreshTokenSchema.partial().safeParse(req.body ?? {});
    const refreshToken = parsed.success ? parsed.data.refreshToken : undefined;

    const ctx = sessionContextFrom(req);
    // access token（JWT）里没有会话 id，因此优先用 refresh token 精确定位；
    // 客户端没带时退化为按设备指纹吊销当前设备，避免刷新令牌一直存活到过期。
    const revoked = refreshToken
      ? revokeSessionByRefreshToken(refreshToken, user.id)
        ? 1
        : 0
      : revokeSessionsForDevice(user.id, ctx);

    recordAudit('user.logout', auditContextFrom(req), { target: user.username, meta: { revoked } });

    return { ok: true, data: { revoked } } satisfies ApiSuccess<{ revoked: number }>;
  });

  app.post('/api/auth/logout-all', { preHandler: requireAuth }, async (req) => {
    const user = currentUser(req);

    // 自增 tokenVersion 让所有已签发的 access token 立即失效（无需等它们过期），
    // 再吊销全部会话让 refresh token 也无法续命。
    bumpTokenVersion(user.id);
    const revoked = revokeAllSessions(user.id);

    recordAudit('user.logout', auditContextFrom(req), { target: user.username, meta: { all: true, revoked } });

    return { ok: true, data: { revoked } } satisfies ApiSuccess<{ revoked: number }>;
  });

  /* ------------------------------- 当前用户 ------------------------------- */

  app.get('/api/auth/me', { preHandler: requireAuth }, async (req) => {
    const auth = currentUser(req);
    const row = getDb().select().from(users).where(eq(users.id, auth.id)).get();
    if (!row) throw unauthorized();

    return { ok: true, data: toSessionUser(row) } satisfies ApiSuccess<SessionUser>;
  });

  /* ------------------------------ 修改密码 ------------------------------ */

  app.post(
    '/api/auth/change-password',
    { preHandler: requireAuth, config: { rateLimit: limited(10, '1 minute') } },
    async (req) => {
      const auth = currentUser(req);
      const input = changePasswordSchema.parse(req.body);
      const db = getDb();

      const row = db.select().from(users).where(eq(users.id, auth.id)).get();
      if (!row) throw unauthorized();

      const oldPlain = resolvePassword(input.oldPassword);
      if (!(await verifyPassword(row.passwordHash, oldPlain))) {
        recordAudit('user.password_change', auditContextFrom(req), {
          target: row.username,
          success: false,
          meta: { reason: 'bad_old_password' },
        });
        throw unauthorized('当前密码不正确');
      }

      const newPlain = resolveNewPassword(input.newPassword, '新密码');
      const passwordHash = await hashPassword(newPlain);
      const updated = db
        .update(users)
        .set({
          passwordHash,
          // KOSync 协议只能发 md5(密码)，不同步更新的话旧密码仍能用于同步
          kosyncKey: md5Hex(newPlain),
          tokenVersion: sql`${users.tokenVersion} + 1`,
          updatedAt: new Date(),
        })
        .where(eq(users.id, row.id))
        .returning()
        .get();
      if (!updated) throw internal('密码更新失败');

      // 改密前的 refresh token 必须全部作废，否则账号被盗后攻击者的会话能活到过期
      revokeAllSessions(row.id);

      // 当前设备发放一套新令牌：既踢掉了其它设备，又不至于让本人立刻被登出
      const ctx = sessionContextFrom(req);
      const { auth: result } = await issueAuthResult(updated, ctx);

      void sendPasswordChangedNotice(updated.email, req.ip ?? null).catch((err) => {
        log.warn({ err }, '发送密码变更通知失败');
      });

      recordAudit('user.password_change', auditContextFrom(req), { target: updated.username });

      return { ok: true, data: result } satisfies ApiSuccess<AuthResult>;
    },
  );

  /* ------------------------------ 找回密码 ------------------------------ */

  app.post(
    '/api/auth/forgot-password',
    { config: { rateLimit: limited(5, '15 minutes') } },
    async (req) => {
      const input = forgotPasswordSchema.parse(req.body);

      if (!getSiteSettings().passwordResetEnabled) {
        throw forbidden('本站点未开放密码找回');
      }
      // 邮件未配置是站点级问题，与邮箱是否注册无关，因此不构成用户枚举
      assertMailConfigured();

      const db = getDb();
      const user = findUserByLogin(input.email);
      if (user && user.status === 'active') {
        const code = generateNumericCode(6);

        // 旧码立即作废：多次请求会留下多个可用验证码，等于人为放大猜码空间
        db.update(emailCodes)
          .set({ consumedAt: new Date() })
          .where(
            and(
              eq(emailCodes.email, user.email),
              eq(emailCodes.purpose, 'password_reset'),
              isNull(emailCodes.consumedAt),
            ),
          )
          .run();

        db.insert(emailCodes)
          .values({
            email: user.email,
            // 只存哈希：邮件内容泄漏或库被读走都不能直接得到验证码
            codeHash: sha256Hex(code),
            purpose: 'password_reset',
            expiresAt: new Date(Date.now() + RESET_CODE_TTL_MS),
            consumedAt: null,
            attempts: 0,
            ip: req.ip ?? null,
            createdAt: new Date(),
          })
          .run();

        const sent = await sendPasswordResetCode(user.email, code, RESET_CODE_TTL_MS / 60000);
        if (!sent.ok) {
          log.error({ reason: sent.message }, '密码重置验证码发送失败');
        }
      }

      // 无论邮箱是否存在，响应文案与状态码完全一致——这是防用户枚举的关键
      return {
        ok: true,
        data: { message: '如果该邮箱已注册，我们已发送重置验证码，请在 10 分钟内完成重置' },
      } satisfies ApiSuccess<{ message: string }>;
    },
  );

  app.post(
    '/api/auth/reset-password',
    { config: { rateLimit: limited(10, '15 minutes') } },
    async (req) => {
      const input = resetPasswordSchema.parse(req.body);
      const db = getDb();

      const record = db
        .select()
        .from(emailCodes)
        .where(
          and(
            eq(emailCodes.email, input.email),
            eq(emailCodes.purpose, 'password_reset'),
            isNull(emailCodes.consumedAt),
          ),
        )
        .orderBy(desc(emailCodes.createdAt))
        .get();

      if (!record) throw badRequest('验证码无效或已过期，请重新获取');
      if (record.expiresAt.getTime() <= Date.now()) throw badRequest('验证码已过期，请重新获取');
      if (record.attempts >= RESET_CODE_MAX_ATTEMPTS) throw badRequest('验证码尝试次数过多，请重新获取');

      if (!safeEqualHex(sha256Hex(input.code), record.codeHash)) {
        const attempts = record.attempts + 1;
        db.update(emailCodes)
          .set({
            attempts,
            // 达到上限直接作废，避免攻击者靠「每次只错一点」无限试探
            ...(attempts >= RESET_CODE_MAX_ATTEMPTS ? { consumedAt: new Date() } : {}),
          })
          .where(eq(emailCodes.id, record.id))
          .run();
        throw badRequest('验证码不正确');
      }

      const user = findUserByLogin(input.email);
      if (!user) throw badRequest('验证码无效或已过期，请重新获取');

      const newPlain = resolveNewPassword(input.newPassword, '新密码');
      const passwordHash = await hashPassword(newPlain);
      const updated = db
        .update(users)
        .set({
          passwordHash,
          kosyncKey: md5Hex(newPlain),
          tokenVersion: sql`${users.tokenVersion} + 1`,
          updatedAt: new Date(),
        })
        .where(eq(users.id, user.id))
        .returning()
        .get();
      if (!updated) throw internal('密码重置失败');

      db.update(emailCodes).set({ consumedAt: new Date() }).where(eq(emailCodes.id, record.id)).run();

      // 走「忘记密码」通常意味着账号可能已被他人控制，必须把所有设备踢下线
      revokeAllSessions(user.id);

      recordAudit('user.password_reset', auditContextFrom(req, { id: updated.id, username: updated.username }), {
        target: updated.username,
      });

      void sendPasswordChangedNotice(updated.email, req.ip ?? null).catch((err) => {
        log.warn({ err }, '发送密码变更通知失败');
      });

      return {
        ok: true,
        data: { message: '密码已重置，请使用新密码登录' },
      } satisfies ApiSuccess<{ message: string }>;
    },
  );

  /* ------------------------------- 两步验证 ------------------------------- */

  app.post('/api/auth/2fa/setup', { preHandler: requireAuth }, async (req) => {
    const auth = currentUser(req);
    const db = getDb();

    const row = db.select().from(users).where(eq(users.id, auth.id)).get();
    if (!row) throw unauthorized();
    if (row.totpEnabled) throw conflict('两步验证已开启，如需更换验证器请先关闭');

    const secret = generateTotpSecret();
    // 暂存密钥但保持 totpEnabled = false：必须等用户用一次有效验证码证明
    // 已经成功导入，否则用户一旦没保存好密钥就会把自己锁在账号外。
    db.update(users)
      .set({
        totpSecretEncrypted: encryptString(secret),
        totpEnabled: false,
        totpLastTimeStep: null,
        updatedAt: new Date(),
      })
      .where(eq(users.id, row.id))
      .run();

    const data: TotpSetupResult = { secret, otpauthUrl: buildTotpUri(secret, row.email) };

    return { ok: true, data } satisfies ApiSuccess<TotpSetupResult>;
  });

  app.post(
    '/api/auth/2fa/enable',
    { preHandler: requireAuth, config: { rateLimit: limited(10, '1 minute') } },
    async (req) => {
      const auth = currentUser(req);
      const input = totpVerifySchema.parse(req.body);
      const db = getDb();

      const row = db.select().from(users).where(eq(users.id, auth.id)).get();
      if (!row) throw unauthorized();
      if (row.totpEnabled) throw conflict('两步验证已开启');
      if (!row.totpSecretEncrypted) throw badRequest('请先获取两步验证密钥');

      const secret = decryptString(row.totpSecretEncrypted);
      // 首次绑定不传 afterTimeStep：此前没有可用的历史时间步
      const check = await checkTotp(secret, input.code, null);
      if (!check.valid) throw badRequest('验证码不正确，请检查设备时间是否准确');

      const updated = db
        .update(users)
        .set({ totpEnabled: true, totpLastTimeStep: check.timeStep, updatedAt: new Date() })
        .where(eq(users.id, row.id))
        .returning()
        .get();
      if (!updated) throw internal('开启两步验证失败');

      const codes = generateRecoveryCodes(8);
      await replaceRecoveryCodes(row.id, codes);

      recordAudit('auth.2fa_enable', auditContextFrom(req), { target: row.username });

      const data: TotpSetupResult & { user: SessionUser } = {
        secret,
        otpauthUrl: buildTotpUri(secret, updated.email),
        recoveryCodes: codes,
        user: toSessionUser(updated),
      };

      // 恢复码明文只在这里返回一次，库里只有 Argon2 哈希
      return { ok: true, data } satisfies ApiSuccess<TotpSetupResult & { user: SessionUser }>;
    },
  );

  app.post(
    '/api/auth/2fa/disable',
    { preHandler: requireAuth, config: { rateLimit: limited(10, '1 minute') } },
    async (req) => {
      const auth = currentUser(req);
      const input = totpDisableSchema.parse(req.body);
      const db = getDb();

      const row = db.select().from(users).where(eq(users.id, auth.id)).get();
      if (!row) throw unauthorized();
      if (!row.totpEnabled || !row.totpSecretEncrypted) throw badRequest('两步验证未开启');

      const plain = resolvePassword(input.password);
      if (!(await verifyPassword(row.passwordHash, plain))) throw unauthorized('密码不正确');

      const secret = decryptString(row.totpSecretEncrypted);
      // 这里不传 afterTimeStep：关闭 2FA 已经要求重新输入账号密码（Argon2 校验），
      // 若因「刚用过的验证码」被拒会让用户莫名其妙地要等 30 秒。
      const check = await checkTotp(secret, input.code, null);
      if (!check.valid) throw badRequest('验证码不正确');

      const updated = db
        .update(users)
        .set({ totpEnabled: false, totpSecretEncrypted: null, totpLastTimeStep: null, updatedAt: new Date() })
        .where(eq(users.id, row.id))
        .returning()
        .get();
      if (!updated) throw internal('关闭两步验证失败');

      // 恢复码与密钥绑定，密钥清空后必须一并删除，否则会留下无用但有效的凭据
      clearRecoveryCodes(row.id);

      recordAudit('auth.2fa_disable', auditContextFrom(req), { target: row.username });

      return { ok: true, data: { user: toSessionUser(updated) } } satisfies ApiSuccess<{ user: SessionUser }>;
    },
  );

  /* ------------------------------ 通行密钥 ------------------------------ */

  app.get('/api/auth/passkeys', { preHandler: requireAuth }, async (req) => {
    const user = currentUser(req);
    const rows = getDb()
      .select()
      .from(passkeys)
      .where(eq(passkeys.userId, user.id))
      .orderBy(desc(passkeys.createdAt))
      .all();

    return { ok: true, data: rows.map(toPasskeySummary) } satisfies ApiSuccess<PasskeySummary[]>;
  });

  app.post('/api/auth/passkeys/register/options', { preHandler: requireAuth }, async (req) => {
    const auth = currentUser(req);
    const db = getDb();

    const user = db.select().from(users).where(eq(users.id, auth.id)).get();
    if (!user) throw unauthorized();

    const { rpID, rpName } = relyingParty();
    const existing = db
      .select({ credentialId: passkeys.credentialId, transports: passkeys.transports })
      .from(passkeys)
      .where(eq(passkeys.userId, user.id))
      .all();

    const options = await generateRegistrationOptions({
      rpName,
      rpID,
      userName: user.username,
      userDisplayName: user.displayName ?? user.username,
      // 用户句柄必须稳定且不含隐私信息，跨多次注册保持一致
      userID: new TextEncoder().encode(`readsync:user:${user.id}`),
      // 自托管场景没有可信的 attestation 校验链，声明 none 即可（浏览器也更愿意配合）
      attestationType: 'none',
      // 排除已注册凭据，避免同一认证器重复绑定同一个账号
      excludeCredentials: existing.map((p) => ({ id: p.credentialId, transports: p.transports ?? [] })),
      authenticatorSelection: { residentKey: 'preferred', userVerification: 'preferred' },
    });

    rememberChallenge('register', options.challenge, user.id);

    return { ok: true, data: options } satisfies ApiSuccess<typeof options>;
  });

  app.post('/api/auth/passkeys/register/verify', { preHandler: requireAuth }, async (req) => {
    const auth = currentUser(req);
    const input = passkeyRegisterVerifySchema.parse(req.body);
    const { rpID, origin } = relyingParty();
    const db = getDb();

    let verification;
    try {
      verification = await verifyRegistrationResponse({
        // challenge 由服务端签发并一次性消费，防止签名响应被重放
        response: input.response,
        expectedChallenge: (challenge) => consumeChallenge('register', challenge, auth.id),
        expectedOrigin: origin,
        expectedRPID: rpID,
      });
    } catch (err) {
      log.warn({ err, userId: auth.id }, '通行密钥注册校验失败');
      throw badRequest('通行密钥注册校验失败，请重试');
    }

    if (!verification.verified) throw badRequest('通行密钥注册校验未通过');

    const { credential, credentialDeviceType, credentialBackedUp } = verification.registrationInfo;

    // z.any() 没有做结构校验，来自客户端的 transports 必须自己收敛类型后再入库
    const rawTransports = input.response?.response?.transports;
    const transports = Array.isArray(rawTransports)
      ? (rawTransports as unknown[]).filter((t): t is string => typeof t === 'string').slice(0, 10)
      : null;

    let inserted: PasskeyRow | undefined;
    try {
      inserted = db
        .insert(passkeys)
        .values({
          userId: auth.id,
          credentialId: credential.id,
          publicKey: encodePublicKey(credential.publicKey),
          counter: credential.counter,
          deviceType: credentialDeviceType,
          backedUp: credentialBackedUp,
          transports,
          name: input.name ?? null,
          lastUsedAt: null,
          createdAt: new Date(),
        })
        .returning()
        .get();
    } catch (err) {
      // credential_id 唯一索引冲突：同一个认证器重复注册
      log.warn({ err, userId: auth.id }, '保存通行密钥失败');
      throw conflict('该通行密钥已注册过，请在设备列表中查看');
    }

    if (!inserted) throw internal('保存通行密钥失败');

    recordAudit('auth.passkey_add', auditContextFrom(req), { target: inserted.name ?? credential.id });

    return { ok: true, data: toPasskeySummary(inserted) } satisfies ApiSuccess<PasskeySummary>;
  });

  app.post(
    '/api/auth/passkeys/login/options',
    { config: { rateLimit: limited(30, '1 minute') } },
    async (req) => {
      // 复用登录校验 schema 的 username 字段；未提供用户名时走 discoverable credential 流程
      const parsed = passkeyLoginVerifySchema.pick({ username: true }).safeParse(req.body ?? {});
      const username = parsed.success ? parsed.data.username : undefined;

      const db = getDb();
      const { rpID } = relyingParty();

      // 用户不存在时同样返回空 allowCredentials，不给「该账号是否注册过」的信号
      const user = username ? findUserByLogin(username) : undefined;
      const credentials = user
        ? db
            .select({ credentialId: passkeys.credentialId, transports: passkeys.transports })
            .from(passkeys)
            .where(eq(passkeys.userId, user.id))
            .all()
        : [];

      const options = await generateAuthenticationOptions({
        rpID,
        allowCredentials: credentials.map((c) => ({ id: c.credentialId, transports: c.transports ?? [] })),
        userVerification: 'preferred',
      });

      rememberChallenge('login', options.challenge, user?.id ?? null);

      return { ok: true, data: options } satisfies ApiSuccess<typeof options>;
    },
  );

  app.post(
    '/api/auth/passkeys/login/verify',
    { config: { rateLimit: limited(10, '1 minute') } },
    async (req) => {
      const input = passkeyLoginVerifySchema.parse(req.body);
      const db = getDb();

      const responseId = typeof input.response?.id === 'string' ? input.response.id : null;
      if (!responseId) throw badRequest('通行密钥响应缺少凭据 id');

      const passkey = db.select().from(passkeys).where(eq(passkeys.credentialId, responseId)).get();
      // 未注册的凭据与校验失败共用同一文案，避免探测哪些凭据已注册
      if (!passkey) throw unauthorized('通行密钥验证失败');

      const user = db.select().from(users).where(eq(users.id, passkey.userId)).get();
      if (!user) throw unauthorized('通行密钥验证失败');
      if (user.status !== 'active') throw forbidden('该账号已被禁用，请联系管理员');

      // 客户端自称的用户必须与凭据归属一致，否则就是用 A 的凭据冒充 B
      if (input.username && input.username !== user.username && input.username !== user.email) {
        throw unauthorized('通行密钥验证失败');
      }

      const { rpID, origin } = relyingParty();

      let verification;
      try {
        verification = await verifyAuthenticationResponse({
          response: input.response,
          expectedChallenge: (challenge) => consumeChallenge('login', challenge, user.id),
          expectedOrigin: origin,
          expectedRPID: rpID,
          credential: {
            id: passkey.credentialId,
            publicKey: decodePublicKey(passkey.publicKey),
            counter: passkey.counter,
            transports: passkey.transports ?? [],
          },
        });
      } catch (err) {
        log.warn({ err, userId: user.id }, '通行密钥登录校验失败');
        throw unauthorized('通行密钥验证失败');
      }

      if (!verification.verified) throw unauthorized('通行密钥验证失败');

      const { newCounter } = verification.authenticationInfo;
      db.update(passkeys)
        .set({
          // 只在计数器确实前进时更新：平台通行密钥常恒为 0，把 0 写回会抹掉克隆检测能力
          ...(newCounter > 0 && newCounter > passkey.counter ? { counter: newCounter } : {}),
          lastUsedAt: new Date(),
        })
        .where(eq(passkeys.id, passkey.id))
        .run();

      // 通行密钥本身就是抗钓鱼的强凭据，因此不再叠加 TOTP 二次校验
      const ctx = sessionContextFrom(req);
      touchLastLogin(user.id, ctx.ip);
      const fresh = db.select().from(users).where(eq(users.id, user.id)).get() ?? user;

      const { auth } = await issueAuthResult(fresh, ctx);

      recordAudit('user.login', auditContextFrom(req, { id: user.id, username: user.username }), {
        target: user.username,
        meta: { method: 'passkey' },
      });

      return { ok: true, data: auth } satisfies ApiSuccess<AuthResult>;
    },
  );

  app.delete('/api/auth/passkeys/:id', { preHandler: requireAuth }, async (req) => {
    const user = currentUser(req);
    const { id } = idParamSchema.parse(req.params);

    // WHERE 同时带 userId：只能删自己的凭据，且不必「先查再判归属」（少一次 TOCTOU 面）
    const result = getDb()
      .delete(passkeys)
      .where(and(eq(passkeys.id, id), eq(passkeys.userId, user.id)))
      .run();

    if (result.changes === 0) throw notFound('通行密钥不存在');

    recordAudit('auth.passkey_remove', auditContextFrom(req), { target: String(id) });

    return { ok: true, data: { deleted: true } } satisfies ApiSuccess<{ deleted: boolean }>;
  });
}

/** 数据库行 → 对外 DTO，时间统一序列化为 RFC3339 */
function toPasskeySummary(row: PasskeyRow): PasskeySummary {
  return {
    id: row.id,
    name: row.name,
    deviceType: row.deviceType,
    backedUp: row.backedUp,
    createdAt: row.createdAt.toISOString(),
    lastUsedAt: row.lastUsedAt ? row.lastUsedAt.toISOString() : null,
  };
}
