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
      /*
       * 迁移期间必须关掉外键约束 —— 这是 SQLite 官方推荐的建表迁移做法。
       *
       * SQLite 不支持 ALTER COLUMN，drizzle-kit 生成的迁移一律是
       * 「建新表 → 拷贝 → 删旧表 → 改名」。而删旧表会触发外键动作：
       * 指向它的 ON DELETE CASCADE 子表会被**清空**，ON DELETE SET NULL
       * 的列会被**置空**。比如把 books.object_key 改成可空这条迁移，
       * 若开着外键，`DROP TABLE books` 会顺带清掉全部 book_versions
       * （版本历史全丢）、并把 reading_sessions / sync_entries 的 book_id
       * 置空（进度与会话和书库脱钩）—— 而且悄无声息，没有任何报错。
       *
       * 注意迁移文件里自带的 PRAGMA foreign_keys 是**没用的**：drizzle 把
       * 整个迁移包在 BEGIN…COMMIT 里，而 SQLite 规定事务内改不了这个开关。
       * 只能在事务外、于调用 migrate() 前后自行切换。
       */
      raw.pragma('foreign_keys = OFF');
      try {
        migrate(db, { migrationsFolder: dir });
      } finally {
        raw.pragma('foreign_keys = ON');
      }
      log.info({ migrationsDir: dir }, '数据库迁移已应用');

      // 外键关掉期间的迁移若写出了悬空引用，必须在这里暴露出来，
      // 而不是等到某次联表查询悄悄少几行
      const violations = raw.pragma('foreign_key_check') as unknown[];
      if (violations.length > 0) {
        log.error({ violations: violations.slice(0, 10) }, '迁移后存在外键完整性违规');
        throw new Error(`迁移后外键校验未通过（${violations.length} 处）`);
      }
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
