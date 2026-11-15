import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import zlib from 'node:zlib';
import { collectOortDays, mergeOortDays, TOOL_NAMES } from '../sync/oort.js';

const DAY_MS = 86_400_000;
// 2026-10-28 12:00 UTC = 北京时间 2026-10-28 20:00
const NOW = Date.parse('2026-10-28T12:00:00.000Z');
const beijing = (ms) => new Date(ms + 8 * 3600000).toISOString().slice(0, 10);

function makeHome() {
  const home = mkdtempSync(join(tmpdir(), 'oort-test-'));
  return { home, done: () => rmSync(home, { recursive: true, force: true }) };
}

function writeDshSession(home, name, totals, mtime) {
  const dir = join(home, '.dsh-oortcloud-work', 'storages', 'session_projcache', 'sessions');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, name);
  writeFileSync(file, JSON.stringify({ version: 7, record: { rows: { tokenUsage: { ver: 2, val: { totals } } } } }));
  utimesSync(file, new Date(mtime), new Date(mtime));
}

function writeOortCodexUsage(home, homeName, rows) {
  const dir = join(home, homeName, 'cli', 'db');
  mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(join(dir, 'db.sqlite'));
  db.exec(`CREATE TABLE model_usage (id TEXT PRIMARY KEY, model_id TEXT, started_at INTEGER,
    input_tokens INTEGER, output_tokens INTEGER, cache_read_input_tokens INTEGER, cache_creation_input_tokens INTEGER)`);
  const insert = db.prepare('INSERT INTO model_usage VALUES(?,?,?,?,?,?,?)');
  for (const row of rows) insert.run(row.id, row.model, row.ts, row.input, row.output, row.cacheRead, row.cacheWrite);
  db.close();
}

function writeAiStudioTask(appData, ext, task, apiReqs, mtime) {
  const dir = join(appData, 'OortCloud AI Studio', 'User', 'globalStorage', ext, 'tasks', task);
  mkdirSync(dir, { recursive: true });
  const messages = [];
  for (const req of apiReqs) {
    const payload = req.usage ? { request: 'x', ...req.usage } : { request: 'x' };
    messages.push({ say: 'api_req_started', ts: req.ts, text: req.text ?? JSON.stringify(payload) });
  }
  const file = join(dir, 'ui_messages.json');
  writeFileSync(file, JSON.stringify(messages));
  utimesSync(file, new Date(mtime), new Date(mtime));
}

