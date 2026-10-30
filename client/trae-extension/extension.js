// extension.js —— Trae Credits POC v0.0.7（只读查询 + 本地快照输出；遵守 trae-credits-agent-test.md 安全边界）
// v0.0.2 修复：credits 字段映射 credits_float（修正 credits=0 根因）
// v0.0.3 增强：模型分类映射 + 全量行 + token 汇总
// v0.0.4 增强：30 天窗口；缺失 model 行诊断；大小写精确匹配优先
// v0.0.5 修正：分类以"计费事实"为准 —— credits_float>0 即 Trae credits 计费（preset 官方模型）；
//              credits_float==0 才可能是自定义模型（BYOK 不计 credits，用量走 /api/ide/v1/report_custom_model_token_usage）。
// v0.0.7 上报：每次查询后把按天聚合（token 维度 + credits）写入 ~/.trae-cn/credits-usage.json
//          （schema 1，供 tokenrank 客户端 trae 采集器只读消费）；运行期间每 6 小时自动刷新。
//          自定义模型（BYOK）不计 credits，统计口径 = token 维度（custom_* 字段单列）。
// 安全声明：只读查询（≤3 页、页间隔 ≥2s）；快照仅含按天聚合数字，不含 session_id、提示词、对话内容；
//          不打印 token；不读取加密库；不上传任何数据（上传由 tokenrank 客户端独立完成）。
const vscode = require('vscode');
const { createHash } = require('crypto');
const { writeFileSync, readFileSync, existsSync, unlinkSync } = require('fs');
const { tmpdir, homedir } = require('os');
const { join } = require('path');

const ENDPOINT = 'https://api.trae.cn/trae/api/v1/pay/query_user_usage_group_by_session';
const SESSION_USAGE = 'https://api.trae.cn/api/v1/commercial/get_session_usage';
const SESSFILE = join(tmpdir(), 'trae-credits-poc-sessions.json');
const REPORT = join(tmpdir(), 'trae-credits-poc-report.json');
const TRIGGER = join(tmpdir(), 'trae-credits-poc.trigger');
const MARKER = join(tmpdir(), 'trae-credits-poc.autorun');
const MODELMAP = join(tmpdir(), 'trae-credits-poc-models.json');
const SNAPSHOT = join(homedir(), '.trae-cn', 'credits-usage.json');
const SNAPSHOT_SCHEMA = 1;
const REFRESH_MS = 6 * 3600 * 1000;   // 运行期间每 6 小时自动刷新快照
const round6 = v => Math.round(v * 1e6) / 1e6;
const PAGE_SIZE = 50;
const MAX_PAGES = 3;
const PAGE_GAP_MS = 2000;
const WINDOW_DAYS = 30;

