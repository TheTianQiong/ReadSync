import { Readable } from 'node:stream';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { s3ConfigSchema, type StorageTestResult } from '@readsync/shared';
import { badRequest, conflict, notFound, storageError } from '../../../errors.js';
import type {
  SignedUploadOptions,
  SignedUploadTarget,
  GetOptions,
  GetResult,
  ListOptions,
  ListResult,
  PutOptions,
  StorageObject,
} from '../types.js';
import type { DirectoryAdapter } from './registry.js';

/**
 * S3 兼容对象存储驱动（阿里云 OSS、腾讯云 COS、MinIO、Cloudflare R2 …）。
 *
 * 要点：
 * - 阿里云 OSS / MinIO 默认需要 path 风格寻址（forcePathStyle: true）；
 * - 对象存储没有目录概念，mkdir 为空操作（key 里的 '/' 只是命名约定）；
 * - config.prefix 作为该存储的命名空间，对外暴露的 key 不含前缀；
 * - getSignedUrl 走预签名 URL，前端可不经服务端直接下载。
 */

/** 从 AWS SDK 异常里取 HTTP 状态码 */
function httpStatusOf(err: unknown): number | undefined {
  const status = (err as { $metadata?: { httpStatusCode?: unknown } })?.$metadata?.httpStatusCode;
  return typeof status === 'number' ? status : undefined;
}

function errorName(err: unknown): string {
  return (err as { name?: string })?.name ?? '';
}

/** 把 SDK 异常翻译成可直接展示的中文消息 */
function describeError(err: unknown): string {
  const name = errorName(err);
  const status = httpStatusOf(err);
  const raw = (err as Error)?.message ?? '未知错误';

  if (name === 'InvalidAccessKeyId' || name === 'SignatureDoesNotMatch' || status === 403) {
    return '对象存储认证失败，请检查 Access Key / Secret Key 与权限';
  }
  if (name === 'NoSuchBucket' || status === 404) {
    return '对象存储 Bucket 不存在或无权访问，请检查 Bucket 名称与区域';
  }
  if (name === 'PermanentRedirect' || name === 'AuthorizationHeaderMalformed') {
    return '对象存储区域（region）配置不正确，请核对 Endpoint 与 Region';
  }
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(raw)) {
    return '对象存储 Endpoint 无法解析，请检查地址';
  }
  if (/ECONNREFUSED|ETIMEDOUT|timeout|aborted/i.test(raw)) {
    return '对象存储连接超时或被拒绝，请检查 Endpoint、端口与网络';
  }
  if (/Cannot determine length|stream.*length/i.test(raw)) {
    return '对象存储不支持未知长度的流式上传，请改为先缓冲后上传';
  }
  return status ? `对象存储请求失败（HTTP ${status}）：${raw}` : `对象存储请求失败：${raw}`;
}

/** 把 Node 可读流转成 Buffer（PutObject 需要已知长度） */
async function streamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
  }
  return Buffer.concat(chunks);
}

