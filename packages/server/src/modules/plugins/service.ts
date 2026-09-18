import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import AdmZip from 'adm-zip';
import { desc, eq } from 'drizzle-orm';
import {
  VERSION,
  type PluginConfigField,
  type PluginManifest,
  type PluginStatus,
  type PluginSummary,
} from '@readsync/shared';
import { loadConfig } from '../../config.js';
import { getDb } from '../../db/index.js';
import { pluginData, plugins, type PluginRow } from '../../db/schema.js';
import { badRequest, forbidden, notFound, payloadTooLarge } from '../../errors.js';
import { getModuleLogger } from '../../logger.js';
import {
  assertApiVersionCompatible,
  isPathInside,
  parseManifestOrThrow,
  safeParseManifest,
} from './internal.js';
import {
  coerceFieldValue,
  encryptPluginConfig,
  isMaskedValue,
  maskPluginConfig,
} from './plugin-config.js';
import { loadPlugin, runPluginHook, unloadPlugin } from './loader.js';

/**
 * 插件安装 / 卸载 / 启停 / 配置读写。
 *
 * 安装过程的安全要求（zip 是不可信输入）：
 *  - 解压前逐条校验 entry 路径，拒绝 `..`、绝对路径、Windows 盘符（Zip Slip 防护）；
 *  - 限制文件数与解压后总大小（默认 50MB / 500 个），防止 zip bomb 打爆磁盘/内存；
 *  - 先解压到 pluginDir 下的随机暂存目录，再整体改名到 `{pluginDir}/{pluginId}`，
 *    每个目标路径都用 path.resolve 后做前缀确认，确保最终仍落在目录内；
 *  - 清单必须位于 zip 根目录，并用 zod 校验，失败时给出字段级原因。
 */

const log = getModuleLogger('plugins');

/** 上传的 zip 大小上限（压缩后） */
const MAX_ZIP_BYTES = 50 * 1024 * 1024;
/** 解压后总大小上限 */
const MAX_EXTRACTED_BYTES = 50 * 1024 * 1024;
/** 解压后文件数上限 */
const MAX_FILES = 500;
/** plugin.json 大小上限，清单不该很大 */
const MAX_MANIFEST_BYTES = 256 * 1024;

/**
 * 保留的挂载路径首段。
 * 插件协议挂在 /api/plugins/{id}{mountPath}，若首段撞上管理接口
 * （config/data/enable/disable/install）会造成路由冲突，安装时直接拒绝。
 */
const RESERVED_MOUNT_SEGMENTS = new Set(['config', 'data', 'enable', 'disable', 'install']);

/* ------------------------------ 查询 ------------------------------ */

/** 列出全部已安装插件（配置脱敏） */
export function listPlugins(): PluginSummary[] {
  return getDb()
    .select()
    .from(plugins)
    .orderBy(desc(plugins.installedAt))
    .all()
    .map((row) => toSummary(row));
}

/** 读取单个插件配置（脱敏） */
export function getPluginConfig(
  pluginId: string,
): { config: Record<string, unknown>; configFields: PluginConfigField[] } {
  const row = mustGetRow(pluginId);
  const manifest = requireManifest(row);
  return {
    config: maskPluginConfig(manifest, row.config ?? {}),
    configFields: manifest.config,
  };
}

/** 列出插件在 plugin_data 表中的键值 */
export function listPluginData(
  pluginId: string,
): Array<{ key: string; value: unknown; updatedAt: string }> {
  mustGetRow(pluginId);
  return getDb()
    .select({ key: pluginData.key, value: pluginData.value, updatedAt: pluginData.updatedAt })
    .from(pluginData)
    .where(eq(pluginData.pluginId, pluginId))
    .all()
    .map((row) => ({
      key: row.key,
      value: row.value,
      updatedAt: row.updatedAt.toISOString(),
    }));
}

/* ------------------------------ 安装 / 卸载 ------------------------------ */

