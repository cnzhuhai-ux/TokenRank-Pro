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

  const many = Array.from({ length: 140 }, (_, i) => [`t${i}`, `m${i}`, 140 - i]);
  const capped = mergeOortDays([{ day: '2026-10-28', tokens: 1, input_tokens: 1, output_tokens: 0, cache_read: 0,
    cache_write: 0, requests: 1, models: [], tools: [], tool_models: many }], []);
  assert.equal(capped[0].tool_models.length, 128);
  assert.equal(capped[0].tool_models[0][0], 't0');
});
