#!/usr/bin/env node
/**
 * 依赖完整性自检。
 *
 * 背景：npm 安装被中断（网络超时、Ctrl+C、脚本中途报错）会留下「半装」的
 * node_modules —— 目录在但入口文件缺失。之后即使再跑 npm install 也可能不
 * 修复它，表现为各种看似是代码 bug 的错误：
 *   - Error: Cannot find package '.../node_modules/byte-length/dist/index.js'
 *   - TS2339: Property 'ok' does not exist on type 'Response'（类型包缺失所致）
 * 这类问题会把排查方向带偏，所以单独做一次显式检查。
 *
 * 判定方式：直接 resolve 每个包的入口文件 —— 入口缺失时 Node 会抛
 * ERR_MODULE_NOT_FOUND，正是我们要捕捉的信号。
 *
 * 用法：node scripts/check-deps.mjs
 */
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let failed = 0;

/**
 * 从指定工作区解析包。
 * from 用工作区目录，因为 vite 之类只装在 packages/web 下，
 * 从仓库根解析会误报缺失。
 */
function checkPackage(name, from, { load = false, note = '', typesOnly = false } = {}) {
  const req = createRequire(path.join(root, from, 'package.json'));

  try {
    if (typesOnly) {
      // 纯类型包没有运行时入口（undici-types 的 exports 不暴露 "."），
      // 因此只确认包目录与 package.json 存在
      const found = (req.resolve.paths(name) ?? []).some((dir) =>
        existsSync(path.join(dir, name, 'package.json')),
      );
      if (!found) throw new Error('未在 node_modules 中找到该包');
      console.log(`  [OK]   ${name}${note ? `  ${note}` : ''}`);
      return true;
    }

    // resolve 会连入口文件一起校验 —— 「目录在但入口缺失」的半装状态会在此抛错
    const entry = req.resolve(name);
    if (!existsSync(entry)) {
      throw new Error(`入口文件不存在：${entry}`);
    }

    if (load) req(name);

    console.log(`  [OK]   ${name}${note ? `  ${note}` : ''}`);
    return true;
  } catch (err) {
    failed += 1;
    const msg = err instanceof Error ? err.message.split('\n')[0] : String(err);
    console.log(`  [FAIL] ${name} → ${msg}`);
    return false;
  }
}

console.log('依赖完整性自检\n');

console.log('原生模块（需与当前平台匹配）：');
checkPackage('better-sqlite3', 'packages/server', { load: true, note: '(SQLite 驱动)' });
checkPackage('@node-rs/argon2', 'packages/server', { load: true, note: '(密码哈希)' });

console.log('\n后端关键依赖：');
checkPackage('fastify', 'packages/server');
checkPackage('drizzle-orm', 'packages/server');
checkPackage('webdav', 'packages/server', { note: '(WebDAV 存储驱动)' });
checkPackage('@aws-sdk/client-s3', 'packages/server', { note: '(对象存储驱动)' });
checkPackage('zod', 'packages/shared');

console.log('\n曾被中断安装漏掉的传递依赖：');
checkPackage('byte-length', 'packages/server', { note: '(webdav 依赖，实测被漏装过)' });
checkPackage('undici-types', 'packages/server', { typesOnly: true, note: '(@types/node 依赖，缺失会导致类型报错)' });

console.log('\n构建工具：');
checkPackage('typescript', '.');
checkPackage('esbuild', '.');
checkPackage('vite', 'packages/web', { note: '(前端构建)' });
checkPackage('@tailwindcss/vite', 'packages/web');

console.log('\n' + '─'.repeat(46));
if (failed > 0) {
  console.error(`有 ${failed} 个依赖不可用 —— node_modules 很可能安装不完整。\n`);
  console.error('修复方法（做一次干净的重新安装）：');
  console.error('  rm -rf node_modules packages/*/node_modules');
  console.error('  npm ci --ignore-scripts');
  console.error('');
  console.error('npm ci 会严格按 package-lock.json 安装并校验，比 npm install 更可靠。');
  process.exit(1);
}
console.log('全部依赖可用 ✓');
