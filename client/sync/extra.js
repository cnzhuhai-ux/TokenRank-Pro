/**
 * token-watcher 之外的补充采集：
 *   - WorkBuddy：上游只扫 ~/.WorkBuddy/projects，这里补齐国内/国际版和便携安装的
 *     `*.jsonl` 转录（~/.workbuddy-ai、~/.WorkBuddy AI、~/.workbuddy-cn 等）。
 *   - DevEco Code：OpenCode 同构的 deveco.db，上游不认识。
 *   - Genspark Code：Genspark Super App 内的编码终端（gencode，OpenCode 定制版），
 *     逐请求用量在 ~/.local/share/gencode/opencode.db，上游不认识；Super App 其余
 *     空间（网页 agents 聊天等）用量仍在云端，无本地数据。
 *   - ToCodex：VS Code 系桌面端与 CLI，任务用量由自带扩展（扩展 id tocodex.tocodex）
 *     写在 Cline 系的各任务目录 ui_messages.json，say=api_req_started 的消息尾带
 *     {tokensIn, tokensOut, cacheReads, cacheWrites}；失败与重试中的请求没有 token
 *     字段，不会重复计。桌面端标准安装读 %APPDATA%\ToCodex Desktop，便携安装读
 *     <安装目录>\data\user-data（含自定义盘的 Program Files）；CLI 的 shim 把
 *     globalStorage 指到 ~/.vscode-mock/global-storage（无扩展 id 子目录）。逐请求
 *     不落模型名，只记工具维度用量。
 *
 * 所有数据目录都在**全部磁盘**上发现，不只看系统盘（C:）：逐盘有界遍历，只看
 * 目录名和 deveco.db / gencode 目录，跳过系统/缓存目录（Program Files 由已知位置
 * 单独补查）；已知环境变量位置再单独补一遍。只读，单文件/单库损坏只跳过并告警，
 * 不会中断同步。
 *
 * 口径与 token-watcher 保持一致：
 *   - WorkBuddy 的 input_tokens 已含 cache_read，展示时拆成 input + cache_read，
 *     total = input_tokens + output_tokens（cache_write 记 0）。
 *   - DevEco/OpenCode 的 tokens 是 input/output/reasoning/cache.read/cache.write，
 *     total = input + output + cache.read + cache.write（reasoning 已含在 output 内）。
 */
