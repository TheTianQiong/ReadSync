import { api } from './api';

/**
 * 通行密钥（WebAuthn）注册。
 *
 * 服务端下发的 challenge / 凭据 id 是 base64url 字符串，而 navigator.credentials
 * 要求 ArrayBuffer，这一层负责两者互转。
 *
 * 优先使用浏览器原生的 PublicKeyCredential.parseCreationOptionsFromJSON /
 * credential.toJSON（Chrome 129+、Safari 18+），它们能正确处理所有字段；
 * 老浏览器回退到手工转换（只覆盖实际会变动的 challenge 与凭据 id）。
 * 没有引入 @simplewebauthn/browser —— 前端本来就要为老浏览器准备回退路径，
 * 再加一个依赖不划算。
 */

interface CredentialDescriptorJson {
  id: string;
  type?: string;
  transports?: string[];
}

interface CreationOptionsJson {
  rp: { id?: string; name: string };
  user: { id: string; name: string; displayName: string };
  challenge: string;
  pubKeyCredParams: Array<{ type: 'public-key'; alg: number }>;
  timeout?: number;
  attestation?: AttestationConveyancePreference;
  authenticatorSelection?: AuthenticatorSelectionCriteria;
  excludeCredentials?: CredentialDescriptorJson[];
  extensions?: AuthenticationExtensionsClientInputs;
}

export function isPasskeySupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.PublicKeyCredential !== 'undefined' &&
    typeof navigator.credentials?.create === 'function'
  );
}

export function base64UrlToBuffer(value: string): ArrayBuffer {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

export function bufferToBase64Url(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const CHUNK = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...Array.from(bytes.subarray(i, i + CHUNK)));
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

type NativeCreationParser = (json: unknown) => PublicKeyCredentialCreationOptions;

function toCreationOptions(json: CreationOptionsJson): PublicKeyCredentialCreationOptions {
  const native = (
    PublicKeyCredential as unknown as { parseCreationOptionsFromJSON?: NativeCreationParser }
  ).parseCreationOptionsFromJSON;

  if (typeof native === 'function') {
    try {
      return native.call(PublicKeyCredential, json);
    } catch {
      /* 结构不符合原生解析器的预期，退回手工转换 */
    }
  }

  return {
    ...json,
    challenge: base64UrlToBuffer(json.challenge),
    user: { ...json.user, id: base64UrlToBuffer(json.user.id) },
    excludeCredentials: (json.excludeCredentials ?? []).map((descriptor) => ({
      ...descriptor,
      id: base64UrlToBuffer(descriptor.id),
      type: 'public-key' as const,
    })),
  } as PublicKeyCredentialCreationOptions;
}

/** 把凭据序列化成后端 @simplewebauthn 能校验的结构 */
function serializeCredential(credential: PublicKeyCredential): Record<string, unknown> {
  const nativeToJson = (credential as unknown as { toJSON?: () => unknown }).toJSON;
  if (typeof nativeToJson === 'function') {
    return nativeToJson.call(credential) as Record<string, unknown>;
  }

  const response = credential.response as AuthenticatorAttestationResponse;

  return {
    id: credential.id,
    rawId: bufferToBase64Url(credential.rawId),
    type: credential.type,
    authenticatorAttachment: credential.authenticatorAttachment ?? undefined,
    clientExtensionResults: credential.getClientExtensionResults(),
    response: {
      clientDataJSON: bufferToBase64Url(response.clientDataJSON),
      attestationObject: bufferToBase64Url(response.attestationObject),
      transports: typeof response.getTransports === 'function' ? response.getTransports() : [],
    },
  };
}

/** 走完「取 challenge → 唤起系统验证器 → 回传凭据」的完整注册流程 */
export async function registerPasskey(name: string): Promise<void> {
  if (!isPasskeySupported()) {
    throw new Error('当前浏览器不支持通行密钥（WebAuthn），请改用密码或验证器应用');
  }
  if (!window.isSecureContext) {
    throw new Error('通行密钥只在安全上下文（HTTPS 或 localhost）下可用');
  }

  const optionsJson = await api.post<CreationOptionsJson>('/auth/passkeys/register/options');
  const publicKey = toCreationOptions(optionsJson);

  let credential: Credential | null;
  try {
    credential = await navigator.credentials.create({ publicKey });
  } catch (err) {
    // 用户取消或超时都会抛错，给一句人话而不是原始 DOMException
    if (err instanceof DOMException && (err.name === 'NotAllowedError' || err.name === 'AbortError')) {
      throw new Error('通行密钥注册已取消或超时');
    }
    throw new Error(`通行密钥注册失败：${err instanceof Error ? err.message : '未知错误'}`);
  }

  if (!credential || credential.type !== 'public-key') {
    throw new Error('未能创建通行密钥');
  }

  await api.post('/auth/passkeys/register/verify', {
    response: serializeCredential(credential as PublicKeyCredential),
    ...(name.trim() ? { name: name.trim() } : {}),
  });
}