test('collectOortDays 汇总 DSH 会话累计（按 mtime 归因，零用量与坏文件跳过）', (t) => {
  const { home, done } = makeHome();
  t.after(done);
  writeDshSession(home, 'a.json', { uncachedInputTokens: 1000, outputTokens: 200, cacheReadTokens: 5000, cacheWriteTokens: 0 }, NOW);
  writeDshSession(home, 'b.json', { uncachedInputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 7 }, NOW - 2 * DAY_MS);
  writeDshSession(home, 'zero.json', { uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, NOW);
  const dir = join(home, '.dsh-oortcloud-work', 'storages', 'session_projcache', 'sessions');
  writeFileSync(join(dir, 'broken.json'), '{not json');

  const days = collectOortDays({ home, appData: null, log: () => {} });
  assert.equal(days.length, 2);
  const today = days.find((d) => d.day === beijing(NOW));
  assert.equal(today.tokens, 6200);
  assert.equal(today.input_tokens, 1000);
  assert.equal(today.output_tokens, 200);
  assert.equal(today.cache_read, 5000);
  assert.equal(today.requests, 1);
  assert.deepEqual(today.tools, [[TOOL_NAMES.dsh, 6200]]);
  const other = days.find((d) => d.day === beijing(NOW - 2 * DAY_MS));
  assert.equal(other.tokens, 22);
  assert.equal(other.requests, 1);
  // 协议形态：models/tool_models 为空数组
  assert.deepEqual(today.models, []);
  assert.deepEqual(today.tool_models, []);
});

test('collectOortDays 解析 AI Studio 的 Cline/Roo 请求记录（跨扩展、按 ts 分日）', (t) => {
  const { home, done } = makeHome();
  t.after(done);
  const appData = join(home, 'appdata');
  writeAiStudioTask(appData, 'saoudrizwan.claude-dev', 'task-1', [
    { ts: NOW, usage: { tokensIn: 5000, tokensOut: 100, cacheWrites: 0, cacheReads: 3000, cost: 0 } },
    { ts: NOW - DAY_MS, usage: { tokensIn: 800, tokensOut: 20, cacheWrites: 0, cacheReads: 0, cost: 0 } },
    { ts: NOW + 1000 }, // 未完成请求：没有 tokensIn 字段，不计
  ], NOW);
  writeAiStudioTask(appData, 'rooveterinaryinc.roo-cline', 'task-2', [
    { ts: NOW, text: '{"request":"...前缀截断的非法 JSON..." ,"tokensIn":120,"tokensOut":30,"cacheReads":600,"cacheWrites":10,"cost":0}' },
  ], NOW);

  const days = collectOortDays({ home, appData, log: () => {} });
  assert.equal(days.length, 2);
  const today = days.find((d) => d.day === beijing(NOW));
  // claude-dev 8100 + roo 760
  assert.equal(today.tokens, 8860);
  assert.equal(today.requests, 2);
  assert.deepEqual(today.tools, [[TOOL_NAMES.aiStudio, 8860]]);
  const yesterday = days.find((d) => d.day === beijing(NOW - DAY_MS));
  assert.equal(yesterday.tokens, 820);
  assert.equal(yesterday.requests, 1);
});

test('collectOortDays 把 AI Studio 内置助手（oortcodex 扩展）与 Cline 任务合并为同一工具', (t) => {
  const { home, done } = makeHome();
  t.after(done);
  const appData = join(home, 'appdata');
  writeAiStudioTask(appData, 'oortcodex.oortcodex', 'task-codex', [
    { ts: NOW, usage: { tokensIn: 1000, tokensOut: 100, cacheWrites: 0, cacheReads: 500, cost: 0 } },
  ], NOW);
  writeAiStudioTask(appData, 'saoudrizwan.claude-dev', 'task-cline', [
    { ts: NOW, usage: { tokensIn: 200, tokensOut: 20, cacheWrites: 0, cacheReads: 0, cost: 0 } },
  ], NOW);

  const days = collectOortDays({ home, appData, log: () => {} });
  assert.equal(days.length, 1);
  assert.equal(days[0].tokens, 1820);
  assert.equal(days[0].requests, 2);
  assert.deepEqual(days[0].tools, [[TOOL_NAMES.aiStudio, 1820]]);
});

test('collectOortDays 采集 OortCodex Desktop 的 model_usage（ZCode 内核数据库）', (t) => {
  const { home, done } = makeHome();
  t.after(done);
  writeOortCodexUsage(home, 'OortCodexWork', [
    { id: 'u1', model: 'glm-5.3-flash', ts: NOW, input: 1000, output: 100, cacheRead: 600, cacheWrite: 0 },
    { id: 'u2', model: 'glm-5.3-flash', ts: NOW - DAY_MS, input: 200, output: 20, cacheRead: 0, cacheWrite: 10 },
    { id: 'u3', model: 'glm-5.3-flash', ts: NOW, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  ]);
  // 预览版目录里的同一条记录不重复计数；损坏的库只跳过
  writeOortCodexUsage(home, 'OortCodexWork Preview', [
    { id: 'u1', model: 'glm-5.3-flash', ts: NOW, input: 1000, output: 100, cacheRead: 600, cacheWrite: 0 },
  ]);
  const broken = join(home, 'OortCodexWork Dev', 'cli', 'db');
  mkdirSync(broken, { recursive: true });
  writeFileSync(join(broken, 'db.sqlite'), 'not a database');

  const days = collectOortDays({ home, appData: null, log: () => {} });
  assert.equal(days.length, 2);
  const today = days.find((d) => d.day === beijing(NOW));
  // input_tokens 含 cache_read：新输入 1000-600，缓存命中 600，输出 100
  assert.equal(today.tokens, 1100);
  assert.equal(today.input_tokens, 400);
  assert.equal(today.cache_read, 600);
  assert.equal(today.output_tokens, 100);
  assert.equal(today.requests, 1);
  assert.deepEqual(today.tools, [[TOOL_NAMES.oortCodexDesktop, 1100]]);
  assert.deepEqual(today.models, [['glm-5.3-flash', 1100]]);
  assert.deepEqual(today.tool_models, [[TOOL_NAMES.oortCodexDesktop, 'glm-5.3-flash', 1100]]);
  const yesterday = days.find((d) => d.day === beijing(NOW - DAY_MS));
  assert.equal(yesterday.tokens, 230);
  assert.equal(yesterday.cache_write, 10);
  assert.equal(yesterday.requests, 1);
});

test('collectOortDays 同日多源合并、无数据目录时返回空', (t) => {
  const { home, done } = makeHome();
  t.after(done);
  assert.deepEqual(collectOortDays({ home, appData: null, log: () => {} }), []);
  const appData = join(home, 'appdata');
  writeDshSession(home, 'dsh.json', { uncachedInputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0 }, NOW);
  writeAiStudioTask(appData, 'saoudrizwan.claude-dev', 't', [
    { ts: NOW, usage: { tokensIn: 10, tokensOut: 5, cacheWrites: 0, cacheReads: 0, cost: 0 } },
  ], NOW);
  const days = collectOortDays({ home, appData, log: () => {} });
  assert.equal(days.length, 1);
  assert.equal(days[0].tokens, 165);
  assert.equal(days[0].requests, 2);
  assert.equal(days[0].tools.length, 2);
});

test('mergeOortDays 不改写 ZCode 的工具名，并叠加 Oort 用量', () => {
  const base = [{
    day: '2026-10-28', tokens: 1000, input_tokens: 600, output_tokens: 400, cache_read: 0, cache_write: 0,
    requests: 10, models: [['glm-5.3', 1000]], tools: [['zcode', 700], ['workbuddy', 300]],
    tool_models: [['zcode', 'glm-5.3', 700]], cost: { basis: 'token_watcher_api_estimate', currency: 'USD', usd_micros: 1, models: [['glm-5.3', 1]], unpriced_models: [], unpriced_tokens: 0 },
  }];
  const oort = [{
    day: '2026-10-28', tokens: 500, input_tokens: 300, output_tokens: 200, cache_read: 0, cache_write: 0,
    requests: 2, models: [], tools: [[TOOL_NAMES.aiStudio, 500]], tool_models: [],
  }];
  const merged = mergeOortDays(base, oort);
  assert.equal(merged.length, 1);
  const day = merged[0];
  assert.equal(day.tokens, 1500);
  assert.equal(day.requests, 12);
  // zcode 保持原名（ZCode 是独立产品），AI Studio 作为独立工具并入，按量降序
  assert.deepEqual(day.tools.map(([n]) => n), ['zcode', TOOL_NAMES.aiStudio, 'workbuddy']);
  assert.deepEqual(day.tool_models, [['zcode', 'glm-5.3', 700]]);
  // cost 原样保留（Oort 增量不计价），其余字段不影响
  assert.equal(day.cost.usd_micros, 1);
  // 入参未被修改
  assert.deepEqual(base[0].tools, [['zcode', 700], ['workbuddy', 300]]);
});

test('collectOortDays 采集 AI Studio 的 Claude agent 转录用量', (t) => {
  const { home, done } = makeHome();
  t.after(done);
  const appData = join(home, 'appdata');
  const dir = join(appData, 'OortCloud AI Studio', 'User', 'globalStorage', 'oortcodex.oortcodex', 'claude-agent-acp', 'projects', 'proj-1');
  mkdirSync(dir, { recursive: true });
  const lines = [
    JSON.stringify({ type: 'user', timestamp: new Date(NOW).toISOString() }),
    JSON.stringify({ type: 'assistant', timestamp: new Date(NOW).toISOString(),
      message: { usage: { input_tokens: 20086, output_tokens: 106, cache_read_input_tokens: 0, cache_creation_input_tokens: 40 } } }),
    JSON.stringify({ type: 'assistant', timestamp: new Date(NOW - DAY_MS).toISOString(),
      message: { usage: { input_tokens: 500, output_tokens: 50, cache_read_input_tokens: 300, cache_creation_input_tokens: 0 } } }),
    // 全零用量不计；无 usage 的行不计
    JSON.stringify({ type: 'assistant', timestamp: new Date(NOW).toISOString(),
      message: { usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } }),
    JSON.stringify({ type: 'assistant', timestamp: new Date(NOW).toISOString(), message: {} }),
    '{broken-line',
  ];
  writeFileSync(join(dir, 'session.jsonl'), lines.join('\n'));

  const days = collectOortDays({ home, appData, log: () => {} });
  assert.equal(days.length, 2);
  const today = days.find((d) => d.day === beijing(NOW));
  assert.equal(today.tokens, 20232);
  assert.equal(today.requests, 1);
  assert.deepEqual(today.tools, [[TOOL_NAMES.aiStudio, 20232]]);
  const yesterday = days.find((d) => d.day === beijing(NOW - DAY_MS));
  assert.equal(yesterday.tokens, 850);
  assert.equal(yesterday.requests, 1);
});

test('mergeOortDays 为 Oort 独有的日子补新行，tools 按协议上限保留', () => {
  const oortOnly = [{
    day: '2026-10-20', tokens: 90, input_tokens: 90, output_tokens: 0, cache_read: 0, cache_write: 0,
    requests: 9, models: [], tools: [], tool_models: [],
  }];
  const merged = mergeOortDays([], oortOnly);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].day, '2026-10-20');
  assert.equal(merged[0].tokens, 90);

  const manyTools = Array.from({ length: 10 }, (_, i) => [`tool${i}`, (i + 1) * 10]);
  const base = [{ day: '2026-10-28', tokens: 550, input_tokens: 550, output_tokens: 0, cache_read: 0, cache_write: 0, requests: 0, models: [], tools: manyTools, tool_models: [] }];
  const result = mergeOortDays(base, []);
  // 10 个工具低于协议上限 128，按量降序全部保留；最小的 tool0 也不再被裁掉。
  assert.equal(result[0].tools.length, 10);
  assert.deepEqual(result[0].tools.map(([name]) => name),
    ['tool9', 'tool8', 'tool7', 'tool6', 'tool5', 'tool4', 'tool3', 'tool2', 'tool1', 'tool0']);
  assert.deepEqual(base[0].tools, manyTools);
});

