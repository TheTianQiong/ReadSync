#!/usr/bin/env node
/**
 * ReadSync 命令行工具。
 *
 * 需求（README 后端要求 1）：「前端能操作的功能，后端也应可以通过指令实现」。
 * 因此这里覆盖用户管理、存储、插件、邀请码、同步令牌、站点设置、书库与系统信息，
 * 便于在无浏览器（服务器运维、容器内、自动化脚本）的场景下完成同样的操作。
 *
 * 用法：readsync <命令> [子命令] [选项]
 * 帮助：readsync --help
 */
import { Command } from 'commander';
import { and, desc, eq, like, or, sql } from 'drizzle-orm';
import { APP_NAME_CN, USER_ROLES, VERSION, passwordSchema } from '@readsync/shared';
import { loadConfig, ConfigError } from './config.js';
import { ensureKeyPair, getKeyFingerprint } from './crypto/keys.js';
import {
  generateInviteCode,
  generateSyncPassword,
  generateToken,
  hashPassword,
  md5Hex,
  safeEqualHex,
  sha256Hex,
} from './crypto/password.js';
import { closeDatabase, getDb, openDatabase } from './db/index.js';
import {
  auditLogs,
  books,
  inviteCodes,
  plugins as pluginsTable,
  storages,
  syncEntries,
  syncTokens,
  users,
} from './db/schema.js';
import { getSiteSettings, patchSiteSettings } from './lib/settings.js';
import { displayWidth, hLine, padDisplayEnd } from './lib/text.js';
import { createUser, findUserByLogin, findUserByLoginLoose, toSessionUser } from './lib/users.js';

/* ------------------------------ 输出helpers ------------------------------ */

const color = {
  reset: '[0m',
  dim: '[2m',
  bold: '[1m',
  green: '[32m',
  red: '[31m',
  yellow: '[33m',
  cyan: '[36m',
};

/** 是否支持彩色输出（管道/重定向时关闭，避免日志里混入转义序列） */
const useColor = process.stdout.isTTY === true && process.env.NO_COLOR === undefined;
const c = (code: string, text: string): string => (useColor ? `${code}${text}${color.reset}` : text);

const ok = (msg: string): void => console.log(`${c(color.green, '✓')} ${msg}`);
const info = (msg: string): void => console.log(`${c(color.cyan, 'ℹ')} ${msg}`);
const warn = (msg: string): void => console.log(`${c(color.yellow, '!')} ${msg}`);
const fail = (msg: string): void => console.error(`${c(color.red, '✗')} ${msg}`);

/**
 * 以对齐的表格输出列表。
 *
 * 列宽按**显示宽度**计算：中文字符在终端占两列，若按 String.length 补齐，
 * 含中文的表格会明显错位。带 ANSI 颜色的单元格需按去色后的宽度补齐。
 */
