const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const usage = require('../utils/usage');
const { presentEntries, presentMe } = require('../utils/leaderboard');

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

test('飞书网页应用：我的用量、群榜统计与群内行都带 Credits', () => {
  const app = fs.readFileSync(path.resolve(root, '../server/public/app/app.js'), 'utf8');
  assert.match(app, /累计 Credits/);
  assert.match(app, /本期 Credits/);
  assert.match(app, /Credits 计费工具/);
  assert.match(app, /creditsBlock\(usage\.credits\)/);
  assert.match(app, /class="l3"/);
  const css = fs.readFileSync(path.resolve(root, '../server/public/app/app.css'), 'utf8');
  assert.match(css, /\.stats\.dense \{ display: grid/);
  assert.match(css, /\.group-row \.l3/);
});
