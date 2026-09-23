/**
 * 端到端集成冒烟测试。
 *
 * 用真实的 Fastify 实例 + 真实 SQLite + 真实本地存储驱动，走一遍核心用户旅程：
 *   健康检查 → 初始化管理员 → 取公钥 → RSA 加密登录 → 建存储 → 上传书（秒传）
 *   → 下载 → 推送同步进度 → 统计 → KOSync 认证与进度 → 权限隔离 → 管理接口
 *
 * 用法：READSYNC_DATA_DIR=./data-e2e npx tsx src/scripts/smoke-e2e.ts
 * 该脚本会清空并重建指定的数据目录，**不要指向生产数据目录**。
 */
import { createHash, publicEncrypt, constants, randomUUID } from 'node:crypto';
import { OTP } from 'otplib';
import { rmSync } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app.js';
import { loadConfig } from '../config.js';
import { ensureKeyPair } from '../crypto/keys.js';
import { closeDatabase, openDatabase } from '../db/index.js';

/**
 * inject 响应的结构化类型。
 *
 * 不直接引用 light-my-request 的类型：它是 fastify 的传递依赖，未在本包声明，
 * 且 Fastify 的 inject 重载推导会落到 undici 的 Response 上，与实际运行时对象不符。
 * 这里只声明测试真正用到的成员。
 */
interface InjectResponse {
  statusCode: number;
  body: string;
  rawPayload: Buffer;
  json<T = any>(): T;
}

let passed = 0;
let failed = 0;

function check(name: string, condition: boolean, detail?: unknown): void {
  if (condition) {
    passed += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failed += 1;
    console.error(`  ✗ ${name}${detail !== undefined ? ` → ${JSON.stringify(detail).slice(0, 300)}` : ''}`);
  }
}

function section(title: string): void {
  console.log(`\n${title}`);
}

