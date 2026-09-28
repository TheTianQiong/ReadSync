import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { open, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { KOREADER_SAMPLE_SIZE, computeKoreaderDocumentId } from '@readsync/shared';
import { loadConfig } from '../config.js';
import type { StorageAdapter } from '../modules/storage/types.js';
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

/**
 * 从存储后端算文档标识（用于给「修复之前上传的书」补上这一列）。
 *
 * 优先用驱动的范围读：只取 12 个 1KB 窗口，总共 12KB。若驱动不支持
 * （插件自定义的驱动可能没有实现 getRange），退化为整份下载到临时文件再算 ——
 * 代价大得多，但总比补不上好。
 */
export async function koreaderDocumentIdFromStorage(
  adapter: StorageAdapter,
  key: string,
  size: number,
): Promise<string | null> {
  try {
    if (adapter.getRange) {
      return await computeKoreaderDocumentId(
        () => {
          const hash = createHash('md5');
          return {
            update: (data: Uint8Array) => hash.update(data),
            digest: () => hash.digest('hex'),
          };
        },
        async (offset, length) => {
          if (offset >= size) return null;
          return adapter.getRange!(key, offset, length);
        },
      );
    }

    // 退路：整份下载到临时文件
    const got = await adapter.get(key);
    if (!got.stream) return null;
    const tmpPath = path.join(loadConfig().tmpDir, `docid-${randomUUID()}.tmp`);
    try {
      await pipeline(got.stream as NodeJS.ReadableStream, createWriteStream(tmpPath));
      return await koreaderDocumentIdFromFile(tmpPath);
    } finally {
      await rm(tmpPath, { force: true }).catch(() => undefined);
    }
  } catch (err) {
    log.warn({ err, key }, '从存储计算文档标识失败');
    return null;
  }
}
