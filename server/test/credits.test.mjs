import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateCredits, buildCredits } from '../src/credits.js';

const row = (credits) => ({ credits_json: credits == null ? null : JSON.stringify(credits) });

test('validateCredits 接受 total/tools 与新增的 models/tool_models 四个维度', () => {
  validateCredits({ total: 100, tools: [['Trae', 60], ['qoder', 40]] });
  validateCredits({ total: 100, tools: [['Trae', 60], ['qoder', 40]],
    models: [['GLM-5.3', 60], ['auto', 40]], tool_models: [['Trae', 'GLM-5.3', 60], ['qoder', 'auto', 40]] });
  validateCredits(undefined); validateCredits(null);
});

test('validateCredits 拒绝越界键、超限分项与重复项', () => {
  const bad = [
    [{ total: 10, extra: [] }, /invalid credits$/],
    [{ total: -1 }, /total/],
    [{ total: 1e9 + 1 }, /total/],
    [{ total: 10, tools: Array.from({ length: 9 }, (_, i) => [`t${i}`, 1]) }, /tools/],
    [{ total: 10, models: Array.from({ length: 9 }, (_, i) => [`m${i}`, 1]) }, /models/],
    [{ total: 10, tool_models: Array.from({ length: 129 }, (_, i) => ['t', `m${i}`, 0.01]) }, /tool_models/],
    [{ total: 10, tools: [['x'.repeat(61), 1]] }, /tools/],
    [{ total: 10, tools: [['a', 1], ['a', 2]] }, /duplicate/],
    [{ total: 10, models: [['m', 1], ['m', 2]] }, /duplicate/],
    [{ total: 10, tool_models: [['t', 'm', 1], ['t', 'm', 2]] }, /duplicate/],
    [{ total: 10, tools: [['a', 11]] }, /tools/],
    // 分项之和超过 total
    [{ total: 10, tools: [['a', 6], ['b', 6]] }, /tools total/],
    [{ total: 10, models: [['m1', 6], ['m2', 6]] }, /models total/],
    [{ total: 10, tool_models: [['t', 'm1', 6], ['t', 'm2', 6]] }, /tool_models total/],
    // 联合分布的边际不得超过一维分项
    [{ total: 10, tools: [['a', 4]], tool_models: [['a', 'm', 5]] }, /margin/],
    [{ total: 10, models: [['m', 4]], tool_models: [['a', 'm', 5]] }, /margin/],
  ];
  for (const [credits, pattern] of bad) {
    assert.throws(() => validateCredits(credits), pattern, JSON.stringify(credits));
  }
});

test('validateCredits 不惩罚旧上报：只有 total 或 total+tools 时按缺维跳过边际检查', () => {
  validateCredits({ total: 10 });
  validateCredits({ total: 10, tools: [['a', 10]] });
  validateCredits({ total: 10, models: [['m', 10]] });
});

test('buildCredits 合并多维度分项：按金额降序取前 8 / 128，缺维不输出空字段', () => {
  const rows = [
    row({ total: 10, tools: [['Trae', 6], ['qoder', 4]], models: [['GLM-5.3', 6], ['auto', 4]],
      tool_models: [['Trae', 'GLM-5.3', 6], ['qoder', 'auto', 4]] }),
    row({ total: 5, tools: [['Trae', 5]], models: [['GLM-5.3', 5]], tool_models: [['Trae', 'GLM-5.3', 5]] }),
  ];
  const credits = buildCredits(rows);
  assert.equal(credits.status, 'complete');
  assert.equal(credits.total, 15);
  assert.deepEqual(credits.tools, [['Trae', 11], ['qoder', 4]]);
  assert.deepEqual(credits.models, [['GLM-5.3', 11], ['auto', 4]]);
  assert.deepEqual(credits.tool_models, [['Trae', 'GLM-5.3', 11], ['qoder', 'auto', 4]]);
  // 旧上报（只有 tools）不带 models/tool_models 字段
  const legacy = buildCredits([row({ total: 3, tools: [['qoder', 3]] })]);
  assert.deepEqual(Object.keys(legacy).sort(), ['status', 'tools', 'total']);
  assert.deepEqual(legacy.tools, [['qoder', 3]]);
});

test('buildCredits 保留 unavailable/partial 语义，损坏行不影响其余维度', () => {
  assert.deepEqual(buildCredits([]), { status: 'unavailable', total: 0, tools: [] });
  assert.deepEqual(buildCredits([row(null)]), { status: 'unavailable', total: 0, tools: [] });
  const mixed = buildCredits([row({ total: 4, tools: [['a', 4]], models: [['m', 4]] }), { credits_json: '{broken' }]);
  assert.equal(mixed.status, 'partial');
  assert.equal(mixed.total, 4);
  assert.deepEqual(mixed.tools, [['a', 4]]);
  assert.deepEqual(mixed.models, [['m', 4]]);
});

test('buildCredits 合并后超出协议上限时截断到前 8 / 128，total 仍为各行合计', () => {
  // 三行各自合法（模型/组合都在本行分项内），合并后 models 24 条 → 8，tool_models 192 条 → 128
  const rows = [0, 1, 2].map((k) => row({
    total: 8,
    tools: Array.from({ length: 8 }, (_, i) => [`t${i}`, 1]),
    models: Array.from({ length: 8 }, (_, i) => [`m${k * 8 + i}`, 1]),
    tool_models: Array.from({ length: 64 }, (_, i) =>
      [`t${i % 8}`, `m${k * 8 + Math.floor(i / 8)}`, 0.01]),
  }));
  const credits = buildCredits(rows);
  assert.equal(credits.status, 'complete');
  assert.equal(credits.total, 24);
  assert.equal(credits.tools.length, 8);
  assert.deepEqual(credits.tools[0], ['t0', 3]);
  assert.equal(credits.models.length, 8);
  assert.equal(credits.tool_models.length, 128);
  assert.equal(credits.tool_models[0].length, 3);
});
