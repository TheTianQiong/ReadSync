import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, privateDecrypt, constants } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { PublicKeyInfo } from '@readsync/shared';
import { loadConfig } from '../config.js';
import { getModuleLogger } from '../logger.js';
import { AppError, ERROR_CODES } from '../errors.js';

/**
 * 服务器本地 RSA 密钥对。
 *
 * 对应 README 要求：密码不可明文传递、私钥存在服务器本地。
 *
 * 工作方式：
 *   前端 GET /api/auth/public-key 拿到公钥 → 用 WebCrypto 做 RSA-OAEP(SHA-256)
 *   加密密码 → 只把 Base64 密文发给服务端 → 服务端用本地私钥解密 → 立即
 *   用 Argon2id 哈希后入库。明文密码既不落在网络日志里，也不落库。
 *
 * 重要澄清：这不是「用非对称加密存储密码」。密码的存储始终是单向的 Argon2id
 * 哈希；RSA 只解决传输环节的机密性。私钥一旦泄露，攻击者能解密传输中的密文，
 * 但无法从数据库反推密码。详见 docs/security.md。
 */

const KEY_DIR_MODE = 0o700;
const PRIVATE_KEY_MODE = 0o600;

let cachedPrivateKey: ReturnType<typeof createPrivateKey> | null = null;
let cachedPublicKeyPem: string | null = null;
let cachedFingerprint: string | null = null;

/** 确保密钥对存在；不存在则生成并落盘 */
export function ensureKeyPair(): void {
  const config = loadConfig();
  const log = getModuleLogger('crypto');

  const keyDir = path.dirname(config.privateKeyFile);
  if (!existsSync(keyDir)) {
    mkdirSync(keyDir, { recursive: true, mode: KEY_DIR_MODE });
  }

  if (existsSync(config.privateKeyFile) && existsSync(config.publicKeyFile)) {
    return;
  }

  log.info({ keyDir }, '未找到 RSA 密钥对，正在生成 3072 位密钥（首次启动一次性操作）');

  const { privateKey, publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 3072,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });

  writeFileSync(config.privateKeyFile, privateKey, { mode: PRIVATE_KEY_MODE });
  writeFileSync(config.publicKeyFile, publicKey, { mode: 0o644 });

  log.info('RSA 密钥对已生成并保存至数据目录');
}

function getPrivateKey(): ReturnType<typeof createPrivateKey> {
  if (cachedPrivateKey) return cachedPrivateKey;
  const config = loadConfig();
  ensureKeyPair();
  cachedPrivateKey = createPrivateKey(readFileSync(config.privateKeyFile, 'utf8'));
  return cachedPrivateKey;
}

function getPublicKeyPem(): string {
  if (cachedPublicKeyPem) return cachedPublicKeyPem;
  const config = loadConfig();
  ensureKeyPair();
  cachedPublicKeyPem = readFileSync(config.publicKeyFile, 'utf8').trim();
  return cachedPublicKeyPem;
}

/**
 * 公钥指纹：对 SPKI DER 编码取 SHA-256，展示前 16 位十六进制。
 * 用途是让前端确认自己拿到的公钥与服务端当前使用的私钥配对（密钥轮换后可识别）。
 */
export function getKeyFingerprint(): string {
  if (cachedFingerprint) return cachedFingerprint;
  const der = createPublicKey(getPublicKeyPem()).export({ type: 'spki', format: 'der' });
  cachedFingerprint = createHash('sha256').update(der).digest('hex').slice(0, 16);
  return cachedFingerprint;
}

/** 下发给前端的公钥信息 */
export function getPublicKeyInfo(): PublicKeyInfo {
  return {
    publicKey: getPublicKeyPem(),
    fingerprint: getKeyFingerprint(),
    algorithm: 'RSA-OAEP-256',
  };
}

/**
 * 解密前端提交的密码密文。
 *
 * 安全约束：
 *  - 固定使用 RSA-OAEP + SHA-256，与前端 WebCrypto 参数一致；
 *  - 密文长度上限 4KB，避免超大 payload 造成无谓的 RSA 运算开销；
 *  - 解密失败一律返回统一错误，不区分「密钥不对」与「密文损坏」，避免成为 oracle。
 */
export function decryptPassword(ciphertextBase64: string): string {
  const config = loadConfig();

  if (ciphertextBase64.length > 4096) {
    throw new AppError(ERROR_CODES.BAD_REQUEST, '密文长度超出限制', 400);
  }

  let buffer: Buffer;
  try {
    buffer = Buffer.from(ciphertextBase64, 'base64');
  } catch {
    throw new AppError(ERROR_CODES.BAD_REQUEST, '密文不是合法的 Base64', 400);
  }

  // RSA-3072 的密文固定为 384 字节；长度不符直接拒绝，省去一次昂贵的私钥运算
  const expectedLength = 384;
  if (buffer.length !== expectedLength) {
    throw new AppError(ERROR_CODES.BAD_REQUEST, '密文长度与公钥不匹配，请刷新页面后重试', 400);
  }

  try {
    const plaintext = privateDecrypt(
      {
        key: getPrivateKey(),
        padding: constants.RSA_PKCS1_OAEP_PADDING,
        oaepHash: 'sha256',
      },
      buffer,
    );
    return plaintext.toString('utf8');
  } catch (err) {
    getModuleLogger('crypto').warn({ err }, '密码密文解密失败');
    throw new AppError(
      ERROR_CODES.BAD_REQUEST,
      '密码解密失败，可能是页面停留过久导致密钥已轮换，请刷新后重试',
      400,
    );
  }
}

/**
 * 宽容模式：开发环境或显式关闭加密时允许直接传明文。
 * 仅当 READSYNC_ALLOW_PLAINTEXT_PASSWORD=true 时启用，默认关闭。
 */
export function allowPlaintextPassword(): boolean {
  return process.env.READSYNC_ALLOW_PLAINTEXT_PASSWORD === 'true';
}

/** 从加密载荷或明文中取出密码明文 */
export function resolvePassword(payload: { ciphertext: string; encrypted?: boolean } | string): string {
  if (typeof payload === 'string') {
    if (!allowPlaintextPassword()) {
      throw new AppError(ERROR_CODES.BAD_REQUEST, '密码必须以密文形式提交', 400);
    }
    return payload;
  }
  if (payload.encrypted === false) {
    if (!allowPlaintextPassword()) {
      throw new AppError(ERROR_CODES.BAD_REQUEST, '密码必须以密文形式提交', 400);
    }
    return payload.ciphertext;
  }
  return decryptPassword(payload.ciphertext);
}

/** 测试用：清除内存中缓存的密钥，便于用不同数据目录重跑 */
export function resetKeyCache(): void {
  cachedPrivateKey = null;
  cachedPublicKeyPem = null;
  cachedFingerprint = null;
}
