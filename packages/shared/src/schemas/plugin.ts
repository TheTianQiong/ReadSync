import { z } from 'zod';
import { PLUGIN_CAPABILITIES, PLUGIN_STATUSES } from '../constants.js';

/**
 * 插件系统。
 *
 * 设计目标（README 要求 1：「其他不支持的协议可以后续通过插件的形式实现」，
 * 以及要求 4.1「编辑插件开发指南，方便开发者开发和系统识别」）：
 *  - 插件是一个 zip 包，根目录含 plugin.json 清单 + 入口 JS 文件。
 *  - 清单声明 id / 版本 / 能力 / 权限 / 配置项 schema。
 *  - 服务端只加载清单校验通过的插件，并按声明的能力授予对应钩子。
 *
 * 完整的开发指南见 docs/plugin-development.md。
 */

/** 插件入口类型：当前只支持 Node ESM 模块（内置驱动） */
export const PLUGIN_RUNTIME_TARGETS = ['node'] as const;
export type PluginRuntimeTarget = (typeof PLUGIN_RUNTIME_TARGETS)[number];

/** 插件向用户暴露的配置项（设置页据此自动渲染表单） */
export const pluginConfigFieldSchema = z.object({
  key: z.string().min(1),
  label: z.string().min(1),
  type: z.enum(['string', 'password', 'number', 'boolean', 'select', 'url']),
  required: z.boolean().default(false),
  default: z.unknown().optional(),
  placeholder: z.string().optional(),
  description: z.string().optional(),
  /** type=select 时的候选项 */
  options: z
    .array(z.object({ value: z.string(), label: z.string() }))
    .optional(),
});

export type PluginConfigField = z.infer<typeof pluginConfigFieldSchema>;

/** plugin.json 清单结构 */
export const pluginManifestSchema = z.object({
  /** 唯一标识，建议反向域名风格，如 com.example.my-webdav */
  id: z
    .string()
    .min(3)
    .max(64)
    .regex(/^[a-z0-9][a-z0-9._-]*$/, 'id 只能包含小写字母、数字、点、下划线和连字符'),
  name: z.string().min(1).max(64),
  version: z.string().regex(/^\d+\.\d+\.\d+/, '版本号需符合语义化版本规范'),
  /** 作者或组织 */
  author: z.string().max(64).optional(),
  description: z.string().max(512).optional(),
  homepage: z.url().optional(),
  license: z.string().max(32).optional(),

  /**
   * 兼容的 ReadSync 主版本范围（语义化版本 range），例如 ">=0.1.0 <0.2.0"。
   * 服务端在安装与加载时都会校验，避免插件与内核 API 不匹配。
   */
  apiVersion: z.string().min(1),

  /** 插件声明的能力，决定服务端授予哪些钩子 */
  capabilities: z.array(z.enum(PLUGIN_CAPABILITIES)).min(1),

  /** 入口文件，相对于插件根目录 */
  main: z.string().default('index.js'),
  runtime: z.enum(PLUGIN_RUNTIME_TARGETS).default('node'),

  /** 用户可配置项 */
  config: z.array(pluginConfigFieldSchema).default([]),

  /**
   * 需要访问的宿主能力。安装时会展示给管理员确认。
   * 未声明的能力即使插件调用也会被拒绝。
   */
  permissions: z
    .array(
      z.enum([
        'http', // 发起外部 HTTP 请求（用于调用网盘 API）
        'fs:data', // 读写插件自己的数据目录
        'fs:storage', // 读写服务器存储目录
        'log', // 输出日志
        'db:plugin', // 使用插件专属数据表
      ]),
    )
    .default([]),

  /** 插件提供的存储驱动定义（capabilities 含 storage 时必填） */
  storageDrivers: z
    .array(
      z.object({
        id: z.string().min(1),
        name: z.string().min(1),
        config: z.array(pluginConfigFieldSchema).default([]),
      }),
    )
    .default([]),

  /** 插件提供的同步协议定义（capabilities 含 sync 时必填） */
  syncProtocols: z
    .array(
      z.object({
        id: z.string().min(1),
        name: z.string().min(1),
        /** 路由挂载前缀，最终路径为 /api/plugins/{pluginId}{mountPath} */
        mountPath: z.string().startsWith('/'),
        description: z.string().optional(),
      }),
    )
    .default([]),
});

export type PluginManifest = z.infer<typeof pluginManifestSchema>;

/** 插件的安装状态与运行时信息 */
export interface PluginSummary {
  id: string;
  name: string;
  version: string;
  author: string | null;
  description: string | null;
  homepage: string | null;
  apiVersion: string;
  capabilities: (typeof PLUGIN_CAPABILITIES)[number][];
  permissions: string[];
  status: (typeof PLUGIN_STATUSES)[number];
  /** 加载失败时的错误信息 */
  error: string | null;
  /** 插件声明的配置项 */
  configFields: PluginConfigField[];
  /** 用户已填写的配置（敏感字段脱敏） */
  config: Record<string, unknown>;
  installedAt: string;
  updatedAt: string;
  /** 是否为内置插件（内置插件不可卸载） */
  builtin: boolean;
}

/** 安装/更新插件配置 */
export const pluginConfigUpdateSchema = z.object({
  config: z.record(z.string(), z.unknown()),
});

/** 插件对外暴露的钩子名。插件入口模块按需导出这些函数。 */
export const PLUGIN_HOOKS = [
  'onLoad', // 插件加载完成
  'onUnload', // 插件卸载/停用
  'onConfigChange', // 配置变更
  'onSyncPush', // 收到同步推送后
  'onBookUpload', // 书籍上传完成后
  'onUserRegister', // 新用户注册后
] as const;
export type PluginHook = (typeof PLUGIN_HOOKS)[number];

/**
 * 精简的 fetch 签名。
 *
 * shared 包不引入 DOM/Node 类型（tsconfig 里 lib 仅 ES2023、types 为空），
 * 这样前端与后端都能安全引用。宿主注入的 fetch 满足该签名。
 */
export type FetchLike = (
  input: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  },
) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
  json(): Promise<unknown>;
}>;

/** 插件上下文 API：由宿主注入给插件入口模块的 register() 函数 */
export interface PluginContext {
  /** 插件 id */
  pluginId: string;
  /** 结构化日志，自动带上插件 id 前缀 */
  log: {
    debug(msg: string, meta?: Record<string, unknown>): void;
    info(msg: string, meta?: Record<string, unknown>): void;
    warn(msg: string, meta?: Record<string, unknown>): void;
    error(msg: string, meta?: Record<string, unknown>): void;
  };
  /** 读取插件配置 */
  getConfig<T = Record<string, unknown>>(): T;
  /** 插件专属数据目录的绝对路径（仅当声明 fs:data 权限时可用） */
  dataDir: string;
  /** 发起 HTTP 请求（仅当声明 http 权限时可用） */
  fetch: FetchLike;
  /** 注册一个存储驱动实现 */
  registerStorageDriver(driverId: string, factory: unknown): void;
  /** 注册一个同步协议处理器 */
  registerSyncProtocol(protocolId: string, handler: unknown): void;
  /** 注册一个钩子回调 */
  on(hook: PluginHook, handler: (...args: unknown[]) => unknown | Promise<unknown>): void;
}

/** 插件入口模块的约定导出 */
export interface PluginModule {
  /** 插件激活入口，宿主在加载时调用一次 */
  register(ctx: PluginContext): void | Promise<void>;
  /** 可选：停用时的清理逻辑 */
  unregister?(): void | Promise<void>;
}
