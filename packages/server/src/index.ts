import { buildApp } from './app.js';
import { ConfigError, loadConfig } from './config.js';
import { ensureKeyPair, getKeyFingerprint } from './crypto/keys.js';
import { closeDatabase, openDatabase } from './db/index.js';
import { closeLogger, getLogger, printStartupBanner } from './logger.js';
import { loadPlugins } from './modules/plugins/loader.js';

/**
 * 服务入口。
 *
 * 启动顺序刻意如此：配置 → 日志 → 密钥 → 数据库 → 插件 → HTTP 监听。
 * 任何一步失败都给出可读的中文提示并退出，避免半启动状态（端口占着但功能不可用）。
 */
async function main(): Promise<void> {
  // 1. 配置校验（失败时 ConfigError 会带上具体的环境变量名）
  const config = loadConfig();

  // 2. 日志（后续所有输出都走它，带版本号）
  const logger = getLogger();

  // 3. RSA 密钥对：首次启动生成，用于前端加密密码
  ensureKeyPair();

  // 4. 数据库连接与迁移
  openDatabase();

  // 5. 加载已启用的插件（失败不影响主服务启动，只记录错误）
  try {
    await loadPlugins();
  } catch (err) {
    logger.error({ err }, '插件加载过程中出现错误，服务将继续启动');
  }

  // 6. 组装并监听
  const app = await buildApp();

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, '收到退出信号，正在关闭服务…');
    try {
      await app.close();
      closeDatabase();
      closeLogger();
      logger.info('服务已安全退出');
      process.exit(0);
    } catch (err) {
      logger.error({ err }, '关闭过程中出错');
      process.exit(1);
    }
  };

  // 容器里 PID 1 需要显式处理信号，否则 docker stop 会等满 10 秒才 SIGKILL
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  process.on('unhandledRejection', (reason) => {
    logger.error({ err: reason }, '未处理的 Promise 拒绝');
  });
  process.on('uncaughtException', (err) => {
    logger.fatal({ err }, '未捕获的异常，进程即将退出');
    process.exit(1);
  });

  await app.listen({ host: config.READSYNC_HOST, port: config.READSYNC_PORT });

  // 7. 启动横幅（README 总体要求 1.2：版本信息显示在后端启动输出内）
  printStartupBanner({
    host: config.READSYNC_HOST,
    port: config.READSYNC_PORT,
    dataDir: config.dataDir,
    databaseFile: config.databaseFile,
    webEnabled: config.READSYNC_SERVE_WEB,
    secretGenerated: config.secretGenerated,
    publicKeyFingerprint: getKeyFingerprint(),
  });
}

main().catch((err: unknown) => {
  if (err instanceof ConfigError) {
    // 配置错误是使用者最容易犯也最容易修的，单独用友好格式输出
    console.error('\n启动失败：配置有误\n');
    console.error(err.message);
    console.error('\n请参考项目根目录的 .env.example 补齐上述环境变量。\n');
    process.exit(1);
  }

  console.error('\n启动失败：', err instanceof Error ? err.message : err);
  if (err instanceof Error && err.stack) {
    console.error(err.stack);
  }
  process.exit(1);
});
