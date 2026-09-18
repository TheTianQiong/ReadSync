import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import {
  PLUGIN_HOOKS,
  VERSION,
  type FetchLike,
  type PluginContext,
  type PluginHook,
  type PluginManifest,
  type PluginModule,
} from '@readsync/shared';
import { loadConfig } from '../../config.js';
import { getDb } from '../../db/index.js';
import { plugins } from '../../db/schema.js';
import { notFound, pluginError } from '../../errors.js';
import { getModuleLogger } from '../../logger.js';
import { assertApiVersionCompatible, isPathInside, safeParseManifest } from './internal.js';
import { resolvePluginConfig } from './plugin-config.js';

/**
 * 插件运行时（加载 / 卸载 / 钩子 / 路由挂载）。
 *
 * 安全模型：
 *  - 插件代码本质上是以服务进程权限运行的 Node 模块，宿主无法沙箱化任意 JS，
 *    因此防线放在「能力授予」上：未声明 http 权限就没有 fetch，未声明 fs:data
 *    权限就没有数据目录，未声明 storage/sync 能力就登记不了驱动与协议。
 *  - 单个插件加载失败只把它自己标记为 error，绝不向上抛错拖垮整个服务
 *    （index.ts 在 buildApp 之前调用 loadPlugins，抛错会导致服务起不来）。
 *  - 插件在进程内注册的路由无法在不重启的情况下撤销：Fastify 不支持运行时删除路由。
 *    停用后插件代码不再被调用，但已挂载的路由要到重启才彻底消失。
 */

type HookHandler = (...args: unknown[]) => unknown | Promise<unknown>;

/** 插件同步协议处理器：宿主把 Fastify 实例交给它，由它在实例上注册相对路径路由 */
export type SyncProtocolHandler = (app: FastifyInstance) => void | Promise<void>;

interface LoadedPlugin {
  id: string;
  manifest: PluginManifest;
  module: PluginModule;
  context: PluginContext;
  hooks: Partial<Record<PluginHook, HookHandler[]>>;
  protocols: Map<string, SyncProtocolHandler>;
  dir: string;
}

const log = getModuleLogger('plugins');

const loadedPlugins = new Map<string, LoadedPlugin>();

/** 动态 import 的查询串，用于升级覆盖安装后绕过 ESM 模块缓存 */
let importToken = 0;

/**
 * 每个 Fastify 实例已挂载的协议（key = `${pluginId}:${protocolId}`）。
 * 按实例记录而非全局：测试里会多次 buildApp，全局集合会让后续实例漏挂路由。
 */
const mountedByApp = new WeakMap<FastifyInstance, Set<string>>();

/** registerPluginRoutes 时注入的 Fastify 实例，运行时启用插件后尝试即时挂载路由 */
let activeApp: FastifyInstance | null = null;

/**
 * 仅当清单声明了对应能力时才授予宿主能力。
 * 这一层必须真正生效，不能只把权限写在清单里给前端看。
 */
const HOOK_REQUIRED_CAPABILITY: Partial<Record<PluginHook, PluginManifest['capabilities'][number]>> = {
  // 收到同步推送属于同步协议范畴，未声明 sync 的插件不应感知同步事件
  onSyncPush: 'sync',
};

/* ------------------------------ 对外接口 ------------------------------ */

/**
 * 启动时加载全部 status='enabled' 的插件。
 * 由 index.ts 在 buildApp 之前调用；任何单个插件的失败都在内部消化。
 */
export async function loadPlugins(): Promise<void> {
  const db = getDb();
  const rows = db.select().from(plugins).all();
  const enabled = rows.filter((row) => row.status === 'enabled');

  log.info({ count: enabled.length, pluginDir: loadConfig().pluginDir }, '开始加载插件');

  for (const row of enabled) {
    // loadPlugin 内部已捕获异常并写回 error 状态，这里再兜一层，确保循环不会中断
    try {
      await loadPlugin(row.pluginId);
    } catch (err) {
      log.error({ err, pluginId: row.pluginId }, '插件加载失败，已跳过');
    }
  }

  warnOrphanDirectories(rows.map((row) => row.pluginId));
}

