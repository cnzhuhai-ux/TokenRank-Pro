const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const flush = () => new Promise(resolve => setImmediate(resolve));
const event = key => ({ currentTarget: { dataset: { key } } });
const board = (name = '本期', snapshot = 'first') => ({ entries: [{ rank: 1, nickname: name, tokens: 12000, credits: 7.2 }],
  me: { rank: 1, tokens: 12000, credits: 7.2 }, total: 2, has_more: true, next_offset: 1, snapshot, updated_at: 1 });
const analysis = name => ({ summary: { tokens: 100, breakdown_tokens: 100, users: 1 },
  items: [{ name, key: name, tokens: 100, percent: 100 }], daily: [], updated_at: 1 });
function page(overrides = {}) {
  let definition;
  const api = { accountEpoch: () => 0, peekMe: () => null, peekLeaderboard: () => null, peekAnalysis: () => null,
    ensureSession: async () => {}, ensureLogin: async () => ({ nickname: '本人' }), fmtRelTime: () => '刚刚',
    fetchLeaderboard: async () => board(), analysis: async () => analysis('工具'), ...overrides };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../pages/square/square.js'), 'utf8'), {
    Page: value => definition = value, wx: { showToast() {}, stopPullDownRefresh() {} },
    require: id => id.endsWith('/api') ? api : id.endsWith('/flow') ? { PERIODS: [
      { key: 'day', label: '今日' }, { key: 'week', label: '近7天' }, { key: 'month', label: '近30天' }, { key: 'last_month', label: '上个月' },
    ] } : require(path.join(__dirname, '../utils', path.basename(id))),
  });
  return { p: { ...definition, data: structuredClone(definition.data), setData(patch) { Object.assign(this.data, patch); } }, api };
}

test('原生周期选择与筛选标签保持一致，忽略无效周期及口径', async () => {
  const queries = [], { p } = page({ fetchLeaderboard: async query => { queries.push(query); return board(); } });
  await p.onShow(); await p.pickPeriod({ detail: { value: '3' } });
  assert.equal(p.data.period, 'last_month'); assert.equal(p.data.periodIndex, 3); assert.equal(queries.at(-1).period, 'last_month');
  await p.switchMetric(event('credits')); assert.equal(queries.at(-1).metric, 'credits');
  p.switchPeriod(event('unknown')); p.switchMetric(event('unknown')); p.pickPeriod({ detail: { value: '99' } });
  assert.equal(p.data.period, 'last_month'); assert.equal(p.data.metric, 'credits'); assert.equal(queries.length, 3);
});

test('同查询刷新保留榜单，失败就地重试，成功才替换当前快照', async () => {
  let reject, resolve, calls = 0;
  const { p } = page({ fetchLeaderboard: () => ++calls === 1 ? Promise.resolve(board()) : new Promise((yes, no) => { resolve = yes; reject = no; }) });
  await p.onShow(); const entries = p.data.entries;
  const refresh = p.refresh(); await flush();
  assert.equal(p.data.entries, entries); assert.equal(p.data.loading, false); assert.equal(p.data.refreshing, true);
  reject(new Error('网络暂不可用')); await refresh;
  assert.equal(p.data.entries, entries); assert.equal(p.data.refreshing, false); assert.equal(p.data.error, ''); assert.match(p.data.refreshError, /网络/);
  const retry = p.refresh(); await flush(); resolve(board('更新后', 'second')); await retry;
  assert.equal(p.data.entries[0].nickname, '更新后'); assert.equal(p.data.refreshError, ''); assert.equal(p.data.snapshot, 'second');
});

test('刷新中改周期立即清空旧结果，旧刷新失败不能覆盖新筛选', async () => {
  let reject, finish;
  const { p, api } = page(); await p.onShow();
  api.fetchLeaderboard = query => new Promise((yes, no) => { if (query.period === 'day') reject = no; else finish = yes; });
  const refresh = p.refresh(); await flush(); const week = p.pickPeriod({ detail: { value: '1' } }); await flush();
  assert.equal(p.data.entries.length, 0); assert.equal(p.data.me, null); assert.equal(p.data.loading, true); assert.equal(p.data.refreshing, false);
  finish(board('近7天', 'week')); await week; reject(new Error('旧刷新失败')); await refresh;
  assert.equal(p.data.entries[0].nickname, '近7天'); assert.equal(p.data.refreshError, ''); assert.equal(p.data.periodIndex, 1);
});

test('同首屏缓存保留续页，换周期即使缓存对象相同也恢复首屏', async () => {
  const cached = board(), { p } = page({ peekLeaderboard: () => cached });
  await p.onShow(); p.setData({ entries: p.data.entries.concat({ rank: 2, nickname: '第二页' }), hasMore: false });
  p.onHide(); await p.onShow(); assert.equal(p.data.entries.length, 2);
  await p.switchPeriod(event('week')); assert.equal(p.data.entries.length, 1); assert.equal(p.data.hasMore, true);
});

test('工具分布刷新失败保留原图，切模型不显示旧分布，隐藏后迟到响应失效', async () => {
  const { p, api } = page(); await p.switchMode(event('tools'));
  const previous = p.data.insights; let reject, finish;
  api.analysis = query => new Promise((yes, no) => { if (query.dimension === 'tools') reject = no; else finish = yes; });
  const refresh = p.refresh(); reject(new Error('刷新失败')); await refresh;
  assert.equal(p.data.insights, previous); assert.match(p.data.refreshError, /失败/);
  const models = p.switchMode(event('models')); assert.equal(p.data.insights, null); assert.equal(p.data.error, '');
  p.onHide(); finish(analysis('迟到模型')); await models; assert.equal(p.data.insights, null);
});

test('账号改变时不保留旧本人排名，上一账号响应不能恢复本人数据', async () => {
  let epoch = 0, finish;
  const { p, api } = page({ accountEpoch: () => epoch }); await p.onShow();
  api.fetchLeaderboard = () => new Promise(resolve => finish = resolve);
  epoch++; const load = p.refresh(); await flush(); assert.equal(p.data.me, null); assert.equal(p.data.entries.length, 0);
  epoch++; finish(board('上一账号')); await load; assert.equal(p.data.me, null); assert.equal(p.data.entries.length, 0);
});

test('Credits 的真实零值不会回落为 Token 数字', () => {
  const { presentMe } = require('../utils/leaderboard');
  const me = presentMe({ rank: 1, tokens: 12000, credits: 0 }, 'credits');
  assert.equal(me.credits_view, '0'); assert.equal(me.alt_view, '1.2 万 tokens');
});
