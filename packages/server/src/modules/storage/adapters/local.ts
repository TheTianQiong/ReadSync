import { randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { localStorageConfigSchema, type StorageTestResult } from '@readsync/shared';
import { loadConfig } from '../../../config.js';
import { badRequest, conflict, notFound, storageError } from '../../../errors.js';
import {
  assertSafeKey,
  type GetOptions,
  type GetResult,
  type ListOptions,
  type ListResult,
  type PutOptions,
  type StorageObject,
} from '../types.js';
import type { DirectoryAdapter } from './registry.js';

/**
 * 本地磁盘存储驱动。
 *
 * 定位：README 说明本地存储「容量有限，仅作中转与缓存」，书库文件主要放在
 * WebDAV / 对象存储上。因此这里不做分片、不做配额硬限制（配额由上层按
 * quotaBytes 判断），只保证路径安全与写入原子性。
 *
 * 安全要点（本文件最关键的部分）：
 *  1. 所有 key 先过 assertSafeKey()，拒绝 `..`、绝对路径、盘符、空字节；
 *  2. resolve 之后再用 path.relative() 二次确认结果仍在根目录内 —— 因为
 *     assertSafeKey 只做字符串层面的检查，跨平台分隔符、编码差异等仍可能
 *     让路径逃逸，二次确认是最后一道防线（纵深防御）。
 */

/** schema 默认值；它恰好等于 localStorageDir 的目录名，见 resolveRoot() */
const DEFAULT_SUBDIR = 'storage';

/** 常见电子书 / 数据文件后缀到 Content-Type 的映射（本地没有元数据可查） */
const CONTENT_TYPES: Record<string, string> = {
  epub: 'application/epub+zip',
  pdf: 'application/pdf',
  mobi: 'application/x-mobipocket-ebook',
  azw3: 'application/vnd.amazon.ebook',
  azw: 'application/vnd.amazon.ebook',
  fb2: 'application/x-fictionbook+xml',
  txt: 'text/plain; charset=utf-8',
  cbz: 'application/vnd.comicbook+zip',
  cbr: 'application/vnd.comicbook-rar',
  zip: 'application/zip',
  json: 'application/json',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
};

function guessContentType(key: string): string | null {
  const ext = path.extname(key).slice(1).toLowerCase();
  return CONTENT_TYPES[ext] ?? null;
}

/**
 * 计算本地存储根目录。
 *
 * shared 的 localStorageConfigSchema 里 path 注释为「相对于服务器数据目录的路径」，
 * 默认 'storage'；而 loadConfig().localStorageDir 正是 {dataDir}/storage。
 * 为兼容两者：path 为空或等于 'storage' 时直接用 localStorageDir（避免出现
 * data/storage/storage 这种嵌套），否则视为 localStorageDir 下的子目录。
 */
function resolveRoot(subPath: string): string {
  const base = loadConfig().localStorageDir;
  const rel = subPath.trim().replace(/^[/\\]+/, '').replace(/[/\\]+$/, '');
  if (!rel || rel === DEFAULT_SUBDIR || rel === path.basename(base)) return base;

  const candidate = path.resolve(base, rel);
  // 纵深防御：即使将来 schema 校验被绕过，也不允许逃出本地存储根目录
  const check = path.relative(base, candidate);
  if (check.startsWith('..') || path.isAbsolute(check)) {
    throw badRequest('本地存储路径必须位于服务器本地存储目录内');
  }
  return candidate;
}

/**
 * 把逻辑 key 解析为安全的绝对路径。
 * assertSafeKey 抛的是普通 Error（types.ts 定义，不能改），这里统一转成
 * 可直接展示给用户的 AppError。
 */
function safeResolve(rootDir: string, key: string): string {
  try {
    assertSafeKey(key);
  } catch (err) {
    throw badRequest(`存储路径不合法：${(err as Error).message}`);
  }

  const full = path.resolve(rootDir, key);
  const rel = path.relative(rootDir, full);
  // rel === '' 表示解析结果就是根目录自身，也不是合法对象路径
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw badRequest('存储路径不合法：超出存储根目录');
  }
  return full;
}

