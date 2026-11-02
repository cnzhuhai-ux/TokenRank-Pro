process.env.TZ = 'Asia/Shanghai';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { collectCodebuddyDays, mergeCodebuddyDays } from '../sync/codebuddy.js';
import { batches } from '../sync/report.js';

// CodeBuddy logs use the host's local time; keep fixtures independent of CI timezone.
process.env.TZ = 'Asia/Shanghai';

const model = (name) => `2026-11-02 10:00:00.000 [info] [BaseAgent:craft] DeepSeek ModelProvider initialized, modelId: ${name}, modelName: Test`;
const usage = (date, id, values = {}) => `${date} [info] [BaseAgent:craft] [req] notifyStepEnd, step: 1, requestId: req, messageId: ${id}, usage: ${JSON.stringify({ inputTokens: 100, outputTokens: 20, totalTokens: 120, cacheTokens: 70, cachedWriteTokens: 0, ...values })}, isMaxTokenLimit: false`;
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'codebuddy-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const logs = join(root, 'logs');
  mkdirSync(logs);
  return { logs, read: () => collectCodebuddyDays({ home: root, env: {}, roots: [logs] }),
    write: (name, lines) => writeFileSync(join(logs, name), lines.join('\n')) };
}

test('CodeBuddy captures model usage and separates cached input without double counting', t => {
  const f = fixture(t);
  f.write('CodeBuddy.log', [model('deepseek-test'), usage('2026-11-02 10:17:17.111', 'm1')]);
  const [day] = f.read();
  assert.equal(day.day, '2026-11-02');
  assert.equal(day.tokens, 120);
  assert.equal(day.input_tokens, 30);
  assert.equal(day.output_tokens, 20);
  assert.equal(day.cache_read, 70);
  assert.equal(day.requests, 1);
  assert.deepEqual(day.models, [['deepseek-test', 120]]);
  assert.deepEqual(day.tools, [['CodeBuddy', 120]]);
  assert.deepEqual(day.tool_models, [['CodeBuddy', 'deepseek-test', 120]]);
});

test('CodeBuddy deduplicates rotated logs, retains separate days and skips malformed usage', t => {
  const f = fixture(t);
  const first = usage('2026-11-01 23:59:59.000', 'm1');
  f.write('CodeBuddy.log', [model('model-a'), first, 'broken usage: {',
    usage('2026-11-02 00:00:01.000', 'm2')]);
  f.write('CodeBuddy.1.log', [model('model-a'), first]);
  const days = f.read();
  assert.deepEqual(days.map(d => [d.day, d.tokens, d.requests]), [
    ['2026-11-01', 120, 1], ['2026-11-02', 120, 1],
  ]);
});

test('CodeBuddy merging preserves existing usage and model detail in upload batches', t => {
  const f = fixture(t);
  f.write('CodeBuddy.log', [model('model-a'), usage('2026-11-02 10:17:17.111', 'm1')]);
  const base = [{ day: '2026-11-02', tokens: 10, input_tokens: 10, output_tokens: 0,
    cache_read: 0, cache_write: 0, requests: 1, models: [['model-a', 10]],
    tools: [['codex', 10]], tool_models: [['codex', 'model-a', 10]] }];
  const before = structuredClone(base);
  const days = mergeCodebuddyDays(base, f.read());
  assert.deepEqual(base, before);
  const [report] = batches(days, 'fixture-device');
  assert.equal(report.days[0].tokens, 130);
  assert.deepEqual(report.days[0].models, [['model-a', 130]]);
  assert.ok(report.days[0].tool_models.some(row => row[0] === 'CodeBuddy' && row[1] === 'model-a' && row[2] === 120));
});

test('CodeBuddy ignores cumulative summaries and rejects invalid counters', t => {
  const f = fixture(t);
  const record = usage('2026-11-02 10:17:17.111', 'valid');
  f.write('CodeBuddy.log', [model('model-a'), record,
    record.replace('notifyStepEnd,', 'notifyAgentEnd,'),
    record.replace('[BaseAgent:craft]', '[AgentReporter]'),
    usage('2026-11-02 10:17:18.111', 'negative', { inputTokens: -100, outputTokens: -20 }),
    usage('2026-11-02 10:17:19.111', 'invalid', { inputTokens: '100', outputTokens: null }),
  ]);
  assert.equal(f.read()[0].tokens, 120);
  assert.equal(f.read()[0].requests, 1);
});


test('mixed model context is not guessed', t => {
  const f = fixture(t);
  f.write('CodeBuddy.log', [model('a'), model('b'), usage('2026-11-02 10:00:01.000', 'mixed')]);
  assert.deepEqual(f.read()[0].models, [['unknown', 120]]);
});
