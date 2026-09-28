import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import type { BookDocumentAlias, BookDocumentIds } from '@readsync/shared';
import { getDb } from '../../db/index.js';
import { bookDocuments, books, readingSessions, syncEntries } from '../../db/schema.js';
import { badRequest, conflict, notFound } from '../../errors.js';
import { getModuleLogger } from '../../logger.js';
import { getOwnedBookRow } from './service.js';

/**
 * 一本书的文档标识管理。
 *
 * 背景：阅读器的文档标识是对**文件内容采样**算出来的。同一本书在不同平台
 * 各自下载一份、或版本/格式不同时，算出的标识往往各不相同，但它们确实是
 * 同一本书。只认一个标识的话，那些设备上报的进度就永远挂不到这本书上。
 *
 * 所以一本书可以有多个标识：`books.documentId` 是服务端能自己算出来的那个
 * （上传时算的），这张表存其余需要手工补充的。匹配时两处都查。
 */

const log = getModuleLogger('library');

/** 标识必须是 32 位十六进制 —— 阅读器发来的就是这个形状 */
const DOCUMENT_ID_RE = /^[a-f0-9]{32}$/;

function normalizeDocumentId(raw: string): string {
  const value = raw.trim().toLowerCase();
  if (!DOCUMENT_ID_RE.test(value)) {
    throw badRequest('文档标识必须是 32 位十六进制（阅读器里显示的那个值）');
  }
  return value;
}

/** 某本书的全部已知标识 */
export function listDocumentIds(bookId: number): BookDocumentIds {
  const row = getDb().select().from(books).where(eq(books.id, bookId)).get();
  if (!row) throw notFound('书籍不存在');
  const aliases = getDb()
    .select()
    .from(bookDocuments)
    .where(eq(bookDocuments.bookId, bookId))
    .orderBy(desc(bookDocuments.createdAt))
    .all();

  return {
    primary: row.documentId,
    aliases: aliases.map(
      (a): BookDocumentAlias => ({
        id: a.id,
        documentId: a.documentId,
        label: a.label,
        createdAt: a.createdAt.toISOString(),
      }),
    ),
  };
}

/**
 * 这个标识是否已被同一账号下的**另一本书**占用。
 *
 * 必须按 owner 限定：不同用户各有一份相同的书、算出相同标识是正常的，
 * 不能因此拒绝。但同一个人的两本书共用标识会让匹配变得不确定 —— 那种情况
 * 直接拒绝并说明是哪一本，比默默认错好。
 */
function findOccupyingBook(userId: number, documentId: string, exceptBookId: number): number | null {
  const db = getDb();

  const byPrimary = db
    .select({ id: books.id })
    .from(books)
    .where(and(eq(books.ownerId, userId), eq(books.documentId, documentId)))
    .get();
  if (byPrimary && byPrimary.id !== exceptBookId) return byPrimary.id;

  const byAlias = db
    .select({ bookId: bookDocuments.bookId })
    .from(bookDocuments)
    .innerJoin(books, eq(books.id, bookDocuments.bookId))
    .where(and(eq(books.ownerId, userId), eq(bookDocuments.documentId, documentId)))
    .get();
  if (byAlias && byAlias.bookId !== exceptBookId) return byAlias.bookId;

  return null;
}

export interface AddDocumentIdResult {
  alias: BookDocumentAlias;
  /** 回填了多少条历史进度 / 阅读会话 */
  relinked: { syncEntries: number; sessions: number };
}

/**
 * 给一本书补一个文档标识，并把**已有的**历史数据认领回来。
 *
 * 回填这一步是重点：用户补标识的目的就是让已经同步过的进度显示出来。
 * 只写标识不回填的话，界面上还是什么都没有，等于白补。
 */
export function addDocumentId(
  userId: number,
  bookId: number,
  rawDocumentId: string,
  label?: string,
): AddDocumentIdResult {
  const documentId = normalizeDocumentId(rawDocumentId);
  // getOwnedBookRow 已按 owner 校验，越权一律 404
  const book = getOwnedBookRow(userId, bookId);

  if (book.documentId === documentId) {
    throw conflict('这本书已经有这个标识了');
  }

  const occupiedBy = findOccupyingBook(userId, documentId, bookId);
  if (occupiedBy !== null) {
    const other = getDb().select({ title: books.title }).from(books).where(eq(books.id, occupiedBy)).get();
    throw conflict(`该标识已被《${other?.title ?? occupiedBy}》占用，请先从那边移除`);
  }

  const alias = getDb()
    .insert(bookDocuments)
    .values({ bookId, documentId, label: label?.trim() || null, createdAt: new Date() })
    .returning()
    .get();

  const relinked = relinkExistingData(userId, documentId, bookId);

  log.info({ userId, bookId, documentId, ...relinked }, '补充文档标识并回填历史关联');

  return {
    alias: {
      id: alias.id,
      documentId: alias.documentId,
      label: alias.label,
      createdAt: alias.createdAt.toISOString(),
    },
    relinked,
  };
}

/**
 * 设置或清空**主标识**。
 *
 * 为什么要能改／能删：主标识是服务端从存储里的文件算出来的，而那份文件未必
 * 与阅读器上的副本一致（不同平台各下一份就会不同）。算出来的值对不上任何
 * 设备时，它就是个碍事的噪音 —— 留着既不参与匹配，又让人以为「标识已经有了」。
 *
 * 传 null 表示清空：此后这本书只靠补充的标识匹配。已有的进度不会因此丢失，
 * 它们已经认领到这本书上了。
 *
 * 注意：清空后再跑 `book:backfill-document-id` 会重新算出来填回。
 */
