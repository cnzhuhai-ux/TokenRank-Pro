/**
 * Trae（CN 桌面版）用量补充采集。
 *
 * 数据源：~/.trae-cn/credits-usage.json —— 由 Trae 扩展（client/trae-extension）在 Trae 内部
 * 通过 icube.common.getToken 会话令牌查询官方用量接口（query_user_usage_group_by_session，
 * usage_type=[7]）后写出的按天聚合快照。本采集器只读该文件，不触网、不读取 Trae 的加密会话库
 * （database.db），也不碰 trae-jwt-token。
 *
 * 兼容 schema 1（只有 tools 分项）与 schema 2（tools/models/tool_models 三维分项 + *_full 全量明细）：
 *   - token：input_tokens/output_tokens/cache_read/cache_write（来源为接口行 extra_info，会话累计值；
 *     活跃会话随用量增长，配合服务端按天整行替换收敛，与 DSH 采集口径一致）；
 *   - requests：当日活跃会话行数（快照 requests 字段，非请求数）；
 *   - credits：credits_float 按天合计（round6）。预置模型计费产生 credits；自定义模型（BYOK）
 *     不计 credits，其 token 已含在 token 四分量中（快照 custom_* 单列，不重复拆分）；
 *   - 模型明细优先取 *_full 全量字段，再按协议上限截断，未覆盖的部分由服务端计入“未关联”残差。
 *
 * 容错：文件不存在 → 静默返回空（未安装扩展属正常形态）；schema 不识别、字段越界、JSON 损坏 →
 * 跳过并告警，不中断同步；某维分项之和超过 total → 丢弃该分项并告警，保留 total 与 tools，不摊派。
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import { existsSync, readFileSync, statSync } from 'node:fs';

export const TOOL_NAME = 'Trae';
const SCHEMAS = [1, 2];
const MAX = { tokens: 1e13, requests: 1e7, credits: 1e9 };
const LIMITS = { models: 8, tools: 8, tool_models: 128 };
const MAX_DAYS = 400;
const DAY_MS = 86_400_000;
const EPSILON = 1e-6;
// 工具×模型组合键的分隔符（名称里的控制字符已在清洗时去掉）
const SEP = String.fromCharCode(30);
const round6 = (value) => Math.round(value * 1e6) / 1e6;

const clamp = (v, max) => Math.max(0, Math.min(max, Math.round(Number(v) || 0)));

const cleanName = (value) => (typeof value === 'string'
  ? value.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60) : '');

/** 读取 [[名称, 数值]] 明细：坏项跳过并计数，同名单独出现时只保留首项，按数值降序截断。 */
function readPairs(list, { cap, maxValue, limit, label, day, log }) {
  const out = new Map();
  if (!Array.isArray(list)) return out;
  let skipped = 0;
  for (const row of list) {
    if (!Array.isArray(row) || row.length !== 2) { skipped++; continue; }
    const name = cleanName(row[0]);
    const value = Number(row[1]);
    if (!name || !Number.isFinite(value) || value <= 0 || value > maxValue || out.has(name)) { skipped++; continue; }
    if (out.size >= limit) { skipped++; continue; }
    out.set(name, cap === 'tokens' ? clamp(value, MAX.tokens) : round6(Math.min(value, maxValue)));
  }
  if (skipped) log(`trae 快照日 ${day} 的 ${label} 有 ${skipped} 条不合格或超出上限，已跳过`);
  return out;
}

/** 读取 [[工具, 模型, 数值]] 明细；工具名只接受本数据源自身，避免伪造别的工具。 */
function readTriples(list, { maxValue, limit, label, day, log }) {
  const out = new Map();
  if (!Array.isArray(list)) return out;
  let skipped = 0;
  for (const row of list) {
    if (!Array.isArray(row) || row.length !== 3) { skipped++; continue; }
    const tool = cleanName(row[0]), model = cleanName(row[1]);
    const value = Number(row[2]);
    if (tool !== TOOL_NAME || !model || !Number.isFinite(value) || value <= 0 || value > maxValue) { skipped++; continue; }
    const key = model + SEP + tool;
    if (out.has(key)) { skipped++; continue; }
    if (out.size >= limit) { skipped++; continue; }
    out.set(key, round6(Math.min(value, maxValue)));
  }
  if (skipped) log(`trae 快照日 ${day} 的 ${label} 有 ${skipped} 条不合格或超出上限，已跳过`);
  return out;
}

function emptyBucket(day) {
  return {
    day, tokens: 0, input_tokens: 0, output_tokens: 0, cache_read: 0, cache_write: 0,
    requests: 0, credits: 0, tools: new Map(), models: new Map(),
    creditModels: new Map(), creditToolModels: new Map(),
  };
}

