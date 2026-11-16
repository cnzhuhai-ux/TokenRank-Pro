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

test('web integration keeps read-only achievements, genuine sharing guidance and Windows installation', () => {
  const app = readFileSync(new URL('../public/app/app.js', import.meta.url), 'utf8');
  const html = readFileSync(new URL('../public/app/index.html', import.meta.url), 'utf8');
  assert.ok(html.indexOf('/app/model.js') < html.indexOf('/app/app.js'));
  assert.doesNotMatch(app, /achievements\/(prepare|confirm|claim|release)/);
  assert.match(app, /install_command_windows/); assert.match(app, /Windows PowerShell/);
  assert.doesNotMatch(app, /onclick="return false"|分享图片/);
  assert.match(app, /consumeOAuthState/); assert.match(app, /crypto/);
  assert.match(app, /\/api\/my\/overview/); assert.match(app, /\/api\/my\/groups-overview/);
  assert.match(app, /\/api\/my\/analysis\?period=/); assert.match(app, /&bundle=1/);
});
