/**
 * Devin（Cognition）用量补充采集：Devin Desktop（原 Windsurf 更名）与 Devin CLI 的
 * 本地 agent 会话共用同一份会话存储——Desktop 的本地会话由 CLI 内核承载
 * （backend_type 为 windsurf 的会话就是 Desktop 里发起的），CLI 直连会话也在同一库里，
 * 因此两个入口天然合并为同一展示名 Devin，按 request_id 去重。
 *
 * 兼容旧 sessions.db 与新版 sessions/<会话>/{meta.json,log.jsonl}。
 * 新版用量在 kind=node 的 node.message.metadata.metrics，旧库在
 * message_nodes.chat_message（JSON 文本）的 metadata.metrics：
 *   - input_tokens / cache_read_tokens / cache_creation_tokens / output_tokens
 *   - input_tokens 不含缓存（库里的 context_input_tokens = 三项输入侧之和，已实测对齐）
 * 模型优先取逐消息 metadata.generation_model（会话中途切换模型时逐消息记录），
 * 缺失退回 sessions.model，再退回 unknown。消息森林会把同一请求写到多个节点，
 * 优先按 request_id、缺失时按 session_id + message_id 去重取首个有效用量。
 *
 * 数据目录（官方文档 docs.devin.ai 的 on-disk formats 页）：
 *   - Windows：%APPDATA%\Devin\cli\sessions.db（Windows 下 CLI 忽略 XDG_* 变量）
 *   - macOS / Linux：~/.local/share/devin/cli/sessions.db（遵循 XDG_DATA_HOME），
 *     macOS 再补查 ~/Library/Application Support/{Devin,devin}
 *   - 政府隔离版（cli-federal）目录名不同、布局相同，一并采集
 *   - 补查 ~/.config/devin 下的旧版/便携式会话库
 *
 * 明确不采：Devin Desktop 的云端会话（Agent Client Protocol 转录在
 * User/acp-messages/*.db，只有 UI 侧消息没有 token；云端按 ACU 计费、用量不出本地）；
 * state.vscdb 只有账号级配额缓存（无逐日明细）；sessions.metadata 的 total_acu_cost
 * 是会话级累计值且无法按日拆分，均不符合日桶口径。
 *
 * 会话库是 CLI 的活动库（带 -wal），只读打开；损坏或非预期结构只跳过并告警，
 * 不中断同步。优先按 metadata.created_at 的完成时间归日，缺失退回节点时间（秒/毫秒）。
 * 新版 JSONL 以起始文件大小分块只读，容忍未写完的尾行；优先新版并与旧库共享请求去重，
 * 避免迁移数据重复计数。不采 transcripts。
 */
import { statSync, realpathSync, readdirSync, readFileSync, openSync, fstatSync, readSync, closeSync } from 'node:fs';
import { join, resolve, basename } from 'node:path';
import { homedir } from 'node:os';
import { StringDecoder } from 'node:string_decoder';
import { DatabaseSync } from 'node:sqlite';
import { TOKEN_DETAIL_LIMITS } from './details.js';

export const TOOL_NAMES = { devin: 'Devin' };

const MAX = { tokens: 1e13, requests: 1e7 };
// 会话库目录名：正式版 cli，政府隔离版 cli-federal（布局相同）。
const DB_VARIANTS = ['cli', 'cli-federal'];
const beijingDayOf = (ms) => new Date(ms + 8 * 3600000).toISOString().slice(0, 10);
// Windows 文件系统不区分大小写，realpath 会保留调用方的大小写；统一小写才能去重。
const canonical = (path) => {
  let found;
  try { found = realpathSync(path); } catch { found = resolve(path); }
  return process.platform === 'win32' ? found.toLowerCase() : found;
};
const isFile = (path) => { try { return statSync(path).isFile(); } catch { return false; } };
const isDirectory = (path) => { try { return statSync(path).isDirectory(); } catch { return false; } };

/** 各平台会话库的候选目录：只看已知的安装布局，不做全盘扫描。 */
function candidateBases({ home, env, platform }) {
  const appData = env.APPDATA || join(home, 'AppData', 'Roaming');
  const localAppData = env.LOCALAPPDATA || join(home, 'AppData', 'Local');
  const legacy = join(home, '.config');
  if (platform === 'win32') return [appData, localAppData, join(home, '.local', 'share'), legacy];
  if (platform === 'darwin') return [join(home, 'Library', 'Application Support'), env.XDG_DATA_HOME || join(home, '.local', 'share'), legacy];
  return [env.XDG_DATA_HOME || join(home, '.local', 'share'), legacy];
}

/** 发现本机全部 Devin 会话库（正式版与隔离版），按规范路径去重。 */
export function discoverDevinDbs({ home = homedir(), env = process.env, platform = process.platform } = {}) {
  return discoverStorage({ home, env, platform }, 'sessions.db', isFile);
}

/** 新版存储独立发现：新安装可能从未生成 sessions.db。 */
export function discoverDevinSessionDirs({ home = homedir(), env = process.env, platform = process.platform } = {}) {
  return discoverStorage({ home, env, platform }, 'sessions', isDirectory);
}

