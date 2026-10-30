/**
 * credits（积分）的校验与汇总，模式仿 costs.js：
 * day.credits 可选、落库为 daily_totals.credits_json、读取侧聚合时逐行复验。
 * 维度：total 为当日总额；tools 按工具、models 按模型、tool_models 按工具×模型。
 * 三个分项都是可选的（旧客户端只报 tools），任一分项之和不得超过 total。
 */
const MAX_CREDITS = 1e9;
const EPSILON = 1e-6;
const MAX_NAME = 60;
const LIMITS = { tools: 8, models: 8, tool_models: 128 };
// 复合分项的键分隔符：工具名与模型名都不含该字符
const SEP = String.fromCharCode(31);
const round6 = (value) => Math.round(value * 1e6) / 1e6;

/** 校验 [[name…, amount]] 分项：条数上限、名称合法、不重复、金额非负、合计不超 total。 */
function checkList(list, field, total, arity) {
  if (list === undefined) return null;
  if (!Array.isArray(list) || list.length > LIMITS[field]) throw new Error('invalid credits ' + field);
  const detail = new Map();
  for (const row of list) {
    if (!Array.isArray(row) || row.length !== arity) throw new Error('invalid credits ' + field);
    const names = row.slice(0, arity - 1), amount = row[arity - 1];
    if (names.some((n) => typeof n !== 'string' || !n || n.length > MAX_NAME)) throw new Error('invalid credits ' + field);
    if (!Number.isFinite(amount) || amount < 0 || amount > total) throw new Error('invalid credits ' + field);
    const key = names.join(SEP);
    if (detail.has(key)) throw new Error('duplicate credits ' + field);
    detail.set(key, amount);
  }
  if ([...detail.values()].reduce((sum, amount) => sum + amount, 0) > total + EPSILON) {
    throw new Error('invalid credits ' + field + ' total');
  }
  return detail;
}

/** 工具×模型的边际合计不得超过对应一维分项；缺哪一维就跳过哪一侧，不做猜测。 */
function checkMargins(rows, index, detail) {
  if (!detail) return;
  const byName = new Map();
  for (const row of rows) byName.set(row[index], (byName.get(row[index]) || 0) + row[2]);
  for (const [name, amount] of byName) {
    if (amount > (detail.get(name) || 0) + EPSILON) throw new Error('invalid credits tool_models margin');
  }
}

export function validateCredits(credits) {
  if (credits == null) return;
  if (typeof credits !== 'object' || Array.isArray(credits)
    || Object.keys(credits).some(k => !['total', 'tools', 'models', 'tool_models'].includes(k))) throw new Error('invalid credits');
  if (!Number.isFinite(credits.total) || credits.total < 0 || credits.total > MAX_CREDITS) throw new Error('invalid credits total');
  const tools = checkList(credits.tools, 'tools', credits.total, 2);
  const models = checkList(credits.models, 'models', credits.total, 2);
  const pairs = checkList(credits.tool_models, 'tool_models', credits.total, 3);
  if (!pairs) return;
  checkMargins(credits.tool_models, 0, tools);
  checkMargins(credits.tool_models, 1, models);
}

const topList = (map, limit) => [...map.entries()].filter(([, amount]) => amount > EPSILON)
  .sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0]))).slice(0, limit);

function addAll(target, rows) {
  if (!rows) return;
  for (const row of rows) {
    const key = row.slice(0, -1).join(SEP);
    target.set(key, (target.get(key) || 0) + row[row.length - 1]);
  }
}

/** rows: [{credits_json, …}] → { status, total, tools, models?, tool_models? }；status 为 unavailable/partial/complete。 */
export function buildCredits(rows) {
  let total = 0, missing = 0;
  const tools = new Map(), models = new Map(), pairs = new Map();
  for (const row of rows) {
    let credits = null;
    try { credits = JSON.parse(row.credits_json || 'null'); validateCredits(credits); } catch { credits = null; }
    if (!credits) { missing++; continue; }
    total += credits.total;
    addAll(tools, credits.tools);
    addAll(models, credits.models);
    addAll(pairs, credits.tool_models);
  }
  if (!rows.length || missing === rows.length) return { status: 'unavailable', total: 0, tools: [] };
  const list = (map, limit) => topList(map, limit)
    .map(([key, amount]) => [...key.split(SEP), round6(amount)]);
  const out = { status: missing ? 'partial' : 'complete', total: round6(total), tools: list(tools, 8) };
  const modelList = list(models, 8);
  if (modelList.length) out.models = modelList;
  const pairList = list(pairs, 128);
  if (pairList.length) out.tool_models = pairList;
  return out;
}