export function setPrimaryDocumentId(
  userId: number,
  bookId: number,
  rawDocumentId: string | null,
): { documentId: string | null; relinked: { syncEntries: number; sessions: number } | null } {
  // getOwnedBookRow 已按 owner 校验，越权一律 404
  getOwnedBookRow(userId, bookId);

  if (rawDocumentId === null) {
    getDb().update(books).set({ documentId: null, updatedAt: new Date() }).where(eq(books.id, bookId)).run();
    log.info({ userId, bookId }, '清空主标识');
    return { documentId: null, relinked: null };
  }

  const documentId = normalizeDocumentId(rawDocumentId);

  // 先校验再改库：顺序反了的话，冲突时那条别名已经被删掉了，白丢一条记录
  const occupiedBy = findOccupyingBook(userId, documentId, bookId);
  if (occupiedBy !== null) {
    const other = getDb().select({ title: books.title }).from(books).where(eq(books.id, occupiedBy)).get();
    throw conflict(`该标识已被《${other?.title ?? occupiedBy}》占用，请先从那边移除`);
  }

  // 允许把它设成某个补充标识的值：那种情况下把那条别名收掉，
  // 免得同一个值在主标识和别名里各存一份
  getDb()
    .delete(bookDocuments)
    .where(and(eq(bookDocuments.bookId, bookId), eq(bookDocuments.documentId, documentId)))
    .run();

  getDb().update(books).set({ documentId, updatedAt: new Date() }).where(eq(books.id, bookId)).run();

  // 换成别的值后，该值名下已有的进度也应当认领过来
  const relinked = relinkExistingData(userId, documentId, bookId);
  log.info({ userId, bookId, documentId, ...relinked }, '设置主标识');

  return { documentId, relinked };
}

export function removeDocumentId(userId: number, bookId: number, aliasId: number): void {
  getOwnedBookRow(userId, bookId);

  const alias = getDb()
    .select()
    .from(bookDocuments)
    .where(and(eq(bookDocuments.id, aliasId), eq(bookDocuments.bookId, bookId)))
    .get();
  if (!alias) throw notFound('该标识不存在');

  getDb().delete(bookDocuments).where(eq(bookDocuments.id, aliasId)).run();
  log.info({ userId, bookId, documentId: alias.documentId }, '移除文档标识');
}

/**
 * 把该标识下已有的进度与会话认领到这本书上。
 *
 * 只动 book_id 为空的那些行 —— 已经被别的书认领过的不抢，避免把原本
 * 正确的归属改错。进度百分比与时长则从认领后的数据重算，因为它们本来就是
 * 派生值（统计接口也是直接读 reading_sessions 的，所以这里重算即一致）。
 */
function relinkExistingData(
  userId: number,
  documentId: string,
  bookId: number,
): { syncEntries: number; sessions: number } {
  const db = getDb();

  const entries = db
    .update(syncEntries)
    .set({ bookId })
    .where(
      and(
        eq(syncEntries.userId, userId),
        eq(syncEntries.document, documentId),
        // 没关联过、或关联到别的书但那条已经从库中消失时才有意义；
        // 这里只认「未关联」，最保守
        isNull(syncEntries.bookId),
      ),
    )
    .run();

  const sessions = db
    .update(readingSessions)
    .set({ bookId, document: documentId })
    .where(
      and(
        eq(readingSessions.userId, userId),
        eq(readingSessions.document, documentId),
        isNull(readingSessions.bookId),
      ),
    )
    .run();

  recomputeBookDerivedFields(userId, bookId);

  return { syncEntries: entries.changes, sessions: sessions.changes };
}

/** 从已认领的进度与会话重算书籍上的派生字段 */
function recomputeBookDerivedFields(userId: number, bookId: number): void {
  const db = getDb();

  const latest = db
    .select({ percentage: syncEntries.percentage })
    .from(syncEntries)
    .where(and(eq(syncEntries.userId, userId), eq(syncEntries.bookId, bookId)))
    .orderBy(desc(syncEntries.updatedAt))
    .get();

  const totals = db
    .select({
      seconds: sql<number>`coalesce(sum(${readingSessions.seconds}), 0)`,
      lastAt: sql<number | null>`max(${readingSessions.startedAt})`,
    })
    .from(readingSessions)
    .where(and(eq(readingSessions.userId, userId), eq(readingSessions.bookId, bookId)))
    .get();

  db.update(books)
    .set({
      ...(latest ? { progressPercent: Math.round(latest.percentage / 100) } : {}),
      totalReadingSeconds: totals?.seconds ?? 0,
      ...(totals?.lastAt ? { lastReadAt: new Date(totals.lastAt) } : {}),
      updatedAt: new Date(),
    })
    .where(eq(books.id, bookId))
    .run();
}

/** 供同步模块调用：这些标识是否属于某本书 */
export function findBookByDocumentId(userId: number, documentId: string): number | null {
  const db = getDb();

  const byPrimary = db
    .select({ id: books.id })
    .from(books)
    .where(and(eq(books.ownerId, userId), eq(books.documentId, documentId)))
    .get();
  if (byPrimary) return byPrimary.id;

  const byAlias = db
    .select({ bookId: bookDocuments.bookId })
    .from(bookDocuments)
    .innerJoin(books, eq(books.id, bookDocuments.bookId))
    .where(and(eq(books.ownerId, userId), eq(bookDocuments.documentId, documentId)))
    .get();
  return byAlias?.bookId ?? null;
}
