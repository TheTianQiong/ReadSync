/**
 * Reeden 导入的端到端验证。
 *
 * 拿一份真实的 Reeden 导出目录跑一遍完整导入（真 zip、真存储适配器、真数据库），
 * 并核对**从样本里算出来的**数字 —— 断言里的每个期望值都是先用独立脚本从样本
 * 里算出来的，不是照着实现反推的。
 *
 * 用法：
 *   READSYNC_DATA_DIR=./data-reeden \
 *   REEDEN_SAMPLE=/path/to/你的/Reeden \
 *   npx tsx src/scripts/reeden-import-check.ts
 *
 * REEDEN_SAMPLE 指向 Reeden 的根目录（里面应有 metadata / book_progress / covers）。
 * 该目录**只读**：导入器不会改动它，这也是设计约束之一。
 */
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import AdmZip from 'adm-zip';
import { eq, sql } from 'drizzle-orm';
import { loadConfig } from '../config.js';
import { ensureKeyPair } from '../crypto/keys.js';
import { closeDatabase, getDb, openDatabase } from '../db/index.js';
import { books, pluginData, plugins, readingSessions, storages } from '../db/schema.js';
import { listPluginTasks, loadPlugins, runPluginTask, stopAllSchedules } from '../modules/plugins/loader.js';
import { installPlugin, updatePluginConfig } from '../modules/plugins/service.js';
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

/** 从样本里独立算出来的期望值（见脚本头部的说明） */
const EXPECTED = {
  /** hourly 的 172 行 + read_record 独有的 7 个小时桶 */
  sessionRows: 179,
  /**
   * 总秒数：**不是**两个文件相加。
   * hourly 覆盖的日子用 hourly，其余用 read_record —— 实测同一 (书,日期)
   * 两边日总数完全一致，相加会把时长翻倍（会得到 311791）。
   */
  totalSeconds: 159202,
  doubleCountedSeconds: 311791,
  bookCount: 18,
  /** 样本里那本《我在精神病院学斩神》 */
  sampleBookId: '28b1ada3bf0d0439dd1196bcf8fa6f4e',
  sampleProgressPercent: 86,
  /**
   * 该书 2026-09-23 那天的总时长。
   *
   * 注意是**求和**（hourly 在那天有 6 个小时行：10/11/12/13/14/15 点），
   * 不是取某一行 —— 第一版期望值就是按 dict 覆盖算的，少了整整 5565 秒。
   */
  sampleDaySeconds: 8447,
};

