const { compact, formatTokens, formatCredits, integer } = require('./usage');

// The API's own rank identifies the current row, including ties and duplicate
// nicknames. Never infer identity from a name or avatar.
function presentEntry(entry, ownRank, metric) {
  const amount = compact(entry.tokens);
  const credits = Number(entry.credits) > 0 ? formatCredits(entry.credits) : '';
  const tokens_fmt = formatTokens(entry.tokens);
  // 另一维度补角：Token 榜补 Credits，Credits 榜补 tokens，让每行一次读齐两个口径
  const alt_view = metric === 'credits'
    ? (Number(entry.tokens) > 0 ? `${tokens_fmt} tokens` : '')
    : (credits ? `${credits} Credits` : '');
  return { ...entry, tokens_fmt, tokens_value: amount.value, tokens_unit: amount.unit,
    credits_view: metric === 'credits' ? formatCredits(entry.credits) : '', alt_view,
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
