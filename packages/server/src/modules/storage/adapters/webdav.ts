import { Agent as HttpsAgent } from 'node:https';
import { Readable } from 'node:stream';
import { webdavConfigSchema, type StorageTestResult } from '@readsync/shared';
import { createClient, type DiskQuota, type FileStat, type WebDAVClient } from 'webdav';
import { badRequest, conflict, notFound, storageError } from '../../../errors.js';
import type {
  GetOptions,
  GetResult,
  ListOptions,
  ListResult,
  PutOptions,
  StorageObject,
} from '../types.js';
import type { DirectoryAdapter } from './registry.js';

/**
 * WebDAV 存储驱动（坚果云、Nextcloud、群晖等）。
 *
 * 说明：
 * - WebDAV 没有预签名 URL，getSignedUrl 返回 null，下载由服务端中转；
 * - 目录列表没有通用的分页游标（PROPFIND 一次返回整棵子树），因此 list()
 *   用 deep 递归拉取后在内存里分页，cursor 参数被忽略；
 * - basePath 是「远端根目录」，key 会拼在它之下，对外暴露的 key 不含 basePath。
 */

/** 把任意配置里的 basePath 规范成以 '/' 开头、不以 '/' 结尾（根为 '/'） */
function normalizeBasePath(raw: string): string {
  let base = (raw || '/').trim();
  if (!base.startsWith('/')) base = `/${base}`;
  base = base.replace(/\/+$/, '');
  return base === '' ? '/' : base;
}

/** 拼接远端绝对路径 */
function joinRemote(basePath: string, key: string): string {
  const clean = key.replace(/^\/+/, '').replace(/\/+$/, '');
  if (!clean) return basePath;
  return basePath === '/' ? `/${clean}` : `${basePath}/${clean}`;
}

/** 从 webdav 客户端调用中提取 HTTP 状态码 */
function statusOf(err: unknown): number | undefined {
  const status = (err as { status?: unknown })?.status;
  return typeof status === 'number' ? status : undefined;
}

/** 把底层异常翻译成可直接展示给用户的中文消息 */
function describeError(err: unknown): string {
  const status = statusOf(err);
  switch (status) {
    case 401:
      return 'WebDAV 认证失败，请检查用户名与密码/应用授权码';
    case 403:
      return 'WebDAV 拒绝访问，请确认账号权限或应用授权码是否正确';
    case 404:
      return 'WebDAV 路径不存在，请检查地址与根目录设置';
    case 405:
      return 'WebDAV 服务器不支持该操作（可能是只读账号或服务端限制）';
    case 507:
      return 'WebDAV 存储空间不足';
    default:
      break;
  }
  const message = (err as Error)?.message ?? '未知错误';
  if (/certificate|self.signed|unable to verify/i.test(message)) {
    return 'WebDAV 证书校验失败；若使用自签名证书，请在配置中开启「允许自签名证书」';
  }
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(message)) {
    return 'WebDAV 地址无法解析，请检查域名是否正确';
  }
  if (/ECONNREFUSED|ETIMEDOUT|timeout|aborted/i.test(message)) {
    return 'WebDAV 连接超时或被拒绝，请检查地址、端口与网络';
  }
  return status ? `WebDAV 请求失败（HTTP ${status}）：${message}` : `WebDAV 请求失败：${message}`;
}

export class WebdavStorageAdapter implements DirectoryAdapter {
  readonly driver = 'webdav' as const;
  readonly description: string;
  private readonly client: WebDAVClient;
  private readonly basePath: string;

  constructor(config: { url: string; username: string; password: string; basePath: string; allowSelfSigned: boolean }) {
    this.basePath = normalizeBasePath(config.basePath);

    /**
     * allowSelfSigned 的真实实现：
     * webdav 包底层用 @buttercup/fetch（node-fetch），支持把 httpsAgent 透传到
     * fetch 的 agent 选项（见 webdav/dist/node/request.js）。因此用一个
     * rejectUnauthorized:false 的 Agent 确实能跳过自签证书校验，而不是「假装支持」。
     * 代价：该存储连接不再校验证书链，仅在用户明确勾选时才启用。
     */
    const httpsAgent = config.allowSelfSigned ? new HttpsAgent({ rejectUnauthorized: false }) : undefined;

    this.client = createClient(config.url, {
      username: config.username,
      password: config.password,
      ...(httpsAgent ? { httpsAgent } : {}),
    });

    this.description = `WebDAV（${config.url}${this.basePath === '/' ? '' : this.basePath}）`;
  }

  async test(): Promise<StorageTestResult> {
    const started = Date.now();
    try {
      // 读根目录是最轻量的探活方式，顺带验证认证与 basePath
      await this.client.getDirectoryContents(this.basePath);
      return {
        ok: true,
        message: `WebDAV 连接成功（${this.basePath}）`,
        latencyMs: Date.now() - started,
      };
    } catch (err) {
      return { ok: false, message: describeError(err), latencyMs: Date.now() - started };
    }
  }

