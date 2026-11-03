import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { buildModelIndex, resolveModel, buildSnapshot, labelOf, SNAPSHOT_SCHEMA, CUSTOM_LABEL } = require('../trae-extension/model-resolve.cjs');

const row = (over = {}) => ({ model_name: '', mode: '', use_max_mode: undefined, credits_float: 0, ...over });

test('Auto 识别：已计费的 Auto 行归 auto（mode 大小写混杂、Auto Mode、use_max_mode 兜底）', () => {
  const index = buildModelIndex([]);
  for (const mode of ['Auto', 'auto', 'AUTO', 'Auto Mode', 'auto mode']) {
    const r = resolveModel(row({ mode, credits_float: 0.5 }), index);
    assert.equal(r.label, 'auto', mode);
    assert.equal(r.kind, 'auto');
    assert.equal(r.source, 'auto');
  }
  const fallback = resolveModel(row({ mode: 'Max? unknown', use_max_mode: false, credits_float: 0.5 }), index);
  assert.equal(fallback.label, 'auto');
  assert.equal(fallback.source, 'fallback-auto');
  // use_max_mode 非严格 false 不触发兜底：已计费的无名行保持“未关联”残差
  const other = resolveModel(row({ mode: 'Pro', use_max_mode: 'false', credits_float: 0.5 }), index);
  assert.equal(other.label, null);
  assert.equal(other.kind, 'unknown');
});

test('自定义模型桶：无模型名且未被 Trae 计费（credits=0）→ 「自定义模型」（2026-11-03 修复）', () => {
  const index = buildModelIndex([]);
  // BYOK 会话行实测形态：model_name 为空、credits=0、mode=Auto —— 不得再归入 auto
  const byok = resolveModel(row({ mode: 'Auto', credits_float: 0 }), index);
  assert.equal(byok.label, CUSTOM_LABEL);
  assert.equal(byok.kind, 'custom');
  assert.equal(byok.source, 'custom-unbilled');
  // use_max_mode 兜底与非 Auto 模式同样按计费事实归桶
  const fallback = resolveModel(row({ mode: 'Max? unknown', use_max_mode: false, credits_float: 0 }), index);
  assert.equal(fallback.label, CUSTOM_LABEL);
  assert.equal(fallback.kind, 'custom');
  const plain = resolveModel(row({ mode: 'Pro', credits_float: 0 }), index);
  assert.equal(plain.label, CUSTOM_LABEL);
  assert.equal(plain.kind, 'custom');
});

test('有模型名时以模型名为准（含 mode=Auto 已回填），mode 原样保留', () => {
  const index = buildModelIndex([]);
  const r = resolveModel(row({ model_name: 'GLM-5.3', mode: 'Auto', credits_float: 5 }), index);
  assert.equal(r.label, 'GLM-5.3');
  assert.equal(r.kind, 'preset');
  assert.equal(r.mode, 'Auto');
});

test('自定义模型：provider// 前缀与模型清单 provider/display_name', () => {
  const index = buildModelIndex([
    { name: 'bigmodel-plan//GLM-5.3', display_name: 'GLM-5.3', provider: 'bigmodel-plan', config_source: 3, is_preset: false },
    { name: 'GLM-5.3', display_name: 'GLM-5.3', provider: '', config_source: 1, is_preset: true },
  ]);
  assert.ok(index.counts.preset >= 1 && index.counts.custom >= 1, '清单计数存在');
  // 接口返回 provider// 全名 → 自定义前缀
  const full = resolveModel(row({ model_name: 'bigmodel-plan//GLM-5.3' }), index);
  assert.equal(full.label, '[bigmodel-plan] GLM-5.3');
  assert.equal(full.kind, 'custom');
  // 清单索引按原名命中（含 display_name/provider）
  assert.equal(labelOf('custom', index.byLower.get('bigmodel-plan//glm-5.3'), 'bigmodel-plan//GLM-5.3'), '[bigmodel-plan] GLM-5.3');
  // provider 缺失时回退到 // 前缀；两者皆缺 → [unknown] 前缀
  assert.equal(labelOf('custom', null, 'vendor-x//Model-Y'), '[vendor-x] Model-Y');
  assert.equal(labelOf('custom', null, 'Bare-Model'), '[unknown] Bare-Model');
});

test('同名跨类以计费事实裁决：有 credits 视为预置', () => {
  const index = buildModelIndex([
    { name: 'GLM-5.3', display_name: 'GLM-5.3', provider: '', config_source: 1, is_preset: true },
    { name: 'GLM-5.3', display_name: 'GLM-5.3', provider: 'bigmodel-plan', config_source: 3, is_preset: false },
    { name: 'bigmodel-plan//GLM-5.3', display_name: 'GLM-5.3', provider: 'bigmodel-plan', config_source: 3, is_preset: false },
  ]);
  // 同名不同类不覆盖：标记 ambiguous，交由计费事实裁决；// 形式经 byBaseLower 也撞到同一个键
  assert.equal(index.byExact.get('GLM-5.3').kind, 'ambiguous');
  assert.equal(index.byBaseLower.get('glm-5.3').kind, 'ambiguous');
  const billed = resolveModel(row({ model_name: 'GLM-5.3', credits_float: 3 }), index);
  assert.equal(billed.kind, 'preset');
  assert.equal(billed.label, 'GLM-5.3');
  const unbilled = resolveModel(row({ model_name: 'GLM-5.3', credits_float: 0 }), index);
  assert.equal(unbilled.kind, 'custom');
  assert.equal(unbilled.label, '[bigmodel-plan] GLM-5.3');
});

