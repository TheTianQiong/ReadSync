import { sql } from 'drizzle-orm';
import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

/**
 * 数据库结构（SQLite）。
 *
 * 约定：
 *  - 主键统一用自增整数 `id`。JSON 序列化时若担心精度可转字符串，但 SQLite
 *    的 rowid 远达不到 2^53，实际不会溢出。
 *  - 时间统一用 `integer({ mode: 'timestamp_ms' })`，Drizzle 自动与 Date 互转。
 *  - 布尔用 integer mode:'boolean'（SQLite 无原生布尔）。
 *  - 枚举类字段用 text + $type<...>()，取值受 @readsync/shared 里的常量约束。
 *  - 需要保密的字段（存储凭据、TOTP 密钥）以 `Encrypted` 结尾，落库前用
 *    crypto/secret-box.ts 加密。
 */

/** 用户 */
export const users = sqliteTable(
  'users',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    username: text('username').notNull(),
    email: text('email').notNull(),
    displayName: text('display_name'),
    avatarUrl: text('avatar_url'),

    /** Argon2id 哈希，格式 $argon2id$v=19$m=...；永不存明文 */
    passwordHash: text('password_hash').notNull(),

    /**
     * KOSync 兼容用的凭据：KOReader 客户端固定发送 md5(密码) 作为 x-auth-key，
     * 服务端无法要求它改用 Argon2。这里保存用户「同步密码」的 md5（小写十六进制）。
     * 用户在设置页可单独设置同步密码，避免主密码的 md5 被用于撞库。
     */
    kosyncKey: text('kosync_key'),

    role: text('role').$type<'admin' | 'user'>().notNull().default('user'),
    status: text('status').$type<'active' | 'disabled'>().notNull().default('active'),

    /** TOTP 密钥（加密存储） */
    totpSecretEncrypted: text('totp_secret_encrypted'),
    totpEnabled: integer('totp_enabled', { mode: 'boolean' }).notNull().default(false),
    /** 上次成功校验的 TOTP 时间步，用于防重放 */
    totpLastTimeStep: integer('totp_last_time_step'),

    /** 个人偏好（主题、首页布局等），JSON */
    preferences: text('preferences', { mode: 'json' }).$type<Record<string, unknown>>(),

    /** 该用户的同步令牌版本；自增后旧 token 全部失效（改密/登出所有设备时用） */
    tokenVersion: integer('token_version').notNull().default(0),

    lastLoginAt: integer('last_login_at', { mode: 'timestamp_ms' }),
    lastLoginIp: text('last_login_ip'),

    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (t) => [
    uniqueIndex('users_username_unique').on(t.username),
    uniqueIndex('users_email_unique').on(t.email),
    index('users_role_idx').on(t.role),
    index('users_status_idx').on(t.status),
  ],
);

/** 会话（refresh token 落库，便于「登出所有设备」与设备管理） */
export const sessions = sqliteTable(
  'sessions',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** refresh token 的 SHA-256，绝不存明文 */
    tokenHash: text('token_hash').notNull(),
    /** token 家族 id：检测到重放时整族吊销 */
    familyId: text('family_id').notNull(),
    device: text('device'),
    userAgent: text('user_agent'),
    ip: text('ip'),
    expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
    revokedAt: integer('revoked_at', { mode: 'timestamp_ms' }),
    lastUsedAt: integer('last_used_at', { mode: 'timestamp_ms' }),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (t) => [
    uniqueIndex('sessions_token_hash_unique').on(t.tokenHash),
    index('sessions_user_idx').on(t.userId),
    index('sessions_family_idx').on(t.familyId),
  ],
);

/** 通行密钥（WebAuthn / Passkey） */
export const passkeys = sqliteTable(
  'passkeys',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** 凭据 ID（Base64URL） */
    credentialId: text('credential_id').notNull(),
    publicKey: text('public_key').notNull(),
    /** 签名计数器，用于克隆检测 */
    counter: integer('counter').notNull().default(0),
    deviceType: text('device_type'),
    backedUp: integer('backed_up', { mode: 'boolean' }).notNull().default(false),
    transports: text('transports', { mode: 'json' }).$type<string[]>(),
    name: text('name'),
    lastUsedAt: integer('last_used_at', { mode: 'timestamp_ms' }),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (t) => [
    uniqueIndex('passkeys_credential_unique').on(t.credentialId),
    index('passkeys_user_idx').on(t.userId),
  ],
);