  async put(key: string, data: Buffer | NodeJS.ReadableStream, options?: PutOptions): Promise<StorageObject> {
    const remote = joinRemote(this.basePath, key);
    if (options?.overwrite === false && (await this.exists(key))) {
      throw conflict(`对象已存在：${key}`);
    }

    try {
      if (Buffer.isBuffer(data)) {
        // contentLength: true 让客户端带上 Content-Length；部分服务端（如坚果云）
        // 对 chunked 上传支持不佳，Buffer 场景显式给出长度更稳
        await this.client.putFileContents(remote, data, {
          overwrite: options?.overwrite !== false,
          contentLength: true,
          ...(options?.contentType ? { headers: { 'Content-Type': options.contentType } } : {}),
        });
      } else {
        await this.client.putFileContents(remote, data as unknown as Readable, {
          overwrite: options?.overwrite !== false,
        });
      }
    } catch (err) {
      throw storageError(describeError(err), err);
    }

    const st = await this.stat(key);
    return st ?? { key, size: 0, lastModified: new Date().toISOString(), etag: options?.md5 ?? null };
  }

  async get(key: string, options?: GetOptions): Promise<GetResult> {
    const file = await this.remoteStat(key);
    if (!file) throw notFound(`WebDAV 上不存在：${key}`);

    return {
      stream: options?.metadataOnly ? null : this.client.createReadStream(joinRemote(this.basePath, key)),
      size: file.size,
      contentType: file.mime && file.mime.length > 0 ? file.mime : null,
      etag: file.etag ?? null,
    };
  }

  async exists(key: string): Promise<boolean> {
    try {
      return await this.client.exists(joinRemote(this.basePath, key));
    } catch (err) {
      throw storageError(describeError(err), err);
    }
  }

  async stat(key: string): Promise<StorageObject | null> {
    const file = await this.remoteStat(key);
    return file ? this.toObject(key, file) : null;
  }

  async delete(key: string): Promise<boolean> {
    try {
      await this.client.deleteFile(joinRemote(this.basePath, key));
      return true;
    } catch (err) {
      // 不存在视为删除成功（幂等），返回 false 便于调用方区分
      if (statusOf(err) === 404) return false;
      throw storageError(describeError(err), err);
    }
  }

  async list(options: ListOptions = {}): Promise<ListResult> {
    const prefix = (options.prefix ?? '').replace(/^\/+/, '');
    const limit = options.limit && options.limit > 0 ? options.limit : 1000;

    let entries: FileStat[];
    try {
      // deep 递归一次拿全量再过滤：WebDAV 无法按前缀分页，这是唯一可靠的做法。
      // 远端文件极多时这一步会较慢，属于协议本身的限制。
      entries = await this.client.getDirectoryContents(this.basePath, { deep: true });
    } catch (err) {
      throw storageError(describeError(err), err);
    }

    const objects = entries
      .filter((entry) => entry.type === 'file')
      .map((entry) => this.toObject(this.toKey(entry.filename), entry))
      .filter((obj) => obj.key.length > 0 && obj.key.startsWith(prefix))
      .sort((a, b) => a.key.localeCompare(b.key));

    return {
      objects: objects.slice(0, limit),
      truncated: objects.length > limit,
    };
  }

  /** WebDAV 无预签名 URL，返回 null 让上层走服务端中转 */
  async getSignedUrl(_key: string, _expiresInSeconds: number): Promise<string | null> {
    return null;
  }

  /** 尝试用 getQuota 拿已用容量；并非所有服务端都实现，失败时返回 null */
  async usedBytes(): Promise<number | null> {
    try {
      const quota = await this.client.getQuota();
      // 不传 details 时返回 DiskQuota | ResponseDataDetailed<...> 的联合类型，做一次收窄
      if (quota && typeof quota === 'object' && 'used' in quota && typeof (quota as DiskQuota).used === 'number') {
        return (quota as DiskQuota).used;
      }
      return null;
    } catch {
      return null;
    }
  }

  async mkdir(key: string): Promise<void> {
    const clean = key.replace(/^\/+/, '').replace(/\/+$/, '');
    const target = clean === '' ? this.basePath : joinRemote(this.basePath, clean);
    try {
      await this.client.createDirectory(target, { recursive: true });
    } catch (err) {
      throw storageError(describeError(err), err);
    }
  }

  /* ------------------------------ 内部工具 ------------------------------ */

  /** 取远端 stat，404 返回 null，其余错误翻译后抛出 */
  private async remoteStat(key: string): Promise<FileStat | null> {
    try {
      const stat = await this.client.stat(joinRemote(this.basePath, key));
      return stat as FileStat;
    } catch (err) {
      if (statusOf(err) === 404) return null;
      throw storageError(describeError(err), err);
    }
  }

  /** webdav 返回的 filename 是相对客户端 URL 路径的，再剥掉业务 basePath */
  private toKey(filename: string): string {
    let p = filename.replace(/\\/g, '/');
    if (this.basePath !== '/') {
      if (p === this.basePath) return '';
      if (p.startsWith(`${this.basePath}/`)) p = p.slice(this.basePath.length + 1);
    }
    return p.replace(/^\/+/, '');
  }

  private toObject(key: string, file: FileStat): StorageObject {
    let lastModified: string | null = null;
    if (file.lastmod) {
      const parsed = new Date(file.lastmod);
      if (!Number.isNaN(parsed.getTime())) lastModified = parsed.toISOString();
    }
    return { key, size: file.size ?? 0, lastModified, etag: file.etag ?? null };
  }
}

/** 适配器工厂：配置非法时抛 BAD_REQUEST */
export function createWebdavAdapter(config: Record<string, unknown>): DirectoryAdapter {
  const parsed = webdavConfigSchema.safeParse(config);
  if (!parsed.success) {
    throw badRequest(`WebDAV 配置不合法：${parsed.error.issues.map((i) => i.message).join('；')}`);
  }
  return new WebdavStorageAdapter(parsed.data);
}
