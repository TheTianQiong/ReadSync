import { and, asc, count, eq } from 'drizzle-orm';
import {
  SENSITIVE_CONFIG_KEYS,
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
    // maskConfig 对密文直接输出 '••••••••'，对明文非敏感字段原样保留
    config: maskConfig(row.config),
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

  const config = input.config as Record<string, unknown>;
  // 写库前先校验配置，避免存进一份永远连不上的配置
  validateStorageConfig(input.driver, config);

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
    validateStorageConfig(existing.driver, merged);
    values.config = encryptConfig(merged);
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

/** 浏览远端目录（「存储管理」页面用） */
export async function browseStorage(
  id: number,
  userId: number,
  options: ListOptions,
): Promise<ListResult> {
  // 适配器抛出的已是可读的 AppError（STORAGE_ERROR / NOT_FOUND），原样向上传递
  const adapter = await getAdapterForStorage(id, userId);
  return adapter.list(options);
}

/** 创建目录；驱动不支持目录概念（对象存储 / 部分插件）时按空操作成功处理 */
export async function mkdirStorage(id: number, userId: number, key: string): Promise<void> {
  if (!key.trim()) throw badRequest('请填写目录名称');
  const adapter = await getAdapterForStorage(id, userId);
  if (!isDirectoryAdapter(adapter)) return;
  await adapter.mkdir(key);
}
