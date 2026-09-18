import { forgotPasswordSchema, loginSchema, passwordSchema, registerSchema, resetPasswordSchema } from '@readsync/shared';

/**
 * 表单校验。
 *
 * 直接复用 @readsync/shared 里的 zod schema，而不是在前端再抄一份规则：
 * 后端就是用同一份 schema 校验请求体的，复用能保证「前端放行、后端拒绝」不会发生，
 * 中文错误文案也只有一处需要维护。
 *
 * 这里不直接 import zod —— 通过 schema 实例的方法使用它，
 * 这样前端不必把 zod 声明成自己的依赖。
 */

/** zod 的 safeParse 结构，用一个最小接口描述，避免把 zod 类型泄漏到页面里 */
interface SafeParseLike {
  safeParse: (value: unknown) => unknown;
}

interface ParseResult {
  success: boolean;
  error?: { issues?: Array<{ message?: string }> };
}

/** 返回第一条错误文案；通过校验返回 null */
export function validateField(schema: SafeParseLike, value: unknown): string | null {
  const result = schema.safeParse(value) as ParseResult;
  if (result.success) return null;
  return result.error?.issues?.[0]?.message ?? '输入不合法';
}

/** 一次性校验多个字段，返回第一个错误（用于提交按钮的即时反馈） */
export function validateAll(entries: ReadonlyArray<[SafeParseLike, unknown]>): string | null {
  for (const [schema, value] of entries) {
    const message = validateField(schema, value);
    if (message) return message;
  }
  return null;
}

/* 从 shared 的复合 schema 里取出单个字段规则，避免重复定义 */

export const emailField = forgotPasswordSchema.shape.email;
export const loginIdentifierField = loginSchema.shape.username;
export const resetCodeField = resetPasswordSchema.shape.code;

export const usernameField = registerSchema.shape.username;
export const registerEmailField = registerSchema.shape.email;

export { passwordSchema };

/** 密码强度的即时提示（不阻塞输入，只在下方给出要求） */
export const PASSWORD_RULES = [
  '至少 8 个字符',
  '包含大写字母',
  '包含小写字母',
  '包含数字',
] as const;

export interface PasswordStrength {
  met: number;
  total: number;
  label: string;
}

export function checkPasswordStrength(password: string): PasswordStrength {
  const checks = [
    password.length >= 8,
    /[A-Z]/.test(password),
    /[a-z]/.test(password),
    /[0-9]/.test(password),
  ];
  const met = checks.filter(Boolean).length;
  const labels = ['太弱', '较弱', '一般', '较强', '很强'];
  return { met, total: checks.length, label: labels[met] ?? '太弱' };
}
