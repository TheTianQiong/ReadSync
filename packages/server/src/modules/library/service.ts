import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { and, asc, count, desc, eq, sql } from 'drizzle-orm';
import type { FastifyRequest } from 'fastify';
import { BOOK_FORMATS, ERROR_CODES } from '@readsync/shared';
import type {
  BookDetail,
  BookFormat,
  BookSummary,
  BookVersion,
  CheckBookExistsResult,
  CreateBookInput,
  ListBooksQuery,
  Paginated,
} from '@readsync/shared';
import type { z } from 'zod';
import { loadConfig } from '../../config.js';
import { getDb } from '../../db/index.js';
import { bookVersions, books, storages, type BookRow, type BookVersionRow } from '../../db/schema.js';
import {
  badRequest,
  conflict,
  forbidden,
  isAppError,
  notFound,
  payloadTooLarge,
  storageError,
  unsupportedMediaType,
} from '../../errors.js';
import { getModuleLogger } from '../../logger.js';
import { getSiteSettings } from '../../lib/settings.js';
import { getAdapterForStorage, getDefaultAdapter } from '../storage/service.js';
import { assertSafeKey, buildBookKey, type StorageAdapter } from '../storage/types.js';

/**
 * 个人书库业务逻辑。
 *
 * 设计要点（对应任务背景）：
 *  - 服务器本地存储有限，书籍文件通常放在 WebDAV / 对象存储上，本地只保存
 *    MD5、书籍元数据与版本记录，并承担「上传中转 / 下载中转」；
 *  - 因此 books.storageId 指向真实存放文件的存储后端，本模块的所有文件操作
 *    都通过 StorageAdapter 完成，不假设本地有副本。
 *
 * 安全要点：
 *  - 客户端传来的 filename 只用于取扩展名，绝不作为磁盘路径（防路径穿越）；
 *  - 客户端传来的 objectKey（POST /api/books）必须过 assertSafeKey 后才能落库；
 *  - 配额校验、扩展名白名单、大小限制都在写入远端存储之前完成。
 */

/** updateBookSchema 未在 shared 中导出对应的 Input 类型，这里从 schema 推导（仅类型，不引入运行时依赖） */
type UpdateBookInput = z.infer<typeof import('@readsync/shared').updateBookSchema>;

/** req.file() 的返回类型；避免直接依赖 @fastify/multipart 的 export= 命名导出写法 */
type UploadedFile = NonNullable<Awaited<ReturnType<FastifyRequest['file']>>>;

const log = getModuleLogger('library');

/* ============================ 对外数据结构 ============================ */

/** 下载所需信息：S3 走预签名重定向，其它驱动走流式中转 */
export type DownloadTarget =
  | { kind: 'redirect'; url: string; filename: string; contentType: string; size: number }
  | { kind: 'stream'; stream: Readable; filename: string; contentType: string; size: number };

export interface DeleteBookResult {
  id: number;
  title: string;
  /** 成功删除的远端对象数 */
  deletedFiles: number;
  /** 删除失败的 objectKey（远端异常时保留记录，便于后续手工清理） */
  failedFiles: string[];
}

export interface UploadBookResult {
  book: BookDetail;
  /** 是否命中秒传（相同 MD5 已存在，未真正上传） */
  deduped: boolean;
}

/* ============================== DTO 映射 ============================== */

interface BookWithStorage {
  book: BookRow;
  storageName: string | null;
}

function toBookSummary(row: BookWithStorage): BookSummary {
  const b = row.book;
  return {
    id: b.id,
    ownerId: b.ownerId,
    title: b.title,
    author: b.author,
    publisher: b.publisher,
    isbn: b.isbn,
    // format 列为 text，写入时已受 BOOK_FORMATS 约束；历史脏数据回退为 'other'
    format: (BOOK_FORMATS as readonly string[]).includes(b.format) ? (b.format as BookFormat) : 'other',
    size: b.size,
    md5: b.md5,
    coverUrl: b.coverUrl,
    description: b.description,
    tags: b.tags ?? [],
    language: b.language,
    readingStatus: b.readingStatus,
    progressPercent: b.progressPercent,
    totalPages: b.totalPages,
    totalWords: b.totalWords,
    currentVersion: b.currentVersion,
    storageId: b.storageId,
    storageName: row.storageName,
    totalReadingSeconds: b.totalReadingSeconds,
    // 时间统一按 RFC3339 字符串对外
    lastReadAt: b.lastReadAt ? b.lastReadAt.toISOString() : null,
    createdAt: b.createdAt.toISOString(),
    updatedAt: b.updatedAt.toISOString(),
  };
}

