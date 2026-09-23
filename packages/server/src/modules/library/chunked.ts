import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ChunkedUploadSession } from '@readsync/shared';
import { loadConfig } from '../../config.js';
import { badRequest, notFound, payloadTooLarge } from '../../errors.js';
import { getModuleLogger } from '../../logger.js';
import {
  assertAllowedExtensionName,
  assertWithinQuota,
  commitNewBook,
  commitNewVersion,
  type ReceivedUpload,
  type UploadFields,
} from './service.js';

/**
 * 分片上传。
 *
 * 为什么需要它：整份文件一次性 POST 时，请求体大小与请求耗时都受中间层约束 ——
 * Nginx 的 client_max_body_size 默认只有 1 MB，Cloudflare 橙云（含 Tunnel）
 * 对请求体与请求时长都有上限且免费版调不了。这些限制都在客户端与服务端之间，
 * 服务端再正确也绕不过去。
 *
 * 切成小块逐个上传后，每个请求都很小、都在几秒内完成，上述限制自然不再触发。
 * 代价是请求数变多，以及服务端要维护「合并中的上传」这个中间状态。
 *
 * 状态放磁盘而不是数据库：分片本身就要落盘，把会话元数据放在同一个目录里，
 * 两者天然同生命周期，也省掉一次 schema 迁移。进程重启后未完成的上传仍在原处。
 */

const log = getModuleLogger('library');

/** 单个分片的大小。4 MiB 是保守值：慢速上行（512 Kbps）下约 64 秒传完，仍在常见代理超时之内 */
const DEFAULT_CHUNK_SIZE = 4 * 1024 * 1024;

/** 分片大小可通过环境变量调整，但夹在合理区间内，避免配出离谱的值 */
export function resolveChunkSize(): number {
  const raw = Number(process.env.READSYNC_UPLOAD_CHUNK_SIZE ?? '');
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_CHUNK_SIZE;
  const min = 256 * 1024;
  const max = 64 * 1024 * 1024;
  return Math.min(Math.max(Math.floor(raw), min), max);
}

/**
 * 分片数上限。
 *
 * 防止客户端用「1 字节一个分片」造出天量文件把 inode 耗光；
 * 按 4 MiB 分片算，10 万片对应 400 GB，远超个人书库的合理范围。
 */
const MAX_CHUNKS = 100_000;

/** 未完成会话的保留时长；超过则由清理逻辑删除，避免中途放弃的上传永久占盘 */
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * 会话 id 必须严格校验。
 *
 * 它会被拼进文件路径，一旦允许 `/`、`..` 之类的字符就是路径穿越漏洞。
 * 这里只放行本服务自己生成的 32 位十六进制串，从源头上杜绝。
 */
const UPLOAD_ID_RE = /^[a-f0-9]{32}$/;

function assertUploadId(id: string): string {
  if (!UPLOAD_ID_RE.test(id)) throw badRequest('上传会话 id 不合法');
  return id;
}

/**
 * 分片标记文件名（`000007.done`）。
 *
 * 序号要补零：这样按文件名排序与数值顺序一致，出问题时 ls 一眼就能看出缺哪片。
 * 序号同样会进路径，因此必须校验。
 */
function chunkMarkerName(index: number): string {
  if (!Number.isInteger(index) || index < 0 || index >= MAX_CHUNKS) {
    throw badRequest('分片序号不合法');
  }
  return `${String(index).padStart(6, '0')}.done`;
}

function chunkedRoot(): string {
  return path.join(loadConfig().tmpDir, 'chunked');
}

function sessionDir(uploadId: string): string {
  return path.join(chunkedRoot(), uploadId);
}

/* ------------------------------- 会话读写 ------------------------------- */

