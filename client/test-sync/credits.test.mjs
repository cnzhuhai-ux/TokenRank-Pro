import { test } from 'node:test';
import assert from 'node:assert/strict';
process.env.TOKENRANK_OORT_DISABLE = '1';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readDays } from '../sync/source.js';
import { writeConfig } from '../sync/config.js';
import { sync } from '../sync/report.js';

const CREDIT_DDL = 'CREATE TABLE credit_usage(ts INTEGER NOT NULL, tool TEXT NOT NULL, amount REAL NOT NULL, dedup_key TEXT NOT NULL UNIQUE)';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'tokenrank-credits-test-')), dir = join(root, 'rank'), source = join(root, 'upstream');
  mkdirSync(source);
  const path = join(source, 'tokenmeter.db');
  const db = new DatabaseSync(path);
  db.exec(`PRAGMA journal_mode=WAL; CREATE TABLE events(ts INTEGER, tool TEXT, model TEXT, input_tokens INTEGER, output_tokens INTEGER, cached_input INTEGER, cache_write INTEGER, total_tokens INTEGER);`);
  db.prepare('INSERT INTO events VALUES(?,?,?,?,?,?,?,?)').run(Date.parse('2024-01-02T12:00:00Z'), 'codex', 'gpt-test', 30, 20, 100, 40, 190);
  writeConfig({ server: 'https://rank.test', token: 'a'.repeat(32), device_id: 'device-test', db_path: path }, dir);
  t.after(() => { db.close(); rmSync(root, { recursive: true, force: true }); });
  return { root, dir, path, db };
}

const ack = options => Response.json({ ok: true, accepted: JSON.parse(options.body).days.length });

test('credit_usage(积分源)聚合为 day.credits：北京日界、纯积分日并集、降级', t => {
  const f = fixture(t);
  // 老版本 token-watcher 没有 credit_usage 表：day 不带 credits 字段，同步照常
  assert.equal('credits' in readDays(f.path)[0], false);
  f.db.exec(CREDIT_DDL);
  const addCredit = (ts, tool, amount, key) => f.db.prepare('INSERT INTO credit_usage VALUES(?,?,?,?)').run(ts, tool, amount, key);
  addCredit(Date.parse('2024-01-02T10:00Z'), 'qoder', 2.25, 'k1');
  addCredit(Date.parse('2024-01-02T15:59Z'), 'qoder', 1.5, 'k2');
  addCredit(Date.parse('2024-01-02T16:01Z'), 'qoder', 0.75, 'k3'); // 16:01Z 越界进次日（北京时间）
  const byDay = Object.fromEntries(readDays(f.path).map(d => [d.day, d]));
  assert.deepEqual(byDay['2024-01-02'].credits, { total: 3.75, tools: [['qoder', 3.75]] });
  assert.deepEqual(byDay['2024-01-03'].credits, { total: 0.75, tools: [['qoder', 0.75]] });
  // 纯积分日（没有 events 行）也要出现在日桶里，tokens 为 0
  assert.equal(byDay['2024-01-03'].tokens, 0);
  assert.deepEqual(byDay['2024-01-03'].models, []);
  // 只读：原始表未被改动
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM credit_usage').get().n, 3);
});

test('credits 随报文上报；服务端确认后指纹稳定不重传', async t => {
  const f = fixture(t);
  f.db.exec(CREDIT_DDL);
  f.db.prepare('INSERT INTO credit_usage VALUES(?,?,?,?)').run(Date.parse('2024-01-02T12:00Z'), 'qoder', 4.5, 'k1');
  const sent = [];
  const fetcher = async (url, options) => { sent.push(JSON.parse(options.body)); return ack(options); };
  assert.equal((await sync({ dir: f.dir, fetcher })).accepted, 1); // events 日与积分同日，合并为一个日桶
  assert.deepEqual(sent[0].days.find(d => d.day === '2024-01-02').credits, { total: 4.5, tools: [['qoder', 4.5]] });
  assert.equal((await sync({ dir: f.dir, fetcher })).accepted, 0);
  assert.equal(sent.length, 1);
});

test('浮点舍入后分项之和不超总额（服务端 1e-6 容差前置钳制）', t => {
  const f = fixture(t);
  f.db.exec(CREDIT_DDL);
  const run = (...args) => f.db.prepare('INSERT INTO credit_usage VALUES(?,?,?,?)').run(...args);
  run(Date.parse('2024-01-02T12:00Z'), 'qoder', 0.1234564, 'a');
  run(Date.parse('2024-01-02T12:01Z'), 'qoder', 0.1234564, 'b');
  const day = readDays(f.path).find(d => d.day === '2024-01-02');
  const sum = day.credits.tools.reduce((n, [, amount]) => n + amount, 0);
  assert.ok(sum <= day.credits.total + 1e-9, `sum ${sum} > total ${day.credits.total}`);
  assert.ok(Math.abs(day.credits.total - 0.246913) < 1e-6);
});
