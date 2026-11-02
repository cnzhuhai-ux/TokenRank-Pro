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
 *   - 独立 Cline / Roo Code：装在 VS Code 系变体（Code、Code - Insiders、Cursor、
 *     Windsurf、VSCodium）里的 claude-dev / roo-cline 扩展，格式与 ToCodex 相同；
 *     装在 OortCloud AI Studio 里的由 oort.js 采集，这里不扫该产品目录，不重复计。
 *   - Cline 桌面端 / CLI（%LOCALAPPDATA%\Cline 安装，数据在 ~/.cline）：逐会话
 *     messages.json 的 assistant 消息带 metrics {inputTokens, outputTokens,
 *     cacheReadTokens, cacheWriteTokens}（分离式，inputTokens 不含缓存）与
 *     modelInfo.id，按消息时间戳分日；与扩展记录分属不同文件，同展示名 Cline。
 *   - JoyCode：京东的 VS Code 分支，任务记录同样是 Cline 系格式
 *     （globalStorage/joycode.joycoder-editor/tasks），逐请求无模型名。
 *   - QoderWork：Claude Code 风格转录 ~/.qoderwork/projects 下的 jsonl，assistant
 *     消息 message.usage 为 Anthropic 四分量（input_tokens 不含缓存），带模型名；
 *     Qoder 代理网关不下发真实 token 的安装全为零值，自动跳过。Qoder（非 Work）
 *     由上游覆盖，不在这里采。
 *   - Kiro：AWS 的 AI IDE，本地只有点数没有 token——~/.kiro/sessions 逐会话
 *     messages.jsonl 的 usage_summary.promptTurnSummaries（unit=credit），并入日行
 *     的 credits 字段（{total, tools}），不占 token 四分量。
 *   - TeleAgent：OpenCode 分支（super-agent-code），库在
 *     ~/.local/share/TeleAgent/teleagent.db，message.data 与 OpenCode 同构（data
 *     列声明为 BLOB，读取时 CAST 成 TEXT）；未使用过的安装表为空，静默无数据。
 *   - CodeArts Agent：华为，OpenCode 分支，库在 ~/.codeartsdoer 各实例子目录的 opencode.db，
 *     同构解析；cost 恒为 0（内部 MaaS），仅入库 token。
 *
 * 明确不采的（本机逐一排查过，详见 docs/prompts/ 与 client/README）：
 *   - OpenCode 本体由上游 token-watcher 覆盖；散落的 opencode.db 不能抢。
 *   - Zed：threads.db 的 token 字段在真实样本中为空（zed.dev 云端计费），暂不采。
 *   - 豆包 / 豆包工作：用量在云端，本地只有编码 agent 的文件改动审计，无 token。
 *   - Kimi 桌面端：聊天与用量都在服务端；CLI（Kimi For Coding）由上游覆盖。
 *   - OortCodex XP Edition：会话 JSON 无 token 字段；主产品库已由 oort.js 采集。
 *   - CodeArtsSpace：内核同为 OpenCode，本机会话目录已被清空，待其重建后再评估。
 *   - Comfy：本地扩散模型推理无 token，API 节点与云端版用量均不落本地。
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

export const TOOL_NAMES = { workbuddy: 'WorkBuddy', deveco: 'DevEco Code', gencode: 'Genspark Code', tocodex: 'ToCodex',
  cline: 'Cline', roo: 'Roo Code', joycode: 'JoyCode', qoderwork: 'QoderWork', kiro: 'Kiro',
  teleagent: 'TeleAgent', codeartsAgent: 'CodeArts Agent' };

