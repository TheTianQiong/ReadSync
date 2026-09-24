import type { BookDetail } from '@readsync/shared';
import { badRequest, forbidden, payloadTooLarge } from '../../errors.js';
import { getModuleLogger } from '../../logger.js';
import { getSiteSettings } from '../../lib/settings.js';
import {
  assertAllowedExtensionName,
  assertWithinQuota,
  findDedupedBook,
  insertBookRecords,
  insertVersionRecords,
  mimeOfExt,
  resolveBookTarget,
  resolveVersionTarget,
  type UploadBookResult,
  type UploadFields,
} from './service.js';
import type { StorageAdapter } from '../storage/types.js';

/**
 * 预签名直传。
 *
 * 浏览器拿服务端签发的 URL，把文件**直接 PUT 到对象存储**，数据完全不经过
 * 本服务。这是大文件传输最彻底的一条路：
 *  - 不占本服务的带宽与磁盘（分片上传仍要落盘再转存）；
 *  - 不受部署在服务前面的任何反向代理/CDN 的请求体大小与超时限制约束 ——
 *    请求根本不经过它们，Cloudflare 的 100 MB 上限、Nginx 的
 *    client_max_body_size 都无从谈起。
 *
 * 代价是三条，都必须正视：
 *  1. **只有 S3 兼容存储支持**（R2 / OSS / COS / MinIO）。本地磁盘与 WebDAV
 *     没有预签名概念，会返回 null，调用方应回退到分片上传。
 *  2. **服务端拿不到文件内容**，因此无法自己算 MD5。这里改为「客户端上报
 *     md5 + 服务端用 ETag 校验」：单次 PUT 的 ETag 就是内容的 MD5 十六进制，
 *     对不上就拒绝。这样仍能发现传输损坏，但强度不如服务端亲自算。
 *  3. 浏览器要直连对象存储，**桶上必须配 CORS**，否则请求会被浏览器拦掉。
 *
 * 设计上刻意做成**无状态**：签发与确认之间不在服务端保存任何中间状态，
 * 确认时凭客户端回传的参数重新推导并核对。这样服务重启不会让已传完的大文件
 * 白费 —— 而分片上传的会话是落盘的，正是因为那里必须记住每个分片的偏移。
 */

const log = getModuleLogger('library');

/** 预签名 URL 的有效期。够传完一个大文件即可，不宜长 —— 它是一张可写入的凭据 */
const SIGNED_URL_TTL_SECONDS = 30 * 60;

export interface PresignInput {
  filename: string;
  size: number;
  md5: string;
  mode: 'create' | 'version';
  bookId?: number | undefined;
  fields: UploadFields;
}

export type PresignResult =
  | { kind: 'presigned'; url: string; method: 'PUT'; headers: Record<string, string>; objectKey: string; expiresIn: number }
  /** 相同 MD5 已在书库中，无需上传 */
  | { kind: 'deduped'; book: BookDetail };

/** 校验大小与配额；两条路径（签发前、入库前）都要过 */
function assertSizeAllowed(size: number, userId: number): void {
  const max = getSiteSettings().upload.maxFileSize;
  if (max > 0 && size > max) {
    throw payloadTooLarge(`文件超过本站单文件上限（${Math.round(max / 1024 / 1024)} MB）`);
  }
  if (size <= 0) throw badRequest('文件内容为空');
  // 配额在上传**之前**就要卡住：直传一旦发出，数据就已经落进对象存储了，
  // 事后再拒只是留下一个没人认领的对象
  assertWithinQuota(userId, size);
}

/**
 * 签发预签名上传 URL。
 *
 * 秒传检查放在最前面：命中就直接返回已有书籍，客户端一个字节都不用传 ——
 * 这是直传模式下最省事的一环，连对象存储的流量都省了。
 */
export async function presignUpload(userId: number, input: PresignInput): Promise<PresignResult> {
  const { ext } = assertAllowedExtensionName(input.filename);
  assertSizeAllowed(input.size, userId);
  const isVersion = input.mode === 'version';

  if (isVersion && input.bookId === undefined) {
    throw badRequest('为已有书籍上传新版本时必须提供 bookId');
  }

  // 秒传只对「登记新书」有意义：新版本本来就是要换掉现有文件
  if (!isVersion) {
    const deduped = findDedupedBook(userId, input.md5);
    if (deduped) return { kind: 'deduped', book: deduped.book };
  }

  // 顺带校验归属与 md5 冲突：不能让用户为一个不存在的书、或一个会撞唯一索引的
  // md5 白传几百 MB —— 直传是浏览器直接发给对象存储的，服务端事后才发现就没意义了
  const target =
    isVersion && input.bookId !== undefined
      ? await resolveVersionTarget(userId, input.bookId, input.md5, ext)
      : await resolveBookTarget(userId, input.md5, ext, input.fields);

  if (!target.adapter.getSignedUploadUrl) {
    throw forbidden(
      `存储「${target.adapter.description}」不支持预签名直传（仅对象存储支持），请改用分片上传`,
    );
  }

  const signed = await target.adapter.getSignedUploadUrl(target.key, SIGNED_URL_TTL_SECONDS, {
    contentType: mimeOfExt(ext),
    contentLength: input.size,
  });
  if (!signed) {
    throw forbidden('该存储未返回可用的预签名上传地址，请改用分片上传');
  }

  log.info(
    { userId, mode: input.mode, size: input.size, storageId: target.storageId },
    '签发预签名上传',
  );

  return {
    kind: 'presigned',
    url: signed.url,
    method: signed.method,
    headers: signed.headers,
    // 回传逻辑 key 供确认时核对；存储的命名空间前缀不对外暴露
    objectKey: target.key,
    expiresIn: SIGNED_URL_TTL_SECONDS,
  };
}

