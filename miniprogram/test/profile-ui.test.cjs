const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const flush = () => new Promise(resolve => setImmediate(resolve));
const event = (key, value) => ({ currentTarget: { dataset: { [key]: value } } });
const user = { user_id: 1, nickname: '本人', avatar_url: 'https://rank.test/me.png', last_report_at: 1 };
const report = (period = 'month', daily = [
  { day: '2026-10-30', tokens: 12000, reported: true },
  { day: '2026-10-31', tokens: 0, reported: true },
  { day: '2026-11-01', tokens: null, reported: false },
]) => ({
  period, from: daily[0]?.day || '2026-10-01', to: daily.at(-1)?.day || '2026-10-31',
  timezone: 'Asia/Shanghai', token_basis: 'upstream_total', has_history: true, trend_days: daily.length,
  summary: { tokens: 12000, requests: 3, active_days: 1, input_tokens: 2000, output_tokens: 1000, cache_read: 9000, cache_write: 0 },
  daily, tools: [{ name: '工具', tokens: 12000, percent: 100 }], models: [{ name: '模型', tokens: 12000, percent: 100 }],
});

function fixture({ raw = report(), profile = user, api: overrides = {} } = {}) {
  let definition;
  const navigation = [], toasts = [], shares = [];
  const api = { peekMe: () => profile, peekUsage: () => raw, ensureSession: async () => {}, fmtRelTime: () => '刚刚',
    myOverview: async () => ({ user: profile, usage: raw }), ...overrides };
  const wx = { getStorageSync: () => '', getPrivacySetting: options => options.success({ needAuthorization: false }),
    showToast: options => toasts.push(options), stopPullDownRefresh() {},
    navigateTo: options => navigation.push(options.url), switchTab: options => navigation.push(options.url) };
  const flow = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'utils/flow.js'), 'utf8'), { module: flow, require: () => api });
  vm.runInNewContext(fs.readFileSync(path.join(root, 'pages/profile/profile.js'), 'utf8'), {
    Page: value => { definition = value; }, wx,
    require: id => id.endsWith('/api') ? api : id.endsWith('/flow') ? flow.exports : id.endsWith('/reminder-prompt') ? { maybePrompt() {} }
      : id.endsWith('/quick-share') ? { quickShare: () => ({ clearQuickShare() {}, buildQuickCover() {},
        prepareQuickShare: options => shares.push(options), quickShareCard: () => null }) }
      : require(path.join(root, 'utils', path.basename(id))),
  });
  const p = { ...definition, data: structuredClone(definition.data), setData(patch) { Object.assign(this.data, patch); } };
  p.data.period = raw.period;
  return { p, api, navigation, toasts, shares };
}

test('个人页分析默认折叠，分区独立展开，全部明细与所选日期在收起后保留', async () => {
  const raw = report();
  raw.tools = Array.from({ length: 8 }, (_, index) => ({ name: '工具' + index, tokens: index + 1, percent: 1 }));
  raw.models = Array.from({ length: 9 }, (_, index) => ({ name: '模型' + index, tokens: index + 1, percent: 1 }));
  const { p } = fixture({ raw });
  await p.onShow();
  for (const key of ['trendExpanded', 'breakdownExpanded', 'cacheExpanded', 'profileExpanded']) assert.equal(p.data[key], false);
  p.pickDate({ detail: { value: '2026-10-30' } });
  p.toggleSection(event('section', 'trendExpanded'));
  p.toggleSection(event('section', 'breakdownExpanded'));
  p.toggleSection(event('section', 'cacheExpanded'));
  p.toggleDetails();
  p.toggleSection(event('section', 'breakdownExpanded'));
  assert.equal(p.data.breakdownExpanded, false);
  assert.equal(p.data.trendExpanded, true);
  assert.equal(p.data.cacheExpanded, true);
  assert.equal(p.data.expanded, true);
  assert.equal(p.data.selectedDay.day, '2026-10-30');
  assert.equal(p.data.usage.tools.length, 8);
  assert.equal(p.data.usage.models.length, 9);
  p.toggleSection(event('section', 'period'));
  assert.equal(p.data.period, 'month');
});