const hash8 = s => createHash('sha256').update(String(s == null ? '' : s)).digest('hex').slice(0, 8);
const numOf = (v, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const bjDay = e => new Date((Number(e) + 8 * 3600) * 1000).toISOString().slice(0, 10);

function loadModelMap() {
  try {
    if (!existsSync(MODELMAP)) return { exact: {}, lower: {} };
    const j = JSON.parse(readFileSync(MODELMAP, 'utf8'));
    return { exact: j.exact || {}, lower: j.lower || j.map || {} };
  } catch { return { exact: {}, lower: {} }; }
}

function safeExtra(v) {
  if (!v || typeof v !== 'object') return undefined;
  const out = {};
  for (const [k, val] of Object.entries(v)) {
    if (typeof val === 'number' || typeof val === 'boolean') out[k] = val;
    else if (typeof val === 'string' && val.length <= 80) out[k] = val;
  }
  return Object.keys(out).length ? out : undefined;
}

// 诊断用：保留数值/布尔/超短字符串/数组长度，跳过任何长文本（可能是提示词）
function safeShape(v, depth = 0) {
  if (v == null) return v;
  if (typeof v === 'number' || typeof v === 'boolean') return v;
  if (typeof v === 'string') return v.length <= 40 ? v : `<string len=${v.length}>`;
  if (Array.isArray(v)) return { __array_len: v.length, first: depth < 1 ? safeShape(v[0], depth + 1) : undefined };
  if (typeof v === 'object') {
    const o = {};
    for (const [k, val] of Object.entries(v)) o[k] = safeShape(val, depth + 1);
    return o;
  }
  return String(v);
}

function classify(name, maps, credits) {
  let byName = 'unknown';
  if (name) {
    if (maps.exact[name]) byName = maps.exact[name];
    else {
      const l = name.toLowerCase();
      if (maps.lower[l]) byName = maps.lower[l];
      else {
        const base = l.includes('//') ? l.split('//').pop() : l;
        byName = maps.lower[base] || (l.includes('//') ? 'custom' : 'unknown');
      }
    }
  }
  // 计费事实优先：credits>0 一定走了 Trae credits 计费（官方预置模型或其路由结果）
  if (credits > 0) {
    if (byName === 'custom') return 'preset';     // 计费与 BYOK 矛盾 → 以计费为准
    return byName === 'unknown' ? 'preset(model_name 缺失)' : byName;
  }
  return byName;
}

// 定点会话探针：对 %TEMP%\trae-credits-poc-sessions.json 中列出的会话做单会话用量查询（最多 3 个、间隔 ≥2s）
async function probeSessions(token, out, report) {
  if (!existsSync(SESSFILE)) return;
  let cfg;
  try { cfg = JSON.parse(readFileSync(SESSFILE, 'utf8')); } catch { return; }
  const list = (Array.isArray(cfg.sessions) ? cfg.sessions : []).slice(0, 3);
  if (!list.length) return;
  report.session_probe = [];
  for (const s of list) {
    await new Promise(r => setTimeout(r, PAGE_GAP_MS));
    let status = null, code = null, first = null, keys = null, err = null;
    try {
      const r = await fetch(SESSION_USAGE, {
        method: 'POST',
        headers: { authorization: 'Cloud-IDE-JWT ' + token, 'content-type': 'application/json' },
        body: JSON.stringify({ session_id: s.id }),
        signal: AbortSignal.timeout(20000),
      });
      status = r.status;
      const text = await r.text();
      let d = null;
      try { d = JSON.parse(text); } catch {}
      code = d && d.code !== undefined ? d.code : null;
      const data = d && d.data ? d.data : d;
      const grp = data && (data.user_usage_group_by_session || data.user_usage_group_by_sessions);
      first = Array.isArray(grp) ? grp[0] : (grp && typeof grp === 'object' ? grp : null);
      keys = first ? Object.keys(first).slice(0, 12) : (data && typeof data === 'object' ? Object.keys(data).slice(0, 12) : null);
    } catch (e) { err = String(e && e.message || e).slice(0, 120); }
    const rec = {
      label: s.label || undefined,
      status, code,
      credits_float: first && typeof first.credits_float === 'number' ? first.credits_float : null,
      model_name: first && typeof first.model_name === 'string' ? first.model_name : null,
      has_record: !!first,
      keys: keys || undefined,
      error: err || undefined,
    };
    report.session_probe.push(rec);
    out.appendLine('    [probe] ' + JSON.stringify(rec));
  }
}

async function queryUsage(out, report) {
  out.appendLine('[1] executeCommand("icube.common.getToken") ...');
  let tok = null;
  try { tok = await vscode.commands.executeCommand('icube.common.getToken'); }
  catch (e) { out.appendLine('    抛错: ' + (e && e.message || e)); }
  if (!tok || !tok.token) {
    report.result = 'blocked';
    report.blocker = 'get_token_command_unavailable';
    return report;
  }
  out.appendLine('    可用 token_len=' + tok.token.length
    + ' expiredAt=' + (tok.expiredAt ? new Date(tok.expiredAt).toISOString() : 'n/a'));
  report.get_token = { ok: true, token_len: tok.token.length, expired_at: tok.expiredAt || null };

  const modelMap = loadModelMap();
  report.model_map_loaded = { exact: Object.keys(modelMap.exact).length, lower: Object.keys(modelMap.lower).length };

  const now = Math.floor(Date.now() / 1000);
  const rowsAll = [];
  let total = null;
  for (let page = 1; page <= MAX_PAGES; page++) {
    if (page > 1) await new Promise(r => setTimeout(r, PAGE_GAP_MS));
    const body = {
      start_time: now - WINDOW_DAYS * 86400, end_time: now,
      page_size: PAGE_SIZE, page_num: page, usage_type: [7],
    };
    out.appendLine('[2] POST page=' + page);
    const r = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { authorization: 'Cloud-IDE-JWT ' + tok.token, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20000),
    });
    const text = await r.text();
    let d = null;
    try { d = JSON.parse(text); } catch {}
    report.http_status = r.status;
    report.error_code = d && d.code !== undefined ? d.code : null;
    out.appendLine('    HTTP ' + r.status + ' code=' + report.error_code + ' topKeys=' + (d ? Object.keys(d).join(',') : '非JSON'));
    if (r.status !== 200 || !d) {
      report.result = 'blocked';
      report.blocker = r.status === 401 ? 'auth' : ('http_' + r.status);
      return report;
    }
    const rows = Array.isArray(d.user_usage_group_by_sessions) ? d.user_usage_group_by_sessions : [];
    total = typeof d.total === 'number' ? d.total : total;
    rowsAll.push(...rows);
    if (rows.length < PAGE_SIZE || rowsAll.length >= (total || 0)) break;
  }

  report.result = 'ok';
  report.endpoint = 'query_user_usage_group_by_session';
  report.total = total;
  report.sessions = rowsAll.length;
  report.fields_first_row = rowsAll.length ? Object.keys(rowsAll[0]) : [];

  const mapped = rowsAll.map(x => {
    const name = typeof x.model_name === 'string' && x.model_name ? x.model_name : undefined;
    const ex = safeExtra(x.extra_info);
    const row = {
      session: hash8(x.session_id),
      day: bjDay(x.usage_time),
      usage_time: x.usage_time,
      model: name,
      kind: classify(name, modelMap, numOf(x.credits_float)),
      billed: numOf(x.credits_float) > 0,
      credits: numOf(x.credits_float),
      amount: numOf(x.amount_float),
      dollar: numOf(x.dollar_float),
      cost_money: numOf(x.cost_money_float),
      input_token: ex ? numOf(ex.input_token) : undefined,
      output_token: ex ? numOf(ex.output_token) : undefined,
      cache_read_token: ex ? numOf(ex.cache_read_token) : undefined,
      cache_write_token: ex ? numOf(ex.cache_write_token) : undefined,
      usage_source: x.usage_source,
      mode: x.mode,
      use_max_mode: x.use_max_mode,
      group_details: Array.isArray(x.usage_group_details) ? x.usage_group_details.length : undefined,
      product_type_list: safeShape(x.product_type_list),
    };
    // model_name 缺失时补充诊断（不含任何文本内容）
    if (!name) {
      row.diag = {
        group_details_shape: safeShape(x.usage_group_details),
        extra_keys: ex ? Object.keys(ex) : undefined,
      };
    }
    return row;
  });

  const sum = (arr, f) => arr.reduce((a, x) => a + numOf(x[f]), 0);
  report.credits_total = sum(mapped, 'credits');
  report.amount_total = sum(mapped, 'amount');
  report.cost_money_total = sum(mapped, 'cost_money');
  report.tokens_total = {
    input: sum(mapped, 'input_token'),
    output: sum(mapped, 'output_token'),
    cache_read: sum(mapped, 'cache_read_token'),
    cache_write: sum(mapped, 'cache_write_token'),
  };

  report.by_kind = {};
  for (const k of new Set(mapped.map(x => x.kind))) {
    const arr = mapped.filter(x => x.kind === k);
    report.by_kind[k] = {
      sessions: arr.length,
      credits: sum(arr, 'credits'),
      amount: sum(arr, 'amount'),
      input_token: sum(arr, 'input_token'),
      output_token: sum(arr, 'output_token'),
    };
  }
  // 自定义模型候选：credits=0 的行（BYOK 不计 credits）；无该行说明窗口内无自定义模型计费记录
  report.custom_candidate_rows = mapped.filter(x => !x.billed).length;

  const byModel = {};
  for (const x of mapped) {
    const key = x.model || '(model_name 缺失)';
    if (!byModel[key]) byModel[key] = { kind: x.kind, sessions: 0, credits: 0, amount: 0, input_token: 0, output_token: 0 };
    byModel[key].sessions += 1;
    byModel[key].credits += x.credits;
    byModel[key].amount += x.amount;
    byModel[key].input_token += numOf(x.input_token);
    byModel[key].output_token += numOf(x.output_token);
  }
  report.by_model = byModel;

  const byDay = {};
  for (const x of mapped) {
    if (!byDay[x.day]) byDay[x.day] = { sessions: 0, credits: 0, custom_sessions: 0, custom_credits: 0, preset_credits: 0, unknown_credits: 0, input_token: 0, output_token: 0 };
    const d0 = byDay[x.day];
    d0.sessions += 1;
    d0.credits += x.credits;
    d0.input_token += numOf(x.input_token);
    d0.output_token += numOf(x.output_token);
    if (x.kind === 'custom') { d0.custom_sessions += 1; d0.custom_credits += x.credits; }
    if (x.billed) d0.preset_credits += x.credits;
  }
  report.by_day = byDay;

  report.rows_with_credits = mapped.filter(x => x.credits > 0).length;
  report.rows_with_amount = mapped.filter(x => x.amount > 0).length;
  report.rows = mapped; // 全量（已脱敏）

  // 按天快照（tokenrank 上报协议同构口径）：token 四分量 + credits + 自定义模型 token 单列
  writeSnapshot(mapped, report);

  // 定点会话探针（可选）：验证指定会话（如自定义模型会话）是否产生 credits 计费记录
  await probeSessions(tok.token, out, report);

  out.appendLine('    ✔ credits_total=' + report.credits_total.toFixed(4)
    + ' rows_with_credits=' + report.rows_with_credits + '/' + mapped.length);
  out.appendLine('    tokens=' + JSON.stringify(report.tokens_total));
  out.appendLine('    by_kind=' + JSON.stringify(report.by_kind));
  out.appendLine('    by_model=' + JSON.stringify(report.by_model));
  return report;
}

