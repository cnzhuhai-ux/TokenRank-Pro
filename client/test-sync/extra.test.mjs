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

test('重复目录和重复消息只计一次；坏文件坏库只跳过；extra-roots 已登记的目录不再采集', (t) => {
  const { root, done } = makeDrives();
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
