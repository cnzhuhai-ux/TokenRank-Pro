import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const source = readFileSync(new URL('../public/app/model.js', import.meta.url), 'utf8');
const context = { module: { exports: {} }, URL, URLSearchParams, Date, Map, Set, Uint8Array };
vm.runInNewContext(source, context);
const M = context.module.exports;
const deferred = () => { let resolve, reject; const promise = new Promise((a,b) => { resolve=a; reject=b; }); return { promise, resolve, reject }; };

test('route validates deep links, dates, metrics and last_month and preserves parent context', () => {
  const route = M.parseRoute('#/group/abc123?period=last_month&metric=credits');
  assert.equal(route.name, 'group'); assert.equal(route.id, 'abc123'); assert.equal(route.period, 'last_month');
  assert.equal(M.parseRoute(M.routeHash(route)).metric, 'credits');
  assert.equal(M.parentRoute({ ...route, name: 'group-analysis' }).name, 'group');
  assert.equal(M.parentRoute(route).period, 'last_month');
  assert.equal(M.parseRoute('#/group/../../private').name, 'groups');
  assert.equal(M.parseRoute('#/me?day=2026-02-30&month=2026-13&metric=money&period=bad').day, '');
  assert.equal(M.parseRoute('#/me?month=2026-13').month, '');
  assert.equal(M.parseRoute('#/me').period, 'all');
  assert.equal(M.parseRoute('#/me?view=analysis').view, 'analysis');
  assert.equal(M.parseRoute('#/me?week=2026-11-15').week, '2026-11-09');
});

test('Beijing natural day boundary differs from UTC', () => {
  assert.equal(M.beijingDay(Date.parse('2026-11-15T15:59:59Z')), '2026-11-15');
  assert.equal(M.beijingDay(Date.parse('2026-11-15T16:00:00Z')), '2026-11-16');
});

test('cost preserves partial coverage and missing data; true priced zero stays available', () => {
  const unavailable = M.costView({ status: 'unavailable', usd_micros: 0, missing_days: 3 });
  assert.equal(unavailable.available, false); assert.match(unavailable.amount, /暂无/); assert.match(unavailable.note, /3 天/);
  const partial = M.costView({ status: 'partial', usd_micros: 1234500, unpriced_count: 2, missing_user_days: 4 });
  assert.equal(partial.amount, '$1.2345'); assert.equal(partial.label, '已计价部分'); assert.match(partial.note, /2 个模型/); assert.match(partial.note, /4 条/);
  assert.equal(M.costView({ status: 'available', usd_micros: 0 }).amount, '$0.0000');
  assert.equal(M.costView({ status: 'partial', usd_micros: null }).available, false);
});

test('heatmap distinguishes zero, missing, future, outside and retains daily cost details', () => {
  const map = M.heatmap({ month: '2026-11', today: '2026-11-03', daily: [
    { day: '2026-11-01', reported: true, tokens: 0 },
    { day: '2026-11-02', reported: true, tokens: 100, details: { cost: { status: 'partial', usd_micros: 0 } } },
    { day: '2026-11-03', reported: false, tokens: null } ] });
  const byDay = day => map.days.find(d => d.day === day);
  assert.equal(byDay('2026-11-01').statusText, '已同步 · 零用量');
  assert.equal(byDay('2026-11-02').level, 4);
  assert.equal(byDay('2026-11-02').details.cost.status, 'partial');
  assert.equal(byDay('2026-11-03').tokens, null);
  assert.equal(byDay('2026-11-04').future, true);
  assert.equal(byDay('2026-10-26').outside, true);
});

test('badge paths use only allowlisted original and tier art', () => {
  assert.equal(M.badgeArt({ family: 'requests', art: 'code-leaves', threshold: 100 }), '/app/assets/badges/tiers/code-leaves-1.png');
  assert.equal(M.badgeArt({ family: 'requests', art: 'code-leaves', threshold: 10000 }), '/app/assets/badges/code-leaves.png');
  assert.equal(M.badgeArt({ art: '../../secret' }), '');
});

