import { md5OfFile } from './utils';
import {
  UPLOAD_CHUNK_SIZE_DEFAULT,
  UPLOAD_CHUNK_SIZE_MIN,
  type ApiResponse,
  type BookDetail,
} from '@readsync/shared';

/**
 * 分片上传因「链路太慢」而降级重试的最大轮数。
 *
 * 从默认 4 MiB 逐级减半到下限 256 KiB 需要 4 轮，多留两轮余量。
 * 到下限仍失败就直接报错 —— 那条链路基本不可用，继续重试只是耗用户时间。
 */
const UPLOAD_CHUNK_RETRIES = 6;

/**
 * 后端接口客户端。
 *
 * 职责边界：
 *  - 统一拼 `/api` 前缀与查询串（开发环境由 Vite 代理到 :3000）；
 *  - 自动附带 Bearer 令牌；
 *  - 拆 `{ ok, data, error }` 信封 —— 成功直接返回 data，失败抛 ApiError；
 *  - 收到 UNAUTHORIZED 时清本地登录态并通知 AuthContext。
 *
 * 令牌存储放在这里而不是 AuthContext，是为了避免 api ↔ context 的循环依赖：
 * context 只是这块 localStorage 的一个订阅者。
 */

const ACCESS_TOKEN_KEY = 'readsync.accessToken';
const REFRESH_TOKEN_KEY = 'readsync.refreshToken';

/** 401 时派发，AuthContext 监听它把用户状态置空，由 ProtectedRoute 完成跳转 */
export const UNAUTHORIZED_EVENT = 'readsync:unauthorized';

/** 带错误码的接口异常。code 取自后端 ERROR_CODES，网络层错误用 NETWORK_ERROR。 */
export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details?: unknown;

  constructor(code: string, message: string, status = 0, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
    this.details = details;
  }

  /** 后端尚未实现该端点时的降级判断依据（404 / 未注册路由） */
  get isMissing(): boolean {
    return this.code === 'NOT_FOUND' || this.status === 404;
  }

  get isUnauthorized(): boolean {
    return this.code === 'UNAUTHORIZED' || this.status === 401;
  }

  get isForbidden(): boolean {
    return this.code === 'FORBIDDEN' || this.status === 403;
  }
}

/* ------------------------------- 令牌存取 ------------------------------- */

export function getAccessToken(): string | null {
  try {
    return localStorage.getItem(ACCESS_TOKEN_KEY);
  } catch {
    return null;
  }
}