/** TOTP 恢复码（一次性，使用后标记） */
export const recoveryCodes = sqliteTable(
  'recovery_codes',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** 恢复码的 Argon2 哈希 */
    codeHash: text('code_hash').notNull(),
    usedAt: integer('used_at', { mode: 'timestamp_ms' }),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (t) => [index('recovery_codes_user_idx').on(t.userId)],
);

/** 邮箱验证码（忘记密码、邮箱验证共用） */
export const emailCodes = sqliteTable(
  'email_codes',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    email: text('email').notNull(),
    /** 6 位数字码的哈希 */
    codeHash: text('code_hash').notNull(),
    purpose: text('purpose').$type<'password_reset' | 'email_verify'>().notNull(),
    expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
    consumedAt: integer('consumed_at', { mode: 'timestamp_ms' }),
    /** 尝试次数，超过上限直接作废，防止暴力猜码 */
    attempts: integer('attempts').notNull().default(0),
    ip: text('ip'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (t) => [
    index('email_codes_email_idx').on(t.email),
    index('email_codes_purpose_idx').on(t.purpose),
  ],
);

/** 邀请码 */
export const inviteCodes = sqliteTable(
  'invite_codes',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    code: text('code').notNull(),
    maxUses: integer('max_uses').notNull().default(1),
    usedCount: integer('used_count').notNull().default(0),
    expiresAt: integer('expires_at', { mode: 'timestamp_ms' }),
    note: text('note'),
    createdBy: integer('created_by')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (t) => [uniqueIndex('invite_codes_code_unique').on(t.code), index('invite_codes_created_by_idx').on(t.createdBy)],
);

/** 存储后端配置（WebDAV / S3 / 本地 / 插件） */
export const storages = sqliteTable(
  'storages',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    driver: text('driver').$type<'local' | 'webdav' | 's3' | 'plugin'>().notNull(),
    /** 驱动配置，JSON；敏感字段在写入前加密（见 crypto/secret-box.ts） */
    config: text('config', { mode: 'json' }).$type<Record<string, unknown>>().notNull(),
    isDefault: integer('is_default', { mode: 'boolean' }).notNull().default(false),
    readOnly: integer('read_only', { mode: 'boolean' }).notNull().default(false),
    enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),

    lastCheckAt: integer('last_check_at', { mode: 'timestamp_ms' }),
    lastCheckOk: integer('last_check_ok', { mode: 'boolean' }),
    lastCheckMessage: text('last_check_message'),
    /** 已用容量（字节），由定期扫描或上传累加更新 */
    usedBytes: integer('used_bytes'),

    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (t) => [index('storages_user_idx').on(t.userId), index('storages_driver_idx').on(t.driver)],
);