test('未完善资料首次展开，原生头像选择返回保留编辑状态及草稿，保存后更新完成状态', async () => {
  const { p, toasts } = fixture({ profile: { user_id: 1, nickname: '', avatar_url: '' },
    api: { uploadProfile: async nickname => ({ ...user, nickname }) } });
  await p.onShow();
  assert.equal(p.data.profileExpanded, true);
  assert.equal(p.data.profileComplete, false);
  p.onNicknameInput({ detail: { value: '微信昵称' } });
  p.onHide();
  p.onChooseAvatar({ detail: { avatarUrl: 'wxfile://picked' } });
  await p.onShow();
  assert.equal(p.data.profileExpanded, true);
  assert.equal(p.data.nickname, '微信昵称');
  assert.equal(p.data.avatarDraft, 'wxfile://picked');
  await p.save({ detail: { value: { nickname: '微信昵称' } } });
  assert.equal(p.data.profileComplete, true);
  assert.equal(p.data.profileExpanded, true);
  assert.equal(toasts.at(-1).title, '资料已保存');
});

test('资料分区收起选择在返回时保留，保存或授权期间不卸载原生表单', async () => {
  const { p } = fixture({ profile: { user_id: 1 } });
  await p.onShow();
  p.toggleSection(event('section', 'profileExpanded'));
  p.onHide(); await p.onShow();
  assert.equal(p.data.profileExpanded, false);
  p.toggleSection(event('section', 'profileExpanded'));
  p.setData({ saving: true });
  p.toggleSection(event('section', 'profileExpanded'));
  assert.equal(p.data.profileExpanded, true);
  p.setData({ saving: false, privacyBusy: true });
  p.toggleSection(event('section', 'profileExpanded'));
  assert.equal(p.data.profileExpanded, true);
});

test('30天趋势可通过日期选择与前后日切换，不跳过未同步日期，不越过范围', async () => {
  const daily = Array.from({ length: 30 }, (_, index) => {
    const day = new Date(Date.UTC(2026, 9, 3 + index)).toISOString().slice(0, 10);
    return { day, tokens: index === 27 ? null : index * 100, reported: index !== 27 };
  });
  const { p } = fixture({ raw: report('month', daily) });
  await p.onShow();
  assert.equal(p.data.trendStart, '2026-10-03');
  assert.equal(p.data.trendEnd, '2026-11-01');
  assert.equal(p.data.selectedDay.day, '2026-11-01');
  assert.equal(p.data.canNext, false);
  p.stepDay(event('delta', 1));
  assert.equal(p.data.selectedDay.day, '2026-11-01');
  p.pickDate({ detail: { value: '2026-10-31' } });
  p.stepDay(event('delta', '-1'));
  assert.equal(p.data.selectedDay.day, '2026-10-30');
  assert.equal(p.data.selectedDay.statusText, '未同步');
  assert.equal(p.data.selectedDay.exact, '');
  p.pickDate({ detail: { value: '2026-10-03' } });
  assert.equal(p.data.canPrevious, false);
  p.stepDay(event('delta', -1));
  assert.equal(p.data.selectedDay.day, '2026-10-03');
  for (const value of ['2026-10-02', '2026-11-02', '2026-10-32', 'invalid']) p.pickDate({ detail: { value } });
  assert.equal(p.data.selectedDay.day, '2026-10-03');
  p.selectDay(event('index', 29));
  assert.equal(p.data.selectedDay.day, '2026-11-01');
});

test('日期选择跨月及闰年按自然日前后移动，缺少的日期显示无数据并保留原序列', async () => {
  const daily = [{ day: '2028-02-28', tokens: 10, reported: true }, { day: '2028-03-01', tokens: 20, reported: true }];
  const { p } = fixture({ raw: report('month', daily) });
  await p.onShow();
  p.stepDay(event('delta', -1));
  assert.equal(p.data.selectedDay.day, '2028-02-29');
  assert.equal(p.data.selectedDay.valueAvailable, false);
  assert.equal(p.data.selectedDay.tokens, null);
  assert.equal(p.data.selectedDay.exact, '');
  assert.equal(p.data.selectedDay.statusText, '暂无该日数据');
  assert.equal(p.data.usage.daily.length, 2);
  p.stepDay(event('delta', -1));
  assert.equal(p.data.selectedDay.day, '2028-02-28');
  assert.equal(p.data.canPrevious, false);
});