const MAX_DEPTH = 5;
const MAX = { tokens: 1e13, requests: 1e7 };
const WORKBUDDY_DIR = /^\.?workbuddy(?:[\s._-]?(?:ai|cn|intl|global))?$/i;
const DEVECO_DIR = /^(?:\.?deveco(?:[\s._-]?code)?|deveco[\s._-]?studio|huawei[\s._-]?deveco.*)$/i;
// gencode 的库只认 gencode 目录名；散落的 opencode.db 属于独立安装的 opencode（上游已覆盖），不能抢。
const GENCODE_DIR = /^\.?gencode$/i;
// ToCodex 的任务数据在扩展目录 tocodex.tocodex/tasks 下；产品目录名（ToCodex / ToCodex Desktop）用于定位安装位置。
const TOCODEX_EXT = 'tocodex.tocodex';
const TOCODEX_DIR = /^\.?tocodex(?:[\s._-]?desktop)?$/i;
// VS Code 系变体（含 JoyCode 分支）：globalStorage 下找 Cline / Roo / JoyCode / ToCodex 扩展的任务目录。
const VS_CODE_DIR = /^\.?(?:code(?:[ ._-]?(?:insiders|oss))?|cursor|windsurf|vscodium|joycode)$/i;
const CLINE_EXT = 'saoudrizwan.claude-dev';
const ROO_EXT = 'rooveterinaryinc.roo-cline';
const JOYCODE_EXT = 'joycode.joycoder-editor';
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
/** VS Code 系安装的扩展 tasks 目录：标准布局与便携模式（data/user-data 在安装目录内）。 */
function vsCodeTasksIn(base, ext) {
  for (const candidate of [join(base, 'User', 'globalStorage', ext, 'tasks'),
    join(base, 'data', 'user-data', 'User', 'globalStorage', ext, 'tasks')]) {
    if (isDirectory(candidate)) return candidate;
  }
  return null;
}
const tocodexTasksIn = (base) => vsCodeTasksIn(base, TOCODEX_EXT);

