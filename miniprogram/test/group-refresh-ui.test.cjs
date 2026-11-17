const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const flush = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve, reject; const promise = new Promise((ok, fail) => { resolve = ok; reject = fail; }); return { promise, resolve, reject }; };
const user = { user_id: 1, nickname: '本人', avatar_url: 'https://rank.test/me.png', last_report_at: 1 };
const group = { id: 'g1', name: '本群', members: 3, joined: true, owner_id: 1 };
function board(period = 'day', nickname = period) {
  return { period, entries: [{ rank: 1, nickname, tokens: 258000000 }, { rank: 2, nickname: '本人', tokens: 100 }],
    me: { rank: 2, tokens: 100 }, members: 3, total: 2, has_more: false, next_offset: null, snapshot: 'snapshot-' + period, updated_at: 1 };
}
function insights(period = 'day') {
  const analysis = { scope: 'group', period, summary: { tokens: 258000100, breakdown_tokens: 258000100, users: 2 }, items: [{ key: 'named:A', name: 'A', tokens: 258000100, percent: 100, users: 2 }], daily: [], trend_days: 7 };
  return { group, period, from: '2026-11-17', to: '2026-11-17', summary: { tokens: 258000100, active_users: 2 },
    tools: { ...analysis, dimension: 'tools' }, models: { ...analysis, dimension: 'models' }, cost: { status: 'unavailable', models: [] }, snapshot: 'insights-' + period };
}
const response = (period = 'day', nickname = period) => ({ user, group, board: board(period, nickname), insights: insights(period) });
function record(period = 'day') {
  return { id: 'a'.repeat(24), user, usage: { period, from: '2026-11-17', to: '2026-11-17', timezone: 'Asia/Shanghai', token_basis: 'upstream_total',
    summary: { tokens: 100, requests: 1, active_days: 1 }, group_standing: { name: '本群', rank: 2, total: 2, members: 3 } } };
}
function fixture(overrides = {}) {
  let definition, epoch = 0, state = '';
  const patches = [], calls = [], api = { accountEpoch: () => epoch, accountState: () => state,
    ensureSession: async () => {}, ensureLogin: async () => user, peekMe: () => null, peekGroup: () => null, peekLeaderboard: () => null,
    groupPage: async (id, period, options) => { calls.push({ id, period, options }); return response(period); },
    createShare: async period => record(period), fmtRelTime: () => '刚刚', fmtTokens: String, initialOf: value => [...String(value || '?')][0], ...overrides };
  const wx = { getStorageSync: () => '', showShareMenu() {}, stopPullDownRefresh() {}, showToast() {}, navigateTo() {} };
  const flowModule = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'utils/flow.js'), 'utf8'), { module: flowModule, require: () => api, wx });
  vm.runInNewContext(fs.readFileSync(path.join(root, 'pages/group/group.js'), 'utf8'), {
    Page: value => definition = value, wx, require: id => id.endsWith('/api') ? api : id.endsWith('/flow') ? flowModule.exports
      : id.endsWith('/share-avatar') ? { loadAvatarImage: async () => null } : require(path.join(root, 'utils', path.basename(id))) });
  const p = { ...definition, data: structuredClone(definition.data), setData(patch) { patches.push(patch); Object.assign(this.data, patch); } };
  p.buildQuickCover = () => {};
  p.onLoad({ g: 'g1', from: 'mine' });
  return { p, api, wx, calls, patches, nextAccount: () => epoch++, inactive: () => { state = 'deleted'; } };
}
const switchTo = (p, period) => p.switchPeriod({ currentTarget: { dataset: { key: period } } });
function assertCleared(p) {
  assert.equal(p.data.entries.length, 0); assert.equal(p.data.me, null); assert.equal(p.data.total, null);
  assert.equal(p.data.snapshot, ''); assert.equal(p.data.insights, null); assert.equal(p.data.boardReady, false);
  assert.equal(p._boardSnapshot, null); assert.equal(p._boardQuery, null); assert.equal(p._quickRecord, null);
  assert.equal(p.data.quickShareReady, false); assert.equal(p.data.posterPath, ''); assert.equal(p.data.shareCardPath, '');
}

