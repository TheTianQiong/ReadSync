/**
 * 登录页「这次用哪个账号登录」的判定。
 *
 * 为什么值得单独拎成一个纯函数：登录页为了「本机登录过就只填密码」会把账号
 * 输入框整个收起来（显示账号头像 + 打码后的账号），此时那个输入框的 state
 * **必然是空的** —— 没人会去填一个不存在的字段。如果提交时直接拿 state 当账号，
 * 「用户名 or 邮箱」的校验就会两个分支同时失败，用户看到的是一句
 * 「Invalid input」：请求根本没发出去，TOTP 输入框自然也不会出现。
 *
 * 这段判定藏在 React 组件里就只能靠手点来验证，所以放到契约层，让回归测试钉住。
 */
export interface LoginAccountInput {
  /** 本机上次登录过的账号（localStorage 里那份，不含凭据）；没有就是空 */
  remembered?: string | null;
  /** 账号输入框里实际填的值；账号被收起来时为空串 */
  typed?: string | null;
  /** 用户点了「使用其他账号」，即明确表示要手动填 */
  useOtherAccount?: boolean;
}

/**
 * 解析出真正用于登录的账号。
 *
 * 规则：本机记住了账号、且用户没有点「使用其他账号」时，一律以记住的那个为准；
 * 否则以手填的为准。两边都空时返回空串，由界面给出「请输入用户名或邮箱」。
 */
export function resolveLoginAccount(input: LoginAccountInput): string {
  const remembered = input.remembered?.trim() ?? '';
  if (remembered && !input.useOtherAccount) return remembered;
  return (input.typed ?? '').trim();
}
