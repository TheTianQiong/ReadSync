import { and, eq } from 'drizzle-orm';
import type { PluginConfigField, PluginManifest, UserPluginSummary } from '@readsync/shared';
import { getDb } from '../../db/index.js';
import { pluginData, pluginUserConfig, plugins, users } from '../../db/schema.js';
import { badRequest, forbidden, notFound } from '../../errors.js';
import { safeParseManifest } from './internal.js';
import {
  coerceFieldValue,
  decryptPluginConfig,
  encryptPluginConfig,
  isMaskedValue,
  maskPluginConfig,
  resolvePluginConfig,
} from './plugin-config.js';
import { getModuleLogger } from '../../logger.js';

/**
 * 插件配置里「归用户自己填」的那部分。
 *
 * 背景：插件原本只有一份站点级配置，由管理员在后台填写。对「导入我自己网盘上的
 * 阅读数据」这类插件，这就说不通了 —— 管理员得替每个用户保管网盘凭据，而且
 * 一个插件只能配一份，第二个用户根本没法用。
 *
 * 于是配置分成两种归属（清单里用 `scope` 声明）：
 *  - `site`：管理员填一次，全站共用；
 *  - `user`：**每个用户填自己的**（设置 → 插件）。
 *
 * 两条安全约束值得单独说明：
 *  1. **目标账号不由配置决定。** 导入写进哪个账号由内核给出 userId（见
 *     `ctx.usersWithConfig()`），插件拿到的是 id 而不是「用户填的用户名」——
 *     否则用户只要在自己配置里写上别人的用户名，就能把数据导进别人的账号。
 *  2. **存储按属主校验。** 用户在自己配置里填的存储 ID 必须是他自己的
 *     （`ctx.storage.forStorage(id, userId)`），否则能借别人的存储读别人的网盘。
 */

const log = getModuleLogger('plugins');

/** 声明为「用户自己填」的字段 */
export function userScopedFields(manifest: PluginManifest): PluginConfigField[] {
  return manifest.config.filter((field) => field.scope === 'user');
}

/** 这个插件需不需要用户自己配置（用户自助页面据此列出来） */
export function hasUserScopedFields(manifest: PluginManifest): boolean {
  return userScopedFields(manifest).length > 0;
}

/** 用户必须存在且可用 —— 停用/删除的账号不该再被插件写数据 */
export function requireActiveUser(userId: number): number {
  const row = getDb().select({ status: users.status }).from(users).where(eq(users.id, userId)).get();
  if (!row) throw notFound(`用户 #${userId} 不存在`);
  if (row.status !== 'active') throw forbidden(`用户 #${userId} 已被停用，插件不再处理其数据`);
  return userId;
}

function readRow(pluginId: string, userId: number) {
  return getDb()
    .select()
    .from(pluginUserConfig)
    .where(and(eq(pluginUserConfig.pluginId, pluginId), eq(pluginUserConfig.userId, userId)))
    .get();
}

/** 该用户填过的原始（密文）配置；没填过返回 {} */
function storedUserConfig(pluginId: string, userId: number): Record<string, unknown> {
  return (readRow(pluginId, userId)?.config as Record<string, unknown> | undefined) ?? {};
}

/** 某个插件下已经填过配置的用户 id（按用户跑任务时用来遍历） */
export function listUsersWithConfig(pluginId: string): number[] {
  const rows = getDb()
    .select({ userId: pluginUserConfig.userId })
    .from(pluginUserConfig)
    .innerJoin(users, eq(users.id, pluginUserConfig.userId))
    .where(and(eq(pluginUserConfig.pluginId, pluginId), eq(users.status, 'active')))
    .all();
  return rows.map((row) => row.userId);
}

/**
 * 用户视角下的完整配置：站点项 + 他自己填的项。
 *
 * 优先级：用户自己填的 > 清单默认值。
 *
 * **站点那份里只取 site 字段。** 看上去多此一举（管理员那条写入路径本来就丢弃
 * user 字段），但升级上来的库里会有「历史遗留」：清单里的某项从 site 改成 user
 * 之后，旧值仍躺在 `plugins.config` 里。若把它们一并当成默认值，管理员当年填的
 * 网盘密码就会被发给每一个用户的导入 —— 那正是分层要避免的事。
 */
export function resolveUserConfig(
  manifest: PluginManifest,
  pluginId: string,
  userId: number,
): Record<string, unknown> {
  const siteRow = getDb()
    .select({ config: plugins.config })
    .from(plugins)
    .where(eq(plugins.pluginId, pluginId))
    .get();

  const siteStored = (siteRow?.config as Record<string, unknown> | undefined) ?? {};
  const siteOnly: Record<string, unknown> = {};
  for (const field of manifest.config) {
    if (field.scope === 'user') continue;
    if (siteStored[field.key] !== undefined) siteOnly[field.key] = siteStored[field.key];
  }

  const merged = resolvePluginConfig(manifest, siteOnly);

  const stored = storedUserConfig(pluginId, userId);
  if (Object.keys(stored).length === 0) return merged;

  const decrypted = decryptPluginConfig(manifest, stored);
  for (const field of userScopedFields(manifest)) {
    if (stored[field.key] !== undefined) merged[field.key] = decrypted[field.key];
  }
  return merged;
}

