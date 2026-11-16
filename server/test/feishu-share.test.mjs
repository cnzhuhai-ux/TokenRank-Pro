import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import vm from 'node:vm';
import worker from '../src/worker.js';
import { requestFixture } from './helpers/request-fixture.mjs';
import { beijingDay, beijingDaysAgo } from '../src/lib.js';

const source = name => readFileSync(new URL('../public/app/' + name, import.meta.url), 'utf8');
const id = '0123456789abcdef01234567';
// Matches createShare/readShare: usage for personal styles, report for group-insights,
// comparison.source for public PK; calendar shares whitelist usage.calendar.
const record = (style = 'usage') => ({ id, style, expires_at: Date.now() + 86400000, user: { nickname: '<script>safe</script>' }, usage: { from: '2026-11-01', to: '2026-11-16', summary: { tokens: 1000, requests: 10, active_days: 2 }, tools: [{ name: 'Claude', tokens: 1000, percent: 100 }] } });
class Element {
  constructor(tag, doc) { this.tagName = tag; this.ownerDocument = doc; this.children = []; this.listeners = {}; this.attributes = {}; this._text = ''; }
  set textContent(value) { this._text = String(value); this.children = []; }
  get textContent() { return this._text + this.children.map(c => c.textContent).join(''); }
  append(...nodes) { for (const node of nodes) { this.children.push(node); node.parentNode = this; } }
  appendChild(node) { this.append(node); return node; }
  replaceChildren(...nodes) { for (const node of this.children) node.parentNode = null; this.children = []; this._text = ''; this.append(...nodes); }
  setAttribute(key, value) { this.attributes[key] = value; }
  addEventListener(name, fn) { this.listeners[name] = fn; }
  async click() { this.clicked = true; return this.listeners.click?.(); }
  select() { this.selected = true; }
  remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(c => c !== this); this.parentNode = null; }
}
function harness() {
  const draws = [], urls = [], nodes = [], fetches = [], requests = [], timers = [];
  const ctx = new Proxy({ measureText: s => ({ width: s.length * 12 }) }, { get(target, key) { return key in target ? target[key] : (...args) => draws.push([key, ...args]); } });
  const doc = { createElement(tag) { const el = new Element(tag, doc); nodes.push(el); if (tag === 'canvas') { el.getContext = () => ctx; el.toBlob = cb => cb(new Blob(['png'], { type: 'image/png' })); } return el; } }; doc.body = doc.createElement('body');
  class BrowserURL extends URL { static createObjectURL(blob) { urls.push(blob); return 'blob:test'; } static revokeObjectURL(url) { urls.push(url); } }
  const sandbox = { URL: BrowserURL, Blob, AbortController, document: doc, location: new URL('https://local.test/app/'), navigator: {}, setTimeout(fn) { timers.push(fn); return timers.length; }, clearTimeout() {}, confirm: () => true,
    async fetch(path, options) { fetches.push([path, options]); return { ok: true, json: async () => record() }; } };
  vm.createContext(sandbox);
  vm.runInContext(source('vendor/qrcode-generator-1.4.4.js'), sandbox);
  vm.runInContext(source('poster.js'), sandbox);
  vm.runInContext(source('share.js'), sandbox);
  sandbox.TokenRankShare.configure({ request: async (path, options = {}) => { requests.push([path, options]); return record(); } });
  return { root: sandbox, api: sandbox.TokenRankShare, poster: sandbox.TokenRankPoster, doc, draws, urls, nodes, fetches, requests, timers, container: () => doc.createElement('main') };
}
const all = (el, tag) => [el, ...el.children.flatMap(c => all(c, tag))].filter(e => e.tagName === tag);

