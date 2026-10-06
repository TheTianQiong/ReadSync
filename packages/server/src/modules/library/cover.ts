import { createHmac, timingSafeEqual } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { getDb } from '../../db/index.js';
import { bookCovers, books } from '../../db/schema.js';
import { loadConfig } from '../../config.js';
import { badRequest, notFound, payloadTooLarge, unsupportedMediaType } from '../../errors.js';

/**
 * 书籍封面。
 *
 * 两件事值得先说清楚：
 *
 * 1. **图片以 base64 存在数据库里**（book_covers 表）。封面属于书目元数据，
 *    跟着数据库备份走、换存储后端不用搬文件，自建场景最省心。
 * 2. **读取接口不能用登录态**。`<img src>` 带不了 Authorization 头，所以
 *    走了一个签名查询参数；而它又不能像头像那样彻底公开 —— 头像只有一张
 *    无所谓，书库封面等于把「这个人有哪些书」暴露给任何猜到数字 id 的人。
 */

/** 允许的封面格式：与头像保持一致（都是浏览器原生能显示的位图） */
export const COVER_MIME_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

/**
 * 封面大小上限。
 *
 * 比头像（2MB）小：封面在列表里也要显示，太大既占库又拖慢首屏。
 * 一张 600×900 的 JPEG 通常 100KB 上下，1.5MB 足够放高清图。
 */
export const COVER_MAX_BYTES = 1.5 * 1024 * 1024;

/** data URI 里 base64 允许的字符集，防止有人塞别的东西进来 */
const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;

/* ------------------------------ 写入 ------------------------------ */

/** 校验上传的封面字节，返回可入库的 base64；不合法直接抛 4xx */
export function encodeCoverUpload(mimetype: string, buffer: Buffer): { mime: string; data: string } {
  // 只看 MIME 声明挡不住伪造，但封面是纯展示用、又不解析，风险可接受；
  // 真正的边界由「大小」与「只能被同一个人读回」两道把着
  const mime = mimetype.toLowerCase().split(';')[0]?.trim() ?? '';
  if (!COVER_MIME_EXT[mime]) {
    throw unsupportedMediaType('仅支持 PNG / JPEG / WebP / GIF 格式的封面');
  }
  if (buffer.length === 0) throw badRequest('封面文件为空');
  if (buffer.length > COVER_MAX_BYTES) {
    throw payloadTooLarge(`封面不能超过 ${Math.round(COVER_MAX_BYTES / 1024 / 1024)}MB`);
  }

  return { mime, data: buffer.toString('base64') };
}

/** 写入/替换封面；同时刷新 books.coverUpdatedAt 作为版本号 */
export function saveBookCover(bookId: number, mime: string, data: string, now: Date): void {
  const db = getDb();

  db.insert(bookCovers)
    .values({ bookId, mime, data, createdAt: now })
    .onConflictDoUpdate({ target: bookCovers.bookId, set: { mime, data, createdAt: now } })
    .run();

  // 版本号变化 → 旧链接的签名失效，浏览器也不会拿旧缓存
  db.update(books).set({ coverUpdatedAt: now, updatedAt: now }).where(eq(books.id, bookId)).run();
}

/** 删除封面，并把版本号清空 */
export function deleteBookCover(bookId: number, now: Date): void {
  const db = getDb();
  db.delete(bookCovers).where(eq(bookCovers.bookId, bookId)).run();
  db.update(books).set({ coverUpdatedAt: null, updatedAt: now }).where(eq(books.id, bookId)).run();
}

/** 取封面字节；没有封面返回 null（路由据此 404） */
export function readBookCover(bookId: number): { mime: string; data: Buffer } | null {
  const row = getDb()
    .select({ mime: bookCovers.mime, data: bookCovers.data })
    .from(bookCovers)
    .where(eq(bookCovers.bookId, bookId))
    .get();
  if (!row) return null;

  // 库里理论上只会有我们自己写进去的合法 base64；真被改坏了宁可 404 也不要
  // 让 Buffer.from 悄悄解出一堆垃圾字节
  if (!BASE64_PATTERN.test(row.data)) return null;
  return { mime: row.mime, data: Buffer.from(row.data, 'base64') };
}

/** 书籍必须存在且属于该用户；越权一律 404（不泄露「这本书存不存在」） */
export function requireOwnedBookId(userId: number, bookId: number): void {
  const row = getDb()
    .select({ id: books.id })
    .from(books)
    .where(and(eq(books.id, bookId), eq(books.ownerId, userId)))
    .get();
  if (!row) throw notFound('书籍不存在');
}

/* ------------------------------ 签名 ------------------------------ */

/**
 * 签名用的密钥。
 *
 * 与 secret-box 一样懒加载并缓存：toBookSummary 每本书都要生一个封面 URL，
 * 每次都去读一遍 secret.key 文件是没必要的开销。
 */
let cachedSecret: string | null = null;

function signingSecret(): string {
  if (cachedSecret === null) cachedSecret = loadConfig().secret;
  return cachedSecret;
}

/** 测试用：主密钥变更后清掉缓存 */
export function resetCoverSecretCache(): void {
  cachedSecret = null;
}

/**
 * 签名长度。
 *
 * 截断到 16 个 hex 字符（64 位）就够：这只是一道「别让人顺着 id 枚举别人
 * 书库」的闸门，不是密码学边界 —— 攻击者能验签成功的概率是 2^-64，
 * 而他本来也拿不到任何密钥材料。
 */
const TOKEN_LENGTH = 16;

function sign(bookId: number, version: number): string {
  return createHmac('sha256', signingSecret())
    .update(`book-cover:${bookId}:${version}`)
    .digest('hex')
    .slice(0, TOKEN_LENGTH);
}

/** 生成可直接放进 `<img src>` 的封面地址；没有上传封面时返回 null */
export function coverSrc(bookId: number, coverUpdatedAt: Date | null): string | null {
  if (!coverUpdatedAt) return null;
  const version = coverUpdatedAt.getTime();
  return `/api/books/${bookId}/cover?v=${version}&t=${sign(bookId, version)}`;
}

/** 校验封面地址上的签名；版本号参与签名，所以换了封面旧链接立即失效 */
export function verifyCoverToken(bookId: number, version: number, token: string | undefined): boolean {
  if (!token || token.length !== TOKEN_LENGTH) return false;

  const expected = sign(bookId, version);
  // 定长比较：长度已在上面锁死，timingSafeEqual 不会因长度不等抛错
  return timingSafeEqual(Buffer.from(expected, 'utf8'), Buffer.from(token, 'utf8'));
}