/** 返回给用户端的配置（敏感字段脱敏） */
export function maskedUserConfig(
  manifest: PluginManifest,
  pluginId: string,
  userId: number,
): Record<string, unknown> {
  const stored = storedUserConfig(pluginId, userId);
  const masked: Record<string, unknown> = {};

  // 只回显 user 项与默认值：站点项属于管理员，界面上也不该出现
  for (const field of userScopedFields(manifest)) {
    if (stored[field.key] !== undefined) {
      masked[field.key] = maskPluginConfig(manifest, stored)[field.key];
    } else if (field.default !== undefined) {
      masked[field.key] = field.default;
    }
  }
  return masked;
}

/**
 * 保存用户自己那份配置。
 *
 * 只接受清单里声明为 `scope: 'user'` 的键 —— 别的键一律忽略，免得用户绕过界面
 * 往自己的配置里塞站点级字段（例如自动导入间隔），把全站节奏改掉。
 */
export function saveUserConfig(
  manifest: PluginManifest,
  pluginId: string,
  userId: number,
  input: Record<string, unknown>,
): void {
  const allowed = userScopedFields(manifest);
  if (allowed.length === 0) {
    throw badRequest('这个插件不需要用户自己配置');
  }

  const current = storedUserConfig(pluginId, userId);
  const next: Record<string, unknown> = { ...current };

  for (const field of allowed) {
    if (!(field.key in input)) continue;
    const value = input[field.key];

    // 前端把掩码原样提交回来 = 不修改，保留原密文
    if (isMaskedValue(value) && current[field.key] !== undefined) continue;

    if (value === '' || value === null || value === undefined) {
      // 清空即删除这一项，让清单默认值重新生效
      delete next[field.key];
      continue;
    }

    next[field.key] = coerceFieldValue(field, value);
  }

  const encrypted = encryptPluginConfig(manifest, next);
  const now = new Date();
  const row = readRow(pluginId, userId);

  if (!row) {
    getDb().insert(pluginUserConfig).values({ pluginId, userId, config: encrypted, updatedAt: now }).run();
  } else {
    getDb()
      .update(pluginUserConfig)
      .set({ config: encrypted, updatedAt: now })
      .where(eq(pluginUserConfig.id, row.id))
      .run();
  }

  log.info({ pluginId, userId, keys: Object.keys(encrypted) }, '用户保存了插件配置');
}

/** 清空某个用户的插件配置（用户端「取消配置」用） */
export function clearUserConfig(pluginId: string, userId: number): void {
  getDb()
    .delete(pluginUserConfig)
    .where(and(eq(pluginUserConfig.pluginId, pluginId), eq(pluginUserConfig.userId, userId)))
    .run();
  log.info({ pluginId, userId }, '用户清空了插件配置');
}

/** 插件不存在或未启用时抛错；用户端接口统一用它把关 */
export function requireEnabledPlugin(pluginId: string) {
  const row = getDb().select().from(plugins).where(eq(plugins.pluginId, pluginId)).get();
  if (!row) throw notFound(`插件 ${pluginId} 不存在`);
  if (row.status !== 'enabled') throw badRequest('该插件当前未启用');
  return row;
}

/** 插件行 + 清单；清单损坏时给出可读错误 */
function manifestOf(pluginId: string): PluginManifest {
  const row = requireEnabledPlugin(pluginId);
  const manifest = safeParseManifest(row.manifest);
  if (!manifest) throw badRequest(`插件 ${pluginId} 的清单数据已损坏，请重新安装`);
  return manifest;
}

/**
 * 列出「需要我自己配置」的插件。
 *
 * 只有声明了 user 归属字段、且当前启用的插件才会出现 —— 用户的自助页面上
 * 不该列出一堆跟他无关的东西。
 */
export function listUserPlugins(userId: number): UserPluginSummary[] {
  const rows = getDb()
    .select()
    .from(plugins)
    .where(eq(plugins.status, 'enabled'))
    .all();

  const out: UserPluginSummary[] = [];
  for (const row of rows) {
    const manifest = safeParseManifest(row.manifest);
    if (!manifest || !hasUserScopedFields(manifest)) continue;

    out.push({
      id: row.pluginId,
      name: row.name,
      version: row.version,
      description: manifest.description ?? null,
      configFields: userScopedFields(manifest),
      config: maskedUserConfig(manifest, row.pluginId, userId),
      configured: readRow(row.pluginId, userId) !== undefined,
      lastRun: lastRunOf(row.pluginId, userId),
    });
  }
  return out;
}

/** 插件按约定写下的「上次运行结果」，见 UserPluginSummary.lastRun 的说明 */
function lastRunOf(pluginId: string, userId: number): unknown {
  return getDb()
    .select({ value: pluginData.value })
    .from(pluginData)
    .where(and(eq(pluginData.pluginId, pluginId), eq(pluginData.key, `lastRun:${userId}`)))
    .get()?.value;
}

/** 用户端保存配置的完整流程：校验插件 → 写入 → 回脱敏结果 */
export function updateMyPluginConfig(
  pluginId: string,
  userId: number,
  input: Record<string, unknown>,
): Record<string, unknown> {
  const manifest = manifestOf(pluginId);
  saveUserConfig(manifest, pluginId, userId, input);
  return maskedUserConfig(manifest, pluginId, userId);
}

/** 用户端清空自己的配置（等于把这个插件从自己的账号上摘掉） */
export function clearMyPluginConfig(pluginId: string, userId: number): void {
  manifestOf(pluginId);
  clearUserConfig(pluginId, userId);
}
