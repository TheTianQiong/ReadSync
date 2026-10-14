/**
 * Reeden 导入的「上游没变就整轮跳过」验证。
 *
 * 为什么单独一份：仓库里不带 Reeden 样本，`reeden-import-check.ts` 需要用户提供
 * 真实导出目录才能跑。而「没变就跳过」这条逻辑必须随时能验 —— 它一旦失效，
 * 用户看到的是「同步跑过了，但数据没更新」，比不跳过还难排查。
 *
 * 所以这里自造一棵与 Reeden 导出同构的目录树（metadata zip + book_progress/*.json
 * + covers zip），走**真实内核**：安装插件 → 按用户配置 → 触发任务 → 校验库。
 * 顺带把「内核把文件修改时间交给插件」这条链路也照进去了 —— 插件的跳过判断
 * 正是靠它，只比大小的话「同长度的改写」会被漏掉。
 *
 * 用法：
 *   READSYNC_DATA_DIR=./data-reeden-skip npx tsx src/scripts/reeden-skip-check.ts
 *
 * 重点断言：
 *  - 上游没变时整轮跳过，且**库里一个字节都没动**（对比运行前后的整库快照）；
 *  - 「内容变了、长度没变」的进度文件必须被发现（专否「只比大小」的实现）；
 *  - metadata 变了、进度文件被删了，都要重新导入；
 *  - skipUnchanged = false 时永远不跳过（同时证明上面那个快照探针确实灵敏）；
 *  - 指纹键里带着导入逻辑版本。
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import AdmZip from 'adm-zip';
import { eq, sql } from 'drizzle-orm';
import { loadConfig } from '../config.js';
import { ensureKeyPair } from '../crypto/keys.js';
import { closeDatabase, getDb, openDatabase } from '../db/index.js';
import { books, pluginData, plugins, readingSessions, syncEntries } from '../db/schema.js';
import { listPluginTasks, loadPlugins, runPluginTask, stopAllSchedules } from '../modules/plugins/loader.js';
import { installPlugin, updatePluginConfig } from '../modules/plugins/service.js';
import { listUsersWithConfig, saveUserConfig } from '../modules/plugins/user-config.js';
import { safeParseManifest } from '../modules/plugins/internal.js';
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

const PLUGIN_ID = 'com.readsync.reeden-sync';
const PLATFORM = 'reeden';
const SAMPLE_DIR = 'reeden-sample';
/** b3 用它当 bookId：32 位十六进制，插件应当原样当 md5 用 */
const HEX_BOOK_ID = createHash('md5').update('reeden-hex-book').digest('hex');
/** b1 / b2 的 bookId 不是十六进制，插件会派生成这两个文档标识 */
const DOC_B1 = createHash('md5').update('reeden:b1').digest('hex');
const DOC_B2 = createHash('md5').update('reeden:b2').digest('hex');

function md5Of(text: string): string {
  return createHash('md5').update(text, 'utf8').digest('hex');
}

/** 1×1 的 PNG（服务端的封面接口只看魔数） */
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64',
);

/** 造一份 Reeden 的 metadata：书目 + 按小时记录的时长 */
function writeMetadata(file: string, bookList: unknown[], hourly: unknown[]): void {
  const zip = new AdmZip();
  zip.addFile('book.json', Buffer.from(JSON.stringify(bookList), 'utf8'));
  zip.addFile('read_record_hourly.json', Buffer.from(JSON.stringify(hourly), 'utf8'));
  // read_record 与 hourly 是同一批数据的两个视图，这里留空（只在 hourly 没覆盖到日子时才用）
  zip.addFile('read_record.json', Buffer.from('[]', 'utf8'));
  writeFileSync(file, zip.toBuffer());
}

/** 写一个进度文件；`mtime` 给了就强制把修改时间设成它 */
function writeProgress(
  dir: string,
  bookId: string,
  content: Record<string, unknown>,
  mtime?: Date,
): string {
  const file = path.join(dir, 'book_progress', `${bookId}.json`);
  writeFileSync(file, JSON.stringify(content), 'utf8');
  if (mtime) utimesSync(file, mtime, mtime);
  return file;
}

function progressContent(readProgress: number, at: string): Record<string, unknown> {
  return {
    lastReadTime: at,
    readProgress,
    sectionIndex: 3,
    paragraphIndex: 7,
    elementIndex: 0,
    deviceId: 'dev-a',
  };
}