/** 解析并校验快照，返回日桶数组；不合法时抛错（由 collectTraeDays 捕获转告警）。 */
function parseSnapshot(raw, log) {
  let json;
  try { json = JSON.parse(raw); } catch (err) { throw new Error(`快照 JSON 损坏：${err?.message || err}`); }
  if (!json || typeof json !== 'object') throw new Error('快照不是 JSON 对象');
  if (!SCHEMAS.includes(json.schema)) {
    throw new Error(`快照 schema=${json.schema} 不受支持（期望 ${SCHEMAS.join(' 或 ')}），请更新适配器或扩展`);
  }
  if (!Array.isArray(json.days)) throw new Error('快照缺少 days 数组');
  if (json.days.length > MAX_DAYS) throw new Error(`快照包含 ${json.days.length} 天，超出上限 ${MAX_DAYS}`);
  const now = Date.now();
  const buckets = [];
  for (const day of json.days) {
    if (!day || typeof day !== 'object' || typeof day.day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(day.day)) {
      log('trae 快照存在格式异常的日行，已跳过该行');
      continue;
    }
    const ts = Date.parse(day.day + 'T00:00:00+08:00');
    if (!Number.isFinite(ts) || ts > now + DAY_MS) {
      log(`trae 快照日 ${day.day} 晚于当前时间，已跳过该行`);
      continue;
    }
    const bucket = emptyBucket(day.day);
    bucket.input_tokens = clamp(day.input_tokens, MAX.tokens);
    bucket.output_tokens = clamp(day.output_tokens, MAX.tokens);
    bucket.cache_read = clamp(day.cache_read, MAX.tokens);
    bucket.cache_write = clamp(day.cache_write, MAX.tokens);
    bucket.tokens = bucket.input_tokens + bucket.output_tokens + bucket.cache_read + bucket.cache_write;
    bucket.requests = clamp(day.requests, MAX.requests);
    const credits = Number(day.credits);
    if (Number.isFinite(credits) && credits > 0 && credits <= MAX.credits) bucket.credits = round6(credits);
    else if (Number.isFinite(credits) && (credits < 0 || credits > MAX.credits)) {
      log(`trae 快照日 ${day.day} 的 credits=${credits} 超出范围，已按 0 处理`);
    }
    // 全量明细优先：截断在采集器做，快照本身不丢数据
    const modelSource = Array.isArray(day.models_full) && day.models_full.length ? day.models_full : day.models;
    bucket.models = readPairs(modelSource, { cap: 'tokens', maxValue: MAX.tokens, limit: LIMITS.models,
      label: '模型明细', day: day.day, log });
    if (json.schema >= 2 && bucket.credits > 0) {
      const creditSource = Array.isArray(day.credits_models_full) && day.credits_models_full.length
        ? day.credits_models_full : day.credits_models;
      bucket.creditModels = readPairs(creditSource, { cap: 'credits', maxValue: bucket.credits,
        limit: LIMITS.models, label: '模型积分分项', day: day.day, log });
      bucket.creditToolModels = readTriples(day.credits_tool_models, { maxValue: bucket.credits,
        limit: LIMITS.tool_models, label: '工具×模型积分分项', day: day.day, log });
    }
    buckets.push(bucket);
  }
  return buckets;
}

const desc = (a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0]));

/**
 * 分项之和不得超过 total（容差 1e-6）。超限说明来源数据自相矛盾：丢弃该分项并告警，
 * 保留 total 与 tools —— 宁可少一份明细，也不摊派制造虚假归因。
 */
function withinTotal(detail, total, label, day, log) {
  if (!detail.size) return [];
  const sum = [...detail.values()].reduce((a, b) => a + b, 0);
  if (sum > total + EPSILON) {
    log(`trae 快照日 ${day} 的 ${label}合计 ${round6(sum)} 超过当日 credits ${total}，已丢弃该分项`);
    return [];
  }
  return [...detail.entries()].sort(desc).map(([name, amount]) => [name, amount]);
}

/** 读取 Trae 快照并产出与上报协议同构的日行；文件不存在或不可用时返回空数组。 */
export function collectTraeDays({ home = homedir(), log = () => {} } = {}) {
  const file = join(home, '.trae-cn', 'credits-usage.json');
  if (!existsSync(file)) return [];
  let raw;
  try {
    if (!statSync(file).isFile()) return [];
    raw = readFileSync(file, 'utf8');
  } catch (err) {
    log(`trae 快照读取失败，已跳过：${err?.message || err}`);
    return [];
  }
  let buckets;
  try { buckets = parseSnapshot(raw, log); }
  catch (err) { log(`trae 快照不可用，已跳过：${err?.message || err}`); return []; }
  return buckets.map((bucket) => {
    const models = [...bucket.models.entries()].sort(desc);
    const row = {
      day: bucket.day,
      tokens: bucket.tokens,
      input_tokens: bucket.input_tokens,
      output_tokens: bucket.output_tokens,
      cache_read: bucket.cache_read,
      cache_write: bucket.cache_write,
      requests: bucket.requests,
      models: models.slice(0, LIMITS.models),
      tools: bucket.tokens > 0 ? [[TOOL_NAME, bucket.tokens]] : [],
      tool_models: models.slice(0, LIMITS.models).map(([model, tokens]) => [TOOL_NAME, model, tokens]),
      credits: null,
    };
    if (bucket.credits <= 0) return row;
    row.credits = { total: bucket.credits, tools: [[TOOL_NAME, bucket.credits]] };
    const creditModels = withinTotal(bucket.creditModels, bucket.credits, '模型积分', bucket.day, log);
    const creditPairs = withinTotal(bucket.creditToolModels, bucket.credits, '工具×模型积分', bucket.day, log)
      .map(([key, amount]) => { const [model, tool] = key.split(SEP); return [tool, model, amount]; });
    if (creditModels.length) row.credits.models = creditModels;
    if (creditPairs.length) row.credits.tool_models = creditPairs;
    return row;
  });
}
