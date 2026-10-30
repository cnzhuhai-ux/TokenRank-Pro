/**
 * Oort 系工具用量补充采集：只读本机各产品自己的状态目录，不写任何外部数据，
 * 也不依赖 token-watcher（它的 13 种工具清单不认识 Oort 系产品）。
 *
 * 数据源与口径：
 *   - DSH For OortCloud Work
 *     ~/.dsh-oortcloud-work/storages/session_projcache/sessions/*.json
 *     的 record.rows.tokenUsage.val.totals（会话累计值：uncachedInput/output/cacheRead/cacheWrite）。
 *     按会话最后活跃日（文件 mtime，北京时间）归因；活跃会话累计值单调变大，配合服务端
 *     按天整行替换语义收敛。跨零点的长会话总量会记到后一天，前一天的已上报值保持不变，
 *     两日合计可能略高于真实总量——只影响跨天长会话，榜单用途可接受。
 *     只读 -oortcloud-work 变体目录；基础版 ~/.dsh 由 token-watcher 官方支持，读了会重复计数。
 *   - OortCloud AI Studio
 *     %APPDATA%\OortCloud AI Studio\User\globalStorage 下三处来源，同一产品、同一展示名：
 *     a) oortcodex.oortcodex\tasks\*\ui_messages.json —— 内置编码助手（扩展 displayName 即
 *        “OortCloud AI Studio”）的逐请求记录，say=api_req_started 的消息尾带
 *        {tokensIn, tokensOut, cacheReads, cacheWrites}，ts 精确到毫秒。
 *     b) oortcodex.oortcodex\claude-agent-acp\projects 下的 Claude Code 格式转录（逐条
 *        message.usage），使用 acp 后端的安装才有。
 *     c) {saoudrizwan.claude-dev,rooveterinaryinc.roo-cline}\tasks —— 装了 Cline/Roo 的安装。
 *     三处是不同后端/插件，同一请求只落在其中一处；都扫描以覆盖不同版本与配置。
 *   - OortCodex Desktop（独立程序，ZCode 内核，与 ZCode 本体分开）
 *     %USERPROFILE%\OortCodexWork\cli\db\db.sqlite 的 model_usage 表（ZCode 内核同构）：
 *     逐请求 input/output/cache_read/cache_creation 与 started_at（毫秒），按北京时间分日。
 *     token-watcher 只读 ~/.zcode，不扫这里，二者不会重复。开发/预览版目录为
 *     OortCodexWork Dev / OortCodexWork Preview，按记录 id 去重。
 *     注意：%APPDATA%\OortCodexWork 只是 Electron 界面缓存，用量不在这里。
 *
 * 无法本地采集：OortOffice —— 本地聊天存于浏览器 Local Storage，无 token 明细；平台侧
 * new-api 有完整计量（/api/dashboard/self/overview 按天按 token），但需要有效的平台
 * accesstoken，本机各应用落盘的令牌均已过期、且主力应用的令牌为加密存储。
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

export const TOOL_NAMES = {
  dsh: 'DSH For OortCloud Work',
  aiStudio: 'OortCloud AI Studio',
  oortCodexDesktop: 'OortCodex Desktop',
};
// 展示名改写表：token-watcher 的 'zcode' 与 Oort 系产品互不相干，不做任何改写。
export const TOOL_RENAME = {};

const MAX = { tokens: 1e13, requests: 1e7 };
const DAY_MS = 86_400_000;
const round6 = (v) => Math.round(v * 1e6) / 1e6;
const beijingDayOf = (ms) => new Date(ms + 8 * 3600000).toISOString().slice(0, 10);

function emptyBucket(day) {
  return { day, tokens: 0, input_tokens: 0, output_tokens: 0, cache_read: 0, cache_write: 0, requests: 0,
    tools: new Map(), models: new Map(), toolModels: new Map() };
}

function addTo(bucket, { input = 0, output = 0, cacheRead = 0, cacheWrite = 0, requests = 0, tool, model }) {
  const clamp = (v, max) => Math.max(0, Math.min(max, Math.round(Number(v) || 0)));
  const tokens = clamp(input, MAX.tokens) + clamp(output, MAX.tokens) + clamp(cacheRead, MAX.tokens) + clamp(cacheWrite, MAX.tokens);
  bucket.input_tokens += clamp(input, MAX.tokens);
  bucket.output_tokens += clamp(output, MAX.tokens);
  bucket.cache_read += clamp(cacheRead, MAX.tokens);
  bucket.cache_write += clamp(cacheWrite, MAX.tokens);
  bucket.requests += clamp(requests, MAX.requests);
  if (tool) bucket.tools.set(tool, (bucket.tools.get(tool) || 0) + tokens);
  if (model) bucket.models.set(model, (bucket.models.get(model) || 0) + tokens);
  if (tool && model) {
    const key = tool + '\u0000' + model;
    bucket.toolModels.set(key, (bucket.toolModels.get(key) || 0) + tokens);
  }
  bucket.tokens = bucket.input_tokens + bucket.output_tokens + bucket.cache_read + bucket.cache_write;
}

/** DSH For OortCloud Work 会话累计用量 → 按 mtime 日聚合 */
function collectDsh(root, log) {
  const dir = join(root, '.dsh-oortcloud-work', 'storages', 'session_projcache', 'sessions');
  if (!existsSync(dir)) return [];
  const buckets = new Map();
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.json')) continue;
    const file = join(dir, name);
    try {
      const totals = JSON.parse(readFileSync(file, 'utf8'))?.record?.rows?.tokenUsage?.val?.totals;
      const input = Number(totals?.uncachedInputTokens) || 0;
      const output = Number(totals?.outputTokens) || 0;
      const cacheRead = Number(totals?.cacheReadTokens) || 0;
      const cacheWrite = Number(totals?.cacheWriteTokens) || 0;
      if (!input && !output && !cacheRead && !cacheWrite) continue;
      const day = beijingDayOf(statSync(file).mtimeMs);
      const bucket = buckets.get(day) || emptyBucket(day);
      addTo(bucket, { input, output, cacheRead, cacheWrite, requests: 1, tool: TOOL_NAMES.dsh });
      buckets.set(day, bucket);
    } catch (err) {
      log(`oort dsh 会话 ${name} 解析失败，已跳过：${err?.message || err}`);
    }
  }
  return [...buckets.values()];
}

