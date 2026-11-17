const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const flush = () => new Promise(resolve => setImmediate(resolve));
const tap = (key, value) => ({ currentTarget: { dataset: value === undefined ? { key } : { field: key, value } } });
const pick = value => ({ detail: { value: String(value) } });
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function analysisData(query = {}, tokens = 100) {
  return { scope: 'public', period: 'day', dimension: 'tools', ...query, from: '2026-11-16', to: '2026-11-16',
    summary: { tokens, requests: 2, users: 1, active_days: 1, breakdown_tokens: tokens },
    items: [{ key: 'tool:A', name: 'A', tokens, percent: 100, users: 1, preferred_users: 1, preferred_percent: 100 }],
    daily: [{ day: '2026-11-16', tokens, reported: true, parts: [{ name: 'A', tokens }] }], trend_days: 7,
    access: { feature: 'community_audience', mode: 'free' } };
}
function trendsData(query = {}, tokens = 100) {
  return { period: 'week', dimension: 'tools', metric: 'users', ...query, from: '2026-11-10', to: '2026-11-16',
    previous_from: '2026-11-03', previous_to: '2026-11-09', summary: { users: 1 }, previous_summary: { users: 1 },
    entries: [{ name: 'A', rank: 1, tokens, users: 1, previous_rank: 1, previous_users: 1, previous_tokens: 50, rank_change: 0 }],
    has_more: true, next_offset: 1, total: 2, snapshot: 'current' };
}
const rawFor = (name, query, tokens) => name === 'analysis' ? analysisData(query, tokens) : trendsData(query, tokens);
function fixture(name, overrides = {}, options = {}) {
  let definition, epoch = 0, state = '', stopped = 0;
  const navigation = [], patches = [], calls = [];
  const api = { accountEpoch: () => epoch, accountState: () => state, peekMe: () => null,
    fmtRelTime: () => '刚刚', ensureLogin: async () => ({ last_report_at: 1 }),
    [name]: async (query, options) => { calls.push({ query, options }); return rawFor(name, query); }, ...overrides };
  const wx = { showShareMenu() {}, hideShareMenu() {}, setNavigationBarTitle() {}, showToast() {}, pageScrollTo() {},
    navigateTo: ({ url }) => navigation.push(url), redirectTo: ({ url }) => navigation.push(url), stopPullDownRefresh: () => stopped++ };
  vm.runInNewContext(fs.readFileSync(path.join(root, `pages/${name}/${name}.js`), 'utf8'), {
    Page: value => definition = value, wx,
    require: id => id.endsWith('/api') ? api : require(path.join(root, 'utils', path.basename(id))),
  });
  const p = { ...definition, data: structuredClone(definition.data), setData(patch, callback) {
    patches.push(patch); Object.assign(this.data, patch); callback?.();
  } };
  p.onLoad(name === 'analysis' ? { scope: 'public', ...options } : options);
  return { p, api, calls, patches, navigation, stopped: () => stopped,
    changeAccount: () => epoch++, setAccountState: value => state = value };
}

