#!/usr/bin/env node
/**
 * 通过 GitHub Git Data API 推送本地提交。
 *
 * 用途：国内网络下 github.com:443（git 的推送主机）经常不可达，而
 * api.github.com 通常仍能访问。本脚本用后者完成推送。
 *
 * 做法：把待推送提交涉及的每个文件上传为 blob，基于父提交的 tree 组装新 tree，
 * 再创建 commit 并移动分支指针。若本地与 API 的元数据完全一致，得到的 commit
 * SHA 会与本地提交相同，从而保持本地与远端不分叉。
 *
 * 用法：node scripts/push-via-api.mjs [--dry-run]
 */
import { execFileSync } from 'node:child_process';

const OWNER = 'TheTianQiong';
const REPO = 'ReadSync';
const BRANCH = 'main';
const DRY_RUN = process.argv.includes('--dry-run');

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();

/** 原始字节级的 git 输出（提交信息需要逐字节一致才能复现 SHA） */
const gitRaw = (...args) => execFileSync('git', args, { encoding: 'buffer' }).toString('utf8');

async function api(path, init = {}) {
  const token = execFileSync('gh', ['auth', 'token'], { encoding: 'utf8' }).trim();
  const res = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
      'User-Agent': 'readsync-push-script',
      ...(init.headers ?? {}),
    },
  });

  const text = await res.text();
  let body;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { raw: text };
  }

  if (!res.ok) {
    throw new Error(`${init.method ?? 'GET'} ${path} → ${res.status}\n${JSON.stringify(body, null, 2).slice(0, 800)}`);
  }
  return body;
}

const LOCAL_HEAD = git('rev-parse', 'HEAD');
const PARENT = git('rev-parse', `${LOCAL_HEAD}^`);

console.log(`本地提交   ${LOCAL_HEAD}`);
console.log(`父提交     ${PARENT}`);

// 远端 main 必须正好是父提交，否则说明远端有新内容，应当先人工处理
const remoteRef = await api(`/repos/${OWNER}/${REPO}/git/ref/heads/${BRANCH}`);
if (remoteRef.object.sha !== PARENT) {
  console.error(`\n拒绝执行：远端 ${BRANCH} 指向 ${remoteRef.object.sha}，不是本提交的父提交 ${PARENT}。`);
  console.error('远端可能已有新提交，请先 git fetch 并合并后再试。');
  process.exit(1);
}
console.log(`远端 ${BRANCH}  ${remoteRef.object.sha}  ✓ 与父提交一致\n`);

// 本次提交改动的文件（相对父提交）
const changed = git('diff', '--name-only', `${PARENT}..${LOCAL_HEAD}`).split('\n').filter(Boolean);
if (changed.length === 0) {
  console.log('没有改动，无需推送。');
  process.exit(0);
}

console.log(`待上传文件（${changed.length} 个）：`);
for (const p of changed) console.log(`  ${p}`);

if (DRY_RUN) {
  console.log('\n--dry-run：仅检查，不做任何改动。');
  process.exit(0);
}

// 1) 上传 blob
const entries = [];
for (const path of changed) {
  const content = gitRaw('show', `${LOCAL_HEAD}:${path}`);
  // 保留文件的权限位（可执行脚本是 100755）
  const mode = git('ls-tree', LOCAL_HEAD, '--', path).split(/\s+/)[0];

  const blob = await api(`/repos/${OWNER}/${REPO}/git/blobs`, {
    method: 'POST',
    body: JSON.stringify({ content: Buffer.from(content, 'utf8').toString('base64'), encoding: 'base64' }),
  });

  entries.push({ path, mode, type: 'blob', sha: blob.sha });
  console.log(`  ✓ ${path}  blob ${blob.sha.slice(0, 8)}  mode ${mode}`);
}

// 2) 基于父 tree 组装新 tree
const parentCommit = await api(`/repos/${OWNER}/${REPO}/git/commits/${PARENT}`);
const tree = await api(`/repos/${OWNER}/${REPO}/git/trees`, {
  method: 'POST',
  body: JSON.stringify({ base_tree: parentCommit.tree.sha, tree: entries }),
});

const localTree = git('rev-parse', `${LOCAL_HEAD}^{tree}`);
console.log(`\ntree  ${tree.sha}`);
console.log(`本地  ${localTree}${tree.sha === localTree ? '  ✓ 一致' : '  ✗ 不一致'}`);

// 3) 创建 commit。提交信息必须逐字节一致，否则 SHA 会对不上
const rawCommit = gitRaw('cat-file', 'commit', LOCAL_HEAD);
const message = rawCommit.slice(rawCommit.indexOf('\n\n') + 2);

const commit = await api(`/repos/${OWNER}/${REPO}/git/commits`, {
  method: 'POST',
  body: JSON.stringify({
    message,
    tree: tree.sha,
    parents: [PARENT],
    author: { name: git('show', '-s', '--format=%an', LOCAL_HEAD), email: git('show', '-s', '--format=%ae', LOCAL_HEAD), date: git('show', '-s', '--format=%aI', LOCAL_HEAD) },
    committer: { name: git('show', '-s', '--format=%cn', LOCAL_HEAD), email: git('show', '-s', '--format=%ce', LOCAL_HEAD), date: git('show', '-s', '--format=%cI', LOCAL_HEAD) },
  }),
});

console.log(`\ncommit  ${commit.sha}`);
console.log(`本地    ${LOCAL_HEAD}${commit.sha === LOCAL_HEAD ? '  ✓ SHA 完全一致，本地与远端不会分叉' : '  ! SHA 不同（内容相同，稍后需同步本地引用）'}`);

// 4) 移动分支指针（非强制，父提交校验已保证不会覆盖别人的提交）
await api(`/repos/${OWNER}/${REPO}/git/refs/heads/${BRANCH}`, {
  method: 'PATCH',
  body: JSON.stringify({ sha: commit.sha, force: false }),
});

console.log(`\n✓ 已更新 ${OWNER}/${REPO} 的 ${BRANCH} → ${commit.sha.slice(0, 8)}`);
if (commit.sha !== LOCAL_HEAD) {
  console.log(`\n本地与远端 SHA 不同但内容一致。执行以下命令对齐本地引用：`);
  console.log(`  git fetch origin && git reset --soft origin/${BRANCH}`);
}
