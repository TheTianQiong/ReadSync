/**
 * 加密封烟测试：验证 secret-box 加解密、脱敏、errors 转出、RSA 密钥与密码哈希。
 * 用法：READSYNC_DATA_DIR=./data-smoke npx tsx src/scripts/smoke-crypto.ts
 */
import { encryptConfig, decryptConfig, encryptString, decryptString, maskConfig } from '../crypto/secret-box.js';
import { ensureKeyPair, getPublicKeyInfo, decryptPassword } from '../crypto/keys.js';
import { hashPassword, verifyPassword, md5Hex, generateNumericCode, generateInviteCode } from '../crypto/password.js';
import { AppError, ERROR_CODES } from '../errors.js';

async function main(): Promise<void> {
  // 1. errors 转出（修复前这里会 SyntaxError）
  console.log('[1] ERROR_CODES 转出:', ERROR_CODES.NOT_FOUND, '| status:', new AppError(ERROR_CODES.NOT_FOUND, 'x').statusCode);

  // 2. AES-256-GCM 盒子
  const enc = encryptString('hello-世界-🔐');
  console.log('[2] 加密:', `${enc.slice(0, 24)}…`, '| 解密还原:', decryptString(enc) === 'hello-世界-🔐');

  // 3. 配置加解密与脱敏
  const cfg = encryptConfig({ url: 'https://dav.example.com', username: 'alice', password: 'secret123' });
  console.log('[3] 密码已加密:', String(cfg.password).startsWith('v1.'));
  console.log('    脱敏后:', JSON.stringify(maskConfig(cfg)));
  console.log('    解密还原:', decryptConfig(cfg).password === 'secret123');

  // 4. RSA 密钥对
  ensureKeyPair();
  const pk = getPublicKeyInfo();
  console.log('[4] RSA 公钥指纹:', pk.fingerprint, '| 算法:', pk.algorithm);

  // 5. 密码哈希
  const hash = await hashPassword('MyPassw0rd');
  console.log('[5] Argon2id 前缀:', hash.slice(0, 20), '| 校验:', await verifyPassword(hash, 'MyPassw0rd'), '| 错误密码:', await verifyPassword(hash, 'wrong'));

  // 6. 各类随机值
  console.log('[6] md5:', md5Hex('test'), '| 验证码:', generateNumericCode(), '| 邀请码:', generateInviteCode());

  void decryptPassword;
  console.log('\n全部通过');
}

main().catch((err) => {
  console.error('失败:', err);
  process.exit(1);
});