// 按天快照：供 tokenrank trae 采集器消费。
// 口径（与 usage 接口行语义一致）：
//   - token：extra_info 的 input/output/cache_read/cache_write（会话累计值，活跃会话随用量增长，
//     整行快照整体替换 + 服务端按天替换语义收敛，与 DSH 采集口径一致）；
//   - requests：当日出现的会话行数（即活跃会话数，非请求数）；
//   - credits：credits_float 合计（round6）；billed=credits>0 为预置模型计费；
//   - 自定义模型（BYOK）不计 credits，token 单列 custom_*；model 含 "//" 视为自定义。
function writeSnapshot(mapped, report) {
  const days = new Map();
  for (const x of mapped) {
    const d0 = days.get(x.day) || {
      day: x.day, input_tokens: 0, output_tokens: 0, cache_read: 0, cache_write: 0, tokens: 0,
      requests: 0, credits: 0, billed_sessions: 0, custom_sessions: 0,
      custom_input_tokens: 0, custom_output_tokens: 0, models: {},
    };
    const clamp = v => Math.max(0, Math.round(Number(v) || 0));
    d0.input_tokens += clamp(x.input_token);
    d0.output_tokens += clamp(x.output_token);
    d0.cache_read += clamp(x.cache_read_token);
    d0.cache_write += clamp(x.cache_write_token);
    d0.requests += 1;
    d0.credits = round6(d0.credits + (x.credits || 0));
    if (x.billed) d0.billed_sessions += 1; else d0.custom_sessions += 1;
    if (!x.billed) { d0.custom_input_tokens += clamp(x.input_token); d0.custom_output_tokens += clamp(x.output_token); }
    if (x.model) {
      const m = x.model.slice(0, 60);
      d0.models[m] = (d0.models[m] || 0) + clamp(x.input_token) + clamp(x.output_token) + clamp(x.cache_read_token) + clamp(x.cache_write_token);
    }
    d0.tokens = d0.input_tokens + d0.output_tokens + d0.cache_read + d0.cache_write;
    days.set(x.day, d0);
  }
  const snapshot = {
    schema: SNAPSHOT_SCHEMA,
    generated_at: new Date().toISOString(),
    window_days: WINDOW_DAYS,
    days: [...days.values()].sort((a, b) => a.day.localeCompare(b.day)).map(d => ({
      ...d,
      credits: round6(d.credits),
      models: Object.entries(d.models).sort((a, b) => b[1] - a[1]).slice(0, 8),
    })),
  };
  try {
    writeFileSync(SNAPSHOT, JSON.stringify(snapshot, null, 2));
    report.snapshot = { path: SNAPSHOT, days: snapshot.days.length };
    if (outCh) outCh.appendLine('    快照: ' + SNAPSHOT + '（' + snapshot.days.length + ' 天）');
  } catch (e) {
    report.snapshot = { path: SNAPSHOT, error: String(e && e.message || e).slice(0, 120) };
    if (outCh) outCh.appendLine('    快照写入失败: ' + report.snapshot.error);
  }
}

