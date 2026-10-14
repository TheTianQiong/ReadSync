/**
 * 安读（Anx Reader）同步插件。
 *
 * Anx Reader（https://github.com/anxcye/anx-reader）把自己的书架与阅读记录放在
 * 一个 SQLite 数据库里，跟着备份一起同步到用户的 WebDAV / S3：
 *
 *   <备份根目录>
 *   ├── database7.db          书架、阅读进度、每日时长都在里面
 *   └── data
 *       ├── cover/<封面图>
 *       └── file/<书籍原文件>
 *
 * 本插件只读那个数据库（`ctx.sqlite.open()` 给的是只读句柄），把数据导进本服务器：
 * 书目、阅读进度、每天每本书的阅读时长、封面。**绝不改动上游的任何文件**。
 *
 * ---------------------------------------------------------------------------
 * 两张表怎么变成我们的数据
 *
 *  - `tb_books`：一行一本书。`file_md5` 正好就是书籍文件的整文件 MD5 —— 与服务端
 *    书库去重用的那个值是一回事，所以同一本书在网页端上传过、又在 Anx 里读过，
 *    两边会**归到同一本**（服务端按 md5 / 文档标识关联）。`reading_percentage`
 *    是 0-1 的小数，`last_read_position` 是 EPUB CFI 串（Anx 把 txt/pdf 也转成
 *    EPUB 再读，所以各格式都是 CFI，见其 lib/service/convert_to_epub/）。
 *
 *  - `tb_reading_time`：一行 = 一本书 + 一天 + 秒数。**它只有日粒度**，没有小时。
 *    所以这些时长是以「小时未知」导进去的（`hour: null`）：日/周/月统计照常包含，
 *    热力图与按小时下钻会跳过它们。把日合计硬塞进某个小时等于编数据 —— 热力图上
 *    会凭空长出一座并不存在的「凌晨高峰」。
 *
 * ---------------------------------------------------------------------------
 * 配置是**按用户**的
 *
 * 每个人有自己的备份目录与凭据，所以连接信息、数据库路径、时区都是清单里
 * `scope: "user"` 的字段，各自在「设置 → 插件」里填。插件遍历
 * `ctx.usersWithConfig()`，用 `ctx.forUser(userId)` 的入口写入 —— 那套 API 里
 * 没有 `user` 参数，导入只会进填配置的那个人自己的账号。
 *
 * 管理员那边只剩两件事：多久跑一次（默认 1 小时）、每天几点补一次（默认 08:00）。
 */

import { createHash } from 'node:crypto';

/** 平台标识：统计里按这个归类，可在「设置 → 阅读平台」里改成中文名 */
const PLATFORM = 'anx';
const DEVICE = 'Anx Reader';

/**
 * 导入逻辑版本（见下面 fingerprintKey 处的说明）。**改了导入逻辑就 +1**：
 * 这会让所有人在下次同步时完整重跑一遍，把历史数据按新逻辑刷新。
 *
 * v2：时长改为自行关联书目（此前只有 Anx 新建的书能关联上，
 *     Reeden 先建的那本会显示「未关联书籍」）。
 */
const LOGIC_VERSION = 3;

/** 服务端的书籍格式枚举（见 shared 的 BOOK_FORMATS）；认不出的扩展名一律按 other */
const KNOWN_FORMATS = new Set([
  'epub', 'pdf', 'mobi', 'azw3', 'azw', 'fb2', 'txt', 'cbz', 'cbr', 'djvu', 'zip', 'json', 'other',
]);

/* ========================================================================== *
 * 小工具
 * ========================================================================== */

/** 把图片字节的魔数认成 MIME —— 服务端的封面接口只接受四种位图 */
function detectImageMime(buf) {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 8 && buf.readUInt32BE(0) === 0x89504e47) return 'image/png';
  if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
    return 'image/webp';
  }
  if (buf.length >= 6 && buf.toString('ascii', 0, 3) === 'GIF') return 'image/gif';
  return null;
}

/** 把 `a/b` 与 `a/b/` 统一成 `a/b/`，空串保持空串 */
function asPrefix(value) {
  const trimmed = String(value ?? '')
    .trim()
    .replace(/^\/+/, '')
    .replace(/\/+$/, '');
  return trimmed === '' ? '' : `${trimmed}/`;
}

