import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { collectExtraDays, TOOL_NAMES } from '../sync/extra.js';
import { mergeOortDays } from '../sync/oort.js';

const DAY_MS = 86_400_000;
const NOW = Date.parse('2026-10-28T12:00:00.000Z');
const beijing = (ms) => new Date(ms + 8 * 3600000).toISOString().slice(0, 10);

function makeDrives() {
  const root = mkdtempSync(join(tmpdir(), 'extra-test-'));
  return { root, done: () => rmSync(root, { recursive: true, force: true }) };
}
function writeWorkbuddy(root, records) {
  const dir = join(root, 'projects', 'f-work-demo');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'session.jsonl'), records.map((r) => typeof r === 'string' ? r : JSON.stringify(r)).join('\n'));
}
function workbuddyRecord(id, ts, usage, model = 'glm-5.3-flash') {
  return { id, timestamp: ts, providerData: { model }, message: { usage } };
}
function writeDeveco(path, messages) {
  mkdirSync(join(path, '..'), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT); CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT)');
  db.prepare('INSERT INTO session VALUES (?,?)').run('ses_1', 'F:/work/demo');
  for (const message of messages) db.prepare('INSERT INTO message VALUES (?,?,?,?,?)')
    .run(message.id, 'ses_1', message.ts, message.ts, JSON.stringify(message.data));
  db.close();
}
// Genspark Code（gencode）的库与 deveco.db 同构，测试夹具共用。
const writeGencode = writeDeveco;

// ToCodex（Cline 系）任务记录：say=api_req_started 的 text 是 JSON，失败请求没有 token 字段。
function writeTocodexTasks(tasksDir, task, messages) {
  const dir = join(tasksDir, task);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'ui_messages.json'), JSON.stringify(messages));
}
function tocodexStarted(ts, tokensIn, tokensOut, cacheReads = 0, cacheWrites = 0) {
  return { ts, say: 'api_req_started', text: JSON.stringify(tokensIn === null
    ? { apiProtocol: 'openai', streamState: 'waiting_for_first_chunk' }
    : { apiProtocol: 'openai', streamState: 'complete', tokensIn, tokensOut, cacheReads, cacheWrites, cost: 0 }) };
}

test('补充采集在全部磁盘发现 WorkBuddy 各版本和 DevEco Code，上游目录不重复计数', (t) => {
  const { root, done } = makeDrives();
  t.after(done);
  const driveA = join(root, 'A'), driveB = join(root, 'B'), home = join(driveA, 'Users', 'me');
  mkdirSync(home, { recursive: true });
  writeWorkbuddy(join(home, '.WorkBuddy'), [workbuddyRecord('upstream', NOW, {
    input_tokens: 9999, output_tokens: 1, cache_read_input_tokens: 0 })]);
  writeWorkbuddy(join(driveB, 'Data', '.workbuddy-ai'), [
    workbuddyRecord('wb-1', NOW, { input_tokens: 1000, output_tokens: 100, cache_read_input_tokens: 400 }),
    workbuddyRecord('wb-zero', NOW, { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0 }),
    '{broken-line',
  ]);
  writeDeveco(join(driveB, 'Apps', 'deveco', 'deveco.db'), [
    { id: 'msg-1', ts: NOW, data: { role: 'assistant', modelID: 'claude-sonnet-4-6',
      tokens: { input: 10, output: 20, reasoning: 5, cache: { read: 30, write: 5 } } } },
    { id: 'msg-user', ts: NOW, data: { role: 'user', modelID: 'claude-sonnet-4-6' } },
    { id: 'msg-zero', ts: NOW, data: { role: 'assistant', modelID: 'm', tokens: { input: 0, output: 0 } } },
    { id: 'msg-broken', ts: NOW, data: 'not-an-object' },
  ]);

  const days = collectExtraDays({ home, env: {}, platform: 'win32', drives: [driveA, driveB], log: () => {} });
  assert.equal(days.length, 1);
  const day = days[0];
  assert.equal(day.day, beijing(NOW));
  // WorkBuddy 1100 + DevEco 65；上游 .WorkBuddy 的 10000 不计入
  assert.equal(day.tokens, 1165);
  assert.equal(day.input_tokens, 610);
  assert.equal(day.output_tokens, 120);
  assert.equal(day.cache_read, 430);
  assert.equal(day.cache_write, 5);
  assert.equal(day.requests, 2);
  assert.deepEqual(day.tools.map(([name]) => name).sort(), [TOOL_NAMES.deveco, TOOL_NAMES.workbuddy].sort());
  assert.deepEqual(day.models.map(([name]) => name).sort(), ['claude-sonnet-4-6', 'glm-5.3-flash']);
  assert.deepEqual(day.tool_models.map(([tool, model]) => [tool, model]).sort(),
    [[TOOL_NAMES.deveco, 'claude-sonnet-4-6'], [TOOL_NAMES.workbuddy, 'glm-5.3-flash']].sort());
});