function writeReport(out, report) {
  try { writeFileSync(REPORT, JSON.stringify(report, null, 2)); out.appendLine('报告: ' + REPORT); }
  catch (e) { out.appendLine('报告写入失败: ' + (e && e.message || e)); }
}

let outCh = null;
let running = false;

async function runOnce(reason) {
  if (running) return;
  running = true;
  try {
    if (!outCh) outCh = vscode.window.createOutputChannel('Trae Credits POC');
    outCh.appendLine('\n===== ' + new Date().toISOString() + ' 触发: ' + reason + ' =====');
    const report = { tested_at: new Date().toISOString(), trigger: reason, trae_base: vscode.version };
    try { await queryUsage(outCh, report); }
    catch (e) { report.result = 'error'; report.error = String(e && e.message || e).slice(0, 200); outCh.appendLine('异常: ' + report.error); }
    writeReport(outCh, report);
  } finally { running = false; }
}

function activate(context) {
  outCh = vscode.window.createOutputChannel('Trae Credits POC');
  context.subscriptions.push(outCh);
  context.subscriptions.push(vscode.commands.registerCommand('trae-credits-poc.query', () => runOnce('command')));
  const timer = setInterval(() => {
    if (existsSync(TRIGGER)) { try { unlinkSync(TRIGGER); } catch {} runOnce('trigger-file'); }
  }, 2000);
  context.subscriptions.push({ dispose: () => clearInterval(timer) });
  // 运行期间定期刷新快照（每次 1~3 个只读请求，间隔 ≥2s），保证 tokenrank 上报的数据不过期
  const refresh = setInterval(() => runOnce('periodic'), REFRESH_MS);
  context.subscriptions.push({ dispose: () => clearInterval(refresh) });
  if (existsSync(MARKER)) { try { unlinkSync(MARKER); } catch {} setTimeout(() => runOnce('autorun'), 1500); }
  outCh.appendLine('[activate] Trae Credits POC v0.0.7 已激活（快照: ' + SNAPSHOT + '）');
}

function deactivate() {}
module.exports = { activate, deactivate };
