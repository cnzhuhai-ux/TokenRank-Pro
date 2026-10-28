/**
 * 建库/升级：空库执行 schema.sql 并把当前 migrations 标记为已应用（schema 已包含其结果，
 * 重复执行 ALTER 会因列已存在失败）；旧库只补齐未应用的迁移。
 */
import { DatabaseSync } from 'node:sqlite';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const dbPath = process.env.TOKENRANK_DB || '/data/tokenrank.db';
const required = (rel) => readFileSync(join(SERVER_DIR, rel), 'utf8');

const isNew = !existsSync(dbPath);
const db = new DatabaseSync(dbPath);
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA busy_timeout = 5000;');
db.exec('CREATE TABLE IF NOT EXISTS applied_migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)');

const migrations = readdirSync(join(SERVER_DIR, 'migrations')).filter((f) => f.endsWith('.sql')).sort();
const applied = new Set(db.prepare('SELECT name FROM applied_migrations').all().map((r) => r.name));

if (isNew && applied.size === 0) {
  db.exec('BEGIN');
  try {
    db.exec(required('schema.sql'));
    const insert = db.prepare('INSERT INTO applied_migrations (name, applied_at) VALUES (?, ?)');
    for (const name of migrations) insert.run(name, Date.now());
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  console.log(`[init-db] ${dbPath} 已由 schema.sql 创建，${migrations.length} 个迁移标记为已应用`);
} else {
  let count = 0;
  for (const name of migrations) {
    if (applied.has(name)) continue;
    db.exec('BEGIN');
    try {
      db.exec(required(join('migrations', name)));
      db.prepare('INSERT INTO applied_migrations (name, applied_at) VALUES (?, ?)').run(name, Date.now());
      db.exec('COMMIT');
      console.log(`[init-db] 应用迁移 ${name}`);
      count += 1;
    } catch (err) {
      db.exec('ROLLBACK');
      throw new Error(`迁移 ${name} 失败：${err.message}`);
    }
  }
  console.log(`[init-db] ${dbPath} 已存在，补齐 ${count} 个迁移`);
}

const tables = db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type IN ('table','view')").get().n;
console.log(`[init-db] 完成：${tables} 张表/视图`);
