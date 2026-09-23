/**
 * 证明分片上传确实能穿过「限制请求体大小」的反向代理。
 *
 * 做法：在客户端与服务端之间插一个极简 TCP 代理，行为对齐 Nginx 的
 * client_max_body_size —— 请求体超过阈值就回 413 并断开连接。
 * 然后在同一个代理后面分别跑一次【整体上传】与一次【分片上传】：
 *
 *   整体上传：请求体 = 整个文件  → 被代理拒绝（这正是用户遇到的情况）
 *   分片上传：请求体 = 一片 4MB  → 每片都在阈值内，顺利通过
 *
 * 这是「分片能解决问题」的直接证据，而不是靠推理。
 *
 * 用法：READSYNC_DATA_DIR=./data-repro npx tsx src/scripts/repro-proxy-limit.ts [MB] [代理上限MB]
 */

import { constants, createHash, publicEncrypt, randomUUID } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { createServer, connect as netConnect, type Socket } from 'node:net';
import { buildApp } from '../app.js';
import { loadConfig } from '../config.js';

const SIZE_MB = Number(process.argv[2] ?? 16);
const LIMIT_MB = Number(process.argv[3] ?? 8);

const BACKEND_PORT = 7394;
const PROXY_PORT = 7395;
const BACKEND = `http://127.0.0.1:${BACKEND_PORT}`;
const PROXY = `http://127.0.0.1:${PROXY_PORT}`;
const LIMIT = LIMIT_MB * 1024 * 1024;

function log(step: string, detail = ''): void {
  console.log(`[${new Date().toISOString().slice(11, 23)}] ${step}${detail ? ` — ${detail}` : ''}`);
}

/**
 * 限制请求体大小的 TCP 代理。
 *
 * 只解析请求头里的 Content-Length —— 对这两个用例足够了，因为都是带长度的
 * 普通请求。超限时按 Nginx 的行为回 413 并断开：**响应是在客户端还在发请求体
 * 的时候发出的**，浏览器正是因此报「网络连接中断」而不是显示 413。
 */
function startLimitedProxy(
  limitBytes: number,
  status = Number(process.env.PROXY_STATUS ?? 413),
): Promise<{ close: () => Promise<void> }> {
  const server = createServer((client: Socket) => {
    const upstream = netConnect({ host: '127.0.0.1', port: BACKEND_PORT });

    let headerBuf = Buffer.alloc(0);
    let decided = false;
    let bodySeen = 0;
    let contentLength = 0;

    const kill = (): void => {
      client.destroy();
      upstream.destroy();
    };

    client.on('data', (chunk: Buffer) => {
      if (decided) {
        bodySeen += chunk.length;
        return; // 已判定放行，后续数据由 pipe 处理
      }

      headerBuf = Buffer.concat([headerBuf, chunk]);
      const headerEnd = headerBuf.indexOf('\r\n\r\n');
      if (headerEnd === -1) return;

      decided = true;
      const head = headerBuf.subarray(0, headerEnd).toString('latin1');
      const match = /content-length:\s*(\d+)/i.exec(head);
      contentLength = match ? Number(match[1]) : 0;
      if (process.env.PROXY_DEBUG === '1') {
        const firstLine = head.split('\r\n')[0];
        console.log(
          `    [proxy] ${firstLine} content-length=${contentLength} limit=${limitBytes} → ` +
            (contentLength > limitBytes ? `拒绝 ${status}` : '放行'),
        );
      }

      if (contentLength > limitBytes) {
        // 模拟代理：回错误状态然后断开，不等请求体发完。
        // 413 = Nginx client_max_body_size；524 = Cloudflare 源站超时
        const reason =
          status === 524 ? 'A timeout occurred' : status === 413 ? 'Request Entity Too Large' : 'Error';
        client.write(
          `HTTP/1.1 ${status} ${reason}\r\n` +
            'Content-Type: text/html\r\n' +
            'Content-Length: 0\r\n' +
            'Connection: close\r\n\r\n',
        );
        setTimeout(kill, 20);
        return;
      }

      // 放行：把已经读到的（含 body 起始部分）转给上游，之后双向直通
      upstream.write(headerBuf);
      bodySeen += Math.max(0, headerBuf.length - headerEnd - 4);
      client.removeAllListeners('data');
      client.pipe(upstream);
      upstream.pipe(client);
    });

    client.on('error', kill);
    upstream.on('error', kill);
  });

  return new Promise((resolve) => {
    server.listen(PROXY_PORT, '127.0.0.1', () =>
      resolve({
        close: () => new Promise<void>((r) => server.close(() => r())),
      }),
    );
  });
}