/** 用服务端公钥加密密码，模拟前端的 WebCrypto 行为 */
function encryptPassword(password: string, publicKeyPem: string): string {
  return publicEncrypt(
    { key: publicKeyPem, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
    Buffer.from(password, 'utf8'),
  ).toString('base64');
}

/** 手工构造 multipart/form-data 请求体 */
function buildMultipart(
  fields: Record<string, string>,
  file: { field: string; filename: string; content: Buffer; contentType: string },
): { body: Buffer; contentType: string } {
  const boundary = `----readsync${randomUUID().replace(/-/g, '')}`;
  const parts: Buffer[] = [];

  for (const [name, value] of Object.entries(fields)) {
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
        'utf8',
      ),
    );
  }

  parts.push(
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${file.field}"; filename="${file.filename}"\r\n` +
        `Content-Type: ${file.contentType}\r\n\r\n`,
      'utf8',
    ),
    file.content,
    Buffer.from('\r\n', 'utf8'),
  );

  parts.push(Buffer.from(`--${boundary}--\r\n`, 'utf8'));

  return { body: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${boundary}` };
}

async function main(): Promise<void> {
  const config = loadConfig();

  // 安全护栏：拒绝在看起来像生产目录的位置跑破坏性测试
  if (!/data-e2e|data-smoke|tmp|test/i.test(config.dataDir)) {
    console.error(`拒绝执行：数据目录 ${config.dataDir} 看起来不是测试目录。`);
    console.error('请设置 READSYNC_DATA_DIR=./data-e2e 后重试。');
    process.exit(1);
  }

  console.log(`端到端测试，数据目录：${config.dataDir}`);

  ensureKeyPair();
  openDatabase();

  const app: FastifyInstance = await buildApp({ serveWeb: false });
  await app.ready();

  /** 直接透传给 light-my-request；用 `as never` 绕过无法收窄的 inject 重载 */
  const api = (opts: {
    method: string;
    url: string;
    headers?: Record<string, string>;
    payload?: unknown;
  }): Promise<InjectResponse> => app.inject(opts as never) as unknown as Promise<InjectResponse>;

  try {
    /* ---------------------------- 1. 系统接口 ---------------------------- */
    section('1. 系统接口');
    const health = await api({ method: 'GET', url: '/api/system/health' });
    check('健康检查返回 200', health.statusCode === 200, health.body);
    check('健康检查含版本号', health.json().data?.version?.length > 0);

    const boot0 = await api({ method: 'GET', url: '/api/system/bootstrap' });
    check('初始状态为未初始化', boot0.json().data?.initialized === false, boot0.body);

    const pub = await api({ method: 'GET', url: '/api/system/public-key' });
    const publicKey = pub.json().data?.publicKey as string;
    check('下发 RSA 公钥', typeof publicKey === 'string' && publicKey.includes('BEGIN PUBLIC KEY'));
    check('公钥算法为 RSA-OAEP-256', pub.json().data?.algorithm === 'RSA-OAEP-256');

    const pubSettings = await api({ method: 'GET', url: '/api/system/settings' });
    check('公开设置可匿名读取', pubSettings.statusCode === 200 && pubSettings.json().data?.version?.length > 0);

    // 前端要靠它在上传前预检大小/类型：没下发的话，用户只能传完才被拒，
    // 走反向代理时甚至只看到「网络连接中断」，根本猜不到是文件太大
    const pubUpload = pubSettings.json().data?.upload;
    check('公开设置含单文件上限（供前端上传前预检）', typeof pubUpload?.maxFileSize === 'number', pubUpload);
    check('公开设置含允许的扩展名', Array.isArray(pubUpload?.allowedExtensions) && pubUpload.allowedExtensions.includes('epub'), pubUpload);

    /* ---------------------------- 2. 初始化管理员 ---------------------------- */
    section('2. 初始化管理员');
    const adminPassword = 'AdminPass123';
    const boot = await api({
      method: 'POST',
      url: '/api/system/bootstrap',
      payload: {
        username: 'admin',
        email: 'admin@example.com',
        password: { ciphertext: encryptPassword(adminPassword, publicKey), encrypted: true },
        siteName: '测试站点',
      },
    });
    check('创建初始管理员成功', boot.statusCode === 200, boot.body);
    check('返回角色为 admin', boot.json().data?.user?.role === 'admin');

    const bootAgain = await api({
      method: 'POST',
      url: '/api/system/bootstrap',
      payload: {
        username: 'admin2',
        email: 'a2@example.com',
        password: { ciphertext: encryptPassword(adminPassword, publicKey), encrypted: true },
      },
    });
    check('重复初始化被拒绝', bootAgain.statusCode === 403, bootAgain.body);

    // 明文密码必须被拒绝：这是「密码不可明文传递」的执行点
    const plaintextRejected = await api({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'admin', password: adminPassword },
    });
    check('明文密码登录被拒绝', plaintextRejected.statusCode === 400, plaintextRejected.body);

    /* ---------------------------- 3. 登录 ---------------------------- */
    section('3. 登录与令牌');
    const badLogin = await api({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'admin', password: { ciphertext: encryptPassword('WrongPass123', publicKey), encrypted: true } },
    });
    check('错误密码被拒绝', badLogin.statusCode === 401, badLogin.body);

    const login = await api({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'admin', password: { ciphertext: encryptPassword(adminPassword, publicKey), encrypted: true } },
    });
    check('登录成功', login.statusCode === 200, login.body);
    const accessToken = login.json().data?.accessToken as string;
    const refreshToken = login.json().data?.refreshToken as string;
    check('返回 access token', typeof accessToken === 'string' && accessToken.length > 20);
    check('返回 refresh token', typeof refreshToken === 'string' && refreshToken.length > 20);

    const auth = { authorization: `Bearer ${accessToken}` };

    const me = await api({ method: 'GET', url: '/api/auth/me', headers: auth });
    check('GET /me 返回当前用户', me.json().data?.username === 'admin', me.body);

    const noAuth = await api({ method: 'GET', url: '/api/books' });
    check('未登录访问受保护接口返回 401', noAuth.statusCode === 401);

    const refreshed = await api({ method: 'POST', url: '/api/auth/refresh', payload: { refreshToken } });
    check('刷新令牌成功', refreshed.statusCode === 200, refreshed.body);
    const newRefresh = refreshed.json().data?.refreshToken as string;

    const replay = await api({ method: 'POST', url: '/api/auth/refresh', payload: { refreshToken } });
    check('旧 refresh token 重放被拒绝（轮换生效）', replay.statusCode === 401, replay.body);
    check('刷新后得到不同的 refresh token', newRefresh !== refreshToken);

    /* ---------------------------- 4. 存储配置 ---------------------------- */
    section('4. 存储配置');
    const created = await api({
      method: 'POST',
      url: '/api/storages',
      headers: auth,
      payload: { name: '本地存储', driver: 'local', isDefault: true, config: { path: 'storage', quotaBytes: 0 } },
    });
    check('创建本地存储成功', created.statusCode === 200, created.body);
    const storageId = created.json().data?.id as number;

    const list = await api({ method: 'GET', url: '/api/storages', headers: auth });
    check('列出存储配置', Array.isArray(list.json().data) && list.json().data.length === 1, list.body);

    const tested = await api({ method: 'POST', url: `/api/storages/${storageId}/test`, headers: auth });
    check('存储连通性测试通过', tested.json().data?.ok === true, tested.body);

    /* ---------------------------- 5. 上传书籍 ---------------------------- */
    section('5. 书库与上传');
    const bookContent = Buffer.from(`%PDF-1.4 fake epub content ${randomUUID()}`.repeat(50), 'utf8');
    const bookMd5 = createHash('md5').update(bookContent).digest('hex');

    const mp = buildMultipart(
      { title: '测试书籍', author: '张三', format: 'epub', storageId: String(storageId) },
      { field: 'file', filename: '测试书.epub', content: bookContent, contentType: 'application/epub+zip' },
    );

    const upload = await api({
      method: 'POST',
      url: '/api/books/upload',
      headers: { ...auth, 'content-type': mp.contentType },
      payload: mp.body,
    });
    check('上传书籍成功', upload.statusCode === 200, upload.body);
    const book = upload.json().data as { id: number; md5: string; size: number } | undefined;
    check('上传后 MD5 与服务端计算一致', book?.md5 === bookMd5, { got: book?.md5, want: bookMd5 });
    check('记录文件大小', book?.size === bookContent.length);

    // 注意：必须用同一个 multipart 对象里的 contentType 与 body ——
    // 两次独立构造会生成不同的 boundary，头与体不匹配会导致解析失败
    const dupMp = buildMultipart(
      { title: '重复的书', format: 'epub' },
      { field: 'file', filename: 'dup.epub', content: bookContent, contentType: 'application/epub+zip' },
    );
    const dup = await api({
      method: 'POST',
      url: '/api/books/upload',
      headers: { ...auth, 'content-type': dupMp.contentType },
      payload: dupMp.body,
    });
    check('重复上传命中秒传', dup.statusCode === 200 && dup.json().data?.id === book?.id, dup.body);

    const check0 = await api({ method: 'POST', url: '/api/books/check', headers: auth, payload: { md5: bookMd5 } });
    check('秒传检查接口返回已存在', check0.json().data?.exists === true);

    const books = await api({ method: 'GET', url: '/api/books', headers: auth });
    check('书库列表只有 1 本（秒传未重复入库）', books.json().data?.total === 1, books.body);

    const download = await api({ method: 'GET', url: `/api/books/${book!.id}/download`, headers: auth });
    check('下载书籍成功', download.statusCode === 200, download.statusCode);
    check('下载内容与上传一致', Buffer.from(download.rawPayload).equals(bookContent));

    /* ------------------------- 5b. 分片上传 ------------------------- */
    section('5b. 分片上传（绕过代理的体积/超时限制）');
    {
      // 造一个跨多片的文件，并让分片大小可控（默认 4 MiB 太大，测试里调小）
      const chunkSize = 256 * 1024;
      process.env.READSYNC_UPLOAD_CHUNK_SIZE = String(chunkSize);

      const payload = Buffer.alloc(chunkSize * 3 + 12345);
      for (let i = 0; i < payload.length; i += 1) payload[i] = (i * 7 + 11) % 251;
      const payloadMd5 = createHash('md5').update(payload).digest('hex');
      const totalChunks = Math.ceil(payload.length / chunkSize);

      const init = await api({
        method: 'POST',
        url: '/api/uploads',
        headers: auth,
        payload: {
          filename: 'chunked.epub',
          size: payload.length,
          md5: payloadMd5,
          mode: 'create',
          fields: { title: '分片上传的书', format: 'epub', author: '张三' },
        },
      });
      check('分片上传：初始化会话成功', init.statusCode === 200, init.body);
      const uploadId = init.json().data?.uploadId as string;
      check('分片上传：返回 chunkSize', init.json().data?.chunkSize === chunkSize, init.json().data);
      check('分片上传：分片数正确', init.json().data?.totalChunks === totalChunks, init.json().data);

      const putPart = (index: number, data: Buffer) =>
        api({
          method: 'PUT',
          url: `/api/uploads/${uploadId}/parts/${index}`,
          headers: { ...auth, 'content-type': 'application/octet-stream' },
          payload: data,
        });

      // 先传最后一片，再倒着传 —— 验证服务端是按偏移写入而非顺序追加。
      // 若误用 O_APPEND，文件会错位且 MD5 必然对不上。
      const partRes = await putPart(totalChunks - 1, payload.subarray((totalChunks - 1) * chunkSize));
      check('分片上传：末片（不足一片）被接受', partRes.statusCode === 200, partRes.body);

      for (let i = totalChunks - 2; i >= 0; i -= 1) {
        const res = await putPart(i, payload.subarray(i * chunkSize, (i + 1) * chunkSize));
        check(`分片上传：第 ${i} 片上传成功`, res.statusCode === 200, res.body);
      }

      // 缺片时必须拒绝：中间缺片会被后续分片撑到完整长度，只看大小发现不了
      const holeInit = await api({
        method: 'POST',
        url: '/api/uploads',
        headers: auth,
        payload: {
          filename: 'hole.epub',
          size: payload.length,
          mode: 'create',
          fields: { title: '缺片的书' },
        },
      });
      const holeId = holeInit.json().data?.uploadId as string;
      await api({
        method: 'PUT',
        url: `/api/uploads/${holeId}/parts/0`,
        headers: { ...auth, 'content-type': 'application/octet-stream' },
        payload: payload.subarray(0, chunkSize),
      });
      // 中间片必须是满片（末片才允许不足），这里按整片切
      await api({
        method: 'PUT',
        url: `/api/uploads/${holeId}/parts/2`,
        headers: { ...auth, 'content-type': 'application/octet-stream' },
        payload: payload.subarray(2 * chunkSize, 3 * chunkSize),
      });
      const holeComplete = await api({ method: 'POST', url: `/api/uploads/${holeId}/complete`, headers: auth });
      // 缺的是第 1、3 片（共 4 片，只传了 0 和 2）；两者都要被点出来
      const holeMsg: string = holeComplete.json().error?.message ?? '';
      check(
        '分片上传：缺片时拒绝合并且指明缺哪片',
        holeComplete.statusCode === 400 && holeMsg.includes('第 1、3 片'),
        holeComplete.body,
      );
      await api({ method: 'DELETE', url: `/api/uploads/${holeId}`, headers: auth });

      // 大小不符的分片要当场拒绝
      const wrongSize = await putPart(0, Buffer.alloc(chunkSize - 1));
      check('分片上传：分片大小不符被拒', wrongSize.statusCode === 400, wrongSize.body);

      const outOfRange = await putPart(totalChunks + 5, Buffer.alloc(16));
      check('分片上传：序号越界被拒', outOfRange.statusCode === 400, outOfRange.body);

      const done = await api({ method: 'POST', url: `/api/uploads/${uploadId}/complete`, headers: auth });
      check('分片上传：合并入库成功', done.statusCode === 200, done.body);
      check('分片上传：服务端重算 MD5 与原始一致', done.json().data?.md5 === payloadMd5, done.json().data?.md5);
      check('分片上传：书名等字段正确带入', done.json().data?.title === '分片上传的书', done.json().data?.title);
      check('分片上传：大小正确', done.json().data?.size === payload.length, done.json().data?.size);

      // 合并后会话应被清理，再合并同一 id 必然失败
      const reComplete = await api({ method: 'POST', url: `/api/uploads/${uploadId}/complete`, headers: auth });
      check('分片上传：合并后会话已清理', reComplete.statusCode === 404, reComplete.statusCode);

      // 内容相同的分片上传应命中秒传
      const dupInit = await api({
        method: 'POST',
        url: '/api/uploads',
        headers: auth,
        payload: {
          filename: 'chunked-copy.epub',
          size: payload.length,
          md5: payloadMd5,
          mode: 'create',
          fields: { title: '重复的分片书' },
        },
      });
      const dupId = dupInit.json().data?.uploadId as string;
      for (let i = 0; i < totalChunks; i += 1) {
        await api({
          method: 'PUT',
          url: `/api/uploads/${dupId}/parts/${i}`,
          headers: { ...auth, 'content-type': 'application/octet-stream' },
          payload: payload.subarray(i * chunkSize, Math.min((i + 1) * chunkSize, payload.length)),
        });
      }
      const dupDone = await api({ method: 'POST', url: `/api/uploads/${dupId}/complete`, headers: auth });
      check('分片上传：相同内容命中秒传', dupDone.statusCode === 200 && dupDone.json().data?.id === done.json().data?.id, dupDone.body);

      // 扩展名白名单：不支持的格式必须在建会话时就被挡住，别让人白传
      const badExt = await api({
        method: 'POST',
        url: '/api/uploads',
        headers: auth,
        payload: { filename: 'evil.exe', size: 1024, mode: 'create', fields: {} },
      });
      check('分片上传：非法扩展名在建会话时被拒', badExt.statusCode === 415, badExt.body);

      // 路径穿越：uploadId 会进文件路径，必须从源头挡住
      const traversal = await api({
        method: 'PUT',
        url: '/api/uploads/..%2f..%2fetc/parts/0',
        headers: { ...auth, 'content-type': 'application/octet-stream' },
        payload: Buffer.alloc(16),
      });
      check('分片上传：路径穿越的 uploadId 被拒', traversal.statusCode >= 400 && traversal.statusCode < 500, traversal.statusCode);

      const bogusId = await api({
        method: 'POST',
        url: '/api/uploads/notavalidid/complete',
        headers: auth,
      });
      check('分片上传：非法 uploadId 被拒', bogusId.statusCode === 400, bogusId.body);

      // 还原，避免影响后续用例（该变量是全局读取的）
      delete process.env.READSYNC_UPLOAD_CHUNK_SIZE;
    }

    /* ---------------------------- 6. 统一同步接口 ---------------------------- */
    section('6. 统一同步接口');
    const push = await api({
      method: 'PUT',
      url: '/api/sync/progress',
      headers: auth,
      payload: {
        document: 'test-doc-001',
        title: '测试书籍',
        progress: 'epubcfi(/6/14!/4/2/2/1:0)',
        percentage: 0.4275,
        platform: 'koreader',
        device: 'TestDevice',
        deviceId: 'dev-1',
        readingSeconds: 300,
      },
    });
    check('推送同步进度成功', push.statusCode === 200 && push.json().data?.accepted === true, push.body);

    const pull = await api({ method: 'GET', url: '/api/sync/progress/test-doc-001', headers: auth });
    check('拉取同步进度', pull.json().data?.entry?.document === 'test-doc-001', pull.body);
    check('百分比精度保持（0.4275）', pull.json().data?.entry?.percentage === 0.4275, pull.json().data?.entry?.percentage);

    const stale = await api({
      method: 'PUT',
      url: '/api/sync/progress',
      headers: auth,
      payload: { document: 'test-doc-001', progress: 'old', percentage: 0.1, clientTime: '2020-01-01T00:00:00.000Z' },
    });
    check('过期客户端进度被拒（latest-wins）', stale.json().data?.accepted === false, stale.body);

    /* ---------------------------- 7. 统计 ---------------------------- */
    section('7. 统计接口');
    const status = await api({ method: 'GET', url: '/api/stats/status', headers: auth });
    check('阅读状态接口可用', status.statusCode === 200, status.body);
    check('累计阅读时长已记入（300 秒）', status.json().data?.totalSeconds === 300, status.json().data?.totalSeconds);

    const trend = await api({ method: 'GET', url: '/api/stats/trend?granularity=day', headers: auth });
    check('阅读趋势接口可用', trend.statusCode === 200 && Array.isArray(trend.json().data?.points), trend.body);

    const heatmap = await api({ method: 'GET', url: '/api/stats/heatmap', headers: auth });
    check('热力图返回 168 个格子', heatmap.json().data?.cells?.length === 168, heatmap.json().data?.cells?.length);

    const dashboard = await api({ method: 'GET', url: '/api/stats/dashboard', headers: auth });
    check('首页聚合接口可用', dashboard.statusCode === 200 && dashboard.json().data?.status !== undefined, dashboard.body);

    /* ---------------------------- 8. KOSync 协议 ---------------------------- */
    section('8. KOSync 兼容协议');
    const kosyncKey = createHash('md5').update(adminPassword).digest('hex');
    const kAuth = { 'x-auth-user': 'admin', 'x-auth-key': kosyncKey };

    // 探活：第三方客户端（如 Reeden）靠它判断「这是不是 KOSync 服务器」。
    // 官方探活脚本的判定条件是响应体里出现 "state":"OK"。
    const kHealth = await api({ method: 'GET', url: '/healthcheck' });
    check(
      'KOSync /healthcheck 返回 {"state":"OK"}',
      kHealth.statusCode === 200 && kHealth.json().state === 'OK',
      kHealth.body,
    );
    check('官方探活脚本能识别本站（grep \'"state":"OK"\'）', kHealth.body.replace(/\s/g, '').includes('"state":"OK"'), kHealth.body);

    const kAuthRes = await api({ method: 'GET', url: '/users/auth', headers: kAuth });
    // 上游是纯文本 OK，但第三方客户端会解析响应体，非 JSON 会被判成「不是 KOSync 服务器」。
    // 返回 {"authorized":"OK"} 同时满足两者：KOReader 只看状态码。
    check(
      'KOSync 认证返回 200 + {"authorized":"OK"}',
      kAuthRes.statusCode === 200 && kAuthRes.json().authorized === 'OK',
      kAuthRes.body,
    );

    const kBad = await api({ method: 'GET', url: '/users/auth', headers: { 'x-auth-user': 'admin', 'x-auth-key': 'f'.repeat(32) } });
    check('KOSync 错误密钥返回 401', kBad.statusCode === 401, kBad.statusCode);
    check('KOSync 失败响应带 message 字段（否则客户端只显示「未知服务器错误」）', typeof kBad.json().message === 'string', kBad.body);
    check('KOSync 失败响应不是 ApiResponse 信封', kBad.json().ok === undefined, kBad.body);

    const kPut = await api({
      method: 'PUT',
      url: '/syncs/progress',
      headers: kAuth,
      payload: { document: 'kosync-doc', progress: '/body/DocFragment[5]/text().0', percentage: 0.5, device: 'Kindle', device_id: 'k1' },
    });
    check('KOSync 推送进度成功', kPut.statusCode === 200 && kPut.json().document === 'kosync-doc', kPut.body);
    check('KOSync 响应无 ApiResponse 信封', kPut.json().ok === undefined, kPut.body);

    const kGet = await api({ method: 'GET', url: '/syncs/progress/kosync-doc', headers: kAuth });
    check('KOSync 拉取进度成功', kGet.json().document === 'kosync-doc', kGet.body);
    check('KOSync 字段名符合上游', 'device_id' in kGet.json() && typeof kGet.json().timestamp === 'number', kGet.body);

    const kMissing = await api({ method: 'GET', url: '/syncs/progress/not-exist', headers: kAuth });
    check('KOSync 未找到返回 200 + 空对象（上游预期行为）', kMissing.statusCode === 200 && JSON.stringify(kMissing.json()) === '{}', kMissing.body);

    // 改同步密码：客户端发 md5(新密码)，成功返回 {"updated": true}
    const newKosyncKey = createHash('md5').update('RotatedPass456').digest('hex');
    const kRotate = await api({ method: 'PUT', url: '/users/password', headers: kAuth, payload: { password: newKosyncKey } });
    check('KOSync 改同步密码返回 {"updated":true}', kRotate.statusCode === 200 && kRotate.json().updated === true, kRotate.body);

    const kOldKey = await api({ method: 'GET', url: '/users/auth', headers: kAuth });
    check('改密后旧同步密码失效', kOldKey.statusCode === 401, kOldKey.statusCode);

    const kNewAuth = { 'x-auth-user': 'admin', 'x-auth-key': newKosyncKey };
    const kNewKey = await api({ method: 'GET', url: '/users/auth', headers: kNewAuth });
    check('改密后新同步密码可用', kNewKey.statusCode === 200, kNewKey.body);

    const kBadNew = await api({ method: 'PUT', url: '/users/password', headers: kNewAuth, payload: { password: 'not-a-md5' } });
    check('KOSync 改密拒绝非 MD5 格式', kBadNew.statusCode === 403 && typeof kBadNew.json().message === 'string', kBadNew.body);

    // 复原，避免影响后续断言或重复运行
    const kRestore = await api({ method: 'PUT', url: '/users/password', headers: kNewAuth, payload: { password: kosyncKey } });
    check('KOSync 同步密码可复原', kRestore.statusCode === 200 && kRestore.json().updated === true, kRestore.body);

    // DELETE /users/me 有意不实现：返回 501 + 可读原因，而不是把整站账号删掉
    const kDeleteMe = await api({ method: 'DELETE', url: '/users/me', headers: kAuth });
    check('KOSync 注销账号返回 501（保护整站账号）', kDeleteMe.statusCode === 501, kDeleteMe.statusCode);
    check('KOSync 注销失败给出可读原因', typeof kDeleteMe.json().message === 'string', kDeleteMe.body);

    const kStillThere = await api({ method: 'GET', url: '/users/auth', headers: kAuth });
    check('调用注销后账号依然存在', kStillThere.statusCode === 200, kStillThere.statusCode);

    /* ---------------------------- 9. 权限隔离 ---------------------------- */
    section('9. 权限隔离');
    const reg = await api({
      method: 'POST',
      url: '/api/auth/register',
      payload: {
        username: 'normaluser',
        email: 'user@example.com',
        password: { ciphertext: encryptPassword('UserPass123', publicKey), encrypted: true },
      },
    });
    check('注册普通用户成功', reg.statusCode === 200, reg.body);

    const userLogin = await api({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'normaluser', password: { ciphertext: encryptPassword('UserPass123', publicKey), encrypted: true } },
    });
    const userAuth = { authorization: `Bearer ${userLogin.json().data?.accessToken}` };

    const userBooks = await api({ method: 'GET', url: '/api/books', headers: userAuth });
    check('普通用户看不到他人书籍', userBooks.json().data?.total === 0, userBooks.body);

    const userSteal = await api({ method: 'GET', url: `/api/books/${book!.id}/download`, headers: userAuth });
    check('越权下载返回 404', userSteal.statusCode === 404, userSteal.statusCode);

    const userAdmin = await api({ method: 'GET', url: '/api/admin/users', headers: userAuth });
    check('普通用户访问管理接口返回 403', userAdmin.statusCode === 403, userAdmin.statusCode);

    const adminList = await api({ method: 'GET', url: '/api/admin/users', headers: auth });
    check('管理员可列出用户', adminList.statusCode === 200 && adminList.json().data?.total >= 2, adminList.body);

    const sysInfo = await api({ method: 'GET', url: '/api/admin/system', headers: auth });
    check('管理员可读取系统信息', sysInfo.statusCode === 200, sysInfo.body);

    /* ---------------------------- 10. 审计与设置 ---------------------------- */
    section('10. 审计与站点设置');
    const audit = await api({ method: 'GET', url: '/api/admin/audit', headers: auth });
    check('审计日志有记录', audit.statusCode === 200 && audit.json().data?.total > 0, audit.body);

    const settings = await api({
      method: 'PATCH',
      url: '/api/admin/settings',
      headers: auth,
      payload: { registrationEnabled: false },
    });
    check('管理员可修改站点设置', settings.statusCode === 200, settings.body);

    const regBlocked = await api({
      method: 'POST',
      url: '/api/auth/register',
      payload: {
        username: 'blocked',
        email: 'blocked@example.com',
        password: { ciphertext: encryptPassword('BlockedPass1', publicKey), encrypted: true },
      },
    });
    check('关闭注册后新用户注册被拒', regBlocked.statusCode === 403, regBlocked.body);

    /* ---------------------------- 11. 错误信封 ---------------------------- */
    section('11. 错误响应格式');
    const notFound = await api({ method: 'GET', url: '/api/nonexistent', headers: auth });
    check('未知接口返回 404 且带信封', notFound.statusCode === 404 && notFound.json().ok === false, notFound.body);
    check('错误码为 NOT_FOUND', notFound.json().error?.code === 'NOT_FOUND');

    const badPayload = await api({ method: 'POST', url: '/api/books/check', headers: auth, payload: { md5: 'not-a-md5' } });
    check('非法参数返回 400', badPayload.statusCode === 400, badPayload.body);

    /* ---------------------------- 12. 两步验证与恢复码 ---------------------------- */
    section('12. 两步验证与恢复码');

    // 用普通用户测试，避免影响后续用 admin 的断言
    const setup = await api({ method: 'POST', url: '/api/auth/2fa/setup', headers: userAuth });
    check('2FA setup 返回密钥与 otpauth URI', setup.statusCode === 200 && !!setup.json().data?.secret, setup.body);
    const totpSecret = setup.json().data?.secret as string;
    check('otpauth URI 格式正确', String(setup.json().data?.otpauthUrl).startsWith('otpauth://totp/'));

    const otp = new OTP({ strategy: 'totp' });
    const enable = await api({
      method: 'POST',
      url: '/api/auth/2fa/enable',
      headers: userAuth,
      payload: { code: await otp.generate({ secret: totpSecret }) },
    });
    check('2FA 启用成功', enable.statusCode === 200, enable.body);
    const recoveryCodes = (enable.json().data?.recoveryCodes ?? []) as string[];
    check('返回一次性恢复码', recoveryCodes.length > 0, recoveryCodes.length);

    // 开启后仅凭密码登录应被要求二次验证，且不下发令牌
    const needTotp = await api({
      method: 'POST',
      url: '/api/auth/login',
      payload: {
        username: 'normaluser',
        password: { ciphertext: encryptPassword('UserPass123', publicKey), encrypted: true },
      },
    });
    check('已开启 2FA 的账号登录被要求二次验证', needTotp.json().data?.requires2fa === true, needTotp.body);
    check('未提供验证码时不签发令牌', needTotp.json().data?.accessToken === undefined);

    const badTotp = await api({
      method: 'POST',
      url: '/api/auth/login',
      payload: {
        username: 'normaluser',
        password: { ciphertext: encryptPassword('UserPass123', publicKey), encrypted: true },
        totpCode: '000000',
      },
    });
    check('错误 TOTP 被拒绝', badTotp.statusCode === 401, badTotp.body);

    // 防重放：启用 2FA 时已消费掉当前时间步，同一窗口内的验证码不能再次使用
    // （RFC 6238 §5.2 要求验证方拒绝同一 OTP 的二次使用）
    const replayed = await api({
      method: 'POST',
      url: '/api/auth/login',
      payload: {
        username: 'normaluser',
        password: { ciphertext: encryptPassword('UserPass123', publicKey), encrypted: true },
        totpCode: await otp.generate({ secret: totpSecret }),
      },
    });
    check('同一时间步的验证码被拒绝（防重放）', replayed.statusCode === 401, replayed.body);

    // ★ 恢复码：用户丢失验证器时的唯一退路，必须可用
    const firstCode = recoveryCodes[0]!;
    const byRecovery = await api({
      method: 'POST',
      url: '/api/auth/login',
      payload: {
        username: 'normaluser',
        password: { ciphertext: encryptPassword('UserPass123', publicKey), encrypted: true },
        totpCode: firstCode,
      },
    });
    check('用恢复码登录成功', byRecovery.statusCode === 200 && !!byRecovery.json().data?.accessToken, byRecovery.body);

    const reuseRecovery = await api({
      method: 'POST',
      url: '/api/auth/login',
      payload: {
        username: 'normaluser',
        password: { ciphertext: encryptPassword('UserPass123', publicKey), encrypted: true },
        totpCode: firstCode,
      },
    });
    check('恢复码不可重复使用', reuseRecovery.statusCode === 401, reuseRecovery.body);

    // 等待进入下一个 30 秒时间窗，才能用新验证码登录。
    // 这段等待是防重放机制的必然代价，不是测试缺陷 —— 真实用户在同一窗口内
    // 重复登录也会遇到同样的等待。
    const currentStep = Math.floor(Date.now() / 30_000);
    const waitMs = (currentStep + 1) * 30_000 - Date.now() + 500;
    console.log(`  … 等待 ${Math.ceil(waitMs / 1000)} 秒进入下一个时间窗（防重放机制所致）`);
    await new Promise((resolve) => setTimeout(resolve, waitMs));

    const goodTotp = await api({
      method: 'POST',
      url: '/api/auth/login',
      payload: {
        username: 'normaluser',
        password: { ciphertext: encryptPassword('UserPass123', publicKey), encrypted: true },
        totpCode: await otp.generate({ secret: totpSecret }),
      },
    });
    check('新时间窗的 TOTP 登录成功', goodTotp.statusCode === 200 && !!goodTotp.json().data?.accessToken, goodTotp.body);
  } finally {
    await app.close();
    closeDatabase();
  }

  console.log(`\n${'─'.repeat(50)}`);
  console.log(`通过 ${passed} 项，失败 ${failed} 项`);
  if (failed > 0) {
    console.error('存在失败项，详见上方 ✗ 标记。');
    process.exit(1);
  }
  console.log('全部通过 ✓');
}

main().catch((err) => {
  console.error('\n测试执行出错：', err);
  process.exit(1);
});

void rmSync;
