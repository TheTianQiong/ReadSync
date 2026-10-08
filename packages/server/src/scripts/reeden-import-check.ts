/**
 * Reeden 导入的端到端验证。
 *
 * 拿一份真实的 Reeden 导出目录跑一遍完整导入（真 zip、真存储适配器、真数据库），
 * 并核对**从样本里算出来的**数字 —— 断言里的每个期望值都是先用独立脚本从样本
 * 里算出来的，不是照着实现反推的。
 *
 * 用法：
 *   READSYNC_DATA_DIR=./data-reeden REEDEN_SAMPLE=/path/to/你的/Reeden \
 *     npx tsx src/scripts/reeden-import-check.ts
 *
 * 仓库里**不附带**样本（那份真实导出属于个人阅读数据，不该进公开仓库），
 * 所以必须用 REEDEN_SAMPLE 指定。该目录**只读**：导入器不会改动它。
 *
 * 注意期望值（书目数、总秒数、单日秒数）是按某一份具体导出算出来的，
 * 换一份数据要对你的导出重新算过。
 *
 * 三种数据源（自带本地连接 / 复用已有存储 / 自带 S3 连接）**各用一个独立账号**，
 * 每个账号配自己那份配置 —— 于是「只配置了 A 的时候，B 和 C 一本都没多」
 * 这句话是能真的断言的，而不是靠「数量没变」这种假通过。
 */
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import AdmZip from 'adm-zip';
import { eq, sql } from 'drizzle-orm';
import { loadConfig } from '../config.js';
import { ensureKeyPair } from '../crypto/keys.js';
import { closeDatabase, getDb, openDatabase } from '../db/index.js';
import { books, pluginData, plugins, readingSessions, storages } from '../db/schema.js';
import { listPluginTasks, loadPlugins, runPluginTask, stopAllSchedules } from '../modules/plugins/loader.js';
import { installPlugin, updatePluginConfig } from '../modules/plugins/service.js';
import { listUsersWithConfig, resolveUserConfig, saveUserConfig } from '../modules/plugins/user-config.js';
import { safeParseManifest } from '../modules/plugins/internal.js';
import { createUser } from '../lib/users.js';
import { startMockS3 } from './mock-s3.js';
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

/** 把样本里那本书的进度文件复制一份到给定目录（S3 段用得上） */
function sampleBookFileName(): string {
  return `${EXPECTED.sampleBookId.toUpperCase()}.json`;
}

