import pino, { type Logger } from 'pino';
import { APP_NAME, APP_NAME_CN, VERSION } from '@readsync/shared';
import { loadConfig } from './config.js';
import { hLine, padDisplayEnd, truncateDisplay } from './lib/text.js';

/**
 * 标准日志输出（README 后端要求 2）。
 *
 * - 生产环境输出单行 JSON，便于被 journald / Docker logs / Loki 采集。
 * - 开发环境（或 READSYNC_LOG_PRETTY=true）输出彩色可读格式。
 * - 所有日志都带 service/version 字段，方便多版本混跑时区分。
 */

let rootLogger: Logger | null = null;

export function createLogger(): Logger {
  if (rootLogger) return rootLogger;

  const config = loadConfig();
  const usePretty = config.READSYNC_LOG_PRETTY || config.NODE_ENV === 'development';

  rootLogger = pino({
    level: config.READSYNC_LOG_LEVEL,
    base: {
      service: APP_NAME.toLowerCase(),
      version: VERSION,
      env: config.NODE_ENV,
    },
    timestamp: pino.stdTimeFunctions.isoTime,
    // 避免把密码、令牌等敏感字段写进日志
    redact: {
      paths: [
        'password',
        '*.password',
        'newPassword',
        'oldPassword',
        '*.newPassword',
        '*.oldPassword',
        'token',
        '*.token',
        'accessToken',
        'refreshToken',
        '*.accessToken',
        '*.refreshToken',
        'secret',
        '*.secret',
        'apiKey',
        '*.apiKey',
        'secretAccessKey',
        '*.secretAccessKey',
        'authorization',
        'req.headers.authorization',
        'req.headers["x-auth-key"]',
        'req.headers.cookie',
      ],
      censor: '[已脱敏]',
    },
    ...(usePretty
      ? {
          transport: {
            target: 'pino-pretty',
            options: {
              colorize: true,
              translateTime: 'SYS:yyyy-mm-dd HH:MM:ss.l',
              ignore: 'pid,hostname,service,env',
              messageFormat: '{msg}',
            },
          },
        }
      : {}),
  });

  return rootLogger;
}

/** 获取根 logger（首次调用时初始化） */
export function getLogger(): Logger {
  return rootLogger ?? createLogger();
}

/** 创建带模块名的子 logger，例如 getModuleLogger('auth') */
export function getModuleLogger(module: string): Logger {
  return getLogger().child({ module });
}

/**
 * 启动横幅（README 总体要求 1.2：版本信息显示在后端启动输出内）。
 * 用 ASCII 边框保证在各类终端与 Docker logs 里都对齐可读。
 */
export function printStartupBanner(opts: {
  host: string;
  port: number;
  dataDir: string;
  databaseFile: string;
  webEnabled: boolean;
  secretGenerated: boolean;
  publicKeyFingerprint: string;
}): void {
  const logger = getLogger();

  // 边框内部可用宽度（不含两侧的 "│"）。中文占两列，必须按显示宽度而非
  // 字符数来补齐，否则边框会呈锯齿状。
  const INNER = 58;
  const line = hLine(INNER);
  const row = (text: string): string => `│${padDisplayEnd(` ${text}`, INNER)}│`;

  const rows: Array<[string, string]> = [
    ['版本', `v${VERSION}`],
    ['监听地址', `http://${opts.host === '0.0.0.0' ? 'localhost' : opts.host}:${opts.port}`],
    ['数据目录', opts.dataDir],
    ['数据库', opts.databaseFile],
    ['前端托管', opts.webEnabled ? '已启用' : '未启用（仅 API）'],
    ['公钥指纹', opts.publicKeyFingerprint],
  ];

  // 标签列按显示宽度对齐到 12 列（「数据目录」= 8 列 + 4 空格）
  const LABEL_WIDTH = 12;
  const lines = [
    '',
    `┌${line}┐`,
    row(`${APP_NAME_CN} ${APP_NAME}  v${VERSION}`),
    `├${line}┤`,
    ...rows.map(([k, v]) => row(`${padDisplayEnd(k, LABEL_WIDTH)}${truncateDisplay(v, INNER - 2 - LABEL_WIDTH)}`)),
    `└${line}┘`,
  ];

  // 用 info 输出多行横幅，保持结构化日志里也是一条记录
  logger.info(lines.join('\n'));

  if (opts.secretGenerated) {
    logger.warn(
      '本次启动自动生成了主密钥（data/secret.key）。该密钥用于加密存储后端凭据，' +
        '请与数据目录一同备份；丢失后已保存的 WebDAV / S3 密码将无法解密。',
    );
  }
}

/** 关闭日志（进程退出前刷新缓冲） */
export function closeLogger(): void {
  rootLogger?.flush?.();
}