function toBookVersion(row: BookVersionRow): BookVersion {
  return {
    id: row.id,
    bookId: row.bookId,
    version: row.version,
    size: row.size,
    md5: row.md5,
    objectKey: row.objectKey,
    storageId: row.storageId,
    note: row.note,
    uploadedBy: row.uploadedBy,
    createdAt: row.createdAt.toISOString(),
  };
}

/* ============================== 查询实现 ============================== */

/** 书籍 + 存储名（storageName 需要 join storages 表） */
function baseBookQuery() {
  return getDb()
    .select({ book: books, storageName: storages.name })
    .from(books)
    .leftJoin(storages, eq(books.storageId, storages.id));
}

function getOwnedBook(userId: number, bookId: number): BookWithStorage {
  const row = baseBookQuery()
    .where(and(eq(books.id, bookId), eq(books.ownerId, userId)))
    .get();
  if (!row) {
    // 不区分「不存在」与「属于别人」，避免通过 404/403 差异探测他人书库
    throw notFound('书籍不存在');
  }
  return row;
}

function findBookByMd5(userId: number, md5: string): BookWithStorage | undefined {
  return baseBookQuery()
    .where(and(eq(books.ownerId, userId), eq(books.md5, md5)))
    .get();
}

/** LIKE 通配符转义，避免用户输入的 % / _ 变成通配（值仍走参数绑定，无注入风险） */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}

function sortColumn(sortBy: ListBooksQuery['sortBy']) {
  switch (sortBy) {
    case 'title':
      return books.title;
    case 'author':
      return books.author;
    case 'size':
      return books.size;
    case 'updatedAt':
      return books.updatedAt;
    case 'lastReadAt':
      return books.lastReadAt;
    case 'createdAt':
    default:
      return books.createdAt;
  }
}

/** 书库列表：支持书名/作者模糊搜索、格式/状态/标签过滤与排序 */
export function listBooks(userId: number, query: ListBooksQuery): Paginated<BookSummary> {
  const db = getDb();
  const conditions = [eq(books.ownerId, userId)];

  if (query.q) {
    const pattern = `%${escapeLike(query.q)}%`;
    conditions.push(
      sql`(${books.title} LIKE ${pattern} ESCAPE '\\' OR coalesce(${books.author}, '') LIKE ${pattern} ESCAPE '\\')`,
    );
  }
  if (query.format) {
    conditions.push(eq(books.format, query.format));
  }
  if (query.readingStatus) {
    conditions.push(eq(books.readingStatus, query.readingStatus));
  }
  if (query.tag) {
    // tags 以 JSON 数组存放，用 json_each 精确匹配单个标签（参数绑定，避免 LIKE 误匹配）
    conditions.push(sql`exists (select 1 from json_each(${books.tags}) where json_each.value = ${query.tag})`);
  }

  const where = and(...conditions);

  const total = db.select({ value: count() }).from(books).where(where).get()?.value ?? 0;

  const column = sortColumn(query.sortBy);
  const order = query.sortOrder === 'asc' ? asc(column) : desc(column);

  const rows = baseBookQuery()
    .where(where)
    // 次级按 id 排序，保证同一排序键下分页结果稳定
    .orderBy(order, desc(books.id))
    .limit(query.pageSize)
    .offset((query.page - 1) * query.pageSize)
    .all();

  return {
    items: rows.map(toBookSummary),
    total,
    page: query.page,
    pageSize: query.pageSize,
    totalPages: Math.ceil(total / query.pageSize),
  };
}

export function listBookVersions(userId: number, bookId: number): BookVersion[] {
  // 先校验归属，避免越权读取他人书籍的版本历史
  getOwnedBook(userId, bookId);
  return getDb()
    .select()
    .from(bookVersions)
    .where(eq(bookVersions.bookId, bookId))
    .orderBy(desc(bookVersions.version))
    .all()
    .map(toBookVersion);
}

export function getBookDetail(userId: number, bookId: number): BookDetail {
  const row = getOwnedBook(userId, bookId);
  return { ...toBookSummary(row), versions: listBookVersions(userId, bookId) };
}

export function checkBookExists(userId: number, md5: string): CheckBookExistsResult {
  const row = findBookByMd5(userId, md5);
  return row ? { exists: true, book: toBookSummary(row) } : { exists: false, book: null };
}

/* ============================ 存储解析与校验 ============================ */