test('pagination uses metric, group, offset and snapshot and refuses changed snapshots', () => {
  const path = new URL(M.boardPath({ id: 'abc', period: 'last_month', metric: 'credits' }, 50, 'a'.repeat(64)), 'http://local');
  assert.equal(path.searchParams.get('scope'), 'group'); assert.equal(path.searchParams.get('metric'), 'credits');
  assert.equal(path.searchParams.get('offset'), '50'); assert.equal(path.searchParams.get('snapshot'), 'a'.repeat(64));
  const first = { entries: [{ rank: 1 }, { rank: 2 }], snapshot: 'a', has_more: true, next_offset: 2 };
  const next = { entries: [{ rank: 2 }, { rank: 3 }], snapshot: 'a', has_more: false, next_offset: null };
  assert.equal(M.mergeBoard(first, next).entries.length, 3);
  assert.throws(() => M.mergeBoard(first, { ...next, snapshot: 'b' }), e => e.status === 409);
  assert.throws(() => M.mergeBoard(first, { ...next, has_more: true, next_offset: 2 }), /游标/);
});

test('cache deduplicates concurrent reads and canonical params for five minutes', async () => {
  let calls = 0, now = Date.parse('2026-11-15T00:00Z'); const work = deferred();
  const cache = M.createCache({ request: () => { calls++; return calls === 1 ? work.promise : { calls }; }, now: () => now });
  const first = cache.read('/api/test?period=day&metric=credits');
  const duplicate = cache.read('/api/test?metric=credits&period=day');
  assert.equal(first, duplicate); await Promise.resolve(); assert.equal(calls, 1);
  work.resolve({ value: 1 }); await first;
  now += 299999; await cache.read('/api/test?period=day&metric=credits'); assert.equal(calls, 1);
  now++; await cache.read('/api/test?period=day&metric=credits'); assert.equal(calls, 2);
  await cache.read('/api/test?period=week&metric=credits'); assert.equal(calls, 3);
});

test('cache separates accounts and Beijing days; rejects obsolete completion', async () => {
  let account = 'one', now = Date.parse('2026-11-15T15:59:59Z'), calls = 0;
  const old = deferred();
  const cache = M.createCache({ request: () => ++calls === 1 ? old.promise : { calls }, account: () => account, now: () => now });
  const first = cache.read('/api/me'); await Promise.resolve();
  account = 'two'; await cache.read('/api/me'); old.resolve({ private: 'one' });
  await assert.rejects(first, e => e.stale === true);
  assert.equal((await cache.read('/api/me')).calls, 2);
  now += 1000; assert.equal((await cache.read('/api/me')).calls, 3);
});

test('force refresh wins out-of-order requests; failed reads can retry', async () => {
  const old = deferred(), fresh = deferred(); let calls = 0;
  const cache = M.createCache({ request: () => ++calls === 1 ? old.promise : fresh.promise });
  const first = cache.read('/api/me'); await Promise.resolve();
  const second = cache.read('/api/me', { force: true }); await Promise.resolve();
  fresh.resolve({ revision: 2 }); await second; old.resolve({ revision: 1 });
  await assert.rejects(first, e => e.stale); assert.equal((await cache.read('/api/me')).revision, 2);
  let attempt = 0; const retry = M.createCache({ request: () => ++attempt === 1 ? Promise.reject(new Error('offline')) : 'ok' });
  await assert.rejects(retry.read('/api/me'), /offline/); assert.equal(await retry.read('/api/me'), 'ok');
});

test('route guard prevents old page callbacks from painting a new route', () => {
  const guard = M.createGuard(), first = guard.next(), second = guard.next();
  assert.equal(first(), false); assert.equal(second(), true); guard.invalidate(); assert.equal(second(), false);
});

