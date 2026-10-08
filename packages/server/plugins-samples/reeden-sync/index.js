/**
 * Reeden 同步插件。
 *
 * 把 Reeden（Android 阅读器）的阅读数据从 WebDAV / S3 上读回来，导入本服务器：
 * 阅读进度、阅读时长、书目信息、封面。
 *
 * Reeden 在它的根目录下留了这些东西（本插件全部只读，绝不改动它们）：
 *
 *   metadata               zip，里面有 book.json / read_record.json /
 *                          read_record_hourly.json 等
 *   book_progress/<id>.json 每本书的阅读位置与进度
 *   covers                 zip，里面是 <hash>.thumb 封面图
 *
 * 三条数据源的取舍（都是从样本里核出来的，不是猜的）：
 *
 *  - **进度**取 book_progress 与 book.json 里 last_read_time 较新的那个。
 *  - **时长**优先 read_record_hourly.json：它的 (书, 日期, 小时) 粒度与本服务
 *    器的 reading_sessions 完全对得上。read_record.json 是同一批数据的
 *    「会话」视图（时长记在开始那一小时），且它多出早期若干天 —— 所以
 *    两种都读：hourly 覆盖的日子用 hourly，其余日子按 read_record 的
 *    create_at 归到对应小时。
 *  - **两者绝不能相加**：实测同一 (书, 日期) 的日总数两边完全一致，
 *    相加会把时长翻倍。
 *
 * 时间戳的口径：hourly 里的 date/hour 已经是**本地时间**，而 read_record 的
 * create_at 是 **UTC**。所以读 create_at 时要按 utcOffsetHours 换算，否则整天的
 * 时长会跑到错误的小时上（实测这个偏移是 +8）。
 *
 * 数据放在哪：**由本插件自己的配置决定**。Reeden 的同步目录一般和书籍文件存储
 * 不是同一个地方（不同网盘、不同桶，或者干脆是本地目录），所以这里支持直接填
 * WebDAV / S3 / 本地路径，不必为了它在「存储管理」里多建一条存储条目；想复用
 * 已有存储时把 sourceMode 选成 existing 也行。
 *
 * ---------------------------------------------------------------------------
 * 配置是**按用户**的
 *
 * 每个用户的 Reeden 放在自己的网盘上、有自己的凭据，所以连接信息、根目录、
 * 时区这些都在清单里标了 `scope: "user"` —— 各自在「设置 → 插件」里填自己的。
 * 插件这边只需要遍历 `ctx.usersWithConfig()`：
 *
 *     for (const userId of await ctx.usersWithConfig()) {
 *       const cfg = await ctx.getUserConfig(userId);
 *       const api = ctx.forUser(userId);
 *       await importFor(api, cfg);
 *     }
 *
 * 两条硬规矩（内核替我们兜住了，但要知道为什么）：
 *  - **导入到哪个账号不由配置决定。** 早先这里有个「导入到哪个账号」的填写项，
 *    那不是配置错误而是越权口子：任何用户只要填上别人的用户名，就能把数据
 *    导进别人的账号。现在账号由内核在 `forUser(userId)` 时定死，插件的写入
 *    入口里根本没有 user 参数。
 *  - **每个用户自己那份配置互相不可见。** 凭据落库前加密，读出来只给对应用户
 *    的那次导入用。
 *
 * `intervalMinutes` / `dailyAt` 是站点级的（管理员定全站的节奏）；其余都在用户手上。
 */

import { inflateRawSync } from 'node:zlib';

/* ========================================================================== *
 * 极简 zip 读取
 *
 * 插件是无依赖的纯 JS，不能指望 adm-zip 之类。只需要「按名字取一个条目」，
 * 所以读中央目录 + 按需解压就够，不必实现完整 zip。
 * ========================================================================== */

const EOCD_SIG = 0x06054b50;
const CD_SIG = 0x02014b50;

