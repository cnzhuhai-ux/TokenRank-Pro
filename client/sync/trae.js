/**
 * Trae（CN 桌面版）用量补充采集。
 *
 * 数据源：~/.trae-cn/credits-usage.json —— 由 Trae 扩展 "Trae Credits POC" 在 Trae 内部
 * 通过 icube.common.getToken 会话令牌查询官方用量接口（query_user_usage_group_by_session，
 * usage_type=[7]）后写出的按天聚合快照（schema 1）。本采集器只读该文件，不触网、
 * 不读取 Trae 的加密会话库（database.db），也不碰 trae-jwt-token。
 *
 * 口径：
 *   - token：快照的 input_tokens/output_tokens/cache_read/cache_write（来源为接口行 extra_info，
 *     会话累计值；活跃会话随用量增长，配合服务端按天整行替换收敛，与 DSH 采集口径一致）；
 *   - requests：当日活跃会话行数（快照 requests 字段，非请求数）；
 *   - credits：快照 credits（credits_float 按天合计，round6）。预置模型计费产生 credits；
 *     自定义模型（BYOK）不计 credits，其 token 已含在 token 四分量中（快照 custom_* 单列，
 *     本采集器不重复拆分，避免与合计冲突）。
 *   - models：快照 models（[[模型名, tokens]]，Auto 模式行无模型名则不贡献）。
 *
 * 容错：文件不存在 → 静默返回空（未安装扩展属正常形态）；schema 不识别、字段越界、
 * JSON 损坏 → 跳过并告警，不中断同步。
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import { existsSync, readFileSync, statSync } from 'node:fs';

export const TOOL_NAME = 'Trae';
const SCHEMA = 1;
const MAX = { tokens: 1e13, requests: 1e7 };
const MAX_DAYS = 400;
const DAY_MS = 86_400_000;
const round6 = (value) => Math.round(value * 1e6) / 1e6;

const clamp = (v, max) => Math.max(0, Math.min(max, Math.round(Number(v) || 0)));

function emptyBucket(day) {
  return {
    day, tokens: 0, input_tokens: 0, output_tokens: 0, cache_read: 0, cache_write: 0,
    requests: 0, credits: 0, tools: new Map(), models: new Map(),
  };
}

/** 解析并校验快照，返回日行数组；不合法时抛错（由 collectTraeDays 捕获转告警）。 */
function parseSnapshot(raw, log) {
  let json;
  try { json = JSON.parse(raw); } catch (err) { throw new Error(`快照 JSON 损坏：${err?.message || err}`); }
  if (!json || typeof json !== 'object') throw new Error('快照不是 JSON 对象');
  if (json.schema !== SCHEMA) throw new Error(`快照 schema=${json.schema} 不受支持（期望 ${SCHEMA}），请更新适配器或扩展`);
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
    const input = clamp(day.input_tokens, MAX.tokens);
    const output = clamp(day.output_tokens, MAX.tokens);
    const cacheRead = clamp(day.cache_read, MAX.tokens);
    const cacheWrite = clamp(day.cache_write, MAX.tokens);
    const credits = Number(day.credits);
    const bucket = emptyBucket(day.day);
    bucket.input_tokens = input;
    bucket.output_tokens = output;
    bucket.cache_read = cacheRead;
    bucket.cache_write = cacheWrite;
    bucket.tokens = input + output + cacheRead + cacheWrite;
    bucket.requests = clamp(day.requests, MAX.requests);
    if (Number.isFinite(credits) && credits > 0 && credits <= 1e9) bucket.credits = round6(credits);
    else if (Number.isFinite(credits) && (credits < 0 || credits > 1e9)) {
      log(`trae 快照日 ${day.day} 的 credits=${credits} 超出范围，已按 0 处理`);
    }
    for (const pair of Array.isArray(day.models) ? day.models : []) {
      if (!Array.isArray(pair) || typeof pair[0] !== 'string' || !pair[0]) continue;
      const tokens = clamp(pair[1], MAX.tokens);
      if (tokens > 0) bucket.models.set(String(pair[0]).slice(0, 60), tokens);
    }
    buckets.push(bucket);
  }
  return buckets;
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
  return buckets.map((bucket) => ({
    day: bucket.day,
    tokens: bucket.tokens,
    input_tokens: bucket.input_tokens,
    output_tokens: bucket.output_tokens,
    cache_read: bucket.cache_read,
    cache_write: bucket.cache_write,
    requests: bucket.requests,
    models: [...bucket.models.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8),
    tools: bucket.tokens > 0 ? [[TOOL_NAME, bucket.tokens]] : [],
    tool_models: [...bucket.models.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8)
      .map(([model, tokens]) => [TOOL_NAME, model, tokens]),
    credits: bucket.credits > 0 ? { total: bucket.credits, tools: [[TOOL_NAME, bucket.credits]] } : null,
  }));
}