test('OAuth state is cryptographic, required, exact and consumed once even on failure', () => {
  const map = new Map(), storage = { getItem: k => map.get(k), removeItem: k => map.delete(k) };
  const state = M.oauthState({ getRandomValues: array => { for (let i=0;i<array.length;i++) array[i]=i; return array; } });
  assert.equal(state.length, 48);
  map.set('tr_oauth_state', state); assert.equal(M.consumeOAuthState(storage, 'wrong'), false); assert.equal(map.size, 0);
  assert.equal(M.consumeOAuthState(storage, state), false);
  map.set('tr_oauth_state', state); assert.equal(M.consumeOAuthState(storage, state), true); assert.equal(M.consumeOAuthState(storage, state), false);
});

function appHarness({ responses = {}, fetcher } = {}) {
  const nodes = new Map(), storage = new Map([['tr_token', 'account-a']]), calls = [];
  const node = selector => { if (!nodes.has(selector)) nodes.set(selector, { isConnected: true, disabled: false, innerHTML: '', dataset: {}, classList: { toggle() {} }, setAttribute() {}, addEventListener() {}, querySelector: node, querySelectorAll: () => [], insertAdjacentHTML() {}, replaceChildren() {}, remove() {} }); return nodes.get(selector); };
  const document = { hidden: false, querySelector: node, querySelectorAll: () => [], body: node('body') };
  class Form { constructor(form) { this.values = Object.entries(form?.values || {}); } set(k, v) { this.values.push([k,v]); } [Symbol.iterator]() { return this.values[Symbol.iterator](); } }
  const ctx = { window: { TokenRankModel: M, TokenRankShare: { configure() {} } }, document, localStorage: { getItem: k => storage.get(k) ?? null, setItem: (k,v) => storage.set(k,v), removeItem: k => storage.delete(k) }, sessionStorage: {}, location: { origin: 'http://local', hash: '#/settings' }, history: {}, URL, URLSearchParams, Date, Map, Set, FormData: Form, console, setTimeout, clearTimeout, requestAnimationFrame: fn => fn(), matchMedia: () => ({ matches: false }), addEventListener() {}, crypto: { getRandomValues: a => a.fill(7) }, fetch: async (path, options) => { calls.push({path, ...options}); if (fetcher) return fetcher(path, options); return { ok: true, json: async () => responses[path] || {} }; } };
  let app = readFileSync(new URL('../public/app/app.js', import.meta.url), 'utf8');
  app = app.replace("  login().catch(error => loginMask('登录失败', error.message));", `  window.testApp = { request, read, cache, mutate, settings, email, subscriptions, reminders, playBadge, releaseDisplay, hero, analysisBlock, current: () => current, setToken: v => {token=v;}, setLease: v => {displayLease=v;}, setAlive: fn => {current=fn;}, setRoute: r => {route=r;} }; current=()=>true; route={name:'me',period:'week',dimension:'tools'};`);
  vm.runInNewContext(app, ctx);
  return { app: ctx.window.testApp, calls, nodes, node, ctx, storage, Form };
}

test('achievement image readiness and successful animation precede confirm; replay never confirms', async () => {
  const h = appHarness(), decoded = deferred(), sequence = [];
  const lease = { id: 'a'.repeat(32), expires_at: Date.now()+60000, identity:'account-a', confirmed:false };
  h.app.setLease(lease);
  const image = { isConnected: true, decode: () => decoded.promise, animate: () => { sequence.push('animate'); return { finished: Promise.resolve() }; } };
  const task = h.app.playBadge({}, image, () => true, lease);
  assert.equal(h.calls.length, 0); decoded.resolve(); await task;
  assert.deepEqual(sequence, ['animate']); assert.equal(lease.confirmed, true);
  assert.equal(h.calls[0].path, '/api/my/achievements/confirm');
  assert.equal(JSON.parse(h.calls[0].body).claim_id, lease.id);
  await h.app.playBadge({}, image, () => true); assert.equal(h.calls.length, 1);
});

