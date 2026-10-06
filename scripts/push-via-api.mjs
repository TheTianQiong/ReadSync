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
 * **文件内容必须按字节上传。** 早先这里是 `git show` 取内容再按 utf8 重新编码，
 * 文本文件看不出问题，二进制文件（zip、图片）会被毁掉 —— 表现是远端 blob 的
 * SHA 与本地不同，而脚本当时只比对 commit SHA，还会打一句「内容相同」把人骗过去。
 * 现在每个 blob 上传后都与本地 blob SHA 逐一对齐，而且 tree 或 commit 一旦对不上
 * 就中止，绝不发布。
 *
 * 用法：node scripts/push-via-api.mjs [--dry-run] [--force]
 *
 *   --force  跳过「远端必须等于父提交」的检查并强制移动分支指针。仅用于修正
 *            上一次推坏的提交；它会丢弃远端那个提交（别人若基于它工作会受影响）。
 */
import { execFileSync } from 'node:child_process';

const OWNER = 'TheTianQiong';
const REPO = 'ReadSync';
const BRANCH = 'main';
const DRY_RUN = process.argv.includes('--dry-run');
const FORCE = process.argv.includes('--force');

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();

/** 原始字节级的 git 输出；maxBuffer 放大到能装下仓库里最大的文件 */
const gitBytes = (...args) =>
  execFileSync('git', args, { encoding: 'buffer', maxBuffer: 512 * 1024 * 1024 });

/**
 * git 输出按 utf8 解码 —— 只适合文本（提交对象、路径）。
 * 文件内容一律走 gitBytes：过一遍 utf8 会把二进制毁掉。
 */
const gitRaw = (...args) => gitBytes(...args).toString('utf8');

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
  if (!FORCE) {
    console.error(`\n拒绝执行：远端 ${BRANCH} 指向 ${remoteRef.object.sha}，不是本提交的父提交 ${PARENT}。`);
    console.error('远端可能已有新提交，请先 git fetch 并合并后再试。');
    console.error('若你确定要用本地提交覆盖远端（例如上一次推坏了东西），加 --force。');
    process.exit(1);
  }
  console.warn(`\n⚠ --force：远端 ${BRANCH} 当前指向 ${remoteRef.object.sha}，将强制改为 ${LOCAL_HEAD}。`);
  console.warn('  那个提交会变成不可达对象 —— 只在确认它没有需要保留的内容时才这么做。\n');
} else {
  console.log(`远端 ${BRANCH}  ${remoteRef.object.sha}  ✓ 与父提交一致\n`);
}

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
  // 该路径在本提交里可能已被删除：tree 里要显式写 sha: null 才能删掉它
  let mode = '';
  try {
    mode = git('ls-tree', LOCAL_HEAD, '--', path).split(/\s+/)[0] ?? '';
  } catch {
    mode = '';
  }
  if (!mode) {
    entries.push({ path, mode: '100644', type: 'blob', sha: null });
    console.log(`  ✗ ${path}  已删除`);
    continue;
  }

  const localBlob = git('rev-parse', `${LOCAL_HEAD}:${path}`);
  const bytes = gitBytes('cat-file', 'blob', localBlob);

  const blob = await api(`/repos/${OWNER}/${REPO}/git/blobs`, {
    method: 'POST',
    body: JSON.stringify({ content: bytes.toString('base64'), encoding: 'base64' }),
  });

  /*
   * 逐个 blob 对齐 SHA。git 的 SHA 是内容寻址的，所以 SHA 相同就等于字节相同 ——
   * 这是唯一能挡住「内容在送入 API 的过程中被悄悄改写」的检查。宁可在这里失败，
   * 也不要把一份被改过的文件推上去（二进制文件尤其看不出来）。
   */
  if (blob.sha !== localBlob) {
    console.error(`\n中止：上传后内容不一致 ${path}`);
    console.error(`  本地 blob ${localBlob}（${bytes.length} 字节）`);
    console.error(`  远端 blob ${blob.sha}`);
    console.error('文件在送入 API 的过程中被改写了；请检查本脚本是否仍按字节读取内容。');
    process.exit(1);
  }

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
console.log(`本地  ${localTree}`);

/*
 * tree 不一致 = 远端会拿到一份与本地不同的内容，**到此为止，不要发布**。
 * 以前这里只打一行「✗ 不一致」就继续推，还给一句「内容相同」的结论 ——
 * 正是那次把 4 个二进制文件传坏了却看不出来。
 */
if (tree.sha !== localTree) {
  console.error('\n中止：组装出的 tree 与本地提交的 tree 不同，远端会拿到不一样的内容。');
  console.error('常见原因：文件内容在传输中被改写（二进制最容易被当文本处理）；');
  console.error('或改动的文件清单不完整（新增 / 删除 / 改名的文件没被算进来）。');
  process.exit(1);
}
console.log('  ✓ 与本地 tree 一致（内容逐字节相同）');

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
console.log(`本地    ${LOCAL_HEAD}`);

/*
 * tree 已经逐字节对齐，那么 commit SHA 也必须一致（内容寻址：相同的 tree + 相同的
 * 父提交 + 相同的作者与时间 → 同一个 SHA）。对不上说明元数据有差异（作者、时间、
 * 提交信息），这时不该装作「内容相同」把它推上去。
 */
if (commit.sha !== LOCAL_HEAD) {
  console.error('\n中止：commit SHA 与本地不同，说明提交元数据（作者 / 时间 / 提交信息）有差异。');
  console.error('不发布，以免本地与远端从此分叉、以后每次推送都得先修引用。');
  process.exit(1);
}

// 4) 移动分支指针。非 --force 时父提交校验已保证不会覆盖别人的提交
await api(`/repos/${OWNER}/${REPO}/git/refs/heads/${BRANCH}`, {
  method: 'PATCH',
  body: JSON.stringify({ sha: commit.sha, force: FORCE }),
});

console.log(`\n✓ 已更新 ${OWNER}/${REPO} 的 ${BRANCH} → ${commit.sha.slice(0, 8)}（本地与远端 SHA 一致）`);
