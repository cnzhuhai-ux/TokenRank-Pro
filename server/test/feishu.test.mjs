import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import worker from '../src/worker.js';
import { beijingDay, beijingDaysAgo } from '../src/lib.js';
import {
  createFeishuService, parseCommand, formatTokens, feishuChatHash, feishuSignature, PERIOD_LABELS,
} from '../src/feishu.js';

const NOW = Date.parse('2026-10-28T12:00:00.000Z'); // 北京时间 20:00

function fixture(t) {
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  t.after(() => db.close());
  function prepare(sql) {
    let args = [];
    const params = () => Object.fromEntries(args.map((v, i) => [String(i + 1), v]));
    return { sql, bind(...values) { args = values; return this; },
      async first() { return db.prepare(sql).get(params()) ?? null; },
      async all() { return { results: db.prepare(sql).all(params()) }; },
      _run() { const r = db.prepare(sql).run(params()); return { meta: { changes: r.changes, last_row_id: Number(r.lastInsertRowid) } }; },
      async run() { return this._run(); } };
  }
  const DB = { prepare, async batch(stmts) {
    db.exec('BEGIN');
    try { const out = stmts.map((s) => s._run()); db.exec('COMMIT'); return out; }
    catch (err) { db.exec('ROLLBACK'); throw err; }
  } };
  const env = {
    FEISHU_APP_ID: 'cli_app', FEISHU_APP_SECRET: 'app-secret', FEISHU_VERIFICATION_TOKEN: 'v-token',
    PUBLIC_BASE_URL: 'https://rank.example.com', DB,
  };
  return { db, env };
}

/** 站内三位用户 + 一个绑定到 oc_group 的群榜；用户 3 在本群隐藏 */
async function seedGroupBoard(db) {
  const today = beijingDay(NOW);
  // specs: [id, 昵称, open_id, 今日 tokens, 一周前(6天前) tokens, 主力模型, 本群隐藏]
  const specs = [
    [1, '张三', 'ou_1', 3_000_000, 2_000_000, 'claude-sonnet-4.5', 0],
    [2, '李四', 'ou_2', 1_200_000, 800_000, 'gpt-5.2', 0],
    [3, '王五', 'ou_3', 5_000_000, 5_000_000, 'kimi-k2', 1],
  ];
  for (const [uid, nick, openId, todayTokens, weekTokens, model] of specs) {
    db.prepare('INSERT INTO users(id,openid,nickname,avatar_url,created_at,updated_at) VALUES(?,?,?,?,1,1)')
      .run(uid, `feishu:${openId}`, nick, `https://img.example/${uid}.png`);
    db.prepare('INSERT INTO connect_tokens(token,user_id,created_at) VALUES(?,?,1)').run(`ct-${uid}`, uid);
    db.prepare('INSERT INTO daily_totals(user_id,device_id,day,tokens,input_tokens,output_tokens,requests,cache_read,cache_write,models_json,tools_json,source_at,updated_at) VALUES(?,?,?,?,?,?,1,0,0,?,\'[["claude-code",600]]\',1,?)')
      .run(uid, `dev-${uid}`, today, todayTokens, Math.round(todayTokens / 2), Math.round(todayTokens / 2),
        JSON.stringify([[model, todayTokens]]), NOW - 60_000);
    db.prepare('INSERT INTO daily_totals(user_id,device_id,day,tokens,input_tokens,output_tokens,requests,cache_read,cache_write,models_json,tools_json,source_at,updated_at) VALUES(?,?,?,?,?,?,1,0,0,\'[]\',\'[]\',1,?)')
      .run(uid, `dev-${uid}`, beijingDaysAgo(6, NOW), weekTokens, 0, 0, NOW - 60_000);
    db.prepare('INSERT INTO usage_sync_state VALUES(?,?,1,?)').run(uid, `dev-${uid}`, NOW - 60_000);
  }
  const hash = await feishuChatHash('oc_group');
  db.prepare("INSERT INTO rank_groups(id,name,owner_user_id,created_at,group_openid_hash) VALUES('g1','飞书测试群',1,1,?)").run(hash);
  for (const [uid, , , , , , hidden] of specs) {
    db.prepare('INSERT INTO rank_group_members(group_id,user_id,joined_at,hidden) VALUES(?,?,1,?)').run('g1', uid, hidden);
  }
}

