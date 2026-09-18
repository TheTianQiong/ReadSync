import { getKeyFingerprint } from '../crypto/keys.js';

/**
 * 安全地获取公钥指纹。
 *
 * 单独抽出一个文件是为了打断循环依赖：
 * settings.ts → fingerprint.ts → crypto/keys.ts → config/logger（不反向依赖 settings）。
 * 密钥尚未生成时（例如 CLI 首次运行前）返回占位串而不是抛错。
 */
export function getPublicKeyFingerprintSafe(): string {
  try {
    return getKeyFingerprint();
  } catch {
    return '(密钥尚未初始化)';
  }
}