/**
 * 用 node:http 发一次请求，且**每次新建连接**（agent: false）。
 *
 * 必须这样：本脚本的代理是按「每条连接的第一个请求」做体积判断的简化实现，
 * 而 fetch/undici 默认 keep-alive 复用连接 —— 复用后后续请求绕过检查，
 * 于是「超限」根本不会发生，测试就成了假的通过。判定逻辑本身不重要，
 * 重要的是让每个请求都真的被检查到。
 */
function rawRequest(opts: {
  port: number;
  method: string;
  path: string;
  headers: Record<string, string>;
  body?: Uint8Array;
}): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port: opts.port,
        method: opts.method,
        path: opts.path,
        // 必须显式给 Content-Length：只用 req.write() 的话 Node 会走 chunked 编码，
        // 请求头里没有长度，代理那关的体积判断就永远看到 0，等于没检查
        headers: {
          ...opts.headers,
          ...(opts.body ? { 'content-length': String(opts.body.length) } : {}),
        },
        agent: false,
      },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (c) => {
          text += c;
        });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: text }));
      },
    );
    req.on('error', reject);
    if (opts.body) req.write(Buffer.from(opts.body));
    req.end();
  });
}

async function main(): Promise<void> {
  const dir = process.env.READSYNC_DATA_DIR ?? './data-repro';
  if (!/repro|test|tmp|e2e|smoke/i.test(dir)) {
    console.error(`拒绝执行：数据目录 ${dir} 看起来不是测试目录。`);
    process.exit(1);
  }

  loadConfig();
  const app = await buildApp({ serveWeb: false });
  await app.listen({ port: BACKEND_PORT, host: '127.0.0.1' });

  const proxy = await startLimitedProxy(LIMIT);
  log('服务端已启动', BACKEND);
  log('代理已启动', `${PROXY}（请求体上限 ${LIMIT_MB} MB，超过即 413 并断连）`);

  try {
    // ---- 准备账号与存储 ----
    const pub = (await (await fetch(`${BACKEND}/api/system/public-key`)).json()) as {
      data?: { publicKey?: string };
    };
    const enc = (plain: string): string =>
      publicEncrypt(
        { key: pub.data!.publicKey!, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
        Buffer.from(plain, 'utf8'),
      ).toString('base64');
    const pw = { ciphertext: enc('ReproPass123'), encrypted: true };

    await fetch(`${BACKEND}/api/system/bootstrap`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'repro', email: 'r@example.com', password: pw }),
    });
    const login = (await (
      await fetch(`${BACKEND}/api/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: 'repro', password: pw }),
      })
    ).json()) as { data?: { accessToken?: string } };
    const token = login.data!.accessToken!;
    const authH = { authorization: `Bearer ${token}` };

    await fetch(`${BACKEND}/api/storages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authH },
      body: JSON.stringify({
        name: '本地',
        driver: 'local',
        isDefault: true,
        config: { path: 'storage', quotaBytes: 0 },
      }),
    });

    // 造测试数据
    const bytes = SIZE_MB * 1024 * 1024;
    const data = Buffer.alloc(bytes);
    for (let i = 0; i < bytes; i += 997) data[i] = (i * 13 + 5) % 251;
    const md5 = createHash('md5').update(data).digest('hex');
    log('测试数据已就绪', `${SIZE_MB} MB`);

    /* ------------------ 1) 整体上传：应当被代理挡住 ------------------ */
    console.log(`\n=== 1) 整体上传 ${SIZE_MB} MB（请求体 = 整个文件）===`);
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(data)], { type: 'application/epub+zip' }), 'whole.epub');
    form.append('title', '整体上传');

    let wholeFailed = false;
    try {
      const res = await fetch(`${PROXY}/api/books/upload`, { method: 'POST', headers: authH, body: form });
      const text = await res.text();
      log('结果', `HTTP ${res.status}`);
      if (res.status !== 200) wholeFailed = true;
      console.log(text.slice(0, 200));
    } catch (err) {
      wholeFailed = true;
      log('结果：传输层失败', (err as Error).message);
      console.log('  → 这正是浏览器里 xhr.onerror「上传失败，网络连接中断」的成因');
    }
    console.log(wholeFailed ? '✓ 整体上传如预期被代理挡下' : '✗ 整体上传竟然成功了？检查代理阈值是否设得比文件还大');

    /* ------------------ 2) 分片上传：应当顺利穿过 ------------------ */
    console.log(`\n=== 2) 分片上传 ${SIZE_MB} MB（请求体 = 一片，默认 4 MB）===`);
    const initRes = await fetch(`${PROXY}/api/uploads`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authH },
      body: JSON.stringify({
        filename: 'chunked.epub',
        size: bytes,
        md5,
        mode: 'create',
        fields: { title: '分片上传' },
      }),
    });
    const init = (await initRes.json()) as {
      data?: { uploadId: string; chunkSize: number; totalChunks: number };
    };
    if (initRes.status !== 200 || !init.data) {
      console.error('初始化失败：', JSON.stringify(init).slice(0, 300));
      process.exitCode = 1;
      return;
    }
    const { uploadId, chunkSize, totalChunks } = init.data;
    log('会话已建立', `分片 ${totalChunks} 片 × ${(chunkSize / 1024 / 1024).toFixed(1)} MB`);

    let allOk = true;
    for (let i = 0; i < totalChunks; i += 1) {
      const slice = data.subarray(i * chunkSize, Math.min((i + 1) * chunkSize, bytes));
      const res = await fetch(`${PROXY}/api/uploads/${uploadId}/parts/${i}`, {
        method: 'PUT',
        headers: { ...authH, 'content-type': 'application/octet-stream' },
        body: new Uint8Array(slice),
      });
      if (res.status !== 200) {
        allOk = false;
        console.error(`  第 ${i} 片失败：HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
      }
    }
    log('分片已全部上传', allOk ? '全部 200' : '存在失败');

    const doneRes = await fetch(`${PROXY}/api/uploads/${uploadId}/complete`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authH },
      body: '{}',
    });
    const done = (await doneRes.json()) as { data?: { md5?: string; size?: number } };
    log('合并结果', `HTTP ${doneRes.status}`);
    console.log(JSON.stringify(done).slice(0, 300));

    const ok = doneRes.status === 200 && done.data?.md5 === md5;
    console.log(
      ok
        ? '✓ 分片上传穿过了同一个代理，且 MD5 一致'
        : '✗ 分片上传失败或校验不符',
    );
    if (!ok) process.exitCode = 1;

    /* ------- 3) 分片本身仍超限时，逐级减半重试（前端自适应的服务端侧验证） ------- */
    console.log(`\n=== 3) 分片仍超过代理上限时逐级减半重试 ===`);
    // 首次请求的分片必须**超过**代理上限，才会触发降级；减半后落到上限之内
    const tooBig = LIMIT * 2;
    let size = tooBig;
    let attempts = 0;

    const jsonH = { 'content-type': 'application/json', ...authH };

    while (size >= 256 * 1024) {
      attempts += 1;
      const initR = await rawRequest({
        port: PROXY_PORT,
        method: 'POST',
        path: '/api/uploads',
        headers: jsonH,
        body: Buffer.from(
          JSON.stringify({
            filename: 'retry.epub',
            size: bytes,
            mode: 'create',
            chunkSize: size,
            fields: { title: '降级重试' },
          }),
        ),
      });
      if (initR.status !== 200) {
        console.error(`  建会话失败：HTTP ${initR.status} ${initR.body.slice(0, 200)}`);
        process.exitCode = 1;
        return;
      }
      const s = JSON.parse(initR.body) as {
        data: { uploadId: string; chunkSize: number; totalChunks: number };
      };
      const real = s.data.chunkSize;
      console.log(
        `  第 ${attempts} 次尝试：分片 ${(real / 1024 / 1024).toFixed(2)} MB × ${s.data.totalChunks} 片`,
      );

      let slowed = false;
      for (let i = 0; i < s.data.totalChunks; i += 1) {
        const slice = data.subarray(i * real, Math.min((i + 1) * real, bytes));
        const partRes = await rawRequest({
          port: PROXY_PORT,
          method: 'PUT',
          path: `/api/uploads/${s.data.uploadId}/parts/${i}`,
          headers: { ...authH, 'content-type': 'application/octet-stream' },
          body: new Uint8Array(slice),
        }).catch(() => ({ status: 0, body: '连接被重置' }));

        if (partRes.status !== 200) {
          console.log(`    ↳ 第 ${i + 1} 片被代理回 ${partRes.status}，减小分片重来`);
          slowed = true;
          break;
        }
      }

      if (!slowed) {
        const fin = await rawRequest({
          port: PROXY_PORT,
          method: 'POST',
          path: `/api/uploads/${s.data.uploadId}/complete`,
          headers: jsonH,
          body: Buffer.from('{}'),
        });
        const finBody = JSON.parse(fin.body || '{}') as { data?: { md5?: string } };
        const good = fin.status === 200 && finBody.data?.md5 === md5;
        console.log(
          good
            ? `✓ 降到 ${(real / 1024).toFixed(0)} KB 后成功（共尝试 ${attempts} 次）`
            : `✗ 合并失败：HTTP ${fin.status}`,
        );
        if (!good) process.exitCode = 1;
        return;
      }

      await rawRequest({
        port: PROXY_PORT,
        method: 'DELETE',
        path: `/api/uploads/${s.data.uploadId}`,
        headers: authH,
      }).catch(() => undefined);
      size = Math.floor(real / 2);
    }
    console.error('✗ 降到下限仍无法通过');
    process.exitCode = 1;
  } finally {
    await proxy.close();
    await app.close();
  }
}

main().catch((err) => {
  console.error('脚本异常：', err);
  process.exit(1);
});