/**
 * 从上传的 zip 安装（或覆盖升级）插件。
 * 覆盖升级会保留原有配置，只替换代码与清单。
 */
export async function installPlugin(buffer: Buffer, installedBy: number | null): Promise<PluginSummary> {
  if (buffer.length === 0) {
    throw badRequest('上传的插件包为空');
  }
  if (buffer.length > MAX_ZIP_BYTES) {
    throw payloadTooLarge(`插件包不能超过 ${Math.round(MAX_ZIP_BYTES / 1024 / 1024)}MB`);
  }

  let zip: AdmZip;
  try {
    zip = new AdmZip(buffer);
  } catch (err) {
    throw badRequest('无法解析插件包，请确认上传的是有效的 zip 文件', {
      cause: err instanceof Error ? err.message : String(err),
    });
  }

  const entries = zip.getEntries();
  // 1) 解压前的静态校验：路径安全 + 资源上限（此时尚未读取任何解压数据）
  validateEntries(entries);
  // 2) 读取并严格校验清单（必须在根目录）
  const manifest = readManifest(entries);
  // 3) 版本兼容 + 结构完整性
  assertApiVersionCompatible(manifest, VERSION);
  validateManifestStructure(manifest, entries);

  const existing = findRow(manifest.id);
  if (existing?.builtin) {
    throw forbidden('内置插件不能通过上传覆盖安装');
  }

  const root = loadConfig().pluginDir;
  const targetDir = pluginTargetDirectory(manifest.id);

  // 先卸掉正在运行的旧实例，避免升级期间新旧代码并存
  await unloadPlugin(manifest.id);

  // 暂存目录放在 pluginDir 内：同分区 rename 是原子操作，也保证清理范围可控
  const stagingDir = path.join(
    root,
    `.tmp-${manifest.id}-${randomBytes(6).toString('hex')}`,
  );
  mkdirSync(stagingDir, { recursive: true, mode: 0o700 });

  try {
    // 4) 再逐条做一次前缀确认后落盘（双保险，见 isPathInside）
    extractEntries(zip, stagingDir);

    if (existsSync(targetDir)) {
      rmSync(targetDir, { recursive: true, force: true });
    }
    renameSync(stagingDir, targetDir);
  } catch (err) {
    rmSync(stagingDir, { recursive: true, force: true });
    if (err instanceof Error && 'statusCode' in err) throw err;
    throw badRequest('插件包解压失败，请确认 zip 未损坏', {
      cause: err instanceof Error ? err.message : String(err),
    });
  }

  const now = new Date();
  const db = getDb();
  if (existing) {
    // 覆盖升级：保留 config / builtin / installedAt，只更新代码相关字段
    db.update(plugins)
      .set({
        name: manifest.name,
        version: manifest.version,
        manifest: manifest as unknown as Record<string, unknown>,
        status: 'enabled',
        error: null,
        updatedAt: now,
      })
      .where(eq(plugins.pluginId, manifest.id))
      .run();
  } else {
    db.insert(plugins)
      .values({
        pluginId: manifest.id,
        name: manifest.name,
        version: manifest.version,
        manifest: manifest as unknown as Record<string, unknown>,
        status: 'enabled',
        error: null,
        config: {},
        builtin: false,
        installedBy,
        installedAt: now,
        updatedAt: now,
      })
      .run();
  }

  // 安装后立即加载；加载失败会被 loader 记为 status='error'，不抛错
  await loadPlugin(manifest.id);
  log.info({ pluginId: manifest.id, version: manifest.version }, '插件安装完成');
  return toSummary(mustGetRow(manifest.id));
}

/**
 * 从本地 zip 文件路径安装。
 * CLI（`readsync plugin install <zip路径>`）用这个入口，与 HTTP 上传共用同一套校验逻辑，
 * 避免两条安装路径的安全规则出现分叉。
 */
