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
 * **可以一次推一批。** 积压多个提交时，脚本回到「远端与本地共同的那个祖先」，
 * 按从早到晚的顺序逐个把提交建出来 —— 因为 GitHub 不接受父提交不存在的提交。
 *
 * **文件内容必须按字节上传。** 早先这里是 `git show` 取内容再按 utf8 重新编码，
 * 文本文件看不出问题，二进制文件（zip、图片）会被毁掉 —— 表现是远端 blob 的
 * SHA 与本地不同，而脚本当时只比对 commit SHA，还会打一句「内容相同」把人骗过去。
 * 现在每个 blob / tree / commit 都逐个对齐 SHA，任何一步对不上就中止，绝不发布。
 *
 * 用法：node scripts/push-via-api.mjs [--dry-run] [--force]
 *
 *   --dry-run  只检查与列清单，不写任何东西
 *   --force    允许覆盖与本地分叉的远端提交（例如上一次推坏了东西）：以远端那个
 *              提交的 tree 为底重新组装，它会变成不可达对象
 */
import { execFileSync } from 'node:child_process';

const OWNER = 'TheTianQiong';
const REPO = 'ReadSync';
const BRANCH = 'main';
const DRY_RUN = process.argv.includes('--dry-run');
const FORCE = process.argv.includes('--force');

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
const gitOk = (...args) => {
  try {
    execFileSync('git', args, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
};

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
    const err = new Error(`${init.method ?? 'GET'} ${path} → ${res.status}\n${JSON.stringify(body, null, 2).slice(0, 800)}`);
    err.status = res.status;
    throw err;
  }
  return body;
}

const LOCAL_HEAD = git('rev-parse', 'HEAD');
const short = (sha) => sha.slice(0, 8);

console.log(`本地提交   ${LOCAL_HEAD}`);

const remoteRef = await api(`/repos/${OWNER}/${REPO}/git/ref/heads/${BRANCH}`);
let remoteTip = remoteRef.object.sha;
console.log(`远端 ${BRANCH}  ${remoteTip}\n`);

/* -------------------------------------------------------------------------- *
 * 1) 找到共同祖先，列出这一批要推的提交（从早到晚）
 * -------------------------------------------------------------------------- */

/**
 * 从远端那个提交往回走，直到遇到「本地也有、而且在 HEAD 的历史里」的提交。
 *
 * 不能直接用 `HEAD^`：积压多个提交时，远端根本没有那个对象。之所以要找到共同
 * 祖先，是因为每个提交的 tree 都要以它的父提交为底来组装，而那个父提交必须先
 * 在远端存在。
 *
 * **两个条件缺一不可。** 只判断「本地有没有」会踩到一种情况：一次失败的
 * `git fetch` 会把远端那个提交的对象抓下来，于是它在本地存在、却不在我们的历史里
 * ——那是兄弟不是祖先。把它当共同祖先，等于认为「两边是同一条线」，接着就会拿它
 * 当新提交的父提交，SHA 必然对不上，报出来的错还会指向「提交元数据有差异」，
 * 完全指错方向。
 */
const isLocalAncestorOfHead = (sha) =>
  gitOk('cat-file', '-e', `${sha}^{commit}`) && gitOk('merge-base', '--is-ancestor', sha, LOCAL_HEAD);

async function findCommonAncestor() {
  let cursor = remoteTip;
  for (let hops = 0; hops < 1000; hops += 1) {
    if (isLocalAncestorOfHead(cursor)) return cursor;

    const commit = await api(`/repos/${OWNER}/${REPO}/git/commits/${cursor}`);
    /*
     * 线性历史，取第一个父提交即可。
     *
     * 注意这个端点的 parents 是**对象数组**（{ sha, url, html_url }），不是字符串
     * 数组 —— 想当然按字符串用会把一个对象当成 SHA 拼进 URL，得到一个
     * `git/commits/[object Object]` 的 404。两种形状都吃下。
     */
    const parentRef = commit.parents?.[0];
    const next = typeof parentRef === 'string' ? parentRef : parentRef?.sha;
    if (!next) {
      throw new Error('远端历史走到了根提交，却始终没找到本地也有的那个提交 —— 两侧不像同源');
    }
    cursor = next;
  }
  throw new Error('回溯层数过多，已放弃');
}

const commonAncestor = await findCommonAncestor();
if (commonAncestor !== remoteTip) {
  console.log(`远端领先/分叉：共同祖先是 ${short(commonAncestor)}，远端那个提交将被替换`);
}

const backlog = git('log', '--reverse', '--format=%H', `${commonAncestor}..${LOCAL_HEAD}`)
  .split('\n')
  .filter(Boolean);

if (backlog.length === 0) {
  console.log('本地没有新提交，无需推送。');
  process.exit(0);
}

