import type { VerificationRequirements } from '@readsync/shared';
import { isMailConfigured } from '../../lib/mail.js';
import { getSiteSettings } from '../../lib/settings.js';
import { getModuleLogger } from '../../logger.js';

/**
 * 「哪些动作需要邮箱验证码」的唯一判定处。
 *
 * 抽出来是因为这句话同时被两边消费：接口把结果告诉前端（决定显不显示验证码
 * 输入框），路由再据此决定拦不拦。若两边各写一份判断，迟早会出现
 * 「界面没要验证码、服务端却要求」这种卡死用户的不一致。
 */

const log = getModuleLogger('auth');

export interface VerificationSubject {
  /** 邮箱验证过的时间；null 表示从未验证过 */
  emailVerifiedAt: Date | null;
}

/**
 * 当前站点 + 当前账号下，各动作是否需要邮箱验证码。
 *
 * 规则：
 *  - `off`：都不要。这是默认值，既有部署升级后行为不变。
 *  - `register`：注册要；**改邮箱也要**（发给新地址）。改邮箱必须跟着要 ——
 *    否则注册时验过邮箱的人随手把地址换成一个没验过的，那道验证就白做了。
 *  - `all`：以上都要，再加改密码与关闭两步验证。
 *
 * 改密码与关闭两步验证这两项只对**邮箱已验证过**的账号生效。这条限制是为了
 * 不把人锁在门外：老账号的邮箱从没验证过（甚至可能是当初随手填错的），拿它
 * 当「第二因素」既证明不了什么，还会让用户改不了密码。这类账号沿用原来的
 * 凭据（旧密码 / TOTP 码），管理员也可随时把开关调回 off。
 */
export function verificationRequirements(user: VerificationSubject): VerificationRequirements {
  const mode = getSiteSettings().emailVerification;

  /*
   * 邮件没配好就一律不要求。
   *
   * 这是有意的 fail-open：站点设置里不允许在未配邮件时开启（管理员那一关
   * 会拦），但管理员事后把邮件配置改坏是可能的 —— 那时若还坚持要验证码，
   * 结果就是所有人都改不了密码、关不掉两步验证，谁也救不了。发不出去的码
   * 不是安全措施，只是故障。
   */
  const mailReady = isMailConfigured();
  if (mode !== 'off' && !mailReady) {
    log.warn({ mode }, '站点要求邮箱验证码，但邮件服务不可用 —— 已临时放行，请检查邮件配置');
  }

  const verified = user.emailVerifiedAt !== null;

  return {
    registration: mailReady && mode !== 'off',
    changeEmail: mailReady && mode !== 'off',
    changePassword: mailReady && mode === 'all' && verified,
    disableTwoFactor: mailReady && mode === 'all' && verified,
  };
}
