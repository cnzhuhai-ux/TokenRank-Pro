const { compact, formatTokens, integer } = require('./usage');

// Credits（Qoder 等按 Credits 计费工具）：固定两位小数，大数沿用紧凑格式
function formatCredits(value) {
  const v = Math.max(0, Number(value) || 0);
  if (v >= 1e4) return compact(Math.round(v)).value + (compact(Math.round(v)).unit || '');
  return v.toFixed(2);
}

// The API's own rank identifies the current row, including ties and duplicate
// nicknames. Never infer identity from a name or avatar.
function presentEntry(entry, ownRank, metric) {
  const amount = compact(entry.tokens);
  return { ...entry, tokens_fmt: formatTokens(entry.tokens), tokens_value: amount.value, tokens_unit: amount.unit,
    credits_view: metric === 'credits' && Number(entry.credits) > 0 ? formatCredits(entry.credits) : '',
    requests_text: integer(entry.requests), initial: [...String(entry.nickname || '').trim()][0] || '?',
    rk: { label: String(entry.rank), top3: entry.rank >= 1 && entry.rank <= 3 },
    isMe: ownRank != null && entry.rank === ownRank };
}
function presentEntries(entries, me, metric) {
  return entries.map(entry => presentEntry(entry, me?.rank, metric));
}
function presentMe(me, metric) {
  return me ? presentEntry(me, me.rank, metric) : null;
}
module.exports = { presentEntries, presentMe, formatCredits };