test('重复目录和重复消息只计一次；坏文件坏库只跳过；extra-roots 已登记的目录不再采集', (t) => {  const { root, done } = makeDrives();
  t.after(done);
  const drive = join(root, 'A'), home = join(drive, 'Users', 'me');
  mkdirSync(home, { recursive: true });
  const registered = join(home, '.workbuddy-intl', 'projects');
  writeWorkbuddy(join(home, '.workbuddy-intl'), [workbuddyRecord('registered', NOW, {
    input_tokens: 500, output_tokens: 50, cache_read_input_tokens: 0 })]);
  mkdirSync(join(home, '.tokenmeter'), { recursive: true });
  writeFileSync(join(home, '.tokenmeter', 'extra-roots.json'),
    JSON.stringify({ workbuddy: ['~/.workbuddy-intl/projects'] }));
  writeWorkbuddy(join(home, '.workbuddy-cn'), [workbuddyRecord('same', NOW, {
    input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 0 })]);
  writeWorkbuddy(join(home, '.WorkBuddy AI'), [workbuddyRecord('same', NOW, {
    input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 0 })]);
  mkdirSync(join(drive, 'Broken'), { recursive: true });
  writeFileSync(join(drive, 'Broken', 'deveco.db'), 'not a database');
  assert.ok(registered);

  const days = collectExtraDays({ home, env: {}, platform: 'win32', drives: [drive], log: () => {} });
  assert.equal(days.length, 1);
  assert.equal(days[0].tokens, 110);
  assert.deepEqual(days[0].tools, [[TOOL_NAMES.workbuddy, 110]]);
});

test('Genspark Code 从 gencode 目录的 OpenCode 同构库采集；独立安装的 opencode 与空目录不采', (t) => {
  const { root, done } = makeDrives();
  t.after(done);
  const drive = join(root, 'A'), home = join(drive, 'Users', 'me');
  mkdirSync(home, { recursive: true });
  writeGencode(join(home, '.local', 'share', 'gencode', 'opencode.db'), [
    { id: 'gen-1', ts: NOW, data: { role: 'assistant', modelID: 'claude-opus-5-5',
      tokens: { input: 1000, output: 200, reasoning: 50, cache: { read: 5000, write: 0 } } } },
    { id: 'gen-2', ts: NOW, data: { role: 'assistant', modelID: 'claude-haiku-5-5',
      tokens: { input: 300, output: 100, reasoning: 0, cache: { read: 700, write: 20 } } } },
    { id: 'gen-user', ts: NOW, data: { role: 'user', modelID: 'claude-opus-5-5' } },
  ]);
  writeGencode(join(drive, 'Tools', 'gencode', 'opencode.db'), [
    { id: 'gen-3', ts: NOW - DAY_MS, data: { role: 'assistant', modelID: 'claude-opus-5-5',
      tokens: { input: 10, output: 20, reasoning: 0, cache: { read: 30, write: 0 } } } },
  ]);
  // 独立安装的真实 opencode（上游 token-watcher 已覆盖）不能被 gencode 规则抢走
  writeGencode(join(home, '.local', 'share', 'opencode', 'opencode.db'), [
    { id: 'real-1', ts: NOW, data: { role: 'assistant', modelID: 'x', tokens: { input: 999999, output: 0 } } },
  ]);
  mkdirSync(join(drive, 'Empty', 'gencode'), { recursive: true });

  const days = collectExtraDays({ home, env: {}, platform: 'win32', drives: [drive], log: () => {} });
  assert.equal(days.length, 2);
  const today = days.find((d) => d.day === beijing(NOW));
  // 1000+200+5000 + 300+100+700+20 = 7320；opencode 目录的 999999 与 user 消息不计入
  assert.equal(today.tokens, 7320);
  assert.equal(today.input_tokens, 1300);
  assert.equal(today.cache_read, 5700);
  assert.equal(today.cache_write, 20);
  assert.equal(today.requests, 2);
  assert.deepEqual(today.tools, [[TOOL_NAMES.gencode, 7320]]);
  assert.deepEqual(today.models.map(([m]) => m).sort(), ['claude-haiku-5-5', 'claude-opus-5-5']);
  assert.deepEqual(today.tool_models.map(([tool, model]) => [tool, model]).sort(),
    [[TOOL_NAMES.gencode, 'claude-haiku-5-5'], [TOOL_NAMES.gencode, 'claude-opus-5-5']].sort());
  const prev = days.find((d) => d.day === beijing(NOW - DAY_MS));
  assert.equal(prev.tokens, 60);
  assert.deepEqual(prev.tools, [[TOOL_NAMES.gencode, 60]]);
});