export async function installPluginFromZip(
  zipPath: string,
  installedBy: number | null = null,
): Promise<{ pluginId: string; name: string; version: string; status: PluginStatus; error: string | null }> {
  const abs = path.resolve(zipPath);
  if (!existsSync(abs)) {
    throw badRequest(`插件包不存在：${abs}`);
  }
  const stat = statSync(abs);
  if (!stat.isFile()) {
    throw badRequest(`插件包不是文件：${abs}`);
  }
  if (stat.size > MAX_ZIP_BYTES) {
    throw payloadTooLarge(`插件包不能超过 ${Math.round(MAX_ZIP_BYTES / 1024 / 1024)}MB`);
  }

  const summary = await installPlugin(readFileSync(abs), installedBy);
  return {
    pluginId: summary.id,
    name: summary.name,
    version: summary.version,
    status: summary.status,
    error: summary.error,
  };
}

/** 卸载插件：停掉运行时、删除磁盘目录与数据库记录（含 plugin_data） */
export async function uninstallPlugin(pluginId: string): Promise<void> {
  const row = mustGetRow(pluginId);
  // 内置插件由服务自身提供，删除会导致内核功能缺失，禁止卸载
  if (row.builtin) {
    throw forbidden('内置插件不可卸载');
  }

  await unloadPlugin(pluginId);

  const dir = pluginTargetDirectory(pluginId);
  if (existsSync(dir)) {
    rmSync(dir, { recursive: true, force: true });
  }

  const db = getDb();
  db.delete(pluginData).where(eq(pluginData.pluginId, pluginId)).run();
  db.delete(plugins).where(eq(plugins.pluginId, pluginId)).run();
  log.info({ pluginId }, '插件已卸载');
}

/* ------------------------------ 启停 ------------------------------ */

/** 启用并加载插件；加载失败时返回的 summary 里 status 为 error */
export async function enablePlugin(pluginId: string): Promise<PluginSummary> {
  mustGetRow(pluginId);
  await loadPlugin(pluginId);
  return toSummary(mustGetRow(pluginId));
}

/** 停用并卸载插件 */
export async function disablePlugin(pluginId: string): Promise<PluginSummary> {
  mustGetRow(pluginId);
  await unloadPlugin(pluginId);
  getDb()
    .update(plugins)
    .set({ status: 'disabled', error: null, updatedAt: new Date() })
    .where(eq(plugins.pluginId, pluginId))
    .run();
  return toSummary(mustGetRow(pluginId));
}

/* ------------------------------ 配置更新 ------------------------------ */

/**
 * 更新插件配置。
 * 敏感字段：掩码值代表「不修改」，保留原密文而非把掩码写进库；
 * 其余敏感值用 encryptConfig 加密后落库。
 */
export async function updatePluginConfig(
  pluginId: string,
  input: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const row = mustGetRow(pluginId);
  const manifest = requireManifest(row);
  const declared = new Map(manifest.config.map((field) => [field.key, field]));

  const next: Record<string, unknown> = { ...(row.config ?? {}) };
  for (const [key, value] of Object.entries(input)) {
    const field = declared.get(key);
    if (!field) {
      // 只接受清单声明的字段，避免前端误传的字段混进配置
      log.warn({ pluginId, key }, '插件配置更新忽略了清单未声明的字段');
      continue;
    }
    if (isMaskedValue(value)) continue; // 保留原密文
    next[key] = coerceFieldValue(field, value);
  }

  const encrypted = encryptPluginConfig(manifest, next);
  getDb()
    .update(plugins)
    .set({ config: encrypted, updatedAt: new Date() })
    .where(eq(plugins.pluginId, pluginId))
    .run();

  // 通知插件配置已变更；钩子抛错不影响本次更新结果
  await runPluginHook(pluginId, 'onConfigChange', { pluginId });
  return maskPluginConfig(manifest, encrypted);
}

/* ------------------------------ zip 处理 ------------------------------ */

/** 把 entry 名统一成 POSIX 风格并去掉开头的 ./ */
function normalizeEntryName(name: string): string {
  return name
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/\/{2,}/g, '/');
}

