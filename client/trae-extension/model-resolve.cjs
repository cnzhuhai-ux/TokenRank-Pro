// model-resolve.cjs —— Trae 用量行的模型归因与按天快照聚合（纯函数，可单测）。
//
// 为什么单独成文件：扩展宿主里的 vscode / 网络部分无法在测试中加载，而这两段逻辑正是口径的
// 来源（Auto 归因、[Provider] 前缀、schema 2 的四维分项与截断），必须能脱离 Trae 验证。
//
// 口径（与 query_user_usage_group_by_session 返回行一致）：
//   - 有 model_name → 以模型名归因；名字形如 `provider//模型` 判为自定义模型（BYOK），
//     上报为 `[provider] 模型名`；其余为内置（预置）模型，上报接口原值（保留大小写）。
//   - 无 model_name 的行按“计费事实”消歧（credits>0 才是 Trae credits 计费，BYOK 自定义模型
//     不计 credits）：已被 Trae 计费且 mode 判定为 Auto（或显式 use_max_mode === false）→ `auto`；
//     未被 Trae 计费 → 固定上报「自定义模型」（BYOK 会话 API 不回传 model_name，此桶即
//     自定义模型用量的展示形态，见 docs/trae-collection.md）。
//   - 其余无模型名且已被 Trae 计费的行不产出模型分项，只计入总额，由服务端归入“未关联模型”残差。
'use strict';

const AUTO_LABEL = 'auto';
const CUSTOM_LABEL = '自定义模型';
const MAX_LABEL = 60;          // 服务端对名称的硬上限
const MAX_PROVIDER = 20;
const MAX_BASE = 40;
const SNAPSHOT_SCHEMA = 2;
const LIMITS = { models: 8, tool_models: 128 };
// 工具×模型组合键的分隔符（模型名里不会出现控制字符，已在 clip 中清除）
const SEP = String.fromCharCode(30);
const round6 = (value) => Math.round(value * 1e6) / 1e6;
const numOf = (value, fallback = 0) => (typeof value === 'number' && Number.isFinite(value) ? value : fallback);
const clampInt = (value) => Math.max(0, Math.round(numOf(value)));

