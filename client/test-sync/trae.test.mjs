import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectTraeDays, TOOL_NAME } from '../sync/trae.js';
import { mergeOortDays } from '../sync/oort.js';

function makeHome() {
  const home = mkdtempSync(join(tmpdir(), 'trae-test-'));
  return { home, done: () => rmSync(home, { recursive: true, force: true }) };
}

function writeSnapshot(home, body) {
  const dir = join(home, '.trae-cn');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'credits-usage.json'),
    typeof body === 'string' ? body : JSON.stringify(body));
}

const SNAPSHOT = {
  schema: 1,
  generated_at: '2026-10-30T04:00:00.000Z',
  window_days: 30,
  days: [
    {
      day: '2026-10-30',
      input_tokens: 1000, output_tokens: 200, cache_read: 5000, cache_write: 0, tokens: 6200,
      requests: 3, credits: 16.2916, billed_sessions: 2, custom_sessions: 1,
      custom_input_tokens: 100, custom_output_tokens: 20,
      models: [['DeepSeek-V4.1-Flash', 6100], ['bigmodel-plan//GLM-5.3-flash', 100]],
    },
    {
      day: '2026-10-29',
      input_tokens: 10, output_tokens: 5, cache_read: 0, cache_write: 7, tokens: 22,
      requests: 1, credits: 0, billed_sessions: 0, custom_sessions: 1,
      custom_input_tokens: 10, custom_output_tokens: 5,
      models: [],
    },
  ],
};

test('collectTraeDays 解析快照：token 四分量、credits、模型榜、自定义模型行', (t) => {
  const { home, done } = makeHome();
  t.after(done);
  writeSnapshot(home, SNAPSHOT);
  const days = collectTraeDays({ home, log: () => {} });
  assert.equal(days.length, 2);
  const today = days.find((d) => d.day === '2026-10-30');
  assert.equal(today.tokens, 6200);
  assert.equal(today.input_tokens, 1000);
  assert.equal(today.output_tokens, 200);
  assert.equal(today.cache_read, 5000);
  assert.equal(today.requests, 3);
  assert.deepEqual(today.tools, [[TOOL_NAME, 6200]]);
  assert.deepEqual(today.models, [['DeepSeek-V4.1-Flash', 6100], ['bigmodel-plan//GLM-5.3-flash', 100]]);
  assert.deepEqual(today.tool_models, [
    [TOOL_NAME, 'DeepSeek-V4.1-Flash', 6100],
    [TOOL_NAME, 'bigmodel-plan//GLM-5.3-flash', 100],
  ]);
  // credits>0 的日行带 credits 对象；credits=0 的日行不带
  assert.deepEqual(today.credits, { total: 16.2916, tools: [[TOOL_NAME, 16.2916]] });
  const other = days.find((d) => d.day === '2026-10-29');
  assert.equal(other.credits, null);
  assert.equal(other.tokens, 22);
});

test('collectTraeDays 容错：无文件/坏 JSON/错 schema/越界日/负值', (t) => {
  const { home, done } = makeHome();
  t.after(done);
  // 无文件：静默空
  assert.deepEqual(collectTraeDays({ home, log: () => {} }), []);
  // 坏 JSON：告警 + 空
  writeSnapshot(home, '{not json');
  const logs = [];
  assert.deepEqual(collectTraeDays({ home, log: (m) => logs.push(m) }), []);
  assert.equal(logs.length, 1);
  // 错 schema：告警 + 空
  writeSnapshot(home, { schema: 99, days: [] });
  assert.deepEqual(collectTraeDays({ home, log: () => {} }), []);
  // 未来日与坏日行跳过，好日行保留；负值钳 0
  writeSnapshot(home, {
    schema: 1,
    days: [
      { day: '2099-01-01', input_tokens: 1, output_tokens: 0, cache_read: 0, cache_write: 0, requests: 1, credits: 0 },
      { day: 'not-a-day', input_tokens: 5, output_tokens: 0, cache_read: 0, cache_write: 0, requests: 1, credits: 0 },
      { day: '2026-10-30', input_tokens: -50, output_tokens: 10, cache_read: 0, cache_write: 0, requests: 1, credits: -3 },
    ],
  });
  const days = collectTraeDays({ home, log: () => {} });
  assert.equal(days.length, 1);
  assert.equal(days[0].day, '2026-10-30');
  assert.equal(days[0].input_tokens, 0);
  assert.equal(days[0].output_tokens, 10);
  assert.equal(days[0].credits, null);
});