export interface PresignCompleteInput {
  filename: string;
  size: number;
  md5: string;
  objectKey: string;
  mode: 'create' | 'version';
  bookId?: number | undefined;
  fields: UploadFields;
}

/**
 * 确认直传完成并入库。
 *
 * 这里做的全是「不信任客户端」的核对 —— 客户端说它传完了，得自己去存储上
 * 看一眼才算数。
 */
/**
 * 到存储上核对客户端声称已传完的那个对象。
 *
 * 客户端说传完了不算数 —— 这里自己去存储上确认「对象在、大小对、内容对」。
 */
async function verifyUploadedObject(
  userId: number,
  adapter: StorageAdapter,
  key: string,
  expected: { size: number; md5: string },
): Promise<void> {
  const meta = await adapter.stat(key);
  if (!meta) {
    throw badRequest('对象存储上找不到刚上传的文件，可能上传未完成或已过期，请重新上传');
  }
  if (meta.size !== expected.size) {
    throw badRequest(
      `文件大小不符：预期 ${expected.size} 字节，存储上实际 ${meta.size} 字节，请重新上传`,
    );
  }

  /*
   * 用 ETag 校验内容完整性。
   *
   * 单次 PUT 的 ETag 就是内容的 MD5 十六进制（带引号），因此能和客户端上报的
   * md5 比对 —— 这是服务端在不下载文件的前提下唯一能做的内容校验。
   * 分片上传（multipart）的 ETag 形如 `<hash>-<parts>`，不是 MD5，此时跳过：
   * 宁可少校验一次，也不能把合法的上传误判成损坏。
   */
  const etag = meta.etag?.replace(/^"|"$/g, '').toLowerCase() ?? '';
  if (/^[a-f0-9]{32}$/.test(etag) && etag !== expected.md5.toLowerCase()) {
    // 内容对不上就删掉，不留一个永远没人认领的孤儿对象
    await adapter.delete(key).catch(() => undefined);
    log.warn({ userId, expected: expected.md5, actual: etag }, '预签名直传的内容校验失败');
    throw badRequest('文件校验失败（内容与声明的 MD5 不一致），请重新上传');
  }
}

export async function completePresignedUpload(
  userId: number,
  input: PresignCompleteInput,
): Promise<UploadBookResult | BookDetail> {
  const { ext } = assertAllowedExtensionName(input.filename);
  assertSizeAllowed(input.size, userId);

  const expected = { size: input.size, md5: input.md5 };

  if (input.mode === 'version' && input.bookId !== undefined) {
    const target = await resolveVersionTarget(userId, input.bookId, input.md5, ext);

    // 核对客户端回传的 objectKey：不核的话，客户端可以声称「我刚传的是那个对象」，
    // 把存储上任意一个对象登记成自己的。key 由 md5 派生且带 userId 前缀，重算即可挡住。
    if (input.objectKey !== target.key) {
      log.warn({ userId, claimed: input.objectKey }, '预签名确认的 objectKey 不符');
      throw badRequest('对象位置与文件指纹不匹配，请重新上传');
    }

    await verifyUploadedObject(userId, target.adapter, target.key, expected);
    return insertVersionRecords(userId, input.bookId, {
      size: input.size,
      md5: input.md5,
      key: target.key,
      storageId: target.storageId,
      note: (input.fields.note ?? '').trim() || null,
    });
  }

  const target = await resolveBookTarget(userId, input.md5, ext, input.fields);

  if (input.objectKey !== target.key) {
    log.warn({ userId, claimed: input.objectKey, expected: target.key }, '预签名确认的 objectKey 不符');
    throw badRequest('对象位置与文件指纹不匹配，请重新上传');
  }

  await verifyUploadedObject(userId, target.adapter, target.key, expected);

  // 并发下的秒传竞态由 insertBookRecords 内部兜住
  return insertBookRecords(userId, {
    title: target.title,
    format: target.format,
    storageId: target.storageId,
    key: target.key,
    size: input.size,
    md5: input.md5,
    fields: input.fields,
  });
}
