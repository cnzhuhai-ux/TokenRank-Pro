import { mkdtempSync, mkdirSync, copyFileSync, existsSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { inspectUpstream } from './upstream.js';
import { readDays } from './source.js';
const exec = promisify(execFile);

/** Reuse upstream pricing in an offline child; its cache writes stay in a disposable home. */
export async function readCostedDays(path, { entry, now = Date.now(), log = () => {} } = {}) {
  const original = inspectUpstream(entry);
  if (!original || !existsSync(join(original.root, 'src/pricing.js'))) return readDays(path, { now, log });
  const home = mkdtempSync(join(tmpdir(), 'tokenrank-pricing-'));
  try {
    const cache = join(home, '.tokenmeter'); mkdirSync(cache);
    for (const name of ['pricing.json', 'litellm-prices.json', 'fx-cache.json']) {
      const source = join(dirname(path), name);
      if (existsSync(source)) copyFileSync(source, join(cache, name));
    }
    const { stdout, stderr } = await exec(process.execPath,
      ['--no-warnings', join(import.meta.dirname, 'cost-worker.js'), original.root, path, String(now)], {
        env: { ...process.env, HOME: home, USERPROFILE: home, TOKENMETER_OFFLINE: '1', TOKENRANK_OFFLINE: '1', TZ: 'Asia/Shanghai' },
        timeout: 60000, maxBuffer: 32 * 1024 * 1024,
      });
    // 子进程把 readDays 的口径/告警日志写到 stderr（stdout 只承载 JSON 结果），这里中继给调用方，
    // 否则 Qoder 网关口径提示与「超出上报协议范围」警告永远不会被用户看到
    for (const line of String(stderr).split('\n')) {
      const message = line.trim();
      if (message) log(message.startsWith('[tokenrank] ') ? message.slice('[tokenrank] '.length) : message);
    }
    const days = JSON.parse(stdout);
    if (!Array.isArray(days)) throw new Error('invalid costs');
    return days;
  } catch {
    // Missing/incompatible pricing must not stop ordinary token uploads or look like a $0 bill.
    log('金额估算暂不可用，本次仅同步 Token 用量。');
    return readDays(path, { now, log });
  } finally { rmSync(home, { recursive: true, force: true }); }
}