/** 从 Cline 系 api_req_started 文本中提取一次请求的 token 用量（无或不完整返回 null） */
function parseClineUsage(text) {
  if (typeof text !== 'string' || !text.includes('tokensIn')) return null;
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { /* 文本头部可能被截断，走正则兜底 */ }
  const pick = (key) => {
    const v = parsed?.[key];
    if (Number.isFinite(v)) return v;
    const m = new RegExp(`"${key}":(\\d+)`).exec(text);
    return m ? Number(m[1]) : 0;
  };
  return { input: pick('tokensIn'), output: pick('tokensOut'), cacheRead: pick('cacheReads'), cacheWrite: pick('cacheWrites') };
}

/** Cline 系扩展（含 AI Studio 内置助手）的任务记录 → 按请求时间戳聚合 */
function collectClineTasks(appData, exts, tool, log) {
  if (!appData) return [];
  const buckets = new Map();
  for (const ext of exts) {
    const tasksDir = join(appData, 'OortCloud AI Studio', 'User', 'globalStorage', ext, 'tasks');
    if (!existsSync(tasksDir)) continue;
    for (const task of readdirSync(tasksDir)) {
      const file = join(tasksDir, task, 'ui_messages.json');
      if (!existsSync(file)) continue;
      try {
        const messages = JSON.parse(readFileSync(file, 'utf8'));
        if (!Array.isArray(messages)) continue;
        for (const message of messages) {
          if (message?.say !== 'api_req_started') continue;
          const usage = parseClineUsage(message.text);
          if (!usage) continue;
          const ts = Number(message.ts);
          const day = beijingDayOf(Number.isFinite(ts) && ts > 0 ? ts : statSync(file).mtimeMs);
          const bucket = buckets.get(day) || emptyBucket(day);
          addTo(bucket, { ...usage, requests: 1, tool });
          buckets.set(day, bucket);
        }
      } catch (err) {
        log(`oort ${ext} 任务 ${task} 解析失败，已跳过：${err?.message || err}`);
      }
    }
  }
  return [...buckets.values()];
}