test('buildSnapshot 产出 schema 2：四维分项齐全、边际一致、截断与残差', () => {
  const rows = [];
  for (let i = 0; i < 10; i++) {
    rows.push({ day: '2026-10-30', label: `m${i}`, kind: 'preset', mode: 'Max', billed: true,
      input_token: 100 + i, output_token: 10, cache_read_token: 0, cache_write_token: 0,
      credits: 1 + i / 10, tool: 'Trae' });
  }
  // 无法归因的行：只进总额
  rows.push({ day: '2026-10-30', label: null, kind: 'unknown', mode: '', billed: true,
    input_token: 5, output_token: 0, cache_read_token: 0, cache_write_token: 0, credits: 0.5, tool: 'Trae' });
  const snap = buildSnapshot(rows, { windowDays: 30, generatedAt: '2026-10-30T00:00:00Z' });
  assert.equal(snap.schema, SNAPSHOT_SCHEMA);
  assert.equal(snap.days.length, 1);
  const day = snap.days[0];
  assert.equal(day.requests, 11);
  assert.equal(day.models.length, 8);
  assert.equal(day.models_full.length, 10);
  assert.equal(day.truncated.models, true);
  assert.equal(day.truncated.credits_models, true);
  // 上报分项之和 ≤ total；全量明细之和 == total（未归因行只进总额 → 差值即残差）
  const sum = (list, at) => list.reduce((a, r) => a + r[at], 0);
  const total = day.credits;
  assert.ok(sum(day.credits_models, 1) <= total + 1e-6);
  assert.ok(Math.abs(sum(day.credits_models_full, 1) + 0.5 - total) <= 1e-6);
  assert.deepEqual(day.credits_tools, [['Trae', total]]);
  assert.equal(day.credits_tool_models.length, 10);
  assert.equal(day.credits_tool_models[0][0], 'Trae');
  // Auto 行进入 token 与 credits 模型分项
  const autoSnap = buildSnapshot([
    { day: '2026-10-29', label: 'auto', kind: 'auto', mode: 'Auto', billed: true,
      input_token: 10, output_token: 5, cache_read_token: 0, cache_write_token: 0, credits: 0.25, tool: 'Trae' },
  ], { windowDays: 30 });
  assert.deepEqual(autoSnap.days[0].models, [['auto', 15]]);
  assert.deepEqual(autoSnap.days[0].credits_models, [['auto', 0.25]]);
  assert.deepEqual(autoSnap.days[0].modes, [['Auto', 1]]);

  // 自定义模型桶：未计费行 token 进入「自定义模型」模型分项，custom_* 聚合列保持一致
  const customSnap = buildSnapshot([
    { day: '2026-11-02', label: CUSTOM_LABEL, kind: 'custom', mode: 'Auto', billed: false,
      input_token: 117665, output_token: 764, cache_read_token: 70016, cache_write_token: 0, credits: 0, tool: 'Trae' },
  ], { windowDays: 30 });
  const cd = customSnap.days[0];
  assert.deepEqual(cd.models, [[CUSTOM_LABEL, 188445]]);
  assert.deepEqual(cd.models_full, [[CUSTOM_LABEL, 188445]]);
  assert.equal(cd.credits, 0);
  assert.deepEqual(cd.credits_models, []);
  assert.equal(cd.custom_sessions, 1);
  assert.equal(cd.custom_input_tokens, 117665);
  assert.equal(cd.custom_output_tokens, 764);
  // 同日混合：已计费 auto 与未计费自定义模型不互相污染
  const mixed = buildSnapshot([
    { day: '2026-11-03', label: 'auto', kind: 'auto', mode: 'Auto', billed: true,
      input_token: 100, output_token: 10, cache_read_token: 0, cache_write_token: 0, credits: 0.5, tool: 'Trae' },
    { day: '2026-11-03', label: CUSTOM_LABEL, kind: 'custom', mode: 'Auto', billed: false,
      input_token: 200, output_token: 20, cache_read_token: 0, cache_write_token: 0, credits: 0, tool: 'Trae' },
  ], { windowDays: 30 });
  assert.deepEqual(mixed.days[0].models, [[CUSTOM_LABEL, 220], ['auto', 110]]);
  assert.deepEqual(mixed.days[0].credits_models, [['auto', 0.5]]);
  assert.equal(mixed.days[0].custom_sessions, 1);
  assert.equal(mixed.days[0].billed_sessions, 1);
});
