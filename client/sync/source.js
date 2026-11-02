import { DatabaseSync } from 'node:sqlite';
import { existsSync, statSync } from 'node:fs';
import { DEFAULT_DB } from './config.js';
const REQUIRED = ['ts', 'tool', 'model', 'total_tokens', 'input_tokens', 'output_tokens', 'cached_input', 'cache_write'];
const MAX = { tokens: 1e13, input_tokens: 1e13, output_tokens: 1e13, requests: 1e7, cache_read: 1e13, cache_write: 1e13 };

export function openSource(path = DEFAULT_DB) {
  if (!existsSync(path) || !statSync(path).isFile()) throw new Error('未找到 token-watcher 统计库。请运行小程序中的接入命令自动准备原版并完成采集；自定义路径可用 --db 指定。');
  let db;
  try {
    db = new DatabaseSync(path, { readOnly: true });
    db.exec('PRAGMA query_only = ON');
    db.exec('PRAGMA busy_timeout = 5000');
    db.function('report_name', { deterministic: true }, value => String(value || '').slice(0, 60));
    const columns = db.prepare('PRAGMA table_info(events)').all();
    const missing = REQUIRED.filter(key => !columns.some(c => c.name === key));
    if (missing.length) throw new Error(`统计库结构不兼容，缺少 ${missing.join(', ')}；未修改原库，请更新适配器`);
    return db;
  } catch (err) {
    db?.close();
    throw new Error(`无法只读打开 token-watcher 数据：${err.message}`);
  }
}

/** credits（积分）计费源（Qoder 等）：老版本 token-watcher 没有该表，返回 null 优雅降级。 */
function readCreditsMap(db, from, now) {
  const table = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='credit_usage'").get();
  if (!table) return null;
  const round6 = value => Math.round(value * 1e6) / 1e6;
  const totals = db.prepare(`SELECT CAST((ts + 28800000) / 86400000 AS INTEGER) AS daynum, SUM(amount) AS total
    FROM credit_usage WHERE ts >= ? AND ts <= ? GROUP BY daynum`).all(from, now);
  const map = new Map();
  for (const r of totals) {
    if (!Number.isFinite(r.total) || r.total < 0 || r.total > 1e9) {
      const day = new Date(r.daynum * 86400000).toISOString().slice(0, 10);
      throw new Error(`${day} 的 credits 超出上报协议范围；已停止同步，不截断或改写原始数据`);
    }
    if (r.total > 0) map.set(r.daynum, { total: round6(r.total), tools: [] });
  }
  const byTool = db.prepare(`SELECT CAST((ts + 28800000) / 86400000 AS INTEGER) AS daynum,
    report_name(tool) AS name, SUM(amount) AS amount FROM credit_usage
    WHERE ts >= ? AND ts <= ? AND tool IS NOT NULL AND tool != ''
    GROUP BY daynum, name ORDER BY daynum, amount DESC, name ASC`).all(from, now);
  for (const r of byTool) {
    const entry = map.get(r.daynum);
    if (!entry || !Number.isFinite(r.amount) || r.amount <= 0) continue;
    if (entry.tools.length < 8) entry.tools.push([String(r.name).slice(0, 60), round6(r.amount)]);
  }
  for (const entry of map.values()) {
    // 四舍五入可能让分项之和略超总额，钳回边界，与服务端 1e-6 容差对齐
    let sum = entry.tools.reduce((n, [, amount]) => n + amount, 0);
    if (sum > entry.total && entry.tools.length) entry.tools.at(-1)[1] = round6(Math.max(0, entry.tools.at(-1)[1] - (sum - entry.total)));
  }
  return map;
}