function collectAiStudio(appData, log) {
  return collectClineTasks(appData, ['oortcodex.oortcodex', 'saoudrizwan.claude-dev', 'rooveterinaryinc.roo-cline'],
    TOOL_NAMES.aiStudio, log);
}

/**
 * OortCloud AI Studio 的 Claude agent 转录：逐条 message.usage，按时间戳分日。
 * 目录不存在或无用量时返回空；单文件损坏只跳过该文件。
 */
function collectAiStudioTranscripts(appData, log) {
  if (!appData) return [];
  const root = join(appData, 'OortCloud AI Studio', 'User', 'globalStorage', 'oortcodex.oortcodex', 'claude-agent-acp', 'projects');
  if (!existsSync(root)) return [];
  const buckets = new Map();
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const file = join(dir, entry.name);
      if (entry.isDirectory()) { walk(file); continue; }
      if (!entry.name.endsWith('.jsonl')) continue;
      try {
        for (const line of readFileSync(file, 'utf8').split('\n')) {
          if (!line.includes('"usage"')) continue;
          let record;
          try { record = JSON.parse(line); } catch { continue; }
          const usage = record?.message?.usage;
          if (!usage || typeof usage !== 'object') continue;
          const input = Number(usage.input_tokens) || 0;
          const output = Number(usage.output_tokens) || 0;
          const cacheRead = Number(usage.cache_read_input_tokens) || 0;
          const cacheWrite = Number(usage.cache_creation_input_tokens) || 0;
          if (!input && !output && !cacheRead && !cacheWrite) continue;
          const ts = Date.parse(record.timestamp || '');
          const day = beijingDayOf(Number.isFinite(ts) ? ts : statSync(file).mtimeMs);
          const bucket = buckets.get(day) || emptyBucket(day);
          addTo(bucket, { input, output, cacheRead, cacheWrite, requests: 1, tool: TOOL_NAMES.aiStudio });
          buckets.set(day, bucket);
        }
      } catch (err) {
        log(`oort ai-studio 转录 ${entry.name} 解析失败，已跳过：${err?.message || err}`);
      }
    }
  };
  walk(root);
  return [...buckets.values()];
}

/** OortCodex Desktop 的 ZCode 内核数据目录（正式/开发/预览三条安装线） */
const OORTCODEX_HOMES = ['OortCodexWork', 'OortCodexWork Dev', 'OortCodexWork Preview'];

/**
 * OortCodex Desktop：cli/db/db.sqlite 的 model_usage（与 token-watcher 的 zcode 同构）。
 * input_tokens 含 cache_read，入库时拆成新输入与缓存命中；按记录 id 去重，防止多条安装线
 * 指向同一份数据。数据库缺失或被占用时只跳过本轮。
 */
function collectOortCodexDesktop(home, log) {
  const buckets = new Map(), seen = new Set();
  for (const name of OORTCODEX_HOMES) {
    const path = join(home, name, 'cli', 'db', 'db.sqlite');
    if (!existsSync(path)) continue;
    let db;
    try {
      db = new DatabaseSync(path, { readOnly: true });
      db.exec('PRAGMA busy_timeout = 3000');
      if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='model_usage'").get()) continue;
      const rows = db.prepare(`SELECT id, model_id, started_at, input_tokens, output_tokens,
        cache_creation_input_tokens, cache_read_input_tokens FROM model_usage`).all();
      for (const row of rows) {
        const key = 'oortcodex:' + row.id;
        if (seen.has(key)) continue;
        const ts = Number(row.started_at);
        if (!Number.isFinite(ts) || ts <= 0) continue;
        const inputRaw = Number(row.input_tokens) || 0;
        const cached = Math.min(Number(row.cache_read_input_tokens) || 0, inputRaw);
        const cacheWrite = Number(row.cache_creation_input_tokens) || 0;
        const output = Number(row.output_tokens) || 0;
        if (inputRaw + cacheWrite + output <= 0) continue;
        seen.add(key);
        // 与 token-watcher 的 zcode 口径一致：模型名小写，跨源合并同一模型
        const model = String(row.model_id || '').trim().toLowerCase().slice(0, 60);
        const day = beijingDayOf(ts);
        const bucket = buckets.get(day) || emptyBucket(day);
        addTo(bucket, { input: inputRaw - cached, cacheRead: cached, cacheWrite, output,
          requests: 1, tool: TOOL_NAMES.oortCodexDesktop, model });
        buckets.set(day, bucket);
      }
    } catch (err) {
      log(`oort oortcodex ${name} 数据库读取失败，已跳过：${err?.message || err}`);
    } finally {
      try { db?.close(); } catch { /* 已关闭 */ }
    }
  }
  return [...buckets.values()];
}