test('mergeOortDays 合并 Trae credits：与既有 credits 同日相加、tools 按名合并取前 8', () => {
  const upstream = [{
    day: '2026-10-30', tokens: 100, input_tokens: 60, output_tokens: 40, cache_read: 0, cache_write: 0,
    requests: 2, models: [], tools: [], tool_models: [],
    credits: { total: 10.5, tools: [['qoder', 10.5]] },
  }];
  const trae = [{
    day: '2026-10-30', tokens: 6200, input_tokens: 1000, output_tokens: 200, cache_read: 5000, cache_write: 0,
    requests: 3, models: [['DeepSeek-V4.1-Flash', 6100]], tools: [[TOOL_NAME, 6200]],
    tool_models: [[TOOL_NAME, 'DeepSeek-V4.1-Flash', 6100]],
    credits: { total: 16.2916, tools: [[TOOL_NAME, 16.2916]] },
  }];
  const merged = mergeOortDays(upstream, trae);
  assert.equal(merged.length, 1);
  const day = merged[0];
  assert.equal(day.tokens, 6300);
  assert.equal(day.input_tokens, 1060);
  assert.deepEqual(day.tools, [[TOOL_NAME, 6200]]);
  // credits 相加：10.5 + 16.2916；tools 按量排序 Trae 在前
  assert.equal(day.credits.total, 26.7916);
  assert.deepEqual(day.credits.tools, [[TOOL_NAME, 16.2916], ['qoder', 10.5]]);
});

test('mergeOortDays：仅补充源带 credits 的日（新建日行）与仅上游带 credits 的日均正确', () => {
  const upstream = [{
    day: '2026-10-28', tokens: 50, input_tokens: 30, output_tokens: 20, cache_read: 0, cache_write: 0,
    requests: 1, models: [], tools: [], tool_models: [],
    credits: { total: 3.3, tools: [['qoder', 3.3]] },
  }];
  const traeOnly = [{
    day: '2026-10-29', tokens: 22, input_tokens: 10, output_tokens: 5, cache_read: 0, cache_write: 7,
    requests: 1, models: [], tools: [[TOOL_NAME, 22]], tool_models: [],
    credits: { total: 1.234567, tools: [[TOOL_NAME, 1.234567]] },
  }];
  const merged = mergeOortDays(upstream, traeOnly);
  assert.equal(merged.length, 2);
  assert.equal(merged[0].day, '2026-10-28');
  assert.equal(merged[0].credits.total, 3.3);
  assert.equal(merged[1].day, '2026-10-29');
  assert.equal(merged[1].credits.total, 1.234567);
  assert.deepEqual(merged[1].credits.tools, [[TOOL_NAME, 1.234567]]);
  // 无 credits 的补充源不改写上游 credits；下游日无 credits 字段
  const noCredits = mergeOortDays(upstream, [{
    day: '2026-10-27', tokens: 1, input_tokens: 1, output_tokens: 0, cache_read: 0, cache_write: 0,
    requests: 1, models: [], tools: [[TOOL_NAME, 1]], tool_models: [],
  }]);
  assert.equal(noCredits.find((d) => d.day === '2026-10-27').credits, undefined);
  assert.equal(noCredits.find((d) => d.day === '2026-10-28').credits.total, 3.3);
});
