import { and, eq } from 'drizzle-orm';
import {
  localStorageConfigSchema,
  s3ConfigSchema,
  webdavConfigSchema,
  type PluginBookInput,
  type PluginProgressPush,
  type PluginSessionImport,
  type PluginStorageConnection,
  type PluginStorageEntry,
  type PluginUserScope,
} from '@readsync/shared';
import { getDb } from '../../db/index.js';
import { books, pluginData, readingSessions, storages, users } from '../../db/schema.js';
import { badRequest, forbidden, notFound } from '../../errors.js';
import { addDocumentId, findBookByDocumentId, normalizeDocumentId } from '../library/documents.js';
import { createBook } from '../library/service.js';
import { saveBookCover } from '../library/cover.js';
import { BROWSE_SCAN_LIMIT, browseStorage, getAdapterForStorage } from '../storage/service.js';
import { createAdapter } from '../storage/adapters/registry.js';
import type { StorageAdapter } from '../storage/types.js';
import { upsertProgress } from '../sync/service.js';
import { getModuleLogger } from '../../logger.js';

/**
 * 插件需要用到的宿主能力。
 *
 * 为什么单独一个模块：`loader.ts` 负责生命周期（加载/卸载/钩子），这里负责
 * 「插件能对数据做什么」。两者的失败模式完全不同 —— 前者错了插件加载不起来，
 * 后者错了会写坏用户数据，所以边界要划清楚。
 *
 * 设计原则：
 *  - **插件不碰数据库**。它拿到的是几个语义明确的动作（推一条进度、按天替换
 *    会话、登记一本书），写入路径与网页端完全共用同一批函数 —— 冲突判定、
 *    书目关联、冗余字段回写都不会因为「这次是插件写的」而不一致。
 *  - **权限真的生效**。未声明对应权限时给出的是抛错的桩，而不是静默空实现。
 */

const log = getModuleLogger('plugins');

/** 会话时长上限：与同步接口的 readingSeconds 约定一致（一天） */
const MAX_SESSION_SECONDS = 86400;

/** 批量导入时的天数上限，防止插件一次塞进几万天把库撑爆 */
const MAX_IMPORT_DAYS = 4000;

/**
 * 把用户名或 id 解析成用户 id。
 *
 * 导入类插件面向的是「某个账号的书库」，配置里写用户名比写 id 友好得多
 * （用户名一眼能认，id 得去数据库里查）。两种都接受。
 */
function resolveUserId(user: string | number): number {
  if (typeof user === 'number' || /^\d+$/.test(String(user))) {
    const id = Number(user);
    const row = getDb().select({ id: users.id }).from(users).where(eq(users.id, id)).get();
    if (!row) throw notFound(`用户 id ${id} 不存在`);
    return row.id;
  }

  const name = String(user).trim();
  // 用户名与邮箱都试一遍：配置里填哪个都能对上
  const row = getDb()
    .select({ id: users.id })
    .from(users)
    .where(eq(users.username, name))
    .get();
  if (row) return row.id;

  const byEmail = getDb().select({ id: users.id }).from(users).where(eq(users.email, name)).get();
  if (!byEmail) throw notFound(`找不到用户「${name}」（用户名或邮箱都可以填）`);
  return byEmail.id;
}