import { existsSync, readdirSync, readFileSync, statSync, realpathSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { homedir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';

export const TOOL_NAMES = { workbuddy: 'WorkBuddy', deveco: 'DevEco Code', gencode: 'Genspark Code', tocodex: 'ToCodex' };

const MAX_DEPTH = 5;
const MAX = { tokens: 1e13, requests: 1e7 };
const WORKBUDDY_DIR = /^\.?workbuddy(?:[\s._-]?(?:ai|cn|intl|global))?$/i;
const DEVECO_DIR = /^(?:\.?deveco(?:[\s._-]?code)?|deveco[\s._-]?studio|huawei[\s._-]?deveco.*)$/i;
// gencode 的库只认 gencode 目录名；散落的 opencode.db 属于独立安装的 opencode（上游已覆盖），不能抢。
const GENCODE_DIR = /^\.?gencode$/i;
// ToCodex 的任务数据在扩展目录 tocodex.tocodex/tasks 下；产品目录名（ToCodex / ToCodex Desktop）用于定位安装位置。
const TOCODEX_EXT = 'tocodex.tocodex';
const TOCODEX_DIR = /^\.?tocodex(?:[\s._-]?desktop)?$/i;
// 逐盘遍历时跳过的系统与缓存目录，避免把整盘扫成分钟级。
const SKIP = new Set(['windows', 'program files', 'program files (x86)', 'programdata', '$recycle.bin',
  'system volume information', 'recovery', 'perflogs', 'node_modules', '.git', '.svn', '.hg',
  'temp', 'tmp', 'cache', '.cache', 'installer', 'microsoft', 'packages', 'crashdumps', 'winsxs',
  'driverstore', 'logs', 'log']);
const beijingDayOf = (ms) => new Date(ms + 8 * 3600000).toISOString().slice(0, 10);
// Windows 文件系统不区分大小写，realpath 会保留调用方的大小写；统一小写才能去重。
const canonical = (path) => {
  let found;
  try { found = realpathSync(path); } catch { found = resolve(path); }
  return process.platform === 'win32' ? found.toLowerCase() : found;
};
const isDirectory = (path) => { try { return statSync(path).isDirectory(); } catch { return false; } };
const isFile = (path) => { try { return statSync(path).isFile(); } catch { return false; } };

/** 所有本地磁盘根：Windows 盘符，macOS 挂载卷，Linux 常见挂载点。 */
export function discoverDrives({ platform = process.platform } = {}) {
  if (platform === 'win32') {
    const drives = [];
    for (const letter of 'CDEFGHIJKLMNOPQRSTUVWXYZ') {
      const root = letter + ':\\';
      if (isDirectory(root)) drives.push(root);
    }
    return drives;
  }
  const roots = ['/'];
  for (const parent of ['/Volumes', '/mnt', '/media']) {
    try {
      for (const name of readdirSync(parent)) {
        const path = join(parent, name);
        if (isDirectory(path)) roots.push(path);
      }
    } catch { /* 挂载点不存在 */ }
  }
  return [...new Set(roots.map(canonical))];
}

/** WorkBuddy 的数据根是 <产品目录>/projects；只认这个布局，避免把安装目录当成数据。 */
function workbuddyRoot(base) {
  const projects = join(base, 'projects');
  return isDirectory(projects) ? projects : null;
}
function devecoDbIn(base) {
  for (const candidate of [join(base, 'deveco.db'), join(base, 'data', 'deveco.db')]) {
    if (isFile(candidate)) return candidate;
  }
  return null;
}
function gencodeDbIn(base) {
  const candidate = join(base, 'opencode.db');
  return isFile(candidate) ? candidate : null;
}
/** ToCodex 的 tasks 目录：桌面端标准布局与 VS Code 便携模式（data/user-data 在安装目录内）。 */
function tocodexTasksIn(base) {
  for (const candidate of [join(base, 'User', 'globalStorage', TOCODEX_EXT, 'tasks'),
    join(base, 'data', 'user-data', 'User', 'globalStorage', TOCODEX_EXT, 'tasks')]) {
    if (isDirectory(candidate)) return candidate;
  }
  return null;
}

/** 逐盘有界遍历：只收集 WorkBuddy 数据目录、deveco.db、gencode 与 ToCodex tasks 目录，不读文件内容。 */
function scanDrives(drives, { workbuddy, deveco, gencode, tocodex }) {
  for (const root of drives) {
    const stack = [[root, 0]];
    while (stack.length) {
      const [dir, depth] = stack.pop();
      let entries;
      try { entries = readdirSync(dir, { withFileTypes: true }); } catch { continue; }
      for (const entry of entries) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (WORKBUDDY_DIR.test(entry.name)) {
            const found = workbuddyRoot(path);
            if (found) workbuddy.add(found);
          }
          if (DEVECO_DIR.test(entry.name)) {
            const found = devecoDbIn(path);
            if (found) deveco.add(found);
          }
          if (GENCODE_DIR.test(entry.name)) {
            const found = gencodeDbIn(path);
            if (found) gencode.add(found);
          }
          if (TOCODEX_DIR.test(entry.name)) {
            const found = tocodexTasksIn(path);
            if (found) tocodex.add(found);
          }
          if (depth < MAX_DEPTH && !SKIP.has(entry.name.toLowerCase())) stack.push([path, depth + 1]);
        } else if (entry.isFile() && entry.name.toLowerCase() === 'deveco.db') {
          deveco.add(path);
        }
      }
    }
  }
}

