/**
 * 校验「books / book_versions 的 objectKey、storageId 改为可空」这条迁移
 * 不会损坏既有数据。
 *
 * 为什么必须单独验：SQLite 不支持 ALTER COLUMN，drizzle-kit 生成的是
 * 「建新表 → 拷贝 → 删旧表 → 改名」。而 book_versions 有指向 books 的外键
 * （ON DELETE cascade），删父表时若外键约束是开启的，SQLite 会执行隐式删除
 * 并级联清空子表 —— 生成的 SQL 里 PRAGMA foreign_keys=ON 恰好出现在重建
 * books 之前，很可能踩中。这种问题在空库上跑永远发现不了。
 *
 * 用法：READSYNC_DATA_DIR=./data-mig npx tsx src/scripts/check-migration.ts
 */

import Database from 'better-sqlite3';
import { readFileSync, readdirSync, rmSync, mkdirSync, writeFileSync, cpSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';

const here = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.resolve(here, '../../drizzle');

let passed = 0;
let failed = 0;

function check(name: string, ok: boolean, detail?: unknown): void {
  if (ok) {
    passed += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failed += 1;
    console.error(`  ✗ ${name}${detail !== undefined ? ` → ${JSON.stringify(detail).slice(0, 300)}` : ''}`);
  }
}

/** drizzle 的迁移文件用这句作语句分隔符 */
function splitStatements(sql: string): string[] {
  return sql
    .split('--> statement-breakpoint')
    .map((s) => s.trim())
    .filter(Boolean);
}

function main(): void {
  const root = process.env.READSYNC_DATA_DIR ?? './data-mig';
  if (!/mig|test|tmp|e2e|smoke|upgrade|repro/i.test(root)) {
    console.error(`拒绝执行：数据目录 ${root} 看起来不是测试目录。`);
    process.exit(1);
  }
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });

  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  check('找到迁移文件', files.length >= 2, files);

  const db = new Database(path.join(root, 'readsync.db'));
  db.pragma('foreign_keys = ON');

  /**
   * 逐条执行，并**复刻真实迁移器的行为**：
   *  - 整个迁移包在一个事务里（所以文件内的 PRAGMA foreign_keys 是空操作）
   *  - 事务外由连接控制外键开关，db/index.ts 会在 migrate() 前后关/开
   */
  const apply = (file: string, withFkOff = false): void => {
    const sql = readFileSync(path.join(migrationsDir, file), 'utf8');
    if (withFkOff) db.pragma('foreign_keys = OFF');
    try {
      db.exec('BEGIN');
      try {
        for (const stmt of splitStatements(sql)) db.exec(stmt);
        db.exec('COMMIT');
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
    } finally {
      if (withFkOff) db.pragma('foreign_keys = ON');
    }
  };

  // 1) 先建到旧版本（只跑 0000）
  apply(files[0]!);

  // 2) 灌入有代表性的数据
  db.exec(`
    INSERT INTO users (id, username, email, password_hash, role, status, totp_enabled, created_at, updated_at)
    VALUES (1, 'u1', 'u1@example.com', 'x', 'user', 'active', 0, 0, 0);
    INSERT INTO storages (id, user_id, name, driver, config, is_default, read_only, enabled, created_at, updated_at)
    VALUES (1, 1, '本地', 'local', '{}', 1, 0, 1, 0, 0);
    INSERT INTO books (id, owner_id, title, format, size, md5, object_key, storage_id, current_version,
                       tags, reading_status, progress_percent, total_reading_seconds, created_at, updated_at)
    VALUES (1, 1, '旧书', 'epub', 1234, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            'books/1/aa/x.epub', 1, 2, '[]', 'reading', 0, 0, 0, 0);
    INSERT INTO book_versions (id, book_id, version, size, md5, object_key, storage_id, uploaded_by, created_at)
    VALUES (1, 1, 1, 100, 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 'books/1/bb/v1.epub', 1, 1, 0),
           (2, 1, 2, 1234, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'books/1/aa/x.epub', 1, 1, 0);
    INSERT INTO reading_sessions (id, user_id, book_id, document, platform, device, seconds, day, hour, weekday, started_at)
    VALUES (1, 1, 1, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'koreader', 'Kindle', 600, '2026-01-01', 10, 3, 0);
    INSERT INTO sync_entries (user_id, document, title, progress, percentage_scaled, platform, device, device_id, book_id, updated_at)
    VALUES (1, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', '旧书', '/body/1', 5000, 'koreader', 'Kindle', 'k1', 1, 0);
  `);

  const before = {
    books: db.prepare('SELECT count(*) c FROM books').get() as { c: number },
    versions: db.prepare('SELECT count(*) c FROM book_versions').get() as { c: number },
    sessions: db.prepare('SELECT count(*) c FROM reading_sessions').get() as { c: number },
    entries: db.prepare('SELECT count(*) c FROM sync_entries').get() as { c: number },
  };
  check('迁移前：1 本书', before.books.c === 1, before);
  check('迁移前：2 条版本记录', before.versions.c === 2, before);

  /*
   * 只准备「旧库」就退出：给「真实启动路径」用。
   *
   * 上面这套是我复刻的迁移逻辑，而复刻本身也可能与 db/index.ts 走样，
   * 所以还要让服务端真的在旧库上启动一次，才算验完。
   *
   * 关键在于这个旧库必须**由 drizzle 自己的迁移器**建出来 —— 手写 SQL 建的表
   * 缺少 __drizzle_migrations 记录，服务端启动时会以为一条迁移都没跑过，
   * 转而重跑 0000 并因「表已存在」失败。那是我造库方式的问题，不是产品的。
   */
  if (process.env.PREPARE_OLD_DB_ONLY === '1') {
    db.close();
    rmSync(path.join(root, 'readsync.db'), { force: true });

    // 复制一份只含 0000 的迁移目录，用官方迁移器建出「旧版本」数据库
    const oldDir = path.join(root, '_old_migrations');
    mkdirSync(path.join(oldDir, 'meta'), { recursive: true });
    const first = files[0]!;
    cpSync(path.join(migrationsDir, first), path.join(oldDir, first));
    const journal = JSON.parse(readFileSync(path.join(migrationsDir, 'meta/_journal.json'), 'utf8')) as {
      entries: { idx: number }[];
    };
    writeFileSync(
      path.join(oldDir, 'meta/_journal.json'),
      JSON.stringify({ ...journal, entries: journal.entries.filter((e) => e.idx === 0) }, null, 2),
      'utf8',
    );

    const oldDb = new Database(path.join(root, 'readsync.db'));
    oldDb.pragma('foreign_keys = ON');
    migrate(drizzle(oldDb), { migrationsFolder: oldDir });
    oldDb.exec(`
      INSERT INTO users (id, username, email, password_hash, role, status, totp_enabled, created_at, updated_at)
      VALUES (1, 'u1', 'u1@example.com', 'x', 'user', 'active', 0, 0, 0);
      INSERT INTO storages (id, user_id, name, driver, config, is_default, read_only, enabled, created_at, updated_at)
      VALUES (1, 1, '本地', 'local', '{}', 1, 0, 1, 0, 0);
      INSERT INTO books (id, owner_id, title, format, size, md5, object_key, storage_id, current_version,
                         tags, reading_status, progress_percent, total_reading_seconds, created_at, updated_at)
      VALUES (1, 1, '旧书', 'epub', 1234, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
              'books/1/aa/x.epub', 1, 2, '[]', 'reading', 0, 0, 0, 0);
      INSERT INTO book_versions (id, book_id, version, size, md5, object_key, storage_id, uploaded_by, created_at)
      VALUES (1, 1, 1, 100, 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 'books/1/bb/v1.epub', 1, 1, 0),
             (2, 1, 2, 1234, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'books/1/aa/x.epub', 1, 1, 0);
      INSERT INTO reading_sessions (id, user_id, book_id, document, platform, device, seconds, day, hour, weekday, started_at)
      VALUES (1, 1, 1, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'koreader', 'Kindle', 600, '2026-01-01', 10, 3, 0);
      INSERT INTO sync_entries (user_id, document, title, progress, percentage_scaled, platform, device, device_id, book_id, updated_at)
      VALUES (1, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', '旧书', '/body/1', 5000, 'koreader', 'Kindle', 'k1', 1, 0);
    `);
    oldDb.close();
    rmSync(oldDir, { recursive: true, force: true });

    console.log(`已备好旧版数据库：${path.join(root, 'readsync.db')}（数据已写入，迁移记录仅 0000）`);
    process.exit(0);
  }

  // 3) 跑新迁移（复刻 db/index.ts：事务外先关外键，迁完再开）
  for (const f of files.slice(1)) apply(f, true);

  // 4) 核对数据一条没少
  const after = {
    books: db.prepare('SELECT count(*) c FROM books').get() as { c: number },
    versions: db.prepare('SELECT count(*) c FROM book_versions').get() as { c: number },
    sessions: db.prepare('SELECT count(*) c FROM reading_sessions').get() as { c: number },
    entries: db.prepare('SELECT count(*) c FROM sync_entries').get() as { c: number },
  };
  check('迁移后书籍仍在', after.books.c === 1, after);
  check('迁移后版本记录未被级联清空', after.versions.c === 2, after);
  check('迁移后阅读会话仍在（外键未误伤）', after.sessions.c === 1, after);
  check('迁移后同步进度仍在', after.entries.c === 1, after);

  // 4b) 指向 books 的 ON DELETE SET NULL 列也必须保住 —— 被置空的话，
  //     阅读会话与同步进度就和书库脱钩了，而且不会有任何报错
  const sessionLink = db.prepare('SELECT book_id FROM reading_sessions WHERE id = 1').get() as {
    book_id: number | null;
  };
  check('阅读会话与书籍的关联未被置空', sessionLink.book_id === 1, sessionLink);
  const entryLink = db.prepare('SELECT book_id FROM sync_entries WHERE id = 1').get() as {
    book_id: number | null;
  };
  check('同步进度与书籍的关联未被置空', entryLink.book_id === 1, entryLink);

  // 5) 内容也要保持一致，不能只剩行数
  const book = db
    .prepare('SELECT title, md5, object_key, storage_id, current_version FROM books WHERE id = 1')
    .get() as Record<string, unknown>;
  check('书籍字段逐列保留', book.title === '旧书' && book.current_version === 2, book);
  check('object_key 与 storage_id 保留', book.object_key === 'books/1/aa/x.epub' && book.storage_id === 1, book);

  // 6) 新约束确实生效：可以插入没有文件的书
  db.exec(`
    INSERT INTO books (id, owner_id, title, format, size, md5, current_version,
                       tags, reading_status, progress_percent, total_reading_seconds, created_at, updated_at)
    VALUES (2, 1, '只登记', 'epub', 0, 'cccccccccccccccccccccccccccccccc', 1, '[]', 'unread', 0, 0, 0, 0);
  `);
  const metaOnly = db.prepare('SELECT object_key, storage_id FROM books WHERE id = 2').get() as Record<string, unknown>;
  check(
    '可以登记没有文件的书（object_key / storage_id 为空）',
    metaOnly.object_key === null && metaOnly.storage_id === null,
    metaOnly,
  );

  // 7) 唯一索引仍在：同一用户不能有两本同 md5 的书
  let dupRejected = false;
  try {
    db.exec(`
      INSERT INTO books (owner_id, title, format, size, md5, current_version,
                         tags, reading_status, progress_percent, total_reading_seconds, created_at, updated_at)
      VALUES (1, '重复', 'epub', 0, 'cccccccccccccccccccccccccccccccc', 1, '[]', 'unread', 0, 0, 0, 0);
    `);
  } catch {
    dupRejected = true;
  }
  check('秒传唯一索引仍然生效', dupRejected);

  // 8) 外键约束也还在（存储被引用时不能删）
  let fkEnforced = false;
  try {
    db.exec('DELETE FROM storages WHERE id = 1');
  } catch {
    fkEnforced = true;
  }
  check('存储的外键约束仍然生效', fkEnforced);

  // 9) 迁移后不该留下悬空引用
  const violations = db.pragma('foreign_key_check') as unknown[];
  check('迁移后无外键完整性违规', violations.length === 0, violations.slice(0, 5));

  db.close();
  rmSync(root, { recursive: true, force: true });

  console.log(`\n通过 ${passed} 项，失败 ${failed} 项`);
  if (failed > 0) {
    console.error('迁移校验未通过');
    process.exit(1);
  }
  console.log('全部通过 ✓');
}

main();