function isErrnoCode(err: unknown, code: string): boolean {
  return (err as NodeJS.ErrnoException)?.code === code;
}

export class LocalStorageAdapter implements DirectoryAdapter {
  readonly driver = 'local' as const;
  readonly description: string;
  private readonly rootDir: string;
  private readonly quotaBytes: number;

  constructor(private readonly subPath: string, quotaBytes: number) {
    this.rootDir = resolveRoot(subPath);
    this.quotaBytes = quotaBytes;
    this.description = `本地磁盘（${this.rootDir}）`;
  }

  async test(): Promise<StorageTestResult> {
    const started = Date.now();
    try {
      await fs.mkdir(this.rootDir, { recursive: true });
      // 真正写一次再删：只判断 access() 无法确认目录可写（只读挂载会漏判）
      const probe = path.join(this.rootDir, `.readsync-probe-${randomBytes(6).toString('hex')}`);
      await fs.writeFile(probe, 'ok');
      await fs.readFile(probe);
      await fs.rm(probe, { force: true });
      return {
        ok: true,
        message: `本地存储可读写：${this.rootDir}`,
        latencyMs: Date.now() - started,
      };
    } catch (err) {
      return {
        ok: false,
        message: `本地存储不可用：${(err as Error).message}`,
        latencyMs: Date.now() - started,
      };
    }
  }

  async put(key: string, data: Buffer | NodeJS.ReadableStream, options?: PutOptions): Promise<StorageObject> {
    const full = safeResolve(this.rootDir, key);
    await fs.mkdir(path.dirname(full), { recursive: true }).catch((err) => {
      throw storageError(`创建本地目录失败：${(err as Error).message}`, err);
    });

    if (options?.overwrite === false && (await this.isFile(full))) {
      throw conflict(`对象已存在：${key}`);
    }

    // 先写临时文件再 rename：进程中断时正式路径上要么是旧文件要么是新文件，
    // 不会出现只写了一半、MD5 已损坏却看起来存在的文件。
    const tmp = `${full}.${randomBytes(6).toString('hex')}.tmp`;
    try {
      if (Buffer.isBuffer(data)) {
        await fs.writeFile(tmp, data);
      } else {
        await pipeline(data, createWriteStream(tmp));
      }
      await fs.rename(tmp, full);
    } catch (err) {
      await fs.rm(tmp, { force: true }).catch(() => undefined);
      throw storageError(`写入本地文件失败：${(err as Error).message}`, err);
    }

    const st = await fs.stat(full);
    return {
      key,
      size: st.size,
      lastModified: st.mtime.toISOString(),
      etag: options?.md5 ?? null,
    };
  }

  async get(key: string, options?: GetOptions): Promise<GetResult> {
    const full = safeResolve(this.rootDir, key);
    const st = await fs.stat(full).catch((err) => {
      if (isErrnoCode(err, 'ENOENT')) throw notFound(`文件不存在：${key}`);
      throw storageError(`读取本地文件失败：${(err as Error).message}`, err);
    });

    if (st.isDirectory()) {
      throw storageError(`目标是目录而非文件：${key}`);
    }

    return {
      stream: options?.metadataOnly ? null : createReadStream(full),
      size: st.size,
      contentType: guessContentType(key),
      etag: null,
    };
  }

  async exists(key: string): Promise<boolean> {
    return this.isFile(safeResolve(this.rootDir, key));
  }

  async stat(key: string): Promise<StorageObject | null> {
    const full = safeResolve(this.rootDir, key);
    try {
      const st = await fs.stat(full);
      if (!st.isFile()) return null;
      return { key, size: st.size, lastModified: st.mtime.toISOString(), etag: null };
    } catch (err) {
      if (isErrnoCode(err, 'ENOENT')) return null;
      throw storageError(`读取本地文件信息失败：${(err as Error).message}`, err);
    }
  }

  async delete(key: string): Promise<boolean> {
    const full = safeResolve(this.rootDir, key);
    try {
      await fs.unlink(full);
      return true;
    } catch (err) {
      // 不存在时静默返回 false（接口约定），其余错误才上报
      if (isErrnoCode(err, 'ENOENT')) return false;
      throw storageError(`删除本地文件失败：${(err as Error).message}`, err);
    }
  }