function discoverStorage({ home, env, platform }, leaf, exists) {
  const names = platform === 'linux' ? ['devin'] : ['Devin', 'devin'];
  const found = new Set();
  for (const base of candidateBases({ home, env, platform })) {
    for (const name of names) {
      for (const variant of DB_VARIANTS) {
        const path = join(base, name, variant, leaf);
        if (exists(path)) found.add(canonical(path));
      }
    }
  }
  return [...found];
}

function emptyBucket(day) {
  return { day, tokens: 0, input_tokens: 0, output_tokens: 0, cache_read: 0, cache_write: 0, requests: 0,
    tools: new Map(), models: new Map(), toolModels: new Map() };
}
function addTo(bucket, { input = 0, output = 0, cacheRead = 0, cacheWrite = 0, tool, model }) {
  const clamp = (v) => Math.max(0, Math.min(MAX.tokens, Math.round(Number(v) || 0)));
  bucket.input_tokens += clamp(input);
  bucket.output_tokens += clamp(output);
  bucket.cache_read += clamp(cacheRead);
  bucket.cache_write += clamp(cacheWrite);
  bucket.requests += 1;
  bucket.tokens = bucket.input_tokens + bucket.output_tokens + bucket.cache_read + bucket.cache_write;
  const tokens = clamp(input) + clamp(output) + clamp(cacheRead) + clamp(cacheWrite);
  if (tool) bucket.tools.set(tool, (bucket.tools.get(tool) || 0) + tokens);
  if (model) bucket.models.set(model, (bucket.models.get(model) || 0) + tokens);
  if (tool && model) {
    const key = tool + '\u0000' + model;
    bucket.toolModels.set(key, (bucket.toolModels.get(key) || 0) + tokens);
  }
}

const topEntries = (map, limit) => [...map.entries()].filter(([, v]) => v > 0)
  .sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0]))).slice(0, limit);

/** 两种存储使用相同的去重、时间与模型口径。 */
function consumeUsage(row, seen, buckets) {
  const today = beijingDayOf(Date.now());
  const requestId = typeof row.rid === 'string' && row.rid.trim() ? row.rid : null;
  const messageId = typeof row.mid === 'string' && row.mid ? row.mid : null;
  const sessionId = typeof row.session_id === 'string' && row.session_id ? row.session_id : null;
  const key = requestId ? `dv:r:${requestId}`
    : sessionId && messageId ? `dv:m:${JSON.stringify([sessionId, messageId])}` : null;
  if (!key || seen.has(key)) return;
  const input = Number(row.t_input) || 0;
  const output = Number(row.t_output) || 0;
  const cacheRead = Number(row.t_cache_read) || 0;
  const cacheWrite = Number(row.t_cache_write) || 0;
  if (input + output + cacheRead + cacheWrite <= 0) return;
  let ts = typeof row.completed_at === 'string' ? Date.parse(row.completed_at) : NaN;
  if (!Number.isFinite(ts)) {
    ts = Number(row.created_at) || 0;
    if (ts > 0 && ts < 1e12) ts *= 1000;
  }
  if (!Number.isFinite(ts) || ts <= 0 || ts > 8.64e15 - 8 * 3600000) return;
  const name = value => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, '').trim() : '';
  const model = (name(row.gen_model) || name(row.session_model) || 'unknown').slice(0, 60);
  const day = beijingDayOf(ts);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || day > today) return;
  seen.add(key);
  let bucket = buckets.get(day);
  if (!bucket) { bucket = emptyBucket(day); buckets.set(day, bucket); }
  addTo(bucket, { input, output, cacheRead, cacheWrite, tool: TOOL_NAMES.devin, model });
}

/** 逐请求四分量用量：请求优先去重，完成时间优先分日；不读取对话正文。 */
function readSessionDb(path, seen, buckets, log) {
  let db;
  try {
    db = new DatabaseSync(path, { readOnly: true });
    db.exec('PRAGMA query_only = ON; PRAGMA busy_timeout = 3000');
    const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((row) => row.name));
    if (!tables.has('message_nodes')) return;
    // sessions 承载会话级模型名；缺失时视为非预期结构，静默跳过。
    if (!tables.has('sessions')) return;
    const rows = db.prepare(`SELECT n.row_id AS row_id, n.session_id AS session_id, n.created_at AS created_at,
      json_extract(n.chat_message, '$.message_id') AS mid,
      json_extract(n.chat_message, '$.metadata.request_id') AS rid,
      json_extract(n.chat_message, '$.metadata.created_at') AS completed_at,
      json_extract(n.chat_message, '$.metadata.metrics.input_tokens') AS t_input,
      json_extract(n.chat_message, '$.metadata.metrics.output_tokens') AS t_output,
      json_extract(n.chat_message, '$.metadata.metrics.cache_read_tokens') AS t_cache_read,
      json_extract(n.chat_message, '$.metadata.metrics.cache_creation_tokens') AS t_cache_write,
      json_extract(n.chat_message, '$.metadata.generation_model') AS gen_model,
      s.model AS session_model
      FROM message_nodes n LEFT JOIN sessions s ON s.id = n.session_id
      WHERE json_valid(n.chat_message) AND json_extract(n.chat_message, '$.role') = 'assistant'
      ORDER BY n.row_id`).all();
    for (const row of rows) {
      consumeUsage(row, seen, buckets);
    }
  } catch (err) {
    log(`devin 会话库 ${path} 读取失败，已跳过：${err?.message || err}`);
  } finally {
    try { db?.close(); } catch { /* 已关闭 */ }
  }
}