test('同群同周期刷新失败保留榜单、本人、汇总及更新时间，局部重试成功才重新准备分享', async () => {
  const f = fixture(); await f.p.onShow(); await flush();
  assert.equal(f.p.data.quickShareReady, true);
  const { entries, me, insights, snapshot, total, updated_fmt } = f.p.data;
  const pending = deferred(); f.api.groupPage = () => pending.promise;
  const refresh = f.p.onPullDownRefresh(); await flush();
  assert.equal(f.p.data.loading, false); assert.equal(f.p.data.refreshing, true);
  assert.equal(f.p.data.entries, entries); assert.equal(f.p.data.me, me); assert.equal(f.p.data.insights, insights);
  assert.equal(f.p.data.quickShareReady, false); assert.equal(f.p.onShareAppMessage().path, '/pages/group/group?enter=1');
  pending.reject(new Error('网络暂不可用')); await refresh;
  assert.equal(f.p.data.entries, entries); assert.equal(f.p.data.me, me); assert.equal(f.p.data.insights, insights);
  assert.equal(f.p.data.snapshot, snapshot); assert.equal(f.p.data.total, total); assert.equal(f.p.data.updated_fmt, updated_fmt);
  assert.equal(f.p.data.error, ''); assert.match(f.p.data.refreshError, /网络/); assert.equal(f.p.data.refreshing, false);
  assert.equal(f.p.retryQuickShare(), undefined); assert.equal(f.p.data.quickShareReady, false);
  f.api.groupPage = async () => response('day', '新数据'); await f.p.load(); await flush();
  assert.equal(f.p.data.entries[0].nickname, '新数据'); assert.equal(f.p.data.refreshError, ''); assert.equal(f.p.data.quickShareReady, true);
});

test('切周期立即清旧榜单及汇总，旧响应和旧分享不能混入新周期；快速切回仍按当前查询读取', async () => {
  const f = fixture(); await f.p.onShow(); await flush(); const week = deferred(), day = deferred();
  f.api.groupPage = (id, period) => period === 'week' ? week.promise : day.promise;
  const old = switchTo(f.p, 'week'); assertCleared(f.p); assert.equal(f.p.data.loading, true); await flush();
  const current = switchTo(f.p, 'day'); assertCleared(f.p); await flush();
  week.resolve(response('week', '旧周期')); await old; assertCleared(f.p);
  day.resolve(response('day', '当前周期')); await current; await flush();
  assert.equal(f.p.data.period, 'day'); assert.equal(f.p.data.entries[0].nickname, '当前周期'); assert.equal(f.p.data.insights.period, 'day');
});

test('切换群查询先清空已有数据，失败不保留另一个群的榜单', async () => {
  const f = fixture(); await f.p.onShow(); const next = deferred(); f.api.groupPage = () => next.promise;
  f.p.setData({ id: 'g2' }); const refresh = f.p.init(); assertCleared(f.p); await flush();
  next.reject(new Error('网络失败')); await refresh; assertCleared(f.p); assert.match(f.p.data.error, /网络/);
});

test('同周期空榜单也是已展示数据，刷新失败保持空态并显示局部错误', async () => {
  const f = fixture({ groupPage: async () => ({ ...response(), board: { ...board(), entries: [], me: null, total: 0 } }) });
  await f.p.onShow(); f.api.groupPage = async () => { throw new Error('断网'); }; await f.p.load();
  assert.equal(f.p.data.boardReady, true); assert.equal(f.p.data.total, 0); assert.equal(f.p.data.error, ''); assert.equal(f.p.data.refreshError, '断网');
});

test('成员资格丢失清空旧榜单、汇总、海报和个人分享；后续失败不得复现成员数据', async () => {
  const f = fixture(); await f.p.onShow(); await flush(); f.p.setData({ posterPath: 'old.png', shareCardPath: 'old-cover.png' });
  f.api.groupPage = async () => ({ user, group: { ...group, joined: false }, board: null, insights: null });
  await f.p.load(); assertCleared(f.p); assert.equal(f.p.data.joined, false);
  f.api.groupPage = async () => { throw new Error('断网'); }; await f.p.load(); assertCleared(f.p);
  assert.equal(f.p.onShareAppMessage().path, '/pages/group/group?enter=1');
});

test('403、404、409、428 权限或快照失效即清空，补资料读取失败也不能留旧数据', async () => {
  for (const statusCode of [403, 404, 409, 428]) {
    const f = fixture(); await f.p.onShow(); const profile = deferred();
    f.api.groupPage = async () => { const error = new Error('访问状态已变化'); error.statusCode = statusCode; throw error; };
    f.api.ensureLogin = () => profile.promise; const refresh = f.p.load(); await flush(); assertCleared(f.p);
    if (statusCode === 428) profile.reject(new Error('无法获取资料')); await refresh; assertCleared(f.p);
  }
});

test('旧接口先检测到隐藏权限变化时，即使新榜单失败也不能保留原来的本人排名', async () => {
  const f = fixture(); await f.p.onShow(); f.api.groupPage = undefined;
  f.api.ensureLogin = async () => ({ ...user, rank_hidden: true }); f.api.groupInfo = async () => group;
  const next = deferred(); f.api.fetchLeaderboard = () => next.promise;
  const refresh = f.p.load(); await flush(); assertCleared(f.p); assert.equal(f.p.data.loading, true);
  next.reject(new Error('网络失败')); await refresh; assertCleared(f.p);
});

