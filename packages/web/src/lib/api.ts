import type { ApiResponse, BookDetail } from '@readsync/shared';

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
    xhr.open('POST', resolveUrl(path), true);
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
  options: { onProgress?: (percent: number) => void; signal?: AbortSignal } = {},
): Promise<BookDetail> {
  const token = getAccessToken();
  const authHeaders: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};

  const post = async (url: string): Promise<unknown> => {
    const res = await fetch(resolveUrl(url), {
      method: 'POST',
      headers: { ...authHeaders, 'Content-Type': 'application/json' },
      body: '{}',
      ...(options.signal ? { signal: options.signal } : {}),
    });
    return unwrap<unknown>(await readBody(res), res.status, {});
  };

  /** 放弃会话，清掉已落盘的分片。失败路径必须调用，否则重试几次就堆出几份残片 */
  const abortSession = (id: string): void => {
    void fetch(resolveUrl(`/uploads/${id}`), { method: 'DELETE', headers: authHeaders }).catch(
      () => undefined,
    );
  };

  const initRes = await fetch(resolveUrl('/uploads'), {
    method: 'POST',
    headers: { ...authHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      filename: file.name,
      size: file.size,
      mode: target.mode,
      ...(target.mode === 'version' ? { bookId: target.bookId } : {}),
      fields,
    }),
    ...(options.signal ? { signal: options.signal } : {}),
  });
  const init = (await unwrap<unknown>(await readBody(initRes), initRes.status, {})) as {
    uploadId: string;
    chunkSize: number;
    totalChunks: number;
  };

  const { uploadId, chunkSize, totalChunks } = init;
  let done = 0;

  try {
    for (let index = 0; index < totalChunks; index += 1) {
      const start = index * chunkSize;
      const blob = file.slice(start, Math.min(start + chunkSize, file.size));

      const res = await fetch(resolveUrl(`/uploads/${uploadId}/parts/${index}`), {
        method: 'PUT',
        headers: { ...authHeaders, 'Content-Type': 'application/octet-stream' },
        body: blob,
        ...(options.signal ? { signal: options.signal } : {}),
      });

      if (!res.ok) {
        // 把服务端给的具体原因带出去（分片大小不对、会话过期等），
        // 否则用户只看到一句「上传失败」，完全不知道下一步该干嘛
        const text = await res.text().catch(() => '');
        throw new ApiError(
          res.status === 401 ? 'UNAUTHORIZED' : 'INTERNAL_ERROR',
          `第 ${index + 1}/${totalChunks} 片上传失败（HTTP ${res.status}）${extractMessage(text)}`,
          res.status,
        );
      }

      done += 1;
      // 只到 99%：最后 1% 留给服务端合并与入库，避免进度条早早停在 100% 却还没结束
      options.onProgress?.(Math.min(99, Math.round((done / totalChunks) * 99)));
    }

    const result = (await post(`/uploads/${uploadId}/complete`)) as BookDetail;
    options.onProgress?.(100);
    return result;
  } catch (err) {
    abortSession(uploadId);
    throw err;
  }
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

export const api = { get, post, put, patch, del, upload, uploadChunked, getBlob };