/** 加载（或重新加载）单个插件；失败时写回 status='error' 与原因，不抛错 */
export async function loadPlugin(pluginId: string): Promise<void> {
  const db = getDb();
  const row = db.select().from(plugins).where(eq(plugins.pluginId, pluginId)).get();
  if (!row) throw notFound(`插件 ${pluginId} 未安装`);

  // 重复调用保持幂等：先卸掉已在运行的实例，避免钩子被注册两遍
  if (loadedPlugins.has(pluginId)) {
    await unloadPlugin(pluginId);
  }

  try {
    const manifest = safeParseManifest(row.manifest);
    if (!manifest) throw new Error('数据库中的插件清单无法解析，请重新安装该插件');

    // 加载时再校验一次版本：内核升级后可能已不再兼容，此时应拒绝运行而不是带病加载
    assertApiVersionCompatible(manifest, VERSION);

    const dir = pluginDirectory(pluginId);
    if (!existsSync(dir)) {
      throw new Error(`插件目录不存在：${dir}（文件被手工删除？请重新安装）`);
    }

    const entryPath = resolveEntryPath(dir, manifest.main);

    // 加查询串绕过 ESM 缓存，否则覆盖安装后仍会执行旧代码
    importToken += 1;
    const moduleUrl = `${pathToFileURL(entryPath).href}?v=${importToken}`;
    const mod = (await import(moduleUrl)) as Partial<PluginModule>;
    if (typeof mod.register !== 'function') {
      throw new Error('插件入口模块必须导出 register(ctx) 函数');
    }

    const loaded = createLoadedPlugin(pluginId, manifest, mod as PluginModule, dir);
    await loaded.module.register(loaded.context);
    loadedPlugins.set(pluginId, loaded);

    db.update(plugins)
      .set({
        name: manifest.name,
        version: manifest.version,
        manifest: manifest as unknown as Record<string, unknown>,
        status: 'enabled',
        error: null,
        updatedAt: new Date(),
      })
      .where(eq(plugins.pluginId, pluginId))
      .run();

    log.info(
      { pluginId, version: manifest.version, capabilities: manifest.capabilities },
      '插件已加载',
    );

    await invokeHook(loaded, 'onLoad', { pluginId });

    // 服务已在运行时（运行时启用插件），尝试即时挂载其协议路由
    if (activeApp) {
      await mountLoadedProtocols(activeApp, loaded);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    loadedPlugins.delete(pluginId);

    db.update(plugins)
      .set({ status: 'error', error: message.slice(0, 2000), updatedAt: new Date() })
      .where(eq(plugins.pluginId, pluginId))
      .run();

    // 面向开发者的字段级提示已由 assertApiVersionCompatible / 清单解析给出
    log.error({ err, pluginId }, '插件加载失败，已标记为 error（服务继续运行）');
  }
}

/** 卸载单个插件：触发 onUnload → 调用 unregister → 移出运行时表 */
export async function unloadPlugin(pluginId: string): Promise<void> {
  const loaded = loadedPlugins.get(pluginId);
  if (!loaded) return;

  // 先摘掉引用：即使钩子或 unregister 抛错，插件也不再接受新的钩子调用
  loadedPlugins.delete(pluginId);

  await invokeHook(loaded, 'onUnload', { pluginId });

  try {
    await loaded.module.unregister?.();
  } catch (err) {
    log.error({ err, pluginId }, '插件 unregister 执行失败（已忽略）');
  }

  log.info({ pluginId }, '插件已卸载');
}

/** 取插件的运行上下文；未加载时返回 null */
export function getPluginContext(pluginId: string): PluginContext | null {
  return loadedPlugins.get(pluginId)?.context ?? null;
}

/**
 * 触发某个钩子。
 *
 * 供其它模块在关键节点调用（如 sync 模块收到推送后调 runHook('onSyncPush', payload)）。
 * 插件抛错只记日志：钩子是旁路扩展点，绝不能影响主流程。
 */
export async function runHook(hook: PluginHook, ...args: unknown[]): Promise<void> {
  if (loadedPlugins.size === 0) return;
  const tasks: Promise<void>[] = [];
  for (const loaded of loadedPlugins.values()) {
    tasks.push(invokeHook(loaded, hook, ...args));
  }
  await Promise.all(tasks);
}

/** 只触发某个插件的钩子（配置变更等定向事件用） */
export async function runPluginHook(pluginId: string, hook: PluginHook, ...args: unknown[]): Promise<void> {
  const loaded = loadedPlugins.get(pluginId);
  if (!loaded) return;
  await invokeHook(loaded, hook, ...args);
}

/**
 * 把插件的同步协议路由挂到 `/api/plugins/{pluginId}{mountPath}`。
 * 由 routes.ts 在 buildApp 阶段调用（此时所有启用的插件已加载完毕）。
 */
export async function mountPluginRoutes(app: FastifyInstance): Promise<void> {
  activeApp = app;
  for (const loaded of loadedPlugins.values()) {
    await mountLoadedProtocols(app, loaded);
  }
}

/** 是否已加载（路由层展示运行时状态用） */
export function isPluginLoaded(pluginId: string): boolean {
  return loadedPlugins.has(pluginId);
}

/* ------------------------------ 内部实现 ------------------------------ */

/** `{pluginDir}/{pluginId}`，并确认仍位于插件根目录内（id 已由 schema 限制字符集，这里是双保险） */
function pluginDirectory(pluginId: string): string {
  const root = loadConfig().pluginDir;
  const dir = path.resolve(root, pluginId);
  if (dir === path.resolve(root) || !isPathInside(root, dir)) {
    throw pluginError(`插件 id 非法：${pluginId}`);
  }
  return dir;
}

/** 解析入口文件绝对路径，并确认没有越出插件目录 */
function resolveEntryPath(dir: string, main: string): string {
  if (path.isAbsolute(main) || /^[a-zA-Z]:/.test(main) || main.includes('..')) {
    throw new Error(`manifest.main 含非法路径：${main}`);
  }
  const entry = path.resolve(dir, main);
  if (!isPathInside(dir, entry)) {
    throw new Error(`manifest.main 越出插件目录：${main}`);
  }
  if (!existsSync(entry)) {
    throw new Error(`插件入口文件不存在：${main}`);
  }
  return entry;
}

/** 构造注入给插件的上下文；未声明的权限在这里被真正降级为不可用 */
function createLoadedPlugin(
  pluginId: string,
  manifest: PluginManifest,
  module: PluginModule,
  dir: string,
): LoadedPlugin {
  const pluginLog = getModuleLogger(`plugin:${pluginId}`);
  const permissions = new Set(manifest.permissions);

  const loaded: LoadedPlugin = {
    id: pluginId,
    manifest,
    module,
    dir,
    hooks: {},
    protocols: new Map(),
    context: null as unknown as PluginContext,
  };

  const context = {
    pluginId,
    log: {
      // 统一加 [pluginId] 前缀，宿主的日志里才能一眼看出是哪个插件在说话
      debug: (msg: string, meta?: Record<string, unknown>) =>
        pluginLog.debug({ ...meta, pluginId }, `[${pluginId}] ${msg}`),
      info: (msg: string, meta?: Record<string, unknown>) =>
        pluginLog.info({ ...meta, pluginId }, `[${pluginId}] ${msg}`),
      warn: (msg: string, meta?: Record<string, unknown>) =>
        pluginLog.warn({ ...meta, pluginId }, `[${pluginId}] ${msg}`),
      error: (msg: string, meta?: Record<string, unknown>) =>
        pluginLog.error({ ...meta, pluginId }, `[${pluginId}] ${msg}`),
    },
    getConfig: <T = Record<string, unknown>>(): T => {
      const row = getDb()
        .select({ config: plugins.config })
        .from(plugins)
        .where(eq(plugins.pluginId, pluginId))
        .get();
      // 每次调用都回库读取并解密：管理员改配置后无需重启插件即可生效
      return resolvePluginConfig(manifest, row?.config ?? {}) as T;
    },
    // 先占位，下面用带警告的 getter 覆盖
    dataDir: '',
    fetch: buildFetch(pluginId, permissions.has('http')),
    registerStorageDriver: (driverId: string, factory: unknown) => {
      registerStorageDriver(loaded, driverId, factory);
    },
    registerSyncProtocol: (protocolId: string, handler: unknown) => {
      registerSyncProtocol(loaded, protocolId, handler);
    },
    on: (hook: PluginHook, handler: HookHandler) => {
      registerHook(loaded, hook, handler);
    },
  } as PluginContext;

  // fs:data 权限：只有声明了才创建并给出数据目录。
  // 用 getter 而不是普通字段，是为了在未授权访问时能留下一条明确的警告日志
  // （“给了空串却静默失败”会让插件作者非常难排查）。
  const hasDataPermission = permissions.has('fs:data');
  const dataDir = path.join(dir, 'data');
  if (hasDataPermission && !existsSync(dataDir)) {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  }
  let dataDirWarned = false;
  Object.defineProperty(context, 'dataDir', {
    enumerable: true,
    configurable: false,
    get() {
      if (hasDataPermission) return dataDir;
      if (!dataDirWarned) {
        dataDirWarned = true;
        pluginLog.warn(
          { pluginId },
          '插件访问了 ctx.dataDir，但清单未声明 fs:data 权限，已返回空串',
        );
      }
      return '';
    },
  });

  loaded.context = context;
  return loaded;
}

/**
 * 构造 ctx.fetch。
 * 未声明 http 权限时注入抛错的桩——权限模型必须真正生效，而不是只写在清单里。
 */
function buildFetch(pluginId: string, allowed: boolean): FetchLike {
  if (!allowed) {
    return async () => {
      throw new Error(
        `插件 ${pluginId} 未声明 http 权限，禁止发起外部网络请求（请在 plugin.json 的 permissions 中加入 "http"）`,
      );
    };
  }
  return (input, init) => globalThis.fetch(input, init);
}

function registerHook(plugin: LoadedPlugin, hook: PluginHook, handler: HookHandler): void {
  if (!PLUGIN_HOOKS.includes(hook)) {
    log.warn({ pluginId: plugin.id, hook }, '插件注册了未知钩子，已忽略');
    return;
  }
  if (typeof handler !== 'function') {
    log.warn({ pluginId: plugin.id, hook }, '插件钩子处理器不是函数，已忽略');
    return;
  }
  const required = HOOK_REQUIRED_CAPABILITY[hook];
  if (required && !plugin.manifest.capabilities.includes(required)) {
    log.warn(
      { pluginId: plugin.id, hook, required },
      '插件未声明所需能力，拒绝注册该钩子',
    );
    return;
  }
  const list = plugin.hooks[hook] ?? [];
  list.push(handler);
  plugin.hooks[hook] = list;
}

function registerSyncProtocol(plugin: LoadedPlugin, protocolId: string, handler: unknown): void {
  if (!plugin.manifest.capabilities.includes('sync')) {
    log.warn({ pluginId: plugin.id, protocolId }, '插件未声明 sync 能力，拒绝注册同步协议');
    return;
  }
  if (!plugin.manifest.syncProtocols.some((p) => p.id === protocolId)) {
    log.warn({ pluginId: plugin.id, protocolId }, '插件注册了清单未声明的同步协议，已忽略');
    return;
  }
  if (typeof handler !== 'function') {
    log.warn({ pluginId: plugin.id, protocolId }, '同步协议处理器不是函数，已忽略');
    return;
  }
  plugin.protocols.set(protocolId, handler as SyncProtocolHandler);
  log.debug({ pluginId: plugin.id, protocolId }, '插件已登记同步协议');
}

/**
 * 登记存储驱动到 storage 模块的驱动注册表。
 *
 * storage/adapters/registry.ts 由另一位同事并行实现，签名约定为
 * `registerExternalDriver(driver, factory)`。这里用动态 import + try/catch 做可选集成：
 * 注册表还不存在时只记警告，不影响插件加载，等该模块落地后即可自动生效。
 */
function registerStorageDriver(plugin: LoadedPlugin, driverId: string, factory: unknown): void {
  if (!plugin.manifest.capabilities.includes('storage')) {
    log.warn({ pluginId: plugin.id, driverId }, '插件未声明 storage 能力，拒绝注册存储驱动');
    return;
  }
  if (!plugin.manifest.storageDrivers.some((d) => d.id === driverId)) {
    log.warn({ pluginId: plugin.id, driverId }, '插件注册了清单未声明的存储驱动，已忽略');
    return;
  }

  // 动态 import 的路径放在变量里：registry.ts 尚未创建，写死字面量会编译报错
  const registryPath = '../storage/adapters/registry.js';
  void (async () => {
    try {
      const registry = (await import(registryPath)) as {
        registerExternalDriver?: (driver: string, factory: unknown) => void;
      };
      if (typeof registry.registerExternalDriver !== 'function') {
        log.warn(
          { pluginId: plugin.id, driverId },
          'storage 驱动注册表未提供 registerExternalDriver，插件驱动注册未生效',
        );
        return;
      }
      registry.registerExternalDriver(driverId, factory);
      log.info({ pluginId: plugin.id, driverId }, '插件存储驱动已注册');
    } catch (err) {
      // 集成点尚未落地时属于预期情况，用 warn 而非 error
      log.warn(
        { err, pluginId: plugin.id, driverId },
        '未找到 storage 驱动注册表，插件存储驱动注册未生效（等待 storage 模块提供 registerExternalDriver）',
      );
    }
  })();
}

/** 执行单个插件的某个钩子；任何异常都只记日志 */
async function invokeHook(plugin: LoadedPlugin, hook: PluginHook, ...args: unknown[]): Promise<void> {
  const handlers = plugin.hooks[hook];
  if (!handlers || handlers.length === 0) return;
  for (const handler of handlers) {
    try {
      await handler(...args);
    } catch (err) {
      log.error({ err, pluginId: plugin.id, hook }, '插件钩子执行失败（已忽略，不影响主流程）');
    }
  }
}

/** 挂载插件声明的同步协议路由 */
async function mountLoadedProtocols(app: FastifyInstance, plugin: LoadedPlugin): Promise<void> {
  let mounted = mountedByApp.get(app);
  if (!mounted) {
    mounted = new Set<string>();
    mountedByApp.set(app, mounted);
  }

  for (const protocol of plugin.manifest.syncProtocols) {
    const key = `${plugin.id}:${protocol.id}`;
    if (mounted.has(key)) continue;

    const handler = plugin.protocols.get(protocol.id);
    // 插件可能只声明了协议但没（或暂时没能）注册处理器，跳过即可
    if (!handler) continue;

    const prefix = `/api/plugins/${plugin.id}${protocol.mountPath}`;
    try {
      // 用 register + prefix 包一层，插件在处理器内部只需注册相对路径
      await app.register(
        async (instance) => {
          await handler(instance);
        },
        { prefix },
      );
      mounted.add(key);
      log.info({ pluginId: plugin.id, protocolId: protocol.id, prefix }, '已挂载插件协议路由');
    } catch (err) {
      // Fastify 在 listen 之后不再允许新增路由，运行时启用插件会走到这里
      log.error(
        { err, pluginId: plugin.id, prefix },
        '挂载插件协议路由失败，该路由需重启服务后才会生效',
      );
    }
  }
}

/**
 * 扫描插件目录，提示「有目录但没有数据库记录」的孤儿插件。
 *
 * 刻意不自动登记执行：否则任何人往目录里放一个文件夹就等于获得了代码执行权限，
 * 与「安装需管理员上传并经清单校验」的设计相悖。
 */
function warnOrphanDirectories(knownIds: string[]): void {
  const root = loadConfig().pluginDir;
  const known = new Set(knownIds);
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch (err) {
    log.warn({ err, pluginDir: root }, '读取插件目录失败');
    return;
  }
  for (const name of entries) {
    // .tmp-* 是安装过程中的暂存目录，忽略
    if (name.startsWith('.')) continue;
    if (known.has(name)) continue;
    log.warn({ dir: path.join(root, name) }, '插件目录中存在未登记的插件，已跳过（请通过管理后台上传安装）');
  }
}
