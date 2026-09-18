import type { EncryptedPayload, PublicKeyInfo } from '@readsync/shared';
import { get } from './api';

/**
 * 密码传输加密。
 *
 * 服务端只接受 RSA-OAEP(SHA-256) 密文，明文密码不出浏览器。
 * 公钥（SPKI/PEM）由 GET /api/system/public-key 下发，前端导入为不可导出的
 * CryptoKey 后缓存在内存里 —— 同一次会话内多次提交表单不必反复取公钥。
 */

const RSA_PARAMS: RsaHashedImportParams = { name: 'RSA-OAEP', hash: 'SHA-256' };

let cached: { key: CryptoKey; fingerprint: string } | null = null;
let inflight: Promise<{ key: CryptoKey; fingerprint: string }> | null = null;

/** WebCrypto 只在安全上下文（HTTPS / localhost / 127.0.0.1）下暴露 subtle */
export function isEncryptionAvailable(): boolean {
  return typeof globalThis.crypto !== 'undefined' && typeof globalThis.crypto.subtle !== 'undefined';
}

const UNSUPPORTED_MESSAGE =
  '当前环境不支持 WebCrypto，无法加密密码。请使用 HTTPS 或通过 localhost 访问本站。';

function assertWebCrypto(): Crypto {
  if (!isEncryptionAvailable()) throw new Error(UNSUPPORTED_MESSAGE);
  return globalThis.crypto;
}

/**
 * 去掉 PEM 头尾与所有空白，Base64 解码成 DER 字节。
 * 显式标注 `Uint8Array<ArrayBuffer>`：WebCrypto 只接受非共享的 ArrayBuffer，
 * 而 TS 里裸写 Uint8Array 会退化成 `Uint8Array<ArrayBufferLike>`（可能是 SharedArrayBuffer），
 * 那样 importKey 会报类型不匹配。
 */
function pemToDer(pem: string): Uint8Array<ArrayBuffer> {
  const body = pem
    .replace(/-----BEGIN [^-]+-----/g, '')
    .replace(/-----END [^-]+-----/g, '')
    .replace(/\s+/g, '');

  if (!body) throw new Error('服务端下发的公钥格式不正确（PEM 内容为空）');

  let binary: string;
  try {
    binary = atob(body);
  } catch {
    throw new Error('服务端下发的公钥不是合法的 Base64');
  }

  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function bufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  // 逐个字符拼接超长字符串会爆栈，按 32KB 分块
  const CHUNK = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...Array.from(bytes.subarray(i, i + CHUNK)));
  }
  return btoa(binary);
}

async function loadKey(): Promise<{ key: CryptoKey; fingerprint: string }> {
  if (cached) return cached;
  // 并发调用（例如注册页同时预取公钥）只发一次请求
  if (inflight) return inflight;

  inflight = (async () => {
    const info = await get<PublicKeyInfo>('/system/public-key', undefined, { auth: false });

    if (info.algorithm !== 'RSA-OAEP-256') {
      throw new Error(`服务端要求不支持的加密算法：${info.algorithm}`);
    }

    const cryptoObj = assertWebCrypto();
    const key = await cryptoObj.subtle.importKey('spki', pemToDer(info.publicKey), RSA_PARAMS, false, [
      'encrypt',
    ]);

    cached = { key, fingerprint: info.fingerprint };
    return cached;
  })();

  try {
    return await inflight;
  } finally {
    inflight = null;
  }
}

/** 公钥轮换后旧密文会被服务端拒绝，届时调用它清掉缓存重新拉取 */
export function resetKeyCache(): void {
  cached = null;
}

/**
 * 加密密码，返回可直接放进请求体的载荷。
 * 失败时抛出带中文原因的错误，调用方应把 message 直接展示给用户。
 */
export async function encryptPassword(password: string): Promise<EncryptedPayload> {
  assertWebCrypto();
  const { key, fingerprint } = await loadKey();

  let ciphertext: ArrayBuffer;
  try {
    ciphertext = await globalThis.crypto.subtle.encrypt(
      { name: 'RSA-OAEP' },
      key,
      new TextEncoder().encode(password),
    );
  } catch (err) {
    // 常见于密码超过 RSA-2048 的 190 字节明文上限
    throw new Error(`密码加密失败：${err instanceof Error ? err.message : '未知错误'}`);
  }

  return {
    ciphertext: bufferToBase64(ciphertext),
    keyFingerprint: fingerprint,
    encrypted: true,
  };
}

/** 服务端公钥指纹，设置页「账号安全」展示用，方便确认前端对接的是哪把密钥 */
export async function getPublicKeyFingerprint(): Promise<string> {
  const { fingerprint } = await loadKey();
  return fingerprint;
}
