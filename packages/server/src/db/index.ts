import { existsSync, mkdirSync } from 'node:fs';
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

/**
 * 定位迁移目录（packages/server/drizzle）。
 *
 * 不能写死一个相对路径：dist 在不同部署方式下的位置不一样。
 *   - npm 直接运行：  packages/server/dist/db/  → ../../drizzle 命中
 *   - Docker 扁平化： /app/server/db/           → ../drizzle 命中
 * 之前只算 `../../drizzle`，容器里会解析成 /app/drizzle 而找不到迁移文件，
 * 服务启动即失败。这里改为按候选顺序探测，取第一个真实存在的。
 */
function resolveMigrationsDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));

  const candidates = [
    // 显式指定优先，便于自定义打包布局
    process.env.READSYNC_MIGRATIONS_DIR,
    // npm/源码布局：packages/server/dist/db → packages/server/drizzle
    path.resolve(here, '..', '..', 'drizzle'),
    // 扁平布局：/app/server/db → /app/server/drizzle
    path.resolve(here, '..', 'drizzle'),
    path.resolve(process.cwd(), 'drizzle'),
    path.resolve(process.cwd(), 'packages', 'server', 'drizzle'),
  ].filter((p): p is string => typeof p === 'string' && p.length > 0);

  for (const dir of candidates) {
    // drizzle 的 migrator 需要 meta/_journal.json，用它判断目录是否有效
    if (existsSync(path.join(dir, 'meta', '_journal.json'))) {
      return dir;
    }
  }

  throw new Error(
    `未找到数据库迁移目录（需要其中的 meta/_journal.json）。已尝试：\n` +
      candidates.map((c) => `  - ${c}`).join('\n') +
      `\n可通过环境变量 READSYNC_MIGRATIONS_DIR 显式指定。`,
  );
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
    try {
      const dir = resolveMigrationsDir();
      migrate(db, { migrationsFolder: dir });
      log.info({ migrationsDir: dir }, '数据库迁移已应用');
    } catch (err) {
      log.error({ err }, '数据库迁移失败');
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
