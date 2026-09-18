#!/usr/bin/env node
/**
 * 清理构建产物。
 *
 * 默认只删 dist 与 tsbuildinfo 等可再生成的产物；
 * 加 --all 会连同 node_modules 一起删除（用于排查依赖问题后重装）。
 *
 * 注意：**不会**删除 data/ 目录 —— 那里有数据库、密钥和用户上传的书，
 * 误删不可恢复。需要清理运行时数据请手动操作。
 */
import { existsSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const includeModules = process.argv.includes('--all');

/** 计算目录大小，用于报告释放了多少空间 */
function dirSize(dir) {
  if (!existsSync(dir)) return 0;
  let total = 0;
  const walk = (p) => {
    const st = statSync(p, { throwIfNoEntry: false });
    if (!st) return;
    if (st.isDirectory()) {
      for (const entry of require('node:fs').readdirSync(p)) walk(path.join(p, entry));
    } else {
      total += st.size;
    }
  };
  walk(dir);
  return total;
}

const targets = [
  'packages/shared/dist',
  'packages/server/dist',
  'packages/web/dist',
  'packages/shared/tsconfig.tsbuildinfo',
  'packages/server/tsconfig.tsbuildinfo',
  'packages/web/tsconfig.tsbuildinfo',
];

if (includeModules) {
  targets.push('node_modules');
  targets.push('packages/shared/node_modules');
  targets.push('packages/server/node_modules');
  targets.push('packages/web/node_modules');
}

let freed = 0;
let removed = 0;

for (const rel of targets) {
  const abs = path.join(root, rel);
  if (!existsSync(abs)) continue;

  const size = includeModules ? 0 : dirSize(abs);
  try {
    rmSync(abs, { recursive: true, force: true });
    freed += size;
    removed += 1;
    console.log(`已删除 ${rel}`);
  } catch (err) {
    console.error(`删除 ${rel} 失败：${err.message}`);
  }
}

if (removed === 0) {
  console.log('没有需要清理的产物。');
} else {
  const mb = (freed / 1024 / 1024).toFixed(1);
  console.log(`\n共删除 ${removed} 项${includeModules ? '' : `，释放约 ${mb} MB`}。`);
}

if (!includeModules) {
  console.log('提示：加 --all 可一并删除 node_modules。');
}
console.log('提示：data/ 目录（数据库、密钥、上传文件）未被触碰。');