export async function createSession(input: {
  userId: number;
  mode: 'create' | 'version';
  bookId?: number | undefined;
  filename: string;
  size: number;
  md5?: string | undefined;
  fields: UploadFields;
}): Promise<ChunkedUploadSession & { chunkSize: number }> {
  // 一开始就校验类型，不能让用户把几百 MB 传完才被告知格式不支持
  assertAllowedExtensionName(input.filename);

  const chunkSize = resolveChunkSize();
  const totalChunks = Math.max(1, Math.ceil(input.size / chunkSize));
  if (totalChunks > MAX_CHUNKS) {
    throw payloadTooLarge(`分片数超过上限（${MAX_CHUNKS}），请减少文件大小或调大 READSYNC_UPLOAD_CHUNK_SIZE`);
  }

  const id = randomUUID().replace(/-/g, '');
  const session: ChunkedUploadSession = {
    uploadId: id,
    mode: input.mode,
    ...(input.bookId !== undefined ? { bookId: input.bookId } : {}),
    filename: input.filename,
    size: input.size,
    ...(input.md5 ? { md5: input.md5 } : {}),
    fields: input.fields,
    userId: input.userId,
    chunkSize,
    totalChunks,
    createdAt: new Date().toISOString(),
  };

  const dir = sessionDir(id);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'session.json'), JSON.stringify(session), 'utf8');

  log.info({ userId: input.userId, uploadId: id, size: input.size, totalChunks }, '创建分片上传会话');
  void sweepExpiredSessions();
  return session;
}

/**
 * 读取会话并校验归属。
 *
 * 越权必须在这层拦住：会话里的 userId 是创建时写入的，任何其它账号
 * 拿到 uploadId 也不能续传、合并或中止别人的上传。
 */
export async function loadSession(uploadId: string, userId: number): Promise<ChunkedUploadSession> {
  assertUploadId(uploadId);
  let raw: string;
  try {
    raw = await readFile(path.join(sessionDir(uploadId), 'session.json'), 'utf8');
  } catch {
    throw notFound('上传会话不存在或已过期，请重新上传');
  }

  const session = JSON.parse(raw) as ChunkedUploadSession;
  if (session.userId !== userId) {
    // 不区分「不存在」与「不属于你」，避免泄露他人会话是否存在
    log.warn({ uploadId, userId, owner: session.userId }, '分片上传会话越权访问');
    throw notFound('上传会话不存在或已过期，请重新上传');
  }
  return session;
}

export async function discardSession(uploadId: string, userId: number): Promise<void> {
  const session = await loadSession(uploadId, userId);
  await rm(sessionDir(session.uploadId), { recursive: true, force: true });
  log.info({ userId, uploadId }, '已放弃分片上传会话');
}

/* ------------------------------- 分片写入 ------------------------------- */

/**
 * 落一个分片。
 *
 * 分片按偏移**直接写进最终的那一个文件**，不先存成独立文件再合并 ——
 * 后者会让同一份数据在磁盘上短暂存在两份，几百 MB 的书在自托管小机器上
 * 很容易把盘写满。位置由序号算出，因此分片可以乱序到达、也可以重传覆盖。
 *
 * 每写完一片落一个 `<序号>.done` 标记，合并时据此判断完整性。
 * 不能只看文件大小：中间缺片时，后续分片的写入会把文件撑到完整长度，
 * 缺的那段是空洞（读出来全是 0），大小完全正常却是个损坏的文件。
 */
export async function writeChunk(
  uploadId: string,
  index: number,
  userId: number,
  data: Buffer,
): Promise<{ received: number; total: number }> {
  const session = await loadSession(uploadId, userId);
  if (index >= session.totalChunks) throw badRequest('分片序号超出范围');

  const isLast = index === session.totalChunks - 1;
  const offset = index * session.chunkSize;
  const expected = isLast ? session.size - offset : session.chunkSize;

  if (expected <= 0) {
    throw badRequest('文件内容为空');
  }
  // 非末片必须正好一片；末片允许小于（但不超过）一片 —— 客户端分片逻辑
  // 写错时能立刻发现，不必等到合并出一个损坏的文件
  if (isLast ? data.length > expected || data.length === 0 : data.length !== expected) {
    throw badRequest(
      `分片大小不正确：第 ${index} 片应为 ${expected} 字节，实际 ${data.length} 字节`,
    );
  }

  const dir = sessionDir(uploadId);
  const handle = await openForWrite(path.join(dir, 'blob'));
  try {
    await handle.write(data, 0, data.length, offset);
  } finally {
    await handle.close();
  }
  // 标记必须在数据写完之后落，否则崩溃时会留下「标记有、数据是空洞」的假完整
  await writeFile(path.join(dir, chunkMarkerName(index)), '', 'utf8');

  return { received: index, total: session.totalChunks };
}

/**
 * 打开待合并文件用于按位置写入。
 *
 * 不能用 'a'/'a+'：那是 O_APPEND，**写入位置会被忽略**，所有分片都会追加到
 * 文件末尾 —— 分片乱序或重传时文件立刻损坏。这里用 'r+'（已存在）或 'w'（首次）。
 */