test('achievement failed art, route departure and expired lease release without confirm', async () => {
  for (const mode of ['art', 'departed', 'expired']) {
    const h = appHarness(), lease = { id: 'b'.repeat(32), expires_at: mode === 'expired' ? 0 : Date.now()+60000, identity:'account-a' };
    h.app.setLease(lease);
    const image = { isConnected: true, decode: () => mode === 'art' ? Promise.reject(new Error('图片加载失败')) : Promise.resolve() };
    await h.app.playBadge({}, image, () => mode !== 'departed', lease);
    assert.equal(h.calls.length, 1, mode); assert.equal(h.calls[0].path, '/api/my/achievements/release');
  }
});

test('reduced motion still acknowledges a ready visible image, never starts animation', async () => {
  const h = appHarness(); h.storage.set('tr_reduce_motion','true');
  const lease = {id:'c'.repeat(32),expires_at:Date.now()+60000,identity:'account-a'}; h.app.setLease(lease);
  await h.app.playBadge({}, {isConnected:true,decode:async()=>{},animate:()=>{throw new Error('must not animate');}},()=>true,lease);
  assert.equal(h.calls[0].path,'/api/my/achievements/confirm');
});

test('writes invalidate old pending reads both before dispatch and after completion', async () => {
  const old = deferred();
  const h = appHarness({fetcher: async (path, options) => path === '/api/slow' ? old.promise : {ok:true,json:async()=>({saved:true})}});
  const pending = h.app.read('/api/slow'); await Promise.resolve();
  await h.app.request('/api/profile/ranking',{method:'POST',body:{hidden:true}});
  old.resolve({ok:true,json:async()=>({private:'old'})}); await assert.rejects(pending,e=>e.stale);
  assert.equal(h.calls[1].credentials,'omit'); assert.equal(h.calls[1].headers.authorization,'Bearer account-a');
});

test('account switch and route departure prevent mutation callbacks; denied writes preserve identity', async () => {
  const work = deferred(), h = appHarness(); let painted=0;
  const task = h.app.mutate({disabled:false,isConnected:true},()=>work.promise,()=>painted++);
  h.app.setToken('account-b'); work.resolve(); await task; assert.equal(painted,0);
  const rejected = appHarness({fetcher:async()=>({ok:false,status:403,json:async()=>({error:'无权限'})})});
  await assert.rejects(rejected.app.request('/api/profile',{method:'POST',body:{}}),e=>e.status===403);
  assert.equal(rejected.storage.get('tr_token'),'account-a');
});

test('email form posts consent and expected revision and does not imply mail delivery', async () => {
  const status={registered:true,email:'a@example.com',revision:'d'.repeat(32),consent_version:'email-daily-registration-v1'};
  const h=appHarness({responses:{'/api/email-registration':status}}); await h.app.email(()=>true);
  const form=h.node('#email-form'); form.elements={email:{value:'b@example.com'},consent:{checked:true}};
  form.onsubmit({preventDefault(){},currentTarget:form}); await new Promise(r=>setTimeout(r,0));
  const call=h.calls.find(c=>c.method==='POST'); assert.ok(call);
  const body=JSON.parse(call.body); assert.equal(body.expected_revision,status.revision); assert.equal(body.consent,true); assert.equal(body.email,'b@example.com');
  assert.match(h.node('#body').innerHTML,/不会发送日报邮件/);
});

