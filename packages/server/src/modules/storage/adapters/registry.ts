import type { StorageDriver } from '@readsync/shared';
import { badRequest } from '../../../errors.js';
import type { StorageAdapter, StorageAdapterFactory } from '../types.js';
import { createLocalAdapter } from './local.js';
import { createS3Adapter } from './s3.js';
import { createWebdavAdapter } from './webdav.js';

/**
 * 存储驱动注册表。
 *
 * 上层（book/sync/service）只通过 createAdapter(driver, config) 拿适配器，
 * 不直接 import 具体驱动，这样插件提供的驱动可以在运行时注册进来，
 * 内置驱动与插件驱动走同一条创建路径。
 *
 * 配置约定：传入的 config 必须是「已解密的明文配置」。加密/脱敏属于
 * service.ts 的职责，注册表只负责实例化。
 */

/**
 * 支持目录创建的适配器。
 *
 * StorageAdapter 接口（types.ts，不可修改）没有 mkdir，但「存储管理」页面
 * 需要在 WebDAV / 本地存储上建目录。这里用扩展接口表达，对象存储的 mkdir
 * 是空操作（S3 无目录概念），因此三个内置驱动都实现它。
 */
export interface DirectoryAdapter extends StorageAdapter {
  mkdir(key: string): Promise<void>;
}

export function isDirectoryAdapter(adapter: StorageAdapter): adapter is DirectoryAdapter {
  return typeof (adapter as Partial<DirectoryAdapter>).mkdir === 'function';
}

/** 驱动注册表。key 为 storages.driver 的取值（插件驱动可用自定义标识） */
const factories = new Map<string, StorageAdapterFactory>();

function registerInternal(driver: StorageDriver, create: (config: Record<string, unknown>) => StorageAdapter): void {
  factories.set(driver, { driver, create });
}

// 内置驱动。插件驱动稍后由 plugins 模块调用 registerExternalDriver 注入。
registerInternal('local', createLocalAdapter);
registerInternal('webdav', createWebdavAdapter);
registerInternal('s3', createS3Adapter);

/**
 * 注册外部（插件）驱动。
 *
 * 插件加载时调用，例如：
 *   registerExternalDriver('plugin:onedrive', { driver: 'plugin', create: (cfg) => new OneDriveAdapter(cfg) });
 * 重复注册同名驱动会被覆盖（便于插件热更新后重新注入）。
 */
export function registerExternalDriver(driver: string, factory: StorageAdapterFactory): void {
  factories.set(driver, factory);
}

/** 是否已注册某个驱动 */
export function hasDriver(driver: string): boolean {
  return factories.has(driver);
}

/** 已注册的驱动标识列表，供管理界面展示 */
export function listDrivers(): string[] {
  return [...factories.keys()].sort();
}

/**
 * 根据驱动类型与明文配置创建适配器。
 * 驱动未注册或配置校验失败时抛 BAD_REQUEST（可读中文消息）。
 */
export function createAdapter(driver: string, config: Record<string, unknown>): StorageAdapter {
  const factory = factories.get(driver);
  if (!factory) {
    throw badRequest(`不支持的存储驱动：${driver}（若为插件驱动，请先安装并启用对应插件）`);
  }
  return factory.create(config);
}

/**
 * 仅校验配置合法性，不真正使用适配器。
 *
 * 用于创建/更新存储时在写库前拦截错误配置。plugin 驱动若未注册则跳过校验
 * （由插件自己负责），避免「装了插件才能保存配置、但配置要先保存才能启用插件」的死循环。
 */
export function validateStorageConfig(driver: string, config: Record<string, unknown>): void {
  if (!factories.has(driver)) {
    if (driver === 'plugin') return;
    throw badRequest(`不支持的存储驱动：${driver}`);
  }
  factories.get(driver)!.create(config);
}