/** 环境变量里的已知位置（可能位于任何盘），作为逐盘遍历的补充。 */
function scanKnownLocations({ home, env }, { workbuddy, deveco, gencode, tocodex }) {
  const bases = [home, env.APPDATA, env.LOCALAPPDATA, env.XDG_DATA_HOME, env.XDG_CONFIG_HOME,
    join(home, 'AppData', 'Roaming'), join(home, 'AppData', 'Local'), join(home, '.local', 'share')]
    .filter(Boolean);
  for (const base of bases) {
    for (const name of ['.WorkBuddy', '.workbuddy', '.workbuddy-ai', '.workbuddy-cn', '.workbuddy-intl',
      '.WorkBuddy AI', '.WorkBuddy-CN', '.WorkBuddy-AI', 'WorkBuddy', 'WorkBuddy AI', 'workbuddy']) {
      const found = workbuddyRoot(join(base, name));
      if (found) workbuddy.add(found);
    }
    for (const candidate of [join(base, 'deveco', 'deveco.db'), join(base, '.deveco', 'deveco.db'),
      join(base, 'deveco-code', 'deveco.db'), join(base, '.deveco-code', 'deveco.db'),
      join(base, 'Huawei', 'DevEcoStudio', 'deveco.db'), join(base, 'DevEcoStudio', 'deveco.db')]) {
      if (isFile(candidate)) deveco.add(candidate);
    }
    for (const candidate of [join(base, 'gencode', 'opencode.db')]) {
      if (isFile(candidate)) gencode.add(candidate);
    }
    for (const candidate of [join(base, 'ToCodex Desktop'), join(base, 'ToCodex'),
      join(base, 'Programs', 'ToCodex Desktop'), join(base, 'Programs', 'ToCodex')]) {
      const found = tocodexTasksIn(candidate);
      if (found) tocodex.add(found);
    }
  }
  // ToCodex CLI：shim 的 globalStorage 在 ~/.vscode-mock/global-storage，tasks 直接在其下（无扩展 id 子目录）。
  for (const candidate of [join(home, '.vscode-mock', 'global-storage', 'tasks'),
    join(home, '.vscode-mock', 'global-storage', TOCODEX_EXT, 'tasks')]) {
    if (isDirectory(candidate)) tocodex.add(candidate);
  }
}

/** token-watcher 已经扫过的 WorkBuddy 目录（含 extra-roots 登记），不能重复采集。 */
function upstreamWorkbuddyRoots(home) {
  const roots = new Set([join(home, '.WorkBuddy', 'projects')].map(canonical));
  try {
    const map = JSON.parse(readFileSync(join(home, '.tokenmeter', 'extra-roots.json'), 'utf8'));
    for (const root of Array.isArray(map?.workbuddy) ? map.workbuddy : []) {
      if (typeof root !== 'string' || !root) continue;
      const expanded = root.startsWith('~') ? join(home, root.slice(1)) : root;
      roots.add(canonical(expanded));
    }
  } catch { /* 没有登记表或格式异常时只排除默认目录 */ }
  return roots;
}

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
  bucket.tokens = bucket.input_tokens + bucket.output_tokens + bucket.cache_read + bucket.cache_write;
  if (tool) bucket.tools.set(tool, (bucket.tools.get(tool) || 0) + tokens);
  if (model) bucket.models.set(model, (bucket.models.get(model) || 0) + tokens);
  if (tool && model) {
    const key = tool + '\u0000' + model;
    bucket.toolModels.set(key, (bucket.toolModels.get(key) || 0) + tokens);
  }
}

