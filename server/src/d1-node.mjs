/**
 * D1 → node:sqlite 适配层：让 server/src/worker.js 在纯 Node 环境跑起来。
 * 占位符 ?N 按名称绑定（与 D1 语义一致，复用测试夹具同款映射）；
 * node:sqlite 全同步，天然无并发写竞争；batch 映射为单事务。
 */
import { DatabaseSync } from 'node:sqlite';

export function openD1(path) {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA busy_timeout = 5000;');
  db.exec('PRAGMA synchronous = NORMAL;');
  const cache = new Map();
  const statement = (sql) => {
    let stmt = cache.get(sql);
    if (!stmt) {
      stmt = db.prepare(sql);
      if (cache.size >= 200) cache.clear();
      cache.set(sql, stmt);
    }
    return stmt;
  };
  function prepare(sql) {
    let args = [];
    const params = () => Object.fromEntries(args.map((v, i) => [String(i + 1), v]));
    const isRead = /^\s*(?:SELECT|WITH)\b/i.test(sql);
    return {
      sql,
      bind(...values) { args = values; return this; },
      async first() { return statement(sql).get(params()) ?? null; },
      async all() { return { results: statement(sql).all(params()) }; },
      _run() { const r = statement(sql).run(params()); return { meta: { changes: r.changes, last_row_id: Number(r.lastInsertRowid) } }; },
      // D1 batch 语义：SELECT 返回 {results}，写语句返回 {meta}（对齐 storeTotalReport 等调用方的检查）
      _exec() { return isRead ? { results: statement(sql).all(params()), meta: { changes: 0 } } : this._run(); },
      async run() { return this._run(); },
    };
  }
  return {
    db,
    prepare,
    async batch(stmts) {
      db.exec('BEGIN');
      try { const out = stmts.map((s) => s._exec()); db.exec('COMMIT'); return out; }
      catch (err) { db.exec('ROLLBACK'); throw err; }
    },
  };
}