test('private requests receive JSON objects; supplied snapshots are never refreshed, 409 preserved', async () => {
  const h = harness(); const snapshot = 'reviewed-snapshot';
  for (const [style, fields] of [['daily', { day: '2026-11-01', day_snapshot: snapshot }], ['weekly', { week: '2026-11-02', week_snapshot: snapshot }], ['milestone', { badge_id: 'total-1', achievement_snapshot: snapshot }]]) {
    await h.api.create({ style, ...fields });
    assert.equal(h.requests.at(-1)[0], '/api/shares');
    assert.deepEqual(JSON.parse(JSON.stringify(h.requests.at(-1)[1].body)), { style, period: 'all', ...fields });
  }
  assert.equal(h.requests.length, 3);
  const conflict = Object.assign(new Error('changed'), { status: 409, code: 'DAY_CHANGED' });
  h.api.configure({ request: async () => { throw conflict; } });
  await assert.rejects(h.api.create({ style: 'daily', day: '2026-11-01', day_snapshot: snapshot }), e => e === conflict);
});
test('milestone/daily/weekly automatically obtain matching snapshots', async () => {
  const h = harness();
  h.api.configure({ request: async (path, options) => { h.requests.push([path, options]); if (path.includes('achievements')) return { snapshot: 'achievement', families: [{ badges: [{ id: 'locked', earned: false }, { id: 'earned', earned: true }] }] }; if (path.includes('daily')) return { snapshot: 'day' }; if (path.includes('weekly')) return { snapshot: 'week', weekly: { week_start: '2026-11-09' } }; return record(); } });
  await h.api.create({ style: 'milestone' }); assert.equal(h.requests.at(-1)[1].body.achievement_snapshot, 'achievement'); assert.equal(h.requests.at(-1)[1].body.badge_id, 'earned');
  await h.api.create({ style: 'daily', day: '2026-11-16' }); assert.equal(h.requests.at(-1)[1].body.day_snapshot, 'day');
  await h.api.create({ style: 'weekly' }); assert.equal(h.requests.at(-1)[1].body.week_snapshot, 'week'); assert.equal(h.requests.at(-1)[1].body.week, '2026-11-09');
});
test('calendar POST contract is minimal and never includes costs by default', async () => {
  const h = harness();
  await h.api.create({ style: 'calendar', month: '2026-11', snapshot: 'private', cost: { usd_micros: 42 }, show_amount: 'true' });
  assert.deepEqual(JSON.parse(JSON.stringify(h.requests.at(-1)[1].body)), { style: 'calendar', month: '2026-11' });
  await h.api.create({ style: 'calendar', month: '2026-11', calendar_snapshot: 'reviewed', show_amount: true });
  assert.deepEqual(JSON.parse(JSON.stringify(h.requests.at(-1)[1].body)), { style: 'calendar', month: '2026-11', calendar_snapshot: 'reviewed', show_amount: true });
  await assert.rejects(h.api.create({ style: 'calendar', month: '2026-13' }));
});
test('group-insights sends snapshot and compare/revoke use private POST', async () => {
  const h = harness(); await h.api.create({ style: 'group-insights', group_id: 'abc123', period: 'week', snapshot: 'reviewed' });
  assert.equal(h.requests[0][0], '/api/groups/abc123/insights/share'); assert.equal(h.requests[0][1].body.snapshot, 'reviewed');
  await h.api.compare(id); await h.api.revoke(id);
  assert.equal(h.requests[1][0], `/api/shares/${id}/compare`); assert.equal(h.requests[2][0], `/api/shares/${id}/revoke`); assert.ok(h.requests.every(([, o]) => o.method === 'POST'));
});
test('public read always bypasses authenticated request, omits credentials and caching', async () => {
  const h = harness(); await h.api.read(id);
  assert.equal(h.requests.length, 0); assert.equal(h.fetches[0][1].credentials, 'omit'); assert.equal(h.fetches[0][1].cache, 'no-store'); assert.equal(h.fetches[0][1].headers.Authorization, undefined);
  h.root.fetch = async () => ({ ok: true, json: async () => ({ ...record(), expires_at: 1 }) }); await assert.rejects(h.api.read(id), /过期/);
  h.root.fetch = async () => ({ ok: false, status: 404, json: async () => ({}) }); await assert.rejects(h.api.read(id), e => e.status === 404);
});
test('origin baseUrl produces app route, link fallback, system cancellation and unsupported sharing', async () => {
  const h = harness(); h.api.configure({ baseUrl: 'https://local.test' }); assert.equal(h.api.link(id), `https://local.test/app/#/share/${id}`);
  assert.equal((await h.api.share(id)).copied, false);
  h.root.navigator.clipboard = { async writeText(text) { assert.match(text, /#\/share\//); } }; assert.equal((await h.api.share(id)).copied, true);
  h.root.navigator.share = async () => { throw Object.assign(new Error(), { name: 'AbortError' }); }; assert.equal((await h.api.share(id)).cancelled, true);
  h.root.navigator.share = async () => { throw new Error('not supported'); }; assert.equal((await h.api.share(id)).copied, true);
});
test('render uses text nodes, real actions, cancellation, revoke, errors and safe route mounts', async () => {
  const h = harness(), container = h.container();
  h.api.render(container, record(), { owner: true, onCompare: () => {} });
  assert.match(container.textContent, /<script>safe<\/script>/); assert.equal(all(container, 'script').length, 0);
  const buttons = all(container, 'button'); assert.equal(buttons.length, 5);
  await buttons[0].click(); assert.match(container.textContent, /浏览器未允许自动复制/); assert.equal(all(container, 'input')[0].value, h.api.link(id));
  await buttons[4].click(); assert.match(container.textContent, /分享已撤销/); assert.equal(all(container, 'button').length, 0);
  h.root.fetch = async () => ({ ok: false, status: 404, json: async () => ({}) });
  await h.api.mountRoute(container, id); assert.match(container.textContent, /失效/);
  let resolve; h.root.fetch = () => new Promise(r => { resolve = r; }); const pending = h.api.mountRoute(container, id);
  h.api.renderTransient(container, { usage: { summary: { tokens: 70 } }, comparison: { source: { user: { nickname: 'secret' }, usage: { summary: { tokens: 40 } } } } });
  resolve({ ok: true, json: async () => record() }); await pending; assert.match(container.textContent, /70/); assert.match(container.textContent, /30/); assert.doesNotMatch(container.textContent, /secret/); assert.equal(all(container, 'button').length, 0);
});
test('render calendar distinguishes missing/zero/future and explicit amount consent', () => {
  const h = harness(), c = h.container(), r = record('calendar');
  r.usage.calendar = { month: '2026-11', show_amount: false, daily: [{ day: '2026-11-01', reported: false }, { day: '2026-11-02', reported: true, tokens: 0, details: { cost: { usd_micros: 1000000 } } }, { day: '2026-11-30', future: true }] };
  h.api.render(c, r); assert.match(c.textContent, /未同步/); assert.match(c.textContent, /零用量/); assert.match(c.textContent, /未来日期/); assert.doesNotMatch(c.textContent, /\$1/);
  r.usage.calendar.show_amount = true; h.api.render(c, r); assert.match(c.textContent, /\$1\.0000/);
});
test('poster actual group analytics.items/public comparison shapes and missing cost are rendered', async () => {
  const h = harness(), group = { ...record('group-insights'), report: { group: { name: '测试群' }, summary: { tokens: 900, active_users: 2 }, tools: { items: [{ name: 'Codex', tokens: 900, percent: 100 }] }, cost: { status: 'unavailable', usd_micros: null } } };
  const view = h.poster.describe(group); assert.ok(view.lines.some(([label]) => label === 'Codex')); assert.match(JSON.stringify(view), /暂无费用记录/); assert.doesNotMatch(JSON.stringify(view), /\$0/);
  const pk = record('comparison'); pk.comparison = { source: { user: { nickname: '公开对象' }, usage: { summary: { tokens: 400 } } } };
  assert.match(JSON.stringify(h.poster.describe(pk)), /600/);
  await h.poster.create(group, h.api.link(id), { skipAvatar: true }); assert.ok(h.draws.some(d => d[0] === 'fillText' && d[1] === 'Codex')); assert.ok(h.draws.filter(d => d[0] === 'fillRect').length > 100);
});
test('download really creates PNG Blob, clicks download, revokes URL; revoked shares never export', async () => {
  const h = harness(); const result = await h.api.download(id);
  assert.equal(result.downloaded, true); assert.equal(h.fetches.length, 2); assert.equal(h.urls[0].type, 'image/png');
  const a = h.nodes.find(el => el.tagName === 'a'); assert.equal(a.clicked, true); assert.equal(a.download, `tokenrank-usage-${id}.png`); h.timers.forEach(fn => fn()); assert.ok(h.urls.includes('blob:test'));
  const second = harness(); second.root.fetch = async () => ({ ok: second.fetches.push(1) === 1, status: 404, json: async () => record() });
  await assert.rejects(second.api.download(id)); assert.equal(second.nodes.some(el => el.tagName === 'a'), false);
});
test('transient cannot be shared or downloaded even with an injected public ID', async () => {
  const h = harness(), r = { ...record('comparison'), transient: true }; assert.throws(() => h.api.link(r), /临时/); await assert.rejects(h.api.download(r)); await assert.rejects(h.api.share(r)); await assert.rejects(h.poster.create(r, h.api.link(id)));
  const c = h.container(); h.api.render(c, r, { owner: true }); assert.equal(all(c, 'button').length, 0);
});
test('external avatar is never fetched or drawn; Blob failure is actionable', async () => {
  const h = harness(); h.root.Image = class {}; assert.equal(await h.poster.avatar('https://foreign.test/avatar.png'), null); assert.equal(h.fetches.length, 0);
  await assert.rejects(h.poster.toBlob({ toBlob() { throw new Error('tainted'); } }), /复制链接/); await assert.rejects(h.poster.toBlob({ toBlob(cb) { cb(null); } }), /导出失败/);
});
test('milestone stage path mirrors miniprogram threshold lookup; actual badge is drawn', async () => {
  const h = harness(), r = record('milestone'); r.usage.milestone = { family: 'total', art: 'usage-orbit', threshold: 1e8, label: '累计用量', current: 2e8, unit: 'Tokens' };
  assert.equal(h.poster.badgePath(r.usage.milestone), '/app/assets/badges/tiers/usage-orbit-1.png'); assert.equal(h.poster.badgePath({ art: '../secret' }), null);
  h.root.Image = class { set src(value) { if (value) this.onload(); } };
  h.root.fetch = async () => ({ ok: true, headers: new Headers({ 'content-type': 'image/png' }), blob: async () => new Blob(['badge']) });
  await h.poster.create(r, h.api.link(id), { skipAvatar: true }); assert.ok(h.draws.some(d => d[0] === 'drawImage' && d[4] === 420));
});
test('pinned local QR library parses, exports, generates complete matrices and retains license', () => {
  const h = harness(), text = source('vendor/qrcode-generator-1.4.4.js');
  assert.equal(Buffer.byteLength(text), 56694); assert.equal(createHash('sha256').update(text).digest('hex'), '18ae399f81182bc9de916e9c77b195df20cc58d6f2d55a62b085a299f1bf1780');
  assert.match(source('vendor/qrcode-generator-LICENSE.txt'), /MIT License/); assert.match(source('vendor/qrcode-generator-LICENSE.txt'), /Kazuhiko Arase/);
  const qr = h.root.qrcode(0, 'M'); qr.addData(h.api.link(id)); qr.make(); const size = qr.getModuleCount(); assert.ok(size >= 21); assert.equal(qr.isDark(0, 0), true); assert.equal(qr.isDark(6, 6), true); assert.equal(qr.isDark(1, 1), false);
});

test('real worker API records round-trip through create/read/render/download for every style', async t => {
  const f = requestFixture(t, worker, { groups: 1, users: 2 }), h = harness();
  f.seed(1, beijingDaysAgo(1), 123);
  h.api.configure({ request: async (path, options = {}) => {
    const result = await f.req(path, 1, options.body || (options.method === 'POST' ? {} : null));
    if (result.status >= 400) throw Object.assign(new Error(result.data.error), { status: result.status, code: result.data.code });
    return result.data;
  } });
  h.root.fetch = async (path, options) => {
    assert.equal(options.credentials, 'omit'); assert.equal(options.cache, 'no-store');
    const result = await f.req(path, null);
    return { ok: result.status < 400, status: result.status, json: async () => result.data };
  };
  const records = [];
  for (const style of ['usage', 'tools', 'receipt', 'daily', 'weekly', 'group-insights', 'milestone', 'calendar']) {
    const r = await h.api.create({ style, day: beijingDaysAgo(1), month: beijingDay().slice(0, 7), ...(style === 'group-insights' ? { group_id: 'g1', period: 'day' } : {}) });
    records.push(r);
    const container = h.container(); h.api.render(container, r);
    assert.ok(container.textContent.length > 20, style);
    assert.equal(all(container, 'button').some(b => b.textContent === '撤销分享'), false);
    if (style !== 'milestone') { const exported = await h.api.download(r, { blobOnly: true, skipAvatar: true }); assert.equal(exported.blob.type, 'image/png', style); }
    if (style === 'group-insights') assert.match(container.textContent, /Codex/);
    if (style === 'calendar') assert.equal(r.usage.calendar.show_amount, false);
  }
  const other = await f.req('/api/shares', 2, { style: 'usage', period: 'day' });
  assert.equal(other.status, 200);
  const pk = await h.api.compare(other.data);
  assert.ok(pk.comparison.source.usage.summary); const c = h.container(); h.api.render(c, pk); assert.match(c.textContent, /对方同口径用量/);
  await h.api.revoke(records[0]); await assert.rejects(h.api.read(records[0]), e => e.status === 404); await assert.rejects(h.api.copyLink(records[0]));
});
test('route alive guard prevents late mounts and inactive callbacks after navigation', async () => {
  const h = harness(), c = h.container(); let alive = true, resolve;
  h.root.fetch = () => new Promise(r => { resolve = r; });
  const pending = h.api.mountRoute(c, id, { onAlive: () => alive }); alive = false;
  resolve({ ok: true, json: async () => record() }); await pending; assert.equal(all(c, 'button').length, 0);
  h.api.render(c, record(), { onAlive: () => alive }); await all(c, 'button')[0].click(); assert.equal(h.requests.length, 0);
});
test('91-day fallback calendar exports every cell above the QR footer', async () => {
  const h = harness(), r = record('calendar'); r.usage.calendar = { heatmap: { daily: Array.from({ length: 91 }, (_, i) => ({ day: 'day-' + i, reported: true, tokens: i })) } };
  const canvas = await h.poster.create(r, h.api.link(id), { skipAvatar: true });
  const labels = h.draws.filter(d => d[0] === 'fillText'); assert.ok(labels.some(d => d[1] === '90'));
  const last = labels.find(d => d[1] === '90'); assert.ok(last[3] < canvas.height - 280);
  const container = h.container(); h.api.render(container, r); assert.equal(all(container, 'tr').length, 91);
});
