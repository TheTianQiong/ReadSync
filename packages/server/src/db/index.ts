import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { loadConfig } from '../config.js';
import { getModuleLogger } from '../logger.js';
import * as schema from './schema.js';

/**
 * 数据库连接与迁移。
 *
 * 使用 better-sqlite3（同步驱动，性能好且无需连接池）。
 * 迁移文件由 `npm run db:generate -w @readsync/server` 从 schema.ts 生成，
 * 产物提交进仓库（packages/server/drizzle），服务启动时自动应用。
 */

export type Db = BetterSQLite3Database<typeof schema>;

export interface DbHandle {
  db: Db;
  raw: Database.Database;
  close(): void;
}

let handle: DbHandle | null = null;

/** 迁移目录：dev 下是 src/db/../../drizzle，构建后是 dist/db/../../drizzle，两者指向同一处 */
function migrationsDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, '..', '..', 'drizzle');
}

/**
 * 打开数据库连接。
 * 幂等：重复调用返回同一个句柄，避免 better-sqlite3 多连接写冲突。
 */
export function openDatabase(): DbHandle {
  if (handle) return handle;

  const config = loadConfig();
  const log = getModuleLogger('db');

  mkdirSync(path.dirname(config.databaseFile), { recursive: true });

  const raw = new Database(config.databaseFile);

  // WAL 模式让读写并发更顺畅（同步接口写入时前端仍可查询）
  raw.pragma('journal_mode = WAL');
  // 外键约束必须显式打开，否则 onDelete: cascade 不会生效
  raw.pragma('foreign_keys = ON');
  // 平衡安全与性能：WAL 下 NORMAL 已足够可靠
  raw.pragma('synchronous = NORMAL');
  // 写锁等待 5 秒再报 SQLITE_BUSY，避免并发写入直接失败
  raw.pragma('busy_timeout = 5000');

  const db = drizzle(raw, { schema });

  if (config.READSYNC_AUTO_MIGRATE) {
    const dir = migrationsDir();
    try {
      migrate(db, { migrationsFolder: dir });
      log.info({ migrationsDir: dir }, '数据库迁移已应用');
    } catch (err) {
      log.error({ err, migrationsDir: dir }, '数据库迁移失败');
      throw err;
    }
  }

  handle = {
    db,
    raw,
    close() {
      raw.close();
      handle = null;
    },
  };

  return handle;
}

/** 获取数据库实例（首次调用时自动打开） */
export function getDb(): Db {
  return openDatabase().db;
}

/** 获取底层 better-sqlite3 句柄，用于执行 Drizzle 不便表达的原生 SQL（如聚合统计） */
export function getRawDb(): Database.Database {
  return openDatabase().raw;
}

/** 进程退出前关闭连接，确保 WAL 落盘 */
export function closeDatabase(): void {
  handle?.close();
}

export { schema };
