/**
 * Oort 系工具用量补充采集：只读本机各产品自己的状态目录，不写任何外部数据，
 * 也不依赖 token-watcher（它的 13 种工具清单不认识 Oort 系产品）。
 *
 * 数据源与口径：
 *   - DSH For OortCloud Work
 *     a) ~/.dsh-oortcloud-work/sessions/<workspace>/<session>/session.v*.jsonl.zst[d]
 *        会话日志的逐请求用量（assistant/message 的 data.usage，或旧版 assistant/chunk 的
 *        chunk.usage），带 time 与模型，按北京时间精确分日。日志是追加的多帧 zstd；
 *        Node 内置解码器只解首帧，这里按帧魔数切开逐帧解，解不出来就整体退回 b)。
 *        分叉/种子会话（isSeeded）开头重放的父会话历史用 time < createdAt 排除。
 *     b) ~/.dsh-oortcloud-work/storages/session_projcache/sessions/*.json
 *        的 record.rows.tokenUsage.val.totals（会话累计值）。没有可用日志的会话才用它，
 *        按文件 mtime（北京时间）归因，避免与 a) 重复计数。
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
 *   - OortOffice（OnlyOffice 外壳 + 内置 ZCode 内核，HOME 指向 zcode-home）
 *     %LOCALAPPDATA%\OortOffice\zcode-home\.zcode\cli\db\db.sqlite 的 model_usage，
 *     与 OortCodex Desktop 同构。未用过的安装没有该库，静默跳过。
 *
 * 无法本地采集：OortOffice 的聊天内容之外没有额外来源 —— %APPDATA%\OortOffice 不存在，
 * 本地聊天存于 OnlyOffice 面板的浏览器存储；平台侧 new-api 有完整计量
 * （/api/dashboard/self/overview 按天按 token），但需要有效的平台 accesstoken，
 * 本机各应用落盘的令牌均已过期、且主力应用的令牌为加密存储。
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import zlib from 'node:zlib';

export const TOOL_NAMES = {
  dsh: 'DSH For OortCloud Work',
  aiStudio: 'OortCloud AI Studio',
  oortCodexDesktop: 'OortCodex Desktop',
  oortOffice: 'OortOffice',
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

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

/**
 * 解开 dsh 的多帧 zstd 会话日志。Node 内置解码器（22.15+）一次只解首帧，
 * 所以按帧魔数切片逐帧解；任一帧解不开（文件正在追加、或魔数误判）就整份作废，
 * 交给 projcache 兜底，宁可粗一点也不能漏。没有内置解码器时返回 null。
 */
function readDshLog(file) {
  if (file.endsWith('.jsonl')) return readFileSync(file, 'utf8');
  const decode = zlib.zstdDecompressSync;
  if (typeof decode !== 'function') return null;
  let buf;
  try { buf = readFileSync(file); } catch { return null; }
  let text = '';
  let frames = 0;
  for (let at = buf.indexOf(ZSTD_MAGIC); at >= 0; at = buf.indexOf(ZSTD_MAGIC, at + 4)) {
    // 截断帧内置解码器不报错、只返回空，按解出 0 字节视为失败
    const part = decode(buf.subarray(at)).toString('utf8');
    if (!part) return null;
    text += part;
    frames++;
  }
  return frames ? text : null;
}

/** 单份 dsh 会话日志 → 逐请求用量（session + turn + step + 输入侧用量 去重） */
function parseDshLog(text) {
  let header = null;
  let model = null;
  const requests = new Map();
  for (const line of text.split('\n')) {
    if (!line || (!line.includes('"usage"') && !line.includes('"request/header"') && !line.includes('"type":"session"'))) continue;
    let rec;
    try { rec = JSON.parse(line); } catch { continue; }
    if (rec.type === 'session') { header = header || rec; continue; }
    if (rec.type === 'request/header') { model = rec.data?.header?.config?.model ?? model; continue; }
    const usage = rec.type === 'assistant/message' ? rec.data?.usage
      : rec.type === 'assistant/chunk' && rec.data?.chunk?.type === 'usage' ? rec.data.chunk.usage : null;
    if (!usage || !Number.isFinite(rec.time)) continue;
    const input = Number(usage.inputTokens) || 0;
    const cached = Number(usage.cacheReadTokens) || 0;
    const cacheWrite = Number(usage.cacheWriteTokens) || 0;
    const output = Number(usage.outputTokens) || 0;
    if (input + cached + cacheWrite + output <= 0) continue;
    const turn = rec.data?.turn, step = rec.data?.step;
    // 同一请求会有 chunk 与 message 两行；带输入侧用量区分“失败后重试”的两次请求
    const key = `${turn}:${step}:${input}:${cached}:${cacheWrite}`;
    const prev = requests.get(key);
    const sourceModel = rec.data?.message?.source?.model;
    let recModel = typeof sourceModel === 'string' && sourceModel ? sourceModel : model;
    if (!recModel && prev) recModel = prev.model;
    if (prev && output <= prev.output) continue;
    requests.set(key, { ts: rec.time, input, output, cacheRead: cached, cacheWrite, model: String(recModel).trim().toLowerCase().slice(0, 60) });
  }
  if (!requests.size) return null;
  // 分叉/种子会话开头重放的是父会话历史，时间早于本会话创建时间，不能重复计入
  const createdAt = Number(header?.createdAt);
  const seeded = header?.isSeeded === true && Number.isFinite(createdAt) ? createdAt : null;
  const id = String(header?.id || '');
  return { id, events: [...requests.values()].filter((e) => seeded === null || e.ts >= seeded) };
}

