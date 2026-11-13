/**
 * Devin（Cognition）用量补充采集：Devin Desktop（原 Windsurf 更名）与 Devin CLI 的
 * 本地 agent 会话共用同一份会话库 sessions.db——Desktop 的本地会话由 CLI 内核承载
 * （backend_type 为 windsurf 的会话就是 Desktop 里发起的），CLI 直连会话也在同一库里，
 * 因此两个入口天然合并为同一展示名 Devin，按 message_id 去重即可避免任何重复。
 *
 * 逐请求用量在 message_nodes.chat_message（JSON 文本）的 metadata.metrics：
 *   - input_tokens / cache_read_tokens / cache_creation_tokens / output_tokens
 *   - input_tokens 不含缓存（库里的 context_input_tokens = 三项输入侧之和，已实测对齐）
 * 模型优先取逐消息 metadata.generation_model（会话中途切换模型时逐消息记录），
 * 缺失退回 sessions.model。消息森林（重试/分叉）会把同一 message_id 写到多个节点，
 * 各节点 metrics 完全一致，按 message_id 去重取首次出现。
 *
 * 数据目录（官方文档 docs.devin.ai 的 on-disk formats 页）：
 *   - Windows：%APPDATA%\Devin\cli\sessions.db（Windows 下 CLI 忽略 XDG_* 变量）
 *   - macOS / Linux：~/.local/share/devin/cli/sessions.db（遵循 XDG_DATA_HOME），
 *     macOS 再补查 ~/Library/Application Support/{Devin,devin}
 *   - 政府隔离版（cli-federal）目录名不同、布局相同，一并采集
 *
 * 明确不采：Devin Desktop 的云端会话（Agent Client Protocol 转录在
 * User/acp-messages/*.db，只有 UI 侧消息没有 token；云端按 ACU 计费、用量不出本地）；
 * state.vscdb 只有账号级配额缓存（无逐日明细）；sessions.metadata 的 total_acu_cost
 * 是会话级累计值且无法按日拆分，均不符合日桶口径。
 *
 * 会话库是 CLI 的活动库（带 -wal），只读打开；损坏或非预期结构只跳过并告警，
 * 不中断同步。时间戳为 Unix 秒，按北京时间分日。
 */
import { statSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';

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

/** 各平台会话库的候选目录：只看已知的安装布局，不做全盘扫描。 */
function candidateBases({ home, env, platform }) {
  const appData = env.APPDATA || join(home, 'AppData', 'Roaming');
  const localAppData = env.LOCALAPPDATA || join(home, 'AppData', 'Local');
  if (platform === 'win32') return [appData, localAppData, join(home, '.local', 'share')];
  if (platform === 'darwin') return [join(home, 'Library', 'Application Support'), env.XDG_DATA_HOME || join(home, '.local', 'share')];
  return [env.XDG_DATA_HOME || join(home, '.local', 'share')];
}

/** 发现本机全部 Devin 会话库（正式版与隔离版），按规范路径去重。 */
export function discoverDevinDbs({ home = homedir(), env = process.env, platform = process.platform } = {}) {
  const names = platform === 'linux' ? ['devin'] : ['Devin', 'devin'];
  const found = new Set();
  for (const base of candidateBases({ home, env, platform })) {
    for (const name of names) {
      for (const variant of DB_VARIANTS) {
        const db = join(base, name, variant, 'sessions.db');
        if (isFile(db)) found.add(canonical(db));
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

/** 读一份会话库：逐请求四分量用量，按 message_id 去重（消息森林的重复节点只计一次）。 */
function readSessionDb(path, seen, buckets, log) {
  let db;
  try {
    db = new DatabaseSync(path, { readOnly: true });
    db.exec('PRAGMA busy_timeout = 3000');
    const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((row) => row.name));
    if (!tables.has('message_nodes')) return;
    // sessions 承载会话级模型名；缺失时视为非预期结构，静默跳过。
    if (!tables.has('sessions')) return;
    const rows = db.prepare(`SELECT n.row_id AS row_id, n.created_at AS created_at,
      json_extract(n.chat_message, '$.message_id') AS mid,
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
      const key = 'dv:' + row.mid;
      if (typeof row.mid !== 'string' || !row.mid || seen.has(key)) continue;
      seen.add(key);
      const input = Number(row.t_input) || 0;
      const output = Number(row.t_output) || 0;
      const cacheRead = Number(row.t_cache_read) || 0;
      const cacheWrite = Number(row.t_cache_write) || 0;
      if (input + output + cacheRead + cacheWrite <= 0) continue;
      let ts = Number(row.created_at) || 0;
      if (ts > 0 && ts < 1e12) ts *= 1000;
      if (!ts) continue;
      const model = String(row.gen_model || row.session_model || '').trim().slice(0, 60);
      const day = beijingDayOf(ts);
      let bucket = buckets.get(day);
      if (!bucket) { bucket = emptyBucket(day); buckets.set(day, bucket); }
      addTo(bucket, { input, output, cacheRead, cacheWrite, tool: TOOL_NAMES.devin, model });
    }
  } catch (err) {
    log(`devin 会话库 ${path} 读取失败，已跳过：${err?.message || err}`);
  } finally {
    try { db?.close(); } catch { /* 已关闭 */ }
  }
}

/** 汇总 Devin Desktop 与 Devin CLI（共用会话库）的逐请求用量，产出与上报协议同构的日行。 */
export function collectDevinDays({ home = homedir(), env = process.env, platform = process.platform,
  paths = null, log = () => {} } = {}) {
  const dbs = paths || discoverDevinDbs({ home, env, platform });
  const buckets = new Map(), seen = new Set();
  for (const path of dbs) readSessionDb(path, seen, buckets, log);
  return [...buckets.values()].sort((a, b) => a.day.localeCompare(b.day)).map((bucket) => ({
    day: bucket.day, tokens: bucket.tokens, input_tokens: bucket.input_tokens, output_tokens: bucket.output_tokens,
    cache_read: bucket.cache_read, cache_write: bucket.cache_write, requests: bucket.requests,
    models: topEntries(bucket.models, 8), tools: topEntries(bucket.tools, 8),
    tool_models: [...bucket.toolModels.entries()].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])))
      .slice(0, 128).map(([key, tokens]) => { const [tool, model] = key.split('\u0000'); return [tool, model, tokens]; }),
  }));
}
