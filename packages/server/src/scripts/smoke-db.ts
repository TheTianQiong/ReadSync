/**
 * 数据库自检脚本：验证迁移、外键、WAL 是否按预期生效。
 * 用法：npx tsx src/scripts/smoke-db.ts
 */
import { closeDatabase, getRawDb, openDatabase } from '../db/index.js';

openDatabase();
const raw = getRawDb();

const tables = raw
  .prepare("select name from sqlite_master where type='table' and name not like 'sqlite_%' order by name")
  .all() as Array<{ name: string }>;

console.log('表数量:', tables.length);
console.log('表列表:', tables.map((t) => t.name).join(', '));
console.log('foreign_keys:', JSON.stringify(raw.pragma('foreign_keys')));
console.log('journal_mode:', JSON.stringify(raw.pragma('journal_mode')));
console.log('sqlite_version:', (raw.prepare('select sqlite_version() as v').get() as { v: string }).v);

closeDatabase();
console.log('OK');