/** `YYYY-MM-DD` → 星期几（0=周日）。日期按 UTC 解析只是取一个不随服务器时区漂移的星期 */
function weekdayOf(day: string): number {
  const parsed = new Date(`${day}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) throw badRequest(`日期格式应为 YYYY-MM-DD，收到「${day}」`);
  return parsed.getUTCDay();
}

/** `YYYY-MM-DD` + 小时 → 时刻（按 UTC 构造，仅用于会话起止的展示与排序） */
function hourStart(day: string, hour: number): Date {
  return new Date(`${day}T${String(Math.max(0, Math.min(23, hour))).padStart(2, '0')}:00:00Z`);
}

export interface HostApiPermissions {
  pluginData: boolean;
  fsStorage: boolean;
  syncWrite: boolean;
  booksWrite: boolean;
}

/** 权限未声明时统一的报错文案：告诉作者去清单里加哪一项 */
function denied(pluginId: string, permission: string, what: string): Error {
  return new Error(
    `插件 ${pluginId} 未声明 ${permission} 权限，禁止${what}（请在 plugin.json 的 permissions 中加入 "${permission}"）`,
  );
}

/* ------------------------------ plugin_data ------------------------------ */

export function buildPluginDataApi(pluginId: string, allowed: boolean) {
  const guard = (): void => {
    if (!allowed) throw denied(pluginId, 'db:plugin', '读写插件数据');
  };

  return {
    async get<T = unknown>(key: string): Promise<T | undefined> {
      guard();
      const row = getDb()
        .select({ value: pluginData.value })
        .from(pluginData)
        .where(and(eq(pluginData.pluginId, pluginId), eq(pluginData.key, key)))
        .get();
      return row?.value as T | undefined;
    },
    async set(key: string, value: unknown): Promise<void> {
      guard();
      const now = new Date();
      getDb()
        .insert(pluginData)
        .values({ pluginId, key, value, updatedAt: now })
        .onConflictDoUpdate({
          target: [pluginData.pluginId, pluginData.key],
          set: { value, updatedAt: now },
        })
        .run();
    },
    async delete(key: string): Promise<void> {
      guard();
      getDb()
        .delete(pluginData)
        .where(and(eq(pluginData.pluginId, pluginId), eq(pluginData.key, key)))
        .run();
    },
    async all(): Promise<Record<string, unknown>> {
      guard();
      const rows = getDb()
        .select({ key: pluginData.key, value: pluginData.value })
        .from(pluginData)
        .where(eq(pluginData.pluginId, pluginId))
        .all();
      const out: Record<string, unknown> = {};
      for (const row of rows) out[row.key] = row.value;
      return out;
    },
  };
}

/* -------------------------------- storage -------------------------------- */

/**
 * 把适配器包成「绑定好位置」的只读读取器。
 *
 * 列目录有两条路：绑定到已有存储时用 browseStorage（它能把扁平的对象列表收敛成
 * 一层目录）；自带连接时没有存储行可用，就地做同样的收敛。
 */
function bindReader(adapter: StorageAdapter, browse?: () => Promise<PluginStorageEntry[]>) {
  return {
    async list(prefix = ''): Promise<PluginStorageEntry[]> {
      if (browse) return browse();

      /*
       * 适配器的 list 是扁平的（S3 风格，没有目录概念），这里收敛成一层：
       * 只保留 prefix 之下、再往下一级为止的条目，目录以 / 结尾 ——
       * 与「存储管理」里看到的样子保持一致。
       */
      const listed = await adapter.list({ prefix, limit: BROWSE_SCAN_LIMIT });
      const byName = new Map<string, PluginStorageEntry>();
      for (const object of listed.objects) {
        const rest = object.key.slice(prefix.length);
        if (!rest) continue;
        const slash = rest.indexOf('/');
        if (slash === -1) {
          byName.set(rest, { name: rest, path: object.key, isDir: false, size: object.size ?? null });
        } else {
          const dir = rest.slice(0, slash + 1);
          byName.set(dir, { name: dir, path: `${prefix}${dir}`, isDir: true, size: null });
        }
      }
      return [...byName.values()];
    },

    async get(key: string): Promise<Uint8Array> {
      const result = await adapter.get(key);
      if (!result.stream) throw new Error(`读取 ${key} 失败：存储返回了空内容`);
      // 适配器可能给 Buffer 也可能给 string（带了编码时），两种都要能吃下
      const chunks: Buffer[] = [];
      for await (const chunk of result.stream as AsyncIterable<Buffer | string>) {
        chunks.push(typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk);
      }
      return Buffer.concat(chunks);
    },

    async stat(key: string): Promise<{ size: number } | null> {
      const object = await adapter.stat(key);
      return object ? { size: object.size } : null;
    },

    async getRange(key: string, offset: number, length: number): Promise<Uint8Array | null> {
      if (!adapter.getRange) throw new Error('该存储后端不支持范围读');
      return adapter.getRange(key, offset, length);
    },
  };
}

/**
 * 用插件自己声明的连接参数建适配器。
 *
 * 校验交给 shared 里那套与「存储管理」完全相同的 schema —— 插件不该自己解析
 * 连接参数：漏掉一项校验就等于开了目录穿越（本地驱动）或错配密钥的口子。
 */
function adapterFromConnection(connection: PluginStorageConnection): StorageAdapter {
  const driver = String(connection.driver ?? '').trim();
  if (!driver) throw badRequest('存储连接缺少 driver');

  const config = connection.config ?? {};
  if (driver === 'local') {
    return createAdapter('local', localStorageConfigSchema.parse(config) as Record<string, unknown>);
  }
  if (driver === 'webdav') {
    return createAdapter('webdav', webdavConfigSchema.parse(config) as Record<string, unknown>);
  }
  if (driver === 's3') {
    return createAdapter('s3', s3ConfigSchema.parse(config) as Record<string, unknown>);
  }
  // 插件自己提供的驱动：配置由那个插件负责校验
  return createAdapter(driver, config);
}

export function buildStorageApi(pluginId: string, allowed: boolean, boundUserId?: number) {
  const guard = (): void => {
    if (!allowed) throw denied(pluginId, 'fs:storage', '读取存储后端');
  };

  /*
   * 两种取法都不接受「随便传个 storageId」：一个是插件配置里的连接参数，
   * 另一个是「存储管理」里已经配好的存储行（归属以该行自己的 ownerId 为准）。
   * 插件拿不到账号列表，也就翻不到别人的网盘。
   */
  const ownerOf = (storageId: number): number => {
    const row = getDb()
      .select({ ownerId: storages.userId })
      .from(storages)
      .where(eq(storages.id, storageId))
      .get();
    if (!row) throw notFound(`存储 #${storageId} 不存在`);
    return row.ownerId;
  };

  /**
   * 这次访问的存储归谁。
   *
   * 绑定用户（按用户跑任务）时只认那个用户自己的存储：用户在自己配置里填的
   * 「存储 ID」不过是个数字，若不校验，A 填上 B 的存储 ID 就能读 B 的网盘。
   */
  const assertAccess = (storageId: number, ownerId: number, requested?: number): void => {
    if (boundUserId !== undefined) {
      if (ownerId !== boundUserId) {
        throw forbidden(`存储 #${storageId} 不属于当前用户，拒绝访问`);
      }
      return;
    }
    if (requested !== undefined && ownerId !== requested) {
      throw forbidden(`存储 #${storageId} 不属于用户 #${requested}，拒绝访问`);
    }
  };

  return {
    /**
     * 用插件自己的连接参数连过去。
     *
     * 这是给「外部数据源」用的：Reeden 的同步目录、别的阅读器的数据目录，
     * 通常与书籍文件存储不是同一个地方，不该逼用户为它在「存储管理」里建条目。
     */
    async connect(connection: PluginStorageConnection) {
      guard();
      if (!connection || typeof connection !== 'object') {
        throw badRequest('connect() 需要一个 { driver, config } 对象');
      }

      const adapter = adapterFromConnection(connection);
      // 连不上时立刻报出来，而不是等到读第一个文件才失败
      const probe = await adapter.test();
      if (!probe.ok) throw badRequest(`存储连接不可用：${probe.message}`);
      return bindReader(adapter);
    },

    /**
     * 复用「存储管理」里已配好的某条存储。
     *
     * `ownerUserId` 是给**站点级**插件用的归属声明；绑定用户之后该参数不再需要
     * （绑定本身就限定了属主），传了也只会被拿去校验。
     */
    async forStorage(storageId: number, ownerUserId?: number) {
      guard();
      const ownerId = ownerOf(storageId);
      assertAccess(storageId, ownerId, ownerUserId);
      const adapter = await getAdapterForStorage(storageId, ownerId);
      return bindReader(adapter, async () => {
        const result = await browseStorage(storageId, ownerId, { prefix: '' });
        return result.entries.map((entry) => ({
          name: entry.name,
          path: entry.path,
          isDir: entry.isDir,
          size: entry.size ?? null,
        }));
      });
    },
  };
}

