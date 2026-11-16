import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const source = fileURLToPath(new URL('../../miniprogram/assets/badges/', import.meta.url));
const target = fileURLToPath(new URL('../public/app/assets/badges/', import.meta.url));
test('飞书网页奖章与小程序 PNG 素材逐字节一致，没有遗失档位', () => {
  const files = readdirSync(source, { recursive: true }).filter(name => name.endsWith('.png')).sort();
  assert.ok(files.length >= 28);
  assert.deepEqual(readdirSync(target, { recursive: true }).filter(name => name.endsWith('.png')).sort(), files);
  for (const name of files) assert.deepEqual(readFileSync(join(target, name)), readFileSync(join(source, name)), name);
});
test('网页奖章静态白名单只开放受限 PNG 路径', () => {
  const code = readFileSync(new URL('../node-service.mjs', import.meta.url), 'utf8');
  const block = code.slice(code.indexOf('const STATIC_ALLOW = ['), code.indexOf('function staticFile'));
  const patterns = [...block.matchAll(/^\s*(\/.*\/[a-z]*),?$/gm)].map(match => Function('return ' + match[1])());
  const allowed = path => patterns.some(pattern => pattern.test(path));
  assert.equal(allowed('/app/assets/badges/terminal.png'), true);
  assert.equal(allowed('/app/assets/badges/tiers/usage-orbit-4.png'), true);
  for (const path of ['/app/assets/badges/../config.json', '/app/assets/badges/secret.json', '/app/assets/badges/x/y.png']) {
    assert.equal(allowed(path), false, path);
  }
});
