process.env.TZ = 'Asia/Shanghai';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { collectDevinDays, discoverDevinDbs } from '../sync/devin.js';
import { mergeOortDays } from '../sync/oort.js';
import { batches } from '../sync/report.js';

// 会话库时间戳是 Unix 秒，按北京时间分日；用 UTC 基准构造保证与 CI 时区无关。
const UTC_EVENING = Math.floor(Date.parse('2026-11-13T16:30:00Z') / 1000); // 北京时间已是次日 00:30
const UTC_NOON = Math.floor(Date.parse('2026-11-13T10:00:00Z') / 1000);    // 北京时间同日 18:00

function createDb(path) {
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY, working_directory TEXT NOT NULL, backend_type TEXT NOT NULL,
    model TEXT NOT NULL, agent_mode TEXT NOT NULL, created_at INTEGER NOT NULL, last_activity_at INTEGER NOT NULL);
    CREATE TABLE message_nodes (row_id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL,
    node_id INTEGER NOT NULL, parent_node_id INTEGER, chat_message TEXT NOT NULL, created_at INTEGER NOT NULL);`);
  db.close();
  return path;
}
function addSession(path, { id = 'sess-1', model = 'claude-opus-5-5-medium' } = {}) {
  const db = new DatabaseSync(path);
  db.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(id, 'D:/work', 'windsurf', model, 'bypass', UTC_NOON, UTC_NOON + 600);
  db.close();
}
function addMessage(path, { sessionId = 'sess-1', nodeId, messageId, role = 'assistant', model, metrics,
  created = UTC_NOON, raw = null } = {}) {
  const chat = raw ?? JSON.stringify({ message_id: messageId, role, content: 'hi',
    metadata: { num_tokens: metrics?.output_tokens ?? null, request_id: 'req-1',
      ...(model ? { generation_model: model } : {}), metrics: metrics ?? null,
      created_at: new Date(created * 1000).toISOString() } });
  const db = new DatabaseSync(path);
  db.prepare('INSERT INTO message_nodes (session_id, node_id, chat_message, created_at) VALUES (?, ?, ?, ?)')
    .run(sessionId, nodeId, chat, created);
  db.close();
}
const metrics = (input = 100, output = 20, cacheRead = 70, cacheWrite = 10) =>
  ({ input_tokens: input, output_tokens: output, cache_read_tokens: cacheRead, cache_creation_tokens: cacheWrite,
    context_input_tokens: input + cacheRead + cacheWrite, total_time_ms: 3448 });

function fixture(t, name = 'cli') {
  const root = mkdtempSync(join(tmpdir(), 'devin-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'Devin', name), { recursive: true });
  const db = createDb(join(root, 'Devin', name, 'sessions.db'));
  return { root, db };
}
const read = (paths) => collectDevinDays({ paths, log: (m) => { throw new Error(m); } });

test('Devin captures per-request usage, dedups forest nodes and attributes model', t => {
  const { db } = fixture(t);
  addSession(db);
  addMessage(db, { nodeId: 1, messageId: 'm1', metrics: metrics() });
  addMessage(db, { nodeId: 2, messageId: 'm1', metrics: metrics() }); // 森林重复节点，metrics 一致
  const [day] = read([db]);
  assert.equal(day.day, '2026-11-13'); // UTC_NOON 北京时间同日 18:00
  assert.deepEqual([day.tokens, day.input_tokens, day.output_tokens, day.cache_read, day.cache_write],
    [200, 100, 20, 70, 10]);
  assert.equal(day.requests, 1);
  assert.deepEqual(day.tools, [['Devin', 200]]);
  assert.deepEqual(day.models, [['claude-opus-5-5-medium', 200]]);
  assert.deepEqual(day.tool_models, [['Devin', 'claude-opus-5-5-medium', 200]]);
});

test('Devin splits days by Beijing time across the UTC boundary', t => {
  const { db } = fixture(t);
  addSession(db);
  addMessage(db, { nodeId: 1, messageId: 'evening', metrics: metrics(1, 2, 3, 4), created: UTC_EVENING });
  addMessage(db, { nodeId: 2, messageId: 'noon', metrics: metrics(5, 6, 7, 8), created: UTC_NOON });
  const days = read([db]);
  assert.deepEqual(days.map(d => [d.day, d.requests]), [['2026-11-13', 1], ['2026-11-14', 1]]);
});

test('Devin prefers per-message generation_model over the session model', t => {
  const { db } = fixture(t);
  addSession(db, { model: 'session-model' });
  addMessage(db, { nodeId: 1, messageId: 'm1', model: 'override-model', metrics: metrics() });
  addMessage(db, { nodeId: 2, messageId: 'm2', metrics: metrics() }); // 无覆盖，退回会话模型
  const [day] = read([db]);
  assert.deepEqual(day.models.map(([name, tokens]) => [name, tokens]).sort((a, b) => a[0] < b[0] ? -1 : 1),
    [['override-model', 200], ['session-model', 200]]);
});

test('Devin skips zero-usage, non-assistant and malformed messages', t => {
  const { db } = fixture(t);
  addSession(db);
  addMessage(db, { nodeId: 1, messageId: 'zero', metrics: metrics(0, 0, 0, 0) });
  addMessage(db, { nodeId: 2, messageId: 'nullmetrics' });
  addMessage(db, { nodeId: 3, messageId: 'user', role: 'user', metrics: metrics() });
  addMessage(db, { nodeId: 4, messageId: 'broken', raw: 'not json {' });
  addMessage(db, { nodeId: 5, messageId: 'good', metrics: metrics() });
  const days = read([db]);
  assert.deepEqual(days.map(d => [d.day, d.tokens, d.requests]), [['2026-11-13', 200, 1]]);
});

test('Devin dedups the same message across databases and merges day rows', t => {
  const first = fixture(t, 'cli');
  const second = fixture(t, 'cli-federal');
  for (const { db } of [first, second]) {
    addSession(db);
    addMessage(db, { nodeId: 1, messageId: 'shared', metrics: metrics() });
    addMessage(db, { nodeId: 2, messageId: `only-${db}`, metrics: metrics(30, 40, 0, 0) });
  }
  const days = read([first.db, second.db]);
  // shared 去重只计一次（200），两个库各自的独有消息 70 + 70
  assert.deepEqual(days.map(d => [d.day, d.tokens, d.requests]), [['2026-11-13', 340, 3]]);
});

test('Devin silently skips databases without the expected tables, warns on unreadable files', t => {
  const root = mkdtempSync(join(tmpdir(), 'devin-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const empty = join(root, 'empty.db');
  new DatabaseSync(empty).close();
  const messagesOnly = join(root, 'messages-only.db');
  const db = new DatabaseSync(messagesOnly);
  db.exec('CREATE TABLE message_nodes (row_id INTEGER PRIMARY KEY, chat_message TEXT)');
  db.close();
  const logs = [];
  const days = collectDevinDays({ paths: [empty, messagesOnly, join(root, 'missing.db')], log: (m) => logs.push(m) });
  assert.deepEqual(days, []);
  assert.equal(logs.length, 1); // 缺失文件告警一次；表结构不符静默跳过
  assert.match(logs[0], /missing\.db/);
});

test('Devin rows flow into upload batches alongside other sources', t => {
  const { db } = fixture(t);
  addSession(db);
  addMessage(db, { nodeId: 1, messageId: 'm1', metrics: metrics() });
  const base = [{ day: '2026-11-13', tokens: 10, input_tokens: 10, output_tokens: 0,
    cache_read: 0, cache_write: 0, requests: 1, models: [['model-a', 10]],
    tools: [['codex', 10]], tool_models: [['codex', 'model-a', 10]] }];
  // 与 report.js 相同：补充采集日行经 mergeOortDays 并入主日桶后分批上报
  const [report] = batches(mergeOortDays(base, read([db])), 'fixture-device');
  assert.equal(report.days[0].tokens, 210);
  assert.ok(report.days[0].tools.some(([tool]) => tool === 'codex'));
  assert.ok(report.days[0].tools.some(([tool]) => tool === 'Devin'));
  assert.ok(report.days[0].tool_models.some(([tool, model]) => tool === 'Devin' && model === 'claude-opus-5-5-medium'));
});

test('Devin discovers the documented install layouts per platform', t => {
  const root = mkdtempSync(join(tmpdir(), 'devin-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const dir of [
    join(root, 'AppData', 'Roaming', 'Devin', 'cli'),
    join(root, 'AppData', 'Roaming', 'Devin', 'cli-federal'),
    join(root, '.local', 'share', 'devin', 'cli'),
    join(root, 'Library', 'Application Support', 'devin', 'cli'),
  ]) {
    mkdirSync(dir, { recursive: true });
    createDb(join(dir, 'sessions.db'));
  }
  // Windows 还会补查 ~/.local/share（不依赖环境变量）；macOS/Linux 遵循 XDG_DATA_HOME。
  // canonical() 会 realpath + 小写，期望值同样归一化后再比较。
  const real = (path) => realpathSync(path).toLowerCase();
  assert.deepEqual(discoverDevinDbs({ home: root, env: {}, platform: 'win32' }),
    [join(root, 'AppData', 'Roaming', 'Devin', 'cli', 'sessions.db'),
     join(root, 'AppData', 'Roaming', 'Devin', 'cli-federal', 'sessions.db'),
     join(root, '.local', 'share', 'devin', 'cli', 'sessions.db')].map(real));
  assert.deepEqual(discoverDevinDbs({ home: root, env: {}, platform: 'linux' }),
    [join(root, '.local', 'share', 'devin', 'cli', 'sessions.db')].map(real));
  assert.deepEqual(discoverDevinDbs({ home: root, env: {}, platform: 'darwin' }),
    [join(root, 'Library', 'Application Support', 'devin', 'cli', 'sessions.db'),
     join(root, '.local', 'share', 'devin', 'cli', 'sessions.db')].map(real));
  assert.deepEqual(discoverDevinDbs({ home: root, env: { XDG_DATA_HOME: join(root, 'xdg') }, platform: 'linux' }), []);
});
