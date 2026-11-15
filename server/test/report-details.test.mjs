import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { validateTotalReport, storeTotalReport } from '../src/report.js';

const SCHEMA = readFileSync(new URL('../schema.sql', import.meta.url), 'utf8');
const MIGRATION = readFileSync(new URL('../migrations/0023_full_model_details.sql', import.meta.url), 'utf8');
const DAY = '2026-01-01';

const report = (days, extra = {}) => ({ v: 2, device_id: 'dev-1', client: 'tokenrank-sync',
  timezone: 'Asia/Shanghai', token_basis: 'upstream_total', source_at: Date.now(),
  full: true, complete: true, days, ...extra });
const day = (extra = {}) => ({ day: DAY, tokens: 1024, input_tokens: 1024, output_tokens: 0,
  cache_read: 0, cache_write: 0, requests: 1, models: [], tools: [], ...extra });

test('token 维度明细接受协议上限 1024/128/1024，超出即拒绝', () => {
  const models = Array.from({ length: 1024 }, (_, i) => [`m${i}`, 1]);
  const tools = Array.from({ length: 128 }, (_, i) => [`t${i}`, 8]);
  const tool_models = Array.from({ length: 1024 }, (_, i) => [`t${i % 128}`, `m${i}`, 1]);
  assert.doesNotThrow(() => validateTotalReport(report([day({ models, tools, tool_models })])));
  for (const bad of [
    day({ models: [...models, ['m1024', 1]] }),
    day({ tools: [...tools, ['t128', 8]] }),
    day({ tool_models: [...tool_models, ['t0', 'm0', 1]] }),
  ]) assert.throws(() => validateTotalReport(report([bad])), /invalid/);
});

function env(db) {
  const prepare = sql => {
    let args = [];
    const params = () => Object.fromEntries(args.map((v, i) => [String(i + 1), v]));
    return { sql, bind(...values) { args = values; return this; },
      async first() { return db.prepare(sql).get(params()) ?? null; },
      async all() { return { results: db.prepare(sql).all(params()) }; },
      _run() { const r = db.prepare(sql).run(params()); return { meta: { changes: r.changes, last_row_id: Number(r.lastInsertRowid) } }; },
      async run() { return this._run(); } };
  };
  return { DB: { prepare, async batch(stmts) {
    db.exec('BEGIN'); try { const results = stmts.map(s => s._run()); db.exec('COMMIT'); return results; }
    catch (err) { db.exec('ROLLBACK'); throw err; }
  } } };
}

test('上报与榜单聚合不再截断模型、工具与工具×模型明细', async t => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec(SCHEMA);
  db.prepare('INSERT INTO users(id,openid,nickname,created_at,updated_at) VALUES(1,?,?,?,?)').run('o', 'n', 1, 1);
  db.prepare('INSERT INTO connect_tokens(token,user_id,created_at) VALUES(?,?,?)').run('tok-1', 1, 1);

  const models = Array.from({ length: 30 }, (_, i) => [`m${i}`, 10]);
  const tools = Array.from({ length: 30 }, (_, i) => [`tool${i}`, 10]);
  const tool_models = Array.from({ length: 30 }, (_, i) => [`tool${i}`, `m${i}`, 10]);
  const d = day({ tokens: 300, input_tokens: 300, models, tools, tool_models });
  const res = await storeTotalReport(env(db), { user_id: 1, token: 'tok-1' }, report([d]));
  assert.equal(res.status, 200);

  const row = db.prepare('SELECT models_json, tools_json, tool_models_json FROM ranked_usage WHERE user_id=1 AND day=?').get(DAY);
  const modelsJson = JSON.parse(row.models_json);
  assert.equal(modelsJson.length, 30);
  assert.ok(modelsJson.some(([name]) => name === 'm29'));
  assert.equal(JSON.parse(row.tools_json).length, 30);
  assert.equal(JSON.parse(row.tool_models_json).length, 30);
});

test('0023 迁移在已有数据上重建视图，token 明细仍不截断', t => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec(SCHEMA);
  db.prepare('INSERT INTO users(id,openid,nickname,created_at,updated_at) VALUES(1,?,?,?,?)').run('o', 'n', 1, 1);
  db.prepare('INSERT INTO usage_device_state(user_id,device_id,source_at,active,last_report_at,updated_at) VALUES(1,?,?,1,?,?)').run('dev', 1, 1, 1);
  db.prepare(`INSERT INTO daily_totals(user_id,device_id,day,tokens,input_tokens,output_tokens,cache_read,cache_write,requests,
    models_json,tools_json,source_at,updated_at,cost_json,credits_json,tool_models_json) VALUES(1,'dev',?,300,300,0,0,0,1,?,?,?,?,NULL,NULL,?)`)
    .run(DAY, JSON.stringify(Array.from({ length: 300 }, (_, i) => [`m${i}`, i + 1])),
      JSON.stringify(Array.from({ length: 140 }, (_, i) => [`tool${i}`, i + 1])), 1, 1,
      JSON.stringify(Array.from({ length: 300 }, (_, i) => [`tool${i % 140}`, `m${i}`, 1])));
  db.exec(MIGRATION);
  const row = db.prepare('SELECT models_json, tools_json, tool_models_json FROM ranked_usage WHERE user_id=1 AND day=?').get(DAY);
  assert.equal(JSON.parse(row.models_json).length, 300);
  assert.equal(JSON.parse(row.tools_json).length, 140);
  assert.equal(JSON.parse(row.tool_models_json).length, 300);
});