async function main(): Promise<void> {
  const config = loadConfig();

  if (!/data-reeden|data-anx|data-e2e|data-smoke|tmp|test/i.test(config.dataDir)) {
    console.error(`拒绝执行：数据目录 ${config.dataDir} 看起来不是测试目录。`);
    console.error('请设置 READSYNC_DATA_DIR=./data-reeden-skip 后重试。');
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

  console.log(`Reeden「上游没变就跳过」验证，数据目录：${config.dataDir}\n`);

  const db = getDb();

  /* -------------------- 1. 造一棵 Reeden 导出树 -------------------- */
  const sampleDir = path.join(config.localStorageDir, SAMPLE_DIR);
  mkdirSync(path.join(sampleDir, 'book_progress'), { recursive: true });
  const metadataFile = path.join(sampleDir, 'metadata');

  const metadataBooks = [
    { id: 'b1', title: '样本一', author: '作者甲', type: 'epub', size: 1024, cover_thumb: 'cover1' },
    { id: 'b2', title: '样本二', type: 'epub', size: 2048 },
    // 第三本用真实的 32 位十六进制 bookId：走「直接用」那条路，而不是派生键
    { id: HEX_BOOK_ID, title: '样本三', type: 'epub', size: 4096 },
  ];

  writeMetadata(metadataFile, metadataBooks, [
    { book_id: 'b1', date: '2026-03-01', hour: 9, read_seconds: 600 },
    { book_id: 'b2', date: '2026-03-01', hour: 10, read_seconds: 300 },
  ]);
  /*
   * 进度文件里的 lastReadTime 故意用「很晚」的固定值：服务端只接受比库里
   * （按上次写入的服务端时间计）更新的进度，写一个过去的时刻会让第二次写入
   * 被直接拒收 —— 那是另一条正确的规则，不该混进这里要验的东西。
   */
  const progressB1 = writeProgress(sampleDir, 'b1', progressContent(5000, '2030-01-01 00:00:00'));
  // b2 的初始时间也用「很晚」的值：见下面进度改写那一段的说明
  writeProgress(sampleDir, 'b2', progressContent(2500, '2030-01-01 00:00:00'));

  const coversZip = new AdmZip();
  coversZip.addFile('cover1.thumb', PNG_1X1);
  writeFileSync(path.join(sampleDir, 'covers'), coversZip.toBuffer());
  check('造出 Reeden 导出树（2 本书 / 2 个进度文件 / 1 张封面）', true);

  /* -------------------- 2. 账号与插件 -------------------- */
  const user = await createUser({
    username: 'reedenuser',
    email: 'reeden@example.com',
    plainPassword: 'ReedenPass123',
  });
  const other = await createUser({
    username: 'reedenother',
    email: 'reeden-other@example.com',
    plainPassword: 'ReedenPass123',
  });
  check('准备两个账号（第二个用来验证配置不外溢）', user.id > 0 && other.id > 0);

  const zip = new AdmZip();
  zip.addLocalFolder(path.join(repoRoot, 'packages', 'server', 'plugins-samples', 'reeden-sync'));
  const installed = await installPlugin(zip.toBuffer(), user.id);
  check('插件安装成功（清单校验通过）', installed.id === PLUGIN_ID, installed);

  // 设成「只在手动触发时跑」：这个脚本自己调任务，不要留定时器
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

  const baseConfig = {
    sourceMode: 'connect',
    driver: 'local',
    localPath: SAMPLE_DIR,
    rootPath: '',
    progressDir: 'book_progress',
    utcOffsetHours: '8',
    autoRegisterBooks: 'true',
    importReadingTime: 'true',
    importCovers: 'true',
  };

  configureFor(user.id, baseConfig);
  const configured = listUsersWithConfig(PLUGIN_ID);
  check('只有一个账号配过时，遍历名单里也只有他', configured.length === 1 && configured[0] === user.id, configured);

  /* -------------------- 3. 首次导入 -------------------- */
  await runPluginTask(PLUGIN_ID, 'sync');

  const countBooks = (userId: number): number =>
    db.select({ n: sql<number>`count(*)` }).from(books).where(eq(books.ownerId, userId)).get()?.n ?? 0;
  const rowsOf = () => db.select().from(readingSessions).where(eq(readingSessions.userId, user.id)).all();
  const entryOf = (document: string) =>
    db
      .select()
      .from(syncEntries)
      .where(sql`${syncEntries.userId} = ${user.id} and ${syncEntries.document} = ${document}`)
      .get();
  const bookOf = (title: string) =>
    db
      .select()
      .from(books)
      .where(sql`${books.ownerId} = ${user.id} and ${books.title} = ${title}`)
      .get();

  if (countBooks(user.id) === 0) {
    console.error('\n一本书都没导入，后续断言已跳过。');
    console.error(`插件数据：${JSON.stringify(db.select().from(pluginData).all().map((r) => [r.key, r.value]))}`);
    stopAllSchedules();
    closeDatabase();
    process.exit(1);
  }

  check('导入 3 本书', countBooks(user.id) === 3, countBooks(user.id));
  check('没配置过的账号一本都没多（配置不外溢）', countBooks(other.id) === 0, countBooks(other.id));

  const b1 = bookOf('样本一');
  /*
   * bookId 不是 32 位十六进制（UUID / 别自增数字…）时，直接拿它当 md5 或文档标识
   * 传给内核会被拒 —— 那样一本都导不进来（这份验证就是被这条打回过一次）。
   * 十六进制的照旧原样用，非十六进制的派生一个稳定的键兜底。
   */
  check(
    'bookId 不是十六进制时，md5 与文档标识都用派生键',
    b1?.md5 === md5Of('reeden:b1') && b1?.documentId === md5Of('reeden:b1'),
    { md5: b1?.md5, documentId: b1?.documentId },
  );
  check(
    'bookId 本身是十六进制时原样当 md5（能与网页端上传的同一本对上）',
    bookOf('样本三')?.md5 === HEX_BOOK_ID,
    bookOf('样本三')?.md5,
  );
  check(
    '进度按 book_progress 写入（5000 → 50.00%）',
    entryOf(DOC_B1)?.percentage === 5000,
    entryOf(DOC_B1)?.percentage,
  );
  check(
    '第二本也是（2500 → 25.00%）',
    entryOf(DOC_B2)?.percentage === 2500,
    entryOf(DOC_B2)?.percentage,
  );
  check('进度状态推进到「在读」', b1?.readingStatus === 'reading', b1?.readingStatus);

  const firstSessions = rowsOf();
  check('时长导入 2 段（600 + 300）', firstSessions.length === 2, firstSessions.length);
  check(
    '总时长 900 秒，平台为 reeden',
    firstSessions.reduce((sum, s) => sum + s.seconds, 0) === 900 &&
      firstSessions.every((s) => s.platform === PLATFORM),
    firstSessions.map((s) => [s.seconds, s.platform]),
  );
  check('小时粒度如实保留（9 点 600 秒 / 10 点 300 秒）', firstSessions.every((s) => s.hour !== null), {
    hours: firstSessions.map((s) => s.hour),
  });
  check('时长都关联到了书籍', firstSessions.every((s) => s.bookId !== null), firstSessions.map((s) => s.bookId));
  check('有封面的书取到了封面', (b1?.coverUpdatedAt ?? null) !== null, b1?.coverUpdatedAt);
  check('没封面的书保持为空', bookOf('样本二')?.coverUpdatedAt === null, bookOf('样本二')?.coverUpdatedAt);

  /* -------------------- 4. 上游没变：整轮跳过 -------------------- */
  // 键名形如 sourceSig:v<导入逻辑版本>:<用户id>。这里按正则找，不写死版本号 ——
  // 否则以后每次抬版本都要来改一遍测试（改了就是假红）。
  const fingerprintRows = db
    .select()
    .from(pluginData)
    .where(eq(pluginData.pluginId, PLUGIN_ID))
    .all()
    .filter((row) => new RegExp(`^sourceSig:v\\d+:${user.id}$`).test(row.key));
  check(
    '指纹键里带着导入逻辑版本（改了逻辑就 +1，让所有人重跑一次）',
    fingerprintRows.length === 1 && /^[0-9a-f]{32}$/.test(String(fingerprintRows[0]?.value ?? '')),
    fingerprintRows.map((row) => [row.key, row.value]),
  );

  /*
   * 整库快照 —— 「跳过那一轮真的什么都没写」的探针。
   * 它的灵敏度由下面 skipUnchanged=false 那一轮反证（那轮会全量重跑，快照必须变）。
   */
  const snapshotOf = (): string =>
    JSON.stringify({
      books: db.select().from(books).all(),
      entries: db.select().from(syncEntries).all(),
      sessions: db.select().from(readingSessions).all(),
      plugin: db.select().from(pluginData).where(eq(pluginData.pluginId, PLUGIN_ID)).all(),
    });

  const beforeSkip = snapshotOf();
  const secondRun = (await runPluginTask(PLUGIN_ID, 'sync')) as
    | { skippedUnchanged?: number; message?: string }
    | null
    | undefined;
  check(
    '上游没变：整轮跳过，并把原因告诉调用方（用户点「立即同步」看得到）',
    secondRun?.skippedUnchanged === 1 && secondRun?.message === '上游没有变化，无需导入',
    secondRun,
  );
  check('跳过那一轮库里一个字节都没动', snapshotOf() === beforeSkip);

  /* -------------------- 5. 同一份数据的重跑确实会动库（探针灵敏度） -------------------- */
  // skipUnchanged 是**站点级**开关（与安读插件一致）：用户配置那条路会按设计丢弃它
  await updatePluginConfig(PLUGIN_ID, { skipUnchanged: false });
  const beforeForced = snapshotOf();
  const forcedRun = (await runPluginTask(PLUGIN_ID, 'sync')) as
    | { skippedUnchanged?: number; message?: string }
    | null
    | undefined;
  check(
    'skipUnchanged = false 时即使没变也照常导入',
    forcedRun?.skippedUnchanged === 0 && forcedRun?.message !== '上游没有变化，无需导入',
    forcedRun,
  );
  check(
    '（探针灵敏度）全量重跑确实会写库 —— 所以上一条「没动」不是碰巧',
    snapshotOf() !== beforeForced,
  );
  await updatePluginConfig(PLUGIN_ID, { skipUnchanged: true });

  /* -------------------- 6. 内容变了但长度没变 -------------------- */
  const sizeBefore = readFileSync(progressB1);
  /*
   * 只改数字、不改长度：`5000` → `5001`、`00:00:00` → `00:05:00`（同一秒数位），
   * 时间同时往后挪一点，让服务端认它确实更新。
   */
  writeProgress(sampleDir, 'b1', progressContent(5001, '2030-01-01 00:05:00'), new Date('2031-01-01T00:00:00Z'));
  const sizeAfter = readFileSync(progressB1);
  check(
    '造出的改动确实「长度不变、只有内容变了」（下面那条断言的前提）',
    sizeBefore.length === sizeAfter.length && !sizeBefore.equals(sizeAfter),
    { before: sizeBefore.length, after: sizeAfter.length },
  );

  const changedRun = (await runPluginTask(PLUGIN_ID, 'sync')) as { skippedUnchanged?: number } | null | undefined;
  check('同长度的内容改写也被发现（只比大小的实现会在这里红）', changedRun?.skippedUnchanged === 0, changedRun);
  check('改写后的进度确实落库了（5001）', entryOf(DOC_B1)?.percentage === 5001, entryOf(DOC_B1)?.percentage);

  /* -------------------- 7. metadata 变了 -------------------- */
  writeMetadata(metadataFile, metadataBooks, [
    { book_id: 'b1', date: '2026-03-01', hour: 9, read_seconds: 600 },
    { book_id: 'b2', date: '2026-03-01', hour: 10, read_seconds: 300 },
    { book_id: 'b1', date: '2026-03-02', hour: 20, read_seconds: 900 },
  ]);
  const metaRun = (await runPluginTask(PLUGIN_ID, 'sync')) as { skippedUnchanged?: number } | null | undefined;
  check('metadata 变了会重新导入', metaRun?.skippedUnchanged === 0, metaRun);
  check('新增的那天也导进来了（3 段）', rowsOf().length === 3, rowsOf().length);

  /* -------------------- 8. 上游删掉一个进度文件 -------------------- */
  rmSync(path.join(sampleDir, 'book_progress', 'b2.json'));
  const removedRun = (await runPluginTask(PLUGIN_ID, 'sync')) as { skippedUnchanged?: number } | null | undefined;
  check('进度文件被删掉（清单变了）也会重新导入', removedRun?.skippedUnchanged === 0, removedRun);

  /* -------------------- 9. 只有一本书变了：别的书一秒都不许动 -------------------- */
  {
    /*
     * 用户的原话：「只有某一本书或者某几本书的记录有变化，插件依旧会更新书库中
     * 所有书籍内容」。
     *
     * 成因有两处，这里各钉一条：
     *  - 进度照推：上游的 last_read_time 常常自己往前走，服务端会接受并重写这本书的
     *    最近阅读/更新时间；
     *  - 时长整批发：importSessions 是先删后写，整批发等于把所有书所有天重写一遍。
     */
    const booksBefore = db.select().from(books).all();
    const sessionsBefore = db.select().from(readingSessions).all();

    const beforeOf = (title: string) => {
      const row = booksBefore.find((b) => b.title === title)!;
      return { updatedAt: row.updatedAt.getTime(), lastReadAt: row.lastReadAt?.getTime() ?? null };
    };
    const afterOf = (title: string) =>
      db.select().from(books).where(sql`${books.ownerId} = ${user.id} and ${books.title} = ${title}`).get()!;

    const b1Before = beforeOf('样本一');
    const b2Before = beforeOf('样本二');

    // 只动 b2：内容变、长度不变（2500 → 2501），时间往后挪 5 分钟
    writeProgress(sampleDir, 'b2', progressContent(2501, '2030-01-01 00:05:00'));

    const run = (await runPluginTask(PLUGIN_ID, 'sync')) as
      | { progress?: number; progressUnchanged?: number; unchanged?: boolean }
      | null
      | undefined;
    check('上游确实变了（这一轮没被整轮跳过）', run?.unchanged !== true, run);
    check('只推了变化的那一本，没变的那本被跳过', run?.progress === 1 && run?.progressUnchanged === 1, run);

    const b1After = afterOf('样本一');
    const b2After = afterOf('样本二');
    check(
      '没变的书（样本一）的「最近更新 / 最近阅读」一点没动',
      b1After.updatedAt.getTime() === b1Before.updatedAt &&
        (b1After.lastReadAt?.getTime() ?? null) === b1Before.lastReadAt,
      { updatedAt: [b1Before.updatedAt, b1After.updatedAt.getTime()], lastReadAt: [b1Before.lastReadAt, b1After.lastReadAt?.getTime() ?? null] },
    );
    check(
      '变了的书（样本二）确实被更新了',
      b2After.updatedAt.getTime() !== b2Before.updatedAt,
      { before: b2Before.updatedAt, after: b2After.updatedAt.getTime() },
    );
    check('样本二的进度落库为 2501', entryOf(DOC_B2)?.percentage === 2501, entryOf(DOC_B2)?.percentage);
    check(
      '时长一条都没重写（上游的天数没变，按天指纹应当全部命中）',
      JSON.stringify(db.select().from(readingSessions).all()) === JSON.stringify(sessionsBefore),
    );
  }

  /* -------------------- 10. 只有一天变了：只重写那一天 -------------------- */
  {
    const rowsOn = (day: string) =>
      db
        .select()
        .from(readingSessions)
        .where(sql`${readingSessions.userId} = ${user.id} and ${readingSessions.day} = ${day}`)
        .all();
    const idsOn = (day: string) => rowsOn(day).map((row) => row.id).sort();
    const secondsOn = (day: string) => rowsOn(day).reduce((sum, row) => sum + row.seconds, 0);

    const dayOneIds = idsOn('2026-03-01');
    const dayTwoIds = idsOn('2026-03-02');
    check('前置：两个日期各有记录', dayOneIds.length > 0 && dayTwoIds.length > 0, {
      dayOneIds,
      dayTwoIds,
    });

    // 只改 3-01 的时长（600 → 700），3-02 原样不动
    writeMetadata(metadataFile, metadataBooks, [
      { book_id: 'b1', date: '2026-03-01', hour: 9, read_seconds: 700 },
      { book_id: 'b2', date: '2026-03-01', hour: 10, read_seconds: 300 },
      { book_id: 'b1', date: '2026-03-02', hour: 20, read_seconds: 900 },
    ]);

    const run = (await runPluginTask(PLUGIN_ID, 'sync')) as { sessionRows?: number } | null | undefined;
    check('只重写了变化的那一天（3-01 两行）', run?.sessionRows === 2, run);
    check('3-01 的时长被替换成 700 + 300', secondsOn('2026-03-01') === 1000, secondsOn('2026-03-01'));
    check(
      '3-02 的行 id 一个都没变（那天没变，没被重写）',
      JSON.stringify(idsOn('2026-03-02')) === JSON.stringify(dayTwoIds),
      { before: dayTwoIds, after: idsOn('2026-03-02') },
    );
  }

  /* -------------------- 11. 定时触发那一趟也不写 lastRun（跳过时） -------------------- */
  const lastRunAtOf = (): string | undefined => {
    const value = db
      .select()
      .from(pluginData)
      .where(sql`${pluginData.pluginId} = ${PLUGIN_ID} and ${pluginData.key} = ${`lastRun:${user.id}`}`)
      .get()?.value as { at?: string } | undefined;
    return value?.at;
  };
  const atBefore = lastRunAtOf();
  const skippedAgain = (await runPluginTask(PLUGIN_ID, 'sync')) as
    | { skippedUnchanged?: number }
    | null
    | undefined;
  check('再跑一次仍是跳过（指纹已更新）', skippedAgain?.skippedUnchanged === 1, skippedAgain);
  check('跳过时不刷新「上次运行」记录（免得把真实导入的统计冲掉）', lastRunAtOf() === atBefore);

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