const topEntries = (map, limit) => [...map.entries()].filter(([, v]) => v > 0)
  .sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0]))).slice(0, limit);

/** 汇总 Oort 系各源，产出与上报协议同构的日行 */
export function collectOortDays({ home = homedir(), appData = process.env.APPDATA || null, log = () => {} } = {}) {
  const merged = new Map();
  const sources = [...collectDsh(home, log), ...collectAiStudio(appData, log),
    ...collectAiStudioTranscripts(appData, log), ...collectOortCodexDesktop(home, log)];
  for (const bucket of sources) {
    const existing = merged.get(bucket.day) || emptyBucket(bucket.day);
    existing.input_tokens += bucket.input_tokens;
    existing.output_tokens += bucket.output_tokens;
    existing.cache_read += bucket.cache_read;
    existing.cache_write += bucket.cache_write;
    existing.requests += bucket.requests;
    for (const [tool, tokens] of bucket.tools) existing.tools.set(tool, (existing.tools.get(tool) || 0) + tokens);
    for (const [model, tokens] of bucket.models) existing.models.set(model, (existing.models.get(model) || 0) + tokens);
    for (const [key, tokens] of bucket.toolModels) existing.toolModels.set(key, (existing.toolModels.get(key) || 0) + tokens);
    existing.tokens = existing.input_tokens + existing.output_tokens + existing.cache_read + existing.cache_write;
    merged.set(bucket.day, existing);
  }
  return [...merged.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([day, bucket]) => ({
    day, tokens: bucket.tokens, input_tokens: bucket.input_tokens, output_tokens: bucket.output_tokens,
    cache_read: bucket.cache_read, cache_write: bucket.cache_write, requests: bucket.requests,
    models: topEntries(bucket.models, 8), tools: topEntries(bucket.tools, 8),
    tool_models: [...topEntries(bucket.toolModels, 128)].map(([key, tokens]) => [...key.split('\u0000'), tokens]),
  }));
}

/**
 * 合并两份 credits：total 相加（round6），各分项按键合并、按量取协议上限，
 * 分项之和钳回 ≤ total（与服务端 1e-6 容差对齐）。
 *   { total, tools: [[工具, 积分]], models?: [[模型, 积分]], tool_models?: [[工具, 模型, 积分]] }
 * 任一为空取另一方；旧客户端只报 total/tools，缺的维度不输出空字段。
 */
const CREDIT_LIMITS = { tools: 8, models: 8, tool_models: 128 };
// 复合键分隔符（名称已在采集侧清掉控制字符）
const CREDIT_SEP = String.fromCharCode(30);

function mergeDetailList(a, b, field) {
  const rows = [...(a || []), ...(b || [])];
  if (!rows.length) return null;
  const arity = field === 'tool_models' ? 3 : 2;
  const merged = new Map();
  for (const row of rows) {
    if (!Array.isArray(row) || row.length !== arity) continue;
    const amount = Number(row[arity - 1]);
    if (!Number.isFinite(amount) || amount <= 0) continue;
    const key = row.slice(0, arity - 1).join(CREDIT_SEP);
    merged.set(key, round6((merged.get(key) || 0) + amount));
  }
  const list = [...merged.entries()].filter(([, amount]) => amount > 0)
    .sort((x, y) => y[1] - x[1] || String(x[0]).localeCompare(String(y[0])))
    .slice(0, CREDIT_LIMITS[field])
    .map(([key, amount]) => [...key.split(CREDIT_SEP), amount]);
  return list.length ? list : null;
}