export function getRefreshToken(): string | null {
  try {
    return localStorage.getItem(REFRESH_TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setTokens(accessToken: string, refreshToken?: string): void {
  try {
    localStorage.setItem(ACCESS_TOKEN_KEY, accessToken);
    if (refreshToken) localStorage.setItem(REFRESH_TOKEN_KEY, refreshToken);
  } catch {
    /* 隐私模式下写不进去，本次会话仍可用内存中的状态 */
  }
}

export function clearTokens(): void {
  try {
    localStorage.removeItem(ACCESS_TOKEN_KEY);
    localStorage.removeItem(REFRESH_TOKEN_KEY);
  } catch {
    /* 同上 */
  }
}

function notifyUnauthorized(): void {
  clearTokens();
  window.dispatchEvent(new CustomEvent(UNAUTHORIZED_EVENT));
}

/* ------------------------------- 请求封装 ------------------------------- */

export type QueryValue = string | number | boolean | null | undefined;

export interface RequestOptions {
  method?: string;
  body?: unknown;
  query?: Record<string, QueryValue>;
  /** 显式传 FormData 时不设置 Content-Type，交给浏览器带上 multipart boundary */
  formData?: FormData;
  signal?: AbortSignal;
  /** 默认 true；公开接口（登录/注册/公钥）传 false 以免带上过期令牌 */
  auth?: boolean;
  /** 登录接口自身返回 401 时不应触发「跳登录页」，否则会把错误信息吞掉 */
  skipAuthRedirect?: boolean;
}

/**
 * 上传专用地址（来自站点设置 `upload.baseUrl`），留空表示与主站同源。
 *
 * 用于「上传走一条不经过 CDN 的通道」的部署：主站挂在 Cloudflare 后面享受
 * 免维护的 TLS，大文件上传另开一个灰云子域直连服务器，绕开 CDN 对请求体大小
 * 与请求时长的限制。由 AuthContext 在读到站点设置后调用 setUploadBaseUrl 注入，
 * 因此管理员改完即时生效，不需要重新构建前端。
 */
let uploadBaseUrl = '';

export function setUploadBaseUrl(url: string): void {
  uploadBaseUrl = url.trim().replace(/\/+$/, '');
}

export function getUploadBaseUrl(): string {
  return uploadBaseUrl;
}

/** 上传接口是否为跨域（用于给出更准确的失败提示） */
export function isUploadCrossOrigin(): boolean {
  if (!uploadBaseUrl) return false;
  try {
    return new URL(uploadBaseUrl).origin !== window.location.origin;
  } catch {
    return false;
  }
}

/** 把上传路径拼到上传地址上；与主站同源时返回相对路径 */
function resolveUploadUrl(path: string): string {
  const normalized = path.startsWith('/api/') ? path : `/api${path.startsWith('/') ? path : `/${path}`}`;
  return uploadBaseUrl ? `${uploadBaseUrl}${normalized}` : normalized;
}

/** 把 '/auth/login' 之类的相对路径补成 '/api/auth/login'；已是绝对 API 路径则原样保留 */
function resolveUrl(path: string, query?: Record<string, QueryValue>): string {
  const base = path.startsWith('/api/') || path === '/api' ? path : `/api${path.startsWith('/') ? path : `/${path}`}`;
  if (!query) return base;

  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    // undefined/null/空串一律不发送：后端对空串的 coerce 结果常常是意外值
    if (value === undefined || value === null || value === '') continue;
    params.append(key, String(value));
  }
  const qs = params.toString();
  return qs ? `${base}?${qs}` : base;
}

function buildHeaders(options: RequestOptions): Record<string, string> {
  const headers: Record<string, string> = { Accept: 'application/json' };

  if (options.auth !== false) {
    const token = getAccessToken();
    if (token) headers.Authorization = `Bearer ${token}`;
  }

  // FormData 必须让浏览器自己设置 Content-Type（里面含 boundary），
  // 手动设置会导致后端解析 multipart 失败。
  if (options.formData === undefined && options.body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }

  return headers;
}

/** 从各种形态的响应里拆出信封；非信封响应（404 页、代理 HTML）转为 ApiError */
function unwrap<T>(payload: unknown, status: number, options: RequestOptions): T {
  if (payload && typeof payload === 'object' && 'ok' in payload) {
    const envelope = payload as ApiResponse<T>;
    if (envelope.ok) return envelope.data;

    const error = envelope.error;
    if ((error.code === 'UNAUTHORIZED' || status === 401) && !options.skipAuthRedirect) {
      notifyUnauthorized();
    }
    throw new ApiError(error.code, error.message, status, error.details);
  }

  if (status >= 400) {
    if (status === 401 && !options.skipAuthRedirect) notifyUnauthorized();
    throw new ApiError(
      status === 404 ? 'NOT_FOUND' : status === 403 ? 'FORBIDDEN' : 'INTERNAL_ERROR',
      status === 404 ? '接口不存在或尚未实现' : `请求失败（HTTP ${status}）`,
      status,
    );
  }

  // 2xx 但没有信封：少数端点（如下载重定向）会返回裸数据，直接透传
  return payload as T;
}

async function readBody(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const url = resolveUrl(path, options.query);
  const init: RequestInit = {
    method: options.method ?? 'GET',
    headers: buildHeaders(options),
  };
  if (options.signal) init.signal = options.signal;
  if (options.formData !== undefined) init.body = options.formData;
  else if (options.body !== undefined) init.body = JSON.stringify(options.body);

  let res: Response;
  try {
    res = await fetch(url, init);
  } catch (err) {
    // AbortError 是调用方主动取消，不该被当成网络故障报给用户
    if (err instanceof DOMException && err.name === 'AbortError') throw err;
    throw new ApiError('NETWORK_ERROR', '无法连接服务器，请检查网络或后端是否已启动', 0);
  }

  if (res.status === 204) return undefined as T;

  return unwrap<T>(await readBody(res), res.status, options);
}

/* -------------------------------- 方法集 -------------------------------- */

export function get<T>(path: string, query?: Record<string, QueryValue>, options?: RequestOptions): Promise<T> {
  return request<T>(path, { ...options, method: 'GET', query });
}

export function post<T>(path: string, body?: unknown, options?: RequestOptions): Promise<T> {
  return request<T>(path, { ...options, method: 'POST', body });
}

export function put<T>(path: string, body?: unknown, options?: RequestOptions): Promise<T> {
  return request<T>(path, { ...options, method: 'PUT', body });
}

export function patch<T>(path: string, body?: unknown, options?: RequestOptions): Promise<T> {
  return request<T>(path, { ...options, method: 'PATCH', body });
}

export function del<T>(path: string, options?: RequestOptions): Promise<T> {
  return request<T>(path, { ...options, method: 'DELETE' });
}

/**
 * 文件上传。
 *
 * 用 XMLHttpRequest 而不是 fetch，因为书库文件动辄上百 MB，
 * fetch 无法上报上传进度，用户会以为页面卡死。信封解析逻辑与 request 保持一致。
 */
export function upload<T>(
  path: string,
  formData: FormData,
  options: { onProgress?: (percent: number) => void; signal?: AbortSignal } = {},
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', resolveUploadUrl(path), true);
    xhr.responseType = 'text';

    const token = getAccessToken();
    if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`);
    xhr.setRequestHeader('Accept', 'application/json');

    // 记下最后到达的进度：连接中断时它是判断「卡在哪一层」的唯一线索
    let lastPercent = 0;
    let sentBytes = 0;

    if (xhr.upload) {
      xhr.upload.onprogress = (event) => {
        sentBytes = event.loaded;
        if (event.lengthComputable) {
          lastPercent = Math.round((event.loaded / event.total) * 100);
          options.onProgress?.(lastPercent);
        }
      };
    }

    xhr.onload = () => {
      let payload: unknown = null;
      try {
        payload = xhr.responseText ? (JSON.parse(xhr.responseText) as unknown) : null;
      } catch {
        payload = xhr.responseText;
      }
      try {
        resolve(unwrap<T>(payload, xhr.status, { formData, skipAuthRedirect: false }));
      } catch (err) {
        reject(err);
      }
    };

    /*
     * 连接中断。
     *
     * 这里必须把「传到哪儿了」讲清楚，否则用户只看到一句「网络连接中断」，
     * 完全无从下手 —— 而这两种情况的处置方式截然不同：
     *
     *  - 一个字节都没发出去（sentBytes === 0）：是本机到服务器根本没通，
     *    查地址、端口、防火墙。
     *  - 传到一半才断：连接建立过、数据也发出去了一部分，说明链路是通的，
     *    是**中途**被掐断的。自托管场景下最常见的原因是反向代理限制：
     *    nginx 的 client_max_body_size（默认仅 1 MB）、Cloudflare 免费版
     *    100 MB 请求体上限、以及 Cloudflare 100 秒的请求超时。
     *    服务端本身不会这样断（它会返回 413），所以看到「传到一半断」
     *    基本可以直接去查代理配置。
     */
    xhr.onerror = () => {
      if (sentBytes === 0) {
        reject(new ApiError('NETWORK_ERROR', '上传失败，无法连接服务器，请检查网络或后端是否已启动', 0));
        return;
      }
      reject(
        new ApiError(
          'NETWORK_ERROR',
          `上传在 ${lastPercent}% 处中断。连接是通的，但中途被切断了 —— ` +
            `若经过 nginx/Cloudflare 等反向代理，请检查其请求体大小限制（nginx 的 ` +
            `client_max_body_size 默认仅 1 MB）与超时设置，详见 docs/https-setup.md`,
          0,
        ),
      );
    };
    xhr.ontimeout = () => reject(new ApiError('NETWORK_ERROR', '上传超时', 0));
    xhr.onabort = () => reject(new DOMException('上传已取消', 'AbortError'));

    if (options.signal) {
      if (options.signal.aborted) {
        xhr.abort();
        return;
      }
      options.signal.addEventListener('abort', () => xhr.abort(), { once: true });
    }

    xhr.send(formData);
  });
}

/**
 * 分片上传。
 *
 * 为什么不用上面那个整体上传：整份文件一次 POST 时，请求体大小与请求耗时都
 * 受客户端与服务端之间的中间层约束 —— Nginx 的 client_max_body_size 默认只有
 * 1 MB，Cloudflare 橙云（含 Tunnel）对体积和时长都有上限且免费版调不了。
 * 这些限制服务端绕不过去，只能改用小请求。
 *
 * 分片大小由服务端在 init 时下发（默认 4 MiB），前端不自己定：
 * 服务端才知道自己的 bodyLimit 与部署环境能承受多大的请求。
 *
 * 失败时的 uploadId 会随错误抛出，调用方可以据此中止会话，避免分片一直占着磁盘。
 */
export async function uploadChunked(
  file: File,
  fields: Record<string, string>,
  target: { mode: 'create' } | { mode: 'version'; bookId: number },
  options: {
    onProgress?: (percent: number) => void;
    onNotice?: (message: string) => void;
    signal?: AbortSignal;
  } = {},
): Promise<BookDetail> {
  const token = getAccessToken();
  const authHeaders: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};

  const abortSession = (id: string): void => {
    void fetch(resolveUploadUrl(`/uploads/${id}`), { method: 'DELETE', headers: authHeaders }).catch(
      () => undefined,
    );
  };

  /** 跑完一轮：建会话 → 逐片上传 → 合并。任何一步失败都由调用方决定是否降级重试 */
  const runOnce = async (chunkSize?: number): Promise<BookDetail> => {
    /*
     * 建会话这一步的失败**绝不能**按「链路慢」去重试。
     *
     * 它是一个 134 字节的 JSON POST，再慢的链路也传得完；它失败只可能是
     * 连不上、跨域被拦、或令牌/参数有问题。若和分片的超时混为一谈，
     * 一次 CORS 配置失误会被演成「重试 6 轮后报上传持续超时」，
     * 把排查方向整个带偏 —— 而这类问题恰恰是「上传走独立域名」最容易踩的。
     */
    let initRes: Response;
    try {
      initRes = await fetch(resolveUploadUrl('/uploads'), {
        method: 'POST',
        headers: { ...authHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          filename: file.name,
          size: file.size,
          mode: target.mode,
          ...(target.mode === 'version' ? { bookId: target.bookId } : {}),
          ...(chunkSize !== undefined ? { chunkSize } : {}),
          fields,
        }),
        ...(options.signal ? { signal: options.signal } : {}),
      });
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') throw err;
      throw new ApiError('NETWORK_ERROR', uploadUnreachableHint(), 0);
    }

    const init = (await unwrap<unknown>(await readBody(initRes), initRes.status, {})) as {
      uploadId: string;
      chunkSize: number;
      totalChunks: number;
    };

    const { uploadId, totalChunks } = init;
    let done = 0;

    try {
      for (let index = 0; index < totalChunks; index += 1) {
        const start = index * init.chunkSize;
        const blob = file.slice(start, Math.min(start + init.chunkSize, file.size));

        let res: Response;
        try {
          res = await fetch(resolveUploadUrl(`/uploads/${uploadId}/parts/${index}`), {
            method: 'PUT',
            headers: { ...authHeaders, 'Content-Type': 'application/octet-stream' },
            body: blob,
            ...(options.signal ? { signal: options.signal } : {}),
          });
        } catch (err) {
          if (err instanceof DOMException && err.name === 'AbortError') throw err;
          // 分片阶段拿不到响应（连接被重置/断流）：这才是「这一片传不完」的典型形态，
          // 交给上层减半重试。用 UPLOAD_CHUNK_FAILED 标记，与建会话失败区分开。
          throw new ApiError('UPLOAD_CHUNK_FAILED', `第 ${index + 1}/${totalChunks} 片传输中断`, 0);
        }

        if (!res.ok) {
          const text = await res.text().catch(() => '');
          throw new ApiError(
            res.status === 401 ? 'UNAUTHORIZED' : 'UPLOAD_CHUNK_FAILED',
            `第 ${index + 1}/${totalChunks} 片上传失败（HTTP ${res.status}）${extractMessage(text)}`,
            res.status,
          );
        }

        done += 1;
        // 只到 99%：最后 1% 留给服务端合并与入库
        options.onProgress?.(Math.min(99, Math.round((done / totalChunks) * 99)));
      }

      const doneRes = await fetch(resolveUploadUrl(`/uploads/${uploadId}/complete`), {
        method: 'POST',
        headers: { ...authHeaders, 'Content-Type': 'application/json' },
        body: '{}',
        ...(options.signal ? { signal: options.signal } : {}),
      });
      return (await unwrap<unknown>(await readBody(doneRes), doneRes.status, {})) as BookDetail;
    } catch (err) {
      abortSession(uploadId);
      throw err;
    }
  };

  /*
   * 自适应降级重试。
   *
   * HTTP 524 是 Cloudflare 的「源站超时」（约 100 秒），504/408 同理，连接被重置
   * 也常是同一回事 —— 它们都**不表示请求有问题，只表示这一片在这个链路上传得太慢**。
   * 分片大小能不能扛住，取决于用户上行带宽到源站的实际速度，事前猜不准：同一个
   * 4 MiB 在光纤上几百毫秒，在绕经 Cloudflare 的慢链路上就会超过 100 秒。
   *
   * 所以不猜 —— 超时就减半重来，直到传得动为止。每次减半都要重建会话，
   * 因为服务端的分片布局（总片数、每片偏移）是建会话时定死的。
   */
  let chunkSize: number | undefined;
  let lastError: unknown;

  for (let attempt = 1; attempt <= UPLOAD_CHUNK_RETRIES; attempt += 1) {
    try {
      const result = await runOnce(chunkSize);
      options.onProgress?.(100);
      return result;
    } catch (err) {
      lastError = err;
      if (!isSlowLinkError(err)) throw err;

      const used = chunkSize ?? UPLOAD_CHUNK_SIZE_DEFAULT;
      const next = Math.floor(used / 2);
      if (next < UPLOAD_CHUNK_SIZE_MIN) {
        // 已经降到服务端接受的下界还是传不动，说明这条链路基本不可用，
        // 再重试只是耗用户时间 —— 如实说清楚，把判断交给用户
        throw new ApiError(
          'NETWORK_ERROR',
          `上传持续超时：分片已降到最小的 ${formatKB(UPLOAD_CHUNK_SIZE_MIN)} 仍传不完。` +
            `当前网络到服务器的上行速度过慢，请换网络后重试。`,
          0,
        );
      }

      chunkSize = next;
      options.onProgress?.(0);
      options.onNotice?.(
        `网络较慢，正在把分片减小到 ${formatKB(next)} 重试（第 ${attempt} 次）…`,
      );
    }
  }

  throw lastError instanceof Error ? lastError : new Error('上传失败');
}

/**
 * 预签名直传：浏览器把文件**直接 PUT 到对象存储**，数据完全不经过本服务。
 *
 * 这是大文件最彻底的一条路 —— 不占服务端带宽与磁盘，也不受部署在服务前面的
 * 任何反向代理/CDN 的体积与超时限制约束（Cloudflare 的 100 MB 上限、
 * Nginx 的 client_max_body_size 都无从谈起，因为请求根本不经过它们）。
 *
 * 需要一个前提：服务端算不出 MD5（它压根看不到文件），所以要由浏览器先算好，
 * 服务端再拿它派生对象位置、并用存储返回的 ETag 比对校验。
 *
 * 返回 null 表示**当前存储不支持**（本地磁盘、WebDAV 没有预签名概念），
 * 调用方应回退到分片上传，而不是把用户卡在这里。
 */
export async function uploadPresigned(
  file: File,
  fields: Record<string, string>,
  target: { mode: 'create' } | { mode: 'version'; bookId: number },
  options: {
    onProgress?: (percent: number) => void;
    onNotice?: (message: string) => void;
    signal?: AbortSignal;
    /** 复用调用方已经算过的 MD5，省一次大文件哈希 */
    knownMd5?: string;
  } = {},
): Promise<BookDetail | null> {
  const token = getAccessToken();
  const authHeaders: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};

  const postJson = async (url: string, body: unknown): Promise<unknown> => {
    const res = await fetch(resolveUploadUrl(url), {
      method: 'POST',
      headers: { ...authHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      ...(options.signal ? { signal: options.signal } : {}),
    });
    return unwrap<unknown>(await readBody(res), res.status, {});
  };

  // 大文件哈希要几秒钟，必须给提示，否则界面看起来像卡住了
  if (!options.knownMd5) options.onNotice?.('正在计算文件指纹…');
  const md5 = options.knownMd5 ?? (await md5OfFile(file, options.onProgress));

  const base = {
    filename: file.name,
    size: file.size,
    md5,
    mode: target.mode,
    ...(target.mode === 'version' ? { bookId: target.bookId } : {}),
    fields,
  };

  let presign: {
    kind: 'presigned' | 'deduped';
    url?: string;
    headers?: Record<string, string>;
    objectKey?: string;
    book?: BookDetail;
  };
  try {
    presign = (await postJson('/uploads/presign', base)) as typeof presign;
  } catch (err) {
    // 存储不支持预签名（本地 / WebDAV）时服务端返回 403，回退到分片上传。
    // 这是预期内的分支，不是错误 —— 管理员可能把上传方式设成了 presigned
    // 但默认存储仍是本地磁盘。
    if (err instanceof ApiError && err.isForbidden) {
      options.onNotice?.('当前存储不支持直传，已改用分片上传…');
      return null;
    }
    throw err;
  }

  if (presign.kind === 'deduped' && presign.book) {
    options.onProgress?.(100);
    return presign.book;
  }

  const { url, headers = {}, objectKey } = presign;
  if (!url || !objectKey) throw new ApiError('INTERNAL_ERROR', '服务端未返回上传地址', 0);

  options.onNotice?.('正在直传对象存储…');
  await putWithProgress(url, file, headers, options.onProgress, options.signal);

  return (await postJson('/uploads/presign/complete', { ...base, objectKey })) as BookDetail;
}

/** 用 XHR 直传以获得真实进度；fetch 无法上报上传进度 */
function putWithProgress(
  url: string,
  file: File,
  headers: Record<string, string>,
  onProgress?: (percent: number) => void,
  signal?: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url, true);

    let sentBytes = 0;
    let lastPercent = 0;
    // 签名可能覆盖了这些头，必须原样带回，否则对象存储会以签名不符拒绝
    for (const [key, value] of Object.entries(headers)) xhr.setRequestHeader(key, value);

    if (xhr.upload) {
      xhr.upload.onprogress = (event) => {
        sentBytes = event.loaded;
        if (event.lengthComputable) {
          lastPercent = Math.round((event.loaded / event.total) * 100);
          onProgress?.(Math.min(99, lastPercent));
        }
      };
    }

    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve();
        return;
      }
      reject(
        new ApiError(
          'INTERNAL_ERROR',
          `直传对象存储失败（HTTP ${xhr.status}）${xhr.responseText ? `：${xhr.responseText.slice(0, 200)}` : ''}`,
          xhr.status,
        ),
      );
    };

    xhr.onerror = () => {
      if (sentBytes === 0) {
        // 一个字节都没发出去：多半是桶上没配 CORS，浏览器直接把跨域请求拦了
        reject(
          new ApiError(
            'NETWORK_ERROR',
            '无法连接对象存储。请确认存储桶已配置 CORS（允许本站域名以 PUT 方式上传），' +
              '配置方法见 docs/storage-cors.md',
            0,
          ),
        );
        return;
      }
      reject(
        new ApiError(
          'NETWORK_ERROR',
          `直传在 ${lastPercent}% 处中断，请检查网络后重试（已传部分不会入库）`,
          0,
        ),
      );
    };

    xhr.ontimeout = () => reject(new ApiError('NETWORK_ERROR', '直传超时，请重试', 0));
    xhr.onabort = () => reject(new DOMException('上传已取消', 'AbortError'));

    if (signal) {
      if (signal.aborted) {
        xhr.abort();
        return;
      }
      signal.addEventListener('abort', () => xhr.abort(), { once: true });
    }

    xhr.send(file);
  });
}

/** 建会话阶段连不上时的提示；跨域时要把 CORS 这一最常见原因说清楚 */
function uploadUnreachableHint(): string {
  if (!isUploadCrossOrigin()) {
    return '无法连接服务器，请检查网络或后端是否已启动';
  }
  return (
    `无法连接上传地址 ${getUploadBaseUrl()}。该地址与本站不同源，请确认：` +
    `① 上传地址可从浏览器直接访问且证书有效；② 服务器的 CORS 白名单包含本站域名` +
    `（设 READSYNC_CORS_ORIGINS 时需一并包含，详见 docs/https-setup.md）。`
  );
}

/**
 * 判断错误是否属于「这一片在这个链路上传不完」——只有这类才值得减小分片重试。
 *
 * 关键前提：只认**分片阶段**的失败。建会话是 134 字节的请求，它失败必然不是
 * 「片太大」，减半重试毫无意义，只会把 CORS/连通性问题演成「上传持续超时」。
 *
 * 413 也算：那是中间层明确说「这个请求体太大」，减小分片正好对症。
 * 而 400/401/415 属于请求本身有问题，重试多少次都一样，应当直接报错。
 */
function isSlowLinkError(err: unknown): boolean {
  if (err instanceof DOMException && err.name === 'AbortError') return false;
  if (!(err instanceof ApiError) || err.code !== 'UPLOAD_CHUNK_FAILED') return false;
  return err.status === 0 || err.status === 413 || err.status === 408 || err.status === 504 || err.status === 524;
}

function formatKB(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(0)} MB` : `${Math.round(bytes / 1024)} KB`;
}

/** 从响应的错误信封里取出 message；拿不到就返回空串（不要污染上层提示） */
function extractMessage(text: string): string {
  try {
    const parsed = JSON.parse(text) as { error?: { message?: string } };
    return parsed.error?.message ?? '';
  } catch {
    return '';
  }
}

/**
 * 以二进制方式拉取文件。
 *
 * 下载接口有两种形态：S3 后端返回预签名 URL（拿 JSON 里跳转即可），
 * 其余走后端中转直接吐字节流。认证走 Bearer 头，无法用 <a href> 直接下载，
 * 所以这里把响应读成 Blob 再由前端触发保存。
 */
export async function getBlob(path: string, query?: Record<string, QueryValue>): Promise<Blob> {
  const headers: Record<string, string> = {};
  const token = getAccessToken();
  if (token) headers.Authorization = `Bearer ${token}`;

  let res: Response;
  try {
    res = await fetch(resolveUrl(path, query), { headers });
  } catch {
    throw new ApiError('NETWORK_ERROR', '下载失败，无法连接服务器', 0);
  }

  if (!res.ok) {
    if (res.status === 401) notifyUnauthorized();
    throw new ApiError(
      res.status === 404 ? 'NOT_FOUND' : 'INTERNAL_ERROR',
      `下载失败（HTTP ${res.status}）`,
      res.status,
    );
  }

  return res.blob();
}

export const api = { get, post, put, patch, del, upload, uploadChunked, uploadPresigned, getBlob };
