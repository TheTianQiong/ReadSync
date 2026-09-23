import { buildApp } from './app.js';
import { ConfigError, loadConfig } from './config.js';
import { ensureKeyPair, getKeyFingerprint } from './crypto/keys.js';
import { closeDatabase, openDatabase } from './db/index.js';
import { closeLogger, getLogger, printStartupBanner } from './logger.js';
import { loadPlugins } from './modules/plugins/loader.js';

/**
 * 监听端口，并在配置为 0.0.0.0 时优先采用 IPv6 双栈。
 *
 * 为什么不能简单地监听 0.0.0.0：
 * 它是**纯 IPv4**，此时连 [::1]:3000 会被拒绝。而 localhost 在不少系统上
 * 优先解析到 ::1，于是反向代理（cloudflared、nginx 的 localhost 上游）
 * 连不上源站，表现为 **502 Bad Gateway** —— 自托管场景非常常见的坑。
 *
 * 改用 `::`：Node 默认 ipv6Only=false，一个监听同时接受 IPv4 与 IPv6。
 * 系统未启用 IPv6 时再回退到 0.0.0.0。
 *
 * 注意不能「先听 0.0.0.0 再听 ::」——Fastify 不允许对同一实例调用两次
 * listen，会抛 FST_ERR_REOPENED_SERVER。必须一次选对地址。
 */
async function listenWithIpv6Fallback(
  app: Awaited<ReturnType<typeof buildApp>>,
  host: string,
  port: number,
  logger: ReturnType<typeof getLogger>,
): Promise<string> {
  // 只有通配地址才需要双栈处理；显式绑定的地址按用户意图尊重
  const candidates = host === '0.0.0.0' ? ['::', '0.0.0.0'] : [host];

  let lastError: unknown;
  for (const candidate of candidates) {
    try {
      await app.listen({ host: candidate, port });
      return candidate;
    } catch (err) {
      lastError = err;
      if (candidate !== candidates[candidates.length - 1]) {
        logger.warn({ err, host: candidate }, 'IPv6 监听不可用，回退到纯 IPv4');
      }
    }
  }

  throw lastError;
}

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

  const boundHost = await listenWithIpv6Fallback(
    app,
    config.READSYNC_HOST,
    config.READSYNC_PORT,
    logger,
  );

  if (boundHost !== config.READSYNC_HOST) {
    logger.info(
      { configured: config.READSYNC_HOST, actual: boundHost },
      '已按双栈方式监听（同时接受 IPv4 与 IPv6 连接）',
    );
  }

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
