import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/worker.js';

const preflight = (origin, env = {}) => worker.fetch(new Request('https://rank.test/api/me', {
  method: 'OPTIONS',
  headers: origin ? { origin } : {},
}), env);

test('默认不下发 CORS 通配符', async () => {
  const res = await preflight('https://evil.test');
  assert.equal(res.status, 204);
  assert.equal(res.headers.get('access-control-allow-origin'), null);
});

test('CORS_ORIGIN 精确匹配才放行', async () => {
  const env = { CORS_ORIGIN: 'https://ok.test, https://also.test' };
  assert.equal((await preflight('https://ok.test', env)).headers.get('access-control-allow-origin'), 'https://ok.test');
  assert.equal((await preflight('https://also.test', env)).headers.get('access-control-allow-origin'), 'https://also.test');
  assert.equal((await preflight('https://evil.test', env)).headers.get('access-control-allow-origin'), null);
});

test('预检响应带安全头', async () => {
  const res = await preflight('https://ok.test');
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(res.headers.get('x-frame-options'), 'DENY');
  assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
});