/** 对活动日志取有界快照；内存仅保留当前行，不装载整份会话。 */
function* jsonLines(path) {
  const fd = openSync(path, 'r');
  try {
    const end = fstatSync(fd).size;
    const chunk = Buffer.allocUnsafe(64 * 1024), decoder = new StringDecoder('utf8');
    let position = 0, pending = '';
    while (position < end) {
      const bytes = readSync(fd, chunk, 0, Math.min(chunk.length, end - position), position);
      if (!bytes) break;
      position += bytes;
      pending += decoder.write(chunk.subarray(0, bytes));
      let start = 0, index;
      while ((index = pending.indexOf('\n', start)) !== -1) {
        const line = pending.slice(start, index);
        start = index + 1;
        let value;
        try { value = JSON.parse(line); } catch { continue; }
        yield value;
      }
      pending = pending.slice(start);
    }
    pending += decoder.end();
    // 有效的无换行尾记录可读取；活跃文件尚未写完的 JSON 留待下次扫描。
    let value;
    try { value = JSON.parse(pending); } catch { return; }
    yield value;
  } finally { closeSync(fd); }
}

function readSessionDir(root, seen, buckets, log) {
  let entries;
  try { entries = readdirSync(root, { withFileTypes: true }); }
  catch (err) { log(`devin 会话目录读取失败，已跳过（${err.code || 'READ_FAILED'}）`); return; }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory()) continue;
    const dir = join(root, entry.name), file = join(dir, 'log.jsonl');
    let meta = {};
    try { meta = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8')) || {}; }
    catch {
      // 元数据可能仍在写入；只记录固定诊断，逐消息模型与目录名仍足以归因。
      log('devin 会话元数据暂不可读，已回退到逐消息模型与会话目录名');
    }
    const sessionId = typeof meta.id === 'string' && meta.id ? meta.id : basename(dir);
    try {
      for (const record of jsonLines(file)) {
        if (record?.kind !== 'node') continue;
        const node = record.node, message = node?.message;
        if (message?.role !== 'assistant') continue;
        const metadata = message.metadata || {}, metrics = metadata.metrics || {};
        consumeUsage({ session_id: sessionId, mid: message.message_id, rid: metadata.request_id,
          completed_at: metadata.created_at, created_at: node.metadata?.created_at ?? record.at,
          t_input: metrics.input_tokens, t_output: metrics.output_tokens,
          t_cache_read: metrics.cache_read_tokens, t_cache_write: metrics.cache_creation_tokens,
          gen_model: metadata.generation_model, session_model: meta.model }, seen, buckets);
      }
    } catch (err) {
      // 不包含 JSON 原文/解析异常，避免把会话正文写入日志。
      log(`devin 会话日志读取失败，已跳过（${err.code || 'READ_FAILED'}）`);
    }
  }
}

/** 汇总 Devin Desktop 与 Devin CLI 两种存储格式的逐请求用量。 */
export function collectDevinDays({ home = homedir(), env = process.env, platform = process.platform,
  paths = null, sessionDirs = null, log = () => {} } = {}) {
  const dbs = paths || discoverDevinDbs({ home, env, platform });
  // 显式 paths 沿用隔离行为；调用方可同时提供 sessionDirs 验证迁移合并。
  const dirs = sessionDirs ?? (paths === null ? discoverDevinSessionDirs({ home, env, platform }) : []);
  const buckets = new Map(), seen = new Set();
  for (const dir of dirs) readSessionDir(dir, seen, buckets, log);
  for (const path of dbs) readSessionDb(path, seen, buckets, log);
  return [...buckets.values()].sort((a, b) => a.day.localeCompare(b.day)).map((bucket) => ({
    day: bucket.day, tokens: bucket.tokens, input_tokens: bucket.input_tokens, output_tokens: bucket.output_tokens,
    cache_read: bucket.cache_read, cache_write: bucket.cache_write, requests: bucket.requests,
    models: topEntries(bucket.models, TOKEN_DETAIL_LIMITS.models), tools: topEntries(bucket.tools, TOKEN_DETAIL_LIMITS.tools),
    tool_models: [...bucket.toolModels.entries()].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])))
      .slice(0, TOKEN_DETAIL_LIMITS.tool_models).map(([key, tokens]) => { const [tool, model] = key.split('\u0000'); return [tool, model, tokens]; }),
  }));
}
