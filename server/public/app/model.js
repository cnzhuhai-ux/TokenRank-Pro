/* Shared pure browser/Node helpers. No framework or platform dependencies. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.TokenRankModel = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const periods = [['day', '今日'], ['week', '近7天'], ['month', '近30天'], ['last_month', '上月']];
  const beijingDay = (now = Date.now()) => new Date(now + 8 * 3600000).toISOString().slice(0, 10);
  const shiftDay = (day, n) => new Date(Date.parse(day + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);
  const monday = day => shiftDay(day, -((new Date(day + 'T00:00:00Z').getUTCDay() + 6) % 7));
  const validDay = day => /^\d{4}-\d{2}-\d{2}$/.test(day || '') && Number.isFinite(Date.parse(day + 'T00:00:00Z')) && shiftDay(day, 0) === day;
  function parseRoute(hash) {
    const [path, query = ''] = String(hash || '').replace(/^#\/?/, '').split('?');
    const parts = path.split('/'), q = new URLSearchParams(query);
    let name = parts[0] || 'groups', id = '';
    if (!['groups', 'group', 'group-analysis', 'square', 'me', 'achievements', 'help', 'subscriptions', 'settings', 'email', 'reminders', 'share'].includes(name)) name = 'groups';
    if (['group', 'group-analysis'].includes(name)) {
      if (!/^[a-z0-9]+$/.test(parts[1] || '')) name = 'groups';
      else id = parts[1];
    }
    if (name === 'share') {
      if (!/^[a-f0-9]{24}$/.test(parts[1] || '')) name = 'groups';
      else id = parts[1];
    }
    const views = ['sum', 'daily', 'cal', 'trend', 'analysis', 'weekly', ...(name === 'me' ? ['ledger'] : [])];
    const view = views.includes(q.get('view')) ? q.get('view') : 'sum';
    const publicTrend = ['square', 'subscriptions'].includes(name) && view === 'trend';
    const allowedPeriods = publicTrend ? ['week', 'month', 'last_month'] : [...periods.map(p => p[0]), ...(name === 'me' ? ['all'] : [])];
    const period = allowedPeriods.includes(q.get('period')) ? q.get('period') : publicTrend ? 'week' : name === 'me' ? 'all' : 'day';
    return { name, id, period, metric: q.get('metric') === 'credits' ? 'credits' : 'tokens', view,
      dimension: q.get('dimension') === 'models' ? 'models' : 'tools',
      day: validDay(q.get('day')) ? q.get('day') : '',
      month: /^\d{4}-(0[1-9]|1[0-2])$/.test(q.get('month') || '') ? q.get('month') : '',
      week: validDay(q.get('week')) ? monday(q.get('week')) : '',
      family: q.get('family') || '', badge: q.get('badge') || '', tool: q.get('tool') || '',
      range: q.get('range') === 'month' ? 'month' : 'quarter', end: validDay(q.get('end')) ? q.get('end') : '',
      trendMetric: q.get('trendMetric') === 'tokens' ? 'tokens' : 'users',
      analysisView: ['share', 'trend', 'detail'].includes(q.get('analysisView')) ? q.get('analysisView') : 'share',
      analysisBasis: q.get('analysisBasis') === 'users' ? 'users' : 'tokens', category: q.get('category') || '' };
  }
  function routeHash(route) {
    const q = new URLSearchParams();
    for (const key of ['period', 'metric', 'view', 'dimension', 'day', 'month', 'week', 'family', 'badge', 'tool', 'range', 'end', 'trendMetric', 'analysisView', 'analysisBasis', 'category']) if (route[key]) q.set(key, route[key]);
    return '#/' + route.name + (route.id ? '/' + encodeURIComponent(route.id) : '') + (q.size ? '?' + q : '');
  }
  function parentRoute(route) {
    if (route.name === 'subscriptions') return route.view === 'trend' ? { name: 'square', view: 'sum', period: route.period } : { name: 'me', view: 'sum', period: 'all' };
    if (route.name === 'group-analysis') return { ...route, name: 'group' };
    if (route.name === 'group') return { name: 'groups', period: route.period };
    if (route.name === 'achievements') return route.family ? { name: 'achievements' } : { name: 'me' };
    if (route.name === 'me' && route.view !== 'sum') return { name: 'me', period: route.period };
    return { name: 'groups' };
  }
  function boardPath({ id = '', period = 'day', metric = 'tokens' } = {}, offset = 0, snapshot = '') {
    const q = new URLSearchParams({ scope: id ? 'group' : 'global', period });
    if (id) q.set('id', id);
    if (metric === 'credits') q.set('metric', metric);
    if (offset) { q.set('offset', offset); q.set('snapshot', snapshot); }
    return '/api/leaderboard?' + q;
  }
  function mergeBoard(previous, next) {
    if (!previous) return { ...next, entries: [...(next.entries || [])] };
    if (!next.snapshot || previous.snapshot !== next.snapshot) throw Object.assign(new Error('榜单已有更新，请刷新后继续查看'), { status: 409 });
    if (next.has_more && !(next.next_offset > previous.next_offset)) throw new Error('分页游标未前进，请刷新榜单');
    const seen = new Set((previous.entries || []).map(e => e.rank));
    return { ...next, entries: [...previous.entries, ...(next.entries || []).filter(e => !seen.has(e.rank))] };
  }
  function costView(cost) {
    const available = !!cost && cost.status !== 'unavailable' && Number.isSafeInteger(cost.usd_micros) && cost.usd_micros >= 0;
    const notes = [cost?.unpriced_count || cost?.unpriced_models?.length ? `${cost.unpriced_count || cost.unpriced_models.length} 个模型未计价` : '',
      cost?.missing_user_days ? `${cost.missing_user_days} 条成员日记录金额未同步` : cost?.missing_days ? `${cost.missing_days} 天金额未同步` : ''].filter(Boolean);
    return { available, amount: available ? '$' + (cost.usd_micros / 1e6).toFixed(4) : '暂无费用记录',
      label: cost?.status === 'partial' ? '已计价部分' : 'API 等值估算', note: notes.join(' · ') };
  }
  function heatmap(report) {
    if (Array.isArray(report.heatmap?.days)) return report.heatmap;
    const source = report.heatmap, extended = !!source?.daily?.length, raw = extended ? source.daily : report.daily || [];
    const from = extended ? source.from : report.month + '-01';
    const [year, month] = report.month.split('-').map(Number);
    const endMonth = new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
    const start = monday(from), end = extended ? source.end : shiftDay(monday(endMonth), 6);
    const to = extended ? source.to : endMonth;
    const byDay = new Map(raw.map(d => [d.day, d]));
    const max = Math.max(1, ...raw.filter(d => d.reported && !d.future && !d.outside).map(d => d.tokens || 0));
    const days = [];
    for (let day = start; day <= end; day = shiftDay(day, 1)) {
      const row = byDay.get(day) || {}, outside = day < from || day > to || !!row.outside;
      const future = !!row.future || day > report.today, reported = !outside && !future && !!row.reported;
      const tokens = reported ? row.tokens : null;
      days.push({ ...row, day, outside, future, reported, tokens,
        level: !reported || !tokens ? 0 : Math.min(4, Math.max(1, Math.ceil(tokens / max * 4))),
        statusText: outside ? '范围外' : future ? '未到日期' : !reported ? '未同步' : tokens === 0 ? '已同步 · 零用量' : '已同步' });
    }
    return { days, from, to, extended };
  }
  const stages = { requests: ['code-leaves', [100, 1000, 10000, 100000], 3], models: ['neural-core', [1, 3, 5, 10], 2],
    tools: ['linked-loops', [2, 3, 5, 8], 1], active: ['steady-flame', [3, 7, 30, 100], 2], uploads: ['upload-calendar', [3, 7, 30, 100], 2],
    peak: ['milestone-peaks', [1e8, 5e8, 1e9, 5e9], 3], total: ['usage-orbit', [1e8, 1e9, 1e10, 1e11], 3] };
  const arts = ['terminal', 'code-leaves', 'neural-core', 'linked-loops', 'build-modules', 'release-plane', 'value-bridge', 'impact-beacon', 'steady-flame', 'upload-calendar', 'milestone-peaks', 'usage-orbit'];
  function badgeArt(badge) {
    if (!arts.includes(badge?.art)) return '';
    const stage = stages[badge.family], index = stage?.[0] === badge.art ? stage[1].indexOf(badge.threshold) + 1 : 0;
    return '/app/assets/badges/' + (index && index !== stage[2] ? 'tiers/' + badge.art + '-' + index : badge.art) + '.png';
  }
  function consumeOAuthState(storage, returned) {
    const expected = storage.getItem('tr_oauth_state');
    storage.removeItem('tr_oauth_state');
    return typeof returned === 'string' && returned.length >= 16 && !!expected && returned === expected;
  }
  function oauthState(crypto) { return Array.from(crypto.getRandomValues(new Uint8Array(24)), b => b.toString(16).padStart(2, '0')).join(''); }
  function createCache({ request, account = () => '', now = () => Date.now(), ttl = 300000 } = {}) {
    const values = new Map(), pending = new Map(), latest = new Map();
    let epoch = 0, day = '', identity = '', order = 0;
    function clear() { epoch++; values.clear(); pending.clear(); latest.clear(); }
    function key(path) {
      const nextDay = beijingDay(now()), nextIdentity = account();
      if (nextDay !== day || nextIdentity !== identity) { clear(); day = nextDay; identity = nextIdentity; }
      const url = new URL(path, 'http://cache.local'); url.searchParams.sort();
      return identity + ':' + day + ':' + url.pathname + url.search;
    }
    function read(path, { force = false } = {}) {
      const k = key(path), cached = values.get(k);
      if (!force && cached && now() - cached.at < ttl && (!cached.value?.expires_at || cached.value.expires_at > now())) return Promise.resolve(cached.value);
      if (!force && pending.has(k)) return pending.get(k);
      const version = ++order, generation = epoch;
      latest.set(k, version);
      const task = Promise.resolve().then(() => request(path)).then(value => {
        const current = key(path);
        if (generation !== epoch || k !== current) throw Object.assign(new Error('账号或北京时间日期已变化，请重新加载'), { stale: true });
        if (latest.get(k) === version) {
          if (values.size >= 100 && !values.has(k)) values.delete(values.keys().next().value);
          values.set(k, { value, at: now() });
        } else throw Object.assign(new Error('已有更新的请求'), { stale: true });
        return value;
      }).finally(() => { if (pending.get(k) === task) pending.delete(k); });
      pending.set(k, task); return task;
    }
    return { read, clear };
  }
  function createGuard() { let version = 0; return { next: () => { const own = ++version; return () => own === version; }, invalidate: () => ++version }; }
  return { periods, beijingDay, shiftDay, monday, validDay, parseRoute, routeHash, parentRoute, boardPath, mergeBoard, costView, heatmap, badgeArt, consumeOAuthState, oauthState, createCache, createGuard };
});