/** 解析中央目录，返回 name → {method, size, offset} */
function readZipDirectory(buf) {
  // EOCD 在文件末尾，注释最长 65535 字节，所以从这里往回找
  let eocd = -1;
  const from = Math.max(0, buf.length - 65557);
  for (let i = buf.length - 22; i >= from; i -= 1) {
    if (buf.readUInt32LE(i) === EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('不是有效的 zip（找不到中央目录）');

  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);

  const entries = new Map();
  for (let i = 0; i < count; i += 1) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== CD_SIG) break;
    const method = buf.readUInt16LE(p + 10);
    const compressedSize = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const offset = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    entries.set(name, { method, compressedSize, size, offset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/** 取出一个条目的原始字节；不存在返回 null */
function readZipEntry(buf, dir, name) {
  const entry = dir.get(name);
  if (!entry) return null;

  // 本地头比中央目录多了「实际的名字与扩展字段长度」，必须重新读一遍
  const p = entry.offset;
  const nameLen = buf.readUInt16LE(p + 26);
  const extraLen = buf.readUInt16LE(p + 28);
  const start = p + 30 + nameLen + extraLen;
  const raw = buf.subarray(start, start + entry.compressedSize);

  if (entry.method === 0) return Buffer.from(raw);
  if (entry.method === 8) return inflateRawSync(raw);
  throw new Error(`zip 条目 ${name} 用了不支持的压缩方式 ${entry.method}`);
}

/** 读一个 zip 里的 JSON 条目；条目不存在或不是 JSON 时返回 null */
function readZipJson(buf, dir, name) {
  const raw = readZipEntry(buf, dir, name);
  if (!raw) return null;
  try {
    // Reeden 导出的 JSON 不带 BOM，但真带了也不该整份解析失败
    const text = raw.toString('utf8').replace(/^﻿/, '');
    return JSON.parse(text);
  } catch (err) {
    throw new Error(`解析 ${name} 失败：${err.message}`);
  }
}

/* ========================================================================== *
 * 小工具
 * ========================================================================== */

/** 把图片字节的魔数认成 MIME —— 服务端的封面接口只接受四种位图 */
function detectImageMime(buf) {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 8 && buf.readUInt32BE(0) === 0x89504e47) return 'image/png';
  if (buf.length >= 6 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
    return 'image/webp';
  }
  if (buf.length >= 6 && buf.toString('ascii', 0, 3) === 'GIF') return 'image/gif';
  return null;
}

/**
 * read_record 的 create_at 是 UTC，而 Reeden 的 date/hour 是本地时间。
 * 按 offset 换算成「本地日期 + 本地小时」。
 */
function toLocal(dateUtc, offsetHours) {
  const shifted = new Date(dateUtc.getTime() + offsetHours * 3600_000);
  return {
    day: shifted.toISOString().slice(0, 10),
    hour: shifted.getUTCHours(),
  };
}

function parseTime(value) {
  if (!value) return null;
  // "2026-05-07 07:16:47"（UTC，无时区后缀）与带 Z 的 ISO 都要认
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)
    ? `${value.replace(' ', 'T')}Z`
    : value;
  const at = new Date(normalized);
  return Number.isNaN(at.getTime()) ? null : at;
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

/* ========================================================================== *
 * 数据整理
 * ========================================================================== */

/**
 * 汇总阅读时长。
 *
 * 返回 Map<bookId(小写), Map<day, Map<hour, seconds>>>。
 * hourly 覆盖到的 (书, 日期) 一律用 hourly；其余用 read_record 归到开始的那一小时。
 */
function collectSessions(hourly, records, offsetHours) {
  const byBook = new Map();
  const hourlyDays = new Set();

  const put = (bookId, day, hour, seconds) => {
    if (!bookId || !day || seconds <= 0) return;
    const id = String(bookId).toLowerCase();
    if (!byBook.has(id)) byBook.set(id, new Map());
    const days = byBook.get(id);
    if (!days.has(day)) days.set(day, new Map());
    const hours = days.get(day);
    hours.set(hour, (hours.get(hour) ?? 0) + seconds);
  };

  for (const row of Array.isArray(hourly) ? hourly : []) {
    const day = row?.date;
    const hour = Number(row?.hour);
    if (!day || !Number.isFinite(hour)) continue;
    hourlyDays.add(`${String(row.book_id).toLowerCase()}|${day}`);
    put(row.book_id, day, Math.max(0, Math.min(23, hour)), Number(row.read_seconds) || 0);
  }

  for (const row of Array.isArray(records) ? records : []) {
    const id = String(row?.book_id ?? '').toLowerCase();
    const at = parseTime(row?.create_at);
    if (!id || !at) continue;

    const local = toLocal(at, offsetHours);
    // hourly 已经有这一天就跳过：两边是同一批数据，相加会翻倍
    if (hourlyDays.has(`${id}|${local.day}`)) continue;
    put(id, local.day, local.hour, Number(row.read_seconds) || 0);
  }

  return byBook;
}

/** 一本书的进度：取两个来源里 lastReadTime 较新的 */
function pickProgress(progressFile, bookMeta) {
  const candidates = [];
  if (progressFile) {
    candidates.push({
      at: parseTime(progressFile.lastReadTime),
      // readProgress 是 0-10000（8618 = 86.18%）
      percentage: Number(progressFile.readProgress) / 10000,
      position: {
        section: progressFile.sectionIndex,
        paragraph: progressFile.paragraphIndex,
        element: progressFile.elementIndex,
      },
      deviceId: progressFile.deviceId,
    });
  }
  if (bookMeta) {
    candidates.push({
      at: parseTime(bookMeta.last_read_time),
      percentage: Number(bookMeta.read_progress) / 10000,
      position: {
        section: bookMeta.last_read_section_index,
        paragraph: bookMeta.last_read_para_index,
        element: bookMeta.last_read_element_index,
      },
      deviceId: null,
    });
  }

  const valid = candidates.filter((c) => Number.isFinite(c.percentage));
  if (valid.length === 0) return null;

  valid.sort((a, b) => (b.at?.getTime() ?? 0) - (a.at?.getTime() ?? 0));
  const best = valid[0];
  return {
    ...best,
    percentage: Math.max(0, Math.min(1, best.percentage)),
  };
}

/** 位置串：服务端只做字符串存储，这里存成可读、可解析的形式便于排查 */
function positionString(position) {
  if (!position) return '';
  return `section=${position.section ?? 0},paragraph=${position.paragraph ?? 0},element=${position.element ?? 0}`;
}

/* ========================================================================== *
 * 插件入口
 * ========================================================================== */

/* ========================================================================== *
 * 数据源连接
 * ========================================================================== */

/** 把插件配置里的连接信息拼成内核要的 { driver, config } */
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
        // 两种寻址方式必须一致，否则会出现「签名用的 host 与实际请求的不一样」
        addressingStyle: pathStyle ? 'path' : 'virtual-host',
      },
    };
  }

  if (driver === 'local') {
    return {
      driver: 'local',
      config: {
        // 本地驱动的 path 是**相对**服务器存储目录的，绝对路径会被沙箱拒绝
        path: String(cfg.localPath || 'reeden').trim() || 'reeden',
        quotaBytes: 0,
      },
    };
  }

  throw new Error('请选择「连接方式」（WebDAV / S3 / 本地目录），或改用「复用已有存储」');
}