/* --------------------------------- sync ---------------------------------- */

/** 写入类入参：绑定用户后 `user` 就不该出现，因此内部一律按可空处理 */
type WithOptionalUser<T extends { user: unknown }> = Omit<T, 'user'> & { user?: string | number };

export function buildSyncApi(
  pluginId: string,
  syncAllowed: boolean,
  booksAllowed: boolean,
  /** 绑定到这个用户之后，写入再也不能指定别的账号（`ctx.forUser()` 用） */
  boundUserId?: number,
) {
  const guardSync = (): void => {
    if (!syncAllowed) throw denied(pluginId, 'sync:write', '写入阅读数据');
  };
  const guardBooks = (): void => {
    if (!booksAllowed) throw denied(pluginId, 'books:write', '登记书目');
  };

  /**
   * 这次写入落到哪个账号。
   *
   * 这是「用户在自己配置里填上别人的用户名，就能把数据导进别人的账号」那道口子
   * 的封堵点。绑定之后正常路径下插件**给不出** `user`（类型里就没有这个字段），
   * 这里再拦一道：万一插件（多半是被改过的旧版本）传了别的用户，直接拒绝。
   */
  const targetUser = (user?: string | number): number => {
    if (boundUserId === undefined) {
      if (user === undefined || user === null || String(user).trim() === '') {
        throw badRequest('必须指定 user（用户名或用户 id）');
      }
      return resolveUserId(user);
    }

    if (user !== undefined && user !== null && String(user).trim() !== '') {
      const requested = resolveUserId(user);
      if (requested !== boundUserId) {
        throw forbidden(
          `插件已绑定到用户 #${boundUserId}，不能写入其它账号（收到 #${requested}）`,
        );
      }
    }
    return boundUserId;
  };

  return {
    async pushProgress(input: WithOptionalUser<PluginProgressPush>): Promise<{ accepted: boolean }> {
      guardSync();
      if (!/^[a-fA-F0-9]{32}$/.test(input.document)) {
        throw badRequest(`document 必须是 32 位十六进制，收到「${input.document}」`);
      }

      const userId = targetUser(input.user);
      // 复用统一同步接口的写入逻辑：冲突判定、书目关联、冗余字段回写全都一致
      const result = upsertProgress(userId, {
        document: input.document.toLowerCase(),
        percentage: input.percentage,
        progress: input.progress ?? '',
        platform: input.platform ?? 'import',
        device: input.device ?? 'import',
        deviceId: input.deviceId ?? 'import',
        // 时长走 importSessions，避免同一天的数据被算两遍
        readingSeconds: 0,
        ...(input.title ? { title: input.title } : {}),
        ...(input.clientTime ? { clientTime: input.clientTime } : {}),
      });

      return { accepted: result.accepted };
    },

    async importSessions(
      input: WithOptionalUser<PluginSessionImport>,
    ): Promise<{ days: number; inserted: number }> {
      guardSync();
      if (!input.platform) throw badRequest('platform 不能为空');
      if (input.days.length > MAX_IMPORT_DAYS) {
        throw badRequest(`一次最多导入 ${MAX_IMPORT_DAYS} 天，收到 ${input.days.length} 天`);
      }

      const userId = targetUser(input.user);
      const db = getDb();
      const device = input.device || 'import';
      let inserted = 0;
      let days = 0;

      for (const day of input.days) {
        const weekday = weekdayOf(day.day);
        /*
         * 先删后写：导入会被反复重跑（定时任务），累加会把时长越滚越多。
         * 删的范围严格限定在「这个账号 + 这个 platform + 这一天」，动不到
         * 用户在网页端或阅读器上报的数据（那些用的是别的 platform）。
         */
        db.delete(readingSessions)
          .where(
            and(
              eq(readingSessions.userId, userId),
              eq(readingSessions.platform, input.platform),
              eq(readingSessions.day, day.day),
            ),
          )
          .run();
        days += 1;

        for (const entry of day.hours) {
          const seconds = Math.max(0, Math.min(Math.round(entry.seconds), MAX_SESSION_SECONDS));
          if (seconds === 0) continue;

          const at = hourStart(day.day, entry.hour);
          db.insert(readingSessions)
            .values({
              userId,
              bookId: entry.bookId ?? null,
              document: entry.document ?? null,
              platform: input.platform,
              device,
              seconds,
              day: day.day,
              hour: Math.max(0, Math.min(23, Math.round(entry.hour))),
              weekday,
              progressPercent: null,
              startedAt: at,
              endedAt: at,
              createdAt: at,
            })
            .run();
          inserted += 1;
        }
      }

      log.info({ pluginId, userId, days, inserted }, '插件导入阅读会话完成');
      return { days, inserted };
    },

    async findBook(
      input: WithOptionalUser<{ user: string | number; documentId: string }>,
    ): Promise<{ id: number } | null> {
      guardBooks();
      const userId = targetUser(input.user);
      const documentId = normalizeDocumentId(input.documentId);
      // 主标识与补充标识都要查：书可能是网页端手工登记的，也可能由导入建的
      const id = findBookByDocumentId(userId, documentId);
      return id === null ? null : { id };
    },

    async ensureBook(input: WithOptionalUser<PluginBookInput>): Promise<{ id: number; created: boolean }> {
      guardBooks();
      const userId = targetUser(input.user);
      const md5 = input.md5.toLowerCase();
      if (!/^[a-f0-9]{32}$/.test(md5)) {
        throw badRequest(`md5 必须是 32 位十六进制，收到「${input.md5}」`);
      }

      /*
       * 先按文档标识找。这一步不能省：用户完全可能已经把这本书手工登记进
       * 书库（标识填的就是外部书库的 bookId），只是 md5 用的是别的值 ——
       * 那时按 md5 找不到，再去建就会撞上「标识已被占用」而整次导入失败。
       */
      if (input.documentId) {
        const byDocument = findBookByDocumentId(userId, normalizeDocumentId(input.documentId));
        if (byDocument !== null) return { id: byDocument, created: false };
      }

      // 再看 md5（同一账号下唯一）
      const existing = getDb()
        .select({ id: books.id })
        .from(books)
        .where(and(eq(books.ownerId, userId), eq(books.md5, md5)))
        .get();
      if (existing) return { id: existing.id, created: false };

      const documentId = input.documentId ? normalizeDocumentId(input.documentId) : undefined;
      const detail = await createBook(userId, {
        title: input.title,
        ...(input.author ? { author: input.author } : {}),
        format: (input.format ?? 'epub') as never,
        size: input.size ?? 0,
        md5,
        // 只登记书目：不传 objectKey，服务端不会去找文件
        ...(documentId ? { documentId } : {}),
        ...(input.totalWords ? { totalWords: input.totalWords } : {}),
        ...(input.tags ? { tags: input.tags } : {}),
        ...(input.description ? { description: input.description } : {}),
      } as never);

      // 外部书库的 bookId 与「主标识」可能是两个值：都把外部 id 挂成补充标识，
      // 这样设备上报任一个都能对上
      if (documentId && documentId !== normalizeDocumentId(input.md5)) {
        try {
          addDocumentId(userId, detail.id, input.md5, '外部书库');
        } catch {
          // 冲突（这个 md5 已属于别的书）不该让整次导入失败
          log.warn({ pluginId, bookId: detail.id }, '补充标识失败，已跳过');
        }
      }

      log.info({ pluginId, userId, bookId: detail.id, title: input.title }, '插件登记书目');
      return { id: detail.id, created: true };
    },

    async setCover(input: { book: number; mime: string; dataBase64: string }): Promise<void> {
      guardBooks();
      const row = getDb()
        .select({ id: books.id, ownerId: books.ownerId })
        .from(books)
        .where(eq(books.id, input.book))
        .get();
      if (!row) throw notFound(`书籍 #${input.book} 不存在`);
      // 封面挂在书上行上，所以这里也得按属主把关：绑定用户后不能给别人的书写封面
      if (boundUserId !== undefined && row.ownerId !== boundUserId) {
        throw forbidden(`书籍 #${input.book} 不属于当前用户，拒绝写入封面`);
      }
      saveBookCover(input.book, input.mime, input.dataBase64, new Date());
    },
  };
}

/* ---------------------------- 绑定到某个用户 ---------------------------- */

/**
 * 构造 `ctx.forUser(userId)`：把写入入口固定到这个账号上。
 *
 * 权限仍按清单授予（未声明 sync:write 的插件绑定后照样写不了），
 * 只是「写给谁」不再由插件决定。
 */
export function buildUserScope(
  pluginId: string,
  userId: number,
  permissions: { syncWrite: boolean; booksWrite: boolean; fsStorage: boolean },
): PluginUserScope {
  return {
    userId,
    sync: buildSyncApi(pluginId, permissions.syncWrite, permissions.booksWrite, userId),
    storage: buildStorageApi(pluginId, permissions.fsStorage, userId),
  };
}