function stripEtag(etag: string | undefined): string | null {
  return etag ? etag.replace(/"/g, '') : null;
}

export class S3StorageAdapter implements DirectoryAdapter {
  readonly driver = 's3' as const;
  readonly description: string;
  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly prefix: string;

  constructor(config: {
    endpoint: string;
    region: string;
    bucket: string;
    accessKeyId: string;
    secretAccessKey: string;
    prefix: string;
    forcePathStyle: boolean;
    addressingStyle: 'path' | 'virtual-host';
  }) {
    this.bucket = config.bucket;
    // 统一去掉首尾斜杠，保证拼接结果稳定
    this.prefix = config.prefix.replace(/^\/+/, '').replace(/\/+$/, '');

    this.client = new S3Client({
      endpoint: config.endpoint,
      region: config.region,
      // 阿里云 OSS / MinIO 用 path 风格；addressingStyle 与 forcePathStyle 保持一致
      forcePathStyle: config.forcePathStyle || config.addressingStyle === 'path',
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
    });

    this.description = `S3 兼容存储（${config.endpoint}/${config.bucket}${this.prefix ? `/${this.prefix}` : ''}）`;
  }

  async test(): Promise<StorageTestResult> {
    const started = Date.now();
    try {
      // MaxKeys: 1 的列举是最轻量且不产生费用的探活方式（HeadBucket 在部分厂商不可用）
      await this.client.send(
        new ListObjectsV2Command({ Bucket: this.bucket, MaxKeys: 1, Prefix: this.prefix || undefined }),
      );
      return {
        ok: true,
        message: `对象存储连接成功（${this.bucket}）`,
        latencyMs: Date.now() - started,
      };
    } catch (err) {
      return { ok: false, message: describeError(err), latencyMs: Date.now() - started };
    }
  }

  async put(key: string, data: Buffer | NodeJS.ReadableStream, options?: PutOptions): Promise<StorageObject> {
    if (options?.overwrite === false && (await this.exists(key))) {
      throw conflict(`对象已存在：${key}`);
    }

    // PutObject 需要已知长度；调用方通常已算出 MD5 的 Buffer，流则先缓冲。
    // 代价是内存占用，但本项目的上传路径本就先算 MD5，改动上层更不划算。
    const body = Buffer.isBuffer(data) ? data : await streamToBuffer(data);

    try {
      const result = await this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: this.fullKey(key),
          Body: body,
          ContentLength: body.byteLength,
          ...(options?.contentType ? { ContentType: options.contentType } : {}),
          // 调用方给了 MD5 就让 S3 做服务端校验，损坏的上传会直接被拒绝
          ...(options?.md5 && /^[a-f0-9]{32}$/i.test(options.md5)
            ? { ContentMD5: Buffer.from(options.md5, 'hex').toString('base64') }
            : {}),
        }),
      );

      const now = new Date().toISOString();
      return {
        key,
        size: body.byteLength,
        lastModified: now,
        etag: stripEtag(result.ETag) ?? options?.md5 ?? null,
      };
    } catch (err) {
      throw storageError(describeError(err), err);
    }
  }

  async get(key: string, options?: GetOptions): Promise<GetResult> {
    if (options?.metadataOnly) {
      const st = await this.stat(key);
      if (!st) throw notFound(`对象存储上不存在：${key}`);
      return { stream: null, size: st.size, contentType: null, etag: st.etag };
    }

    try {
      const result = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: this.fullKey(key) }),
      );
      if (!result.Body) {
        throw storageError(`对象存储返回了空内容：${key}`);
      }
      return {
        // Node 运行时 Body 是挂在 Readable 上的 SdkStream，可直接当流用
        stream: result.Body as unknown as Readable,
        size: result.ContentLength ?? 0,
        contentType: result.ContentType ?? null,
        etag: stripEtag(result.ETag),
      };
    } catch (err) {
      if (errorName(err) === 'NoSuchKey' || httpStatusOf(err) === 404) {
        throw notFound(`对象存储上不存在：${key}`);
      }
      throw storageError(describeError(err), err);
    }
  }

  async exists(key: string): Promise<boolean> {
    return (await this.stat(key)) !== null;
  }

  async stat(key: string): Promise<StorageObject | null> {
    try {
      const result = await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: this.fullKey(key) }),
      );
      return {
        key,
        size: result.ContentLength ?? 0,
        lastModified: result.LastModified ? result.LastModified.toISOString() : null,
        etag: stripEtag(result.ETag),
      };
    } catch (err) {
      const name = errorName(err);
      if (name === 'NotFound' || name === 'NoSuchKey' || httpStatusOf(err) === 404) return null;
      throw storageError(describeError(err), err);
    }
  }

  async delete(key: string): Promise<boolean> {
    // DeleteObject 幂等，删不存在的 key 也返回成功；先 stat 一次才能如实返回 false
    const existed = await this.exists(key);
    if (!existed) return false;

    try {
      await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: this.fullKey(key) }));
      return true;
    } catch (err) {
      throw storageError(describeError(err), err);
    }
  }

  async list(options: ListOptions = {}): Promise<ListResult> {
    const limit = options.limit && options.limit > 0 ? options.limit : 1000;
    const listPrefix = this.fullKey((options.prefix ?? '').replace(/^\/+/, ''));

    try {
      const result = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: listPrefix || undefined,
          MaxKeys: limit,
          // S3 的分页游标就是 ContinuationToken，原样透传
          ContinuationToken: options.cursor || undefined,
        }),
      );

      const objects: StorageObject[] = (result.Contents ?? [])
        .filter((item): item is typeof item & { Key: string } => typeof item.Key === 'string')
        .map((item) => ({
          key: this.toLogicalKey(item.Key),
          size: item.Size ?? 0,
          lastModified: item.LastModified ? item.LastModified.toISOString() : null,
          etag: stripEtag(item.ETag),
        }));

      const truncated = result.IsTruncated === true;
      return {
        objects,
        ...(truncated && result.NextContinuationToken ? { cursor: result.NextContinuationToken } : {}),
        truncated,
      };
    } catch (err) {
      throw storageError(describeError(err), err);
    }
  }

  /** 生成预签名下载 URL，前端可不经服务端直接下载 */
  async getSignedUrl(key: string, expiresInSeconds: number): Promise<string | null> {
    try {
      return await getSignedUrl(
        this.client,
        new GetObjectCommand({ Bucket: this.bucket, Key: this.fullKey(key) }),
        { expiresIn: Math.max(1, Math.floor(expiresInSeconds)) },
      );
    } catch (err) {
      throw storageError(describeError(err), err);
    }
  }

  /**
   * 预签名上传：让浏览器把文件直接 PUT 到对象存储，不经过本服务。
   *
   * 把 ContentType 与 ContentLength 一并签进去，存储侧就会拒绝内容类型或
   * 大小不符的上传 —— 校验不能只放在确认阶段，那时数据已经写进去了。
   *
   * 注意用的是 this.fullKey(key)：逻辑 key 不含存储的命名空间前缀，
   * 真正写进桶的必须带上，否则会和该存储的其它数据混在一起。
   */
  async getSignedUploadUrl(
    key: string,
    expiresInSeconds: number,
    options: SignedUploadOptions = {},
  ): Promise<SignedUploadTarget> {
    const headers: Record<string, string> = {};
    if (options.contentType) headers['Content-Type'] = options.contentType;

    try {
      const url = await getSignedUrl(
        this.client,
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: this.fullKey(key),
          ...(options.contentType ? { ContentType: options.contentType } : {}),
          ...(options.contentLength !== undefined ? { ContentLength: options.contentLength } : {}),
        }),
        { expiresIn: Math.max(1, Math.floor(expiresInSeconds)) },
      );
      return { url, method: 'PUT', headers };
    } catch (err) {
      throw storageError(describeError(err), err);
    }
  }

  /** 对象存储没有目录概念：空操作即可，key 的层级由 '/' 约定表达 */
  async mkdir(_key: string): Promise<void> {
    return;
  }

  /* ------------------------------ 内部工具 ------------------------------ */

  /** 逻辑 key → 桶内真实 key（拼上命名空间前缀） */
  private fullKey(key: string): string {
    const clean = key.replace(/^\/+/, '');
    if (!this.prefix) return clean;
    return clean ? `${this.prefix}/${clean}` : this.prefix;
  }

  /** 桶内真实 key → 对外逻辑 key（剥掉命名空间前缀） */
  private toLogicalKey(s3Key: string): string {
    if (!this.prefix) return s3Key;
    if (s3Key === this.prefix) return '';
    return s3Key.startsWith(`${this.prefix}/`) ? s3Key.slice(this.prefix.length + 1) : s3Key;
  }
}

/** 适配器工厂：配置非法时抛 BAD_REQUEST */
export function createS3Adapter(config: Record<string, unknown>): DirectoryAdapter {
  const parsed = s3ConfigSchema.safeParse(config);
  if (!parsed.success) {
    throw badRequest(`对象存储配置不合法：${parsed.error.issues.map((i) => i.message).join('；')}`);
  }
  return new S3StorageAdapter(parsed.data);
}