// 名称里不允许出现换行、制表与控制字符，统一压成单空格再截断
function clip(value, max) {
  return String(value == null ? '' : value)
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

/** 自定义模型名形如 `bigmodel-plan//GLM-5.3`：`//` 前为 Provider，后为模型名。 */
const baseOf = (name) => (name.indexOf('//') >= 0 ? name.slice(name.indexOf('//') + 2) : name);
const providerOf = (name) => (name.indexOf('//') >= 0 ? name.slice(0, name.indexOf('//')) : '');

/**
 * 模型清单索引（可选输入）。条目只保留分类需要的 5 个字段，其余（ak/sk/base_url 等）不读取。
 * items: [{ name, display_name, provider, config_source, is_preset }]
 */
function buildModelIndex(items) {
  const index = { byExact: new Map(), byLower: new Map(), byBaseLower: new Map(), counts: { preset: 0, custom: 0 } };
  for (const item of Array.isArray(items) ? items : []) {
    if (!item || typeof item !== 'object') continue;
    const name = clip(item.name, MAX_LABEL);
    if (!name) continue;
    const kind = (item.config_source === 1 || item.is_preset === true) ? 'preset' : 'custom';
    const entry = { kind, provider: clip(String(item.provider || ''), MAX_PROVIDER), name,
      display: clip(item.display_name || '') || name };
    const put = (map, key) => {
      const previous = map.get(key);
      // 同名跨类（预置与自定义显示名相同）不覆盖，标记 ambiguous，交由计费事实裁决
      map.set(key, previous && previous.kind !== kind ? Object.assign({}, entry, { kind: 'ambiguous' }) : entry);
    };
    put(index.byExact, name);
    put(index.byLower, name.toLowerCase());
    put(index.byBaseLower, baseOf(name).toLowerCase());
    index.counts[kind]++;
  }
  return index;
}

/** 自定义模型上报名 `[Provider] 模型名`；内置模型保持接口原值。 */
function labelOf(kind, hit, raw) {
  if (kind !== 'custom') return clip(raw, MAX_LABEL) || null;
  const provider = clip(String((hit && hit.provider) || providerOf(raw) || ''), MAX_PROVIDER).replace(/[[\]]/g, '');
  const base = clip((hit && hit.display) || baseOf(raw), MAX_BASE);
  if (!base) return clip(raw, MAX_LABEL) || null;
  return clip('[' + (provider || 'unknown') + '] ' + base, MAX_LABEL);
}

/** 归因唯一入口：返回 { label, kind, source, mode }；label 为 null 表示该行不贡献模型分项。 */
function resolveModel(row, index) {
  const raw = typeof row.model_name === 'string' ? clip(row.model_name, MAX_LABEL) : '';
  const mode = clip(row.mode, 20);
  const isAutoMode = /^auto(\s*mode)?$/i.test(mode);
  const billed = numOf(row.credits_float) > 0;
  if (raw) {
    const hit = index.byExact.get(raw) || index.byLower.get(raw.toLowerCase())
      || index.byBaseLower.get(baseOf(raw).toLowerCase());
    let kind = hit ? hit.kind : (raw.indexOf('//') >= 0 ? 'custom' : 'preset');
    // ambiguous：产生 credits 说明走的是 Trae 计费（预置模型或其路由结果）
    if (kind === 'ambiguous') kind = billed ? 'preset' : 'custom';
    // 没有任何 Provider 线索时不编造前缀
    if (kind === 'custom' && raw.indexOf('//') < 0 && !(hit && hit.provider)) kind = 'preset';
    return { label: labelOf(kind, hit, raw), kind, source: 'row', mode };
  }
  // 无模型名的行按计费事实消歧：未计费（BYOK 不计 Trae credits）即自定义模型会话，
  // 不得归入 `auto` —— 否则自定义模型 token 会污染 auto 归因且平台无法查看（2026-11-03 修复）。
  if (isAutoMode) {
    return billed ? { label: AUTO_LABEL, kind: 'auto', source: 'auto', mode }
      : { label: CUSTOM_LABEL, kind: 'custom', source: 'custom-unbilled', mode };
  }
  if (row.use_max_mode === false) {
    return billed ? { label: AUTO_LABEL, kind: 'auto', source: 'fallback-auto', mode }
      : { label: CUSTOM_LABEL, kind: 'custom', source: 'custom-unbilled', mode };
  }
  if (!billed) return { label: CUSTOM_LABEL, kind: 'custom', source: 'custom-unbilled', mode };
  return { label: null, kind: 'unknown', source: 'unknown', mode };
}

function emptyDay(day) {
  return { day, input_tokens: 0, output_tokens: 0, cache_read: 0, cache_write: 0, tokens: 0,
    requests: 0, credits: 0, billed_sessions: 0, custom_sessions: 0,
    custom_input_tokens: 0, custom_output_tokens: 0,
    tokenModels: new Map(), creditModels: new Map(), creditToolModels: new Map(),
    modes: new Map(), truncated: { models: false, credits_models: false, credits_tool_models: false } };
}

/**
 * 按天聚合成 schema 2 快照。
 * rows: [{ day, label, kind, mode, billed, input_token, output_token, cache_read_token,
 *          cache_write_token, credits, tool }]
 * 同一行集合既贡献 token 分项也贡献 credits 分项；未截断时 Σmodels = Σtool_models = Σtools = total。
 * label 为空的行只进总额，不进任何模型分项（服务端按残差计“未关联模型”）。
 */
function buildSnapshot(rows, { windowDays = 30, generatedAt = new Date().toISOString() } = {}) {
  const days = new Map();
  for (const row of rows) {
    if (!row || typeof row.day !== 'string') continue;
    const day = days.get(row.day) || emptyDay(row.day);
    days.set(row.day, day);
    const input = clampInt(row.input_token), output = clampInt(row.output_token);
    const cacheRead = clampInt(row.cache_read_token), cacheWrite = clampInt(row.cache_write_token);
    day.input_tokens += input; day.output_tokens += output;
    day.cache_read += cacheRead; day.cache_write += cacheWrite;
    day.tokens = day.input_tokens + day.output_tokens + day.cache_read + day.cache_write;
    day.requests += 1;
    const credits = numOf(row.credits);
    day.credits = round6(day.credits + credits);
    if (row.billed) day.billed_sessions += 1; else day.custom_sessions += 1;
    if (!row.billed) { day.custom_input_tokens += input; day.custom_output_tokens += output; }
    const mode = row.mode || '';
    day.modes.set(mode, (day.modes.get(mode) || 0) + 1);
    if (!row.label) continue;
    const rowTokens = input + output + cacheRead + cacheWrite;
    if (rowTokens > 0) day.tokenModels.set(row.label, (day.tokenModels.get(row.label) || 0) + rowTokens);
    if (credits > 0) {
      day.creditModels.set(row.label, round6((day.creditModels.get(row.label) || 0) + credits));
      const pair = `${row.tool || 'Trae'}${SEP}${row.label}`;
      day.creditToolModels.set(pair, round6((day.creditToolModels.get(pair) || 0) + credits));
    }
  }
  const byAmount = (a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0]));
  const ordered = [...days.values()].sort((a, b) => a.day.localeCompare(b.day));
  return {
    schema: SNAPSHOT_SCHEMA,
    generated_at: generatedAt,
    window_days: windowDays,
    days: ordered.map((day) => {
      const modelList = [...day.tokenModels].sort(byAmount);
      const creditList = [...day.creditModels].sort(byAmount);
      const pairList = [...day.creditToolModels]
        .sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])) || String(a[1]).localeCompare(String(b[1])));
      day.truncated.models = modelList.length > LIMITS.models;
      day.truncated.credits_models = creditList.length > LIMITS.models;
      day.truncated.credits_tool_models = pairList.length > LIMITS.tool_models;
      return {
        day: day.day,
        input_tokens: day.input_tokens, output_tokens: day.output_tokens,
        cache_read: day.cache_read, cache_write: day.cache_write,
        tokens: day.tokens, requests: day.requests, credits: round6(day.credits),
        billed_sessions: day.billed_sessions, custom_sessions: day.custom_sessions,
        custom_input_tokens: day.custom_input_tokens, custom_output_tokens: day.custom_output_tokens,
        models: modelList.slice(0, LIMITS.models), models_full: modelList,
        // 本数据源只有 Trae 一个工具，tools 分项恒为该工具合计
        credits_tools: day.credits > 0 ? [['Trae', round6(day.credits)]] : [],
        credits_models: creditList.slice(0, LIMITS.models), credits_models_full: creditList,
        credits_tool_models: pairList.slice(0, LIMITS.tool_models)
          .map(([key, amount]) => { const [tool, label] = key.split(SEP); return [tool, label, amount]; }),
        modes: [...day.modes].sort((a, b) => b[1] - a[1]),
        truncated: day.truncated,
      };
    }),
  };
}

module.exports = { AUTO_LABEL, CUSTOM_LABEL, SNAPSHOT_SCHEMA, LIMITS, SEP, clip, round6, baseOf, providerOf,
  buildModelIndex, labelOf, resolveModel, buildSnapshot };