async function main(): Promise<void> {
  const config = loadConfig();

  if (!/data-reeden|data-e2e|data-smoke|tmp|test/i.test(config.dataDir)) {
    console.error(`拒绝执行：数据目录 ${config.dataDir} 看起来不是测试目录。`);
    console.error('请设置 READSYNC_DATA_DIR=./data-reeden 后重试。');
    process.exit(1);
  }

  /*
   * 样本必须由调用方指定。
   *
   * 仓库里**不附带** Reeden 导出样本 —— 那是一份真实的阅读数据（书目、阅读时长、
   * 划线标注），不该躺在公开仓库里。要跑这个验证，把自己 Reeden 根目录指过来即可。
   */
  // packages/server/src/scripts → 四级回到仓库根（下面定位插件源码时要用）
  const repoRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
    '..',
    '..',
    '..',
  );
  const sampleDir = path.resolve(process.env.REEDEN_SAMPLE ?? '');
  if (!existsSync(path.join(sampleDir, 'metadata'))) {
    console.error('需要一份 Reeden 导出才能跑这个验证。用 REEDEN_SAMPLE 指定它的根目录：');
    console.error('  READSYNC_DATA_DIR=./data-reeden REEDEN_SAMPLE=/path/to/Reeden \\');
    console.error('    npx tsx src/scripts/reeden-import-check.ts');
    console.error('');
    console.error('该目录下应有 metadata、book_progress、covers 这三样。');
    console.error('脚本只读它，不会改动你的数据。');
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
  /*
   * 三种数据源（自带本地连接 / 复用已有存储 / 自带 S3 连接）**各用一个独立账号**。
   *
   * 一开始三者共用同一个账号，断言写的是「跑完后数量不变」—— 那是**假通过**：
   * 前面的运行已经把数据都导进去了，后面那次就算一个字节都没读到，数量也「不变」。
   * 独立账号下必须从 0 涨到期望值，才能真正证明那次导入读到了数据。
   * 更要紧的是：配置是按用户存的，独立账号才断得清「谁的数据进了谁的账号」。
   */
  const user = await createUser({
    username: 'reedenuser',
    email: 'reeden@example.com',
    plainPassword: 'ReedenPass123',
    displayName: 'Reeden',
  });
  check('创建导入目标账号', user.id > 0, user.id);

  const storageUser = await createUser({
    username: 'reedenbystorage',
    email: 'reeden-storage@example.com',
    plainPassword: 'ReedenPass123',
  });
  const s3User = await createUser({
    username: 'reedenbys3',
    email: 'reeden-s3@example.com',
    plainPassword: 'ReedenPass123',
  });
  check('为「复用已有存储」与「S3」各准备一个独立账号', storageUser.id > 0 && s3User.id > 0);

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
  const pluginSrcDir = path.join(repoRoot, 'packages', 'server', 'plugins-samples', 'reeden-sync');
  const zip = new AdmZip();
  zip.addLocalFolder(pluginSrcDir);
  const installed = await installPlugin(zip.toBuffer(), user.id);
  check('插件安装成功（清单校验通过）', installed.id === PLUGIN_ID, installed);

  /*
   * 站点级配置只有节奏（间隔、每日补同步时间）。
   * 连接信息、根目录、导入策略统统是**用户级**的，写在各自的账号下。
   */
  updatePluginConfig(PLUGIN_ID, { intervalMinutes: '0', dailyAt: '' });
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

  /** 保存某个用户自己那份配置（与网页端「设置 → 插件」走的是同一套内核逻辑） */
  const configureFor = (userId: number, values: Record<string, unknown>): void => {
    const row = db.select().from(plugins).where(eq(plugins.pluginId, PLUGIN_ID)).get();
    const manifest = safeParseManifest(row?.manifest ?? {});
    if (!manifest) throw new Error('插件清单读不出来');
    saveUserConfig(manifest, PLUGIN_ID, userId, values);
  };

  const manifestOf = () => {
    const row = db.select().from(plugins).where(eq(plugins.pluginId, PLUGIN_ID)).get();
    const manifest = safeParseManifest(row?.manifest ?? {});
    if (!manifest) throw new Error('插件清单读不出来');
    return manifest;
  };

  const count = (table: 'books' | 'sessions', userId: number): number => {
    const row =
      table === 'books'
        ? db.select({ n: sql<number>`count(*)` }).from(books).where(eq(books.ownerId, userId)).get()
        : db
            .select({ n: sql<number>`count(*)` })
            .from(readingSessions)
            .where(eq(readingSessions.userId, userId))
            .get();
    return row?.n ?? 0;
  };

  /** 某个账号的总时长 */
  const totalSecondsOf = (userId: number): number =>
    db
      .select({ total: sql<number>`coalesce(sum(${readingSessions.seconds}), 0)` })
      .from(readingSessions)
      .where(eq(readingSessions.userId, userId))
      .get()?.total ?? 0;

  /* -------------------- 3. 只有第一个账号配过：只导他的 -------------------- */
  /*
   * 用插件**自己的连接信息**导入（默认模式）。
   *
   * 这是主要用法：Reeden 的同步目录通常在另一个网盘或另一个桶里，不该逼用户
   * 为它在「存储管理」里建条目。本地驱动要求相对路径，插件会把 localPath 交给
   * 内核用与「存储管理」相同的 schema 校验。
   */
  configureFor(user.id, {
    sourceMode: 'connect',
    driver: 'local',
    localPath: 'reeden-sample',
    rootPath: '',
    progressDir: 'book_progress',
    utcOffsetHours: '8',
    autoRegisterBooks: 'true',
    importReadingTime: 'true',
    importCovers: 'true',
  });

  const configuredIds = listUsersWithConfig(PLUGIN_ID);
  check('只有一个用户配过时，遍历名单里也只有他', configuredIds.length === 1 && configuredIds[0] === user.id, configuredIds);

  await runPluginTask(PLUGIN_ID, 'sync');

  if (count('books', user.id) === 0) {
    // 快速失败：没有书就别再往下查了，后面的断言只会掩盖真正的原因
    const run = getPluginData(user.id);
    console.error(`
一本书都没导入，后续断言已跳过。`);
    console.error(`插件上次运行记录：${JSON.stringify(run)}`);
    console.error('常见原因：存储路径不对（本地存储的 path 相对服务器存储目录）、连接信息填错。');
    stopAllSchedules();
    closeDatabase();
    process.exit(1);
  }

  check('书目数量与样本里的一致', count('books', user.id) === EXPECTED.bookCount, count('books', user.id));

  const sessionRows = count('sessions', user.id);
  check(`阅读会话行数为 ${EXPECTED.sessionRows}`, sessionRows === EXPECTED.sessionRows, sessionRows);

  const totalSeconds = totalSecondsOf(user.id);
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

  /*
   * 配置是按用户存的，所以「只配了我一个」时，别的账号必须一条数据都没有 ——
   * 这是这条特性最要紧的一句话，放在这里断言而不是靠人眼看日志。
   */
  check('没配置过的账号一本都没多（配置不会外溢）', count('books', storageUser.id) === 0, count('books', storageUser.id));
  check('没配置过的账号一条时长都没多', count('sessions', s3User.id) === 0, count('sessions', s3User.id));

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

  check('重跑后书目数不变', count('books', user.id) === EXPECTED.bookCount, count('books', user.id));
  check('重跑后会话行数不变', count('sessions', user.id) === EXPECTED.sessionRows, count('sessions', user.id));
  check('重跑后总时长不变（按天替换而非累加）', totalSecondsOf(user.id) === EXPECTED.totalSeconds, totalSecondsOf(user.id));

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

  /* -------------------- 5. 第二个账号：复用「存储管理」里的存储 -------------------- */
  /*
   * 两条取数据的路都必须能走通：自带连接（上面那几段）与复用「存储管理」里的
   * 存储。两者读的是同一份数据，所以「换了数据源但内容相同」不该把时长再算一遍。
   *
   * 存储必须挂在**他自己名下**：绑定用户之后只能访问自己的存储，拿别人的
   * ID 会被内核拒绝（这里正好给第二个账号建一条自己的存储）。
   */
  const ownStorage = db
    .insert(storages)
    .values({
      userId: storageUser.id,
      name: 'Reeden 样本（我的）',
      driver: 'local',
      config: { path: 'reeden-sample', quotaBytes: 0 },
      isDefault: true,
      readOnly: false,
      enabled: true,
    })
    .returning()
    .get();

  configureFor(storageUser.id, {
    sourceMode: 'existing',
    storageId: String(ownStorage.id),
    rootPath: '',
    progressDir: 'book_progress',
    utcOffsetHours: '8',
    autoRegisterBooks: 'true',
    importReadingTime: 'true',
    importCovers: 'true',
  });
  await runPluginTask(PLUGIN_ID, 'sync');

  check(
    '「复用已有存储」模式：书目数从 0 涨到期望值',
    count('books', storageUser.id) === EXPECTED.bookCount,
    count('books', storageUser.id),
  );
  check(
    '「复用已有存储」模式：会话行数从 0 涨到期望值',
    count('sessions', storageUser.id) === EXPECTED.sessionRows,
    count('sessions', storageUser.id),
  );
  check(
    '「复用已有存储」模式：总时长与自带连接一致',
    totalSecondsOf(storageUser.id) === EXPECTED.totalSeconds,
    totalSecondsOf(storageUser.id),
  );
  check(
    '给第二个账号跑导入没有动第一个账号的数据',
    count('sessions', user.id) === EXPECTED.sessionRows && totalSecondsOf(user.id) === EXPECTED.totalSeconds,
    { rows: count('sessions', user.id), seconds: totalSecondsOf(user.id) },
  );

  /* -------------------- 6. 插件自带 S3 连接（假 S3） -------------------- */
  {
    /*
     * 用户最需要的其实是这条：Reeden 的数据常在另一个对象存储上。
     * 用假 S3 走一遍真实 HTTP，顺带验证前缀拼接与「列目录」—— plugin 只给到桶与
     * 前缀，剩下的路径由插件自己拼，拼错就会读不到文件。
     */
    const s3 = await startMockS3();
    try {
      const samplePrefix = 'reeden';
      const objects: Array<[string, Buffer]> = [
        ['metadata', readFileSync(path.join(sampleCopy, 'metadata'))],
        ['covers', readFileSync(path.join(sampleCopy, 'covers'))],
        [
          `book_progress/${sampleBookFileName()}`,
          readFileSync(path.join(sampleCopy, 'book_progress', sampleBookFileName())),
        ],
      ];

      for (const [key, body] of objects) {
        const res = await fetch(`${s3.endpoint}/${s3.bucket}/${samplePrefix}/${key}`, {
          method: 'PUT',
          body,
        });
        if (!res.ok) throw new Error(`往假 S3 放 ${key} 失败：HTTP ${res.status}`);
      }
      check('样本已放进假 S3（前缀 reeden/）', true);

      configureFor(s3User.id, {
        sourceMode: 'connect',
        driver: 's3',
        s3Endpoint: s3.endpoint,
        s3Region: 'us-east-1',
        s3Bucket: s3.bucket,
        s3AccessKeyId: 'test-key',
        s3SecretAccessKey: 'test-secret',
        s3Prefix: samplePrefix,
        s3ForcePathStyle: 'true',
        rootPath: '',
        progressDir: 'book_progress',
        utcOffsetHours: '8',
        autoRegisterBooks: 'true',
        importReadingTime: 'true',
        importCovers: 'true',
      });

      await runPluginTask(PLUGIN_ID, 'sync');

      check(
        'S3 数据源：书目数从 0 涨到期望值',
        count('books', s3User.id) === EXPECTED.bookCount,
        count('books', s3User.id),
      );
      check(
        'S3 数据源：会话行数从 0 涨到期望值',
        count('sessions', s3User.id) === EXPECTED.sessionRows,
        count('sessions', s3User.id),
      );
      check(
        'S3 数据源：总时长与本地一致',
        totalSecondsOf(s3User.id) === EXPECTED.totalSeconds,
        totalSecondsOf(s3User.id),
      );

      /*
       * 进度是从 book_progress/ 里**列目录**发现的（而不是写死的文件名），
       * 所以这条能过就说明「桶 + 前缀 + 目录」三层路径拼对了。前缀丢了、
       * 或列目录没实现对，这条都会红。
       */
      const bookViaS3 = db
        .select({ progressPercent: books.progressPercent })
        .from(books)
        .where(
          sql`${books.ownerId} = ${s3User.id} and ${books.documentId} = ${EXPECTED.sampleBookId}`,
        )
        .get();
      check(
        'S3 数据源：进度为 86%（前缀与列目录都对）',
        Math.round(bookViaS3?.progressPercent ?? -1) === EXPECTED.sampleProgressPercent,
        bookViaS3?.progressPercent,
      );

      // 三个账号都配过了：遍历名单要齐，且各自读到的是**自己那份**配置
      const allIds = listUsersWithConfig(PLUGIN_ID);
      check('三个账号都配过后，遍历名单里正好是这三个', allIds.length === 3, allIds);

      const s3Cfg = resolveUserConfig(manifestOf(), PLUGIN_ID, s3User.id);
      const localCfg = resolveUserConfig(manifestOf(), PLUGIN_ID, user.id);
      check(
        'S3 账号读到的是自己的 S3 桶',
        s3Cfg.driver === 's3' && s3Cfg.s3Bucket === s3.bucket,
        { driver: s3Cfg.driver, bucket: s3Cfg.s3Bucket },
      );
      check(
        '本地账号读到的仍是本地目录（配置互不串台）',
        localCfg.driver === 'local' && localCfg.localPath === 'reeden-sample',
        { driver: localCfg.driver, path: localCfg.localPath },
      );
      check('S3 的密钥不会漏进别的账号的配置', localCfg.s3SecretAccessKey === undefined, localCfg.s3SecretAccessKey);

      /*
       * 升级场景：老版本把连接信息存在**站点配置**里，这些键现在是 user 归属了。
       * 旧值不能继续当「所有人的默认值」—— 那样管理员当年填的网盘密码会被发给
       * 每一个用户的导入。这里直接往 plugins.config 里塞一份遗留数据来复现。
       */
      db.update(plugins)
        .set({
          config: {
            intervalMinutes: 0,
            dailyAt: '',
            driver: 'webdav',
            webdavUrl: 'https://leaked.example.com/dav/',
            webdavPassword: 'leaked-secret',
          },
        })
        .where(eq(plugins.pluginId, PLUGIN_ID))
        .run();

      const afterStale = resolveUserConfig(manifestOf(), PLUGIN_ID, storageUser.id);
      check(
        '站点配置里遗留的旧连接信息不会当作用户默认值',
        afterStale.webdavUrl === undefined && (afterStale.webdavPassword ?? '') === '',
        { url: afterStale.webdavUrl, password: afterStale.webdavPassword },
      );
    } finally {
      await s3.close();
    }
  }

  /* -------------------- 7. 运行记录：每个账号各自一条 -------------------- */
  /*
   * `lastRun:<用户id>` 是内核与插件之间的约定，用户自助页面上那句
   * 「上次运行：…」就是从这里读出来的。也顺带证明三个账号是分别跑的。
   */
  const lastRun = getPluginData(s3User.id);
  check('插件记录了该用户的上次运行结果', typeof lastRun?.at === 'string', lastRun?.at);
  check('运行记录里有导入计数', Number(lastRun?.books) === EXPECTED.bookCount, lastRun);

  const otherRun = getPluginData(user.id);
  check(
    '两个账号的运行记录是分开的',
    typeof otherRun?.at === 'string' && typeof lastRun?.at === 'string',
    { first: otherRun?.at, third: lastRun?.at },
  );

  stopAllSchedules();
  closeDatabase();

  console.log(`\n通过 ${passed} 项，失败 ${failed} 项`);
  if (failed > 0) {
    console.error('存在失败项。');
    process.exit(1);
  }
  console.log('全部通过 ✓');
}

/** 读某个用户写在 plugin_data 里的运行记录（键名带用户 id，见清单说明） */
function getPluginData(userId: number): Record<string, unknown> | undefined {
  const row = getDb()
    .select({ value: pluginData.value })
    .from(pluginData)
    .where(sql`${pluginData.pluginId} = ${PLUGIN_ID} and ${pluginData.key} = ${`lastRun:${userId}`}`)
    .get();
  return row?.value as Record<string, unknown> | undefined;
}

main().catch((err) => {
  console.error('\n验证执行出错：', err);
  process.exit(1);
});