function joinKey(prefix, name) {
  return `${prefix}${name}`;
}

/** 32 位十六进制（服务端只认这种形态的 md5 / 文档标识） */
function isHex32(value) {
  return typeof value === 'string' && /^[0-9a-fA-F]{32}$/.test(value.trim());
}

function md5Hex(text) {
  return createHash('md5').update(text, 'utf8').digest('hex');
}

/**
 * 一本书的稳定键。
 *
 * 优先用 Anx 记的整文件 MD5：那样网页端上传的同一本书能对上。
 * 没有 MD5 的（导入异常、或从别的来源加进来的）用 `anx:<id>` 派生一个 ——
 * 它必须是 32 位十六进制，因为服务端拿它既当去重键又当文档标识。
 */
function bookKey(book) {
  return isHex32(book.file_md5) ? String(book.file_md5).toLowerCase() : md5Hex(`anx:${book.id}`);
}

/** 书籍格式：从 file_path 的扩展名推；认不出就 other */
function formatOf(filePath) {
  const match = /\.([a-z0-9]+)$/i.exec(String(filePath ?? ''));
  const ext = match ? match[1].toLowerCase() : '';
  return KNOWN_FORMATS.has(ext) ? ext : 'other';
}

/**
 * Anx 的时间戳是「本地时间、不带时区」的字符串（`2025-12-28T23:00:12.156352`）。
 *
 * 直接 `new Date(str)` 会按**服务器**时区解释，部署在 UTC 上就会整体偏 8 小时。
 * 所以先按字面量取出年月日时分秒，再减去配置里的偏移，得到真正的 UTC 时刻。
 */
function parseLocalTime(value, offsetHours) {
  if (typeof value !== 'string' || value.trim() === '') return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})/.exec(value.trim());
  if (!match) return null;

  const [, y, mo, d, h, mi, s] = match.map(Number);
  const utc = Date.UTC(y, mo - 1, d, h, mi, s) - offsetHours * 3600_000;
  const at = new Date(utc);
  return Number.isNaN(at.getTime()) ? null : at;
}

/** `YYYY-MM-DD`：只保留服务端认得的那种日期，别的宁可丢掉也不猜 */
function normalizeDay(value) {
  const text = String(value ?? '').trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : null;
}

/** 0-1 的进度 → 0-1；Anx 存的是小数，但真碰到 0-100 的库也认 */
function normalizePercentage(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.max(0, Math.min(1, n > 1 ? n / 100 : n));
}

/** 百分比按服务端自己的分辨率（万分之一）取整 —— 直接比浮点会因二进制误差误判成「变了」 */
function scalePercent(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return -1;
  return Math.min(10000, Math.max(0, Math.round(n * 10000)));
}

/**
 * 服务器上那份进度与上游这份是不是同一份（位置串与百分比任一不同就算变了）。
 *
 * **不看时间**：上游的 update_time 常会自己往前走（打开书、同步一下时间就变了），
 * 照推的话服务端会接受并重写这本书的最近阅读/更新时间。
 */
function sameProgress(current, percentage, position) {
  if (!current) return false;
  return (
    scalePercent(current.percentage) === scalePercent(percentage) &&
    (current.progress ?? '') === position
  );
}

/**
 * 某一天的小时表指纹（顺序无关）。
 *
 * document 也要算进去：时长与书目的关联是导入时解析出来的（文档标识 → md5 → 书名），
 * 关联结果变了就得重导一次，否则那天会一直挂着旧的归属。
 */
function dayDigest(hours) {
  return hours
    .map((entry) => `${entry.hour}|${entry.document ?? ''}|${entry.bookId ?? ''}|${entry.seconds}`)
    .sort()
    .join(';');
}

/* ========================================================================== *
 * 数据源连接（与 Reeden 插件同一套写法，填法也一致）
 * ========================================================================== */

