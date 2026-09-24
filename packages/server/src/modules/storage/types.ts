import type { StorageDriver, StorageTestResult } from '@readsync/shared';

/**
 * 存储适配器统一接口。
 *
 * 所有驱动（本地磁盘、WebDAV、S3 兼容对象存储、插件提供的驱动）都实现这一组方法，
 * 上层书库与同步模块只依赖该接口，不关心底层是网盘还是对象存储。
 *
 * 约定：
 *  - key 统一使用 POSIX 风格相对路径（如 `books/2026/abc.epub`），驱动内部负责转换；
 *  - 所有方法失败时抛 AppError(STORAGE_ERROR)，消息要能直接展示给用户；
 *  - 不支持的能力（如对象存储没有目录概念）返回空数组或空操作，而不是抛错。
 */

/** 对象元信息 */
export interface StorageObject {
  key: string;
  size: number;
  /** 最后修改时间（RFC3339）；驱动拿不到时为 null */
  lastModified: string | null;
  /** 内容 ETag / MD5，驱动能提供时给出 */
  etag: string | null;
}

/** 写入选项 */
export interface PutOptions {
  /** 内容类型，WebDAV/S3 会用它设置 Content-Type */
  contentType?: string;
  /** 期望的 MD5（十六进制），驱动支持时用于服务端校验 */
  md5?: string;
  /** 覆盖已有对象；为 false 且对象已存在时抛 CONFLICT */
  overwrite?: boolean;
}

/** 读取选项 */
export interface GetOptions {
  /** 只取元信息，不下载内容 */
  metadataOnly?: boolean;
}

/** 下载结果 */
export interface GetResult {
  /** 内容流；metadataOnly 时为 null */
  stream: NodeJS.ReadableStream | null;
  size: number;
  contentType: string | null;
  etag: string | null;
}

/** 列表选项 */
export interface ListOptions {
  /** 只列该前缀下的对象 */
  prefix?: string;
  /** 最大返回条数，默认 1000 */
  limit?: number;
  /** 分页游标，由驱动自行定义（S3 用 continuationToken，WebDAV 忽略） */
  cursor?: string;
}

/** 预签名上传的约束条件；驱动支持时会把它们签进 URL，让存储侧也把住关 */
export interface SignedUploadOptions {
  contentType?: string | undefined;
  /** 预期字节数。签进去之后，存储会拒绝大小不符的上传 */
  contentLength?: number | undefined;
}

/** 预签名上传目标：客户端拿它直接 PUT */
export interface SignedUploadTarget {
  url: string;
  method: 'PUT';
  /** 客户端必须原样带回的请求头（签名可能覆盖了它们） */
  headers: Record<string, string>;
}

export interface ListResult {
  objects: StorageObject[];
  /** 还有更多时返回下一页游标 */
  cursor?: string;
  /** 是否已到末尾 */
  truncated: boolean;
}

/**
 * 存储适配器。
 * 实现类需保证方法可并发调用（驱动内部若持有连接应自行处理）。
 */
export interface StorageAdapter {
  /** 驱动类型标识 */
  readonly driver: StorageDriver;
  /** 人类可读的驱动描述，用于日志与「测试连接」结果 */
  readonly description: string;

  /**
   * 连通性测试：读取根目录或做一次轻量操作。
   * 不应抛错，而是返回 { ok, message }，便于管理界面直接展示。
   */
  test(): Promise<StorageTestResult>;

  /** 上传/写入对象 */
  put(key: string, data: Buffer | NodeJS.ReadableStream, options?: PutOptions): Promise<StorageObject>;

  /** 下载对象；对象不存在时抛 NOT_FOUND */
  get(key: string, options?: GetOptions): Promise<GetResult>;

  /** 对象是否存在（不下载内容） */
  exists(key: string): Promise<boolean>;

  /** 对象元信息；不存在返回 null */
  stat(key: string): Promise<StorageObject | null>;

  /** 删除对象；不存在时静默返回 false */
  delete(key: string): Promise<boolean>;

  /** 列出对象 */
  list(options?: ListOptions): Promise<ListResult>;

  /**
   * 生成可直接访问的下载链接。
   * 对象存储返回预签名 URL；本地与 WebDAV 返回 null（由上层走中转下载）。
   */
  getSignedUrl?(key: string, expiresInSeconds: number): Promise<string | null>;

  /**
   * 生成可直接上传的预签名 PUT 链接，让浏览器把文件**直接传给对象存储**，
   * 完全不经过本服务。返回 null 表示该驱动不支持（本地磁盘、WebDAV 没有
   * 预签名概念），调用方应回退到别的上传方式。
   *
   * 这是「大文件传输」最彻底的一条路：不占用本服务的带宽与磁盘，
   * 也不受部署在服务前面的任何反向代理/CDN 的体积与超时限制约束 ——
   * 请求根本不经过它们。
   *
   * key 由服务端按 md5 派生，不接受客户端指定；URL 有效期应当很短。
   */
  getSignedUploadUrl?(
    key: string,
    expiresInSeconds: number,
    options?: SignedUploadOptions,
  ): Promise<SignedUploadTarget | null>;

  /** 已用容量（字节）；无法统计时返回 null */
  usedBytes?(): Promise<number | null>;
}

/** 适配器工厂：根据存储配置创建适配器实例 */
export interface StorageAdapterFactory {
  driver: StorageDriver;
  /** 校验配置并创建实例；配置非法时抛 BAD_REQUEST */
  create(config: Record<string, unknown>): StorageAdapter;
}

/** 校验存储 key，防止路径穿越（本地驱动尤其重要） */
export function assertSafeKey(key: string): void {
  if (!key || key.length === 0) {
    throw new Error('存储 key 不能为空');
  }
  if (key.length > 1024) {
    throw new Error('存储 key 过长');
  }
  if (key.startsWith('/') || key.startsWith('\\')) {
    throw new Error('存储 key 不能以斜杠开头');
  }
  // 拒绝 .. 片段与 Windows 盘符，避免逃逸出存储根目录
  const segments = key.split(/[/\\]/);
  if (segments.some((s) => s === '..' || s === '.')) {
    throw new Error('存储 key 不能包含相对路径片段');
  }
  if (/^[a-zA-Z]:/.test(key)) {
    throw new Error('存储 key 不能包含盘符');
  }
  if (key.includes('\0')) {
    throw new Error('存储 key 包含非法字符');
  }
}

/** 根据书籍信息生成存储 key，形如 books/{userId}/{md5前2位}/{md5}.{ext} */
export function buildBookKey(userId: number, md5: string, extension: string): string {
  const ext = extension.replace(/^\./, '').toLowerCase();
  return `books/${userId}/${md5.slice(0, 2)}/${md5}${ext ? `.${ext}` : ''}`;
}