test('mergeOortDays 输出可被 JSON 序列化（tools 为数组而非 Map）', () => {
  const base = [{ day: '2026-10-28', tokens: 1, input_tokens: 1, output_tokens: 0, cache_read: 0, cache_write: 0, requests: 1, models: [], tools: [['zcode', 1]], tool_models: [] }];
  const oort = [{ day: '2026-10-28', tokens: 2, input_tokens: 2, output_tokens: 0, cache_read: 0, cache_write: 0, requests: 1, models: [], tools: [[TOOL_NAMES.aiStudio, 2]], tool_models: [] }];
  const json = JSON.stringify(mergeOortDays(base, oort));
  assert.match(json, /zcode/);
  assert.match(json, /OortCloud AI Studio/);
  assert.ok(!/"tools":\s*{}/.test(json));
});

test('mergeOortDays 的 credits 合并覆盖 models/tool_models 四字段，分项和不超过 total', () => {
  const upstream = [{
    day: '2026-10-30', tokens: 100, input_tokens: 60, output_tokens: 40, cache_read: 0, cache_write: 0,
    requests: 1, models: [], tools: [['qoder', 100]], tool_models: [],
    credits: {
      total: 10, tools: [['qoder', 10]],
      models: [['GLM-5.3', 6], ['glm-5.3', 4]],
      tool_models: [['qoder', 'GLM-5.3', 6], ['qoder', 'glm-5.3', 4]],
    },
  }];
  const trae = [{
    day: '2026-10-30', tokens: 200, input_tokens: 120, output_tokens: 80, cache_read: 0, cache_write: 0,
    requests: 2, models: [['auto', 200]], tools: [['Trae', 200]], tool_models: [['Trae', 'auto', 200]],
    credits: {
      total: 16.5, tools: [['Trae', 16.5]],
      models: [['GLM-5.3', 10], ['auto', 6.5]],
      tool_models: [['Trae', 'GLM-5.3', 10], ['Trae', 'auto', 6.5]],
    },
  }];
  const day = mergeOortDays(upstream, trae)[0];
  assert.equal(day.credits.total, 26.5);
  assert.deepEqual(day.credits.tools, [['Trae', 16.5], ['qoder', 10]]);
  // 同名异写在此处保持原样（归一化在服务端榜单），只做同键相加
  assert.deepEqual(day.credits.models, [['GLM-5.3', 16], ['auto', 6.5], ['glm-5.3', 4]]);
  assert.equal(day.credits.tool_models.length, 4);
  const sum = (rows) => rows.reduce((n, row) => n + row[row.length - 1], 0);
  assert.ok(Math.abs(sum(day.credits.models) - 26.5) < 1e-6);
  // 旧客户端只报 total/tools 时，合并结果不出现空的 models 字段
  const legacy = mergeOortDays([{
    day: '2026-10-29', tokens: 1, input_tokens: 1, output_tokens: 0, cache_read: 0, cache_write: 0,
    requests: 1, models: [], tools: [['qoder', 1]], tool_models: [],
    credits: { total: 2, tools: [['qoder', 2]] },
  }], [{
    day: '2026-10-29', tokens: 3, input_tokens: 3, output_tokens: 0, cache_read: 0, cache_write: 0,
    requests: 1, models: [], tools: [['Trae', 3]], tool_models: [],
    credits: { total: 1, tools: [['Trae', 1]] },
  }]);
  assert.deepEqual(Object.keys(legacy[0].credits).sort(), ['tools', 'total']);
  assert.equal(legacy[0].credits.total, 3);
});