  async list(options: ListOptions = {}): Promise<ListResult> {
    const prefix = (options.prefix ?? '').replace(/^\/+/, '');
    const limit = options.limit && options.limit > 0 ? options.limit : 1000;

    const all: StorageObject[] = [];
    await this.walk('', all);

    // 本地驱动不实现游标分页：目录规模本就不大，一次性返回后由调用方截断。
    // cursor 参数被忽略，truncated 用于提示「还有更多」。
    const filtered = all
      .filter((o) => o.key.startsWith(prefix))
      .sort((a, b) => a.key.localeCompare(b.key));

    return {
      objects: filtered.slice(0, limit),
      truncated: filtered.length > limit,
    };
  }

  /** 本地没有签名 URL 概念，返回 null 让上层走服务端中转下载 */
  async getSignedUrl(_key: string, _expiresInSeconds: number): Promise<string | null> {
    return null;
  }

  /** 递归统计目录占用；本驱动可精确统计，故一定返回数值 */
  async usedBytes(): Promise<number | null> {
    return this.directorySize('');
  }

  async mkdir(key: string): Promise<void> {
    // 允许传空 key / '/' 表示「确保根目录存在」
    const clean = key.replace(/^\/+/, '').replace(/\/+$/, '');
    const target = clean === '' ? this.rootDir : safeResolve(this.rootDir, clean);
    try {
      await fs.mkdir(target, { recursive: true });
    } catch (err) {
      throw storageError(`创建本地目录失败：${(err as Error).message}`, err);
    }
  }

  /** 配额（0 表示不限制），供上层做容量判断 */
  getQuotaBytes(): number {
    return this.quotaBytes;
  }

  /* ------------------------------ 内部工具 ------------------------------ */

  private async isFile(full: string): Promise<boolean> {
    try {
      return (await fs.stat(full)).isFile();
    } catch (err) {
      if (isErrnoCode(err, 'ENOENT')) return false;
      throw storageError(`访问本地文件失败：${(err as Error).message}`, err);
    }
  }

  private async walk(relDir: string, out: StorageObject[]): Promise<void> {
    const dir = relDir ? path.join(this.rootDir, relDir) : this.rootDir;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (err) {
      // 根目录尚未创建时视为空，而不是报错
      if (isErrnoCode(err, 'ENOENT')) return;
      throw storageError(`读取本地目录失败：${(err as Error).message}`, err);
    }

    for (const entry of entries) {
      // 统一输出 POSIX 风格的 key，避免 Windows 下产生反斜杠导致跨平台不一致
      const childRel = relDir ? `${relDir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await this.walk(childRel, out);
      } else if (entry.isFile()) {
        const st = await fs.stat(path.join(this.rootDir, childRel));
        out.push({ key: childRel, size: st.size, lastModified: st.mtime.toISOString(), etag: null });
      }
    }
  }

  private async directorySize(relDir: string): Promise<number> {
    const dir = relDir ? path.join(this.rootDir, relDir) : this.rootDir;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (err) {
      if (isErrnoCode(err, 'ENOENT')) return 0;
      throw storageError(`统计本地目录大小失败：${(err as Error).message}`, err);
    }

    let total = 0;
    for (const entry of entries) {
      const childRel = relDir ? `${relDir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        total += await this.directorySize(childRel);
      } else if (entry.isFile()) {
        total += (await fs.stat(path.join(this.rootDir, childRel))).size;
      }
    }
    return total;
  }
}

/** 适配器工厂：配置非法时抛 BAD_REQUEST（registry 会捕获并统一处理） */
export function createLocalAdapter(config: Record<string, unknown>): DirectoryAdapter {
  const parsed = localStorageConfigSchema.safeParse(config);
  if (!parsed.success) {
    throw badRequest(`本地存储配置不合法：${parsed.error.issues.map((i) => i.message).join('；')}`);
  }
  return new LocalStorageAdapter(parsed.data.path, parsed.data.quotaBytes);
}