test('ToCodex：桌面端便携安装按产品目录发现，CLI 读 .vscode-mock，失败请求与坏文件不计', (t) => {
  const { root, done } = makeDrives();
  t.after(done);
  const drive = join(root, 'A'), home = join(drive, 'Users', 'me');
  mkdirSync(home, { recursive: true });
  // 便携安装：data/user-data 在安装目录内（Program Files 被全盘遍历跳过，由已知位置补查）
  const portable = join(drive, 'Program Files', 'ToCodex', 'data', 'user-data', 'User', 'globalStorage', 'tocodex.tocodex', 'tasks');
  writeTocodexTasks(portable, 'task-1', [
    { ts: NOW, say: 'text', text: '你好' },
    tocodexStarted(NOW, 13099, 72, 18304, 0),
    // 失败与重试中的请求没有 token 字段，不能计数
    tocodexStarted(NOW + 1, null),
    { ts: NOW + 2, say: 'api_req_started', text: '{broken' },
    // 全零用量不计
    tocodexStarted(NOW + 3, 0, 0, 0, 0),
  ]);
  // 桌面端标准布局：%APPDATA%\ToCodex Desktop\User\globalStorage
  const standard = join(home, 'AppData', 'Roaming', 'ToCodex Desktop', 'User', 'globalStorage', 'tocodex.tocodex', 'tasks');
  writeTocodexTasks(standard, 'task-2', [tocodexStarted(NOW - DAY_MS, 20165, 139)]);
  // CLI：shim 的 globalStorage 无扩展 id 子目录
  writeTocodexTasks(join(home, '.vscode-mock', 'global-storage', 'tasks'), 'task-3',
    [tocodexStarted(NOW, 1000, 200, 500, 20)]);
  // 逐盘遍历发现 Tools/ToCodex 下的便携安装；坏文件只跳过该任务
  const toolsDir = join(drive, 'Tools', 'ToCodex', 'data', 'user-data', 'User', 'globalStorage', 'tocodex.tocodex', 'tasks');
  mkdirSync(join(toolsDir, 'task-bad'), { recursive: true });
  writeFileSync(join(toolsDir, 'task-bad', 'ui_messages.json'), '{"broken":');

  const days = collectExtraDays({ home, env: {}, platform: 'win32', drives: [drive], log: () => {} });
  assert.equal(days.length, 2);
  const today = days.find((d) => d.day === beijing(NOW));
  // 便携 13099+72+18304 + CLI 1000+200+500+20 = 33195
  assert.equal(today.tokens, 33195);
  assert.equal(today.input_tokens, 14099);
  assert.equal(today.output_tokens, 272);
  assert.equal(today.cache_read, 18804);
  assert.equal(today.cache_write, 20);
  assert.equal(today.requests, 2);
  assert.deepEqual(today.tools, [[TOOL_NAMES.tocodex, 33195]]);
  const prev = days.find((d) => d.day === beijing(NOW - DAY_MS));
  assert.equal(prev.tokens, 20304);
  assert.deepEqual(prev.tools, [[TOOL_NAMES.tocodex, 20304]]);
});

test('ToCodex：同一数据经多条路径发现只计一次（目录与消息双重去重）', (t) => {
  const { root, done } = makeDrives();
  t.after(done);
  const drive = join(root, 'A'), home = join(drive, 'Users', 'me');
  mkdirSync(home, { recursive: true });
  // APPDATA 已知位置与逐盘遍历（Roaming 下的产品目录名匹配）会指向同一个 tasks 目录
  const appData = join(drive, 'Users', 'me', 'AppData', 'Roaming');
  const tasks = join(appData, 'ToCodex Desktop', 'User', 'globalStorage', 'tocodex.tocodex', 'tasks');
  writeTocodexTasks(tasks, 'task-1', [tocodexStarted(NOW, 500, 50, 0, 0)]);
  writeTocodexTasks(tasks, 'task-2', [tocodexStarted(NOW, 100, 10, 0, 0)]);

  const days = collectExtraDays({ home, env: { APPDATA: appData }, platform: 'win32', drives: [drive], log: () => {} });
  assert.equal(days.length, 1);
  assert.equal(days[0].tokens, 660);
  assert.equal(days[0].requests, 2);
  assert.deepEqual(days[0].tools, [[TOOL_NAMES.tocodex, 660]]);
});

