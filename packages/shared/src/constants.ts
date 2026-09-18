/**
 * 全局枚举与常量。
 *
 * 这些值同时被后端数据库（作为 TEXT 列存储）、REST API、CLI 参数和前端下拉框使用，
 * 因此集中定义在这里，避免前后端出现字面量漂移。
 */

/** 用户角色。admin 可访问「设置管理后台」 */
export const USER_ROLES = ['admin', 'user'] as const;
export type UserRole = (typeof USER_ROLES)[number];

/** 用户状态。disabled 用户无法登录，但数据保留 */
export const USER_STATUSES = ['active', 'disabled'] as const;
export type UserStatus = (typeof USER_STATUSES)[number];

/** 用户通过的认证方式 */
export const AUTH_METHODS = ['password', 'totp', 'passkey'] as const;
export type AuthMethod = (typeof AUTH_METHODS)[number];

/**
 * 存储驱动类型。
 * - local  : 服务器本地磁盘（容量有限，README 建议仅作中转与缓存）
 * - webdav : 坚果云、Nextcloud 等 WebDAV 网盘
 * - s3     : 兼容 S3 协议的对象存储（阿里云 OSS、腾讯云 COS、MinIO、R2 等）
 * - plugin : 由插件提供的自定义驱动
 */
export const STORAGE_DRIVERS = ['local', 'webdav', 's3', 'plugin'] as const;
export type StorageDriver = (typeof STORAGE_DRIVERS)[number];

/** 对象存储的寻址风格 */
export const S3_ADDRESSING_STYLES = ['path', 'virtual-host'] as const;
export type S3AddressingStyle = (typeof S3_ADDRESSING_STYLES)[number];

/**
 * 同步协议。
 * - kosync   : KOReader 原生进度同步协议（兼容第三方阅读器）
 * - readsync : 本项目统一同步接口，供其他阅读软件开发者接入
 * - plugin   : 由插件提供的自定义协议
 */
export const SYNC_PROTOCOLS = ['kosync', 'readsync', 'plugin'] as const;
export type SyncProtocol = (typeof SYNC_PROTOCOLS)[number];

/**
 * 书籍文件格式。
 * README 要求支持 *.zip、*.json 等常见类型，因此这里覆盖电子书与数据文件两类。
 */
export const BOOK_FORMATS = [
  'epub',
  'pdf',
  'mobi',
  'azw3',
  'azw',
  'fb2',
  'txt',
  'cbz',
  'cbr',
  'djvu',
  'zip',
  'json',
  'other',
] as const;
export type BookFormat = (typeof BOOK_FORMATS)[number];

/** 书籍阅读状态 */
export const READING_STATUSES = ['unread', 'reading', 'finished', 'paused', 'abandoned'] as const;
export type ReadingStatus = (typeof READING_STATUSES)[number];

/**
 * 内置阅读平台标识。
 * 用户也可在「设置 → 阅读平台」里自定义平台，此时 platform 字段为任意字符串。
 */
export const BUILTIN_PLATFORMS = [
  'koreader',
  'kindle',
  'apple_books',
  'wechat_read',
  'duokan',
  'neat_reader',
  'other',
] as const;
export type BuiltinPlatform = (typeof BUILTIN_PLATFORMS)[number];

/** 内置平台的中文显示名 */
export const PLATFORM_LABELS: Record<BuiltinPlatform, string> = {
  koreader: 'KOReader',
  kindle: 'Kindle',
  apple_books: 'Apple Books',
  wechat_read: '微信读书',
  duokan: '多看阅读',
  neat_reader: 'Neat Reader',
  other: '其他',
};

/**
 * 插件能力声明。
 * 插件在 manifest 中声明自己需要哪些能力，服务端据此授予对应钩子与权限。
 */
export const PLUGIN_CAPABILITIES = [
  'storage', // 提供存储驱动
  'sync', // 提供同步协议
  'auth', // 提供认证方式
  'notification', // 发送通知
  'metadata', // 抓取/补全书籍元数据
  'dashboard', // 向首页提供自定义图表卡片
] as const;
export type PluginCapability = (typeof PLUGIN_CAPABILITIES)[number];

/** 插件运行状态 */
export const PLUGIN_STATUSES = ['enabled', 'disabled', 'error'] as const;
export type PluginStatus = (typeof PLUGIN_STATUSES)[number];

/** 首页可自定义显示的图表卡片（README 前端要求 5） */
export const DASHBOARD_WIDGETS = [
  'reading_time_trend', // 阅读时长趋势
  'platform_distribution', // 阅读平台分布
  'reading_heatmap', // 阅读热力图
  'recent_books', // 最近在读
  'library_overview', // 书库概览
  'sync_status', // 同步状态
] as const;
export type DashboardWidget = (typeof DASHBOARD_WIDGETS)[number];

/** 图表统计的时间粒度 */
export const STAT_GRANULARITIES = ['day', 'week', 'month', 'year'] as const;
export type StatGranularity = (typeof STAT_GRANULARITIES)[number];

/** 主题偏好（README 前端要求 1：白天/夜晚/跟随系统） */
export const THEME_PREFERENCES = ['light', 'dark', 'system'] as const;
export type ThemePreference = (typeof THEME_PREFERENCES)[number];

/** 邮件服务商 */
export const MAIL_PROVIDERS = ['resend', 'smtp', 'console'] as const;
export type MailProvider = (typeof MAIL_PROVIDERS)[number];

/** 审计日志动作类型 */
export const AUDIT_ACTIONS = [
  'user.register',
  'user.login',
  'user.login_failed',
  'user.logout',
  'user.password_change',
  'user.password_reset',
  'user.update',
  'user.disable',
  'user.enable',
  'user.delete',
  'user.role_change',
  'auth.2fa_enable',
  'auth.2fa_disable',
  'auth.passkey_add',
  'auth.passkey_remove',
  'storage.create',
  'storage.update',
  'storage.delete',
  'book.upload',
  'book.download',
  'book.delete',
  'sync.push',
  'sync.pull',
  'admin.settings_update',
  'admin.invite_create',
  'admin.invite_revoke',
  'plugin.install',
  'plugin.enable',
  'plugin.disable',
  'plugin.uninstall',
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

/** 默认分页大小 */
export const DEFAULT_PAGE_SIZE = 20;
/** 分页大小上限，防止一次拉取过多数据 */
export const MAX_PAGE_SIZE = 100;

/** 同步进度的默认最大长度限制（KOSync 的 progress 字段） */
export const MAX_SYNC_PROGRESS_LENGTH = 4096;
/** KOSync 协议中 document 标识的最大长度 */
export const MAX_DOCUMENT_ID_LENGTH = 512;