test('Feishu reminder reservation needs no wx permission and DELETE carries appointment id', async () => {
  const h=appHarness({responses:{'/api/reminders':{channel:'feishu',authorization_required:false,has_reported:true,kinds:[{key:'daily',label:'日报',available:true,appointment:{id:'e'.repeat(24),state:'pending'}}]}}});
  await h.app.reminders(()=>true);
  assert.match(h.node('#body').innerHTML,/data-reserve="daily"/);
  const b={dataset:{reserve:'daily'},disabled:false,isConnected:true};
  h.node('#body').onclick({target:{closest:()=>b}}); await new Promise(r=>setTimeout(r,0));
  const call=h.calls.find(c=>c.method==='POST'); assert.match(JSON.parse(call.body).request_id,/^[a-f0-9]{48}$/);
  const cancel={dataset:{cancelReminder:'daily',id:'e'.repeat(24)},disabled:false,isConnected:true};
  h.node('#body').onclick({target:{closest:()=>cancel}}); await new Promise(r=>setTimeout(r,0));
  assert.equal(JSON.parse(h.calls.find(c=>c.method==='DELETE').body).id,'e'.repeat(24));
});

test('ledger submits major-unit prices, custom days and active status without ended_day', async () => {
  const h=appHarness({responses:{'/api/subscriptions':{items:[],topups:[]}}}); await h.app.subscriptions(()=>true);
  h.node('#body').onclick({target:{closest:()=>({dataset:{ledgerNew:'subscriptions'}})}});
  const form=h.node('#ledger-form');
  form.values={name:'测试服务',plan:'Pro',price:'12.34',currency:'USD',cycle:'custom',custom_days:'17',start_day:'2026-11-01',status:'active',ended_day:'2026-11-16',notes:''};
  form.elements={api_key:{checked:true}};
  form.onsubmit({preventDefault(){},currentTarget:form}); await new Promise(r=>setTimeout(r,0));
  const body=JSON.parse(h.calls.find(c=>c.path==='/api/subscriptions'&&c.method==='POST').body);
  assert.equal(body.price,12.34);assert.equal(body.custom_days,17);assert.equal(body.api_key,true);assert.equal(Object.hasOwn(body,'ended_day'),false);
});

test('topup form posts a real zero balance and preserves vendor and currency', async () => {
  const h=appHarness({responses:{'/api/subscriptions':{items:[],topups:[]}}});await h.app.subscriptions(()=>true);
  h.node('#body').onclick({target:{closest:()=>({dataset:{ledgerNew:'topups'}})}});
  const form=h.node('#ledger-form');form.values={vendor:'deepseek',kind:'balance',amount:'0',currency:'CNY',day:'2026-11-16',notes:'余额校准'};
  form.onsubmit({preventDefault(){},currentTarget:form});await new Promise(r=>setTimeout(r,0));
  const body=JSON.parse(h.calls.find(c=>c.path==='/api/topups'&&c.method==='POST').body);
  assert.equal(body.amount,0);assert.equal(body.vendor,'deepseek');assert.equal(body.kind,'balance');assert.equal(body.currency,'CNY');
});

test('web integration wires sharing, two-phase achievements and Windows installation', () => {
  const app = readFileSync(new URL('../public/app/app.js', import.meta.url), 'utf8');
  const html = readFileSync(new URL('../public/app/index.html', import.meta.url), 'utf8');
  assert.ok(html.indexOf('/app/model.js') < html.indexOf('/app/app.js'));
  for (const action of ['prepare', 'confirm', 'release']) assert.ok(app.includes('/api/my/achievements/' + action));
  assert.doesNotMatch(app, /achievements\/claim/);
  assert.ok(app.includes('await image.decode()'));
  assert.ok(app.includes('calendar_snapshot: data.snapshot'));
  assert.ok(app.includes("options.show_amount = !!$('#share-amount')?.checked"));
  assert.match(app, /install_command_windows/); assert.match(app, /Windows PowerShell/);
  assert.doesNotMatch(app, /onclick="return false"|分享图片/);
  assert.match(app, /consumeOAuthState/); assert.match(app, /crypto/);
  assert.match(app, /\/api\/my\/overview/); assert.match(app, /\/api\/my\/groups-overview/);
  assert.match(app, /\/api\/my\/analysis\?period=/); assert.match(app, /&bundle=1/);
});