/** WorkBuddy 转录：message.usage 的 input_tokens 已含 cache_read。 */
function collectWorkbuddy(root, seen, buckets, log) {
  const walk = (dir) => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) { walk(path); continue; }
      if (!entry.name.endsWith('.jsonl')) continue;
      try {
        for (const line of readFileSync(path, 'utf8').split('\n')) {
          if (!line.includes('"usage"')) continue;
          let record;
          try { record = JSON.parse(line); } catch { continue; }
          const usage = record?.message?.usage;
          if (!usage || typeof usage !== 'object' || !record.id || !Number.isFinite(record.timestamp)) continue;
          const inputRaw = Number(usage.input_tokens) || 0;
          const cached = Math.min(Number(usage.cache_read_input_tokens) || 0, inputRaw);
          const output = Number(usage.output_tokens) || 0;
          if (inputRaw + output <= 0) continue;
          const key = 'wb:' + record.id;
          if (seen.has(key)) continue;
          seen.add(key);
          const model = String(record.providerData?.model || '').trim().slice(0, 60);
          const day = beijingDayOf(record.timestamp);
          let bucket = buckets.get(day);
          if (!bucket) { bucket = emptyBucket(day); buckets.set(day, bucket); }
          addTo(bucket, { input: inputRaw - cached, cacheRead: cached, output, requests: 1, tool: TOOL_NAMES.workbuddy, model });
        }
      } catch (err) {
        log(`workbuddy 转录 ${entry.name} 解析失败，已跳过：${err?.message || err}`);
      }
    }
  };
  walk(root);
}

/** OpenCode 同构库（DevEco Code 的 deveco.db、Genspark Code 的 gencode/opencode.db）：message.data.tokens。 */
function collectOpencodeDb(path, tool, seen, buckets, log) {
  let db;
  try {
    db = new DatabaseSync(path, { readOnly: true });
    db.exec('PRAGMA busy_timeout = 3000');
    const table = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='message'").get();
    if (!table) return;
    const field = (jsonPath) => `CASE WHEN json_valid(data) THEN json_extract(data, '${jsonPath}') END`;
    const rows = db.prepare(`SELECT id, session_id, time_created,
      ${field('$.time.created')} AS created, ${field('$.role')} AS role,
      ${field('$.modelID')} AS model, CASE WHEN json_valid(data) THEN json_type(data, '$.tokens') END AS tokens_type,
      ${field('$.tokens.input')} AS t_input, ${field('$.tokens.output')} AS t_output,
      ${field('$.tokens.reasoning')} AS t_reasoning,
      ${field('$.tokens.cache.read')} AS t_cache_read, ${field('$.tokens.cache.write')} AS t_cache_write
      FROM message`).all();
    for (const row of rows) {
      if (row.tokens_type !== 'object' || row.role !== 'assistant') continue;
      const input = Number(row.t_input) || 0;
      const cacheRead = Number(row.t_cache_read) || 0;
      const cacheWrite = Number(row.t_cache_write) || 0;
      const output = Number(row.t_output) || 0;
      if (input + output + cacheRead + cacheWrite <= 0) continue;
      const key = tool + ':' + row.id;
      if (seen.has(key)) continue;
      seen.add(key);
      let ts = Number(row.created) || Number(row.time_created) || 0;
      if (ts > 0 && ts < 1e12) ts *= 1000;
      if (!ts) continue;
      const model = String(row.model || '').trim().slice(0, 60);
      const day = beijingDayOf(ts);
      let bucket = buckets.get(day);
      if (!bucket) { bucket = emptyBucket(day); buckets.set(day, bucket); }
      addTo(bucket, { input, output, cacheRead, cacheWrite, requests: 1, tool: TOOL_NAMES[tool], model });
    }
  } catch (err) {
    log(`${tool} 数据库 ${path} 读取失败，已跳过：${err?.message || err}`);
  } finally {
    try { db?.close(); } catch { /* 已关闭 */ }
  }
}

const topEntries = (map, limit) => [...map.entries()].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])))
  .slice(0, limit);

/** 从 Cline 系 api_req_started 文本中提取一次请求的 token 用量；没有 token 字段（失败/重试中）返回 null。 */
function parseClineUsage(text) {
  if (typeof text !== 'string' || !text.includes('tokensIn')) return null;
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { /* 文本可能被截断，走正则兜底 */ }
  const pick = (key) => {
    const v = parsed?.[key];
    if (Number.isFinite(v)) return v;
    const m = new RegExp(`"${key}":(\\d+)`).exec(text);
    return m ? Number(m[1]) : 0;
  };
  return { input: pick('tokensIn'), output: pick('tokensOut'), cacheRead: pick('cacheReads'), cacheWrite: pick('cacheWrites') };
}