/** 逐盘有界遍历：只收集 WorkBuddy 数据目录、deveco.db、gencode、ToCodex 与 VS Code 系扩展 tasks 目录，不读文件内容。 */
function scanDrives(drives, { workbuddy, deveco, gencode, tocodex, cline, roo, joycode }) {
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
          if (VS_CODE_DIR.test(entry.name)) {
            const found = vsCodeTasksIn(path, CLINE_EXT);
            if (found) cline.add(found);
            const rooTasks = vsCodeTasksIn(path, ROO_EXT);
            if (rooTasks) roo.add(rooTasks);
            const joyTasks = vsCodeTasksIn(path, JOYCODE_EXT);
            if (joyTasks) joycode.add(joyTasks);
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
function scanKnownLocations({ home, env }, { workbuddy, deveco, gencode, tocodex, cline, roo, joycode, teleagent, codearts }) {
  const bases = [home, env.APPDATA, env.LOCALAPPDATA, env.XDG_DATA_HOME, env.XDG_CONFIG_HOME,
    join(home, 'AppData', 'Roaming'), join(home, 'AppData', 'Local'), join(home, '.local', 'share'),
    join(home, 'Library', 'Application Support')]
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
    for (const variant of ['Code', 'Code - Insiders', 'Code - OSS', 'Cursor', 'Windsurf', 'VSCodium', 'JoyCode']) {
      const clineTasks = vsCodeTasksIn(join(base, variant), CLINE_EXT);
      if (clineTasks) cline.add(clineTasks);
      const rooTasks = vsCodeTasksIn(join(base, variant), ROO_EXT);
      if (rooTasks) roo.add(rooTasks);
      const joyTasks = vsCodeTasksIn(join(base, variant), JOYCODE_EXT);
      if (joyTasks) joycode.add(joyTasks);
    }
    for (const candidate of [join(base, 'TeleAgent', 'teleagent.db')]) {
      if (isFile(candidate)) teleagent.add(candidate);
    }
  }
  // ToCodex CLI：shim 的 globalStorage 在 ~/.vscode-mock/global-storage，tasks 直接在其下（无扩展 id 子目录）。
  for (const candidate of [join(home, '.vscode-mock', 'global-storage', 'tasks'),
    join(home, '.vscode-mock', 'global-storage', TOCODEX_EXT, 'tasks')]) {
    if (isDirectory(candidate)) tocodex.add(candidate);
  }
  // CodeArts Agent：~/.codeartsdoer 下各实例的 OpenCode 同构库。
  const codeartsRoot = join(home, '.codeartsdoer');
  for (const candidate of [join(codeartsRoot, 'opencode.db')]) {
    if (isFile(candidate)) codearts.add(candidate);
  }
  let instances;
  try { instances = readdirSync(codeartsRoot, { withFileTypes: true }); } catch { instances = []; }
  for (const instance of instances) {
    const db = join(codeartsRoot, instance.name, 'opencode.db');
    if (instance.isDirectory() && isFile(db)) codearts.add(db);
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

/** OpenCode 同构库（DevEco/Genspark/TeleAgent/CodeArts Agent 等）：message.data.tokens。data 列可能是 BLOB，统一 CAST 成 TEXT 再解析。 */
function collectOpencodeDb(path, tool, seen, buckets, log) {
  let db;
  try {
    db = new DatabaseSync(path, { readOnly: true });
    db.exec('PRAGMA busy_timeout = 3000');
    const table = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='message'").get();
    if (!table) return;
    const field = (jsonPath) => `CASE WHEN json_valid(CAST(data AS TEXT)) THEN json_extract(CAST(data AS TEXT), '${jsonPath}') END`;
    const rows = db.prepare(`SELECT id, session_id, time_created,
      ${field('$.time.created')} AS created, ${field('$.role')} AS role,
      ${field('$.modelID')} AS model, CASE WHEN json_valid(CAST(data AS TEXT)) THEN json_type(CAST(data AS TEXT), '$.tokens') END AS tokens_type,
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

/** Cline 系任务记录（ToCodex / 独立 Cline / Roo Code / JoyCode）：逐请求用量，按消息时间戳聚合。 */
function collectClineTasks(tasksDirs, tool, seen, buckets, log) {
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
          const key = `cl:${tool}:${dir}:${entry.name}:${ts}`;
          if (seen.has(key)) continue;
          seen.add(key);
          const day = beijingDayOf(ts);
          let bucket = buckets.get(day);
          if (!bucket) { bucket = emptyBucket(day); buckets.set(day, bucket); }
          addTo(bucket, { ...usage, requests: 1, tool: TOOL_NAMES[tool] });
        }
      } catch (err) {
        log(`${tool} 任务 ${entry.name} 解析失败，已跳过：${err?.message || err}`);
      }
    }
  }
}

/** QoderWork 转录：Claude Code 风格，message.usage 为 Anthropic 四分量（input_tokens 不含缓存），带模型名。 */
function collectQoderwork(root, seen, buckets, log) {
  if (!isDirectory(root)) return;
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
          if (record?.type !== 'assistant' || !usage || typeof usage !== 'object' || !record.uuid) continue;
          const input = Number(usage.input_tokens) || 0;
          const output = Number(usage.output_tokens) || 0;
          const cacheRead = Number(usage.cache_read_input_tokens) || 0;
          const cacheWrite = Number(usage.cache_creation_input_tokens) || 0;
          if (input + output + cacheRead + cacheWrite <= 0) continue;
          const key = 'qw:' + record.uuid;
          if (seen.has(key)) continue;
          seen.add(key);
          const ts = Date.parse(record.timestamp || '');
          if (!Number.isFinite(ts)) continue;
          const model = String(record.message.model || '').trim().slice(0, 60);
          const day = beijingDayOf(ts);
          let bucket = buckets.get(day);
          if (!bucket) { bucket = emptyBucket(day); buckets.set(day, bucket); }
          addTo(bucket, { input, output, cacheRead, cacheWrite, requests: 1, tool: TOOL_NAMES.qoderwork, model });
        }
      } catch (err) {
        log(`qoderwork 转录 ${entry.name} 解析失败，已跳过：${err?.message || err}`);
      }
    }
  };
  walk(root);
}

/** Kiro 的点数（credits）：sessions 逐会话 messages.jsonl 的 usage_summary，不产生 token 四分量。 */
function collectKiroCredits(root, seen, buckets, log) {
  if (!isDirectory(root)) return;
  let workspaces;
  try { workspaces = readdirSync(root, { withFileTypes: true }); } catch { return; }
  for (const workspace of workspaces) {
    if (!workspace.isDirectory()) continue;
    const workspaceDir = join(root, workspace.name);
    let sessions;
    try { sessions = readdirSync(workspaceDir, { withFileTypes: true }); } catch { continue; }
    for (const session of sessions) {
      if (!session.isDirectory()) continue;
      const file = join(workspaceDir, session.name, 'messages.jsonl');
      if (!isFile(file)) continue;
      try {
        for (const line of readFileSync(file, 'utf8').split('\n')) {
          if (!line.includes('usage_summary')) continue;
          let record;
          try { record = JSON.parse(line); } catch { continue; }
          const payload = record?.payload;
          if (payload?.type !== 'usage_summary' || !Array.isArray(payload.promptTurnSummaries)) continue;
          const ts = Date.parse(record.timestamp || '');
          if (!Number.isFinite(ts)) continue;
          const key = 'kiro:' + (typeof record.id === 'string' && record.id ? record.id : `${session.name}:${ts}`);
          if (seen.has(key)) continue;
          let amount = 0;
          for (const turn of payload.promptTurnSummaries) {
            const value = Number(turn?.usage);
            if (Number.isFinite(value) && value > 0) amount += value;
          }
          if (amount <= 0) continue;
          seen.add(key);
          const day = beijingDayOf(ts);
          const bucket = buckets.get(day) || emptyBucket(day);
          if (!bucket.credits) bucket.credits = { total: 0, tools: new Map() };
          bucket.credits.total += amount;
          bucket.credits.tools.set(TOOL_NAMES.kiro, (bucket.credits.tools.get(TOOL_NAMES.kiro) || 0) + amount);
          buckets.set(day, bucket);
        }
      } catch (err) {
        log(`kiro 会话 ${session.name} 解析失败，已跳过：${err?.message || err}`);
      }
    }
  }
}

/** Cline 桌面端 / CLI 的会话记录（~/.cline/data/sessions）：assistant 消息 metrics 四分量 + modelInfo.id。 */
function collectClineDesktop(root, seen, buckets, log) {
  if (!isDirectory(root)) return;
  let sessions;
  try { sessions = readdirSync(root, { withFileTypes: true }); } catch { return; }
  for (const entry of sessions) {
    if (!entry.isDirectory()) continue;
    const file = join(root, entry.name, entry.name + '.messages.json');
    if (!isFile(file)) continue;
    try {
      const data = JSON.parse(readFileSync(file, 'utf8'));
      const messages = Array.isArray(data?.messages) ? data.messages : [];
      for (const message of messages) {
        const metrics = message?.metrics;
        if (!metrics || typeof metrics !== 'object') continue;
        const input = Number(metrics.inputTokens) || 0;
        const output = Number(metrics.outputTokens) || 0;
        const cacheRead = Number(metrics.cacheReadTokens) || 0;
        const cacheWrite = Number(metrics.cacheWriteTokens) || 0;
        if (input + output + cacheRead + cacheWrite <= 0) continue;
        const ts = Number(message.ts);
        if (!Number.isFinite(ts) || ts <= 0) continue;
        const key = `cd:${entry.name}:${typeof message.id === 'string' && message.id ? message.id : ts}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const model = String(message.modelInfo?.id || '').trim().slice(0, 60);
        const day = beijingDayOf(ts);
        let bucket = buckets.get(day);
        if (!bucket) { bucket = emptyBucket(day); buckets.set(day, bucket); }
        addTo(bucket, { input, output, cacheRead, cacheWrite, requests: 1, tool: TOOL_NAMES.cline, model });
      }
    } catch (err) {
      log(`cline 桌面会话 ${entry.name} 解析失败，已跳过：${err?.message || err}`);
    }
  }
}

// credits 上报口径：总额 round6，分项按量取前 8，分项之和钳回 ≤ 总额（与服务端 1e-6 容差对齐）。
const round6 = (v) => Math.round(v * 1e6) / 1e6;
function clampCredits(credits) {
  const total = round6(Math.max(0, credits.total));
  const tools = [...credits.tools].filter(([, v]) => v > 0)
    .sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])))
    .slice(0, 8).map(([name, v]) => [name, round6(v)]);
  const sum = tools.reduce((n, [, v]) => n + v, 0);
  if (sum > total && tools.length) tools.at(-1)[1] = round6(Math.max(0, tools.at(-1)[1] - (sum - total)));
  return { total, tools };
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