/**
 * 解压前的校验：路径安全 + 文件数 + 总大小。
 *
 * 路径校验放在最前面且不看任何解压内容，因为 Zip Slip 只需要一个恶意的
 * entry 名（如 `../../etc/cron.d/x`）就能在解压时覆盖任意文件。
 * 大小用中央目录记录的 header.size 求和，避免先解压再判断（那就已经中招了）。
 */
function validateEntries(entries: AdmZip.IZipEntry[]): void {
  let fileCount = 0;
  let totalBytes = 0;

  for (const entry of entries) {
    const name = normalizeEntryName(entry.entryName);

    if (name.length === 0) {
      throw badRequest('插件包中存在空路径条目');
    }
    if (name.includes('\0')) {
      throw badRequest('插件包条目包含非法字符（NUL）');
    }
    if (name.startsWith('/')) {
      throw badRequest(`插件包条目不能是绝对路径：${entry.entryName}`);
    }
    if (/^[a-zA-Z]:/.test(name)) {
      throw badRequest(`插件包条目不能包含 Windows 盘符：${entry.entryName}`);
    }
    if (name.includes('..')) {
      throw badRequest(`插件包条目包含非法路径片段「..」：${entry.entryName}`);
    }

    if (entry.isDirectory) continue;

    fileCount += 1;
    totalBytes += entry.header.size;

    if (fileCount > MAX_FILES) {
      throw payloadTooLarge(`插件包文件数超过上限（${MAX_FILES} 个）`);
    }
    if (totalBytes > MAX_EXTRACTED_BYTES) {
      throw payloadTooLarge(
        `插件包解压后体积超过上限（${Math.round(MAX_EXTRACTED_BYTES / 1024 / 1024)}MB）`,
      );
    }
  }

  if (fileCount === 0) {
    throw badRequest('插件包中没有文件');
  }
}

/** 从根目录读取 plugin.json 并做 zod 校验 */
function readManifest(entries: AdmZip.IZipEntry[]): PluginManifest {
  const manifestEntry = entries.find(
    (entry) => !entry.isDirectory && normalizeEntryName(entry.entryName) === 'plugin.json',
  );
  if (!manifestEntry) {
    throw badRequest('插件包根目录缺少 plugin.json（请把清单放在压缩包最外层，不要套一层文件夹）');
  }
  if (manifestEntry.header.size > MAX_MANIFEST_BYTES) {
    throw badRequest('plugin.json 体积异常，请检查插件包');
  }

  let raw: unknown;
  try {
    raw = JSON.parse(manifestEntry.getData().toString('utf8'));
  } catch {
    throw badRequest('plugin.json 不是合法的 JSON');
  }
  // parseManifestOrThrow 会给出「字段: 原因」级别的可读错误
  return parseManifestOrThrow(raw);
}

/** 校验入口文件存在、挂载路径不与管理接口冲突、能力与声明条目一致 */
function validateManifestStructure(manifest: PluginManifest, entries: AdmZip.IZipEntry[]): void {
  const fileNames = new Set(
    entries.filter((entry) => !entry.isDirectory).map((entry) => normalizeEntryName(entry.entryName)),
  );
  const mainName = normalizeEntryName(manifest.main);

  if (!fileNames.has(mainName)) {
    throw badRequest(`插件入口文件 ${manifest.main} 不在插件包中`);
  }
  if (!/\.(m?js|cjs)$/i.test(mainName)) {
    throw badRequest('插件入口必须是 .js / .mjs / .cjs 文件');
  }
  if (manifest.main.includes('..') || path.isAbsolute(manifest.main)) {
    throw badRequest('manifest.main 必须是插件根目录下的相对路径');
  }

  for (const protocol of manifest.syncProtocols) {
    const first = protocol.mountPath.split('/').filter(Boolean)[0];
    if (first && RESERVED_MOUNT_SEGMENTS.has(first)) {
      throw badRequest(
        `同步协议挂载路径 ${protocol.mountPath} 与内置管理接口冲突，请改用其它前缀`,
      );
    }
  }

  if (manifest.capabilities.includes('storage') && manifest.storageDrivers.length === 0) {
    throw badRequest('capabilities 声明了 storage，必须在 storageDrivers 中至少声明一个驱动');
  }
  if (manifest.capabilities.includes('sync') && manifest.syncProtocols.length === 0) {
    throw badRequest('capabilities 声明了 sync，必须在 syncProtocols 中至少声明一个协议');
  }
}