/** ToCodex（桌面端与 CLI）的任务记录：逐请求用量，按消息时间戳聚合。 */
function collectTocodex(tasksDirs, seen, buckets, log) {
  for (const dir of tasksDirs) {
    let tasks;
    try { tasks = readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of tasks) {
      if (!entry.isDirectory()) continue;
      const file = join(dir, entry.name, 'ui_messages.json');
      if (!isFile(file)) continue;
      try {
        const messages = JSON.parse(readFileSync(file, 'utf8'));
        if (!Array.isArray(messages)) continue;
        for (const message of messages) {
          if (message?.say !== 'api_req_started') continue;
          const usage = parseClineUsage(message.text);
          if (!usage || usage.input + usage.output + usage.cacheRead + usage.cacheWrite <= 0) continue;
          const ts = Number(message.ts);
          if (!Number.isFinite(ts) || ts <= 0) continue;
          const key = `tc:${dir}:${entry.name}:${ts}`;
          if (seen.has(key)) continue;
          seen.add(key);
          const day = beijingDayOf(ts);
          let bucket = buckets.get(day);
          if (!bucket) { bucket = emptyBucket(day); buckets.set(day, bucket); }
          addTo(bucket, { ...usage, requests: 1, tool: TOOL_NAMES.tocodex });
        }
      } catch (err) {
        log(`tocodex 任务 ${entry.name} 解析失败，已跳过：${err?.message || err}`);
      }
    }
  }
}

/** Program Files 在逐盘遍历里被跳过，ToCodex 的便携安装（data/user-data）在这里按盘补查。 */
function scanProgramFiles(drives, tocodex) {
  for (const root of drives) {
    for (const candidate of [join(root, 'Program Files', 'ToCodex'), join(root, 'Program Files (x86)', 'ToCodex')]) {
      const found = tocodexTasksIn(candidate);
      if (found) tocodex.add(found);
    }
  }
}

/** 汇总所有磁盘上的 WorkBuddy 各版本、DevEco Code、Genspark Code 与 ToCodex，产出与上报协议同构的日行。 */
export function collectExtraDays({ home = homedir(), env = process.env, platform = process.platform,
  drives = null, log = () => {} } = {}) {
  const workbuddy = new Set(), deveco = new Set(), gencode = new Set(), tocodex = new Set();
  const found = drives || discoverDrives({ platform });
  scanDrives(found, { workbuddy, deveco, gencode, tocodex });
  scanKnownLocations({ home, env }, { workbuddy, deveco, gencode, tocodex });
  if (platform === 'win32') scanProgramFiles(found, tocodex);
  const upstream = [...upstreamWorkbuddyRoots(home)];
  const buckets = new Map(), seen = new Set();
  for (const root of new Set([...workbuddy].map(canonical))) {
    if (upstream.some(base => root === base || root.startsWith(base + sep))) continue;
    collectWorkbuddy(root, seen, buckets, log);
  }
  for (const path of new Set([...deveco].map(canonical))) collectOpencodeDb(path, 'deveco', seen, buckets, log);
  for (const path of new Set([...gencode].map(canonical))) collectOpencodeDb(path, 'gencode', seen, buckets, log);
  collectTocodex([...new Set([...tocodex].map(canonical))], seen, buckets, log);
  return [...buckets.values()].sort((a, b) => a.day.localeCompare(b.day)).map((bucket) => ({
    day: bucket.day, tokens: bucket.tokens, input_tokens: bucket.input_tokens, output_tokens: bucket.output_tokens,
    cache_read: bucket.cache_read, cache_write: bucket.cache_write, requests: bucket.requests,
    models: topEntries(bucket.models, 8), tools: topEntries(bucket.tools, 8),
    tool_models: [...bucket.toolModels.entries()].sort((a, b) => b[1] - a[1])
      .slice(0, 128).map(([key, tokens]) => { const [tool, model] = key.split('\u0000'); return [tool, model, tokens]; }),
  }));
}
