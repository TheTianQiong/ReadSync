import { randomBytes } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import type { PluginSqliteDatabase } from '@readsync/shared';
import { loadConfig } from '../../config.js';
import { badRequest } from '../../errors.js';
import { getModuleLogger } from '../../logger.js';

/**
 * 给插件的**只读** SQLite 入口。
 *
 * 场景：别的阅读器把数据存在自己的 SQLite 文件里（Anx Reader 的 database7.db），
 * 插件要把它读出来。插件是无依赖的纯 JS，装不了原生模块，所以由宿主把已经带着的
 * better-sqlite3 包一层。
 *
 * 为什么必须是「只读」：
 *  - 那是**别人的数据库**。导入是单向的：我们读它、写自己的库，绝不改动它 ——
 *    真被改坏了，用户手里那份数据就没了，而我们连备份都不是。
 *  - 只读连接由 SQLite 自己保证（任何写语句都会被拒绝），不是靠我们检查关键字。
 *
 * 实现上有个细节：better-sqlite3 只能打开**文件**，不能打开字节。所以先把字节落到
 * 临时目录再打开，关闭时删掉。插件记得 `close()` 最好；忘了也不会一直堆积 ——
 * 每个插件的所有句柄都记在册上，卸载/停用时兜底关掉。
 */

const log = getModuleLogger('plugins');

/** 句柄登记表：pluginId → 还开着的数据库。卸载插件时用来兜底清理 */
const openByPlugin = new Map<string, Set<OpenHandle>>();

interface OpenHandle {
  db: Database.Database;
  file: string;
}

/**
 * 允许的语句前缀。
 *
 * 这不是沙箱（插件本来就能 `import('node:fs')`，见安全须知），拦的是手滑：
 * 一条 `UPDATE tb_books SET ...` 打在别人的库上，只读连接也会直接报错，
 * 早点拦下来能给插件作者一句更清楚的话。
 */
const ALLOWED_PREFIXES = ['select', 'with', 'pragma table_info', 'explain'];

/** 去掉前导注释与空白，便于判断语句类型 */
function stripLeading(sql: string): string {
  let text = sql.trimStart();
  // 去 -- 行注释与 /* */ 块注释（可能有连续几段）
  for (;;) {
    if (text.startsWith('--')) {
      const end = text.indexOf('\n');
      if (end === -1) return '';
      text = text.slice(end + 1).trimStart();
      continue;
    }
    if (text.startsWith('/*')) {
      const end = text.indexOf('*/');
      if (end === -1) return '';
      text = text.slice(end + 2).trimStart();
      continue;
    }
    return text;
  }
}

function assertReadOnlyStatement(sql: string): void {
  if (typeof sql !== 'string' || sql.trim().length === 0) {
    throw badRequest('SQL 不能为空');
  }
  const head = stripLeading(sql).toLowerCase();
  if (!ALLOWED_PREFIXES.some((prefix) => head.startsWith(prefix))) {
    throw badRequest(
      `只允许查询语句（SELECT / WITH / PRAGMA table_info）；这条被拒绝了：${sql.slice(0, 80)}`,
    );
  }
  // 多语句会让「只读」这件事变得难以判断（分号后面还能接一条别的）
  if (head.replace(/;+\s*$/, '').includes(';')) {
    throw badRequest('一次只能执行一条语句');
  }
}

/** 参数白名单：SQLite 只认这几种绑定值，其余（对象、Buffer）容易变成隐式转换 */
function normalizeParams(params: unknown): Array<string | number | null> {
  if (params === undefined) return [];
  if (!Array.isArray(params)) throw badRequest('SQL 参数必须是数组');
  return params.map((value) => {
    if (value === null || typeof value === 'string' || typeof value === 'number') return value;
    if (typeof value === 'boolean') return value ? 1 : 0;
    if (value === undefined) return null;
    throw badRequest(`SQL 参数只支持字符串、数字与 null，收到 ${typeof value}`);
  });
}

export function buildSqliteApi(pluginId: string, allowed: boolean) {
  const guard = (): void => {
    if (!allowed) {
      throw new Error(
        `插件 ${pluginId} 未声明 sqlite:read 权限，禁止读取外部数据库（请在 plugin.json 的 permissions 中加入 "sqlite:read"）`,
      );
    }
  };

  return {
    async open(input: { data: Uint8Array }): Promise<PluginSqliteDatabase> {
      guard();
      const data = input?.data;
      if (!data || typeof (data as Uint8Array).length !== 'number' || data.length === 0) {
        throw badRequest('sqlite.open() 需要一个 { data: Uint8Array }');
      }

      const dir = path.join(loadConfig().tmpDir, 'plugin-sqlite');
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const file = path.join(dir, `${pluginId.replace(/[^\w.-]/g, '_')}-${randomBytes(8).toString('hex')}.db`);
      // 0600：库里可能有别人的阅读记录，别让同机器上的其他账号顺手看到
      writeFileSync(file, Buffer.from(data), { mode: 0o600 });

      let db: Database.Database;
      try {
        db = new Database(file, { readonly: true, fileMustExist: true });
      } catch (err) {
        rmSync(file, { force: true });
        throw badRequest('这个文件不是有效的 SQLite 数据库（或已损坏）', {
          cause: err instanceof Error ? err.message : String(err),
        });
      }

      const handle: OpenHandle = { db, file };
      const set = openByPlugin.get(pluginId) ?? new Set<OpenHandle>();
      set.add(handle);
      openByPlugin.set(pluginId, set);

      const close = (): void => {
        set.delete(handle);
        if (set.size === 0) openByPlugin.delete(pluginId);
        try {
          db.close();
        } catch {
          /* 已经关了就算了 */
        }
        rmSync(file, { force: true });
      };

      const run = <T>(sql: string, params: unknown, single: boolean): T | T[] | undefined => {
        assertReadOnlyStatement(sql);
        try {
          const stmt = db.prepare(sql);
          const bound = normalizeParams(params);
          return (single ? stmt.get(...bound) : stmt.all(...bound)) as T | T[] | undefined;
        } catch (err) {
          if (err instanceof Error && 'statusCode' in err) throw err;
          throw badRequest(`查询失败：${err instanceof Error ? err.message : String(err)}`);
        }
      };

      return {
        async all<T = Record<string, unknown>>(
          sql: string,
          params?: Array<string | number | null>,
        ): Promise<T[]> {
          return ((run<T>(sql, params, false) as T[] | undefined) ?? []) as T[];
        },
        async get<T = Record<string, unknown>>(
          sql: string,
          params?: Array<string | number | null>,
        ): Promise<T | undefined> {
          return run<T>(sql, params, true) as T | undefined;
        },
        close,
      };
    },
  };
}

/**
 * 关掉某个插件还开着的数据库（卸载 / 停用时兜底）。
 *
 * 插件忘了 close 也不会让临时文件一直堆着 —— 一次导入可能会打开好几个库，
 * 而插件作者多半不会想到在每条出错路径上都关一遍。
 */
export function closePluginSqlite(pluginId: string): void {
  const set = openByPlugin.get(pluginId);
  if (!set) return;
  for (const handle of [...set]) {
    try {
      handle.db.close();
    } catch {
      /* 忽略 */
    }
    rmSync(handle.file, { force: true });
  }
  set.clear();
  openByPlugin.delete(pluginId);
  log.debug({ pluginId }, '已关闭插件的 SQLite 句柄');
}