function connectionFromConfig(cfg) {
  const driver = String(cfg.driver || '').trim();

  if (driver === 'webdav') {
    if (!cfg.webdavUrl) throw new Error('请填写 WebDAV 地址');
    return {
      driver: 'webdav',
      config: {
        url: String(cfg.webdavUrl).trim(),
        username: String(cfg.webdavUsername ?? ''),
        password: String(cfg.webdavPassword ?? ''),
        basePath: String(cfg.webdavBasePath || '/'),
        allowSelfSigned: cfg.webdavAllowSelfSigned === true,
      },
    };
  }

  if (driver === 's3') {
    if (!cfg.s3Endpoint || !cfg.s3Bucket) throw new Error('请填写 S3 的 Endpoint 与存储桶');
    const pathStyle = cfg.s3ForcePathStyle !== false;
    return {
      driver: 's3',
      config: {
        endpoint: String(cfg.s3Endpoint).trim(),
        region: String(cfg.s3Region || 'us-east-1'),
        bucket: String(cfg.s3Bucket).trim(),
        accessKeyId: String(cfg.s3AccessKeyId ?? ''),
        secretAccessKey: String(cfg.s3SecretAccessKey ?? ''),
        prefix: String(cfg.s3Prefix ?? ''),
        forcePathStyle: pathStyle,
        addressingStyle: pathStyle ? 'path' : 'virtual-host',
      },
    };
  }

  if (driver === 'local') {
    return {
      driver: 'local',
      config: {
        // 本地驱动的 path 是**相对**服务器存储目录的，绝对路径会被沙箱拒绝
        path: String(cfg.localPath || 'anx').trim() || 'anx',
        quotaBytes: 0,
      },
    };
  }

  throw new Error('请选择「连接方式」（WebDAV / S3 / 本地目录），或改用「复用已有存储」');
}

async function openSource(storage, cfg) {
  if (String(cfg.sourceMode || 'connect') === 'existing') {
    const storageId = Number(cfg.storageId);
    if (!Number.isFinite(storageId) || storageId <= 0) {
      throw new Error('请填写「已有存储的 ID」（或把数据源改成「在这里填连接信息」）');
    }
    return storage.forStorage(storageId);
  }
  return storage.connect(connectionFromConfig(cfg));
}

/* ========================================================================== *
 * 插件入口
 * ========================================================================== */