/** 校验存储属于当前用户且启用（用于只登记元数据、不实际写文件的场景） */
function assertOwnedStorage(userId: number, storageId: number): void {
  const row = getDb()
    .select({ id: storages.id })
    .from(storages)
    .where(and(eq(storages.id, storageId), eq(storages.userId, userId), eq(storages.enabled, true)))
    .get();
  if (!row) throw notFound('存储后端不存在、不属于当前用户或已禁用');
}

/**
 * 按 id 取当前用户的存储适配器（委托给 storage 模块实现）。
 * storage/service.ts 对「不存在/被禁用」抛 NOT_FOUND，这里换成更贴近书库语义的提示。
 */
export async function resolveStorageAdapter(storageId: number, userId: number): Promise<StorageAdapter> {
  try {
    return await getAdapterForStorage(storageId, userId);
  } catch (err) {
    if (isAppError(err) && err.code === ERROR_CODES.NOT_FOUND) {
      throw notFound('存储后端不存在、不属于当前用户或已禁用');
    }
    throw err;
  }
}

/** 取用户默认存储；一个都没配置时给出可操作的中文提示 */
async function resolveDefaultStorage(userId: number): Promise<{ storageId: number; adapter: StorageAdapter }> {
  try {
    return await getDefaultAdapter(userId);
  } catch (err) {
    if (isAppError(err) && err.code === ERROR_CODES.NOT_FOUND) {
      throw notFound('尚未配置默认存储，请先在「存储管理」中添加一个存储并设为默认');
    }
    throw err;
  }
}

/** objectKey 来自客户端时（POST /api/books）必须校验，防止写入 .. 等穿越片段后被本地驱动解析出根目录 */
function safeKeyOrThrow(key: string): void {
  try {
    assertSafeKey(key);
  } catch (err) {
    throw badRequest(`非法的对象键：${err instanceof Error ? err.message : String(err)}`);
  }
}

/* ============================== 常规增删改 ============================== */

export async function createBook(userId: number, input: CreateBookInput): Promise<BookDetail> {
  const db = getDb();

  const duplicate = findBookByMd5(userId, input.md5);
  if (duplicate) {
    throw conflict('该文件已存在于你的书库中（相同 MD5）');
  }

  // objectKey 由客户端提供，落库前必须校验安全性
  safeKeyOrThrow(input.objectKey);

  const storageId = input.storageId ?? (await resolveDefaultStorage(userId)).storageId;
  assertOwnedStorage(userId, storageId);

  const now = new Date();
  let bookId: number;
  try {
    const inserted = db
      .insert(books)
      .values({
        ownerId: userId,
        title: input.title,
        author: input.author ?? null,
        publisher: input.publisher ?? null,
        isbn: input.isbn ?? null,
        format: input.format,
        size: input.size,
        md5: input.md5,
        objectKey: input.objectKey,
        storageId,
        currentVersion: 1,
        coverUrl: input.coverUrl ?? null,
        description: input.description ?? null,
        tags: input.tags ?? [],
        language: input.language ?? null,
        totalPages: input.totalPages ?? null,
        totalWords: input.totalWords ?? null,
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: books.id })
      .get();
    bookId = inserted.id;
  } catch (err) {
    // 并发登记同一 MD5 时唯一索引会报错，转成业务冲突而不是 500
    if (isUniqueConstraintError(err)) {
      throw conflict('该文件已存在于你的书库中（相同 MD5）');
    }
    throw err;
  }

  db.insert(bookVersions)
    .values({
      bookId,
      version: 1,
      size: input.size,
      md5: input.md5,
      objectKey: input.objectKey,
      storageId,
      note: '初次入库',
      uploadedBy: userId,
      createdAt: now,
    })
    .run();

  log.info({ userId, bookId, md5: input.md5, storageId }, '登记书籍');
  return getBookDetail(userId, bookId);
}

export function updateBook(userId: number, bookId: number, input: UpdateBookInput): BookDetail {
  // 先确认归属
  getOwnedBook(userId, bookId);

  const patch: Partial<typeof books.$inferInsert> = { updatedAt: new Date() };
  if (input.title !== undefined) patch.title = input.title;
  if (input.author !== undefined) patch.author = input.author;
  if (input.publisher !== undefined) patch.publisher = input.publisher;
  if (input.isbn !== undefined) patch.isbn = input.isbn;
  if (input.coverUrl !== undefined) patch.coverUrl = input.coverUrl;
  if (input.description !== undefined) patch.description = input.description;
  if (input.tags !== undefined) patch.tags = input.tags;
  if (input.language !== undefined) patch.language = input.language;
  if (input.readingStatus !== undefined) patch.readingStatus = input.readingStatus;
  // progressPercent 在库中是 0-100 的整数，schema 允许小数，这里四舍五入
  if (input.progressPercent !== undefined) patch.progressPercent = Math.round(input.progressPercent);
  if (input.totalPages !== undefined) patch.totalPages = input.totalPages;
  if (input.totalWords !== undefined) patch.totalWords = input.totalWords;

  getDb().update(books).set(patch).where(eq(books.id, bookId)).run();
  return getBookDetail(userId, bookId);
}

