/**
 * 安读（Anx Reader）导入的端到端验证。
 *
 * 与 Reeden 那份验证不同，这里**不需要用户提供样本**：脚本自己用 better-sqlite3
 * 造一个结构与 Anx 一致的 database7.db（tb_books / tb_reading_time 两张表，
 * 字段名与官方仓库 lib/models/book.dart、lib/dao/database.dart 一致），
 * 连同封面图一起放进本地存储目录，然后走真实的安装 → 配置 → 导入 → 校验。
 *
 * 用法：
 *   READSYNC_DATA_DIR=./data-anx npx tsx src/scripts/anx-import-check.ts
 *
 * 重点断言（都是这个插件最容易做错的地方）：
 *  - 只有日粒度的时长以「小时未知」入库：热力图**跳过**它们，日合计照常包含；
 *  - file_md5 直接当 md5 用（网页端上传的同一本书能对上），没有的用派生键；
 *  - is_deleted = 1 的书不导入；
 *  - 数据库没变化时跳过（第二次运行不重新解析），变了就照常导入；
 *  - 配置按用户隔离：只配了一个人时，别人的账号一本都不多。
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import AdmZip from 'adm-zip';
import Database from 'better-sqlite3';
import { eq, sql } from 'drizzle-orm';
import { loadConfig } from '../config.js';
import { ensureKeyPair } from '../crypto/keys.js';
import { closeDatabase, getDb, openDatabase } from '../db/index.js';
import { books, pluginData, plugins, readingSessions, syncEntries } from '../db/schema.js';
import { listPluginTasks, loadPlugins, runPluginTask, stopAllSchedules } from '../modules/plugins/loader.js';
import { installPlugin, updatePluginConfig } from '../modules/plugins/service.js';
import { listUsersWithConfig, saveUserConfig } from '../modules/plugins/user-config.js';
import { safeParseManifest } from '../modules/plugins/internal.js';
import { getReadingHeatmap, listReadingSessions } from '../modules/stats/service.js';
import { createUser } from '../lib/users.js';
import { setLogLevel } from '../logger.js';

let passed = 0;
let failed = 0;

function check(name: string, condition: boolean, detail?: unknown): void {
  if (condition) {
    passed += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failed += 1;
    console.error(`  ✗ ${name}${detail !== undefined ? ` → ${JSON.stringify(detail).slice(0, 300)}` : ''}`);
  }
}

const PLUGIN_ID = 'com.readsync.anx-reader-sync';
const PLATFORM = 'anx';
/** 造数据用的 md5：bookA 有真实 file_md5，bookB 故意没有 */
const MD5_A = createHash('md5').update('bookA').digest('hex');
const CFI_A = 'epubcfi(/6/458!/4,/70/1:40,/82/1:133)';
/** 1×1 的 PNG（魔数对得上就够了，服务端只看魔数） */
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64',
);

function md5Of(text: string): string {
  return createHash('md5').update(text, 'utf8').digest('hex');
}