for (const name of ['analysis', 'trends']) {
  test(`${name}: 同查询强制刷新失败保留报表，局部重试强制读取并更新`, async () => {
    const f = fixture(name), { p, api, patches } = f;
    await p.onShow();
    if (name === 'analysis') {
      p.chooseItem({ detail: { name: 'A' } });
      p.selectDay({ detail: { index: 0 } });
      p.moreItems();
    } else p.setData({ report: { ...p.data.report, entries: [...p.data.report.entries, { name: 'expanded' }] } });
    const displayed = p.data.report, key = p._displayKey, pending = deferred();
    let force;
    api[name] = (query, options) => { force = options.force; return pending.promise; };
    patches.length = 0;
    const refreshing = p.onPullDownRefresh();
    assert.equal(p.data.report, displayed);
    assert.equal(p.data.loading, false);
    assert.equal(p.data.refreshing, true);
    assert.equal(force, true);
    assert.equal(p._displayKey, key);
    assert.ok(!patches.some(patch => patch.loading === true || patch.report === null));
    pending.reject(new Error('offline'));
    await refreshing;
    assert.equal(p.data.report, displayed);
    assert.equal(p.data.error, '');
    assert.equal(p.data.refreshError, 'offline');
    assert.equal(p.data.refreshing, false);
    assert.equal(f.stopped(), 1);
    if (name === 'analysis') {
      assert.equal(p.data.focusName, 'A');
      assert.equal(p.data.selectedDay.exact, '100');
      assert.equal(p.data.visibleCount, 20);
    } else assert.equal(p.data.report.entries.length, 2);
    api[name] = async (query, options) => { assert.equal(options.force, true); return rawFor(name, query, 200); };
    await p.refresh();
    assert.equal(p.data.refreshError, '');
    assert.equal(name === 'analysis' ? p.data.report.summary.tokens : p.data.report.entries[0].tokens, 200);
    if (name === 'analysis') {
      assert.equal(p.data.selectedDay.exact, '200');
      assert.equal(p.data.visibleCount, 20);
    }
  });

  test(`${name}: 切查询立即清报表；A→B→A 不把空表当作刷新，迟到响应不恢复`, async () => {
    const { p, api } = fixture(name);
    await p.onShow();
    const oldQuery = { ...p.query() }, requests = [];
    api[name] = query => { const task = deferred(); requests.push({ ...task, query }); return task.promise; };
    const staleRefresh = p.refresh();
    const switched = name === 'analysis' ? p.pickPeriod(pick(1)) : p.pickMetric(pick(1));
    assert.equal(p.data.report, null);
    assert.equal(p._raw, null);
    assert.equal(p._displayKey, '');
    assert.equal(p.data.refreshing, false);
    assert.equal(p.data.loading, true);
    if (name === 'analysis') { p.switchMetric(tap('people')); assert.equal(p.data.report, null); }
    requests[1].reject(new Error('new query failed'));
    await switched;
    requests[0].resolve(rawFor(name, oldQuery, 999));
    await staleRefresh;
    assert.equal(p.data.report, null);
    assert.equal(p.data.error, 'new query failed');
    p.setData(oldQuery);
    const back = p.refresh();
    assert.equal(p.data.report, null);
    assert.equal(p.data.loading, true);
    assert.equal(p.data.refreshing, false);
    requests[2].resolve(rawFor(name, oldQuery, 300));
    await back;
    assert.ok(p.data.report);
    assert.equal(p.data.error, '');
  });

  test(`${name}: 查询改变后即使 _raw 复用同一缓存对象也重新标记真正展示的查询`, async () => {
    const raw = rawFor(name), { p, api } = fixture(name, { [name === 'analysis' ? 'peekAnalysis' : 'peekTrends']: () => raw });
    await p.onShow();
    const oldKey = p._displayKey;
    if (name === 'analysis') await p.switchDimension(tap('models'));
    else await p.switchOption(tap('dimension', 'models'));
    assert.ok(p.data.report);
    assert.notEqual(p._displayKey, oldKey);
    assert.equal(p._displayKey, p.queryKey());
    const pending = deferred();
    api[name] = () => pending.promise;
    const refreshed = p.refresh();
    assert.equal(p.data.refreshing, true);
    pending.reject(new Error('offline'));
    await refreshed;
    assert.ok(p.data.report);
  });

  test(`${name}: 缓存返回保留选中与展开，不进入全屏加载`, async () => {
    const raw = rawFor(name), peek = name === 'analysis' ? 'peekAnalysis' : 'peekTrends';
    const { p, patches } = fixture(name, { [peek]: () => raw, [name]: async () => assert.fail('cache must be reused') });
    await p.onShow();
    if (name === 'analysis') {
      p.chooseItem({ detail: { name: 'A' } }); p.selectDay({ detail: { index: 0 } }); p.moreItems();
      p.setData({ audienceName: 'A', audience: [{ nickname: 'expanded' }], audienceTotal: 1 });
    } else p.setData({ report: { ...p.data.report, entries: [...p.data.report.entries, { name: 'expanded' }] } });
    const report = p.data.report;
    patches.length = 0;
    p.onHide(); await p.onShow();
    assert.equal(p.data.report, report);
    assert.ok(!patches.some(patch => patch.loading === true || patch.report === null));
    if (name === 'analysis') {
      assert.equal(p.data.focusName, 'A'); assert.equal(p.data.selectedDay.exact, '100');
      assert.equal(p.data.visibleCount, 20); assert.equal(p.data.audience.length, 1);
    } else assert.equal(p.data.report.entries.length, 2);
  });

  test(`${name}: 离页后强制刷新的迟到成功或错误不能更新页面，普通 load 仍清空`, async () => {
    for (const fail of [false, true]) {
      const { p, api } = fixture(name);
      await p.onShow();
      const report = p.data.report, pending = deferred();
      api[name] = () => pending.promise;
      const refreshed = p.refresh();
      p.onHide();
      if (fail) pending.reject(new Error('late error')); else pending.resolve(rawFor(name, p.query(), 999));
      await refreshed;
      assert.equal(p.data.report, report);
      assert.equal(p.data.refreshing, false);
      assert.equal(p.data.refreshError, '');
    }
    const { p, api } = fixture(name);
    await p.onShow();
    const pending = deferred(); api[name] = () => pending.promise;
    const ordinary = p.load(); p.onHide();
    pending.resolve(rawFor(name, p.query(), 999)); await ordinary;
    assert.equal(p.data.report, null);
    assert.equal(p._displayKey, '');
  });
}

test('私有分析：换账户后强制刷新立即清空旧账号报表', async () => {
  const { p, api, changeAccount } = fixture('analysis', {}, { scope: 'mine' });
  await p.onShow();
  const pending = deferred(); api.analysis = () => pending.promise;
  changeAccount();
  const refreshed = p.refresh();
  assert.equal(p.data.report, null);
  assert.equal(p._displayKey, '');
  assert.equal(p.data.loading, true);
  await flush();
  pending.resolve(analysisData(p.query(), 200)); await refreshed;
  assert.equal(p.data.report.summary.tokens, 200);
});