/**
 * 逐条落盘。
 * 每个目标路径都 path.resolve 后与暂存目录做前缀比对（isPathInside），
 * 即便前面的 entry 名校验被绕过，这里仍能拦住越界写入。
 */
function extractEntries(zip: AdmZip, targetRoot: string): void {
  const resolvedRoot = path.resolve(targetRoot);
  let written = 0;

  for (const entry of zip.getEntries()) {
    const name = normalizeEntryName(entry.entryName);
    const dest = path.resolve(resolvedRoot, name);

    if (!isPathInside(resolvedRoot, dest)) {
      throw badRequest(`插件包条目越出目标目录：${entry.entryName}`);
    }

    if (entry.isDirectory) {
      mkdirSync(dest, { recursive: true });
      continue;
    }

    let data: Buffer;
    try {
      data = entry.getData();
    } catch (err) {
      throw badRequest(`插件包条目解压失败：${entry.entryName}`, {
        cause: err instanceof Error ? err.message : String(err),
      });
    }

    // 中央目录里的 size 可能被伪造，落盘前按实际长度再累计一次
    written += data.length;
    if (written > MAX_EXTRACTED_BYTES) {
      throw payloadTooLarge('插件包解压后体积超过上限，可能为 zip bomb');
    }

    mkdirSync(path.dirname(dest), { recursive: true });
    // 0600：插件代码属主可读写即可，不额外放开权限
    writeFileSync(dest, data, { mode: 0o600 });
  }
}

/* ------------------------------ 通用辅助 ------------------------------ */

function findRow(pluginId: string): PluginRow | undefined {
  return getDb().select().from(plugins).where(eq(plugins.pluginId, pluginId)).get();
}

function mustGetRow(pluginId: string): PluginRow {
  const row = findRow(pluginId);
  if (!row) throw notFound(`插件 ${pluginId} 未安装`);
  return row;
}

/** 读取数据库中的清单；损坏时给出可读错误而不是抛 zod 细节 */
function requireManifest(row: PluginRow): PluginManifest {
  const manifest = safeParseManifest(row.manifest);
  if (!manifest) {
    throw badRequest(`插件 ${row.pluginId} 的清单数据已损坏，请重新安装`);
  }
  return manifest;
}

/** `{pluginDir}/{pluginId}`，并确认位于插件根目录内 */
function pluginTargetDirectory(pluginId: string): string {
  const root = path.resolve(loadConfig().pluginDir);
  const dir = path.resolve(root, pluginId);
  if (dir === root || !isPathInside(root, dir)) {
    throw badRequest(`插件 id 非法：${pluginId}`);
  }
  return dir;
}

/** 数据库行 → 对外摘要（配置脱敏） */
function toSummary(row: PluginRow): PluginSummary {
  const manifest = safeParseManifest(row.manifest);
  const stored = row.config ?? {};
  return {
    id: row.pluginId,
    name: row.name,
    version: row.version,
    author: manifest?.author ?? null,
    description: manifest?.description ?? null,
    homepage: manifest?.homepage ?? null,
    apiVersion: manifest?.apiVersion ?? '',
    capabilities: manifest?.capabilities ?? [],
    permissions: manifest?.permissions ?? [],
    status: row.status,
    error: row.error,
    configFields: manifest?.config ?? [],
    config: manifest ? maskPluginConfig(manifest, stored) : {},
    installedAt: row.installedAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    builtin: row.builtin,
  };
}