/** 汇总所有磁盘上的 WorkBuddy 各版本、DevEco Code、Genspark Code、ToCodex、独立 Cline/Roo/JoyCode、
 *  QoderWork、Kiro 点数、TeleAgent 与 CodeArts Agent，产出与上报协议同构的日行。 */
export function collectExtraDays({ home = homedir(), env = process.env, platform = process.platform,
  drives = null, log = () => {} } = {}) {
  const workbuddy = new Set(), deveco = new Set(), gencode = new Set(), tocodex = new Set();
  const cline = new Set(), roo = new Set(), joycode = new Set(), teleagent = new Set(), codearts = new Set();
  const found = drives || discoverDrives({ platform });
  scanDrives(found, { workbuddy, deveco, gencode, tocodex, cline, roo, joycode });
  scanKnownLocations({ home, env }, { workbuddy, deveco, gencode, tocodex, cline, roo, joycode, teleagent, codearts });
  if (platform === 'win32') scanProgramFiles(found, tocodex);
  const upstream = [...upstreamWorkbuddyRoots(home)];
  const buckets = new Map(), seen = new Set();
  for (const root of new Set([...workbuddy].map(canonical))) {
    if (upstream.some(base => root === base || root.startsWith(base + sep))) continue;
    collectWorkbuddy(root, seen, buckets, log);
  }
  for (const path of new Set([...deveco].map(canonical))) collectOpencodeDb(path, 'deveco', seen, buckets, log);
  for (const path of new Set([...gencode].map(canonical))) collectOpencodeDb(path, 'gencode', seen, buckets, log);
  collectClineTasks([...new Set([...tocodex].map(canonical))], 'tocodex', seen, buckets, log);
  collectClineTasks([...new Set([...cline].map(canonical))], 'cline', seen, buckets, log);
  collectClineTasks([...new Set([...roo].map(canonical))], 'roo', seen, buckets, log);
  collectClineTasks([...new Set([...joycode].map(canonical))], 'joycode', seen, buckets, log);
  collectClineDesktop(join(home, '.cline', 'data', 'sessions'), seen, buckets, log);
  for (const root of [join(home, '.qoderwork', 'projects'), join(home, '.qoderwork-cn', 'projects')]) {
    collectQoderwork(root, seen, buckets, log);
  }
  collectKiroCredits(join(home, '.kiro', 'sessions'), seen, buckets, log);
  for (const path of new Set([...teleagent].map(canonical))) collectOpencodeDb(path, 'teleagent', seen, buckets, log);
  for (const path of new Set([...codearts].map(canonical))) collectOpencodeDb(path, 'codeartsAgent', seen, buckets, log);
  return [...buckets.values()].sort((a, b) => a.day.localeCompare(b.day)).map((bucket) => ({
    day: bucket.day, tokens: bucket.tokens, input_tokens: bucket.input_tokens, output_tokens: bucket.output_tokens,
    cache_read: bucket.cache_read, cache_write: bucket.cache_write, requests: bucket.requests,
    models: topEntries(bucket.models, 8), tools: topEntries(bucket.tools, 8),
    tool_models: [...bucket.toolModels.entries()].sort((a, b) => b[1] - a[1])
      .slice(0, 128).map(([key, tokens]) => { const [tool, model] = key.split('\u0000'); return [tool, model, tokens]; }),
    ...(bucket.credits ? { credits: clampCredits(bucket.credits) } : {}),
  }));
}
