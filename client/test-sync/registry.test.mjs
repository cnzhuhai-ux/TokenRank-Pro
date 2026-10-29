import { test } from 'node:test';
import assert from 'node:assert/strict';

// 模块级 REGISTRY 在 import 时求值，用 query 强制重新加载以验证环境变量分支
const load = (query = '') => import(`../sync/upstream.js${query}`);

test('registryCandidates：默认 npmjs + 国内镜像回退；显式指定时只用指定源', async () => {
  delete process.env.TOKENRANK_REGISTRY;
  const a = await load('?case=default');
  assert.deepEqual(a.registryCandidates(), ['https://registry.npmjs.org/', 'https://registry.npmmirror.com/']);
  process.env.TOKENRANK_REGISTRY = 'https://npm.internal.example/';
  try {
    const b = await load('?case=explicit');
    assert.deepEqual(b.registryCandidates(), ['https://npm.internal.example/']);
  } finally {
    delete process.env.TOKENRANK_REGISTRY;
  }
});

test('resolveUpdate：npmjs 不可达时自动回退镜像，并回报所用 registry', async () => {
  delete process.env.TOKENRANK_REGISTRY;
  const { resolveUpdate } = await load('?case=fallback');
  const calls = [];
  const fetcher = async (url) => {
    calls.push(url);
    if (url.startsWith('https://registry.npmjs.org/')) throw new Error('ECONNREFUSED 127.0.0.1:53622');
    return Response.json({ name: 'token-watcher', version: '1.9.6' });
  };
  const target = await resolveUpdate(fetcher);
  assert.equal(target.version, '1.9.6');
  assert.equal(target.spec, 'token-watcher@1.9.6');
  assert.equal(target.registry, 'https://registry.npmmirror.com/');
  assert.equal(calls.length, 2);
  assert.ok(calls[0].startsWith('https://registry.npmjs.org/'));
});

test('resolveUpdate：两个源都失败时抛出最后一次错误', async () => {
  delete process.env.TOKENRANK_REGISTRY;
  const { resolveUpdate } = await load('?case=fail');
  let n = 0;
  const fetcher = async () => { n += 1; throw new Error(`down-${n}`); };
  await assert.rejects(() => resolveUpdate(fetcher), /down-2/);
});