/** All SELECTs share one snapshot, including committed WAL records. No upstream Store or scanner is loaded. */
export function readDays(path, { now = Date.now(), fromDay = null, costing = null, log = null } = {}) {
  const db = openSource(path);
  try {
    db.exec('BEGIN');
    const from = fromDay ? Date.parse(fromDay + 'T00:00:00+08:00') : 0;
    const rows = db.prepare(`SELECT CAST((ts + 28800000) / 86400000 AS INTEGER) AS daynum,
      SUM(total_tokens) AS tokens, SUM(input_tokens) AS input_tokens, SUM(output_tokens) AS output_tokens, SUM(cached_input) AS cache_read,
      SUM(cache_write) AS cache_write, COUNT(*) AS requests
      FROM events WHERE ts >= ? AND ts <= ? GROUP BY daynum ORDER BY daynum`).all(from, now);
    const grouped = key => db.prepare(`SELECT CAST((ts + 28800000) / 86400000 AS INTEGER) AS daynum,
      report_name(${key}) AS name, SUM(total_tokens) AS tokens FROM events
      WHERE ts >= ? AND ts <= ? AND ${key} IS NOT NULL AND ${key} != ''
      GROUP BY daynum, name ORDER BY daynum, tokens DESC, name ASC`).all(from, now);
    const models = grouped('model'), tools = grouped('tool');
    const associations = db.prepare(`SELECT CAST((ts + 28800000) / 86400000 AS INTEGER) AS daynum,
      report_name(tool) AS tool_name, report_name(model) AS model_name, SUM(total_tokens) AS tokens
      FROM events WHERE ts >= ? AND ts <= ? AND tool IS NOT NULL AND tool != '' AND model IS NOT NULL AND model != ''
      GROUP BY daynum,tool_name,model_name ORDER BY daynum,tokens DESC,tool_name,model_name`).all(from, now);
    const toolModels = new Map();
    for (const row of associations) {
      if (!toolModels.has(row.daynum)) toolModels.set(row.daynum, []);
      const items = toolModels.get(row.daynum);
      if (items.length < 128 && row.tokens > 0) items.push([row.tool_name, row.model_name, row.tokens]);
    }
    const detailMap = list => {
      const map = new Map();
      for (const r of list) {
        const items = map.get(r.daynum) || [];
        if (items.length < 8 && r.tokens > 0) items.push([String(r.name).slice(0, 60), r.tokens]);
        map.set(r.daynum, items);
      }
      return map;
    };
    const modelMap = detailMap(models), toolMap = detailMap(tools);
    const costs = costing ? costing(db, from, now) : null;
    const creditsMap = readCreditsMap(db, from, now);
    // Qoder 等纯 credits 工具不产生 events 行，日桶取两者并集
    const daynums = new Set([...rows.map(row => row.daynum), ...(creditsMap ? [...creditsMap.keys()] : [])]);
    const rowMap = new Map(rows.map(row => [row.daynum, row]));
    // 上游原始日志可能有脏数据（负值/超协议上限）：跳过该日并告警，好数据照常上报，数字本身不改写
    const days = [], skipped = [];
    for (const daynum of [...daynums].sort((a, b) => a - b)) {
      const row = rowMap.get(daynum) || { tokens: 0, input_tokens: 0, output_tokens: 0, requests: 0, cache_read: 0, cache_write: 0 };
      const day = new Date(daynum * 86400000).toISOString().slice(0, 10);
      const bad = Object.entries(MAX).filter(([key, max]) => !Number.isFinite(row[key]) || row[key] < -1 || row[key] > max);
      if (bad.length) {
        skipped.push(`${day}（${bad.map(([key]) => `${key}=${row[key]}`).join('、')}）`);
        continue;
      }
      const norm = key => (Number.isSafeInteger(row[key]) ? row[key] : Math.max(0, Math.round(row[key])));
      days.push({ day, tokens: norm('tokens'), input_tokens: norm('input_tokens'), output_tokens: norm('output_tokens'), requests: norm('requests'), cache_read: norm('cache_read'), cache_write: norm('cache_write'),
        models: modelMap.get(daynum) || [], tools: toolMap.get(daynum) || [],
        tool_models: toolModels.get(daynum) || [],
        ...(costs?.has(daynum) ? { cost: costs.get(daynum) } : {}),
        ...(creditsMap?.has(daynum) ? { credits: creditsMap.get(daynum) } : {}) });
    }
    if (skipped.length) log?.(`警告：${skipped.length} 天的统计数字超出上报协议范围，已跳过不上传（原始数据未改动）：${skipped.join('；')}`);
    // 网关口径诊断（每次同步最多一行）：Qoder 等网关只在 usage.credits 落真实消耗，token 四项恒 0
    // 且 model 是网关别名（如 qfmodel/dfmodel）而非用户可见模型名——模型维度对这部分天数没有数据可归，
    // 不是采集或上报链路故障；要按模型拆分需平台侧提供用量接口（同 docs/oort-collection.md 的 OortOffice 结论）。
    const creditsOnly = days.filter(day => Number(day.credits?.total) > 0 && day.tokens === 0 && !day.models.length);
    if (creditsOnly.length) {
      log?.(`口径提示：${creditsOnly.length} 天只有 credits（tokens=0 且无模型明细，多为 Qoder 等网关不下发真实计数），模型维度对这部分无数据`);
    }
    db.exec('COMMIT');
    return days;
  } finally { db.close(); }
}

export function readLegacySettings(path) {
  const db = openSource(path);
  try {
    const table = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='settings'").get();
    if (!table) return {};
    const result = {};
    for (const key of ['rank.url', 'rank.token', 'rank.device_id']) {
      const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
      if (row) { try { result[key] = JSON.parse(row.value); } catch {} }
    }
    return result;
  } finally { db.close(); }
}