/**
 * 删除书籍：先删远端对象，再删版本行与主记录。
 *
 * 权衡：远端删除失败时不阻断数据库清理（用户语义上是「从书库移除」），
 * 失败的 objectKey 返回给调用方，避免因某个存储临时不可用导致记录永远删不掉。
 */
export async function deleteBook(userId: number, bookId: number): Promise<DeleteBookResult> {
  const { book } = getOwnedBook(userId, bookId);
  const db = getDb();

  const versions = db.select().from(bookVersions).where(eq(bookVersions.bookId, bookId)).all();

  // 用 storageId:objectKey 去重：同一对象可能被多个版本引用（如回滚后）
  const targets = new Map<string, { storageId: number; objectKey: string; size: number }>();
  targets.set(`${book.storageId}:${book.objectKey}`, {
    storageId: book.storageId,
    objectKey: book.objectKey,
    size: book.size,
  });
  for (const v of versions) {
    targets.set(`${v.storageId}:${v.objectKey}`, { storageId: v.storageId, objectKey: v.objectKey, size: v.size });
  }

  const adapters = new Map<number, StorageAdapter>();
  const freedByStorage = new Map<number, number>();
  const failedFiles: string[] = [];
  let deletedFiles = 0;

  for (const target of targets.values()) {
    try {
      let adapter = adapters.get(target.storageId);
      if (!adapter) {
        adapter = await resolveStorageAdapter(target.storageId, userId);
        adapters.set(target.storageId, adapter);
      }
      await adapter.delete(target.objectKey);
      deletedFiles += 1;
      freedByStorage.set(target.storageId, (freedByStorage.get(target.storageId) ?? 0) + target.size);
    } catch (err) {
      log.warn({ err, storageId: target.storageId, objectKey: target.objectKey }, '删除远端对象失败，继续清理数据库记录');
      failedFiles.push(target.objectKey);
    }
  }

  // 版本行、主记录、容量统计放在同一事务，避免删一半留下孤儿数据
  db.transaction((tx) => {
    tx.delete(bookVersions).where(eq(bookVersions.bookId, bookId)).run();
    tx.delete(books).where(eq(books.id, bookId)).run();

    for (const [storageId, freed] of freedByStorage) {
      tx.update(storages)
        .set({
          usedBytes: sql`max(0, coalesce(${storages.usedBytes}, 0) - ${freed})`,
          updatedAt: new Date(),
        })
        .where(eq(storages.id, storageId))
        .run();
    }
  });

  log.info({ userId, bookId, deletedFiles, failedFiles: failedFiles.length }, '删除书籍');
  return { id: bookId, title: book.title, deletedFiles, failedFiles };
}

/* ============================ 文件类型与容量 ============================ */

/** 常见电子书格式的 MIME；驱动不支持时用 octet-stream 也能正常下载 */
const EXT_MIME: Record<string, string> = {
  epub: 'application/epub+zip',
  pdf: 'application/pdf',
  mobi: 'application/x-mobipocket-ebook',
  azw3: 'application/vnd.amazon.ebook',
  azw: 'application/vnd.amazon.ebook',
  fb2: 'application/x-fictionbook+xml',
  txt: 'text/plain; charset=utf-8',
  cbz: 'application/vnd.comicbook+zip',
  cbr: 'application/vnd.comicbook-rar',
  djvu: 'image/vnd.djvu',
  zip: 'application/zip',
  json: 'application/json',
};

function mimeOfExt(ext: string): string {
  return EXT_MIME[ext] ?? 'application/octet-stream';
}

/**
 * 从文件名中安全地取扩展名。
 * 只保留 basename 的最后一个点之后的 [a-z0-9]，其余字符一律丢弃，
 * 这样即使客户端传来 `../../etc/passwd` 或 `a.<script>` 也只会得到空/无害后缀。
 */
