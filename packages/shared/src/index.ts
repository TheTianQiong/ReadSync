/**
 * @readsync/shared
 *
 * 前后端共享的契约层：枚举常量、zod 校验 schema、DTO 类型。
 * 后端用它做请求校验，前端用它做表单校验与类型提示，保证两端规则一致。
 */

export * from './version.js';
export * from './constants.js';

export * from './schemas/common.js';
export * from './schemas/auth.js';
export * from './schemas/user.js';
export * from './schemas/storage.js';
export * from './schemas/book.js';
export * from './schemas/sync.js';
export * from './schemas/stats.js';
export * from './schemas/plugin.js';
export * from './schemas/admin.js';