function table(rows: Array<Record<string, unknown>>, columns?: string[]): void {
  if (rows.length === 0) {
    console.log(c(color.dim, '（空）'));
    return;
  }

  const GAP = '  ';
  const cols = columns ?? Object.keys(rows[0]!);
  // 去掉 ANSI 转义序列再量宽度，否则彩色单元格会被算多
  const plain = (v: unknown): string => String(v ?? '').replace(/\[[0-9;]*m/g, '');

  const widths = cols.map((col) =>
    Math.max(displayWidth(col), ...rows.map((r) => displayWidth(plain(r[col])))),
  );

  console.log(cols.map((col, i) => c(color.bold, padDisplayEnd(col, widths[i]!))).join(GAP));
  console.log(c(color.dim, widths.map((w) => hLine(w)).join(GAP)));

  for (const row of rows) {
    console.log(
      cols
        .map((col, i) => {
          // 先按显示宽度补空格再上色：转义序列本身不占列，混在一起无法正确对齐
          const raw = String(row[col] ?? '');
          return raw + ' '.repeat(Math.max(0, widths[i]! - displayWidth(plain(raw))));
        })
        .join(GAP),
    );
  }
}

/** 把可能为 undefined 的值转成展示文本 */
const show = (v: unknown): string => (v === null || v === undefined || v === '' ? '-' : String(v));
const showDate = (v: Date | null | undefined): string => (v ? v.toISOString().slice(0, 19).replace('T', ' ') : '-');

/** 统一的错误出口 */
function die(err: unknown): never {
  if (err instanceof Error && err.message.includes('已被')) {
    fail(err.message);
  } else {
    fail(err instanceof Error ? err.message : String(err));
  }
  process.exit(1);
}

/** 包装 action，统一打开数据库、捕获异常、确保关闭 */
function withDb<T extends unknown[]>(fn: (...args: T) => Promise<void> | void) {
  return async (...args: T): Promise<void> => {
    try {
      openDatabase();
      await fn(...args);
    } catch (err) {
      die(err);
    } finally {
      closeDatabase();
    }
  };
}

/** 按用户名或 id 找用户，找不到直接报错退出 */
function requireUser(identifier: string) {
  const db = getDb();
  const asId = Number(identifier);
  const row = Number.isInteger(asId) && asId > 0
    ? db.select().from(users).where(eq(users.id, asId)).get()
    : findUserByLogin(identifier);

  if (!row) {
    fail(`找不到用户：${identifier}`);
    process.exit(1);
  }
  return row;
}

/* --------------------------------- 程序 --------------------------------- */

const program = new Command();

program
  .name('readsync')
  .description(`${APP_NAME_CN} ReadSync 命令行工具`)
  .version(VERSION, '-v, --version', '显示版本号')
  .option('--json', '以 JSON 输出，便于脚本处理');

program.configureHelp({ sortSubcommands: true });

/* ------------------------------- 系统信息 ------------------------------- */

program
  .command('info')
  .description('显示服务与数据概览')
  .action(
    withDb(async () => {
      const config = loadConfig();
      const db = getDb();

      const rows = {
        用户: db.select({ v: sql<number>`count(*)` }).from(users).get()?.v ?? 0,
        书籍: db.select({ v: sql<number>`count(*)` }).from(books).get()?.v ?? 0,
        存储配置: db.select({ v: sql<number>`count(*)` }).from(storages).get()?.v ?? 0,
        同步条目: db.select({ v: sql<number>`count(*)` }).from(syncEntries).get()?.v ?? 0,
        插件: db.select({ v: sql<number>`count(*)` }).from(pluginsTable).get()?.v ?? 0,
      };

      if (program.opts().json) {
        console.log(
          JSON.stringify(
            {
              version: VERSION,
              dataDir: config.dataDir,
              database: config.databaseFile,
              publicKeyFingerprint: getKeyFingerprint(),
              counts: rows,
            },
            null,
            2,
          ),
        );
        return;
      }

      console.log(`\n${c(color.bold, `${APP_NAME_CN} ReadSync`)} ${c(color.dim, `v${VERSION}`)}\n`);
      console.log(`  数据目录    ${config.dataDir}`);
      console.log(`  数据库      ${config.databaseFile}`);
      console.log(`  公钥指纹    ${getKeyFingerprint()}`);
      console.log(`  站点名称    ${getSiteSettings().siteName}`);
      console.log('');
      table(Object.entries(rows).map(([项目, 数量]) => ({ 项目, 数量 })));
      console.log('');
    }),
  );

/* ------------------------------- 用户管理 ------------------------------- */

const user = program.command('user').description('用户管理');

user
  .command('list')
  .description('列出所有用户')
  .option('-q, --query <关键词>', '按用户名或邮箱搜索')
  .action(
    withDb(async (opts: { query?: string }) => {
      const db = getDb();
      const q = opts.query;
      const rows = db
        .select()
        .from(users)
        .where(q ? or(like(users.username, `%${q}%`), like(users.email, `%${q}%`)) : undefined)
        .orderBy(desc(users.createdAt))
        .all();

      if (program.opts().json) {
        console.log(JSON.stringify(rows.map((r) => toSessionUser(r)), null, 2));
        return;
      }

      table(
        rows.map((r) => ({
          ID: r.id,
          用户名: r.username,
          邮箱: r.email,
          角色: r.role === 'admin' ? c(color.yellow, 'admin') : 'user',
          状态: r.status === 'active' ? c(color.green, 'active') : c(color.red, 'disabled'),
          '2FA': r.totpEnabled ? '已开启' : '-',
          最后登录: showDate(r.lastLoginAt),
          创建时间: showDate(r.createdAt),
        })),
      );
      console.log(c(color.dim, `\n共 ${rows.length} 个用户`));
    }),
  );

user
  .command('create <username>')
  .description('创建用户')
  .requiredOption('-e, --email <邮箱>', '邮箱')
  .requiredOption('-p, --password <密码>', '密码（至少 8 位，含大小写字母与数字）')
  .option('-r, --role <角色>', `角色：${USER_ROLES.join(' | ')}`, 'user')
  .option('-n, --display-name <昵称>', '显示名称')
  .action(
    withDb(async (username: string, opts: { email: string; password: string; role: string; displayName?: string }) => {
      if (!USER_ROLES.includes(opts.role as (typeof USER_ROLES)[number])) {
        fail(`角色必须是 ${USER_ROLES.join(' 或 ')}`);
        process.exit(1);
      }
      const created = await createUser({
        username,
        email: opts.email,
        plainPassword: opts.password,
        role: opts.role as (typeof USER_ROLES)[number],
        displayName: opts.displayName,
      });
      ok(`已创建用户 ${c(color.bold, created.username)}（ID ${created.id}，角色 ${created.role}）`);
      if (created.role === 'admin') {
        info('该账号为管理员，可访问「设置管理后台」。');
      }
    }),
  );

user
  .command('reset-password <identifier>')
  .description('重置用户密码（可用用户名、邮箱或 ID）')
  .requiredOption('-p, --password <新密码>', '新密码')
  .option('--keep-kosync', '不重置该用户的 KOSync 同步密钥')
  .action(
    withDb(async (identifier: string, opts: { password: string; keepKosync?: boolean }) => {
      const target = requireUser(identifier);
      const db = getDb();
      const passwordHash = await hashPassword(opts.password);

      db.update(users)
        .set({
          passwordHash,
          // KOReader 用的是同步密码的 md5，改主密码后必须同步，否则客户端会认证失败
          kosyncKey: opts.keepKosync ? target.kosyncKey : md5Hex(opts.password),
          // 自增令牌版本，让该用户所有已登录设备立即下线
          tokenVersion: target.tokenVersion + 1,
          updatedAt: new Date(),
        })
        .where(eq(users.id, target.id))
        .run();

      ok(`已重置 ${c(color.bold, target.username)} 的密码，该用户所有登录设备已下线。`);
    }),
  );

user
  .command('set-role <identifier> <role>')
  .description(`设置用户角色（${USER_ROLES.join(' | ')}）`)
  .action(
    withDb(async (identifier: string, role: string) => {
      if (!USER_ROLES.includes(role as (typeof USER_ROLES)[number])) {
        fail(`角色必须是 ${USER_ROLES.join(' 或 ')}`);
        process.exit(1);
      }
      const target = requireUser(identifier);
      const db = getDb();

      // 防止把最后一个管理员降级，导致站点无人可管理
      if (target.role === 'admin' && role !== 'admin') {
        const adminCount = db.select({ v: sql<number>`count(*)` }).from(users).where(eq(users.role, 'admin')).get()?.v ?? 0;
        if (adminCount <= 1) {
          fail('这是站点唯一的管理员，降级后将无人能管理站点。请先创建另一个管理员。');
          process.exit(1);
        }
      }

      db.update(users).set({ role: role as 'admin' | 'user', updatedAt: new Date() }).where(eq(users.id, target.id)).run();
      ok(`已将 ${c(color.bold, target.username)} 的角色设为 ${role}`);
    }),
  );

for (const [cmd, status, label] of [
  ['disable', 'disabled', '禁用'],
  ['enable', 'active', '启用'],
] as const) {
  user
    .command(`${cmd} <identifier>`)
    .description(`${label}用户`)
    .action(
      withDb(async (identifier: string) => {
        const target = requireUser(identifier);
        const db = getDb();

        if (status === 'disabled') {
          const adminCount =
            db.select({ v: sql<number>`count(*)` }).from(users).where(and(eq(users.role, 'admin'), eq(users.status, 'active'))).get()?.v ?? 0;
          if (target.role === 'admin' && adminCount <= 1) {
            fail('这是站点唯一处于启用状态的管理员，禁用后将无人能管理站点。');
            process.exit(1);
          }
        }

        db.update(users)
          .set({
            status,
            // 禁用时同时自增令牌版本，让其在途会话立即失效
            ...(status === 'disabled' ? { tokenVersion: target.tokenVersion + 1 } : {}),
            updatedAt: new Date(),
          })
          .where(eq(users.id, target.id))
          .run();

        ok(`已${label} ${c(color.bold, target.username)}`);
      }),
    );
}

user
  .command('sync-password <identifier>')
  .description('查看或设置 KOSync 同步密码（KOReader 用它登录）')
  .option('-p, --password <密码>', '设置为指定密码；省略则随机生成一个并显示')
  .option('-s, --status', '只查看当前是否已设置')
  .action(
    withDb(async (identifier: string, opts: { password?: string; status?: boolean }) => {
      const target = requireUser(identifier);
      const db = getDb();
      const row = db.select({ kosyncKey: users.kosyncKey }).from(users).where(eq(users.id, target.id)).get();

      if (opts.status) {
        console.log(
          row?.kosyncKey
            ? `${c(color.green, '已设置')} —— KOReader 需使用该同步密码登录`
            : `${c(color.yellow, '未设置')} —— KOReader 将使用主密码登录`,
        );
        return;
      }

      // 服务端只存 md5，取不回明文；未指定密码时只能随机生成
      const plain = opts.password ?? generateSyncPassword();

      if (opts.password) {
        const check = passwordSchema.safeParse(opts.password);
        if (!check.success) {
          fail(`密码不符合要求：${check.error.issues[0]?.message ?? '格式不正确'}`);
          process.exit(1);
        }
      }

      db.update(users)
        .set({ kosyncKey: md5Hex(plain), updatedAt: new Date() })
        .where(eq(users.id, target.id))
        .run();

      ok(`已为 ${c(color.bold, target.username)} 设置 KOSync 同步密码`);
      console.log('');
      console.log(`  ${c(color.yellow, '同步密码（仅显示这一次）：')}`);
      console.log(`  ${c(color.bold, plain)}`);
      console.log('');
      console.log(c(color.dim, '  在 KOReader 的「工具 → 云存储 → 进度同步」里：'));
      console.log(c(color.dim, `    用户名：${target.username}`));
      console.log(c(color.dim, '    密码：上面这串'));
      console.log('');
      console.log(c(color.dim, '  注意：设置后 KOReader 将不再接受主密码，网页端登录不受影响。'));
    }),
  );

user
  .command('kosync-check <identifier>')
  .description('用指定密码模拟 KOReader 登录，确认能否通过 KOSync 认证')
  .requiredOption('-p, --password <密码>', '要验证的密码（同步密码，或未设置同步密码时的主密码）')
  .action(
    withDb(async (identifier: string, opts: { password: string }) => {
      const db = getDb();
      // 与 KOSync 服务端一致：用户名或邮箱都接受
      // 与服务端 KOSync 一致：允许邮箱、忽略大小写
      const target = findUserByLoginLoose(identifier);

      if (!target) {
        fail(`找不到用户：${identifier}（KOSync 允许填用户名或邮箱，且不区分大小写）`);
        console.log(c(color.dim, '  用 readsync user list 查看现有账号。'));
        process.exit(1);
      }

      console.log('');
      console.log(`  账号      ${c(color.bold, target.username)} <${target.email}>`);
      console.log(`  状态      ${target.status === 'active' ? c(color.green, '正常') : c(color.red, '已禁用')}`);

      if (!target.kosyncKey) {
        warn('该账号尚未设置同步密码 —— KOReader 一定登录失败。');
        console.log(
          c(color.dim, `  修复：readsync user sync-password ${target.username}`),
        );
        process.exit(1);
      }

      // KOReader 发的是 md5(密码)，这里做同样的计算再比对
      const incoming = md5Hex(opts.password);
      const matches = safeEqualHex(target.kosyncKey.toLowerCase(), incoming);

      console.log(`  收到的 key md5(${opts.password.slice(0, 2)}${'*'.repeat(Math.max(0, opts.password.length - 2))}) = ${incoming.slice(0, 12)}…`);
      console.log(`  库中的 key  ${target.kosyncKey.slice(0, 12)}…`);
      console.log('');

      if (matches) {
        ok('该密码可以通过 KOSync 认证，KOReader 可以正常登录。');
        console.log(c(color.dim, '  若 KOReader 仍失败，请检查服务器地址与用户名填写是否正确。'));
        return;
      }

      fail('该密码与库中的同步密码不一致，KOReader 会报认证失败。');
      console.log('');
      console.log(c(color.dim, '  可能原因：'));
      console.log(c(color.dim, '    · 输入时多了空格或大小写不同'));
      console.log(c(color.dim, '    · 该账号设置过独立同步密码，而不是主密码'));
      console.log('');
      console.log(c(color.dim, `  修复：readsync user sync-password ${target.username}     # 随机生成一个新的`));
      console.log(c(color.dim, `        readsync user sync-password ${target.username} -p 你记得住的密码`));
      process.exit(1);
    }),
  );

user
  .command('delete <identifier>')
  .description('删除用户及其全部数据（书籍、存储配置、同步记录）')
  .option('-y, --yes', '跳过确认')
  .action(
    withDb(async (identifier: string, opts: { yes?: boolean }) => {
      const target = requireUser(identifier);
      const db = getDb();

      if (target.role === 'admin') {
        const adminCount = db.select({ v: sql<number>`count(*)` }).from(users).where(eq(users.role, 'admin')).get()?.v ?? 0;
        if (adminCount <= 1) {
          fail('这是站点唯一的管理员，删除后将无人能管理站点。');
          process.exit(1);
        }
      }

      if (!opts.yes) {
        warn(`即将删除用户 ${target.username}（ID ${target.id}）及其全部书籍、存储配置与同步记录。`);
        warn('该操作不可恢复。确认请加 --yes 重新执行。');
        process.exit(0);
      }

      // books.storage_id 是 restrict，必须先删书再删存储
      db.delete(books).where(eq(books.ownerId, target.id)).run();
      db.delete(storages).where(eq(storages.userId, target.id)).run();
      db.delete(users).where(eq(users.id, target.id)).run();

      ok(`已删除用户 ${c(color.bold, target.username)}`);
    }),
  );

/* ------------------------------ 站点设置 ------------------------------ */

const settings = program.command('settings').description('站点设置');

settings
  .command('show')
  .description('显示当前站点设置')
  .action(
    withDb(async () => {
      const s = getSiteSettings();
      if (program.opts().json) {
        console.log(JSON.stringify(s, null, 2));
        return;
      }
      table([
        { 配置项: '站点名称', 值: s.siteName },
        { 配置项: '开放注册', 值: s.registrationEnabled ? '是' : '否' },
        { 配置项: '需要邀请码', 值: s.inviteRequired ? '是' : '否' },
        { 配置项: '找回密码', 值: s.passwordResetEnabled ? '是' : '否' },
        { 配置项: '单文件上限', 值: `${(s.upload.maxFileSize / 1024 / 1024).toFixed(1)} MB` },
        { 配置项: '允许的文件类型', 值: s.upload.allowedExtensions.join(', ') },
        { 配置项: '用户配额', 值: s.userQuotaBytes === 0 ? '不限' : `${(s.userQuotaBytes / 1024 / 1024 / 1024).toFixed(2)} GB` },
        { 配置项: '默认主题', 值: s.defaultTheme },
      ]);
    }),
  );

settings
  .command('set <key> <value>')
  .description('修改单项设置，值接受 true/false/数字/字符串')
  .action(
    withDb(async (key: string, value: string) => {
      // 把 CLI 传入的字符串转成合适的类型
      const parsed: unknown =
        value === 'true' ? true : value === 'false' ? false : /^\d+$/.test(value) ? Number(value) : value;

      const allowed = new Set([
        'siteName',
        'registrationEnabled',
        'inviteRequired',
        'passwordResetEnabled',
        'userQuotaBytes',
        'allowUserStorage',
        'defaultTheme',
        'footerText',
      ]);

      if (!allowed.has(key)) {
        fail(`未知的设置项：${key}`);
        info(`可用项：${[...allowed].join(', ')}`);
        process.exit(1);
      }

      patchSiteSettings({ [key]: parsed } as never);
      ok(`已设置 ${key} = ${String(parsed)}`);
    }),
  );

settings
  .command('upload-limit')
  .description('设置单文件上传上限与允许的扩展名')
  .option('-s, --size-mb <MB>', '单文件上限（MB）')
  .option('-e, --extensions <列表>', '允许的扩展名，逗号分隔（如 epub,pdf,zip,json）')
  .action(
    withDb(async (opts: { sizeMb?: string; extensions?: string }) => {
      const current = getSiteSettings();
      const upload = { ...current.upload };

      if (opts.sizeMb) {
        const mb = Number(opts.sizeMb);
        if (!Number.isFinite(mb) || mb <= 0) {
          fail('--size-mb 必须是正数');
          process.exit(1);
        }
        upload.maxFileSize = Math.round(mb * 1024 * 1024);
      }

      if (opts.extensions) {
        upload.allowedExtensions = opts.extensions
          .split(',')
          .map((s) => s.trim().toLowerCase().replace(/^\./, ''))
          .filter(Boolean);
      }

      patchSiteSettings({ upload });
      ok(`单文件上限 ${(upload.maxFileSize / 1024 / 1024).toFixed(1)} MB，允许类型：${upload.allowedExtensions.join(', ')}`);
    }),
  );

/* ------------------------------- 邀请码 ------------------------------- */

const invite = program.command('invite').description('邀请码管理');

invite
  .command('create')
  .description('创建邀请码')
  .option('-c, --code <自定义码>', '自定义邀请码，留空则随机生成')
  .option('-m, --max-uses <次数>', '可注册次数，0 表示不限', '1')
  .option('-n, --note <备注>', '备注')
  .option('-d, --days <天数>', '有效天数，留空表示永不过期')
  .action(
    withDb(async (opts: { code?: string; maxUses: string; note?: string; days?: string }) => {
      const db = getDb();
      const admin = db.select().from(users).where(eq(users.role, 'admin')).get();
      if (!admin) {
        fail('站点还没有管理员账号，请先执行 readsync user create 或访问网页完成初始化。');
        process.exit(1);
      }

      const code = opts.code ?? generateInviteCode();
      const maxUses = Number(opts.maxUses);
      const expiresAt = opts.days ? new Date(Date.now() + Number(opts.days) * 86400_000) : null;

      db.insert(inviteCodes)
        .values({ code, maxUses, usedCount: 0, expiresAt, note: opts.note ?? null, createdBy: admin.id, createdAt: new Date() })
        .run();

      ok(`已创建邀请码：${c(color.bold, code)}`);
      console.log(`  可用次数  ${maxUses === 0 ? '不限' : maxUses}`);
      console.log(`  过期时间  ${expiresAt ? expiresAt.toISOString().slice(0, 10) : '永不过期'}`);
    }),
  );

invite
  .command('list')
  .description('列出邀请码')
  .action(
    withDb(async () => {
      const db = getDb();
      const rows = db.select().from(inviteCodes).orderBy(desc(inviteCodes.createdAt)).all();
      const now = Date.now();

      table(
        rows.map((r) => {
          const exhausted = r.usedCount >= r.maxUses || (r.expiresAt !== null && r.expiresAt.getTime() < now);
          return {
            码: exhausted ? c(color.dim, r.code) : c(color.bold, r.code),
            已用: `${r.usedCount}/${r.maxUses === 0 ? '∞' : r.maxUses}`,
            过期时间: r.expiresAt ? r.expiresAt.toISOString().slice(0, 10) : '永不',
            状态: exhausted ? c(color.dim, '已失效') : c(color.green, '可用'),
            备注: show(r.note),
          };
        }),
      );
    }),
  );

invite
  .command('revoke <code>')
  .description('删除邀请码')
  .action(
    withDb(async (code: string) => {
      const db = getDb();
      const result = db.delete(inviteCodes).where(eq(inviteCodes.code, code)).run();
      if (result.changes === 0) {
        fail(`找不到邀请码：${code}`);
        process.exit(1);
      }
      ok(`已删除邀请码 ${code}`);
    }),
  );

/* ------------------------------ 同步令牌 ------------------------------ */

const token = program.command('sync-token').description('第三方接入令牌管理');

token
  .command('create')
  .description('为用户创建接入令牌（供其他阅读软件调用统一同步接口）')
  .requiredOption('-u, --user <用户名>', '用户名、邮箱或 ID')
  .requiredOption('-n, --name <名称>', '令牌名称，例如设备名')
  .option('-s, --scopes <权限>', '权限，逗号分隔（sync,books,*）', 'sync')
  .option('-d, --days <天数>', '有效天数，留空表示永不过期')
  .action(
    withDb(async (opts: { user: string; name: string; scopes: string; days?: string }) => {
      const target = requireUser(opts.user);
      const db = getDb();

      const raw = `rs_${generateToken(24)}`;
      const scopes = opts.scopes.split(',').map((s) => s.trim()).filter(Boolean);
      const expiresAt = opts.days ? new Date(Date.now() + Number(opts.days) * 86400_000) : null;

      db.insert(syncTokens)
        .values({
          userId: target.id,
          name: opts.name,
          tokenHash: sha256Hex(raw),
          tokenPrefix: raw.slice(0, 11),
          scopes,
          expiresAt,
          createdAt: new Date(),
        })
        .run();

      ok(`已为 ${c(color.bold, target.username)} 创建令牌「${opts.name}」`);
      console.log('');
      console.log(`  ${c(color.yellow, '令牌（仅显示这一次，请立即保存）：')}`);
      console.log(`  ${c(color.bold, raw)}`);
      console.log('');
      console.log(c(color.dim, '  调用示例：'));
      console.log(c(color.dim, `    curl -H "Authorization: Bearer ${raw}" \\`));
      console.log(c(color.dim, `         ${"'"}{baseUrl}/api/sync/entries${"'"}`));
    }),
  );

token
  .command('list')
  .description('列出接入令牌')
  .option('-u, --user <用户名>', '只显示某用户的令牌')
  .action(
    withDb(async (opts: { user?: string }) => {
      const db = getDb();
      const target = opts.user ? requireUser(opts.user) : null;
      const rows = db
        .select()
        .from(syncTokens)
        .where(target ? eq(syncTokens.userId, target.id) : undefined)
        .orderBy(desc(syncTokens.createdAt))
        .all();

      const now = Date.now();
      table(
        rows.map((r) => ({
          ID: r.id,
          用户: db.select({ u: users.username }).from(users).where(eq(users.id, r.userId)).get()?.u ?? r.userId,
          名称: r.name,
          前缀: `${r.tokenPrefix}…`,
          权限: (r.scopes ?? []).join(',') || '-',
          最后使用: showDate(r.lastUsedAt),
          状态: r.expiresAt && r.expiresAt.getTime() < now ? c(color.dim, '已过期') : c(color.green, '有效'),
        })),
      );
    }),
  );

token
  .command('revoke <id>')
  .description('删除接入令牌')
  .action(
    withDb(async (id: string) => {
      const db = getDb();
      const result = db.delete(syncTokens).where(eq(syncTokens.id, Number(id))).run();
      if (result.changes === 0) {
        fail(`找不到令牌 ID：${id}`);
        process.exit(1);
      }
      ok(`已删除令牌 ${id}`);
    }),
  );

/* -------------------------------- 插件 -------------------------------- */

const plugin = program.command('plugin').description('插件管理');

plugin
  .command('list')
  .description('列出已安装插件')
  .action(
    withDb(async () => {
      const db = getDb();
      const rows = db.select().from(pluginsTable).orderBy(desc(pluginsTable.installedAt)).all();

      table(
        rows.map((r) => ({
          ID: r.pluginId,
          名称: r.name,
          版本: r.version,
          状态:
            r.status === 'enabled'
              ? c(color.green, '已启用')
              : r.status === 'error'
                ? c(color.red, '错误')
                : c(color.dim, '已停用'),
          内置: r.builtin ? '是' : '-',
          错误: show(r.error),
        })),
      );
    }),
  );

plugin
  .command('install <zip路径>')
  .description('安装插件（zip 包）')
  .action(
    withDb(async (zipPath: string) => {
      // 动态导入：插件的安装逻辑依赖 adm-zip，放在子命令里避免影响其它命令的启动速度
      const mod = await import('./modules/plugins/service.js').catch(() => null);
      if (!mod || typeof (mod as Record<string, unknown>).installPluginFromZip !== 'function') {
        fail('插件服务未就绪：modules/plugins/service.ts 未导出 installPluginFromZip。');
        process.exit(1);
      }
      const install = (mod as { installPluginFromZip: (p: string, by?: number | null) => Promise<{ pluginId: string; name: string; version: string }> }).installPluginFromZip;
      const result = await install(zipPath, null);
      ok(`已安装插件 ${c(color.bold, result.name)}（${result.pluginId} v${result.version}）`);
      info(`使用 readsync plugin enable ${result.pluginId} 启用它。`);
    }),
  );

for (const [cmd, status, label] of [
  ['enable', 'enabled', '启用'],
  ['disable', 'disabled', '停用'],
] as const) {
  plugin
    .command(`${cmd} <插件ID>`)
    .description(`${label}插件`)
    .action(
      withDb(async (pluginId: string) => {
        const db = getDb();
        const row = db.select().from(pluginsTable).where(eq(pluginsTable.pluginId, pluginId)).get();
        if (!row) {
          fail(`找不到插件：${pluginId}`);
          process.exit(1);
        }
        db.update(pluginsTable).set({ status, updatedAt: new Date() }).where(eq(pluginsTable.pluginId, pluginId)).run();
        ok(`已${label}插件 ${pluginId}`);
        info('重启服务后生效：systemctl restart readsync');
      }),
    );
}

plugin
  .command('uninstall <插件ID>')
  .description('卸载插件')
  .action(
    withDb(async (pluginId: string) => {
      const db = getDb();
      const row = db.select().from(pluginsTable).where(eq(pluginsTable.pluginId, pluginId)).get();
      if (!row) {
        fail(`找不到插件：${pluginId}`);
        process.exit(1);
      }
      if (row.builtin) {
        fail('内置插件不可卸载。');
        process.exit(1);
      }
      db.delete(pluginsTable).where(eq(pluginsTable.pluginId, pluginId)).run();
      ok(`已卸载插件 ${pluginId}`);
      warn('插件文件仍保留在插件目录中，如需彻底清除请手动删除对应文件夹。');
    }),
  );

/* ------------------------------ 书库与审计 ------------------------------ */

program
  .command('book:list')
  .description('列出书籍')
  .option('-u, --user <用户名>', '只看某用户的书籍')
  .option('-q, --query <关键词>', '按书名或作者搜索')
  .action(
    withDb(async (opts: { user?: string; query?: string }) => {
      const db = getDb();
      const target = opts.user ? requireUser(opts.user) : null;

      const conditions = [
        target ? eq(books.ownerId, target.id) : undefined,
        opts.query ? or(like(books.title, `%${opts.query}%`), like(books.author, `%${opts.query}%`)) : undefined,
      ].filter(Boolean);

      const rows = db
        .select()
        .from(books)
        .where(conditions.length > 0 ? and(...(conditions as never[])) : undefined)
        .orderBy(desc(books.createdAt))
        .all();

      table(
        rows.map((r) => ({
          ID: r.id,
          书名: r.title.length > 30 ? `${r.title.slice(0, 29)}…` : r.title,
          作者: show(r.author),
          格式: r.format,
          大小: `${(r.size / 1024 / 1024).toFixed(2)} MB`,
          进度: `${r.progressPercent}%`,
          状态: r.readingStatus,
        })),
      );
      console.log(c(color.dim, `\n共 ${rows.length} 本`));
    }),
  );

program
  .command('audit')
  .description('查看审计日志')
  .option('-n, --limit <条数>', '显示条数', '30')
  .option('-a, --action <动作>', '按动作过滤，如 user.login')
  .option('-u, --user <用户名>', '按用户过滤')
  .action(
    withDb(async (opts: { limit: string; action?: string; user?: string }) => {
      const db = getDb();
      const target = opts.user ? requireUser(opts.user) : null;

      const conditions = [
        opts.action ? like(auditLogs.action, `%${opts.action}%`) : undefined,
        target ? eq(auditLogs.userId, target.id) : undefined,
      ].filter(Boolean);

      const rows = db
        .select()
        .from(auditLogs)
        .where(conditions.length > 0 ? and(...(conditions as never[])) : undefined)
        .orderBy(desc(auditLogs.createdAt))
        .limit(Number(opts.limit))
        .all();

      table(
        rows.map((r) => ({
          时间: showDate(r.createdAt),
          用户: show(r.username),
          动作: r.success ? r.action : c(color.red, r.action),
          对象: show(r.target),
          IP: show(r.ip),
        })),
      );
    }),
  );

/* ------------------------------- 运维命令 ------------------------------- */

program
  .command('keys')
  .description('显示或初始化服务器 RSA 密钥对（用于前端加密密码）')
  .action(() => {
    try {
      const config = loadConfig();
      ensureKeyPair();
      ok('RSA 密钥对已就绪');
      console.log(`  私钥  ${config.privateKeyFile}`);
      console.log(`  公钥  ${config.publicKeyFile}`);
      console.log(`  指纹  ${getKeyFingerprint()}`);
    } catch (err) {
      die(err);
    }
  });

program
  .command('secret')
  .description('显示主密钥状态（用于确认备份是否完整）')
  .action(() => {
    try {
      const config = loadConfig();
      if (config.secretGenerated) {
        warn('本次运行自动生成了新的主密钥 —— 说明数据目录中原本没有 secret.key。');
        warn('如果这是在一个已有数据的目录上运行，已保存的存储凭据将无法解密！');
      } else {
        ok('主密钥已就绪');
      }
      console.log(`  来源  ${process.env.READSYNC_SECRET ? '环境变量 READSYNC_SECRET' : `${config.dataDir}/secret.key`}`);
      console.log(c(color.dim, '\n  备份提示：data/secret.key 与 data/keys/private.pem 必须与数据库一同备份，'));
      console.log(c(color.dim, '  丢失后已保存的 WebDAV / S3 凭据将无法恢复。'));
    } catch (err) {
      die(err);
    }
  });

/* -------------------------------- 入口 -------------------------------- */

async function main(): Promise<void> {
  /*
   * CLI 的输出是给人看的结果，不该被服务端的基础设施日志淹没
   * （例如每次打开数据库都会打印「数据库迁移已应用」）。
   * 这里在未显式指定时把日志级别压到 warn —— 真出问题时仍会输出。
   */
  process.env.READSYNC_LOG_LEVEL = process.env.READSYNC_LOG_LEVEL ?? 'warn';
  process.env.READSYNC_LOG_PRETTY = process.env.READSYNC_LOG_PRETTY ?? 'false';

  try {
    await program.parseAsync(process.argv);
  } catch (err) {
    if (err instanceof ConfigError) {
      fail('配置有误');
      console.error(err.message);
      process.exit(1);
    }
    die(err);
  }
}

// 没有子命令时打印帮助，避免用户面对空白不知所措
if (process.argv.length <= 2) {
  program.help();
}

main();
