/**
 * credits（积分）计费工具（Qoder 等）的校验与汇总，模式仿 costs.js：
 * day.credits 可选、落库为 daily_totals.credits_json、读取侧聚合时逐行复验。
 * 与 cost 的差异：单位是积分（REAL，非整数微美元），按工具维度。
 */
const MAX_CREDITS = 1e9;
const EPSILON = 1e-6;

export function validateCredits(credits) {
  if (credits == null) return;
  if (typeof credits !== 'object' || Array.isArray(credits)
    || Object.keys(credits).some(k => !['total', 'tools'].includes(k))) throw new Error('invalid credits');
  if (!Number.isFinite(credits.total) || credits.total < 0 || credits.total > MAX_CREDITS) throw new Error('invalid credits total');
  if (credits.tools === undefined) return;
  if (!Array.isArray(credits.tools) || credits.tools.length > 8) throw new Error('invalid credits tools');
  const names = new Set(); let total = 0;
  for (const pair of credits.tools) {
    if (!Array.isArray(pair) || pair.length !== 2 || typeof pair[0] !== 'string' || !pair[0] || pair[0].length > 60 || names.has(pair[0])
      || !Number.isFinite(pair[1]) || pair[1] < 0 || pair[1] > credits.total) throw new Error('invalid credits tool');
    names.add(pair[0]); total += pair[1];
  }
  if (total > credits.total + EPSILON) throw new Error('invalid credits tools total');
}

/** rows: [{credits_json, ...}] → { status, total, tools:[[name,amount]] }，status: unavailable/partial/complete */
export function buildCredits(rows) {
  let total = 0, missing = 0;
  const tools = new Map();
  for (const row of rows) {
    let credits = null;
    try { credits = JSON.parse(row.credits_json || 'null'); validateCredits(credits); } catch { credits = null; }
    if (!credits) { missing++; continue; }
    total += credits.total;
    for (const [name, amount] of credits.tools || []) tools.set(name, (tools.get(name) || 0) + amount);
  }
  if (!rows.length || missing === rows.length) return { status: 'unavailable', total: 0, tools: [] };
  const sorted = [...tools.entries()].filter(([, amount]) => amount > EPSILON).sort((a, b) => b[1] - a[1]).slice(0, 8);
  const rounded = Math.round(total * 1e6) / 1e6;
  return { status: missing ? 'partial' : 'complete', total: rounded, tools: sorted.map(([name, amount]) => [name, Math.round(amount * 1e6) / 1e6]) };
}