function extensionOf(filenameOrKey: string): string {
  const base = filenameOrKey.split(/[/\\]/).pop() ?? '';
  const dot = base.lastIndexOf('.');
  if (dot <= 0 || dot === base.length - 1) return '';
  return base.slice(dot + 1).toLowerCase().replace(/[^a-z0-9]/g, '');
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value.toFixed(1)} ${units[index] ?? 'B'}`;
}

/** 该用户书库已用容量（当前版本大小之和；与 BookSummary.size 口径一致） */
function usedBytesOf(userId: number): number {
  const row = getDb()
    .select({ total: sql<number>`coalesce(sum(${books.size}), 0)` })
    .from(books)
    .where(eq(books.ownerId, userId))
    .get();
  return Number(row?.total ?? 0);
}

/** 配额校验：必须在写入远端存储前执行，避免超配额数据先落地再回滚 */
function assertWithinQuota(userId: number, incomingBytes: number): void {
  const quota = getSiteSettings().userQuotaBytes;
  if (quota <= 0) return; // 0 表示不限制

  const used = usedBytesOf(userId);
  if (used + incomingBytes > quota) {
    throw forbidden(
      `书库容量不足：已使用 ${formatBytes(used)}，本次需要 ${formatBytes(incomingBytes)}，` +
        `配额上限 ${formatBytes(quota)}`,
    );
  }
}

/* ============================ multipart 辅助 ============================ */

function readField(fields: UploadedFile['fields'], name: string): string | undefined {
  const raw = fields[name];
  const entry = Array.isArray(raw) ? raw[0] : raw;
  if (!entry || entry.type !== 'field') return undefined;
  const value = entry.value;
  if (typeof value === 'string') return value;
  if (Buffer.isBuffer(value)) return value.toString('utf8');
  return undefined;
}

function parsePositiveIntField(raw: string, field: string): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) throw badRequest(`${field} 必须是正整数`);
  return value;
}

function parseOptionalCountField(raw: string | undefined, field: string): number | undefined {
  if (raw === undefined || raw.trim() === '') return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) throw badRequest(`${field} 必须是非负整数`);
  return value;
}

/** tags 表单字段为逗号分隔；去重、限长，与 createBookSchema 的约束保持一致 */
function parseTagsField(raw: string | undefined): string[] {
  if (!raw) return [];
  const out: string[] = [];
  for (const part of raw.split(',')) {
    const tag = part.trim().slice(0, 32);
    if (tag && !out.includes(tag)) out.push(tag);
    if (out.length >= 20) break;
  }
  return out;
}

/** 以扩展名派生 format，扩展名不在 BOOK_FORMATS 内时归为 other（如 json/zip 之外的自定义类型） */
function resolveFormat(raw: string | undefined, ext: string): BookFormat {
  const value = (raw ?? '').trim().toLowerCase();
  const known = BOOK_FORMATS as readonly string[];
  if (known.includes(value)) return value as BookFormat;
  if (known.includes(ext)) return ext as BookFormat;
  return 'other';
}

/**
 * 边写临时文件边算 MD5。
 *
 * 必须流式处理：电子书可能上百 MB，整份读进内存会打爆自托管小机器。
 * 大小上限在 Transform 中判定并中断管道，避免把超限内容全部落盘。
 */
async function streamFileToTemp(
  file: UploadedFile,
  tmpPath: string,
  maxBytes: number,
): Promise<{ size: number; md5: string }> {
  const hash = createHash('md5');
  let size = 0;

  const meter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      size += chunk.length;
      if (maxBytes > 0 && size > maxBytes) {
        callback(payloadTooLarge(`文件超过单文件上限 ${formatBytes(maxBytes)}`));
        return;
      }
      hash.update(chunk);
      callback(null, chunk);
    },
  });

  await pipeline(file.file, meter, createWriteStream(tmpPath));
  return { size, md5: hash.digest('hex') };
}

/** 扩展名白名单校验；失败时先 drain 掉文件流，否则 multipart 解析器会卡住连接 */
function assertAllowedExtension(file: UploadedFile): { ext: string; allowed: string[] } {
  const allowed = getSiteSettings().upload.allowedExtensions.map((e) => e.toLowerCase());
  const ext = extensionOf(file.filename ?? '');
  if (!ext || !allowed.includes(ext)) {
    file.file.resume();
    throw unsupportedMediaType(
      `不支持的文件类型${ext ? ` .${ext}` : ''}；允许的扩展名：${allowed.join('、')}`,
    );
  }
  return { ext, allowed };
}

/** 上传前的公共流程：校验类型 → 落临时文件（边算 MD5）→ 大小/配额校验 */
async function receiveUpload(
  file: UploadedFile,
  userId: number,
): Promise<{ ext: string; size: number; md5: string; tmpPath: string }> {
  const { ext } = assertAllowedExtension(file);

  const maxFileSize = getSiteSettings().upload.maxFileSize;
  // 临时文件名只用随机 UUID，绝不使用客户端 filename（防路径穿越 / 覆盖）
  const tmpPath = path.join(loadConfig().tmpDir, `upload-${randomUUID()}.tmp`);

  try {
    const { size, md5 } = await streamFileToTemp(file, tmpPath, maxFileSize);
    if (file.file.truncated) {
      throw payloadTooLarge('文件超过服务器允许的大小上限');
    }
    if (size === 0) {
      throw badRequest('上传的文件内容为空');
    }
    // 配额检查放在这里：此时已知精确大小，且尚未写入任何远端存储
    assertWithinQuota(userId, size);
    return { ext, size, md5, tmpPath };
  } catch (err) {
    // 任何一条校验失败都要清理临时文件，避免 tmpDir 无限增长
    await rm(tmpPath, { force: true }).catch(() => undefined);
    throw err;
  }
}

async function cleanupTemp(tmpPath: string): Promise<void> {
  await rm(tmpPath, { force: true }).catch((err) => {
    log.warn({ err, tmpPath }, '清理上传临时文件失败');
  });
}

/* ============================== 竞态与错误工具 ============================== */

interface UniqueError {
  code?: unknown;
}

/** 判断是否为 SQLite 唯一约束错误（秒传并发竞态的兜底依据） */
function isUniqueConstraintError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const code = (err as UniqueError).code;
  return typeof code === 'string' && code.startsWith('SQLITE_CONSTRAINT');
}

/* ============================== 上传（秒传） ============================== */

/**
 * 登记新书并上传文件。
 *
 * 流程：扩展名白名单 → 流式写临时文件并算 MD5 → 大小/配额校验 → MD5 查重（秒传）
 *      → 适配器 put（流式，不读进内存）→ 插入 books + bookVersions v1 → 累加 usedBytes。
 *
 * 秒传竞态说明：查重与插入之间不是原子操作，两个并发请求可能同时通过查重。
 * 数据库上的唯一索引 (owner_id, md5) 是最终防线：后插入者捕获约束错误后，
 * 返回先插入的那条记录，因此不会产生重复书籍，也不会重复累加 usedBytes。
 */
export async function uploadBook(userId: number, file: UploadedFile): Promise<UploadBookResult> {
  const received = await receiveUpload(file, userId);

  try {
    // 秒传：命中则不上传、不落库，直接返回已有书籍（省流量的关键路径）
    const existing = findBookByMd5(userId, received.md5);
    if (existing) {
      log.info({ userId, bookId: existing.book.id, md5: received.md5 }, '命中秒传，跳过上传');
      return { book: getBookDetail(userId, existing.book.id), deduped: true };
    }

    // text 字段在文件流消费完后才全部可用（客户端通常把字段放在文件之前）
    const fields = file.fields;
    const title = (readField(fields, 'title') ?? '').trim();
    if (!title) throw badRequest('请填写书名（表单字段 title）');
    if (title.length > 256) throw badRequest('书名不能超过 256 个字符');

    const storageIdRaw = readField(fields, 'storageId');
    let storageId: number;
    let adapter: StorageAdapter;
    if (storageIdRaw !== undefined && storageIdRaw.trim() !== '') {
      storageId = parsePositiveIntField(storageIdRaw, 'storageId');
      adapter = await resolveStorageAdapter(storageId, userId);
    } else {
      const resolved = await resolveDefaultStorage(userId);
      storageId = resolved.storageId;
      adapter = resolved.adapter;
    }
    // 写路径要求存储属于当前用户且处于启用状态（getAdapterForStorage 不校验 enabled）
    assertOwnedStorage(userId, storageId);

    // key 由 md5 派生，天然安全；仍过一遍 assertSafeKey 作为纵深防御
    const key = buildBookKey(userId, received.md5, received.ext);
    safeKeyOrThrow(key);

    const stream = createReadStream(received.tmpPath);
    try {
      await adapter.put(key, stream, { contentType: mimeOfExt(received.ext), md5: received.md5, overwrite: true });
    } finally {
      stream.destroy();
    }

    const now = new Date();
    const format = resolveFormat(readField(fields, 'format'), received.ext);

    // 主记录 + 版本行 + 容量统计在同一事务内完成：唯一索引冲突时整体回滚，
    // 不会留下「有书没版本」或「容量已加但书没建」的中间状态。
    const inserted = getDb().transaction((tx): { id: number; deduped: boolean } => {
      // 只有主记录的插入需要兜住并发秒传竞态，因此单独 try；
      // 版本行/容量统计若出错说明是真实故障，应让事务回滚。
      const outcome = ((): { id: number; raced: boolean } => {
        try {
          const row = tx
            .insert(books)
            .values({
              ownerId: userId,
              title,
              author: nonEmpty(readField(fields, 'author')),
              publisher: nonEmpty(readField(fields, 'publisher')),
              isbn: nonEmpty(readField(fields, 'isbn')),
              format,
              size: received.size,
              md5: received.md5,
              objectKey: key,
              storageId,
              currentVersion: 1,
              description: nonEmpty(readField(fields, 'description')),
              tags: parseTagsField(readField(fields, 'tags')),
              language: nonEmpty(readField(fields, 'language')),
              totalPages: parseOptionalCountField(readField(fields, 'totalPages'), 'totalPages') ?? null,
              totalWords: parseOptionalCountField(readField(fields, 'totalWords'), 'totalWords') ?? null,
              createdAt: now,
              updatedAt: now,
            })
            .returning({ id: books.id })
            .get();
          return { id: row.id, raced: false };
        } catch (err) {
          if (isUniqueConstraintError(err)) {
            const existing = findBookByMd5(userId, received.md5);
            if (existing) return { id: existing.book.id, raced: true };
          }
          throw err;
        }
      })();

      if (outcome.raced) {
        // 另一个请求抢先插入了相同 md5，它已负责版本行与容量累加
        return { id: outcome.id, deduped: true };
      }

      tx.insert(bookVersions)
        .values({
          bookId: outcome.id,
          version: 1,
          size: received.size,
          md5: received.md5,
          objectKey: key,
          storageId,
          note: '初次上传',
          uploadedBy: userId,
          createdAt: now,
        })
        .run();

      tx.update(storages)
        .set({ usedBytes: sql`coalesce(${storages.usedBytes}, 0) + ${received.size}`, updatedAt: now })
        .where(eq(storages.id, storageId))
        .run();

      return { id: outcome.id, deduped: false };
    });

    log.info(
      { userId, bookId: inserted.id, deduped: inserted.deduped, size: received.size, storageId },
      inserted.deduped ? '并发秒传竞态，返回已存在书籍' : '上传书籍完成',
    );
    return { book: getBookDetail(userId, inserted.id), deduped: inserted.deduped };
  } finally {
    // try/finally 保证任何路径（含异常、秒传）都会清理临时文件
    await cleanupTemp(received.tmpPath);
  }
}

function nonEmpty(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

/**
 * 上传新版本：版本号 = 当前版本 + 1，同时把 books 主记录指向新文件。
 * 历史版本对象保留在存储上，因此 usedBytes 只增不减。
 */
export async function uploadBookVersion(userId: number, bookId: number, file: UploadedFile): Promise<BookDetail> {
  // 先消费完上传流再校验归属：否则 404 时客户端的上传体没人读，连接会挂住
  const received = await receiveUpload(file, userId);

  try {
    const { book } = getOwnedBook(userId, bookId);

    // books(owner_id, md5) 唯一索引要求：新版本的 md5 不能与同用户其它书籍相同
    const clash = findBookByMd5(userId, received.md5);
    if (clash && clash.book.id !== bookId) {
      throw conflict('相同 MD5 的文件已存在于书库中的其它书籍，请先处理该书籍');
    }

    const adapter = await resolveStorageAdapter(book.storageId, userId);
    assertOwnedStorage(userId, book.storageId);
    const key = buildBookKey(userId, received.md5, received.ext);
    safeKeyOrThrow(key);

    const stream = createReadStream(received.tmpPath);
    try {
      await adapter.put(key, stream, { contentType: mimeOfExt(received.ext), md5: received.md5, overwrite: true });
    } finally {
      stream.destroy();
    }

    const now = new Date();
    const nextVersion = book.currentVersion + 1;
    const note = nonEmpty(readField(file.fields, 'note'));

    // 先更新主记录（md5 唯一冲突会在此抛出并回滚），再插版本行，最后累加容量；
    // 三步同一事务，避免出现「版本行已写但 currentVersion 未变」导致后续版本号撞车。
    getDb().transaction((tx) => {
      tx.update(books)
        .set({
          size: received.size,
          md5: received.md5,
          objectKey: key,
          currentVersion: nextVersion,
          updatedAt: now,
        })
        .where(eq(books.id, bookId))
        .run();

      tx.insert(bookVersions)
        .values({
          bookId,
          version: nextVersion,
          size: received.size,
          md5: received.md5,
          objectKey: key,
          storageId: book.storageId,
          note,
          uploadedBy: userId,
          createdAt: now,
        })
        .run();

      tx.update(storages)
        .set({ usedBytes: sql`coalesce(${storages.usedBytes}, 0) + ${received.size}`, updatedAt: now })
        .where(eq(storages.id, book.storageId))
        .run();
    });

    log.info({ userId, bookId, version: nextVersion, size: received.size }, '上传书籍新版本');
    return getBookDetail(userId, bookId);
  } finally {
    await cleanupTemp(received.tmpPath);
  }
}

/**
 * 回滚到历史版本。
 *
 * 回滚不移动文件（目标对象已存在），只是把主记录重新指向该版本的
 * md5/objectKey/size/storageId，并追加一条新版本作为审计痕迹
 * （note 标注「回滚自 vN」），这样版本历史始终是只追加的。
 */
export function restoreBookVersion(userId: number, bookId: number, versionRowId: number): BookDetail {
  const { book } = getOwnedBook(userId, bookId);
  const db = getDb();

  const target = db
    .select()
    .from(bookVersions)
    .where(and(eq(bookVersions.id, versionRowId), eq(bookVersions.bookId, bookId)))
    .get();
  if (!target) throw notFound('版本不存在');
  if (target.version === book.currentVersion) throw badRequest('该版本已是当前版本，无需回滚');

  // 回滚可能把 md5 改回一个已被同用户其它书籍占用的值，需先检查唯一约束
  const clash = findBookByMd5(userId, target.md5);
  if (clash && clash.book.id !== bookId) {
    throw conflict('目标版本的 MD5 与书库中其它书籍冲突，无法回滚');
  }

  const now = new Date();
  const nextVersion = book.currentVersion + 1;

  // 主记录与新增的「回滚」版本行必须一起生效，否则版本历史会与当前版本不一致
  db.transaction((tx) => {
    tx.update(books)
      .set({
        size: target.size,
        md5: target.md5,
        objectKey: target.objectKey,
        storageId: target.storageId,
        currentVersion: nextVersion,
        updatedAt: now,
      })
      .where(eq(books.id, bookId))
      .run();

    tx.insert(bookVersions)
      .values({
        bookId,
        version: nextVersion,
        size: target.size,
        md5: target.md5,
        objectKey: target.objectKey,
        storageId: target.storageId,
        note: `回滚自 v${target.version}`,
        uploadedBy: userId,
        createdAt: now,
      })
      .run();
  });

  log.info({ userId, bookId, from: target.version, to: nextVersion }, '回滚书籍版本');
  return getBookDetail(userId, bookId);
}

/* ============================== 下载 / 中转 ============================== */

/**
 * 准备下载：S3 等支持预签名 URL 的驱动直接 302 重定向，省去服务器带宽；
 * 其余驱动（本地 / WebDAV）由上层把内容流 pipe 给响应，完成「文件中转」。
 */
export async function prepareBookDownload(userId: number, bookId: number): Promise<DownloadTarget> {
  const { book } = getOwnedBook(userId, bookId);
  const adapter = await resolveStorageAdapter(book.storageId, userId);

  // 扩展名只从 objectKey 取（buildBookKey 保证带扩展名），不从书名推断，
  // 否则形如「Vol.1」的书名会被误判出 ".1" 后缀
  const ext = extensionOf(book.objectKey);
  const filename = `${book.title}${ext ? `.${ext}` : ''}`;
  const contentType = mimeOfExt(ext);

  if (typeof adapter.getSignedUrl === 'function') {
    const url = await adapter.getSignedUrl(book.objectKey, 300);
    if (url) {
      return { kind: 'redirect', url, filename, contentType, size: book.size };
    }
  }

  const result = await adapter.get(book.objectKey);
  if (!result.stream) {
    // metadataOnly 不会走这条路径；stream 为空说明驱动实现异常
    throw storageError('存储未返回文件内容');
  }
  return {
    kind: 'stream',
    // StorageAdapter.get() 的 stream 声明为 NodeJS.ReadableStream；实际各驱动都返回 Readable，
    // 这里收窄类型以便路由侧能调用 destroy() 主动断开出错/中断的连接
    stream: result.stream as Readable,
    filename,
    contentType: result.contentType ?? contentType,
    size: result.size || book.size,
  };
}