/** dsh 会话日志目录 → 已按请求归日的桶；返回已覆盖的会话 id（这些会话不再读 projcache） */
function collectDshLogs(root, buckets) {
  const covered = new Set();
  if (!existsSync(root)) return covered;
  for (const workspace of readdirSync(root, { withFileTypes: true })) {
    if (!workspace.isDirectory()) continue;
    for (const entry of readdirSync(join(root, workspace.name), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dir = join(root, workspace.name, entry.name);
      let files;
      try { files = readdirSync(dir).filter((n) => /\.jsonl(\.zst)?(\.zstd)?$/.test(n)).sort(); }
      catch { continue; }
      if (!files.length) continue;
      const reqs = new Map();
      let id = entry.name;
      let failed = false;
      for (const name of files) {
        const text = readDshLog(join(dir, name));
        if (text === null) { failed = true; break; }
        const parsed = parseDshLog(text);
        if (!parsed) continue;
        if (parsed.id) id = parsed.id;
        for (const event of parsed.events) {
          const key = `dsh:${event.ts}:${event.input}:${event.cacheRead}:${event.cacheWrite}`;
          const prev = reqs.get(key);
          if (!prev || event.output > prev.output) reqs.set(key, event);
        }
      }
      // 日志解不开时整份作废，让 projcache 的会话累计值兜底（不重复计）
      if (failed) continue;
      covered.add(entry.name);
      if (id) covered.add(id);
      for (const event of reqs.values()) {
        const day = beijingDayOf(event.ts);
        const bucket = buckets.get(day) || emptyBucket(day);
        addTo(bucket, { input: event.input, output: event.output, cacheRead: event.cacheRead,
          cacheWrite: event.cacheWrite, requests: 1, tool: TOOL_NAMES.dsh, model: event.model });
        buckets.set(day, bucket);
      }
    }
  }
  return covered;
}

/** DSH For OortCloud Work：优先逐请求日志，缺日志的会话退回 projcache 累计（按 mtime 归因） */
function collectDsh(root, log) {
  const base = join(root, '.dsh-oortcloud-work');
  const buckets = new Map();
  const covered = collectDshLogs(join(base, 'sessions'), buckets);
  const dir = join(base, 'storages', 'session_projcache', 'sessions');
  if (!existsSync(dir)) return [...buckets.values()];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.json')) continue;
    if (covered.has(name.slice(0, -'.json'.length))) continue;
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
 * 读一份 ZCode 内核库的 model_usage（与 token-watcher 的 zcode 同构）并入桶。
 * input_tokens 含 cache_read，入库时拆成新输入与缓存命中；按记录 id 去重，防止多条安装线
 * 指向同一份数据。数据库缺失或被占用时只跳过本轮。
 */
function readZcodeUsage(path, tool, prefix, buckets, seen, log) {
  if (!existsSync(path)) return;
  let db;
  try {
    db = new DatabaseSync(path, { readOnly: true });
    db.exec('PRAGMA busy_timeout = 3000');
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='model_usage'").get()) return;
    const rows = db.prepare(`SELECT id, model_id, started_at, input_tokens, output_tokens,
      cache_creation_input_tokens, cache_read_input_tokens FROM model_usage`).all();
    for (const row of rows) {
      const key = prefix + row.id;
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
        requests: 1, tool, model });
      buckets.set(day, bucket);
    }
  } catch (err) {
    log(`oort ${tool} 数据库读取失败，已跳过（${path}）：${err?.message || err}`);
  } finally {
    try { db?.close(); } catch { /* 已关闭 */ }
  }
}

function collectOortCodexDesktop(home, log) {
  const buckets = new Map(), seen = new Set();
  for (const name of OORTCODEX_HOMES) {
    readZcodeUsage(join(home, name, 'cli', 'db', 'db.sqlite'), TOOL_NAMES.oortCodexDesktop, 'oortcodex:', buckets, seen, log);
  }
  return [...buckets.values()];
}

/**
 * OortOffice 自带 ZCode 内核，HOME 被指到安装数据目录下的 zcode-home，
 * 因此用量落在 <data>/OortOffice/zcode-home/.zcode/cli/db/db.sqlite。
 * 默认数据目录按平台惯例取，未用过 OortOffice 时该库不存在。
 */
function collectOortOffice(localAppData, log) {
  if (!localAppData) return [];
  const buckets = new Map();
  readZcodeUsage(join(localAppData, 'OortOffice', 'zcode-home', '.zcode', 'cli', 'db', 'db.sqlite'),
    TOOL_NAMES.oortOffice, 'oortoffice:', buckets, new Set(), log);
  return [...buckets.values()];
}

const topEntries = (map, limit) => [...map.entries()].filter(([, v]) => v > 0)
  .sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0]))).slice(0, limit);

// 只按 home 推平台数据目录（不读环境变量）：测试里给临时 home 就不会扫到真机数据
const dataHomeOf = (home) => process.platform === 'win32'
  ? join(home, 'AppData', 'Local')
  : process.platform === 'darwin' ? join(home, 'Library', 'Application Support')
    : join(home, '.local', 'share');

/** 汇总 Oort 系各源，产出与上报协议同构的日行 */
export function collectOortDays({ home = homedir(), appData = process.env.APPDATA || null,
  localAppData = null, log = () => {} } = {}) {
  const merged = new Map();
  const sources = [...collectDsh(home, log), ...collectAiStudio(appData, log),
    ...collectAiStudioTranscripts(appData, log), ...collectOortCodexDesktop(home, log),
    ...collectOortOffice(localAppData ?? dataHomeOf(home), log)];
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