// OpenCode 同构库夹具：schema 与 deveco.db 相同；blob=true 时 data 以 BLOB 落库（TeleAgent 声明类型）。
function writeOpencodeLike(path, messages, blob = false) {
  mkdirSync(join(path, '..'), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT); CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT)');
  db.prepare('INSERT INTO session VALUES (?,?)').run('ses_1', 'F:/work/demo');
  for (const message of messages) db.prepare('INSERT INTO message VALUES (?,?,?,?,?)')
    .run(message.id, 'ses_1', message.ts, message.ts, blob ? Buffer.from(JSON.stringify(message.data), 'utf8') : JSON.stringify(message.data));
  db.close();
}

test('独立 Cline / Roo Code / JoyCode 从 VS Code 变体的 globalStorage 采集；AI Studio 目录不抢（归 oort.js）', (t) => {
  const { root, done } = makeDrives();
  t.after(done);
  const drive = join(root, 'A'), home = join(drive, 'Users', 'me');
  mkdirSync(home, { recursive: true });
  const roaming = join(drive, 'Users', 'me', 'AppData', 'Roaming');
  writeTocodexTasks(join(roaming, 'Code', 'User', 'globalStorage', 'saoudrizwan.claude-dev', 'tasks'), 'task-1', [
    tocodexStarted(NOW, 13099, 72, 18304, 0),
    tocodexStarted(NOW + 1, null),            // 失败请求无 token 字段
    tocodexStarted(NOW + 2, 0, 0, 0, 0),      // 全零不计
  ]);
  writeTocodexTasks(join(roaming, 'Cursor', 'User', 'globalStorage', 'rooveterinaryinc.roo-cline', 'tasks'), 'task-2',
    [tocodexStarted(NOW, 500, 50, 0, 0)]);
  writeTocodexTasks(join(roaming, 'JoyCode', 'User', 'globalStorage', 'joycode.joycoder-editor', 'tasks'), 'task-3',
    [tocodexStarted(NOW - DAY_MS, 1000, 200, 500, 20)]);
  // AI Studio 里的 Cline 归 oort.js 采集，这里绝不能重复计
  writeTocodexTasks(join(roaming, 'OortCloud AI Studio', 'User', 'globalStorage', 'saoudrizwan.claude-dev', 'tasks'), 'task-4',
    [tocodexStarted(NOW, 999999, 0, 0, 0)]);

  const days = collectExtraDays({ home, env: { APPDATA: roaming }, platform: 'win32', drives: [drive], log: () => {} });
  const today = days.find((d) => d.day === beijing(NOW));
  assert.equal(today.tokens, 13099 + 72 + 18304 + 500 + 50);
  assert.equal(today.requests, 2);
  assert.deepEqual(today.tools.map(([name]) => name).sort(), [TOOL_NAMES.cline, TOOL_NAMES.roo].sort());
  const prev = days.find((d) => d.day === beijing(NOW - DAY_MS));
  assert.deepEqual(prev.tools, [[TOOL_NAMES.joycode, 1720]]);
});

