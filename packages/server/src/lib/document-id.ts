import { createHash } from 'node:crypto';
import { open, stat } from 'node:fs/promises';
import { KOREADER_SAMPLE_SIZE, computeKoreaderDocumentId } from '@readsync/shared';
import { getModuleLogger } from '../logger.js';

/**
 * 算出「阅读器会用来标识这本书」的文档标识（KOReader 的 partial MD5）。
 *
 * 为什么服务端要算它：书库里的书是用**整文件 MD5** 去重的，而 KOReader 同步
 * 进度时用的是**采样 MD5**。两者永不相等 —— 所以只有整文件 MD5 的话，进度
 * 永远关联不到上传的书上，只能退化成按书名精确匹配（书名一改就断）。
 * 上传时服务端手上有文件，顺手算出来存下，关联就精确了。
 *
 * 约束：文件可能上百 MB，绝不能整份读进内存。只按采样偏移做定位读，
 * 最多读 12KB。
 */

const log = getModuleLogger('library');

/** 从本地文件计算；文件读不到时返回 null（关联退化为旧行为，不影响上传本身） */
export async function koreaderDocumentIdFromFile(filePath: string): Promise<string | null> {
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    const info = await stat(filePath);
    if (!info.isFile()) return null;
    // 空文件不做特殊处理：KOReader 对空文件也会算出「空内容的 MD5」
    // （d41d8cd9…）。忠实照做，免得在这个边界上与阅读器产生分歧。
    handle = await open(filePath, 'r');

    return await computeKoreaderDocumentId(
      () => {
        const hash = createHash('md5');
        return {
          update: (data: Uint8Array) => hash.update(data),
          digest: () => hash.digest('hex'),
        };
      },
      async (offset, length) => {
        // 越界的位置直接当作「读不到」，与 KOReader 的 seek 到文件尾再 read 一致
        if (offset >= info.size) return null;
        const buffer = Buffer.alloc(Math.min(length, KOREADER_SAMPLE_SIZE));
        const { bytesRead } = await handle!.read(buffer, 0, buffer.length, offset);
        if (bytesRead === 0) return null;
        return buffer.subarray(0, bytesRead);
      },
    );
  } catch (err) {
    // 算不出来不该让上传失败 —— 这只是让进度关联更准，不是上传的必要条件
    log.warn({ err, filePath }, '计算文档标识失败，将退化为按文件名/整文件 MD5 关联');
    return null;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}
