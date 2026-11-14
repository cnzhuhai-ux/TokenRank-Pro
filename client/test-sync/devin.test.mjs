process.env.TZ = 'Asia/Shanghai';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, realpathSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { collectDevinDays, discoverDevinDbs } from '../sync/devin.js';
import { mergeOortDays } from '../sync/oort.js';
import { batches, sync } from '../sync/report.js';
import { writeConfig } from '../sync/config.js';

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
// 会话可为空的宽松库结构：模拟线上库中 session_id 为 NULL 的节点行。
function createDbNullableSession(path) {
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY, working_directory TEXT NOT NULL, backend_type TEXT NOT NULL,
    model TEXT NOT NULL, agent_mode TEXT NOT NULL, created_at INTEGER NOT NULL, last_activity_at INTEGER NOT NULL);
    CREATE TABLE message_nodes (row_id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT,
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
// request_id 默认按 message_id 派生（同一消息的重复节点共享同一请求）；传 null 显式省略。
// metadataCreated 默认跟随节点时间；传 false 省略该键，传 null/字符串独立覆盖节点 created_at。
function messageJson({ messageId, role = 'assistant', model, metrics, created = UTC_NOON,
  requestId, metadataCreated } = {}) {
  return JSON.stringify({
    ...(messageId !== undefined ? { message_id: messageId } : {}),
    role, content: 'hi',
    metadata: { num_tokens: metrics?.output_tokens ?? null,
      ...(requestId === null ? {} : { request_id: requestId ?? `req-${messageId}` }),
      ...(model !== undefined ? { generation_model: model } : {}),
      metrics: metrics ?? null,
      ...(metadataCreated === false ? {} : { created_at: metadataCreated === undefined
        ? new Date(created * 1000).toISOString() : metadataCreated }) } });
}
function addMessage(path, { sessionId = 'sess-1', nodeId, raw = null, ...msg } = {}) {
  const chat = raw ?? messageJson(msg);
  const db = new DatabaseSync(path);
  db.prepare('INSERT INTO message_nodes (session_id, node_id, chat_message, created_at) VALUES (?, ?, ?, ?)')
    .run(sessionId, nodeId, chat, msg.created ?? UTC_NOON);
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
  // canonical() 会 realpath，且仅在 Windows 上小写化；期望值按同一规则归一化。
  const real = (path) => {
    const found = realpathSync(path);
    return process.platform === 'win32' ? found.toLowerCase() : found;
  };
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

test('Devin dedups by request_id across messages and databases, keeps request-only rows', t => {
  const first = fixture(t, 'cli');
  const second = fixture(t, 'cli-federal');
  addSession(first.db);
  addSession(second.db);
  // 同一 request_id 出现在两条不同 message_id 的 assistant 行：重试/续写只计一次。
  addMessage(first.db, { nodeId: 1, messageId: 'm-a', requestId: 'req-shared', metrics: metrics() });
  addMessage(first.db, { nodeId: 2, messageId: 'm-b', requestId: 'req-shared', metrics: metrics() });
  // 没有 message_id 的 request 级行也要计入。
  addMessage(first.db, { nodeId: 3, requestId: 'req-solo', metrics: metrics(10, 10, 0, 0) });
  // 零 metrics 占位行先于有效行写入同一 request，不得吞掉有效数据。
  addMessage(first.db, { nodeId: 4, messageId: 'ph-1', requestId: 'req-z', metrics: metrics(0, 0, 0, 0) });
  addMessage(first.db, { nodeId: 5, messageId: 'ph-2', requestId: 'req-z', metrics: metrics() });
  // 跨库出现的同一 request_id 全局去重。
  addMessage(second.db, { nodeId: 1, messageId: 'm-c', requestId: 'req-shared', metrics: metrics() });
  const [day] = read([first.db, second.db]);
  assert.equal(day.day, '2026-11-13');
  assert.deepEqual([day.tokens, day.input_tokens, day.output_tokens, day.cache_read, day.cache_write, day.requests],
    [420, 210, 50, 140, 20, 3]);
});

test('Devin falls back to session + message_id dedup when request_id is absent', t => {
  const { db } = fixture(t);
  addSession(db, { id: 'sess-a' });
  addSession(db, { id: 'sess-b' });
  // 无 request_id 时同一 message_id 跨会话是两条不同请求。
  addMessage(db, { sessionId: 'sess-a', nodeId: 1, messageId: 'm-x', requestId: null, metrics: metrics() });
  addMessage(db, { sessionId: 'sess-b', nodeId: 2, messageId: 'm-x', requestId: null, metrics: metrics() });
  // 同一会话内的重复节点只计一次。
  addMessage(db, { sessionId: 'sess-a', nodeId: 3, messageId: 'm-x', requestId: null, metrics: metrics() });
  // request_id 与 message_id 都缺失的行直接跳过。
  addMessage(db, { sessionId: 'sess-a', nodeId: 4, requestId: null, metrics: metrics() });
  const [day] = read([db]);
  assert.deepEqual([day.tokens, day.requests], [400, 2]);
});

test('Devin buckets by metadata completion time instead of node time', t => {
  const { db } = fixture(t);
  addSession(db);
  // 两个节点都在北京时间 11-13 23:59:59 写入（UTC 15:59:59），完成时间分跨北京日界。
  const node = Math.floor(Date.parse('2026-11-13T15:59:59Z') / 1000);
  addMessage(db, { nodeId: 1, messageId: 'before', created: node,
    metadataCreated: '2026-11-13T15:59:59.999000000Z', metrics: metrics() });
  addMessage(db, { nodeId: 2, messageId: 'after', created: node,
    metadataCreated: '2026-11-13T16:00:00.000000000Z', metrics: metrics() });
  const days = read([db]);
  assert.deepEqual(days.map(d => [d.day, d.requests, d.tokens]),
    [['2026-11-13', 1, 200], ['2026-11-14', 1, 200]]);
});

test('Devin falls back to node time when completion time is missing or invalid', t => {
  const { db } = fixture(t);
  addSession(db);
  addMessage(db, { nodeId: 1, messageId: 'null-ts', metadataCreated: null, metrics: metrics() });
  addMessage(db, { nodeId: 2, messageId: 'bad-ts', metadataCreated: 'not-a-timestamp', metrics: metrics() });
  addMessage(db, { nodeId: 3, messageId: 'no-ts', metadataCreated: false, metrics: metrics() });
  // 节点时间也允许毫秒，同样退回节点时间。
  addMessage(db, { nodeId: 4, messageId: 'ms-node', created: UTC_NOON * 1000,
    metadataCreated: 'not-a-timestamp', metrics: metrics() });
  const days = read([db]);
  assert.deepEqual(days.map(d => [d.day, d.requests, d.tokens]), [['2026-11-13', 4, 800]]);
});

test('Devin treats null or missing cache fields as zero', t => {
  const { db } = fixture(t);
  addSession(db);
  addMessage(db, { nodeId: 1, messageId: 'null-cache', metrics: { input_tokens: 100,
    output_tokens: 20, cache_read_tokens: null, cache_creation_tokens: null,
    context_input_tokens: 100, total_time_ms: 100 } });
  addMessage(db, { nodeId: 2, messageId: 'no-cache', metrics: { input_tokens: 100,
    output_tokens: 20, context_input_tokens: 100, total_time_ms: 100 } });
  const [day] = read([db]);
  assert.deepEqual([day.tokens, day.input_tokens, day.output_tokens, day.cache_read, day.cache_write, day.requests],
    [240, 200, 40, 0, 0, 2]);
});

test('Devin reports literal unknown model and falls back from blank generation_model', t => {
  const { db } = fixture(t);
  addSession(db, { id: 'sess-named', model: 'sess-model-x' });
  addSession(db, { id: 'sess-blank', model: '   ' });
  // 逐消息 generation_model 为空白时退回会话模型。
  addMessage(db, { sessionId: 'sess-named', nodeId: 1, messageId: 'blank-gen', model: '   ', metrics: metrics() });
  // generation_model 为 null 且会话模型也不可用时记为 unknown。
  addMessage(db, { sessionId: 'sess-blank', nodeId: 2, messageId: 'null-gen', model: null, metrics: metrics() });
  const [day] = read([db]);
  assert.deepEqual(day.models, [['sess-model-x', 200], ['unknown', 200]]);
  assert.deepEqual(day.tool_models, [['Devin', 'sess-model-x', 200], ['Devin', 'unknown', 200]]);
});

test('Devin keeps arbitrary per-message model names and all nine tool_models tuples', t => {
  const { db } = fixture(t);
  addSession(db);
  const longModel = 'zenith-' + 'z'.repeat(60);
  const names = ['arbor-1', 'birch-2', 'cedar-3', 'glimmer-5', 'harbor-7', 'ion-3',
    'jade-8', 'swe-2-fusion-alpha-2027', longModel];
  names.forEach((name, i) => addMessage(db,
    { nodeId: i + 1, messageId: `model-${i}`, model: name, metrics: metrics() }));
  const [day] = read([db]);
  const trimmed = longModel.slice(0, 60);
  assert.deepEqual([day.tokens, day.requests], [1800, 9]);
  // 模型维度沿用既有 top8 协议；tool_models 九条全部保留，名称原样（上限 60 字符）。
  assert.deepEqual(day.models, [
    ['arbor-1', 200], ['birch-2', 200], ['cedar-3', 200], ['glimmer-5', 200],
    ['harbor-7', 200], ['ion-3', 200], ['jade-8', 200], ['swe-2-fusion-alpha-2027', 200]]);
  assert.deepEqual(day.tool_models, [
    ['Devin', 'arbor-1', 200], ['Devin', 'birch-2', 200], ['Devin', 'cedar-3', 200],
    ['Devin', 'glimmer-5', 200], ['Devin', 'harbor-7', 200], ['Devin', 'ion-3', 200],
    ['Devin', 'jade-8', 200], ['Devin', 'swe-2-fusion-alpha-2027', 200], ['Devin', trimmed, 200]]);
});

test('Devin logs once for a corrupt file, never creates a missing db, still reads valid dbs', t => {
  const root = mkdtempSync(join(tmpdir(), 'devin-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const corrupt = join(root, 'corrupt.db');
  writeFileSync(corrupt, 'this is not a sqlite database at all');
  const missing = join(root, 'missing.db');
  const { db: valid } = fixture(t);
  addSession(valid);
  addMessage(valid, { nodeId: 1, messageId: 'ok', metrics: metrics() });
  const logs = [];
  const days = collectDevinDays({ paths: [corrupt, missing, valid], log: (m) => logs.push(m) });
  assert.deepEqual(days.map(d => [d.day, d.tokens, d.requests]), [['2026-11-13', 200, 1]]);
  assert.equal(logs.length, 2); // 每个坏文件各告警一次
  assert.match(logs[0], /corrupt\.db/);
  assert.match(logs[1], /missing\.db/);
  assert.equal(existsSync(missing), false);
});

test('Devin reads a live WAL database without modifying db or wal bytes', t => {
  const root = mkdtempSync(join(tmpdir(), 'devin-test-'));
  const db = createDb(join(root, 'sessions.db'));
  const writer = new DatabaseSync(db);
  // 清理顺序固定：先关写入连接再删目录（Windows 上打开的文件无法删除）。
  t.after(() => {
    try { writer.close(); } catch { /* 已关闭 */ }
    rmSync(root, { recursive: true, force: true });
  });
  writer.exec('PRAGMA journal_mode=WAL');
  writer.exec('PRAGMA wal_autocheckpoint=0');
  writer.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run('sess-wal', 'D:/work', 'windsurf', 'wal-model', 'bypass', UTC_NOON, UTC_NOON + 600);
  writer.prepare('INSERT INTO message_nodes (session_id, node_id, chat_message, created_at) VALUES (?, ?, ?, ?)')
    .run('sess-wal', 1, messageJson({ messageId: 'wal-m', metrics: metrics() }), UTC_NOON);
  const wal = db + '-wal';
  assert.ok(existsSync(wal));
  const dbBefore = readFileSync(db), walBefore = readFileSync(wal);
  // 写入连接保持打开，模拟 CLI 正在使用会话库。
  const [day] = read([db]);
  assert.deepEqual([day.requests, day.tokens], [1, 200]);
  assert.deepEqual(readFileSync(db), dbBefore);
  assert.deepEqual(readFileSync(wal), walBefore);
});

test('Devin discovers the legacy ~/.config/devin/cli sessions.db on every platform', t => {
  const root = mkdtempSync(join(tmpdir(), 'devin-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const dir of [
    join(root, 'AppData', 'Roaming', 'Devin', 'cli'),
    join(root, 'AppData', 'Roaming', 'Devin', 'cli-federal'),
    join(root, '.local', 'share', 'devin', 'cli'),
    join(root, 'Library', 'Application Support', 'devin', 'cli'),
    join(root, '.config', 'devin', 'cli'),
  ]) {
    mkdirSync(dir, { recursive: true });
    createDb(join(dir, 'sessions.db'));
  }
  // 旧布局作为回退补充发现，与既有候选根去重合并；两侧按 canonical() 同一规则归一化后比较。
  const real = (path) => {
    const found = realpathSync(path);
    return process.platform === 'win32' ? found.toLowerCase() : found;
  };
  const sorted = (paths) => paths.map(real).sort();
  const appdataCli = join(root, 'AppData', 'Roaming', 'Devin', 'cli', 'sessions.db');
  const appdataFederal = join(root, 'AppData', 'Roaming', 'Devin', 'cli-federal', 'sessions.db');
  const xdg = join(root, '.local', 'share', 'devin', 'cli', 'sessions.db');
  const mac = join(root, 'Library', 'Application Support', 'devin', 'cli', 'sessions.db');
  const legacy = join(root, '.config', 'devin', 'cli', 'sessions.db');
  assert.deepEqual(sorted(discoverDevinDbs({ home: root, env: {}, platform: 'win32' })),
    sorted([appdataCli, appdataFederal, xdg, legacy]));
  assert.deepEqual(sorted(discoverDevinDbs({ home: root, env: {}, platform: 'linux' })),
    sorted([xdg, legacy]));
  assert.deepEqual(sorted(discoverDevinDbs({ home: root, env: {}, platform: 'darwin' })),
    sorted([mac, xdg, legacy]));
  // 设置 XDG_DATA_HOME 后 legacy 回退仍然生效。
  assert.deepEqual(discoverDevinDbs({ home: root, env: { XDG_DATA_HOME: join(root, 'xdg') }, platform: 'linux' })
    .map(real), [real(legacy)]);
});

test('sync merges Devin supplemental days into the upstream report without network', async t => {
  const root = mkdtempSync(join(tmpdir(), 'devin-sync-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  // 隔离 HOME 与补充源开关：只留 Devin，其余补充采集关闭。
  const keys = ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'XDG_DATA_HOME',
    'TOKENRANK_OORT_DISABLE', 'TOKENRANK_EXTRA_DISABLE', 'TOKENRANK_TRAE_DISABLE',
    'TOKENRANK_CODEBUDDY_DISABLE', 'TOKENRANK_DEVIN_DISABLE', 'TOKENRANK_OFFLINE', 'TOKENMETER_OFFLINE'];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  t.after(() => { for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
  const home = join(root, 'home');
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.APPDATA = join(home, 'AppData', 'Roaming');
  process.env.LOCALAPPDATA = join(home, 'AppData', 'Local');
  process.env.XDG_DATA_HOME = join(home, '.local', 'share');
  process.env.TOKENRANK_OORT_DISABLE = '1';
  process.env.TOKENRANK_EXTRA_DISABLE = '1';
  process.env.TOKENRANK_TRAE_DISABLE = '1';
  process.env.TOKENRANK_CODEBUDDY_DISABLE = '1';
  delete process.env.TOKENRANK_DEVIN_DISABLE;
  delete process.env.TOKENRANK_OFFLINE;
  delete process.env.TOKENMETER_OFFLINE;

  // 上游统计库事件：codex / gpt-x 在北京时间 11-14 合计 1000。
  const upstreamDb = join(root, 'tokenmeter.db');
  const udb = new DatabaseSync(upstreamDb);
  udb.exec(`CREATE TABLE events (ts INTEGER NOT NULL, tool TEXT, model TEXT,
    total_tokens INTEGER NOT NULL, input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL,
    cached_input INTEGER NOT NULL, cache_write INTEGER NOT NULL)`);
  udb.prepare('INSERT INTO events VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(Date.parse('2026-11-14T10:00:00Z'), 'codex', 'gpt-x', 1000, 600, 100, 300, 0);
  udb.close();

  // Devin 会话库放当前平台的发现路径下：swe-1-6-slow 于北京时间 11-14 17:31 完成。
  const devinBase = process.platform === 'win32' ? process.env.APPDATA
    : process.platform === 'darwin' ? join(home, 'Library', 'Application Support')
    : process.env.XDG_DATA_HOME;
  const devinDir = join(devinBase, process.platform === 'linux' ? 'devin' : 'Devin', 'cli');
  mkdirSync(devinDir, { recursive: true });
  const devinDb = createDb(join(devinDir, 'sessions.db'));
  addSession(devinDb, { id: 'sess-d', model: 'session-fallback' });
  addMessage(devinDb, { sessionId: 'sess-d', nodeId: 1, messageId: 'dm-1', model: 'swe-1-6-slow',
    created: Math.floor(Date.parse('2026-11-14T09:31:00Z') / 1000),
    metadataCreated: '2026-11-14T09:31:00.000000000Z', metrics: metrics(100, 20, 300, 50) });

  const dir = join(root, 'sync-cfg');
  writeConfig({ token: 'a'.repeat(32), server: 'https://fixture.example.com', device_id: 'fixture-device',
    db_path: upstreamDb, upstream_entry: null, protocol_version: 2, synced_days: {} }, dir);
  const configFile = join(dir, 'config.json');
  const configBefore = readFileSync(configFile);
  let calls = 0;
  const result = await sync({ dir, dryRun: true,
    fetcher: () => { calls += 1; throw new Error('unexpected network'); } });
  assert.equal(calls, 0);
  assert.deepEqual(readFileSync(configFile), configBefore);
  assert.equal(result.dryRun, true);
  const days = result.reports.flatMap((r) => r.days);
  assert.equal(days.length, 1);
  const day = days[0];
  assert.deepEqual({ day: day.day, tokens: day.tokens, input_tokens: day.input_tokens,
    output_tokens: day.output_tokens, cache_read: day.cache_read, cache_write: day.cache_write,
    requests: day.requests, tools: day.tools, models: day.models, tool_models: day.tool_models }, {
    day: '2026-11-14', tokens: 1470, input_tokens: 700, output_tokens: 120,
    cache_read: 600, cache_write: 50, requests: 2,
    tools: [['codex', 1000], ['Devin', 470]],
    models: [['gpt-x', 1000], ['swe-1-6-slow', 470]],
    tool_models: [['codex', 'gpt-x', 1000], ['Devin', 'swe-1-6-slow', 470]],
  });
});

test('Devin strips ASCII control characters from generation_model before fallback', t => {
  const { db } = fixture(t);
  addSession(db, { model: 'session-model-y' });
  // 模型名中的控制字符先剥离再 trim；剥离后为空则退回会话模型。
  addMessage(db, { nodeId: 1, messageId: 'ctrl', model: '  fu\u0000sion\n-next\u007f  ', metrics: metrics() });
  addMessage(db, { nodeId: 2, messageId: 'ctrl-only', model: ' \u0000\n\u007f ', metrics: metrics() });
  const [day] = read([db]);
  assert.deepEqual(day.models, [['fusion-next', 200], ['session-model-y', 200]]);
  assert.deepEqual(day.tool_models, [['Devin', 'fusion-next', 200], ['Devin', 'session-model-y', 200]]);
});

test('Devin fallback key needs nonempty session and message, tuple never collides', t => {
  const root = mkdtempSync(join(tmpdir(), 'devin-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'Devin', 'cli'), { recursive: true });
  const db = createDbNullableSession(join(root, 'Devin', 'cli', 'sessions.db'));
  addSession(db, { id: 'a:b' });
  addSession(db, { id: 'a' });
  // 朴素拼接 key 会把 ('a:b','c') 与 ('a','b:c') 合并成一条；元组 key 必须分清两条。
  addMessage(db, { sessionId: 'a:b', nodeId: 1, messageId: 'c', requestId: null, metrics: metrics() });
  addMessage(db, { sessionId: 'a', nodeId: 2, messageId: 'b:c', requestId: null, metrics: metrics() });
  // session_id 为 NULL 且没有 request_id：无法构造回退键，跳过。
  addMessage(db, { sessionId: null, nodeId: 3, messageId: 'orphan', requestId: null,
    metrics: metrics(50, 50, 0, 0) });
  // session_id 为 NULL 但有 request_id：按请求去重照常计入。
  addMessage(db, { sessionId: null, nodeId: 4, requestId: 'req-no-session', metrics: metrics() });
  const [day] = read([db]);
  assert.deepEqual([day.tokens, day.requests], [600, 3]);
});

test('Devin skips malformed node timestamps and future completion days', t => {
  const { db } = fixture(t);
  addSession(db);
  // 微秒级节点时间戳不能被当成毫秒，整条跳过；缺失 metadata 完成时间也无有效回退。
  addMessage(db, { nodeId: 1, messageId: 'us-ts', created: 1763076000000000,
    metadataCreated: false, metrics: metrics() });
  // 完成时间落在远未来北京日：服务端拒绝未来日，跳过。
  addMessage(db, { nodeId: 2, messageId: 'year-2099', created: UTC_NOON,
    metadataCreated: '2099-01-01T00:00:00.000000000Z', metrics: metrics() });
  // 完成时间在明天（相对当前时间的未来日）同样跳过。
  addMessage(db, { nodeId: 3, messageId: 'tomorrow', created: UTC_NOON,
    metadataCreated: new Date(Date.now() + 86400000).toISOString(), metrics: metrics() });
  // 有效对照行照常输出。
  addMessage(db, { nodeId: 4, messageId: 'valid', metrics: metrics() });
  const days = read([db]);
  assert.deepEqual(days.map(d => [d.day, d.tokens, d.requests]), [['2026-11-13', 200, 1]]);
});