test('QoderWork 从 ~/.qoderwork/projects 转录采集（Anthropic 四分量+模型名），Kiro 的点数并入 credits', (t) => {
  const { root, done } = makeDrives();
  t.after(done);
  const drive = join(root, 'A'), home = join(drive, 'Users', 'me');
  mkdirSync(home, { recursive: true });
  const qwDir = join(home, '.qoderwork', 'projects', 'proj-a');
  mkdirSync(qwDir, { recursive: true });
  const qwRecord = (uuid, ts, usage, model = 'qmodel_38max') => JSON.stringify({
    type: 'assistant', uuid, timestamp: ts, parentUuid: null, isSidechain: false,
    message: { id: 'chatcmpl-' + uuid, role: 'assistant', model, usage } });
  writeFileSync(join(qwDir, 'a.jsonl'), [
    qwRecord('qw-1', '2026-11-01T10:00:00.000Z', { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 500, cache_creation_input_tokens: 20 }),
    // 零值（网关不下发真实 token 的安装）与 user 消息、非 assistant 记录都不计
    qwRecord('qw-2', '2026-11-01T10:01:00.000Z', { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }),
    JSON.stringify({ type: 'user', uuid: 'qw-3', timestamp: '2026-11-01T10:02:00.000Z', message: { role: 'user', usage: { input_tokens: 5 } } }),
  ].join('\n'));
  // Kiro：点数（credits）按 usage_summary 逐条聚合，不产生 token
  const kiroDir = join(home, '.kiro', 'sessions', 'ws1', 'sess_1');
  mkdirSync(kiroDir, { recursive: true });
  const kiroRecord = (id, ts, usage) => JSON.stringify({
    id, timestamp: ts, payload: { type: 'usage_summary', promptTurnSummaries: [{ unit: 'credit', usage }], status: 'success' } });
  writeFileSync(join(kiroDir, 'messages.jsonl'), [
    kiroRecord('t1-usage', '2026-11-01T11:00:00.000Z', 0.13332872394693202),
    kiroRecord('t2-usage', '2026-11-02T11:00:00.000Z', 0.25),
    kiroRecord('t3-usage', '2026-11-02T11:01:00.000Z', 0),   // 零点数不计
    JSON.stringify({ id: 't4', timestamp: '2026-11-02T11:02:00.000Z', payload: { type: 'usage_summary', promptTurnSummaries: [] } }),
  ].join('\n'));

  const days = collectExtraDays({ home, env: {}, platform: 'win32', drives: [drive], log: () => {} });
  const day1 = days.find((d) => d.day === '2026-11-01');
  assert.equal(day1.tokens, 1720);
  assert.deepEqual(day1.models, [['qmodel_38max', 1720]]);
  assert.deepEqual(day1.tools, [[TOOL_NAMES.qoderwork, 1720]]);
  assert.deepEqual(day1.credits, { total: 0.133329, tools: [[TOOL_NAMES.kiro, 0.133329]] });
  const day2 = days.find((d) => d.day === '2026-11-02');
  assert.equal(day2.tokens, 0);
  assert.deepEqual(day2.credits, { total: 0.25, tools: [[TOOL_NAMES.kiro, 0.25]] });
  // credits 随补充日行走 mergeOortDays 合并进主日行
  const merged = mergeOortDays([{ day: '2026-11-02', tokens: 10, input_tokens: 10, output_tokens: 0, cache_read: 0,
    cache_write: 0, requests: 1, models: [], tools: [], tool_models: [] }], days.filter((d) => d.day === '2026-11-02'));
  assert.deepEqual(merged[0].credits, { total: 0.25, tools: [[TOOL_NAMES.kiro, 0.25]] });
});

test('TeleAgent 与 CodeArts Agent 从 OpenCode 同构库采集；data 为 BLOB 时也能解析', (t) => {
  const { root, done } = makeDrives();
  t.after(done);
  const drive = join(root, 'A'), home = join(drive, 'Users', 'me');
  mkdirSync(home, { recursive: true });
  const opencodeData = (id, ts, tokens, model) => ({
    id, ts, data: { role: 'assistant', modelID: model,
      tokens: { input: tokens, output: 37, reasoning: 5, cache: { read: 0, write: 0 } } } });
  // TeleAgent：~/.local/share/TeleAgent/teleagent.db，data 列为 BLOB
  writeOpencodeLike(join(home, '.local', 'share', 'TeleAgent', 'teleagent.db'),
    [opencodeData('msg-t1', NOW, 1000, 'chat-pro')], true);
  // CodeArts Agent：~/.codeartsdoer/cli-data/opencode.db
  writeOpencodeLike(join(home, '.codeartsdoer', 'cli-data', 'opencode.db'),
    [opencodeData('msg-c1', NOW, 14189, 'deepseek-v3.2')]);

  const days = collectExtraDays({ home, env: {}, platform: 'win32', drives: [drive], log: () => {} });
  assert.equal(days.length, 1);
  // OpenCode 口径：total = input + output + cache（reasoning 已含在 output 内）
  assert.equal(days[0].tokens, (1000 + 37) + (14189 + 37));
  assert.equal(days[0].requests, 2);
  assert.deepEqual(days[0].tools.map(([name]) => name).sort(), [TOOL_NAMES.teleagent, TOOL_NAMES.codeartsAgent].sort());
  assert.deepEqual(days[0].models.map(([m]) => m).sort(), ['chat-pro', 'deepseek-v3.2']);
});

