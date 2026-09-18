import { passwordSchema, type EncryptedPayload } from '@readsync/shared';
import { resolvePassword } from '../crypto/keys.js';
import { validationFailed } from '../errors.js';

/**
 * 处理「设置新密码」类请求的统一入口。
 *
 * 为什么需要它：密码在所有请求体里都是 RSA 密文（`EncryptedPayload`），
 * zod 只能在密文上校验「是不是合法密文」，无法校验长度、大小写、数字等强度规则。
 * 因此必须在**解密之后**补一次 `passwordSchema` 校验 —— 否则绕过前端直接调接口，
 * 就能注册出 1 位密码的账号。
 *
 * 所有需要新密码的接口（注册、改密、重置密码、管理员建号/重置、初始化引导）
 * 都应当走这个函数，保证策略只有一处定义。
 */
export function resolveNewPassword(payload: EncryptedPayload | string, fieldLabel = '密码'): string {
  const plain = resolvePassword(payload);

  const check = passwordSchema.safeParse(plain);
  if (!check.success) {
    const first = check.error.issues[0];
    throw validationFailed(`${fieldLabel}不符合要求：${first?.message ?? '格式不正确'}`, check.error.issues);
  }

  return plain;
}