export async function register(ctx) {
  /**
   * 跑一遍导入。
   *
   * `run.user` 有值时**只跑那一个账号** —— 那是用户在「设置 → 插件」里点
   * 「立即同步」的情形，由内核从登录态给出，插件指定不了。没给就遍历所有
   * 配置过的人（定时任务与管理员手动触发走这条）。
   *
   * 单账号那趟**不吞异常**：点按钮的人需要看到失败原因。批量那趟相反 ——
   * 某个人网盘连不上只该跳过他自己。
   */
  async function runImport(run = {}) {
    const only = run.user;
    const userIds = only === undefined ? await ctx.usersWithConfig() : [only];

    if (userIds.length === 0) {
      ctx.log.info('还没有用户配置过自己的 Anx 备份位置，跳过（请在「设置 → 插件」里配置）');
      return { users: 0, skippedUsers: 0 };
    }

    const totals = { users: 0, skippedUsers: 0, skippedUnchanged: 0, books: 0, created: 0, progress: 0, progressUnchanged: 0, sessionRows: 0 };
    for (const userId of userIds) {
      try {
        const cfg = await ctx.getUserConfig(userId);
        const report = await runImportFor(userId, cfg);
        if (report.skipped) {
          totals.skippedUnchanged += 1;
          continue;
        }
        totals.users += 1;
        totals.books += report.books;
        totals.created += report.created;
        totals.progress += report.progress;
        totals.progressUnchanged += report.progressUnchanged ?? 0;
        totals.sessionRows += report.sessionRows ?? 0;
      } catch (err) {
        totals.skippedUsers += 1;
        // 只跑一个人时把错误抛出去（谁点的按钮谁该知道为什么没成）
        if (only !== undefined) throw err;
        ctx.log.error(`用户 #${userId} 的导入失败，已跳过该用户`, {
          userId,
          error: String(err?.message ?? err),
        });
      }
    }

    const message =
      totals.users === 0 && totals.skippedUnchanged > 0
        ? '数据库没有变化，无需导入'
        : `书 ${totals.books} 本（新登记 ${totals.created}），进度 ${totals.progress} 条，时长 ${totals.sessionRows} 段`;

    ctx.log.info(
      `本轮导入完成：成功 ${totals.users} 个账号（${totals.skippedUnchanged} 个数据库未变化已跳过），` +
        `失败 ${totals.skippedUsers} 个；${message}`,
    );
    return { ...totals, message };
  }

  /**
   * 单个用户的一次完整同步。
   *
   * `api` 是绑定到这个用户的写入入口（`ctx.forUser`），`cfg` 是他自己那份配置。
   */
  async function runImportFor(userId, cfg) {
    const api = ctx.forUser(userId);
    const source = await openSource(api.storage, cfg);

    const root = asPrefix(cfg.rootPath);
    const dbPath = String(cfg.dbPath || 'database7.db').replace(/^\/+/, '');
    const assetDir = String(cfg.assetDir || 'data').replace(/^\/+|\/+$/g, '');
    const offsetHours = Number.isFinite(Number(cfg.utcOffsetHours)) ? Number(cfg.utcOffsetHours) : 8;
    const report = {
      books: 0,
      created: 0,
      progress: 0,
      progressUnchanged: 0,
      sessions: 0,
      covers: 0,
      skipped: 0,
      sessionRows: 0,
    };

    // ---- 1) 取数据库（先比 MD5，没变就不解析） ----
    const dbKey = joinKey(root, dbPath);
    const stat = await source.stat(dbKey);
    if (!stat) {
      throw new Error(`找不到 ${dbKey} —— 请确认「Anx 备份根目录」与「数据库文件名」填对了`);
    }

    const bytes = Buffer.from(await source.get(dbKey));
    const fingerprint = createHash('md5').update(bytes).digest('hex');

    /*
     * 指纹键里带一个「导入逻辑版本」。
     *
     * 改了导入逻辑（比如这次修好了时长与书目的关联）就把它 +1：键一变，所有
     * 用户下次同步都会**完整重跑一遍**，历史数据随之被刷新（时长是按天替换的）。
     * 不带版本号的话，「数据库没变就跳过」会让旧数据一直躺着 —— 用户看到的是
     * 「升级了但什么都没变」，而原因藏在插件数据表的一个键里，谁也想不到。
     */
    const fingerprintKey = `dbMd5:v${LOGIC_VERSION}:${userId}`;

    if (cfg.skipUnchanged !== false && (await ctx.pluginData.get(fingerprintKey)) === fingerprint) {
      ctx.log.info(`数据库未变化（${fingerprint.slice(0, 8)}…），跳过`, { userId });
      return { ...report, skipped: true };
    }

    // ---- 2) 读两张表 ----
    const db = await ctx.sqlite.open({ data: bytes });
    let bookRows;
    let timeRows;
    try {
      bookRows = await db.all(
        `SELECT id, title, cover_path, file_path, last_read_position, reading_percentage,
                author, is_deleted, description, update_time, file_md5
           FROM tb_books`,
      );
      timeRows =
        cfg.importReadingTime !== false
          ? await db.all(`SELECT book_id, date, reading_time FROM tb_reading_time`)
          : [];
    } finally {
      // 无论成功失败都关掉：临时文件是宿主建的，插件有责任还回去
      db.close();
    }

    const booksById = new Map();
    for (const row of bookRows) {
      // is_deleted 为 1 的是用户在 Anx 里删掉的书，不该再导进来
      if (Number(row.is_deleted) === 1) continue;
      booksById.set(Number(row.id), row);
    }

    // ---- 3) 逐本导入 ----
    const coverJobs = [];
    const sessionsByDay = new Map();

    for (const [anxId, meta] of booksById) {
      const title = typeof meta.title === 'string' && meta.title.trim() ? meta.title.trim() : `Anx 书籍 ${anxId}`;
      const md5 = bookKey(meta);
      const documentId = md5;

      let book = null;
      if (cfg.autoRegisterBooks !== false) {
        book = await api.sync.ensureBook({
          title,
          md5,
          documentId,
          ...(meta.author ? { author: String(meta.author) } : {}),
          format: formatOf(meta.file_path),
          ...(meta.description ? { description: String(meta.description) } : {}),
          tags: ['Anx Reader'],
        });
        if (book.created) {
          report.created += 1;
          // 封面只给刚建的书设：不覆盖用户自己传的封面
          if (cfg.importCovers !== false && meta.cover_path) {
            coverJobs.push({ book: book.id, coverPath: String(meta.cover_path) });
          }
        }
      } else {
        book = await api.sync.findBook({ documentId });
        if (!book) {
          report.skipped += 1;
        }
      }

      if (!book) continue;
      report.books += 1;

      // 进度：reading_percentage 是 0-1，last_read_position 是 EPUB CFI
      const percentage = normalizePercentage(meta.reading_percentage);
      const position = typeof meta.last_read_position === 'string' ? meta.last_read_position : '';
      if (percentage > 0 || position) {
        /*
         * 与服务器上那份一样就不推。上游的 update_time 常会自己往前走
         * （打开书、同步一下时间就变了），照推的话服务端会接受并重写这本书的
         * 最近阅读/更新时间 —— 于是「只有一本在读，整库的书都显示成刚更新过」。
         */
        const current = await api.sync.getProgress({ document: documentId });
        if (sameProgress(current, percentage, position)) {
          report.progressUnchanged += 1;
        } else {
          const at = parseLocalTime(meta.update_time, offsetHours);
          const result = await api.sync.pushProgress({
            document: documentId,
            title,
            progress: position,
            percentage,
            platform: PLATFORM,
            device: DEVICE,
            deviceId: 'anx',
            ...(at ? { clientTime: at.toISOString() } : {}),
          });
          if (result.accepted) report.progress += 1;
        }
      }
    }

    // ---- 4) 阅读时长：一天一本书一行，按天替换 ----
    if (cfg.importReadingTime !== false) {
      for (const row of timeRows) {
        const day = normalizeDay(row.date);
        const book = booksById.get(Number(row.book_id));
        const seconds = Math.round(Number(row.reading_time));
        if (!day || !book || !Number.isFinite(seconds) || seconds <= 0) continue;

        if (!sessionsByDay.has(day)) sessionsByDay.set(day, []);
        sessionsByDay.get(day).push({
          // Anx 只有日粒度：如实记成「小时未知」，不假装是某个小时读的
          hour: null,
          seconds,
          document: bookKey(book),
        });
        report.sessions += 1;
      }
    }

    {
      /*
       * 时长：按天算指纹，只把「和上次不一样」的天、以及「上游已经没有」的天
       * 发过去。服务端的 importSessions 是**先删后写**，整批发过去会让
       * 所有书、所有天的记录都被重写一遍 —— 用户看到的就是
       * 「只读了一本书，书库里所有书的历史记录都动了一遍」。
       *
       * 状态键名带导入逻辑版本；它同时承担原 importedDays 的职责：
       * 上游删掉的那天在这里就是「以前有、现在没有」，送空小时表即被清空。
       */
      const digestKey = `sessionDays:v${LOGIC_VERSION}:${userId}`;
      const previous = (await ctx.pluginData.get(digestKey)) ?? {};
      const next = {};
      const changed = [];

      for (const [day, hours] of sessionsByDay) {
        const digest = dayDigest(hours);
        next[day] = digest;
        if (previous[day] !== digest) changed.push({ day, hours });
      }
      for (const day of Object.keys(previous)) {
        if (!sessionsByDay.has(day)) changed.push({ day, hours: [] });
      }

      if (changed.length > 0) {
        const result = await api.sync.importSessions({
          platform: PLATFORM,
          device: DEVICE,
          days: changed,
        });
        report.sessionRows = result.inserted;
        ctx.log.info(`时长：${changed.length} 天有变化，已按天替换`, { userId });
      } else {
        ctx.log.info(`时长：${Object.keys(next).length} 天全部与上次一致，一条都没重写`, { userId });
      }

      const kept = {};
      for (const day of Object.keys(next).sort().slice(-500)) kept[day] = next[day];
      await ctx.pluginData.set(digestKey, kept);
    }

    // ---- 5) 封面 ----
    if (coverJobs.length > 0) {
      const failures = [];
      // 资源目录要带尾斜杠才能与文件名拼起来（`data` + `cover/a.png` 会拼成
      // `datacover/a.png`，看着像路径、其实谁都不认识）
      const assetPrefix = asPrefix(joinKey(root, assetDir));
      for (const job of coverJobs) {
        try {
          // cover_path 是相对资源目录的（cover/xxx.png），也可能已经是完整路径
          const key =
            assetDir && !job.coverPath.startsWith(`${assetDir}/`)
              ? joinKey(assetPrefix, job.coverPath)
              : joinKey(root, job.coverPath);

          const raw = Buffer.from(await source.get(key));
          const mime = detectImageMime(raw);
          if (!mime) continue;
          await api.sync.setCover({ book: job.book, mime, dataBase64: raw.toString('base64') });
          report.covers += 1;
        } catch (err) {
          // 封面缺失很常见（Anx 里没抓到的书就是没有），不该让整次导入失败
          failures.push(String(err?.message ?? err));
        }
      }
      if (failures.length > 0) {
        ctx.log.warn(`有 ${failures.length} 张封面没取到（不影响书目与进度）`, { userId, sample: failures[0] });
      }
    }

    await ctx.pluginData.set(fingerprintKey, fingerprint);
    // 「上次运行」由内核读出来显示在用户的自助页面上，键名是约定好的
    await ctx.pluginData.set(`lastRun:${userId}`, {
      at: new Date().toISOString(),
      message:
        `书 ${report.books} 本（新登记 ${report.created}），进度 ${report.progress} 条` +
        `${report.progressUnchanged > 0 ? `（${report.progressUnchanged} 本没变，未重写）` : ''}，` +
        `时长 ${report.sessionRows ?? 0} 段`,
      ...report,
    });

    ctx.log.info(
      `用户 #${userId} 导入完成：书 ${report.books}（新登记 ${report.created}），` +
        `进度 ${report.progress}（${report.progressUnchanged} 本未变化已跳过），` +
        `时长 ${report.sessionRows ?? 0} 段，封面 ${report.covers}，跳过 ${report.skipped}`,
      { userId },
    );
    return report;
  }

  /** 定时触发走这里：错误只记日志，不让定时器炸掉 */
  async function safeRun(reason, run) {
    try {
      return await runImport(run);
    } catch (err) {
      ctx.log.error(`导入失败（${reason}）`, { error: String(err?.message ?? err) });
      return null;
    }
  }

  // ---- 定时任务 ----
  // 触发时刻由内核按「整点对齐 + 本插件的固定偏移」排（见 plugin-development.md 4.4）
  const initialCfg = ctx.getConfig();
  const intervalMinutes = Number(initialCfg.intervalMinutes);
  ctx.schedule(
    'sync',
    Number.isFinite(intervalMinutes) && intervalMinutes > 0 ? intervalMinutes : 0,
    (run) => {
      /*
       * 手动触发的错误要抛出去（点按钮的人得看到原因），定时触发的只记日志。
       * 两种触发共用同一个处理器，`run.trigger` 就是干这个用的。
       */
      if (run?.trigger === 'schedule') return safeRun('定时', run);
      return runImport(run);
    },
  );

  /*
   * 每日固定时间再完整同步一次（默认 08:00）。
   *
   * 为什么需要：Anx 也会轮转/清理自己的记录，而「数据库未变化就跳过」只看
   * 文件指纹 —— 当天结束前再抓一次，能把那些数据留住。
   *
   * 实现用「每分钟看一眼表」而不是排到那个时刻：这样管理员改完 dailyAt 立刻生效，
   * 也不用为每个用户各排一个计时器。用上次执行的日期去重。
   */
  const dailyAt = String(initialCfg.dailyAt || '').trim();
  if (/^\d{1,2}:\d{2}$/.test(dailyAt)) {
    ctx.schedule('daily-check', 1, async () => {
      const cfgNow = ctx.getConfig();
      const target = String(cfgNow.dailyAt || '').trim();
      if (!/^\d{1,2}:\d{2}$/.test(target)) return;

      const [hh, mm] = target.split(':').map((v) => Number(v));
      const now = new Date();
      if (now.getHours() !== hh || now.getMinutes() !== mm) return;

      const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
      const state = (await ctx.pluginData.get('dailyState')) ?? {};
      if (state.lastDate === today) return;
      await ctx.pluginData.set('dailyState', { lastDate: today, at: now.toISOString() });

      await safeRun('每日补同步', { trigger: 'schedule' });
    });
  }

  ctx.log.info(
    `已就绪：每 ${intervalMinutes > 0 ? `${intervalMinutes} 分钟` : '（关闭，仅手动）'}` +
      `${dailyAt ? `，每日 ${dailyAt} 补同步` : ''}`,
  );
}

export function unregister() {
  // 定时器由宿主清理（loader 的 clearSchedules），SQLite 句柄也已逐个 close
}
