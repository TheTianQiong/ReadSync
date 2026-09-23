import { and, asc, count, eq } from 'drizzle-orm';
import {
  SENSITIVE_CONFIG_KEYS,
  type StorageBrowseEntry,
  type StorageBrowseResult,
  type StorageInput,
  type StorageSummary,
  type StorageTestResult,
} from '@readsync/shared';
import { decryptConfig, encryptConfig, maskConfig } from '../../crypto/secret-box.js';
import { getDb } from '../../db/index.js';
import { books, bookVersions, storages, type StorageRow } from '../../db/schema.js';
import { badRequest, conflict, forbidden, notFound, storageError } from '../../errors.js';
import { getSiteSettings } from '../../lib/settings.js';
import { createAdapter, isDirectoryAdapter, validateStorageConfig } from './adapters/registry.js';
import type { ListOptions, ListResult, StorageAdapter } from './types.js';

/**
 * 存储配置的业务逻辑。
 *
 * 三条不变量：
 *  1. 凭据加密：写库前 encryptConfig()，读取使用前 decryptConfig()，返回前端前 maskConfig()。
 *  2. 归属隔离：所有按 id 的操作都同时匹配 userId，避免越权访问他人存储。
 *  3. 默认唯一：同一用户最多一个 isDefault=true 的存储。
 */

/** 当前用户的最小形状（避免 service 依赖 Fastify 请求对象） */
export interface StorageOwner {
  id: number;
  role: 'admin' | 'user';
}

function toIso(value: Date | null | undefined): string | null {
  return value ? value.toISOString() : null;
}