async function main(): Promise<void> {
  const config = loadConfig();

  if (!/data-reeden|data-e2e|data-smoke|tmp|test/i.test(config.dataDir)) {
    console.error(`拒绝执行：数据目录 ${config.dataDir} 看起来不是测试目录。`);
    console.error('请设置 READSYNC_DATA_DIR=./data-reeden 后重试。');
    process.exit(1);
  }

  // 必须显式给 REEDEN_SAMPLE：仓库里不带样本（那是用户的真实阅读数据，不该入库）
  const sampleDir = path.resolve(process.env.REEDEN_SAMPLE ?? '');
  if (!existsSync(path.join(sampleDir, 'metadata'))) {
    console.error(`找不到 Reeden 样本：${sampleDir}`);
    console.error('用 REEDEN_SAMPLE=<你的 Reeden 根目录> 指定；目录里应有 metadata / book_progress / covers。');
    process.exit(1);
  }

  // 数据目录清空重建（loadConfig 已经建过一些子目录，删完要补回来）
  rmSync(config.dataDir, { recursive: true, force: true });
  for (const dir of [config.dataDir, config.tmpDir, config.localStorageDir, config.pluginDir]) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  ensureKeyPair();
  openDatabase();
  setLogLevel('warn');

  console.log(`Reeden 导入验证，数据目录：${config.dataDir}`);
  console.log(`样本：${sampleDir}\n`);

  const db = getDb();

  /* -------------------- 1. 准备账号与存储 -------------------- */
  const user = await createUser({
    username: 'reedenuser',
    email: 'reeden@example.com',
    plainPassword: 'ReedenPass123',
    displayName: 'Reeden',
  });
  check('创建导入目标账号', user.id > 0, user.id);

  /*
   * 把样本复制到本地存储目录下。
   *
   * 不能把存储路径直接指向仓库里的样本目录：本地驱动的 path 是**相对**本地
   * 存储根的，绝对路径会被沙箱拒绝（「必须位于服务器本地存储目录内」）。
   * 复制一份也更稳妥 —— 导入器只读，但测试不该有机会动到样本原件。
   */
  const sampleCopy = path.join(config.localStorageDir, 'reeden-sample');
  cpSync(sampleDir, sampleCopy, { recursive: true });

  const storage = db
    .insert(storages)
    .values({
      userId: user.id,
      name: 'Reeden 样本',
      driver: 'local',
      config: { path: 'reeden-sample', quotaBytes: 0 },
      isDefault: true,
      readOnly: false,
      enabled: true,
    })
    .returning()
    .get();
  check('登记存储（样本已复制进存储目录）', storage.id > 0, storage.id);

  /* -------------------- 2. 安装插件（走真实安装路径） -------------------- */
  const pluginSrcDir = path.join(process.cwd(), 'plugins-samples', 'reeden-sync');
  const zip = new AdmZip();
  zip.addLocalFolder(pluginSrcDir);
  const installed = await installPlugin(zip.toBuffer(), user.id);
  check('插件安装成功（清单校验通过）', installed.id === PLUGIN_ID, installed);

  updatePluginConfig(PLUGIN_ID, {
    storageId: String(storage.id),
    username: user.username,
    rootPath: '',
    progressDir: 'book_progress',
    utcOffsetHours: '8',
    intervalMinutes: '0',
    dailyAt: '',
    autoRegisterBooks: 'true',
    importReadingTime: 'true',
    importCovers: 'true',
  });
  db.update(plugins).set({ status: 'enabled' }).where(eq(plugins.pluginId, PLUGIN_ID)).run();

  await loadPlugins();

  /*
   * 先看插件有没有加载错误。否则后面的断言会全部失败在一堆误导性的现象上
   * （比如「书目数量 0」），真正的原因（清单/入口报错）反而被埋掉。
   */
  const pluginRow = db.select().from(plugins).where(eq(plugins.pluginId, PLUGIN_ID)).get();
  check('插件加载无错误', pluginRow?.status === 'enabled', pluginRow?.error ?? pluginRow?.status);

  const tasks = listPluginTasks(PLUGIN_ID);
  check('插件加载后注册了任务', tasks.includes('sync'), tasks);
  check('间隔为 0 时也保留可手动触发的任务', tasks.includes('daily-check') === false, tasks);

  /* -------------------- 3. 跑导入 -------------------- */
  await runPluginTask(PLUGIN_ID, 'sync');

  const count = (table: 'books' | 'sessions'): number => {
    const row =
      table === 'books'
        ? db.select({ n: sql<number>`count(*)` }).from(books).where(eq(books.ownerId, user.id)).get()
        : db
            .select({ n: sql<number>`count(*)` })
            .from(readingSessions)
            .where(eq(readingSessions.userId, user.id))
            .get();
    return row?.n ?? 0;
  };

  if (count('books') === 0) {
    // 快速失败：没有书就别再往下查了，后面的断言只会掩盖真正的原因
    const run = await getPluginData();
    console.error(`
一本书都没导入，后续断言已跳过。`);
    console.error(`插件上次运行记录：${JSON.stringify(run)}`);
    console.error('常见原因：存储路径不对（本地存储的 path 相对服务器存储目录）、账号名写错。');
    stopAllSchedules();
    closeDatabase();
    process.exit(1);
  }

  check('书目数量与样本里的一致', count('books') === EXPECTED.bookCount, count('books'));

  const sessionRows = count('sessions');
  check(`阅读会话行数为 ${EXPECTED.sessionRows}`, sessionRows === EXPECTED.sessionRows, sessionRows);

  const totalSeconds =
    db
      .select({ total: sql<number>`coalesce(sum(${readingSessions.seconds}), 0)` })
      .from(readingSessions)
      .where(eq(readingSessions.userId, user.id))
      .get()?.total ?? 0;

  check(
    `总时长等于 ${EXPECTED.totalSeconds} 秒（两个数据源没有相加）`,
    totalSeconds === EXPECTED.totalSeconds,
    { got: totalSeconds, doubleCounted: EXPECTED.doubleCountedSeconds },
  );
  check(
    '明确不是两个文件的简单相加',
    totalSeconds !== EXPECTED.doubleCountedSeconds,
    totalSeconds,
  );

  const sampleBook = db
    .select()
    .from(books)
    .where(sql`${books.ownerId} = ${user.id} and ${books.documentId} = ${EXPECTED.sampleBookId}`)
    .get();
  check('样本里那本书已登记', sampleBook !== undefined, sampleBook?.title);
  check(
    '进度按 readProgress/10000 换算（86%）',
    Math.round(sampleBook?.progressPercent ?? -1) === EXPECTED.sampleProgressPercent,
    sampleBook?.progressPercent,
  );
  check('同步来的进度把状态推进到「在读」', sampleBook?.readingStatus === 'reading', sampleBook?.readingStatus);
  check('从 covers 里取到了封面', sampleBook?.coverUpdatedAt !== null, sampleBook?.coverUpdatedAt);
  check('书名取自 book.json', (sampleBook?.title?.length ?? 0) > 0, sampleBook?.title);
  check('作者取自 book.json', sampleBook?.author !== null, sampleBook?.author);
  check('字数取自 word_count', (sampleBook?.totalWords ?? 0) > 0, sampleBook?.totalWords);

  const daySeconds =
    db
      .select({ total: sql<number>`coalesce(sum(${readingSessions.seconds}), 0)` })
      .from(readingSessions)
      .where(
        sql`${readingSessions.userId} = ${user.id} and ${readingSessions.bookId} = ${sampleBook?.id} and ${readingSessions.day} = '2026-09-23'`,
      )
      .get()?.total ?? 0;
  check(`单日时长对得上（2026-09-23 = ${EXPECTED.sampleDaySeconds} 秒）`, daySeconds === EXPECTED.sampleDaySeconds, daySeconds);

  // 小时的归属要正确：read_record 的 create_at 是 UTC，按 +8 换算后才落在正确的小时上
  const mayRows = db
    .select({ day: readingSessions.day, hour: readingSessions.hour })
    .from(readingSessions)
    .where(sql`${readingSessions.userId} = ${user.id} and ${readingSessions.day} = '2026-05-07'`)
    .all();
  check(
    '早期数据（只有 read_record）按 UTC+8 归到正确小时',
    mayRows.length === 1 && mayRows[0]?.hour === 15,
    mayRows,
  );

  const sessionsDoc = db
    .select({ bookId: readingSessions.bookId })
    .from(readingSessions)
    .where(sql`${readingSessions.userId} = ${user.id} and ${readingSessions.day} = '2026-09-23'`)
    .all();
  check('阅读会话关联到了具体书目', (sessionsDoc[0]?.bookId ?? null) !== null, sessionsDoc);

  /* -------------------- 4. 幂等：再跑一次不该翻倍 -------------------- */
  await runPluginTask(PLUGIN_ID, 'sync');

  check('重跑后书目数不变', count('books') === EXPECTED.bookCount, count('books'));
  check('重跑后会话行数不变', count('sessions') === EXPECTED.sessionRows, count('sessions'));

  const totalAfter =
    db
      .select({ total: sql<number>`coalesce(sum(${readingSessions.seconds}), 0)` })
      .from(readingSessions)
      .where(eq(readingSessions.userId, user.id))
      .get()?.total ?? 0;
  check('重跑后总时长不变（按天替换而非累加）', totalAfter === EXPECTED.totalSeconds, totalAfter);

  const sampleAfter = db
    .select({ totalReadingSeconds: books.totalReadingSeconds })
    .from(books)
    .where(eq(books.id, sampleBook?.id ?? -1))
    .get();
  check(
    '重跑后单本累计时长不翻倍',
    (sampleAfter?.totalReadingSeconds ?? 0) <= EXPECTED.totalSeconds,
    sampleAfter?.totalReadingSeconds,
  );

  /* -------------------- 5. 运行记录 -------------------- */
  const lastRun = (await getPluginData()) ?? {};
  check('插件记录了上次运行结果', typeof lastRun.at === 'string', lastRun.at);
  check('运行记录里有导入计数', Number(lastRun.books) === EXPECTED.bookCount, lastRun);

  stopAllSchedules();
  closeDatabase();

  console.log(`\n通过 ${passed} 项，失败 ${failed} 项`);
  if (failed > 0) {
    console.error('存在失败项。');
    process.exit(1);
  }
  console.log('全部通过 ✓');
}

/** 读插件写在 plugin_data 里的运行记录 */
async function getPluginData(): Promise<Record<string, unknown> | undefined> {
  const row = getDb()
    .select({ value: pluginData.value })
    .from(pluginData)
    .where(sql`${pluginData.pluginId} = ${'com.readsync.reeden-sync'} and ${pluginData.key} = 'lastRun'`)
    .get();
  return row?.value as Record<string, unknown> | undefined;
}

main().catch((err) => {
  console.error('\n验证执行出错：', err);
  process.exit(1);
});
