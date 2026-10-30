const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const usage = require('../utils/usage');
const { presentEntries, presentMe } = require('../utils/leaderboard');
const { presentAnalysis } = require('../utils/analytics');
const { trendsView } = require('../utils/history');

const base = (period, extra = {}) => ({
  period, timezone: 'Asia/Shanghai', token_basis: 'upstream_total', from: '2026-09-22', to: '2026-09-28',
  summary: { tokens: 0, input_tokens: 0, output_tokens: 0, requests: 0, cache_read: 0, cache_write: 0, active_days: 0 },
  daily: [], models: [], tools: [], trend_days: 7, ...extra,
});
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8');

test('Credits 数字格式：不足一万保留两位小数，过万才用紧凑单位', () => {
  assert.equal(usage.formatCredits(4011.334), '4,011.33');
  assert.equal(usage.formatCredits(7.2), '7.2');
  assert.deepEqual(usage.compactCredits(12345.67), { value: '1.23', unit: '万' });
  assert.deepEqual(usage.compactCredits(0), { value: '0', unit: '' });
  assert.deepEqual(usage.compactCredits(-5), { value: '0', unit: '' });
});

test('我的用量：creditsDisplay 给出与 tokens 同款的大数字分段', () => {
  const week = usage.present(base('week', { credits: { status: 'complete', total: 4011.33, tools: [['qoder', 4000], ['trae', 11.33]] } }));
  assert.equal(week.creditsDisplay.available, true);
  assert.equal(week.creditsDisplay.value, '4,011.33');
  assert.equal(week.creditsDisplay.unit, '');
  assert.equal(week.creditsDisplay.formatted, '4,011.33');
  assert.equal(week.creditsDisplay.note, 'qoder、trae');
  const big = usage.present(base('all', { credits: { status: 'complete', total: 12345.67, tools: [] } }));
  assert.deepEqual({ value: big.creditsDisplay.value, unit: big.creditsDisplay.unit }, { value: '1.23', unit: '万' });
  assert.equal(usage.present(base('day')).creditsDisplay.available, false);
  assert.equal(usage.present(base('day', { credits: { status: 'unavailable', total: 0, tools: [] } })).creditsDisplay.available, false);
});

test('榜单每行同步另一维度：Token 榜补 Credits，Credits 榜补 tokens', () => {
  const entry = { rank: 1, nickname: '甲', tokens: 1234567, credits: 4011.33, requests: 9 };
  const tokenRow = presentEntries([entry], null, 'tokens')[0];
  assert.equal(tokenRow.credits_view, '');
  assert.equal(tokenRow.alt_view, '4,011.33 Credits');
  const creditRow = presentEntries([entry], null, 'credits')[0];
  assert.equal(creditRow.credits_view, '4,011.33');
  assert.equal(creditRow.alt_view, '123.46 万 tokens');
  assert.equal(presentEntries([{ ...entry, credits: 0 }], null, 'tokens')[0].alt_view, '');
  assert.equal(presentEntries([{ ...entry, tokens: 0 }], null, 'credits')[0].alt_view, '');
  assert.equal(presentMe(null), null);
  assert.equal(presentMe(entry, 'tokens').alt_view, '4,011.33 Credits');
});

test('页面标记：tokens 在上、Credits 在下，统计位成对出现', () => {
  const profile = read('pages', 'profile', 'profile.wxml');
  assert.ok(profile.indexOf('hero-number num-font">{{usage.value}}') < profile.indexOf('credits-number'));
  assert.match(profile, /Credits 计费工具/);
  const home = read('pages', 'index', 'index.wxml');
  assert.ok(home.indexOf('own-number num-font') < home.indexOf('own-credits'));
  assert.match(home, /credits_fmt/);
  const board = read('templates', 'leaderboard.wxml');
  assert.match(board, /class="lb-alt">{{item\.alt_view}}/);
  assert.match(board, /me\.alt_view/);
});

const analysisResult = (extra = {}) => ({
  scope: 'public', dimension: 'tools', period: 'week', from: '2026-10-23', to: '2026-10-29', trend_days: 7, has_overlap: false,
  summary: { tokens: 5000, requests: 20, users: 3, breakdown_tokens: 5000, credits: 42.5 },
  items: [{ name: 'Qoder', tokens: 3000, percent: 60, users: 2, preferred_users: 1, credits: 42.5 },
    { name: 'Codex', tokens: 2000, percent: 40, users: 1, preferred_users: 1, credits: 0 }],
  daily: [{ day: '2026-10-29', tokens: 5000, requests: 20, credits: 42.5, reported: true, reported_users: 2,
    parts: [{ name: 'Qoder', tokens: 3000, credits: 42.5 }] }],
  credits: { scope: 'tools', total: 42.5 }, ...extra,
});

