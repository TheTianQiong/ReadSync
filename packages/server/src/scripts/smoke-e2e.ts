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

    const kAuthRes = await api({ method: 'GET', url: '/users/auth', headers: kAuth });
    check('KOSync 认证返回 200 OK', kAuthRes.statusCode === 200 && kAuthRes.body.trim() === 'OK', kAuthRes.body);

    const kBad = await api({ method: 'GET', url: '/users/auth', headers: { 'x-auth-user': 'admin', 'x-auth-key': 'f'.repeat(32) } });
    check('KOSync 错误密钥返回 401', kBad.statusCode === 401, kBad.statusCode);

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