// 远端那个提交不是这批里第一个提交的父提交 —— 也就是说两者分叉了，需要 --force
const diverged = remoteTip !== commonAncestor;

console.log(`待推送提交（${backlog.length} 个，从早到晚）：`);
for (const sha of backlog) {
  console.log(`  ${short(sha)}  ${git('log', '-1', '--format=%s', sha)}`);
}

if (diverged && !FORCE) {
  console.error(`\n拒绝执行：远端 ${BRANCH} 指向 ${short(remoteTip)}，与本地这批提交分叉。`);
  console.error('若你确定要用本地提交替换它（例如上一次推坏了东西），加 --force。');
  process.exit(1);
}
if (diverged) {
  console.warn(`\n⚠ --force：远端那个提交 ${short(remoteTip)} 会被替换成 ${short(backlog.at(-1))}。`);
  console.warn('  它的内容若不在本地这批提交里，就会丢失。\n');
}

if (DRY_RUN) {
  console.log('\n--dry-run：仅检查，不做任何改动。');
  process.exit(0);
}

/* -------------------------------------------------------------------------- *
 * 2) 逐个提交地推
 * -------------------------------------------------------------------------- */

/** 上传一个 blob，并核对远端存下来的 SHA 与本地一致 */
async function uploadBlob(path, blobSha) {
  const bytes = gitBytes('cat-file', 'blob', blobSha);

  const blob = await api(`/repos/${OWNER}/${REPO}/git/blobs`, {
    method: 'POST',
    body: JSON.stringify({ content: bytes.toString('base64'), encoding: 'base64' }),
  });

  /*
   * 逐个 blob 对齐 SHA。git 的 SHA 是内容寻址的，所以 SHA 相同就等于字节相同 ——
   * 这是唯一能挡住「内容在送入 API 的过程中被悄悄改写」的检查。宁可在这里失败，
   * 也不要把一份被改过的文件推上去（二进制文件尤其看不出来）。
   */
  if (blob.sha !== blobSha) {
    console.error(`\n中止：上传后内容不一致 ${path}`);
    console.error(`  本地 blob ${blobSha}（${bytes.length} 字节）`);
    console.error(`  远端 blob ${blob.sha}`);
    console.error('文件在送入 API 的过程中被改写了；请检查本脚本是否仍按字节读取内容。');
    process.exit(1);
  }

  console.log(`    ✓ ${path}`);
  return blob.sha;
}

/** `git ls-tree -r <tree>` 的输出 → path → { sha, mode } */
function listTree(treeish) {
  const out = new Map();
  for (const line of git('ls-tree', '-r', treeish).split('\n').filter(Boolean)) {
    // 形如：100644 blob <sha>\t<path>
    const [meta, ...rest] = line.split('\t');
    const path = rest.join('\t');
    const [mode, , sha] = meta.split(/\s+/);
    if (path && sha) out.set(path, { sha, mode });
  }
  return out;
}

/**
 * 算出「把 baseTree 变成 targetTree 需要改哪些文件」。
 *
 * **不能只算「这个提交改了什么」**，两者在分叉修正时不是一回事：远端那棵树里可能
 * 有本地已经没有的文件（例如上一次推坏的副本里那份样本），那些必须显式删除，
 * 否则拼出来的树会带着它们，与本地永远对不上。
 *
 * 返回 tree 条目：改动/新增的上传本地那份，多出来的写 sha: null 删掉。
 */
async function entriesBetween(baseTree, targetTree) {
  const target = listTree(targetTree);
  const entries = [];
  const handled = new Set();

  if (gitOk('cat-file', '-e', baseTree)) {
    // 本地有这个 tree，直接让 git 算差异（--no-renames：改名拆成删+增，少一种情况要处理）
    const status = git('diff', '--name-status', '--no-renames', baseTree, targetTree)
      .split('\n')
      .filter(Boolean);

    for (const line of status) {
      const [code, ...rest] = line.split('\t');
      const path = rest.join('\t');
      if (!path) continue;

      if (code === 'D') {
        entries.push({ path, mode: '100644', type: 'blob', sha: null });
        console.log(`    ✗ ${path}  删除`);
        handled.add(path);
        continue;
      }

      const item = target.get(path);
      if (!item) continue;
      entries.push({ path, mode: item.mode, type: 'blob', sha: await uploadBlob(path, item.sha) });
      handled.add(path);
    }
    return entries;
  }

  /*
   * 兜底：远端那个 tree 在本地没有（例如换了台机器），只能拉它的清单逐路径比对。
   * 递归列出一层的 blob 即可，多一层 API 调用换「任何情况下都算得对」。
   */
  const remoteTree = await api(`/repos/${OWNER}/${REPO}/git/trees/${baseTree}?recursive=1`);
  const remoteBlobs = new Map(
    (remoteTree.tree ?? []).filter((e) => e.type === 'blob').map((e) => [e.path, e.sha]),
  );

  for (const [path, item] of target) {
    if (remoteBlobs.get(path) === item.sha) continue;
    entries.push({ path, mode: item.mode, type: 'blob', sha: await uploadBlob(path, item.sha) });
    handled.add(path);
  }
  for (const path of remoteBlobs.keys()) {
    if (handled.has(path) || target.has(path)) continue;
    entries.push({ path, mode: '100644', type: 'blob', sha: null });
    console.log(`    ✗ ${path}  删除`);
  }

  return entries;
}