test('分析页与广场环形图：工具维度带 Credits，模型维度不编造', () => {
  const tools = presentAnalysis(analysisResult());
  assert.equal(tools.creditsAvailable, true);
  assert.equal(tools.creditsText, '42.5');
  assert.equal(tools.items.find(item => item.name === 'Qoder').creditsText, '42.5');
  assert.equal(tools.items.find(item => item.name === 'Codex').creditsText, '');
  assert.equal(tools.daily[0].creditsText, '42.5');
  const models = presentAnalysis(analysisResult({ dimension: 'models', credits: { scope: 'unavailable', total: 42.5 },
    items: [{ name: 'GPT', tokens: 5000, percent: 100, users: 3, preferred_users: 3 }],
    daily: [{ day: '2026-10-29', tokens: 5000, requests: 20, reported: true, reported_users: 2, parts: [] }] }));
  assert.equal(models.creditsAvailable, false);
  assert.equal(models.creditsText, '');
  assert.equal(models.items[0].creditsText, '');
  assert.equal(models.daily[0].creditsText, '');
});

// 新采集器（0.2.24 + Trae 扩展 0.1.0）上报 credits.models 后，模型维度按真实分项展示
test('模型维度有积分分项时按分项展示，缺失时仍标注原因', () => {
  const models = presentAnalysis(analysisResult({ dimension: 'models', credits: { scope: 'models', total: 30 },
    summary: { tokens: 5000, requests: 20, users: 3, breakdown_tokens: 5000, credits: 30 },
    items: [{ name: 'GLM-5.3', tokens: 4000, percent: 80, users: 2, preferred_users: 2, credits: 30 },
      { name: 'auto', tokens: 1000, percent: 20, users: 1, preferred_users: 1, credits: 0 }],
    daily: [{ day: '2026-10-29', tokens: 5000, requests: 20, credits: 30, reported: true, reported_users: 2,
      parts: [{ name: 'GLM-5.3', tokens: 4000, credits: 30 }] }] }));
  assert.equal(models.creditsAvailable, true);
  assert.equal(models.creditsText, '30');
  assert.equal(models.items.find(item => item.name === 'GLM-5.3').creditsText, '30');
  assert.equal(models.daily[0].creditsText, '30');
});

test('趋势榜：工具项带积分与合计，模型项不显示积分', () => {
  const entry = { rank: 1, name: 'Qoder', users: 2, tokens: 3000, percent: 60, credits: 42.5,
    previous_rank: null, previous_users: null, previous_tokens: null, previous_credits: null, rank_change: null };
  const tools = trendsView({ period: 'week', dimension: 'tools', metric: 'users', from: 'a', to: 'b',
    summary: { users: 3, credits: 42.5 }, previous_summary: { users: 2 }, credits: { scope: 'tools', total: 42.5 }, entries: [entry] });
  assert.equal(tools.creditsAvailable, true);
  assert.equal(tools.creditsText, '42.5');
  assert.equal(tools.entries[0].creditsText, '42.5');
  const models = trendsView({ period: 'week', dimension: 'models', metric: 'tokens', from: 'a', to: 'b',
    summary: { users: 3 }, previous_summary: { users: 2 }, credits: { scope: 'unavailable', total: 42.5 },
    entries: [{ ...entry, credits: undefined }] });
  assert.equal(models.creditsAvailable, false);
  assert.equal(models.entries[0].creditsText, '');
});

test('飞书网页应用：我的用量、群榜统计与群内行都带 Credits', () => {
  const app = fs.readFileSync(path.resolve(root, '../server/public/app/app.js'), 'utf8');
  assert.match(app, /累计 Credits/);
  assert.match(app, /本期 Credits/);
  assert.match(app, /Credits 计费工具/);
  assert.match(app, /creditsBlock\(usage\.credits\)/);
  assert.match(app, /class="l3"/);
  // 广场环形图与工具分布同样带积分；模型维度给出说明而不是 0；新增 Credits 饼图与 Tokens 饼并排
  assert.match(app, /d\.credits\.scope === dimension/);
  assert.match(app, /donut-row/);
  assert.match(app, /该维度暂无积分明细/);
  const css = fs.readFileSync(path.resolve(root, '../server/public/app/app.css'), 'utf8');
  assert.match(css, /\.stats\.dense \{ display: grid/);
  assert.match(css, /\.group-row \.l3/);
  assert.match(css, /\.donut-row/);
  assert.match(css, /\.donut-empty/);
});

test('分析、广场与趋势榜标记同步展示 Credits', () => {
  const analysis = read('pages', 'analysis', 'analysis.wxml');
  assert.match(analysis, /\{\{report\.creditsText\}\} Credits/);
  assert.match(analysis, /\{\{item\.creditsText\}\} Credits/);
  assert.match(analysis, /selectedDay\.creditsText \+ ' Credits'/);
  assert.match(analysis, /该维度暂无积分分项/);
  const square = read('pages', 'square', 'square.wxml');
  assert.match(square, /\{\{insights\.creditsText\}\} Credits/);
  assert.match(square, /\{\{item\.creditsText\}\} Credits/);
  const trends = read('pages', 'trends', 'trends.wxml');
  assert.match(trends, /\{\{report\.creditsText\}\} Credits/);
  assert.match(trends, /\{\{item\.creditsText\}\} Credits/);
});