function fakeFeishuApi(log) {
  return async (url, init = {}) => {
    log.push({ url: String(url), body: init.body });
    if (String(url).includes('/auth/v3/tenant_access_token/internal')) {
      return Response.json({ code: 0, tenant_access_token: 't-token', expire: 7200 });
    }
    if (String(url).includes('/im/v1/chats/')) {
      return Response.json({ code: 0, data: { name: '飞书测试群' } });
    }
    if (String(url).includes('/contact/v3/users/')) {
      return Response.json({ code: 0, data: { user: { name: '张三', avatar: { avatar_240: 'https://img.example/new.png' } } } });
    }
    return Response.json({ code: 0, data: { message_id: 'om_out' } });
  };
}

const sentCards = (log) => log
  .filter((m) => m.url.includes('/im/v1/messages'))
  .map((m) => JSON.parse(JSON.parse(m.body).content));
const flat = (card) => {
  const out = [];
  const walk = (el) => {
    if (Array.isArray(el)) { el.forEach(walk); return; }
    if (!el || typeof el !== 'object') return;
    if (el.tag === 'markdown') out.push(el.content);
    if (el.tag === 'note') out.push(el.elements.map((x) => x.content).join(' '));
    if (el.tag === 'img') out.push('[头像]');
    walk(el.columns || []);
    if (el.tag !== 'note') walk(el.elements || []);
  };
  walk(card.body?.elements || []);
  return out.join('\n');
};
const sentTexts = (log) => sentCards(log).map(flat);
const sentTitles = (log) => sentTexts(log).map((t) => (t.match(/^### (.+)$/m) || [])[1] || '');

function messageEvent({ openId = 'ou_1', chatId = 'oc_group', chatType = 'group', text = '榜单', eventId = 'evt-1', createTime = NOW, token = 'v-token' } = {}) {
  return {
    header: { event_id: eventId, event_type: 'im.message.receive_v1', token, app_id: 'cli_app' },
    event: {
      sender: { sender_id: { open_id: openId, union_id: 'un-' + openId }, sender_type: 'user' },
      message: {
        message_id: 'om_in', chat_id: chatId, chat_type: chatType, message_type: 'text',
        content: JSON.stringify({ text }), create_time: String(createTime),
      },
    },
  };
}

async function fire(service, env, event) {
  const request = new Request('https://rank.example.com/feishu/event', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(event),
  });
  const res = await service.handle(request, env); // 不传 ctx：内部同步 await，测试可断言副作用
  assert.equal(res.status, 200);
}

// ───────────────────────────── 纯函数 ─────────────────────────────

test('formatTokens 中文计量单位（与小程序端一致）', () => {
  assert.equal(formatTokens(0), '0');
  assert.equal(formatTokens(999), '999');
  assert.equal(formatTokens(1234), '1,234');
  assert.equal(formatTokens(45_600), '4.56 万');
  assert.equal(formatTokens(3_000_000), '300 万');
  assert.equal(formatTokens(1_115_000), '111.5 万');
  assert.equal(formatTokens(1.5e9), '15.00 亿');
});

test('parseCommand 识别中英文命令与周期参数', () => {
  assert.deepEqual(parseCommand('榜单'), { cmd: 'rank', period: 'day' });
  assert.deepEqual(parseCommand('榜单 本周'), { cmd: 'rank', period: 'week' });
  assert.deepEqual(parseCommand('榜单本月'), { cmd: 'rank', period: 'month' });
  assert.deepEqual(parseCommand('rank all'), { cmd: 'rank', period: 'all' });
  assert.deepEqual(parseCommand('@_user_1 榜单'), { cmd: 'rank', period: 'day' });
  assert.deepEqual(parseCommand('  /帮助 '), { cmd: 'help' });
  assert.deepEqual(parseCommand('绑定'), { cmd: 'bind' });
  assert.deepEqual(parseCommand('connect'), { cmd: 'bind' });
  assert.deepEqual(parseCommand('我的'), { cmd: 'my' });
  assert.deepEqual(parseCommand('加入'), { cmd: 'join' });
  assert.deepEqual(parseCommand('隐藏'), { cmd: 'hide' });
  assert.deepEqual(parseCommand('显示'), { cmd: 'show' });
  assert.deepEqual(parseCommand('退出'), { cmd: 'leave' });
  assert.equal(parseCommand('榜单上周'), null);
  assert.equal(parseCommand('今天天气不错'), null);
  assert.equal(parseCommand(''), null);
});

// ───────────────────────────── 回调入口 ─────────────────────────────

test('/feishu/event 路由：url_verification 原样回 challenge', async () => {
  const env = { FEISHU_VERIFICATION_TOKEN: 'v-token' };
  const res = await worker.fetch(new Request('https://x/feishu/event', {
    method: 'POST', body: JSON.stringify({ type: 'url_verification', challenge: 'abc-123', token: 'v-token' }),
  }), env);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).challenge, 'abc-123');
});