function mergeCredits(a, b) {
  if (!a && !b) return null;
  const total = round6(Math.max(0, Number(a && a.total) || 0) + Math.max(0, Number(b && b.total) || 0));
  const out = { total, tools: clampSum(mergeDetailList(a && a.tools, b && b.tools, 'tools') || [], total) };
  for (const field of ['models', 'tool_models']) {
    const list = mergeDetailList(a && a[field], b && b[field], field);
    if (list) out[field] = clampSum(list, total);
  }
  return out;
}

// 分项之和超过 total 时从末位扣减，保持 Σ分项 ≤ total（与服务端 1e-6 容差对齐）
function clampSum(list, total) {
  const sum = list.reduce((n, row) => n + row[row.length - 1], 0);
  if (sum > total && list.length) {
    const last = list.at(-1);
    last[last.length - 1] = round6(Math.max(0, last[last.length - 1] - (sum - total)));
  }
  return list;
}

/**
 * 把补充采集的日行合并进 token-watcher 的日行：
 *   - 展示名重命名表同步作用于 tools 与 tool_models（当前为空表，保留扩展位）；
 *   - 同日数字相加，tools/models 按量取前 8，tool_models 按工具+模型合并后取前 128；
 *   - credits（{ total, tools }）同日相加、tools 按名合并取前 8（Trae 等补充源也带 credits）；
 *   - 返回新数组，不改入参。重命名会改变日指纹，相关日会在下次同步时整行重传。
 */
export function mergeOortDays(days, oortDays = []) {
  const rename = (name) => TOOL_RENAME[name] || name;
  const keyed = (pairs, map = new Map()) => {
    for (const [name, tokens] of pairs || []) map.set(name, (map.get(name) || 0) + Number(tokens || 0));
    return map;
  };
  const modelKey = (tool, model) => tool + '\u0000' + model;
  const out = days.map((day) => {
    const tools = keyed(day.tools), models = keyed(day.models), toolModels = new Map();
    for (const [tool, model, tokens] of day.tool_models || []) {
      const name = rename(tool), key = modelKey(name, model);
      toolModels.set(key, (toolModels.get(key) || 0) + Number(tokens || 0));
    }
    const credits = day.credits ? {
      total: round6(day.credits.total),
      tools: (day.credits.tools || []).map(([n, v]) => [n, round6(v)]),
      ...(Array.isArray(day.credits.models) && day.credits.models.length
        ? { models: day.credits.models.map(([n, v]) => [n, round6(v)]) } : {}),
      ...(Array.isArray(day.credits.tool_models) && day.credits.tool_models.length
        ? { tool_models: day.credits.tool_models.map(([t, m, v]) => [t, m, round6(v)]) } : {}),
    } : null;
    return { ...day, tools, models, tool_models: toolModels, ...(credits ? { credits } : {}) };
  });
  for (const oort of oortDays) {
    let day = out.find((d) => d.day === oort.day);
    if (!day) {
      day = { day: oort.day, tokens: 0, input_tokens: 0, output_tokens: 0, cache_read: 0, cache_write: 0,
        requests: 0, tools: new Map(), models: new Map(), tool_models: new Map() };
      out.push(day);
    }
    day.tokens += oort.tokens; day.input_tokens += oort.input_tokens; day.output_tokens += oort.output_tokens;
    day.cache_read += oort.cache_read; day.cache_write += oort.cache_write; day.requests += oort.requests;
    keyed(oort.tools, day.tools);
    keyed(oort.models, day.models);
    for (const [tool, model, tokens] of oort.tool_models || []) {
      const name = rename(tool), key = modelKey(name, model);
      day.tool_models.set(key, (day.tool_models.get(key) || 0) + Number(tokens || 0));
    }
    if (oort.credits) day.credits = mergeCredits(day.credits, oort.credits);
  }
  const top = (map, limit) => [...map.entries()].filter(([, tokens]) => tokens > 0)
    .sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0]))).slice(0, limit);
  return out.sort((a, b) => a.day.localeCompare(b.day)).map((day) => ({
    ...day,
    tools: top(day.tools, 8),
    models: top(day.models, 8),
    tool_models: [...top(day.tool_models, 128)].map(([key, tokens]) => [...key.split('\u0000'), tokens]),
  }));
}
