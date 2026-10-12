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

/* ---------------------------- 用通行密钥登录 ---------------------------- */

interface RequestOptionsJson {
  challenge: string;
  timeout?: number;
  rpId?: string;
  allowCredentials?: CredentialDescriptorJson[];
  userVerification?: UserVerificationRequirement;
  extensions?: AuthenticationExtensionsClientInputs;
}

/**
 * 条件式 UI（autofill）是否可用。
 *
 * 可用时浏览器会把这台设备上**该站点的所有通行密钥**列在用户名输入框的自动填充里，
 * 用户点一下就完成登录 —— 不必先输账号，也不必点任何按钮。
 */
export async function isConditionalUiSupported(): Promise<boolean> {
  if (!isPasskeySupported() || !window.isSecureContext) return false;
  const check = (
    PublicKeyCredential as unknown as { isConditionalMediationAvailable?: () => Promise<boolean> }
  ).isConditionalMediationAvailable;
  if (typeof check !== 'function') return false;
  try {
    return await check.call(PublicKeyCredential);
  } catch {
    return false;
  }
}

function toRequestOptions(json: RequestOptionsJson): PublicKeyCredentialRequestOptions {
  const native = (
    PublicKeyCredential as unknown as {
      parseRequestOptionsFromJSON?: (value: unknown) => PublicKeyCredentialRequestOptions;
    }
  ).parseRequestOptionsFromJSON;

  if (typeof native === 'function') {
    try {
      return native.call(PublicKeyCredential, json);
    } catch {
      /* 退回手工转换 */
    }
  }

  return {
    ...json,
    challenge: base64UrlToBuffer(json.challenge),
    allowCredentials: (json.allowCredentials ?? []).map((descriptor) => ({
      ...descriptor,
      id: base64UrlToBuffer(descriptor.id),
      type: 'public-key' as const,
    })),
  } as PublicKeyCredentialRequestOptions;
}

/** 把断言结果序列化成后端 @simplewebauthn 能校验的结构 */
function serializeAssertion(credential: PublicKeyCredential): Record<string, unknown> {
  const nativeToJson = (credential as unknown as { toJSON?: () => unknown }).toJSON;
  if (typeof nativeToJson === 'function') {
    return nativeToJson.call(credential) as Record<string, unknown>;
  }

  const response = credential.response as AuthenticatorAssertionResponse;
  return {
    id: credential.id,
    rawId: bufferToBase64Url(credential.rawId),
    type: credential.type,
    authenticatorAttachment: credential.authenticatorAttachment ?? undefined,
    clientExtensionResults: credential.getClientExtensionResults(),
    response: {
      clientDataJSON: bufferToBase64Url(response.clientDataJSON),
      authenticatorData: bufferToBase64Url(response.authenticatorData),
      signature: bufferToBase64Url(response.signature),
      userHandle: response.userHandle ? bufferToBase64Url(response.userHandle) : null,
    },
  };
}

/**
 * 用通行密钥登录。
 *
 * 两种用法，对应后端同一个端点：
 *  - **不给 `username`**：走「可发现凭据」，系统弹出这台设备上该站点的通行密钥列表
 *    让用户挑 —— 这就是首次在新设备上登录的情形（不必先输账号）。
 *  - **给了 `username`**：只允许那个账号的凭据，用于「本机上次用过的账号」那条快捷路径。
 *
 * `conditional: true` 时用条件式 UI（结果交给浏览器的自动填充，不弹系统框），
 * 这时**不要**等它 resolve —— 用户可能直接改用密码登录，那个 Promise 会一直挂着，
 * 由 `signal` 中止。
 */
export async function loginWithPasskey(options: {
  username?: string;
  conditional?: boolean;
  signal?: AbortSignal;
} = {}): Promise<Record<string, unknown> | null> {
  if (!isPasskeySupported()) {
    throw new Error('当前浏览器不支持通行密钥（WebAuthn）');
  }
  if (!window.isSecureContext) {
    throw new Error('通行密钥只在安全上下文（HTTPS 或 localhost）下可用');
  }

  const optionsJson = await api.post<RequestOptionsJson>('/auth/passkeys/login/options', {
    ...(options.username ? { username: options.username } : {}),
  });
  const publicKey = toRequestOptions(optionsJson);

  let credential: Credential | null;
  try {
    credential = await navigator.credentials.get({
      publicKey,
      ...(options.conditional ? { mediation: 'conditional' as const } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    });
  } catch (err) {
    if (err instanceof DOMException && (err.name === 'AbortError' || err.name === 'NotAllowedError')) {
      // 条件式 UI 被中止、或用户点了取消：这不是错误，调用方按「用户改用别的路」处理
      return null;
    }
    throw new Error(`通行密钥登录失败：${err instanceof Error ? err.message : '未知错误'}`);
  }

  if (!credential || credential.type !== 'public-key') return null;

  return api.post<Record<string, unknown>>('/auth/passkeys/login/verify', {
    ...(options.username ? { username: options.username } : {}),
    response: serializeAssertion(credential as PublicKeyCredential),
  });
}

/* ------------------------- 本机上次登录的账号 ------------------------- */

export interface LastAccount {
  username: string;
  displayName: string | null;
  avatarUrl: string | null;
  /** 上次登录时该账号是否已经有通行密钥（决定按钮的显眼程度，不影响可用性） */
  hasPasskey: boolean;
}

const LAST_ACCOUNT_KEY = 'readsync.lastAccount';

/**
 * 记住「这台设备上次登录的账号」。
 *
 * 存的是**非机密**信息：用户名、显示名、头像地址（头像接口本来就是公开可读的）。
 * 登录页据此把账号字段藏起来、只让填密码，所以这里刻意**不存任何凭据**。
 * 共享设备上的隐私由「只显示打码后的账号」来兜。
 */
export function readLastAccount(): LastAccount | null {
  try {
    const raw = localStorage.getItem(LAST_ACCOUNT_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<LastAccount>;
    if (!parsed || typeof parsed.username !== 'string' || !parsed.username) return null;
    return {
      username: parsed.username,
      displayName: typeof parsed.displayName === 'string' ? parsed.displayName : null,
      avatarUrl: typeof parsed.avatarUrl === 'string' ? parsed.avatarUrl : null,
      hasPasskey: parsed.hasPasskey === true,
    };
  } catch {
    return null;
  }
}

export function rememberLastAccount(account: LastAccount): void {
  try {
    localStorage.setItem(LAST_ACCOUNT_KEY, JSON.stringify(account));
  } catch {
    /* 隐私模式下写不进去：下次照常问账号，不影响登录 */
  }
}

export function forgetLastAccount(): void {
  try {
    localStorage.removeItem(LAST_ACCOUNT_KEY);
  } catch {
    /* 同上 */
  }
}

/**
 * 账号打码：`tianqiong` → `ti***ng`；邮箱保留首字母与域名（`t***@qq.com`）。
 *
 * 登录页会在别人也可能看到的屏幕上显示它，所以打码是必需的 —— 但也只打码到这个
 * 程度：用户得能认出「这是我」，否则这个快捷路径就没用了。
 */
export function maskAccount(value: string): string {
  const text = value.trim();
  if (!text) return '';

  const at = text.indexOf('@');
  if (at > 0) {
    const name = text.slice(0, at);
    const domain = text.slice(at);
    if (name.length <= 1) return `***${domain}`;
    return `${name[0]}***${domain}`;
  }

  if (text.length <= 2) return `${text[0]}***`;
  if (text.length <= 4) return `${text[0]}***${text[text.length - 1]}`;
  return `${text.slice(0, 2)}***${text.slice(-2)}`;
}