test('日期详情区分真实零、未同步、空值与旧接口的未确认零，图表不补假数', async () => {
  const daily = [
    { day: '2026-10-01', tokens: 0, reported: true },
    { day: '2026-10-02', tokens: 0, reported: false },
    { day: '2026-10-03', tokens: null },
    { day: '2026-10-04', tokens: 0 },
    { day: '2026-10-05', tokens: 258000000 },
    { day: '2026-10-06', tokens: 0, reported: false, future: true },
  ];
  const { p } = fixture({ raw: report('week', daily) });
  await p.onShow();
  const states = p.data.usage.daily;
  assert.equal(states[0].valueAvailable, true); assert.equal(states[0].exact, '0');
  assert.equal(states[0].statusText, '已同步 · 零用量');
  for (const index of [1, 2, 3, 5]) {
    p.selectDay(event('index', index));
    assert.equal(p.data.selectedDay.valueAvailable, false);
    assert.equal(p.data.selectedDay.exact, '');
    assert.equal(p.data.selectedDay.height, 0);
  }
  assert.equal(states[1].statusText, '未同步');
  assert.equal(states[2].tokens, null);
  assert.equal(states[3].statusText, '同步状态未确认');
  assert.equal(states[5].statusText, '未到日期');
  p.pickDate({ detail: { value: '2026-10-05' } });
  assert.equal(p.data.selectedDay.exact, '258,000,000');
  assert.equal(p.data.usage.peakText, '2.58 亿');
  assert.deepEqual(rawTokens(p.data.usage.daily), rawTokens(daily));
});
const rawTokens = daily => Array.from(daily, day => day.tokens);

test('缓存返回和强制刷新保留所选日期及折叠状态，跨周期选新范围且分享仍继承周期', async () => {
  let raw = report(), requests = 0;
  const { p, navigation } = fixture({ api: {
    peekUsage: () => raw,
    myOverview: async (period, options) => { requests++; assert.equal(options.force, true); return { user, usage: raw }; },
  } });
  await p.onShow();
  p.toggleSection(event('section', 'trendExpanded'));
  p.toggleSection(event('section', 'cacheExpanded'));
  p.pickDate({ detail: { value: '2026-10-30' } });
  p.onHide(); await p.onShow();
  assert.equal(requests, 0);
  assert.equal(p.data.selectedDay.day, '2026-10-30');
  assert.equal(p.data.trendExpanded, true);
  assert.equal(p.data.cacheExpanded, true);
  raw = report(); raw.daily[0].tokens = 15000;
  await p.onPullDownRefresh();
  assert.equal(requests, 1);
  assert.equal(p.data.selectedDay.day, '2026-10-30');
  assert.equal(p.data.selectedDay.exact, '15,000');
  raw = report('last_month', [{ day: '2026-09-30', tokens: 7, reported: true }]);
  await p.switchPeriod(event('key', 'last_month'));
  assert.equal(p.data.selectedDay.day, '2026-09-30');
  assert.equal(p.data.trendExpanded, true);
  assert.equal(p.data.cacheExpanded, true);
  p.goShare(); p.goAnalysis();
  assert.equal(navigation[0], '/pages/share/share?period=last_month');
  assert.equal(navigation[1], '/pages/analysis/analysis?scope=mine&period=last_month');
});

test('切换周期后迟到旧响应和空序列不恢复无效日期选择', async () => {
  const pending = new Map();
  const { p } = fixture({ raw: report('day'), api: {
    peekMe: () => null, peekUsage: () => null,
    myOverview: period => new Promise(resolve => pending.set(period, resolve)),
  } });
  const old = p.load(); await flush();
  const current = p.switchPeriod(event('key', 'week')); await flush();
  pending.get('week')({ user, usage: report('week', [{ day: '2026-10-29', tokens: 500, reported: true }]) });
  await current;
  pending.get('day')({ user, usage: report('day') }); await old;
  assert.equal(p.data.period, 'week');
  assert.equal(p.data.selectedDay.day, '2026-10-29');
  p.showUsage(report('week', []));
  p.pickDate({ detail: { value: '2026-10-29' } }); p.stepDay(event('delta', 1));
  assert.equal(p.data.selectedDay, null);
  assert.equal(p.data.trendStart, ''); assert.equal(p.data.trendEnd, '');
  assert.equal(p.data.canPrevious, false); assert.equal(p.data.canNext, false);
});