test('未配置加密密钥和 Verification Token 时事件被拒绝（fail closed）', async (t) => {
  const { db, env } = fixture(t);
  await seedGroupBoard(db);
  const log = [];
  const service = createFeishuService({ fetcher: fakeFeishuApi(log), now: () => NOW });
  delete env.FEISHU_VERIFICATION_TOKEN;
  await fire(service, env, messageEvent({}));
  assert.equal(log.filter((m) => m.url.includes('/im/v1/messages')).length, 0);
});

test('未配置飞书凭证时事件被忽略且不报错', async (t) => {
  const { env } = fixture(t);
  const log = [];
  const service = createFeishuService({ fetcher: fakeFeishuApi(log), now: () => NOW });
  delete env.FEISHU_APP_ID;
  await fire(service, env, messageEvent({}));
  assert.equal(log.filter((m) => m.url.includes('/im/v1/messages')).length, 0);
});

test('Verification Token 不匹配的事件被丢弃', async (t) => {
  const { env } = fixture(t);
  const log = [];
  const service = createFeishuService({ fetcher: fakeFeishuApi(log), now: () => NOW });
  await fire(service, env, messageEvent({ token: 'wrong' }));
  assert.equal(log.filter((m) => m.url.includes('/im/v1/messages')).length, 0);
});

test('过期事件（重放）不处理', async (t) => {
  const { env } = fixture(t);
  const log = [];
  const service = createFeishuService({ fetcher: fakeFeishuApi(log), now: () => NOW });
  await fire(service, env, messageEvent({ createTime: NOW - 20 * 60_000 }));
  assert.equal(log.filter((m) => m.url.includes('/im/v1/messages')).length, 0);
});

test('同一 event_id 重复投递只处理一次', async (t) => {
  const { db, env } = fixture(t);
  await seedGroupBoard(db);
  const log = [];
  const service = createFeishuService({ fetcher: fakeFeishuApi(log), now: () => NOW });
  const event = messageEvent({ eventId: 'evt-dup', openId: 'ou_2' });
  await fire(service, env, event);
  await fire(service, env, event);
  await fire(service, env, event);
  assert.equal(log.filter((m) => m.url.includes('/im/v1/messages')).length, 1);
});

async function encryptForFeishu(payload, key) {
  const keyBytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key)));
  const cryptoKey = await crypto.subtle.importKey('raw', keyBytes, { name: 'AES-CBC' }, false, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(16));
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-CBC', iv }, cryptoKey, new TextEncoder().encode(JSON.stringify(payload))));
  const body = new Uint8Array(iv.length + cipher.length);
  body.set(iv, 0); body.set(cipher, iv.length);
  return btoa(String.fromCharCode(...body));
}

async function signedRequest(payload, key, { timestamp = Math.floor(NOW / 1000), nonce = 'n-1' } = {}) {
  const raw = JSON.stringify(payload);
  const signature = await feishuSignature(String(timestamp), nonce, key, raw);
  return new Request('https://rank.example.com/feishu/event', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-lark-request-timestamp': String(timestamp),
      'x-lark-request-nonce': nonce,
      'x-lark-signature': signature,
    },
    body: raw,
  });
}

