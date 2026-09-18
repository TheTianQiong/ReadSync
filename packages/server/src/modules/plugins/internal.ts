import path from 'node:path';
import { pluginManifestSchema, type PluginManifest } from '@readsync/shared';
import { badRequest } from '../../errors.js';

/**
 * 插件模块内部工具：语义化版本 range 校验、路径包含判断、清单解析。
 *
 * 单独抽出来是为了避免 loader.ts 与 service.ts 互相 import 形成循环依赖
 * （两处都要用这些纯函数）。
 */

/* ----------------------------- 版本 range ----------------------------- */

interface ParsedVersion {
  nums: [number, number, number];
  /** 预发布标识；正式版为 null */
  pre: string | null;
}

/**
 * 自实现极简语义化版本比较，而不是依赖 semver 包。
 *
 * 原因：server 的 package.json 并未声明 semver（node_modules 里那份只是传递依赖，
 * 随时可能消失，也缺少类型声明），而插件的 apiVersion 只需要支持常见比较符。
 * 支持：`>= > <= < =`、`^`、`~`、`*`、空格连接的合取、`||` 分隔的析取。
 * 不支持连字符区间（如 `1.2.3 - 2.0.0`）与预发布标识细节，够用即可。
 */
function parseVersion(input: string): ParsedVersion | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(input.trim());
  if (!m) return null;
  return { nums: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ?? null };
}

function compareVersions(a: ParsedVersion, b: ParsedVersion): number {
  for (let i = 0; i < 3; i += 1) {
    const diff = (a.nums[i] as number) - (b.nums[i] as number);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  // 语义化版本规定：有预发布标识的版本小于同号正式版
  if (a.pre === b.pre) return 0;
  if (a.pre === null) return 1;
  if (b.pre === null) return -1;
  return a.pre < b.pre ? -1 : 1;
}

function testComparator(version: ParsedVersion, raw: string): boolean {
  const token = raw.trim();
  if (token === '' || token === '*' || token === 'x' || token === 'X') return true;

  const m = /^(>=|<=|>|<|=|\^|~)?\s*(.+)$/.exec(token);
  if (!m) return false;
  const op = m[1] ?? '=';
  const target = parseVersion(m[2] as string);
  // 无法解析的比较符一律视为不满足，宁可拒绝加载也不放过不兼容插件
  if (!target) return false;

  const cmp = compareVersions(version, target);
  switch (op) {
    case '>=':
      return cmp >= 0;
    case '<=':
      return cmp <= 0;
    case '>':
      return cmp > 0;
    case '<':
      return cmp < 0;
    case '=':
      return cmp === 0;
    case '^':
      // 与 npm 一致：0.x 时锁定次版本，1.x 起锁定主版本
      if (target.nums[0] === 0) {
        return version.nums[0] === 0 && version.nums[1] === target.nums[1] && cmp >= 0;
      }
      return version.nums[0] === target.nums[0] && cmp >= 0;
    case '~':
      return version.nums[0] === target.nums[0] && version.nums[1] === target.nums[1] && cmp >= 0;
    default:
      return false;
  }
}

/** 判断版本是否满足 range（如 ">=0.1.0 <0.2.0" 或 "^0.1.0"） */
export function satisfiesRange(version: string, range: string): boolean {
  const parsed = parseVersion(version);
  if (!parsed) return false;
  const trimmed = range.trim();
  if (trimmed === '') return false;

  return trimmed.split('||').some((alternative) => {
    const comparators = alternative.trim().split(/\s+/).filter(Boolean);
    if (comparators.length === 0) return false;
    return comparators.every((c) => testComparator(parsed, c));
  });
}

/* ------------------------------ 路径安全 ------------------------------ */

/**
 * 判断 child 是否位于 root 之内（含 root 本身）。
 *
 * 插件解压、入口文件定位都必须过这一关：先 path.resolve 再比较，
 * 即使前面已经拒绝了 `..` 与绝对路径，也再做一次前缀确认作为双保险。
 * Windows 大小写不敏感，因此比较时统一小写。
 */
export function isPathInside(root: string, child: string): boolean {
  const rel = path.relative(path.resolve(root), path.resolve(child));
  if (rel === '') return true;
  if (path.isAbsolute(rel)) return false;
  if (rel.toLowerCase().startsWith(`..${path.sep}`) || rel.toLowerCase() === '..') return false;
  return true;
}

/* ------------------------------ 清单解析 ------------------------------ */

/** 把 zod 的 issue 列表转成可读的「字段: 原因」文本 */
function formatIssues(issues: { path: PropertyKey[]; message: string }[]): string {
  return issues
    .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('；');
}

/** 尝试解析清单，失败返回 null（用于读取已存库的清单，坏数据不该让列表接口崩掉） */
export function safeParseManifest(raw: unknown): PluginManifest | null {
  const parsed = pluginManifestSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/** 严格解析清单，失败抛带字段级原因的 BAD_REQUEST */
export function parseManifestOrThrow(raw: unknown): PluginManifest {
  const parsed = pluginManifestSchema.safeParse(raw);
  if (!parsed.success) {
    throw badRequest(`插件清单 plugin.json 校验失败：${formatIssues(parsed.error.issues)}`, {
      issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
  }
  return parsed.data;
}

/** 校验清单声明的 apiVersion 与当前 ReadSync 版本是否兼容 */
export function assertApiVersionCompatible(manifest: PluginManifest, currentVersion: string): void {
  if (!satisfiesRange(currentVersion, manifest.apiVersion)) {
    throw badRequest(
      `插件「${manifest.name}」要求 ReadSync 版本满足 ${manifest.apiVersion}，当前版本为 ${currentVersion}，不兼容`,
    );
  }
}