/**
 * 按配置打开读取器。
 *
 * 每次导入都重新建：用户改完连接信息就能立刻生效，不必重启服务 ——
 * 与 ctx.getUserConfig() 每次回库读取是同一个考虑。
 *
 * `storage` 是**绑定到某个用户**的那份（`ctx.forUser(userId).storage`）：
 * 选「复用已有存储」时只能填到自己的存储，填别人的 ID 会被内核拒绝。
 */
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

export async function register(ctx) {
  /**
   * 跑一次完整导入（所有配置过的用户各跑一遍）。
   *
   * 某个用户配置有问题（网盘连不上、路径填错）时，只跳过他自己 —— 一次导入里
   * 别人是别人的事，不该被连累。
   */
  async function runImport() {
    const userIds = await ctx.usersWithConfig();
    if (userIds.length === 0) {
      ctx.log.info('还没有用户配置过自己的 Reeden 数据源，跳过（请在「设置 → 插件」里配置）');
      return { users: 0, skippedUsers: 0 };
    }

    const totals = { users: 0, skippedUsers: 0, books: 0, created: 0, progress: 0, sessionRows: 0 };
    for (const userId of userIds) {
      try {
        const cfg = await ctx.getUserConfig(userId);
        const report = await runImportFor(userId, cfg);
        totals.users += 1;
        totals.books += report.books;
        totals.created += report.created;
        totals.progress += report.progress;
        totals.sessionRows += report.sessionRows ?? 0;
      } catch (err) {
        totals.skippedUsers += 1;
        ctx.log.error(`用户 #${userId} 的导入失败，已跳过该用户`, {
          userId,
          error: String(err?.message ?? err),
        });
      }
    }

    ctx.log.info(
      `本轮导入完成：成功 ${totals.users} 个账号，跳过 ${totals.skippedUsers} 个；` +
        `书 ${totals.books}（新登记 ${totals.created}），进度 ${totals.progress}，时长 ${totals.sessionRows} 段`,
    );
    return totals;
  }

  /**
   * 单个用户的一次完整导入。
   *
   * `api` 是绑定到这个用户的写入入口（`ctx.forUser`），`cfg` 是他自己那份配置 ——
   * 两者都由函数签名带进来，函数体里拿不到「别的用户」，也就不存在写错账号的可能。
   *
   * 幂等的关键：进度走服务端的 upsert（同一 document 只保留最新），
   * 时长按天替换（importSessions 先删后写）。所以重复跑不会累积。
   */
  async function runImportFor(userId, cfg) {
    const api = ctx.forUser(userId);
    const source = await openSource(api.storage, cfg);

    // 连接信息与 Reeden 根目录都在用户自己那份配置里 —— 外部数据源的位置本来就该由它自己说
    const root = asPrefix(cfg.rootPath);
    const progressDir = String(cfg.progressDir || 'book_progress').replace(/\/+$/, '');
    const offsetHours = Number.isFinite(Number(cfg.utcOffsetHours)) ? Number(cfg.utcOffsetHours) : 8;
    const platform = 'reeden';

    // ---- 1) metadata ----
    const metadataKey = joinKey(root, 'metadata');
    const metadataStat = await source.stat(metadataKey);
    if (!metadataStat) {
      throw new Error(`找不到 ${metadataKey} —— 请确认「Reeden 根目录」填对了`);
    }
    const metadataBuf = Buffer.from(await source.get(metadataKey));
    const metadataDir = readZipDirectory(metadataBuf);

    const bookList = readZipJson(metadataBuf, metadataDir, 'book.json') ?? [];
    const hourly = readZipJson(metadataBuf, metadataDir, 'read_record_hourly.json') ?? [];
    const records = readZipJson(metadataBuf, metadataDir, 'read_record.json') ?? [];

    // ---- 2) 每本书的进度文件 ----
    const progressFiles = new Map();
    try {
      const entries = await source.list(joinKey(root, progressDir));
      for (const entry of entries) {
        if (entry.isDir || !entry.name.endsWith('.json')) continue;
        const bookId = entry.name.slice(0, -'.json'.length).toLowerCase();
        try {
          const raw = Buffer.from(await source.get(entry.path));
          progressFiles.set(bookId, JSON.parse(raw.toString('utf8')));
        } catch (err) {
          // 单个坏文件不该让整次导入失败
          ctx.log.warn(`读取进度文件 ${entry.path} 失败，已跳过`, { userId, error: String(err) });
        }
      }
    } catch (err) {
      ctx.log.warn(`目录 ${progressDir} 读不到（可能这一版 Reeden 用的是别的名字）`, {
        userId,
        error: String(err),
      });
    }

    const sessionsByBook = collectSessions(hourly, records, offsetHours);
    const metaById = new Map();
    for (const book of Array.isArray(bookList) ? bookList : []) {
      if (!book?.id || Number(book.is_deleted) === 1) continue;
      metaById.set(String(book.id).toLowerCase(), book);
    }

    /*
     * 要处理的书 = 有元数据的 ∪ 有进度文件的 ∪ 有时长记录的。
     * 只看元数据会漏掉「书已从 Reeden 库中移除但进度文件还在」的情况。
     */
    const allIds = new Set([...metaById.keys(), ...progressFiles.keys(), ...sessionsByBook.keys()]);

    // ---- 3) 逐本导入 ----
    const report = { books: 0, created: 0, progress: 0, sessions: 0, covers: 0, skipped: 0 };
    const days = new Map(); // day → [{hour, seconds, bookId, document}]
    const coverJobs = [];

    for (const bookId of allIds) {
      const meta = metaById.get(bookId);
      const title = meta?.title || `Reeden 书籍 ${bookId.slice(0, 8)}`;

      let book = null;
      if (cfg.autoRegisterBooks !== false) {
        book = await api.sync.ensureBook({
          title,
          md5: bookId,
          documentId: bookId,
          ...(meta?.author ? { author: meta.author } : {}),
          format: typeof meta?.type === 'string' ? meta.type.toLowerCase() : 'epub',
          size: Number(meta?.size) || 0,
          ...(Number(meta?.word_count) > 0 ? { totalWords: Number(meta.word_count) } : {}),
          ...(typeof meta?.description === 'string' && meta.description
            ? { description: meta.description }
            : {}),
          tags: ['Reeden'],
        });
        if (book.created) {
          report.created += 1;
          // 封面只给刚建的书设：不覆盖用户自己传的封面
          if (cfg.importCovers !== false && (meta?.cover_thumb || meta?.cover_url)) {
            coverJobs.push({ book: book.id, hash: String(meta.cover_thumb || meta.cover_url) });
          }
        }
      } else {
        book = await api.sync.findBook({ documentId: bookId });
        if (!book) {
          report.skipped += 1;
          continue;
        }
      }

      report.books += 1;

      // 进度
      const picked = pickProgress(progressFiles.get(bookId), meta);
      if (picked) {
        const result = await api.sync.pushProgress({
          document: bookId,
          title,
          progress: positionString(picked.position),
          percentage: picked.percentage,
          platform,
          device: 'Reeden',
          deviceId: picked.deviceId || 'reeden',
          ...(picked.at ? { clientTime: picked.at.toISOString() } : {}),
        });
        if (result.accepted) report.progress += 1;
      }

      // 时长（先攒起来，最后按天一次性替换 —— 服务端是按「账号 + 平台 + 天」替换的，
      // 一本书一本书地调用会把别的书在同一天的数据删掉）
      const bookSessions = sessionsByBook.get(bookId);
      if (bookSessions && cfg.importReadingTime !== false) {
        for (const [day, hours] of bookSessions) {
          if (!days.has(day)) days.set(day, []);
          for (const [hour, seconds] of hours) {
            days.get(day).push({ hour, seconds, bookId: book.id, document: bookId });
            report.sessions += 1;
          }
        }
      }
    }

    // ---- 4) 时长：按天替换 ----
    if (days.size > 0) {
      /*
       * 上游删掉的天要一起清掉，否则本地会留着已经不存在的数据。
       * 记着上次导入过哪些天，这次没出现的天用「空小时表」送过去即被清空。
       */
      const importedKey = `importedDays:${userId}`;
      const imported = (await ctx.pluginData.get(importedKey)) ?? [];
      for (const day of Array.isArray(imported) ? imported : []) {
        if (!days.has(day)) days.set(day, []);
      }

      const payload = [...days.entries()].map(([day, hours]) => ({ day, hours }));
      const result = await api.sync.importSessions({ platform, device: 'Reeden', days: payload });
      report.sessionRows = result.inserted;

      await ctx.pluginData.set(
        importedKey,
        // 只留最近的若干天：这个列表只用来发现「上游删了哪一天」，不必永久保存
        [...days.keys()].sort().slice(-500),
      );
    }

    // ---- 5) 封面 ----
    if (coverJobs.length > 0) {
      const coversKey = joinKey(root, 'covers');
      try {
        const coversBuf = Buffer.from(await source.get(coversKey));
        const coversDir = readZipDirectory(coversBuf);
        for (const job of coverJobs) {
          // book.json 里的 cover_thumb 是 covers zip 里的条目名（形如 <hash>.thumb）
          const candidates = [`${job.hash}.thumb`, job.hash];
          let raw = null;
          for (const name of candidates) {
            raw = readZipEntry(coversBuf, coversDir, name);
            if (raw) break;
          }
          if (!raw) continue;

          const mime = detectImageMime(raw);
          if (!mime) continue;
          await api.sync.setCover({ book: job.book, mime, dataBase64: raw.toString('base64') });
          report.covers += 1;
        }
      } catch (err) {
        ctx.log.warn('读取封面失败（不影响进度与时长）', { userId, error: String(err) });
      }
    }

    /*
     * `lastRun:<用户id>` 是内核与插件之间的约定：用户自助页面上那句
     * 「上次运行：… · 导入 N 条记录」就是从这里读出来渲染的。
     */
    await ctx.pluginData.set(`lastRun:${userId}`, {
      at: new Date().toISOString(),
      message: `书 ${report.books} 本（新登记 ${report.created}），进度 ${report.progress} 条，时长 ${report.sessionRows ?? 0} 段`,
      ...report,
    });

    ctx.log.info(
      `用户 #${userId} 导入完成：书 ${report.books}（新登记 ${report.created}），` +
        `进度 ${report.progress}，时长 ${report.sessionRows ?? 0} 段，封面 ${report.covers}，跳过 ${report.skipped}`,
      { userId },
    );
    return report;
  }

  /** 手动/定时都走这里：错误只记日志，不让定时器炸掉 */
  async function safeRun(reason) {
    try {
      await runImport();
    } catch (err) {
      ctx.log.error(`导入失败（${reason}）`, { error: String(err?.message ?? err) });
    }
  }

  // ---- 定时任务 ----
  // 注册时读一次用于排定时器；真正的导入每次都重新读配置，改完即时生效
  const initialCfg = ctx.getConfig();
  const intervalMinutes = Number(initialCfg.intervalMinutes);
  // 0 表示只手动跑：任务仍然注册（管理页能用 CLI 触发），但不排定时器
  ctx.schedule('sync', Number.isFinite(intervalMinutes) && intervalMinutes > 0 ? intervalMinutes : 0, () =>
    safeRun('定时'),
  );

  /*
   * 每日补一次。
   *
   * 为什么需要它：Reeden 的 read_record 会被轮转/备份，某一天的数据可能在次日
   * 就不再出现在 metadata 里了。当天结束前再抓一次，能把这些数据留住。
   *
   * 实现用「每分钟看一眼表」而不是排到那个时刻：这样管理员改完 dailyAt 立刻
   * 生效。用上次执行的日期去重，避免同一分钟内重复触发。
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

      await safeRun('每日补同步');
    });
  }

  ctx.log.info(
    `已就绪：每 ${intervalMinutes > 0 ? `${intervalMinutes} 分钟` : '（关闭，仅手动）'}` +
      `${dailyAt ? `，每日 ${dailyAt} 补同步` : ''}`,
  );
}

export function unregister() {
  // 定时器由宿主负责清理（loader 的 clearSchedules），这里什么都不用做
}