test('加密的 url_verification 校验请求也能返回 challenge', async (t) => {
  const { env } = fixture(t);
  env.FEISHU_ENCRYPT_KEY = 'enc-key';
  const service = createFeishuService({ fetcher: async () => { throw new Error('不应外呼'); }, now: () => NOW });
  const body = { encrypt: await encryptForFeishu({ type: 'url_verification', challenge: 'enc-challenge' }, 'enc-key') };
  const res = await service.handle(await signedRequest(body, 'enc-key'), env);
  assert.equal((await res.json()).challenge, 'enc-challenge');
});

test('加密事件可解密处理', async (t) => {
  const { db, env } = fixture(t);
  await seedGroupBoard(db);
  env.FEISHU_ENCRYPT_KEY = 'enc-key';
  const log = [];
  const service = createFeishuService({ fetcher: fakeFeishuApi(log), now: () => NOW });
  const body = { encrypt: await encryptForFeishu(messageEvent({ eventId: 'evt-enc', openId: 'ou_2' }), 'enc-key') };
  const res = await service.handle(await signedRequest(body, 'enc-key'), env);
  assert.equal(res.status, 200);
  assert.equal(sentTitles(log).length, 1);
  assert.equal(sentTitles(log)[0], '飞书测试群 · Token 排行榜');
});

