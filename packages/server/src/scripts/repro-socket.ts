/**
 * 用原始 TCP socket 复现「浏览器上传到一半连接被重置」。
 *
 * 为什么需要它：用 fetch/undici 在 loopback 上测，整个请求体几毫秒就灌完了，
 * 服务端「读完文件就回响应、不等剩余字段」这个行为完全暴露不出来。
 * 而真实浏览器走公网、经反向代理时，服务端提前关闭连接会让浏览器在
 * **仍在发送请求体**的状态下收到 RST，于是 XHR 触发 onerror，
 * 前端就显示「上传失败，网络连接中断」——尽管服务端其实已经处理完了。
 *
 * 这个脚本按网页端的真实顺序发（file 字段在前、文本字段在后），
 * 并且在发完文件后**故意停顿**，观察：
 *   - 服务端是否在请求体发完之前就回响应了；
 *   - 连接是被正常关闭还是被重置（ECONNRESET）。
 *
 * 用法：READSYNC_DATA_DIR=./data-repro npx tsx src/scripts/repro-socket.ts [MB] [停顿秒数]
 */

import { createHash, randomUUID, publicEncrypt, constants } from 'node:crypto';
import { connect } from 'node:net';
import { buildApp } from '../app.js';
import { loadConfig } from '../config.js';

const SIZE_MB = Number(process.argv[2] ?? 8);
const PAUSE_MS = Number(process.argv[3] ?? 2) * 1000;
const PORT = 7393;
const BASE = `http://127.0.0.1:${PORT}`;

function log(step: string, detail = ''): void {
  console.log(`[${new Date().toISOString().slice(11, 23)}] ${step}${detail ? ` — ${detail}` : ''}`);
}

function buildPart(boundary: string, name: string, value: string): Buffer {
  return Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
    'utf8',
  );
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

  try {
    const pub = (await (await fetch(`${BASE}/api/system/public-key`)).json()) as {
      data?: { publicKey?: string };
    };
    const enc = (plain: string): string =>
      publicEncrypt(
        { key: pub.data!.publicKey!, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
        Buffer.from(plain, 'utf8'),
      ).toString('base64');
    const pw = { ciphertext: enc('ReproPass123'), encrypted: true };

    await fetch(`${BASE}/api/system/bootstrap`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'repro', email: 'r@example.com', password: pw }),
    });
    const login = (await (
      await fetch(`${BASE}/api/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: 'repro', password: pw }),
      })
    ).json()) as { data?: { accessToken?: string } };
    const token = login.data!.accessToken!;

    await fetch(`${BASE}/api/storages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({
        name: '本地',
        driver: 'local',
        isDefault: true,
        config: { path: 'storage', quotaBytes: 0 },
      }),
    });
    // 可选：把站点单文件上限调小，触发服务端的「超限中断」路径。
    // 这条路径在 service.ts 里是直接让 Transform 报错，没有排空剩余请求体。
    const limitMb = Number(process.env.REPRO_LIMIT_MB ?? 0);
    if (limitMb > 0) {
      await fetch(`${BASE}/api/admin/settings`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ upload: { maxFileSize: limitMb * 1024 * 1024 } }),
      });
      log('已把单文件上限调成', `${limitMb} MB`);
    }

    log('准备完成', '账号 + 默认存储');

    /* ------------------------- 开始原始 socket 上传 ------------------------- */
    const boundary = `----readsync${randomUUID().replace(/-/g, '')}`;
    const fileBytes = SIZE_MB * 1024 * 1024;
    const chunk = Buffer.alloc(256 * 1024);
    for (let i = 0; i < chunk.length; i += 1) chunk[i] = (i * 17 + 3) % 251;

    const head = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="big.epub"\r\n` +
        `Content-Type: application/epub+zip\r\n\r\n`,
      'utf8',
    );
    // 关键：文本字段排在 file 之后，与网页端 BookUploadDialog 一致
    const tailParts = Buffer.concat([
      Buffer.from('\r\n', 'utf8'),
      buildPart(boundary, 'title', '原始 socket 复现'),
      buildPart(boundary, 'format', 'epub'),
      Buffer.from(`--${boundary}--\r\n`, 'utf8'),
    ]);

    const total = head.length + fileBytes + tailParts.length;

    const socket = connect({ host: '127.0.0.1', port: PORT });
    let response = Buffer.alloc(0);
    let serverClosedEarly = false;
    let reset = false;

    socket.on('data', (d: Buffer) => {
      response = Buffer.concat([response, d]);
    });
    socket.on('error', (err) => {
      if ((err as NodeJS.ErrnoException).code === 'ECONNRESET') reset = true;
      log('socket 错误', (err as Error).message);
    });
    socket.on('close', () => {
      if (!sentAll) serverClosedEarly = true;
    });

    let sentAll = false;
    await new Promise<void>((r) => socket.on('connect', () => r()));

    socket.write(
      `POST /api/books/upload HTTP/1.1\r\n` +
        `Host: 127.0.0.1:${PORT}\r\n` +
        `Authorization: Bearer ${token}\r\n` +
        `Content-Type: multipart/form-data; boundary=${boundary}\r\n` +
        `Content-Length: ${total}\r\n` +
        `Connection: keep-alive\r\n\r\n`,
    );

    log('发送文件部分…', `${SIZE_MB} MB`);
    socket.write(head);
    for (let sent = 0; sent < fileBytes; sent += chunk.length) {
      const remain = fileBytes - sent;
      socket.write(remain >= chunk.length ? chunk : chunk.subarray(0, remain));
      // 让出事件循环，避免一次性堆满内核缓冲
      if (sent % (chunk.length * 8) === 0) await new Promise((r) => setTimeout(r, 0));
    }
    log('文件部分已发出', '现在停顿，模拟公网延迟下的「尾部字段尚未送达」');

    await new Promise((r) => setTimeout(r, PAUSE_MS));

    if (reset || serverClosedEarly) {
      log('★ 停顿期间连接已被服务端关闭/重置', `reset=${reset} closedEarly=${serverClosedEarly}`);
      log('  这正是浏览器里 xhr.onerror（「网络连接中断」）的成因');
    } else {
      log('停顿期间连接仍然存活', '继续发送尾部字段');
    }

    socket.write(tailParts);
    sentAll = true;

    await new Promise((r) => setTimeout(r, 1500));
    const text = response.toString('utf8');
    const statusLine = text.split('\r\n')[0] ?? '(无响应)';
    log('服务端响应', statusLine);
    console.log(text.slice(text.indexOf('\r\n\r\n') + 4, text.indexOf('\r\n\r\n') + 500));
    socket.destroy();
  } finally {
    await app.close();
  }
}

main().catch((err) => {
  console.error('脚本异常：', err);
  process.exit(1);
});