/** 造一个结构与 Anx Reader 一致的数据库 */
function buildAnxDatabase(file: string): void {
  const db = new Database(file);
  try {
    db.exec(`
      CREATE TABLE tb_books (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT,
        cover_path TEXT,
        file_path TEXT,
        last_read_position TEXT,
        reading_percentage REAL,
        author TEXT,
        is_deleted INTEGER,
        description TEXT,
        create_time TEXT,
        update_time TEXT,
        rating REAL,
        group_id INTEGER,
        file_md5 TEXT
      );
      CREATE TABLE tb_reading_time (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        book_id INTEGER,
        date TEXT,
        reading_time INTEGER
      );
    `);

    const insertBook = db.prepare(
      `INSERT INTO tb_books
         (id, title, cover_path, file_path, last_read_position, reading_percentage, author, is_deleted, description, create_time, update_time, rating, group_id, file_md5)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    // A：有 file_md5、有封面、读到 86%
    insertBook.run(
      1,
      '测试书 A',
      'cover/a.png',
      'file/a.epub',
      CFI_A,
      0.86,
      '作者甲',
      0,
      '一本书的简介',
      '2025-12-28T23:00:12.156352',
      '2026-03-02T21:30:05.000000',
      4.5,
      null,
      MD5_A,
    );
    // B：没有 file_md5（用派生键兜底），读到 12.5%
    insertBook.run(
      2,
      '测试书 B',
      null,
      'file/b.txt',
      'epubcfi(/6/10!/4,/2/1:0)',
      0.125,
      null,
      0,
      null,
      '2026-01-01T10:00:00.000000',
      '2026-03-01T09:00:00.000000',
      0,
      null,
      null,
    );
    // C：在 Anx 里已删除 —— 不该被导入
    insertBook.run(3, '已删除的书', null, 'file/c.epub', null, 0.5, null, 1, null, null, null, 0, null, null);

    const insertTime = db.prepare('INSERT INTO tb_reading_time (book_id, date, reading_time) VALUES (?, ?, ?)');
    insertTime.run(1, '2026-03-01', 1200);
    insertTime.run(1, '2026-03-02', 900);
    insertTime.run(2, '2026-03-01', 300);
    // 上游删掉的那本书记的时长：book_id 指向已删除的书，两边都不该算
    insertTime.run(3, '2026-03-01', 5000);
  } finally {
    db.close();
  }
}

async function main(): Promise<void> {
  const config = loadConfig();

  if (!/data-anx|data-e2e|data-smoke|tmp|test/i.test(config.dataDir)) {
    console.error(`拒绝执行：数据目录 ${config.dataDir} 看起来不是测试目录。`);
    console.error('请设置 READSYNC_DATA_DIR=./data-anx 后重试。');
    process.exit(1);
  }

  // packages/server/src/scripts → 四级回到仓库根
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');

  rmSync(config.dataDir, { recursive: true, force: true });
  for (const dir of [config.dataDir, config.tmpDir, config.localStorageDir, config.pluginDir]) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  ensureKeyPair();
  openDatabase();
  setLogLevel('warn');

  console.log(`Anx Reader 导入验证，数据目录：${config.dataDir}\n`);

  const db = getDb();

  /* -------------------- 1. 造一份 Anx 备份 -------------------- */
  const sampleDir = path.join(config.localStorageDir, 'anx-sample');
  mkdirSync(path.join(sampleDir, 'data', 'cover'), { recursive: true });
  const sampleDb = path.join(sampleDir, 'database7.db');
  buildAnxDatabase(sampleDb);
  writeFileSync(path.join(sampleDir, 'data', 'cover', 'a.png'), PNG_1X1);
  const dbFingerprint = createHash('md5').update(readFileSync(sampleDb)).digest('hex');
  check('造出 Anx 数据库（tb_books 3 行 / tb_reading_time 4 行，含 1 本已删除）', true);

  /* -------------------- 2. 账号与插件 -------------------- */
  const user = await createUser({
    username: 'anxuser',
    email: 'anx@example.com',
    plainPassword: 'AnxPass12345',
  });
  const other = await createUser({
    username: 'anxother',
    email: 'anx-other@example.com',
    plainPassword: 'AnxPass12345',
  });
  check('准备两个账号（第二个用来验证配置不外溢）', user.id > 0 && other.id > 0);

  const zip = new AdmZip();
  zip.addLocalFolder(path.join(repoRoot, 'packages', 'server', 'plugins-samples', 'anx-reader-sync'));
  const installed = await installPlugin(zip.toBuffer(), user.id);
  check('插件安装成功（清单校验通过）', installed.id === PLUGIN_ID, installed);

  updatePluginConfig(PLUGIN_ID, { intervalMinutes: '0', dailyAt: '' });
  db.update(plugins).set({ status: 'enabled' }).where(eq(plugins.pluginId, PLUGIN_ID)).run();
  await loadPlugins();

  const row = db.select().from(plugins).where(eq(plugins.pluginId, PLUGIN_ID)).get();
  check('插件加载无错误', row?.status === 'enabled', row?.error ?? row?.status);
  check('插件注册了 sync 任务', listPluginTasks(PLUGIN_ID).includes('sync'), listPluginTasks(PLUGIN_ID));

  const manifestOf = () => {
    const current = db.select().from(plugins).where(eq(plugins.pluginId, PLUGIN_ID)).get();
    const manifest = safeParseManifest(current?.manifest ?? {});
    if (!manifest) throw new Error('插件清单读不出来');
    return manifest;
  };

  const configureFor = (userId: number, values: Record<string, unknown>): void => {
    saveUserConfig(manifestOf(), PLUGIN_ID, userId, values);
  };

  /* -------------------- 3. 只配一个账号：只导他的 -------------------- */
  configureFor(user.id, {
    sourceMode: 'connect',
    driver: 'local',
    localPath: 'anx-sample',
    rootPath: '',
    dbPath: 'database7.db',
    assetDir: 'data',
    utcOffsetHours: '8',
    autoRegisterBooks: 'true',
    importReadingTime: 'true',
    importCovers: 'true',
  });

  const configured = listUsersWithConfig(PLUGIN_ID);
  check('只有一个账号配过时，遍历名单里也只有他', configured.length === 1 && configured[0] === user.id, configured);

  await runPluginTask(PLUGIN_ID, 'sync');

  const count = (table: 'books' | 'sessions', userId: number): number => {
    const r =
      table === 'books'
        ? db.select({ n: sql<number>`count(*)` }).from(books).where(eq(books.ownerId, userId)).get()
        : db
            .select({ n: sql<number>`count(*)` })
            .from(readingSessions)
            .where(eq(readingSessions.userId, userId))
            .get();
    return r?.n ?? 0;
  };

  if (count('books', user.id) === 0) {
    console.error('\n一本书都没导入，后续断言已跳过。');
    console.error(`插件数据：${JSON.stringify(db.select().from(pluginData).all().map((r) => [r.key, r.value]))}`);
    stopAllSchedules();
    closeDatabase();
    process.exit(1);
  }

  check('导入 2 本书（is_deleted = 1 的不算）', count('books', user.id) === 2, count('books', user.id));
  check('没配置过的账号一本都没多（配置不外溢）', count('books', other.id) === 0, count('books', other.id));

  const bookA = db
    .select()
    .from(books)
    .where(sql`${books.ownerId} = ${user.id} and ${books.md5} = ${MD5_A}`)
    .get();
  check('有 file_md5 的书按原 md5 登记（能与网页端上传的同一本对上）', bookA !== undefined, bookA?.title);
  check('书名取自 tb_books.title', bookA?.title === '测试书 A', bookA?.title);
  check('作者取自 tb_books.author', bookA?.author === '作者甲', bookA?.author);
  check('格式从 file_path 的扩展名推出', bookA?.format === 'epub', bookA?.format);

  const bookB = db
    .select()
    .from(books)
    .where(sql`${books.ownerId} = ${user.id} and ${books.md5} = ${md5Of('anx:2')}`)
    .get();
  check('没有 file_md5 的书用派生键兜底', bookB !== undefined, bookB?.title);
  check('txt 也被认得', bookB?.format === 'txt', bookB?.format);

  check(
    'reading_percentage 按 0-1 换算（86%）',
    Math.round(bookA?.progressPercent ?? -1) === 86,
    bookA?.progressPercent,
  );
  // 进度串存在 sync_entries 里（books 上只有聚合出来的百分比与时间）
  const entryA = db
    .select()
    .from(syncEntries)
    .where(sql`${syncEntries.userId} = ${user.id} and ${syncEntries.document} = ${MD5_A}`)
    .get();
  check('进度串原样保留 EPUB CFI', entryA?.progress === CFI_A, entryA?.progress);
  check('百分比按 0-10000 落库（86% → 8600）', entryA?.percentage === 8600, entryA?.percentage);
  check('同步来的进度把状态推进到「在读」', bookA?.readingStatus === 'reading', bookA?.readingStatus);
  check('封面从 data/cover 里取到', bookA?.coverUpdatedAt !== null, bookA?.coverUpdatedAt);
  check('没有封面的书不会因此失败', bookB?.coverUpdatedAt === null, bookB?.coverUpdatedAt);

  /* -------------------- 4. 时长：小时未知 -------------------- */
  const sessions = db
    .select()
    .from(readingSessions)
    .where(eq(readingSessions.userId, user.id))
    .all();
  check('阅读时长按「书 + 天」导入（3 段，已删除书的 5000 秒不算）', sessions.length === 3, sessions.length);
  check(
    '总时长 = 1200 + 900 + 300',
    sessions.reduce((sum, s) => sum + s.seconds, 0) === 2400,
    sessions.map((s) => s.seconds),
  );
  check(
    '全部记为「小时未知」（hour 为 null，而不是硬塞进 0 点）',
    sessions.every((s) => s.hour === null),
    sessions.map((s) => s.hour),
  );
  check('平台标识为 anx', sessions.every((s) => s.platform === PLATFORM), sessions[0]?.platform);

  // 明细接口要如实告诉前端「时间未知」
  const detail = listReadingSessions(user.id, { granularity: 'day' }, {}, 1, 20, 'Asia/Shanghai');
  check(
    '明细里标出 hourKnown = false',
    detail.total === 3 && detail.items.every((item) => item.hourKnown === false),
    detail.items.map((item) => item.hourKnown),
  );

  /*
   * 热力图必须**跳过**这些时长，而日合计照常包含它们。
   *
   * 这是「不编数据」那条原则的落点：如果实现里把 hour=null 当成 0 点，
   * 这里会看到凌晨那一格上多出一座并不存在的高峰。
   */
  const heatmap = getReadingHeatmap(user.id, { granularity: 'day' }, 'Asia/Shanghai', '2026-03-02');
  check(
    '热力图不显示这些时长（没有凭空出现的时段）',
    heatmap.totalSeconds === 0 && heatmap.cells.every((cell) => cell.seconds === 0),
    { totalSeconds: heatmap.totalSeconds, max: heatmap.maxSeconds },
  );
  check('但年份列表照常包含它们所在的年份', heatmap.availableYears.includes(2026), heatmap.availableYears);

  const trendTotal = db
    .select({ total: sql<number>`coalesce(sum(${readingSessions.seconds}), 0)` })
    .from(readingSessions)
    .where(sql`${readingSessions.userId} = ${user.id} and ${readingSessions.day} = '2026-03-01'`)
    .get()?.total;
  check('按天统计照常包含这些时长（3-01 共 1500 秒）', trendTotal === 1500, trendTotal);

  /* -------------------- 5. 数据库没变化就跳过 -------------------- */
  const firstRunAt = (db
    .select()
    .from(pluginData)
    .where(sql`${pluginData.pluginId} = ${PLUGIN_ID} and ${pluginData.key} = ${`lastRun:${user.id}`}`)
    .get()?.value ?? {}) as { at?: string };
  const storedFingerprint = db
    .select()
    .from(pluginData)
    .where(sql`${pluginData.pluginId} = ${PLUGIN_ID} and ${pluginData.key} = ${`dbMd5:${user.id}`}`)
    .get()?.value;

  check('记录了数据库指纹', storedFingerprint === dbFingerprint, { storedFingerprint, dbFingerprint });

  await runPluginTask(PLUGIN_ID, 'sync');
  const secondRunAt = (db
    .select()
    .from(pluginData)
    .where(sql`${pluginData.pluginId} = ${PLUGIN_ID} and ${pluginData.key} = ${`lastRun:${user.id}`}`)
    .get()?.value ?? {}) as { at?: string };
  check(
    '数据库未变化时走跳过分支（上次运行记录没有更新）',
    typeof firstRunAt.at === 'string' && secondRunAt.at === firstRunAt.at,
    { first: firstRunAt.at, second: secondRunAt.at },
  );
  check('跳过之后数据没有翻倍', count('sessions', user.id) === 3, count('sessions', user.id));

  /* -------------------- 6. 数据库变了就照常导入 -------------------- */
  {
    const busy = new Database(sampleDb);
    try {
      busy.prepare('UPDATE tb_reading_time SET reading_time = ? WHERE book_id = 1 AND date = ?').run(2222, '2026-03-01');
      busy.prepare('INSERT INTO tb_reading_time (book_id, date, reading_time) VALUES (?, ?, ?)').run(2, '2026-03-03', 600);
    } finally {
      busy.close();
    }

    await runPluginTask(PLUGIN_ID, 'sync');

    const thirdRunAt = (db
      .select()
      .from(pluginData)
      .where(sql`${pluginData.pluginId} = ${PLUGIN_ID} and ${pluginData.key} = ${`lastRun:${user.id}`}`)
      .get()?.value ?? {}) as { at?: string };
    check('数据库变化后会重新导入', thirdRunAt.at !== firstRunAt.at, { first: firstRunAt.at, third: thirdRunAt.at });

    const dayOne = db
      .select({ total: sql<number>`coalesce(sum(${readingSessions.seconds}), 0)` })
      .from(readingSessions)
      .where(sql`${readingSessions.userId} = ${user.id} and ${readingSessions.day} = '2026-03-01'`)
      .get()?.total;
    check('按天替换而不是累加（3-01 现在是 2222 + 300）', dayOne === 2522, dayOne);
    check('新出现的日期也导入了', count('sessions', user.id) === 4, count('sessions', user.id));
  }

  /* -------------------- 7. 上游删掉的日期会被清掉 -------------------- */
  {
    const busy = new Database(sampleDb);
    try {
      busy.prepare('DELETE FROM tb_reading_time WHERE date = ?').run('2026-03-03');
    } finally {
      busy.close();
    }

    await runPluginTask(PLUGIN_ID, 'sync');
    check('上游删掉的日期在本地也被清空', count('sessions', user.id) === 3, count('sessions', user.id));
  }

  stopAllSchedules();
  closeDatabase();

  console.log(`\n通过 ${passed} 项，失败 ${failed} 项`);
  if (failed > 0) {
    console.error('存在失败项。');
    process.exit(1);
  }
  console.log('全部通过 ✓');
}

main().catch((err) => {
  console.error('\n验证执行出错：', err);
  process.exit(1);
});
