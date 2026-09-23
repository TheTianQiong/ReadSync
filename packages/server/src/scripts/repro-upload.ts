/**
 * 复现「网页上传阅读文件总是失败，提示网络连接中断」。
 *
 * 冒烟测试里上传的是几百字节的假文件，走的是 app.inject()（进程内，无真实 socket、
 * 无真实耗时），因此大文件上传的问题它照不出来。这个脚本做的是：
 *  1. 起一个真实监听端口的服务端；
 *  2. 用真实 HTTP 上传一个【大】文件（默认 64MB，可用参数改）；
 *  3. 打印每个阶段，看连接是在哪一步断的。
 *
 * 用法：
 *   READSYNC_DATA_DIR=./data-repro npx tsx src/scripts/repro-upload.ts [MB]
 */

import { constants, createHash, publicEncrypt, randomUUID } from 'node:crypto';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../app.js';
import { loadConfig } from '../config.js';

const SIZE_MB = Number(process.argv[2] ?? 64);
const PORT = 7392;
const BASE = `http://127.0.0.1:${PORT}`;

function log(step: string, detail = ''): void {
  console.log(`[${new Date().toISOString().slice(11, 23)}] ${step}${detail ? ` — ${detail}` : ''}`);
}

/** 造一个指定大小的假 epub（内容随机，避免命中秒传） */
function makeFile(dir: string, mb: number): { path: string; size: number; md5: string } {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `repro-${randomUUID()}.epub`);
  // 不能全用同一个字节：秒传会命中，测不到真实上传路径
  const chunk = Buffer.alloc(1024 * 1024);
  for (let i = 0; i < chunk.length; i += 1) chunk[i] = (i * 31 + mb) % 251;
  const fd = [];
  for (let i = 0; i < mb; i += 1) fd.push(chunk);
  const buf = Buffer.concat(fd);
  writeFileSync(path, buf);
  return { path, size: buf.length, md5: createHash('md5').update(buf).digest('hex') };
}

async function main(): Promise<void> {
  const dir = process.env.READSYNC_DATA_DIR ?? './data-repro';
  if (!/repro|test|tmp|e2e|smoke/i.test(dir)) {
    console.error(`拒绝执行：数据目录 ${dir} 看起来不是测试目录。`);
    process.exit(1);
  }

  loadConfig();
  const app = await buildApp({ serveWeb: false });
  await app.listen({ port: PORT, host: '127.0.0.1' });
  log('服务端已启动', BASE);

  const tmp = join(tmpdir(), `readsync-repro-${randomUUID()}`);
  const file = makeFile(tmp, SIZE_MB);
  log('测试文件已生成', `${(file.size / 1024 / 1024).toFixed(1)} MB  ${file.path}`);

  try {
    // 服务端不接受明文密码，先取 RSA 公钥把密码加密（与网页端一致）
    const pubRes = await fetch(`${BASE}/api/system/public-key`);
    const pubBody = (await pubRes.json()) as { data?: { publicKey?: string } };
    const publicKey = pubBody.data?.publicKey;
    if (!publicKey) {
      console.error('拿不到 RSA 公钥，无法继续');
      process.exit(1);
    }
    const encryptPassword = (plain: string): string =>
      publicEncrypt(
        { key: publicKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
        Buffer.from(plain, 'utf8'),
      ).toString('base64');
    const passwordPayload = { ciphertext: encryptPassword('ReproPass123'), encrypted: true };

    // --- 初始化管理员 ---
    const bootstrap = await fetch(`${BASE}/api/system/bootstrap`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'repro', email: 'repro@example.com', password: passwordPayload }),
    });
    log('初始化', `HTTP ${bootstrap.status}`);

    const login = await fetch(`${BASE}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'repro', password: passwordPayload }),
    });
    const loginBody = (await login.json()) as { data?: { accessToken?: string } };
    const token = loginBody.data?.accessToken;
    log('登录', `HTTP ${login.status} token=${token ? '有' : '无'}`);
    if (!token) {
      console.error('登录失败，无法继续：', JSON.stringify(loginBody).slice(0, 500));
      process.exit(1);
    }

    // 上传前必须先有一个默认存储，否则服务端会直接 404
    const storage = await fetch(`${BASE}/api/storages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({
        name: '本地存储',
        driver: 'local',
        isDefault: true,
        config: { path: 'storage', quotaBytes: 0 },
      }),
    });
    log('创建默认存储', `HTTP ${storage.status}`);

    // 可选：把站点单文件上限调小，用来验证「超限」这条路径的失败模式
    const limitMb = Number(process.env.REPRO_LIMIT_MB ?? 0);
    if (limitMb > 0) {
      const patch = await fetch(`${BASE}/api/admin/settings`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ upload: { maxFileSize: limitMb * 1024 * 1024 } }),
      });
      const pb = (await patch.json()) as { data?: { upload?: { maxFileSize?: number } } };
      log('设置单文件上限', `HTTP ${patch.status} → ${pb.data?.upload?.maxFileSize} 字节`);
    }

    // --- 真实上传大文件 ---
    // 用 undici 的 FormData：和浏览器一样是流式 multipart，而不是把整个 body 堆在内存里
    const { openAsBlob } = await import('node:fs');
    const blob = await openAsBlob(file.path, { type: 'application/epub+zip' });
    const form = new FormData();
    if (process.env.REPRO_FILE_LAST === '1') {
      // 我最初写的顺序（file 在最后）
      form.append('title', `复现用书 ${SIZE_MB}MB`);
      form.append('format', 'epub');
      form.append('file', blob, 'repro.epub');
    } else {
      // 网页端 BookUploadDialog 的真实顺序：file 在最前，文本字段在后
      form.append('file', blob, 'repro.epub');
      form.append('title', `复现用书 ${SIZE_MB}MB`);
      form.append('format', 'epub');
      form.append('size', String(file.size));
    }

    log('开始上传…', `${(file.size / 1024 / 1024).toFixed(1)} MB`);
    const started = Date.now();

    let res: Response;
    try {
      res = await fetch(`${BASE}/api/books/upload`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}` },
        body: form,
      });
    } catch (err) {
      const elapsed = ((Date.now() - started) / 1000).toFixed(1);
      // 这一支就是浏览器里 xhr.onerror 的对应物：连接被断开，拿不到任何响应
      console.error(`\n✗ 上传失败（传输层，耗时 ${elapsed}s）：${(err as Error).message}`);
      console.error('  这正是前端提示「上传失败，网络连接中断」的场景。');
      process.exitCode = 1;
      return;
    }

    const elapsed = ((Date.now() - started) / 1000).toFixed(1);
    const text = await res.text();
    log('收到响应', `HTTP ${res.status}（耗时 ${elapsed}s）`);
    console.log(text.slice(0, 800));

    if (res.status === 200) {
      const body = JSON.parse(text) as { data?: { size?: number; md5?: string } };
      log('上传成功', `服务端记录 size=${body.data?.size} md5=${body.data?.md5}`);
      console.log(body.data?.md5 === file.md5 ? '✓ MD5 一致' : `✗ MD5 不一致（本地 ${file.md5}）`);
    } else {
      console.error(`✗ 上传被拒绝，HTTP ${res.status}`);
      process.exitCode = 1;
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
    await app.close();
  }
}

main().catch((err) => {
  console.error('脚本异常：', err);
  process.exit(1);
});
