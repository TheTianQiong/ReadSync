import { defineConfig } from 'drizzle-kit';

/**
 * drizzle-kit 配置，仅用于生成迁移文件：
 *   npm run db:generate --workspace @readsync/server
 *
 * 生成结果位于 packages/server/drizzle/，需要提交进仓库；
 * 服务启动时由 src/db/index.ts 自动应用。
 */
export default defineConfig({
  schema: './src/db/schema.ts',
  out: './drizzle',
  dialect: 'sqlite',
  dbCredentials: {
    url: './data/readsync.db',
  },
  verbose: true,
  strict: false,
});
