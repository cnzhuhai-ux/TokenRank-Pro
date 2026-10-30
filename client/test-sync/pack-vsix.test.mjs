import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { pack, readEntries, manifestXml } = require('../scripts/pack-vsix.mjs');
// zip 结构由 Trae 内置的 yauzl 读取，这里用中央目录解析 + 关键字段自校验；
// 真机安装验收在构建后用服务端分发的 VSIX 跑 trae-cn --install-extension。

test('pack-vsix：条目齐全、manifest 版本一致、两次打包逐字节可复现', (t) => {
  t.after(() => rmSync(join(tmpdir(), 'pack-vsix-test'), { recursive: true, force: true }));
  const pkg = JSON.parse(readFileSync(new URL('../trae-extension/package.json', import.meta.url), 'utf8'));
  assert.match(manifestXml(), new RegExp(`<Identity[^>]*Version="${pkg.version.replace(/\./g, '\\.')}"`));
  const out = join(tmpdir(), 'pack-vsix-test');
  const a = pack({ outDir: join(out, 'a') });
  const b = pack({ outDir: join(out, 'b') });
  // 产物名与条目
  assert.equal(a.version, pkg.version);
  assert.ok(a.file.endsWith(`trae-credits-poc-${pkg.version}.vsix`));
  assert.deepEqual([...a.entries].sort(), ['[Content_Types].xml', 'extension.vsixmanifest',
    'extension/README.md', 'extension/extension.js', 'extension/model-resolve.cjs', 'extension/package.json'].sort());
  // zip 魔数与中央目录可读
  assert.equal(readFileSync(a.file).subarray(0, 2).toString('hex'), '504b');
  assert.equal(readEntries(readFileSync(a.file)).length, 6);
  // 固定时间戳：同源码两次打包逐字节一致（published_at 在 latest.json，不在 zip 内）
  assert.equal(readFileSync(a.file).equals(readFileSync(b.file)), true);
  // latest.json 指针指向该版本并带校验和
  const latest = JSON.parse(readFileSync(join(out, 'a', '..', 'latest.json'), 'utf8'));
  assert.equal(latest.version, pkg.version);
  assert.equal(latest.sha256, a.sha256);
  assert.match(latest.vsix, new RegExp(`^/dl/trae-extension/${pkg.version}/trae-credits-poc-`));
});