/** 书籍 */
export const books = sqliteTable(
  'books',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    ownerId: integer('owner_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    author: text('author'),
    publisher: text('publisher'),
    isbn: text('isbn'),
    format: text('format').notNull().default('epub'),
    /** 当前版本的文件大小与 MD5（历史版本见 book_versions） */
    size: integer('size').notNull().default(0),
    md5: text('md5').notNull(),
    objectKey: text('object_key').notNull(),
    storageId: integer('storage_id')
      .notNull()
      .references(() => storages.id, { onDelete: 'restrict' }),
    currentVersion: integer('current_version').notNull().default(1),

    coverUrl: text('cover_url'),
    description: text('description'),
    tags: text('tags', { mode: 'json' }).$type<string[]>().notNull().default(sql`'[]'`),
    language: text('language'),

    readingStatus: text('reading_status')
      .$type<'unread' | 'reading' | 'finished' | 'paused' | 'abandoned'>()
      .notNull()
      .default('unread'),
    /** 阅读进度百分比 0-100（由同步进度换算并保留） */
    progressPercent: integer('progress_percent').notNull().default(0),
    totalPages: integer('total_pages'),
    totalWords: integer('total_words'),

    /** 该书累计阅读秒数（冗余字段，便于列表排序；权威数据在 reading_sessions） */
    totalReadingSeconds: integer('total_reading_seconds').notNull().default(0),
    lastReadAt: integer('last_read_at', { mode: 'timestamp_ms' }),

    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (t) => [
    index('books_owner_idx').on(t.ownerId),
    // 秒传/去重：同一用户下 MD5 唯一
    uniqueIndex('books_owner_md5_unique').on(t.ownerId, t.md5),
    index('books_storage_idx').on(t.storageId),
    index('books_reading_status_idx').on(t.readingStatus),
    index('books_last_read_idx').on(t.lastReadAt),
  ],
);

/** 书籍文件版本历史 */
export const bookVersions = sqliteTable(
  'book_versions',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    bookId: integer('book_id')
      .notNull()
      .references(() => books.id, { onDelete: 'cascade' }),
    version: integer('version').notNull(),
    size: integer('size').notNull(),
    md5: text('md5').notNull(),
    objectKey: text('object_key').notNull(),
    storageId: integer('storage_id')
      .notNull()
      .references(() => storages.id, { onDelete: 'restrict' }),
    note: text('note'),
    uploadedBy: integer('uploaded_by')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (t) => [
    uniqueIndex('book_versions_unique').on(t.bookId, t.version),
    index('book_versions_book_idx').on(t.bookId),
  ],
);

/**
 * 同步条目：KOSync 与统一接口共用同一张表。
 * KOSync 的 document/progress/percentage/device/device_id 字段一一对应。
 */
export const syncEntries = sqliteTable(
  'sync_entries',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    document: text('document').notNull(),
    title: text('title'),
    progress: text('progress').notNull(),
    /** 0-1 之间 */
    percentage: integer('percentage_scaled').notNull().default(0),
    platform: text('platform').notNull().default('other'),
    device: text('device').notNull().default('unknown'),
    deviceId: text('device_id').notNull().default('unknown'),
    /** 关联的书籍（若 document 能匹配到书库中的书） */
    bookId: integer('book_id').references(() => books.id, { onDelete: 'set null' }),
    /** 客户端上报的时间，用于离线补传时判定新旧 */
    clientTime: integer('client_time', { mode: 'timestamp_ms' }),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (t) => [
    uniqueIndex('sync_entries_user_document_unique').on(t.userId, t.document),
    index('sync_entries_user_idx').on(t.userId),
    index('sync_entries_updated_idx').on(t.updatedAt),
    index('sync_entries_book_idx').on(t.bookId),
  ],
);

/**
 * 阅读会话：统计的权威数据源。
 * 每次同步上报的 readingSeconds 会累加进当天的会话记录。
 */
export const readingSessions = sqliteTable(
  'reading_sessions',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    bookId: integer('book_id').references(() => books.id, { onDelete: 'set null' }),
    document: text('document'),
    platform: text('platform').notNull().default('other'),
    device: text('device').notNull().default('unknown'),
    /** 会话时长（秒） */
    seconds: integer('seconds').notNull().default(0),
    /** 会话所属日期，YYYY-MM-DD，按用户时区归集，便于按天聚合 */
    day: text('day').notNull(),
    /** 小时 0-23，用于热力图 */
    hour: integer('hour').notNull().default(0),
    /** 星期 0-6（0=周日），用于热力图 */
    weekday: integer('weekday').notNull().default(0),
    progressPercent: integer('progress_percent'),
    startedAt: integer('started_at', { mode: 'timestamp_ms' }).notNull(),
    endedAt: integer('ended_at', { mode: 'timestamp_ms' }),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (t) => [
    index('reading_sessions_user_day_idx').on(t.userId, t.day),
    index('reading_sessions_user_idx').on(t.userId),
    index('reading_sessions_book_idx').on(t.bookId),
    index('reading_sessions_platform_idx').on(t.platform),
  ],
);

/** 用户自定义阅读平台 */
export const readingPlatforms = sqliteTable(
  'reading_platforms',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    platformId: text('platform_id').notNull(),
    label: text('label').notNull(),
    icon: text('icon'),
    color: text('color'),
    builtin: integer('builtin', { mode: 'boolean' }).notNull().default(false),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (t) => [uniqueIndex('reading_platforms_user_platform_unique').on(t.userId, t.platformId)],
);

/** 第三方接入令牌（统一同步接口用） */
export const syncTokens = sqliteTable(
  'sync_tokens',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    /** 令牌的 SHA-256 */
    tokenHash: text('token_hash').notNull(),
    /** 展示用前缀，如 rs_ab12… */
    tokenPrefix: text('token_prefix').notNull(),
    scopes: text('scopes', { mode: 'json' }).$type<string[]>().notNull().default(sql`'[]'`),
    lastUsedAt: integer('last_used_at', { mode: 'timestamp_ms' }),
    expiresAt: integer('expires_at', { mode: 'timestamp_ms' }),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (t) => [uniqueIndex('sync_tokens_hash_unique').on(t.tokenHash), index('sync_tokens_user_idx').on(t.userId)],
);

/** 站点设置：单行 key-value，避免为每个开关加列 */
export const serverSettings = sqliteTable('server_settings', {
  key: text('key').primaryKey(),
  value: text('value', { mode: 'json' }).$type<unknown>(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
    .notNull()
    .default(sql`(unixepoch() * 1000)`),
});

/** 已安装插件 */
export const plugins = sqliteTable(
  'plugins',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    pluginId: text('plugin_id').notNull(),
    name: text('name').notNull(),
    version: text('version').notNull(),
    /** 完整清单，避免每次加载都读磁盘 */
    manifest: text('manifest', { mode: 'json' }).$type<Record<string, unknown>>().notNull(),
    status: text('status').$type<'enabled' | 'disabled' | 'error'>().notNull().default('disabled'),
    /** 加载失败原因 */
    error: text('error'),
    /** 用户填写的配置（敏感项加密） */
    config: text('config', { mode: 'json' }).$type<Record<string, unknown>>(),
    builtin: integer('builtin', { mode: 'boolean' }).notNull().default(false),
    installedBy: integer('installed_by').references(() => users.id, { onDelete: 'set null' }),
    installedAt: integer('installed_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (t) => [uniqueIndex('plugins_plugin_id_unique').on(t.pluginId), index('plugins_status_idx').on(t.status)],
);

/** 插件专属键值存储（声明 db:plugin 权限后可用） */
export const pluginData = sqliteTable(
  'plugin_data',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    pluginId: text('plugin_id').notNull(),
    key: text('key').notNull(),
    value: text('value', { mode: 'json' }).$type<unknown>(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (t) => [uniqueIndex('plugin_data_unique').on(t.pluginId, t.key)],
);

/** 审计日志 */
export const auditLogs = sqliteTable(
  'audit_logs',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    userId: integer('user_id').references(() => users.id, { onDelete: 'set null' }),
    /** 冗余用户名，用户被删除后日志仍可读 */
    username: text('username'),
    action: text('action').notNull(),
    target: text('target'),
    ip: text('ip'),
    userAgent: text('user_agent'),
    meta: text('meta', { mode: 'json' }).$type<Record<string, unknown>>(),
    success: integer('success', { mode: 'boolean' }).notNull().default(true),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (t) => [
    index('audit_logs_user_idx').on(t.userId),
    index('audit_logs_action_idx').on(t.action),
    index('audit_logs_created_idx').on(t.createdAt),
  ],
);

/* ------------------------------ 类型导出 ------------------------------ */

export type UserRow = typeof users.$inferSelect;
export type NewUserRow = typeof users.$inferInsert;
export type SessionRow = typeof sessions.$inferSelect;
export type StorageRow = typeof storages.$inferSelect;
export type BookRow = typeof books.$inferSelect;
export type BookVersionRow = typeof bookVersions.$inferSelect;
export type SyncEntryRow = typeof syncEntries.$inferSelect;
export type ReadingSessionRow = typeof readingSessions.$inferSelect;
export type PluginRow = typeof plugins.$inferSelect;
export type AuditLogRow = typeof auditLogs.$inferSelect;
export type InviteCodeRow = typeof inviteCodes.$inferSelect;
export type PasskeyRow = typeof passkeys.$inferSelect;
export type SyncTokenRow = typeof syncTokens.$inferSelect;
export type ReadingPlatformRow = typeof readingPlatforms.$inferSelect;