// dsh 会话日志是追加的多帧 zstd；用 Node 内置压缩器造同样的分帧文件
const hasZstd = typeof zlib.zstdCompressSync === 'function' && typeof zlib.zstdDecompressSync === 'function';
const zstdFrames = (records) => Buffer.concat(records.map((r) =>
  zlib.zstdCompressSync(Buffer.from(JSON.stringify(r) + '\n'))));

function writeDshLog(home, sessionId, records) {
  const dir = join(home, '.dsh-oortcloud-work', 'sessions', '--ws--', sessionId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'session.v4.jsonl.zstd'), zstdFrames(records));
  return dir;
}

test('collectOortDays 按 dsh 会话日志逐请求分日，同会话不再读 projcache', { skip: !hasZstd && 'Node 缺少 zstd 内置实现' }, (t) => {
  const { home, done } = makeHome();
  t.after(done);
  const id = 'session-abc';
  const createdAt = NOW - 2 * DAY_MS;
  writeDshLog(home, id, [
    { type: 'session', version: 4, id, createdAt, isSeeded: false },
    { type: 'request/header', seq: 1, time: createdAt, data: { header: { config: { provider: 'p', model: 'GLM-5.3-Flash' } } } },
    { type: 'assistant/message', seq: 2, time: createdAt, data: { turn: 1, step: 1,
      usage: { inputTokens: 100, outputTokens: 10, totalTokens: 110 }, message: {} } },
    { type: 'assistant/message', seq: 3, time: NOW, data: { turn: 2, step: 1,
      usage: { inputTokens: 50, cacheReadTokens: 20, outputTokens: 5, totalTokens: 75 } } },
  ]);
  // 同一会话的 projcache 累计值（150/15/20）不能被重复计入
  writeDshSession(home, id + '.json', { uncachedInputTokens: 150, outputTokens: 15, cacheReadTokens: 20, cacheWriteTokens: 0 }, NOW);

  const days = collectOortDays({ home, appData: null, localAppData: null, log: () => {} });
  assert.equal(days.length, 2);
  const today = days.find((d) => d.day === beijing(NOW));
  assert.equal(today.tokens, 75);
  assert.equal(today.input_tokens, 50);
  assert.equal(today.cache_read, 20);
  assert.equal(today.requests, 1);
  assert.deepEqual(today.tools, [[TOOL_NAMES.dsh, 75]]);
  assert.deepEqual(today.models, [['glm-5.3-flash', 75]]);
  const older = days.find((d) => d.day === beijing(createdAt));
  assert.equal(older.tokens, 110);
  assert.deepEqual(older.models, [['glm-5.3-flash', 110]]);
});