test('私有分析：权限失败清除旧数据，账户变化时的迟到成功或错误也不能恢复', async () => {
  for (const statusCode of [401, 403, 410]) {
    const { p, api } = fixture('analysis', {}, { scope: 'mine' }); await p.onShow();
    api.analysis = async () => { throw Object.assign(new Error('denied'), { statusCode }); };
    await p.refresh();
    assert.equal(p.data.report, null); assert.equal(p._raw, null); assert.equal(p._displayKey, '');
    assert.equal(p.data.refreshError, ''); assert.equal(p.data.error, 'denied');
  }
  for (const fail of [false, true]) {
    const { p, api, changeAccount } = fixture('analysis', {}, { scope: 'mine' }); await p.onShow();
    const pending = deferred(); api.analysis = () => pending.promise;
    const refreshed = p.refresh(); await flush(); changeAccount();
    if (fail) pending.reject(new Error('old account')); else pending.resolve(analysisData(p.query(), 999));
    await refreshed;
    assert.equal(p.data.report, null); assert.equal(p._raw, null); assert.equal(p._displayKey, '');
    assert.equal(p.data.refreshing, false);
    p.switchMetric(tap('people')); p.render(); assert.equal(p.data.report, null);
  }
  const { p, api, setAccountState, navigation } = fixture('analysis', {}, { scope: 'mine' }); await p.onShow();
  setAccountState('deleted'); api.analysis = async () => assert.fail('inactive account cannot request');
  await p.refresh();
  assert.equal(p.data.report, null); assert.equal(p.data.loading, false);
  assert.equal(navigation.at(-1), '/pages/account/account');
});

test('分析：强制刷新、切查询和离页均作废正在读取的常用用户名单', async () => {
  for (const interrupt of ['refresh', 'period', 'hide']) {
    const { p, api } = fixture('analysis'); await p.onShow();
    const audience = deferred(); api.insightUsers = () => audience.promise;
    const pending = p.openAudience({ currentTarget: { dataset: { name: 'A' } } }); await flush();
    const version = p._audienceVersion;
    if (interrupt === 'refresh') await p.refresh();
    if (interrupt === 'period') await p.pickPeriod(pick(1));
    if (interrupt === 'hide') p.onHide();
    assert.ok(p._audienceVersion > version);
    audience.resolve({ entries: [{ nickname: 'late', rank: 1, tokens: 999 }], total: 1, has_more: false });
    await pending;
    assert.equal(p.data.audience.length, 0);
    assert.equal(p.data.audienceLoading, false);
    assert.equal(p.data.gateBusy, false);
  }
});

test('趋势：刷新期间不读续页，刷新前的迟到续页不能拼回新快照', async () => {
  const { p, api } = fixture('trends'); await p.onShow();
  const continuation = deferred(), refreshed = deferred(); let reads = 0;
  api.trends = query => { reads++; return query.offset ? continuation.promise : refreshed.promise; };
  const more = p.loadMore(), refresh = p.refresh();
  await p.loadMore(); assert.equal(reads, 2);
  refreshed.resolve({ ...trendsData(p.query(), 200), snapshot: 'new' }); await refresh;
  continuation.resolve({ ...trendsData(p.query()), entries: [{ name: 'late page', tokens: 999, users: 1 }] }); await more;
  assert.equal(p.data.report.entries.length, 1);
  assert.equal(p.data.report.entries[0].tokens, 200);
  assert.equal(p.data.report.snapshot, 'new');
});

test('原生筛选保留合法周期、工具条件及分享固定截止日，非法选择不发请求', async () => {
  const analysis = fixture('analysis', {}, { scope: 'public', period: 'last_month', tool: 'A/B', name: 'A' });
  await analysis.p.onShow(); assert.equal(analysis.p.data.periodIndex, 3);
  await analysis.p.pickPeriod(pick(2));
  assert.equal(analysis.p.data.period, 'month'); assert.equal(analysis.calls.at(-1).query.tool, 'A/B');
  assert.match(analysis.p.onShareAppMessage().path, /period=month&dimension=models&tool=A%2FB&name=A/);
  const trend = fixture('trends', {}, { period: 'last_month', metric: 'tokens', dimension: 'models', end: '2026-11-16' });
  await trend.p.onShow(); assert.equal(trend.p.data.periodIndex, 2); assert.equal(trend.p.data.metricIndex, 1);
  const shared = trend.p.onShareAppMessage().path;
  await trend.p.refresh(); assert.equal(trend.p.data.end, '2026-11-16'); assert.equal(trend.p.onShareAppMessage().path, shared);
  await trend.p.pickMetric(pick(0)); assert.equal(trend.p.data.end, '2026-11-16');
  await trend.p.pickPeriod(pick(0)); assert.equal(trend.p.data.end, ''); assert.equal(trend.p.data.period, 'week');
  for (const f of [analysis, trend]) {
    const count = f.calls.length; await f.p.pickPeriod(pick(99));
    if (f.p.pickMetric) await f.p.pickMetric(pick(99));
    assert.equal(f.calls.length, count);
  }
});