test('加密事件缺少签名或签名错误时不处理', async (t) => {
  const { db, env } = fixture(t);
  await seedGroupBoard(db);
  env.FEISHU_ENCRYPT_KEY = 'enc-key';
  const log = [];
  const service = createFeishuService({ fetcher: fakeFeishuApi(log), now: () => NOW });
  const event = messageEvent({ eventId: 'evt-enc-bad', openId: 'ou_2' });
  const body = { encrypt: await encryptForFeishu(event, 'enc-key') };
  const unsigned = new Request('https://rank.example.com/feishu/event', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  await service.handle(unsigned, env);
  const wrongKey = await signedRequest(body, 'other-key');
  await service.handle(wrongKey, env);
  const stale = await signedRequest(body, 'enc-key', { timestamp: Math.floor(NOW / 1000) - 3600 });
  await service.handle(stale, env);
  assert.equal(log.filter((m) => m.url.includes('/im/v1/messages')).length, 0);
});

// ───────────────────────────── 榜单 ─────────────────────────────

test('群里发「榜单」返回本群排行卡片（隐藏成员不计入）', async (t) => {
  const { db, env } = fixture(t);
  await seedGroupBoard(db);
  const log = [];
  const service = createFeishuService({ fetcher: fakeFeishuApi(log), now: () => NOW });
  await fire(service, env, messageEvent({ openId: 'ou_2', eventId: 'evt-rank' }));
  const cards = sentCards(log);
  assert.equal(cards.length, 1);
  assert.equal(JSON.parse(log.find((m) => m.url.includes('/im/v1/messages')).body).receive_id, 'oc_group');
  assert.equal(cards[0].schema, '2.0', '卡片为 schema 2.0');
  const text = flat(cards[0]);
  assert.match(text, /### 飞书测试群 · Token 排行榜/);
  assert.match(text, /\*\*<font color='orange'>今日<\/font>\*\*/);  // 周期 Tab 行，当前橙色
  assert.ok(text.includes('张三') && text.includes('300 万'), '第一名成绩用中文单位');
  assert.ok(text.includes('李四') && text.includes('120 万'));
  assert.ok(!text.includes('王五'), '本群隐藏的成员不能出现在榜单上');
  assert.match(text, /成员 · 3 人/);
  assert.match(text, /更新于 1 分钟前/);
});

test('「榜单 本周」按一周总量聚合', async (t) => {
  const { db, env } = fixture(t);
  await seedGroupBoard(db);
  const log = [];
  const service = createFeishuService({ fetcher: fakeFeishuApi(log), now: () => NOW });
  await fire(service, env, messageEvent({ openId: 'ou_2', text: '榜单 本周', eventId: 'evt-week' }));
  const text = sentTexts(log)[0];
  assert.match(sentTexts(log)[0], /\*\*<font color='orange'>本周<\/font>\*\*/);
  assert.ok(text.includes('张三') && text.includes('500 万'), '3M 今日 + 2M 一周前');
});

test('榜内成员附带自己的名次，未上榜成员收到加入提示', async (t) => {
  const { db, env } = fixture(t);
  await seedGroupBoard(db);
  db.prepare("INSERT INTO users(id,openid,nickname,avatar_url,created_at,updated_at) VALUES(9,'feishu:ou_9','赵六',NULL,1,1)").run();
  const log = [];
  const service = createFeishuService({ fetcher: fakeFeishuApi(log), now: () => NOW });
  await fire(service, env, messageEvent({ openId: 'ou_2', eventId: 'evt-me' }));
  assert.match(sentTexts(log)[0], /你排第 \*\*2\*\* 名 · 120 万 tokens/);
  assert.match(sentTexts(log)[0], /\*\*李四\*\* 我/);  // 置顶“我的行”
  await fire(service, env, messageEvent({ openId: 'ou_9', eventId: 'evt-join-hint' }));
  assert.match(sentTexts(log).at(-1), /你还未上榜/);
});

test('未绑定群发「榜单」提示先接入', async (t) => {
  const { env } = fixture(t);
  const log = [];
  const service = createFeishuService({ fetcher: fakeFeishuApi(log), now: () => NOW });
  await fire(service, env, messageEvent({ chatId: 'oc_other', eventId: 'evt-unbound' }));
  assert.match(sentTitles(log)[0], /本群还没有榜单/);
});

test('单聊「榜单」返回广场榜（含未入群用户）', async (t) => {
  const { db, env } = fixture(t);
  await seedGroupBoard(db);
  const log = [];
  const service = createFeishuService({ fetcher: fakeFeishuApi(log), now: () => NOW });
  await fire(service, env, messageEvent({ chatId: 'oc_p2p', chatType: 'p2p', text: 'rank', eventId: 'evt-global' }));
  const text0 = sentTexts(log)[0];
  assert.match(text0, /### 广场 · Token 排行榜/);
  assert.match(text0, /成员 · \d+ 人/);
  assert.match(text0, /Token 用量/);
  const text = sentTexts(log)[0];
  assert.ok(text0.includes('王五')); // 广场榜不受单群 hidden 影响（王五未全局隐藏，仅本群隐藏）
});

// ───────────────────────────── 绑定与账号 ─────────────────────────────

test('单聊「绑定」：创建账号、发接入码；重复绑定幂等不重建账号', async (t) => {
  const { db, env } = fixture(t);
  const log = [];
  const service = createFeishuService({ fetcher: fakeFeishuApi(log), now: () => NOW });
  await fire(service, env, messageEvent({ chatId: 'oc_p2p', chatType: 'p2p', openId: 'ou_new', text: '绑定', eventId: 'evt-bind' }));
  const user = db.prepare('SELECT * FROM users WHERE openid=?').get('feishu:ou_new');
  assert.ok(user, '账号已创建');
  assert.equal(user.nickname, '张三');
  assert.equal(user.avatar_url, 'https://img.example/new.png');
  const token = db.prepare('SELECT token FROM connect_tokens WHERE user_id=?').get(user.id).token;
  assert.match(sentTexts(log)[0], new RegExp(`curl -fsSL https://rank\\.example\\.com/install\\.sh \\| sh -s https://rank\\.example\\.com ${token}`));
  assert.match(sentTexts(log)[0], /install\.ps1/);
  await fire(service, env, messageEvent({ chatId: 'oc_p2p', chatType: 'p2p', openId: 'ou_new', text: '绑定', eventId: 'evt-bind2' }));
  assert.equal(db.prepare('SELECT COUNT(*) c FROM users WHERE openid=?').get('feishu:ou_new').c, 1);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM connect_tokens WHERE user_id=?').get(user.id).c, 1);
  assert.match(sentTexts(log).at(-1), new RegExp(token));
});

test('群里「绑定」绝不泄露接入码，只引导单聊', async (t) => {
  const { db, env } = fixture(t);
  await seedGroupBoard(db);
  const log = [];
  const service = createFeishuService({ fetcher: fakeFeishuApi(log), now: () => NOW });
  await fire(service, env, messageEvent({ openId: 'ou_1', text: '绑定', eventId: 'evt-bind-group' }));
  const cards = sentCards(log);
  assert.equal(cards.length, 1);
  const whole = JSON.stringify(cards[0]);
  assert.ok(!whole.includes('ct-1'), '群里不能出现任何接入码');
  assert.match(flat(cards[0]), /单聊/);
});

// ───────────────────────────── 群管理 ─────────────────────────────

test('「加入」创建群榜并绑定 chat_id 哈希，重复加入幂等', async (t) => {
  const { db, env } = fixture(t);
  db.prepare("INSERT INTO users(id,openid,nickname,avatar_url,created_at,updated_at) VALUES(1,'feishu:ou_1','张三','https://i/1.png',1,1)").run();
  const log = [];
  const service = createFeishuService({ fetcher: fakeFeishuApi(log), now: () => NOW });
  await fire(service, env, messageEvent({ openId: 'ou_1', chatId: 'oc_new', text: '加入', eventId: 'evt-join' }));
  const hash = await feishuChatHash('oc_new');
  const group = db.prepare('SELECT * FROM rank_groups WHERE group_openid_hash=?').get(hash);
  assert.ok(group, '群榜按 chat_id 哈希创建');
  assert.equal(group.name, '飞书测试群'); // 群名来自飞书群信息接口
  assert.equal(group.owner_user_id, 1);
  assert.ok(db.prepare('SELECT 1 FROM rank_group_members WHERE group_id=? AND user_id=1').get(group.id));
  await fire(service, env, messageEvent({ openId: 'ou_1', chatId: 'oc_new', text: '加入', eventId: 'evt-join2' }));
  assert.equal(db.prepare('SELECT COUNT(*) c FROM rank_group_members WHERE group_id=?').get(group.id).c, 1);
  assert.match(sentTexts(log).at(-1), /已经在榜单里/);
});

test('无账号用户「加入」被引导先绑定', async (t) => {
  const { env } = fixture(t);
  const log = [];
  const service = createFeishuService({ fetcher: fakeFeishuApi(log), now: () => NOW });
  await fire(service, env, messageEvent({ openId: 'ou_none', text: '加入', eventId: 'evt-join-none' }));
  assert.match(sentTitles(log)[0], /Token 群排名/);
  assert.match(JSON.stringify(sentCards(log)[0]), /绑定/);
});

test('「隐藏/显示」切换本群可见性，「退出」移除成员', async (t) => {
  const { db, env } = fixture(t);
  await seedGroupBoard(db);
  const log = [];
  const service = createFeishuService({ fetcher: fakeFeishuApi(log), now: () => NOW });
  await fire(service, env, messageEvent({ openId: 'ou_2', text: '隐藏', eventId: 'evt-hide' }));
  assert.equal(db.prepare('SELECT hidden FROM rank_group_members WHERE group_id=? AND user_id=2').get('g1').hidden, 1);
  await fire(service, env, messageEvent({ openId: 'ou_2', text: '显示', eventId: 'evt-show' }));
  assert.equal(db.prepare('SELECT hidden FROM rank_group_members WHERE group_id=? AND user_id=2').get('g1').hidden, 0);
  await fire(service, env, messageEvent({ openId: 'ou_2', text: '退出', eventId: 'evt-leave' }));
  assert.ok(!db.prepare('SELECT 1 FROM rank_group_members WHERE group_id=? AND user_id=2').get('g1'));
  assert.equal(db.prepare("SELECT COUNT(*) c FROM daily_totals WHERE user_id=2").get().c, 2, '退榜不删用量数据');
});

// ───────────────────────────── 个人用量 ─────────────────────────────

test('单聊「我的」返回用量卡片', async (t) => {
  const { db, env } = fixture(t);
  await seedGroupBoard(db);
  const log = [];
  const service = createFeishuService({ fetcher: fakeFeishuApi(log), now: () => NOW });
  await fire(service, env, messageEvent({ chatId: 'oc_p2p', chatType: 'p2p', openId: 'ou_1', text: '我的', eventId: 'evt-my' }));
  const card = sentCards(log)[0];
  const text = flat(card);
  assert.match(text, /我的用量 · 今日 · 总用量 · 含缓存/);
  assert.match(text, /## <font color='orange'>300 万<\/font>/);
  assert.match(text, /5,000,000/);  // 累计完整整数
  assert.match(text, /## <font color='orange'>300 万<\/font>/);  // 橙色大数字
  assert.match(text, /\*\*500 万\*\*/);            // 本周
  assert.match(text, /claude-code \/ claude-sonnet-4\.5/);
  assert.match(text, /第 2 名/); // 王五 5M 第一（仅本群隐藏，广场可见）
});

test('群里「我的」引导到单聊，避免用量公开泄露', async (t) => {
  const { db, env } = fixture(t);
  await seedGroupBoard(db);
  const log = [];
  const service = createFeishuService({ fetcher: fakeFeishuApi(log), now: () => NOW });
  await fire(service, env, messageEvent({ openId: 'ou_1', text: '我的', eventId: 'evt-my-group' }));
  const whole = JSON.stringify(sentCards(log)[0]);
  assert.ok(!whole.includes('300'), '群里不能出现个人用量数字');
  assert.match(whole, /单聊/);
});

test('单聊无账号发「我的」提示先绑定', async (t) => {
  const { env } = fixture(t);
  const log = [];
  const service = createFeishuService({ fetcher: fakeFeishuApi(log), now: () => NOW });
  await fire(service, env, messageEvent({ chatId: 'oc_p2p', chatType: 'p2p', openId: 'ou_none', text: '我的', eventId: 'evt-my-none' }));
  assert.match(JSON.stringify(sentCards(log)[0]), /绑定/);
});

test('单聊未知命令回复帮助卡片，群里未知命令静默', async (t) => {
  const { db, env } = fixture(t);
  await seedGroupBoard(db);
  const log = [];
  const service = createFeishuService({ fetcher: fakeFeishuApi(log), now: () => NOW });
  await fire(service, env, messageEvent({ chatId: 'oc_p2p', chatType: 'p2p', openId: 'ou_1', text: '你是谁', eventId: 'evt-unknown' }));
  assert.match(sentTitles(log)[0], /Token 群排名 · 使用帮助/);
  await fire(service, env, messageEvent({ openId: 'ou_1', text: '今天天气不错', eventId: 'evt-unknown-g' }));
  assert.equal(log.filter((m) => m.url.includes('/im/v1/messages')).length, 1);
});

test('非文本消息被忽略', async (t) => {
  const { db, env } = fixture(t);
  await seedGroupBoard(db);
  const log = [];
  const service = createFeishuService({ fetcher: fakeFeishuApi(log), now: () => NOW });
  const event = messageEvent({ eventId: 'evt-image' });
  event.event.message.message_type = 'image';
  event.event.message.content = '{}';
  await fire(service, env, event);
  assert.equal(log.filter((m) => m.url.includes('/im/v1/messages')).length, 0);
});

test('周期标签覆盖全部取值', () => {
  assert.deepEqual(Object.keys(PERIOD_LABELS).sort(), ['all', 'day', 'month', 'week']);
});

test('ensureAvatarKey 上传头像换 img_key 并按来源缓存，命中后不再上传', async (t) => {
  const { db, env } = fixture(t);
  await seedGroupBoard(db);
  const uploads = [];
  const fetcher = async (url, init = {}) => {
    if (String(url).includes('/auth/v3/tenant_access_token/internal')) {
      return Response.json({ code: 0, tenant_access_token: 't-token', expire: 7200 });
    }
    if (String(url).includes('/im/v1/images')) {
      uploads.push(String(url));
      return Response.json({ code: 0, data: { image_key: 'img_v2_avatar' } });
    }
    if (String(url).includes('img.example/1.png')) {
      return new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/png' } });
    }
    return Response.json({ code: 0, data: {} });
  };
  const service = createFeishuService({ fetcher, now: () => NOW });
  const entry = { uid: 1, avatar_path: null, avatar_url: 'https://img.example/1.png' };
  assert.equal(await service._internals.ensureAvatarKey(env, entry), 'img_v2_avatar');
  assert.equal(await service._internals.ensureAvatarKey(env, entry), 'img_v2_avatar');
  assert.equal(uploads.length, 1, '缓存命中后不再重复上传');
  const cached = db.prepare('SELECT image_key, source FROM feishu_avatar_cache WHERE user_id=1').get();
  assert.equal(cached.image_key, 'img_v2_avatar');
  assert.equal(cached.source, 'https://img.example/1.png');
  // 无头像来源返回 null，不报错
  assert.equal(await service._internals.ensureAvatarKey(env, { uid: 2, avatar_path: null, avatar_url: null }), null);
});

test('榜单卡片新增「工具」列：位于成员与模型之间，展示使用率最高的工具', async (t) => {
  const { db, env } = fixture(t);
  await seedGroupBoard(db);
  // 张三：codex 用量高于 claude-code → 工具列取 codex；李四只有 claude-code
  const today = beijingDay(NOW);
  db.prepare('UPDATE daily_totals SET tools_json=? WHERE user_id=1 AND day=?')
    .run(JSON.stringify([['codex', 2_000_000], ['claude-code', 1_000_000]]), today);
  console.error('DEBUG-TOOLS', JSON.stringify(db.prepare('SELECT day, tools_json FROM daily_totals WHERE user_id=1').all()));
  console.error('DEBUG-VIEW', JSON.stringify(db.prepare('SELECT day, tools_json FROM public_usage WHERE user_id=1').all()));
  db.prepare('UPDATE daily_totals SET tools_json=? WHERE user_id=2 AND day=?')
    .run(JSON.stringify([['claude-code', 1_200_000]]), today);
  const log = [];
  const service = createFeishuService({ fetcher: fakeFeishuApi(log), now: () => NOW });
  await fire(service, env, messageEvent({ openId: 'ou_2', eventId: 'evt-tool-col' }));
  const card = sentCards(log)[0];
  console.error('DEBUG-BOARD', JSON.stringify(await service._internals.boardRows(env, { groupId: 'g1', from: today, to: today })));
  const rows = card.body.elements.filter((el) => el.tag === 'column_set');
  const cell = (row, index) => flat({ body: { elements: row.columns[index].elements } });
  console.error('DEBUG-CELLS', JSON.stringify(rows.map((r) => r.columns.map((_, i) => cell(r, i)))));
  // 表头：# / 成员 / 工具 / 模型 / Token 用量（头像列为空占位）；单元格文本带 grey font 标记
  const header = rows[0];
  assert.equal(header.columns.length, 6, '六列：序号/头像/成员/工具/模型/用量');
  assert.match(cell(header, 2), /成员/);
  assert.equal(cell(header, 3), "<font color='grey'>工具</font>");
  assert.equal(cell(header, 4), "<font color='grey'>模型</font>");
  // 第一名（张三）行：工具列 = 使用率最高的 codex，模型列仍是主力模型（列序：名次/头像/成员/工具/模型/用量）
  const first = rows[1];
  assert.equal(cell(first, 2), '张三');
  assert.match(cell(first, 3), /codex/);
  assert.match(cell(first, 4), /claude-sonnet-4\.5/);
  // Credits 榜（纯积分用户）同样带工具列：取积分口径的计费工具
  db.prepare('UPDATE daily_totals SET tokens=0, requests=0, tools_json=?, credits_json=? WHERE user_id=3 AND day=?').run('[]', JSON.stringify({ total: 12, tools: [['qoder', 12]] }), today);
  db.prepare("UPDATE rank_group_members SET hidden=0 WHERE user_id=3").run();
  const log2 = [];
  const service2 = createFeishuService({ fetcher: fakeFeishuApi(log2), now: () => NOW });
  await fire(service2, env, messageEvent({ openId: 'ou_2', eventId: 'evt-tool-col-2' }));
  const card2 = sentCards(log2)[0];
  const creditRows = card2.body.elements.filter((el) => el.tag === 'column_set');
  const creditHeader = creditRows.find((r) => cell(r, 5) === "<font color='grey'>Credits</font>");
  assert.ok(creditHeader, '存在 Credits 榜表头');
  assert.equal(cell(creditHeader, 3), "<font color='grey'>工具</font>");
  const wangwu = creditRows.find((r) => cell(r, 2) === '王五');
  assert.ok(wangwu, '王五出现在 Credits 榜');
  assert.match(cell(wangwu, 3), /qoder/);
});