test('dsh 种子会话开头重放的父会话历史不计入', { skip: !hasZstd && 'Node 缺少 zstd 内置实现' }, (t) => {
  const { home, done } = makeHome();
  t.after(done);
  const id = 'session-fork';
  const createdAt = NOW - DAY_MS / 2;
  writeDshLog(home, id, [
    { type: 'session', version: 4, id, createdAt, isSeeded: true, parentSession: 'session-parent' },
    { type: 'assistant/message', seq: 1, time: NOW - 3 * DAY_MS, data: { turn: 1, step: 1,
      usage: { inputTokens: 900, outputTokens: 90, totalTokens: 990 }, message: {} } },
    { type: 'assistant/message', seq: 2, time: NOW, data: { turn: 2, step: 1,
      usage: { inputTokens: 40, outputTokens: 4, totalTokens: 44 }, message: {} } },
  ]);

  const days = collectOortDays({ home, appData: null, localAppData: null, log: () => {} });
  assert.equal(days.length, 1);
  assert.equal(days[0].day, beijing(NOW));
  assert.equal(days[0].tokens, 44);
  assert.equal(days[0].requests, 1);
});

test('dsh 日志解不开时退回 projcache 累计', { skip: !hasZstd && 'Node 缺少 zstd 内置实现' }, (t) => {
  const { home, done } = makeHome();
  t.after(done);
  const id = 'session-broken';
  const dir = join(home, '.dsh-oortcloud-work', 'sessions', '--ws--', id);
  mkdirSync(dir, { recursive: true });
  const truncated = Buffer.concat([
    Buffer.from(JSON.stringify({ type: 'session', version: 4, id, createdAt: NOW, isSeeded: false }) + '\n'),
  ]);
  writeFileSync(join(dir, 'session.v4.jsonl.zstd'), Buffer.concat([
    zlib.zstdCompressSync(truncated),
    Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x00, 0x00, 0x00]), // 截断帧
  ]));
  writeDshSession(home, id + '.json', { uncachedInputTokens: 300, outputTokens: 30, cacheReadTokens: 0, cacheWriteTokens: 0 }, NOW);

  const days = collectOortDays({ home, appData: null, localAppData: null, log: () => {} });
  assert.equal(days.length, 1);
  assert.equal(days[0].tokens, 330);
  assert.deepEqual(days[0].tools, [[TOOL_NAMES.dsh, 330]]);
});