test('账户 epoch 改变或注销后返回页面先清空本人及群数据，迟到结果不能恢复', async () => {
  for (const inactive of [false, true]) {
    const f = fixture(); await f.p.onShow(); await flush(); const next = deferred(); f.api.groupPage = () => next.promise;
    const refresh = f.p.load(); await flush();
    if (inactive) f.inactive(); else f.nextAccount();
    next.resolve(response('day', '前一账号')); await refresh; assertCleared(f.p); assert.equal(f.p.data.user, null); assert.equal(f.p.data.joined, null);
    const again = deferred(); f.api.groupPage = () => again.promise; const show = f.p.onShow(); assertCleared(f.p);
    if (!inactive) { await flush(); again.reject(new Error('新账号网络失败')); } await show; assertCleared(f.p);
  }
});

test('隐藏后迟到首屏或汇总不改页面，返回同一缓存快照保留已经展开的续页', async () => {
  const first = response(); first.board = { ...first.board, has_more: true, next_offset: 2, total: 3 };
  const f = fixture({ groupPage: async () => first, fetchLeaderboard: async () => ({ ...first.board, entries: [{ rank: 3, nickname: '续页', tokens: 1 }], has_more: false, next_offset: null }) });
  await f.p.onShow(); await f.p.loadMore(); assert.equal(f.p.data.entries.length, 3);
  f.api.peekMe = () => user; f.api.peekGroup = () => ({ ...group, owner_id: undefined }); f.api.peekLeaderboard = () => first.board; f.api.peekGroupInsights = () => first.insights;
  f.p.onHide(); await f.p.onShow(); assert.equal(f.p.data.entries.length, 3);
  const pending = deferred(); f.api.groupPage = () => pending.promise; const refresh = f.p.load(); await flush(); f.p.onHide();
  const patches = f.patches.length; pending.resolve(response('day', '迟到首屏')); await refresh;
  assert.equal(f.patches.length, patches); assert.equal(f.p.data.entries.length, 3);
  f.p._visible = true; const report = deferred(); f.api.groupInsights = () => report.promise;
  const loading = f.p.loadInsights({ force: true }); f.p.onHide(); const reportPatches = f.patches.length;
  report.resolve(insights('week')); await loading; assert.equal(f.patches.length, reportPatches); assert.equal(f.p.data.insights.period, 'day');
});

test('刷新撤销旧的快分享在途记录；普通失败后迟到分享不再变为可转发', async () => {
  const share = deferred(), f = fixture({ createShare: () => share.promise }); await f.p.onShow();
  f.api.groupPage = async () => { throw new Error('断网'); }; await f.p.load();
  share.resolve(record()); await flush(); assert.equal(f.p._quickRecord, null); assert.equal(f.p.data.quickShareReady, false);
  assert.equal(f.p.onShareAppMessage().path, '/pages/group/group?enter=1');
});

test('隐藏设置完成前切换周期仍刷新当前周期，不保留旧开关、本人名次或分享', async () => {
  const setting = deferred(); let hidden = false;
  const f = fixture({
    setGroupVisibility: async () => { await setting.promise; hidden = true; },
    groupPage: async (id, period) => ({ ...response(period), group: { ...group, my_hidden: hidden },
      board: hidden ? { ...board(period), me: null, entries: [board(period).entries[0]] } : board(period) }),
    createShare: async period => { if (hidden) throw new Error('已在本群隐藏'); return record(period); },
  });
  await f.p.onShow(); await flush();
  const save = f.p.toggleGroupVisibility({ detail: { value: false } });
  await switchTo(f.p, 'week'); await flush();
  assert.equal(f.p.data.period, 'week'); assert.equal(f.p.data.myHidden, false); assert.ok(f.p.data.me);
  setting.resolve(); await save; await flush();
  assert.equal(f.p.data.period, 'week'); assert.equal(f.p.data.myHidden, true); assert.equal(f.p.data.me, null);
  assert.equal(f.p.data.visibilitySaving, false); assert.equal(f.p.data.quickShareReady, false);
  assert.equal(f.p._quickRecord, null);
});

test('本群分析入口滚动可选，页面结构先榜单与口径再完整汇总及操作区，数字不强制拆行', () => {
  const f = fixture(); assert.doesNotThrow(() => f.p.scrollToInsights());
  const template = fs.readFileSync(path.join(root, 'pages/group/group.wxml'), 'utf8');
  assert.ok(template.indexOf('class="tabs"') < template.indexOf('is="leaderboard-row"'));
  assert.ok(template.indexOf('class="board-meta"') < template.indexOf('id="group-overview"'));
  assert.ok(template.indexOf('id="group-overview"') < template.indexOf('class="visibility-row"'));
  for (const key of ['insights.amount.value', 'insights.costText', 'insights.summary.active_users', 'insights.topTool', 'insights.topModel', 'insights.costNote']) assert.ok(template.includes(key));
  const styles = fs.readFileSync(path.join(root, 'pages/group/group.wxss'), 'utf8');
  assert.doesNotMatch(styles, /word-break\s*:\s*break-all/); assert.match(styles, /overview-metrics[^}]*flex-wrap:\s*wrap/);
  assert.match(styles, /overview-value[^}]*white-space:\s*nowrap/); assert.match(styles, /max-width:\s*340px/);
});
