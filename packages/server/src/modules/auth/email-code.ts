import { and, desc, eq, isNull } from 'drizzle-orm';
import { getDb } from '../../db/index.js';
import { emailCodes } from '../../db/schema.js';
import { generateNumericCode, safeEqualHex, sha256Hex } from '../../crypto/password.js';
import { badRequest } from '../../errors.js';
import { getModuleLogger } from '../../logger.js';

/**
 * 邮箱验证码的签发与核销。
 *
 * 所有需要「证明你能收到这个邮箱的信」的地方都走这里：注册、改邮箱、改密码、
 * 关闭两步验证、忘记密码。抽成一个模块是因为这几处的规则必须完全一致 ——
 * 任何一个环节自己实现，都可能漏掉「旧码作废」或「尝试次数上限」这类细节，
 * 而漏掉它们等于把猜码空间放大到不设防。
 */

const log = getModuleLogger('auth');

/** 验证码用途。按用途隔离：给「改密码」发的码不能拿去「改邮箱」 */
export type EmailCodePurpose =
  | 'password_reset'
  | 'email_verify'
  | 'register'
  | 'change_email'
  | 'change_password'
  | 'disable_2fa';

/**
 * 有效期与尝试上限。
 *
 * 10 分钟：够用户去邮箱里翻一趟，又不至于让一个泄漏的码长期可用。
 * 5 次：6 位数字有一百万种可能，5 次尝试命中的概率是百万分之五。
 */
export const EMAIL_CODE_TTL_MS = 10 * 60 * 1000;
export const EMAIL_CODE_MAX_ATTEMPTS = 5;

/**
 * 签发一个验证码，返回**明文**（只用于发信，绝不入库）。
 *
 * 同一邮箱同一用途下已有的未消费码会立即作废：多次点「发送验证码」若留下
 * 多个可用码，等于把猜码空间乘以请求次数。
 */
export function issueEmailCode(email: string, purpose: EmailCodePurpose, ip: string | null): string {
  const db = getDb();
  const now = new Date();
  const code = generateNumericCode(6);

  db.update(emailCodes)
    .set({ consumedAt: now })
    .where(
      and(
        eq(emailCodes.email, email),
        eq(emailCodes.purpose, purpose),
        isNull(emailCodes.consumedAt),
      ),
    )
    .run();

  db.insert(emailCodes)
    .values({
      email,
      // 只存哈希：邮件内容泄漏、或者库被读走，都不能直接得到验证码
      codeHash: sha256Hex(code),
      purpose,
      expiresAt: new Date(now.getTime() + EMAIL_CODE_TTL_MS),
      consumedAt: null,
      attempts: 0,
      ip,
      createdAt: now,
    })
    .run();

  return code;
}

/**
 * 校验一个验证码；不通过直接抛 400。
 *
 * 校验顺序是「存在 → 过期 → 尝试次数 → 内容」，无论哪种失败都先查一遍
 * 尝试次数再比较内容，避免攻击者用「码不存在」这种快速失败来区分状态。
 *
 * **成功时并不核销**，而是返回一个核销函数 —— 调用方要在真正把事办成之后
 * 再调用它。这样「密码太短」「用户名已被占用」这类业务校验失败不会白烧掉
 * 一个验证码（否则用户还得再去邮箱翻一次新的）。
 */
export function verifyEmailCode(
  email: string,
  purpose: EmailCodePurpose,
  code: string,
): () => void {
  const db = getDb();

  const record = db
    .select()
    .from(emailCodes)
    .where(
      and(
        eq(emailCodes.email, email),
        eq(emailCodes.purpose, purpose),
        isNull(emailCodes.consumedAt),
      ),
    )
    .orderBy(desc(emailCodes.createdAt))
    .get();

  if (!record) throw badRequest('验证码无效或已过期，请重新获取');
  if (record.expiresAt.getTime() <= Date.now()) throw badRequest('验证码已过期，请重新获取');
  if (record.attempts >= EMAIL_CODE_MAX_ATTEMPTS) {
    throw badRequest('验证码尝试次数过多，请重新获取');
  }

  if (!safeEqualHex(sha256Hex(code), record.codeHash)) {
    const attempts = record.attempts + 1;
    db.update(emailCodes)
      .set({
        attempts,
        // 达到上限直接作废，避免攻击者靠「每次只错一点」无限试探
        ...(attempts >= EMAIL_CODE_MAX_ATTEMPTS ? { consumedAt: new Date() } : {}),
      })
      .where(eq(emailCodes.id, record.id))
      .run();
    throw badRequest('验证码不正确');
  }

  log.debug({ email, purpose }, '邮箱验证码校验通过');
  return () => {
    db.update(emailCodes)
      .set({ consumedAt: new Date() })
      .where(eq(emailCodes.id, record.id))
      .run();
  };
}

/** 校验并立即核销。适用于「校验通过 = 动作就算完成」的场景 */
export function consumeEmailCode(email: string, purpose: EmailCodePurpose, code: string): void {
  verifyEmailCode(email, purpose, code)();
}

/**
 * 把邮箱打码成 `a***@example.com`，用于「验证码已发送至 …」这类回显。
 *
 * 前端本来就知道自己的邮箱，打码是为了别的：万一有人站在身后看屏幕，
 * 别把完整地址连同「这个账号存在」一起白送出去。
 */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf('@');
  if (at <= 0) return '***';
  const name = email.slice(0, at);
  const domain = email.slice(at);
  const head = name.slice(0, 1);
  return `${head}***${domain}`;
}