test('collectOortDays 采集 OortOffice 内置 ZCode 内核的 model_usage', (t) => {
  const { home, done } = makeHome();
  t.after(done);
  const data = join(home, 'localappdata');
  const dir = join(data, 'OortOffice', 'zcode-home', '.zcode', 'cli', 'db');
  mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(join(dir, 'db.sqlite'));
  db.exec(`CREATE TABLE model_usage (id TEXT PRIMARY KEY, model_id TEXT, started_at INTEGER,
    input_tokens INTEGER, output_tokens INTEGER, cache_read_input_tokens INTEGER, cache_creation_input_tokens INTEGER)`);
  const insert = db.prepare('INSERT INTO model_usage VALUES(?,?,?,?,?,?,?)');
  insert.run('o1', 'GLM-5.3', NOW, 1000, 100, 600, 0);
  insert.run('o2', 'GLM-5.3', NOW - DAY_MS, 200, 20, 0, 10);
  db.close();

  const days = collectOortDays({ home, appData: null, localAppData: data, log: () => {} });
  assert.equal(days.length, 2);
  const today = days.find((d) => d.day === beijing(NOW));
  assert.equal(today.tokens, 1100);
  assert.equal(today.input_tokens, 400);
  assert.equal(today.cache_read, 600);
  assert.deepEqual(today.tools, [[TOOL_NAMES.oortOffice, 1100]]);
  assert.deepEqual(today.tool_models, [[TOOL_NAMES.oortOffice, 'glm-5.3', 1100]]);
  const yesterday = days.find((d) => d.day === beijing(NOW - DAY_MS));
  assert.equal(yesterday.tokens, 230);
  assert.equal(yesterday.cache_write, 10);
});