/** 取某个提交（本地或远端）的 tree sha —— 本地有就用本地，避免多余的 API 调用 */
async function treeOf(sha) {
  if (gitOk('cat-file', '-e', `${sha}^{commit}`)) return git('rev-parse', `${sha}^{tree}`);
  const commit = await api(`/repos/${OWNER}/${REPO}/git/commits/${sha}`);
  return commit.tree.sha;
}

let parent = commonAncestor;
// 第一个提交要基于**远端那个 tree** 组装：本地祖先的 tree 与远端现状不同
let baseTree = await treeOf(remoteTip);

for (const [index, commit] of backlog.entries()) {
  console.log(`\n[${index + 1}/${backlog.length}] ${short(commit)}  ${git('log', '-1', '--format=%s', commit)}`);

  // 以远端当前那棵树为底，算出「差集」——改动/新增的上传，多出来的删掉
  const entries = await entriesBetween(baseTree, git('rev-parse', `${commit}^{tree}`));
  const tree = await api(`/repos/${OWNER}/${REPO}/git/trees`, {
    method: 'POST',
    body: JSON.stringify({ base_tree: baseTree, tree: entries }),
  });

  const localTree = git('rev-parse', `${commit}^{tree}`);
  /*
   * tree 不一致 = 远端会拿到一份与本地不同的内容，**到此为止，不要发布**。
   * 以前这里只打一行「✗ 不一致」就继续推，还给一句「内容相同」的结论 ——
   * 正是那次把 4 个二进制文件传坏了却看不出来。
   */
  if (tree.sha !== localTree) {
    console.error(`\n中止：${short(commit)} 组装出的 tree 与本地不同，远端会拿到不一样的内容。`);
    console.error(`  远端 tree ${tree.sha}`);
    console.error(`  本地 tree ${localTree}`);
    console.error('常见原因：文件内容在传输中被改写（二进制最容易被当文本处理）；');
    console.error('或改动的文件清单不完整（新增 / 删除 / 改名的文件没被算进来）。');
    process.exit(1);
  }

  // 提交信息必须逐字节一致，否则 SHA 会对不上
  const rawCommit = gitRaw('cat-file', 'commit', commit);
  const message = rawCommit.slice(rawCommit.indexOf('\n\n') + 2);

  const created = await api(`/repos/${OWNER}/${REPO}/git/commits`, {
    method: 'POST',
    body: JSON.stringify({
      message,
      tree: tree.sha,
      parents: [parent],
      author: {
        name: git('show', '-s', '--format=%an', commit),
        email: git('show', '-s', '--format=%ae', commit),
        date: git('show', '-s', '--format=%aI', commit),
      },
      committer: {
        name: git('show', '-s', '--format=%cn', commit),
        email: git('show', '-s', '--format=%ce', commit),
        date: git('show', '-s', '--format=%cI', commit),
      },
    }),
  });

  /*
   * tree 已经逐字节对齐，那么 commit SHA 也必须一致（内容寻址：相同的 tree +
   * 相同的父提交 + 相同的作者与时间 → 同一个 SHA）。对不上说明元数据有差异
   * （作者、时间、提交信息），这时不该装作「内容相同」把它推上去。
   */
  if (created.sha !== commit) {
    console.error(`\n中止：${short(commit)} 的 commit SHA 与本地不同，说明提交元数据有差异。`);
    console.error(`  远端 ${created.sha}`);
    console.error(`  本地 ${commit}`);
    process.exit(1);
  }

  // 远端指针与这个提交的父提交不同 → 不是快进，必须 force
  const needsForce = remoteTip !== parent;
  await api(`/repos/${OWNER}/${REPO}/git/refs/heads/${BRANCH}`, {
    method: 'PATCH',
    body: JSON.stringify({ sha: created.sha, force: needsForce }),
  });

  remoteTip = created.sha;
  parent = commit;
  baseTree = localTree; // 下一个提交以这个 tree 为底（它已与远端一致）
  console.log(`    ✓ tree 与提交 SHA 都对上了 → 远端 ${BRANCH} 现为 ${short(created.sha)}`);
}

console.log(`\n✓ 已推送 ${backlog.length} 个提交，${OWNER}/${REPO} 的 ${BRANCH} → ${short(LOCAL_HEAD)}（本地与远端 SHA 一致）`);