/** 数据库行 → 对外表示（敏感字段脱敏；密文统一显示为掩码） */
export function toStorageSummary(row: StorageRow): StorageSummary {
  return {
    id: row.id,
    name: row.name,
    driver: row.driver,
    isDefault: row.isDefault,
    readOnly: row.readOnly,
    enabled: row.enabled,
    // 先按驱动 schema 规范化再脱敏。
    // 历史数据里可能存在字符串形式的布尔值（配置页曾把布尔统一 String() 后提交），
    // 若原样返回，前端会把 "false" 当真值渲染，开关显示与实际行为不符。
    // maskConfig 对密文直接输出 '••••••••'，对明文非敏感字段原样保留。
    config: maskConfig(normalizeConfigForRead(row.driver, row.config)),
    lastCheckAt: toIso(row.lastCheckAt),
    lastCheckOk: row.lastCheckOk,
    lastCheckMessage: row.lastCheckMessage,
    usedBytes: row.usedBytes,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** 按 id + 归属查询；不存在时抛 404（不区分「不存在」与「不属于你」，避免探测） */
export function getStorageRow(id: number, userId: number): StorageRow {
  const row = getDb()
    .select()
    .from(storages)
    .where(and(eq(storages.id, id), eq(storages.userId, userId)))
    .get();
  if (!row) throw notFound('存储配置不存在');
  return row;
}

/** 列出当前用户的全部存储（不含明文凭据） */
export function listStorages(userId: number): StorageSummary[] {
  return getDb()
    .select()
    .from(storages)
    .where(eq(storages.userId, userId))
    .orderBy(asc(storages.id))
    .all()
    .map(toStorageSummary);
}

/** 把某用户其它存储的 isDefault 清掉，保证「同一用户只有一个默认」 */
function clearOtherDefaults(userId: number, exceptId?: number): void {
  const db = getDb();
  const rows = db
    .select({ id: storages.id })
    .from(storages)
    .where(and(eq(storages.userId, userId), eq(storages.isDefault, true)))
    .all();
  for (const row of rows) {
    if (exceptId !== undefined && row.id === exceptId) continue;
    db.update(storages).set({ isDefault: false, updatedAt: new Date() })
      .where(eq(storages.id, row.id))
      .run();
  }
}

/**
 * 创建存储配置。
 * allowUserStorage 关闭时仅管理员可创建（站点级开关，见 lib/settings.ts）。
 */
export function createStorage(user: StorageOwner, input: StorageInput): StorageSummary {
  if (!getSiteSettings().allowUserStorage && user.role !== 'admin') {
    throw forbidden('站点已关闭用户自定义存储，请联系管理员');
  }

  // 写库前先校验配置，避免存进一份永远连不上的配置。
  // 必须用返回的规范化结果落库：schema 会做类型转换（表单传来的 "true" → 布尔 true）
  // 与默认值补全，直接存原始输入会让字符串 "false" 在适配器里被当成真值。
  const config = validateStorageConfig(input.driver, input.config as Record<string, unknown>);

  const db = getDb();
  if (input.isDefault) clearOtherDefaults(user.id);

  const row = db
    .insert(storages)
    .values({
      userId: user.id,
      name: input.name,
      driver: input.driver,
      // 凭据必须加密后落库：数据库文件泄露时也不至于直接暴露网盘密码
      config: encryptConfig(config),
      isDefault: input.isDefault,
      readOnly: input.readOnly,
      enabled: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    .returning()
    .get();

  if (!row) throw storageError('创建存储配置失败');
  return toStorageSummary(row);
}

/**
 * 合并配置：敏感字段若为掩码或空值则保留原值。
 *
 * 前端编辑时拿到的是脱敏配置（敏感字段为 '••••••••'）。若直接整体覆盖，
 * 会把掩码字符串当成新密码存进库，用户下次连接必然失败。这里逐字段判断并保留原密文。
 */
function mergeConfig(
  existing: Record<string, unknown>,
  incoming: Record<string, unknown>,
): Record<string, unknown> {
  const isSensitive = (key: string): boolean =>
    SENSITIVE_CONFIG_KEYS.includes(key as (typeof SENSITIVE_CONFIG_KEYS)[number]);

  const isMaskedOrEmpty = (value: unknown): boolean => {
    if (value === undefined || value === null || value === '') return true;
    // 掩码形如 '••••••••' 或 'ab••••cd'，含 '•' 即视为未修改
    return typeof value === 'string' && value.includes('•');
  };

  const out: Record<string, unknown> = { ...existing };
  for (const [key, value] of Object.entries(incoming)) {
    if (isSensitive(key) && isMaskedOrEmpty(value)) continue;
    if (value === undefined) continue;
    out[key] = value;
  }
  return out;
}

/**
 * 展示用的配置规范化。
 *
 * 与 validateStorageConfig 的区别：这里**不抛错**——读路径不该因为一条历史脏数据
 * 就整页打不开，规范化失败时原样返回即可。
 */
function normalizeConfigForRead(
  driver: string,
  config: Record<string, unknown>,
): Record<string, unknown> {
  try {
    return validateStorageConfig(driver, config);
  } catch {
    return config;
  }
}

/** 部分更新存储配置 */
export function updateStorage(
  id: number,
  user: StorageOwner,
  patch: {
    name?: string;
    config?: Record<string, unknown>;
    isDefault?: boolean;
    readOnly?: boolean;
    enabled?: boolean;
  },
): StorageSummary {
  const existing = getStorageRow(id, user.id);
  const db = getDb();

  const values: Partial<StorageRow> = { updatedAt: new Date() };
  if (patch.name !== undefined) values.name = patch.name;
  if (patch.readOnly !== undefined) values.readOnly = patch.readOnly;
  if (patch.enabled !== undefined) values.enabled = patch.enabled;

  if (patch.config !== undefined) {
    const merged = mergeConfig(existing.config, patch.config);
    // 同上：保存规范化后的结果，而不是合并后的原始值
    values.config = encryptConfig(validateStorageConfig(existing.driver, merged));
  }

  if (patch.isDefault === true) {
    clearOtherDefaults(user.id, id);
    values.isDefault = true;
  } else if (patch.isDefault === false) {
    values.isDefault = false;
  }

  const row = db.update(storages).set(values).where(eq(storages.id, id)).returning().get();
  if (!row) throw notFound('存储配置不存在');
  return toStorageSummary(row);
}

/**
 * 删除存储配置。
 * books / book_versions 通过外键 restrict 引用该存储，直接删会触发数据库外键错误，
 * 因此先统计引用数并给出可读的冲突提示，让用户先去迁移书籍。
 */
export function deleteStorage(id: number, userId: number): void {
  const row = getStorageRow(id, userId);
  const db = getDb();

  const bookCount = db.select({ value: count() }).from(books).where(eq(books.storageId, id)).get()?.value ?? 0;
  if (bookCount > 0) {
    throw conflict(`仍有 ${bookCount} 本书使用存储「${row.name}」，请先迁移或删除这些书籍`, { bookCount });
  }

  const versionCount =
    db.select({ value: count() }).from(bookVersions).where(eq(bookVersions.storageId, id)).get()?.value ?? 0;
  if (versionCount > 0) {
    throw conflict(
      `仍有 ${versionCount} 个书籍历史版本引用存储「${row.name}」，请先清理这些版本`,
      { versionCount },
    );
  }

  db.delete(storages).where(eq(storages.id, id)).run();
}

/** 按 id 创建适配器（内部使用，配置已解密） */
export function adapterFromRow(row: StorageRow): StorageAdapter {
  return createAdapter(row.driver, decryptConfig(row.config));
}

/**
 * 取指定存储的适配器；只能访问自己的存储。
 * 注意：不校验 enabled，调用方（如下载/上传）应自行判断是否可用；
 * 「测试连接」需要能测试被禁用的存储，因此这里不拦。
 */
export async function getAdapterForStorage(storageId: number, userId: number): Promise<StorageAdapter> {
  return adapterFromRow(getStorageRow(storageId, userId));
}

/**
 * 取用户的默认存储适配器。
 * 优先 isDefault=true 且启用中的；没有则回退到第一个启用中的存储；
 * 一个都没有时抛 404（不擅自创建本地存储，避免隐式副作用）。
 */
export async function getDefaultAdapter(userId: number): Promise<{ storageId: number; adapter: StorageAdapter }> {
  const db = getDb();
  const row =
    db
      .select()
      .from(storages)
      .where(and(eq(storages.userId, userId), eq(storages.enabled, true), eq(storages.isDefault, true)))
      .get() ??
    db
      .select()
      .from(storages)
      .where(and(eq(storages.userId, userId), eq(storages.enabled, true)))
      .orderBy(asc(storages.id))
      .get();

  if (!row) {
    throw notFound('尚未配置可用的存储后端，请先在「存储管理」中添加');
  }
  return { storageId: row.id, adapter: adapterFromRow(row) };
}

/** 测试连通性并把结果写回数据库 */
export async function testStorage(id: number, userId: number): Promise<StorageTestResult> {
  const row = getStorageRow(id, userId);
  const adapter = adapterFromRow(row);

  const result = await adapter.test();

  getDb()
    .update(storages)
    .set({
      lastCheckAt: new Date(),
      lastCheckOk: result.ok,
      // 截断，避免第三方返回的超长错误信息撑爆列
      lastCheckMessage: result.message.slice(0, 1000),
      updatedAt: new Date(),
    })
    .where(eq(storages.id, id))
    .run();

  return result;
}

/**
 * 浏览目录时向上游扫描的对象数上限。
 *
 * 适配器给的是**扁平**对象列表（S3 风格：只有文件，没有目录概念），要还原出
 * 「这一层有哪些子目录」，必须把它下面所有对象都看一遍才知道。自托管书库通常
 * 是几千个文件量级，一次扫完没有压力；这个上限只是防止有人把存储根指向一个
 * 巨型桶时把内存和上游配额打爆。
 */
const BROWSE_SCAN_LIMIT = 5000;

/**
 * 浏览目录（「存储管理」页面用）。
 *
 * 适配器的 list() 返回扁平对象列表，而界面要的是**一层目录**：
 * 这里把 `books/1/ab/cd.md5.epub` 这样的 key 收敛成根目录下的 `books/` 目录项，
 * 进到 `books/1/` 后再收敛成 `ab/`。没有这一步，界面既显示不出目录，
 * 也没法逐层进入。
 */
export async function browseStorage(
  id: number,
  userId: number,
  options: ListOptions,
): Promise<StorageBrowseResult> {
  // 适配器抛出的已是可读的 AppError（STORAGE_ERROR / NOT_FOUND），原样向上传递
  const adapter = await getAdapterForStorage(id, userId);

  // 统一成「以 / 结尾的前缀」或空串，避免 books 与 books/ 两种写法列出不同结果
  const rawPrefix = (options.prefix ?? '').trim().replace(/^\/+/, '');
  const prefix = rawPrefix === '' ? '' : `${rawPrefix.replace(/\/+$/, '')}/`;

  const listed = await adapter.list({ prefix, limit: BROWSE_SCAN_LIMIT });

  const limit = options.limit && options.limit > 0 ? options.limit : 100;
  const dirNames = new Set<string>();
  const files: StorageBrowseEntry[] = [];

  for (const object of listed.objects) {
    // 适配器可能返回前缀之外的 key（个别驱动忽略 prefix），这里自己再筛一次
    if (!object.key.startsWith(prefix)) continue;
    const rest = object.key.slice(prefix.length);
    if (!rest) continue;

    const slash = rest.indexOf('/');
    if (slash === -1) {
      files.push({
        name: rest,
        path: object.key,
        isDir: false,
        size: object.size,
        lastModified: object.lastModified,
      });
    } else {
      // 只取第一段作为目录名：更深的层级等用户点进去再列
      dirNames.add(rest.slice(0, slash));
    }
  }

  const dirs: StorageBrowseEntry[] = [...dirNames].map((name) => ({
    name,
    path: `${prefix}${name}/`,
    isDir: true,
    size: null,
    lastModified: null,
  }));

  // 目录在前、文件在后，各自按名称排序 —— 与常见文件管理器一致
  dirs.sort((a, b) => a.name.localeCompare(b.name));
  files.sort((a, b) => a.name.localeCompare(b.name));

  const all = [...dirs, ...files];
  return {
    prefix,
    entries: all.slice(0, limit),
    // 上游自己截断过的话，这一层也一定不完整，必须如实告知
    truncated: all.length > limit || listed.truncated,
  };
}

/** 创建目录；驱动不支持目录概念（对象存储 / 部分插件）时按空操作成功处理 */
export async function mkdirStorage(id: number, userId: number, key: string): Promise<void> {
  if (!key.trim()) throw badRequest('请填写目录名称');
  const adapter = await getAdapterForStorage(id, userId);
  if (!isDirectoryAdapter(adapter)) return;
  await adapter.mkdir(key);
}
