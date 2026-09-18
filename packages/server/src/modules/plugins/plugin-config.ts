import { SENSITIVE_CONFIG_KEYS, type PluginConfigField, type PluginManifest } from '@readsync/shared';
import {
  decryptConfig,
  decryptString,
  encryptConfig,
  encryptString,
  isEncrypted,
  maskConfig,
} from '../../crypto/secret-box.js';

/**
 * 插件配置的加解密与脱敏。
 *
 * 与存储凭据的区别：插件的敏感字段由清单自己声明（config[].type === 'password'），
 * 字段名不一定是 SENSITIVE_CONFIG_KEYS 里的约定名（如 webdavPassword 就不在表里）。
 * 所以这里在通用加密盒子之上再叠加「清单声明的 password 字段」，
 * 两类字段都按密文落库、按明文交给插件、按掩码返回前端。
 */

/** 前端收到掩码后原样提交时用的占位符，必须与 maskPluginConfig 输出一致 */
export const MASK_PLACEHOLDER = '••••••••';

/** 清单里声明为 password 的字段名 */
export function passwordFieldKeys(manifest: PluginManifest): string[] {
  return manifest.config.filter((f) => f.type === 'password').map((f) => f.key);
}

/** 需要加密的全部字段名 = 通用敏感字段名 ∪ 清单声明的 password 字段 */
export function sensitiveKeys(manifest: PluginManifest): Set<string> {
  return new Set<string>([...SENSITIVE_CONFIG_KEYS, ...passwordFieldKeys(manifest)]);
}

/** 判断前端提交的值是不是掩码（是则代表「不修改」，要保留原密文） */
export function isMaskedValue(value: unknown): boolean {
  return typeof value === 'string' && (value === MASK_PLACEHOLDER || /^[•*]+$/.test(value));
}

/** 写入库前加密敏感字段；幂等，已是密文的不重复加密 */
export function encryptPluginConfig(
  manifest: PluginManifest,
  input: Record<string, unknown>,
): Record<string, unknown> {
  // 先走通用盒子，覆盖 password / apiKey 等约定字段名
  const out: Record<string, unknown> = { ...encryptConfig(input) };
  for (const key of sensitiveKeys(manifest)) {
    const value = out[key];
    if (typeof value === 'string' && value.length > 0 && !isEncrypted(value)) {
      out[key] = encryptString(value);
    }
  }
  return out;
}

/** 读取时解密敏感字段；解密失败置空串，让插件侧能给出可读的失败提示 */
export function decryptPluginConfig(
  manifest: PluginManifest,
  stored: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...decryptConfig(stored) };
  for (const key of sensitiveKeys(manifest)) {
    const value = stored[key];
    if (isEncrypted(value)) {
      try {
        out[key] = decryptString(value as string);
      } catch {
        out[key] = '';
      }
    }
  }
  return out;
}

/** 返回给前端的脱敏配置；敏感字段一律用统一占位符，避免泄漏长度或首尾字符 */
export function maskPluginConfig(
  manifest: PluginManifest,
  stored: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...maskConfig(stored) };
  for (const key of sensitiveKeys(manifest)) {
    const value = stored[key];
    if (typeof value === 'string' && value.length > 0) {
      out[key] = MASK_PLACEHOLDER;
    }
  }
  return out;
}

/**
 * 交给插件使用（ctx.getConfig）的最终配置：解密敏感字段 + 补上清单默认值。
 * 每次调用都重新读取，因此管理员改配置后插件无需重启即可看到新值。
 */
export function resolvePluginConfig(
  manifest: PluginManifest,
  stored: Record<string, unknown>,
): Record<string, unknown> {
  const values = decryptPluginConfig(manifest, stored);
  for (const field of manifest.config) {
    if (values[field.key] === undefined && field.default !== undefined) {
      values[field.key] = field.default;
    }
  }
  return values;
}

/** 按声明的字段类型做轻量类型纠正（表单提交的数字/布尔常是字符串） */
export function coerceFieldValue(field: PluginConfigField, value: unknown): unknown {
  if (value === null || value === undefined) return value;
  switch (field.type) {
    case 'number': {
      const n = typeof value === 'number' ? value : Number(value);
      return Number.isFinite(n) ? n : value;
    }
    case 'boolean': {
      if (typeof value === 'boolean') return value;
      if (value === 'true') return true;
      if (value === 'false') return false;
      return Boolean(value);
    }
    default:
      return value;
  }
}