test('Cline 桌面端从 ~/.cline/data/sessions 采集（metrics 四分量+模型名），坏文件只跳过', (t) => {
  const { root, done } = makeDrives();
  t.after(done);
  const drive = join(root, 'A'), home = join(drive, 'Users', 'me');
  const sessionDir = join(home, '.cline', 'data', 'sessions', '1783859167747_RxB_X');
  mkdirSync(sessionDir, { recursive: true });
  const message = (id, ts, metrics, model = 'hy3-free') => ({ role: 'assistant', id, ts, modelInfo: { id: model, provider: 'opencode' }, metrics });
  writeFileSync(join(sessionDir, '1783859167747_RxB_X.messages.json'), JSON.stringify({
    version: 1, sessionId: '1783859167747_RxB_X', agent: 'lead',
    messages: [
      { role: 'user', id: 'u1', ts: NOW, content: '你好' },
      message('a1', NOW, { inputTokens: 2562, outputTokens: 2166, cacheReadTokens: 53632, cacheWriteTokens: 0 }),
      message('a2', NOW - DAY_MS, { inputTokens: 14361, outputTokens: 501, cacheReadTokens: 37696, cacheWriteTokens: 0 }, 'big-pickle'),
      message('a3', NOW + 1, { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }),  // 全零不计
      { role: 'assistant', id: 'a4', ts: NOW + 2 },  // 无 metrics 不计
    ] }));
  // 另一个会话目录但没有 messages 文件（只有元数据）——静默跳过
  mkdirSync(join(home, '.cline', 'data', 'sessions', 'meta-only'), { recursive: true });
  // 坏文件只跳过该会话
  const badDir = join(home, '.cline', 'data', 'sessions', 'broken');
  mkdirSync(badDir, { recursive: true });
  writeFileSync(join(badDir, 'broken.messages.json'), '{"broken":');

  const days = collectExtraDays({ home, env: {}, platform: 'win32', drives: [drive], log: () => {} });
  const today = days.find((d) => d.day === beijing(NOW));
  assert.equal(today.tokens, 2562 + 2166 + 53632);
  assert.equal(today.requests, 1);
  assert.deepEqual(today.tools, [[TOOL_NAMES.cline, 2562 + 2166 + 53632]]);
  assert.deepEqual(today.models, [['hy3-free', 2562 + 2166 + 53632]]);
  assert.deepEqual(today.tool_models, [[TOOL_NAMES.cline, 'hy3-free', 2562 + 2166 + 53632]]);
  const prev = days.find((d) => d.day === beijing(NOW - DAY_MS));
  assert.equal(prev.tokens, 14361 + 501 + 37696);
  assert.deepEqual(prev.models, [['big-pickle', 14361 + 501 + 37696]]);
});

test('合并补充日行时模型和工具内模型一起累加，超过协议上限按量截断', () => {
  const base = [{ day: '2026-10-28', tokens: 100, input_tokens: 100, output_tokens: 0, cache_read: 0, cache_write: 0,
    requests: 1, models: [['glm-5.3', 100]], tools: [['zcode', 100]], tool_models: [['zcode', 'glm-5.3', 100]] }];
  const extra = [{ day: '2026-10-28', tokens: 60, input_tokens: 60, output_tokens: 0, cache_read: 0, cache_write: 0,
    requests: 1, models: [['glm-5.3', 60]], tools: [[TOOL_NAMES.workbuddy, 60]], tool_models: [[TOOL_NAMES.workbuddy, 'glm-5.3', 60]] }];
  const merged = mergeOortDays(base, extra);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].tokens, 160);
  assert.deepEqual(merged[0].models, [['glm-5.3', 160]]);
  assert.equal(merged[0].tools.length, 2);
  assert.deepEqual(merged[0].tool_models, [['zcode', 'glm-5.3', 100], [TOOL_NAMES.workbuddy, 'glm-5.3', 60]]);

  const many = Array.from({ length: 1100 }, (_, i) => [`t${i}`, `m${i}`, 1100 - i]);
  const capped = mergeOortDays([{ day: '2026-10-28', tokens: 1, input_tokens: 1, output_tokens: 0, cache_read: 0,
    cache_write: 0, requests: 1, models: [], tools: [], tool_models: many }], []);
  assert.equal(capped[0].tool_models.length, 1024);
  assert.equal(capped[0].tool_models[0][0], 't0');
  assert.ok(capped[0].tool_models.every(([tool]) => tool !== 't1099'));
});
