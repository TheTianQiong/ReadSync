#!/usr/bin/env node
/**
 * 部署验收脚本：对一个正在运行的 ReadSync 实例做端到端功能验证。
 *
 * 只依赖 HTTP，因此对 Docker、一键脚本、手动部署三种方式都适用 ——
 * 用来确认「服务起来了」之外，核心业务链路也真的通。
 *
 * 用法：node scripts/verify-deploy.mjs http://localhost:3000
 */
import { createHash, publicEncrypt, constants, randomUUID } from 'node:crypto';

const BASE = (process.argv[2] ?? 'http://localhost:3000').replace(/\/$/, '');

let pass = 0;
let fail = 0;
const check = (name, ok, detail) => {
  if (ok) {
    pass += 1;
    console.log(`  [OK]   ${name}`);
  } else {
    fail += 1;
    console.log(`  [FAIL] ${name}${detail !== undefined ? ` → ${JSON.stringify(detail).slice(0, 200)}` : ''}`);
  }
};

async function req(method, path, { token, body, headers = {}, raw = false } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (raw) return { status: res.status, text: await res.text() };
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { status: res.status, json, text };
}

const encrypt = (plain, pem) =>
  publicEncrypt(
    { key: pem, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
    Buffer.from(plain, 'utf8'),
  ).toString('base64');

console.log(`验收目标：${BASE}\n`);

// 1. 基础可用性
console.log('1. 服务可用性');
const health = await req('GET', '/api/system/health');
check('健康检查返回 200', health.status === 200, health.text);
check('返回版本号', typeof health.json?.data?.version === 'string', health.json);

const spa = await req('GET', '/', { raw: true });
check('前端页面可访问', spa.status === 200, spa.status);
check('返回的是 HTML', spa.text.includes('<!doctype html') || spa.text.includes('<!DOCTYPE html'), spa.text.slice(0, 80));

// 2. 初始化 / 登录
console.log('\n2. 账号与认证');
const bootStatus = await req('GET', '/api/system/bootstrap');
const initialized = bootStatus.json?.data?.initialized === true;

const publicKey = (await req('GET', '/api/system/public-key')).json?.data?.publicKey;
check('可获取 RSA 公钥', typeof publicKey === 'string' && publicKey.includes('BEGIN PUBLIC KEY'));

const password = 'VerifyPass123';
let token = null;

if (!initialized) {
  const boot = await req('POST', '/api/system/bootstrap', {
    body: {
      username: 'verifyadmin',
      email: 'verify@example.com',
      password: { ciphertext: encrypt(password, publicKey), encrypted: true },
      siteName: '验收测试',
    },
  });
  check('初始化管理员成功', boot.status === 200, boot.text);
} else {
  check('站点已初始化（跳过 bootstrap）', true);
}

const login = await req('POST', '/api/auth/login', {
  body: { username: 'verifyadmin', password: { ciphertext: encrypt(password, publicKey), encrypted: true } },
});
check('管理员登录成功', login.status === 200 && !!login.json?.data?.accessToken, login.text);
token = login.json?.data?.accessToken ?? null;

const plaintext = await req('POST', '/api/auth/login', { body: { username: 'verifyadmin', password } });
check('明文密码被拒绝（400）', plaintext.status === 400, plaintext.status);

if (token) {
  const me = await req('GET', '/api/auth/me', { token });
  check('可读取当前用户', me.json?.data?.username === 'verifyadmin', me.json);
}

// 3. 存储与书库
console.log('\n3. 存储与书库');
if (token) {
  const st = await req('POST', '/api/storages', {
    token,
    body: { name: '验收存储', driver: 'local', isDefault: true, config: { path: 'storage', quotaBytes: 0 } },
  });
  check('创建本地存储成功', st.status === 200, st.text);

  const stTest = await req('POST', `/api/storages/${st.json?.data?.id}/test`, { token });
  check('存储连通性测试通过', stTest.json?.data?.ok === true, stTest.json);

  const books = await req('GET', '/api/books', { token });
  check('书库接口可用', books.status === 200 && Array.isArray(books.json?.data?.items), books.text);
}

// 4. 同步与统计
console.log('\n4. 同步与统计');
if (token) {
  const push = await req('PUT', '/api/sync/progress', {
    token,
    body: {
      document: `verify-${randomUUID()}`,
      progress: 'epubcfi(/6/14!/4/2/2/1:0)',
      percentage: 0.42,
      platform: 'koreader',
      readingSeconds: 120,
    },
  });
  check('推送同步进度成功', push.status === 200 && push.json?.data?.accepted === true, push.text);

  const stats = await req('GET', '/api/stats/status', { token });
  check('统计接口可用', stats.status === 200, stats.text);
  check('阅读时长已记录', stats.json?.data?.totalSeconds >= 120, stats.json?.data?.totalSeconds);
}

// 5. KOSync 兼容协议
console.log('\n5. KOSync 兼容协议');
if (initialized === false) {
  const kosyncKey = createHash('md5').update(password).digest('hex');
  const kauth = await req('GET', '/users/auth', {
    headers: { 'x-auth-user': 'verifyadmin', 'x-auth-key': kosyncKey },
    raw: true,
  });
  check('KOSync 认证返回 200 OK', kauth.status === 200 && kauth.text.trim() === 'OK', kauth.text);

  const kput = await req('PUT', '/syncs/progress', {
    headers: { 'x-auth-user': 'verifyadmin', 'x-auth-key': kosyncKey, 'Content-Type': 'application/json' },
    body: { document: 'verify-doc', progress: '/body/text().0', percentage: 0.5, device: 'Test', device_id: 't1' },
  });
  check('KOSync 推送进度成功', kput.status === 200 && kput.json?.document === 'verify-doc', kput.json);
} else {
  check('KOSync 检查跳过（已有账号，密码未知）', true);
}

console.log('\n────────────────────────────────');
console.log(`通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail === 0 ? 0 : 1);