async function openForWrite(filePath: string): Promise<import('node:fs/promises').FileHandle> {
  const { open } = await import('node:fs/promises');
  try {
    return await open(filePath, 'r+');
  } catch {
    return await open(filePath, 'w');
  }
}

/**
 * 合并分片并入库。
 *
 * 这里不信任客户端上报的 md5 与 size：合并时自己流式重算一遍，
 * 不一致就拒绝。分片乱序、丢片、被截断都会在这一步暴露。
 */
export async function completeSession(
  uploadId: string,
  userId: number,
): Promise<{ kind: 'create'; result: Awaited<ReturnType<typeof commitNewBook>> } | { kind: 'version'; result: Awaited<ReturnType<typeof commitNewVersion>> }> {
  const session = await loadSession(uploadId, userId);
  const dir = sessionDir(uploadId);
  const blobPath = path.join(dir, 'blob');

  // 合并前再校一次类型：会话创建时已校过，但那之后管理员可能收紧了白名单
  const { ext } = assertAllowedExtensionName(session.filename);

  // 合并前先确认所有分片都到了。判据是 .done 标记而不是 blob 的大小：
  // blob 按偏移写入，中间缺片会被后续分片撑到完整长度，大小看不出问题。
  const present = await readdir(dir);
  const have = new Set(
    present.filter((f) => f.endsWith('.done')).map((f) => Number.parseInt(f, 10)),
  );
  const missing: number[] = [];
  for (let i = 0; i < session.totalChunks; i += 1) {
    if (!have.has(i)) {
      missing.push(i);
      if (missing.length >= 10) break;
    }
  }
  if (missing.length > 0) {
    throw badRequest(`还有分片未上传（如第 ${missing.join('、')} 片），请补传后再合并`);
  }

  const info = await stat(blobPath).catch(() => null);
  if (!info) throw badRequest('未收到任何分片，请重新上传');
  if (info.size !== session.size) {
    throw badRequest(`合并后大小不符：预期 ${session.size} 字节，实际 ${info.size} 字节`);
  }

  // 流式重算 MD5，避免把整个文件读进内存
  const hash = createHash('md5');
  for await (const chunk of createReadStream(blobPath)) {
    hash.update(chunk as Buffer);
  }
  const md5 = hash.digest('hex');

  if (session.md5 && session.md5.toLowerCase() !== md5) {
    log.warn({ uploadId, userId, expected: session.md5, actual: md5 }, '分片合并后 MD5 不符');
    throw badRequest('文件校验失败（MD5 不一致），请重新上传');
  }

  await assertWithinQuota(userId, session.size);

  const received: ReceivedUpload = { ext, size: session.size, md5, tmpPath: blobPath };

  try {
    if (session.mode === 'version') {
      if (session.bookId === undefined) throw badRequest('会话缺少书籍 id');
      const result = await commitNewVersion(userId, session.bookId, received, session.fields);
      return { kind: 'version', result };
    }
    const result = await commitNewBook(userId, received, session.fields);
    return { kind: 'create', result };
  } finally {
    // 无论成败都清掉整个会话目录（含 blob），否则磁盘会被失败的上传慢慢吃满
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}


/* ------------------------------- 清理 ------------------------------- */

/**
 * 删除超时未完成的会话。
 *
 * 中途放弃的上传不会自己消失，blob 可能已经写了几百 MB。这里按目录的
 * 修改时间判断，且在每次创建会话时顺带跑一次 —— 不引入定时器，
 * 也不会因为进程空闲而积累垃圾。
 */
export async function sweepExpiredSessions(): Promise<number> {
  const root = chunkedRoot();
  let removed = 0;
  try {
    const entries = await readdir(root, { withFileTypes: true });
    const now = Date.now();
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const dir = path.join(root, entry.name);
      try {
        const info = await stat(dir);
        if (now - info.mtimeMs > SESSION_TTL_MS) {
          await rm(dir, { recursive: true, force: true });
          removed += 1;
        }
      } catch {
        // 单个目录清理失败不该影响其它会话
      }
    }
  } catch {
    // 根目录还不存在（从未有人用过）—— 不是错误
  }
  if (removed > 0) log.info({ removed }, '清理超时的分片上传会话');
  return removed;
}
