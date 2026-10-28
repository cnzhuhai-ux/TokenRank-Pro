import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import worker from '../src/worker.js';
import { beijingDay, beijingDaysAgo } from '../src/lib.js';
import {
  createFeishuService, parseCommand, formatTokens, feishuChatHash, PERIOD_LABELS,
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
const sentTitles = (log) => sentCards(log).map((c) => c.header?.title?.content ?? '');

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

test('formatTokens 按数量级缩写', () => {
  assert.equal(formatTokens(0), '0');
  assert.equal(formatTokens(999), '999');
  assert.equal(formatTokens(1234), '1.2K');
  assert.equal(formatTokens(3_000_000), '3.00M');
  assert.equal(formatTokens(1.5e9), '1.50B');
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
  const res = await worker.fetch(new Request('https://x/feishu/event', {
    method: 'POST', body: JSON.stringify({ type: 'url_verification', challenge: 'abc-123', token: 'v-token' }),
  }), {});
  assert.equal(res.status, 200);
  assert.equal((await res.json()).challenge, 'abc-123');
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

test('加密的 url_verification 校验请求也能返回 challenge', async (t) => {
  const { env } = fixture(t);
  env.FEISHU_ENCRYPT_KEY = 'enc-key';
  const service = createFeishuService({ fetcher: async () => { throw new Error('不应外呼'); }, now: () => NOW });
  const res = await service.handle(new Request('https://rank.example.com/feishu/event', {
    method: 'POST', body: JSON.stringify({ encrypt: await encryptForFeishu({ type: 'url_verification', challenge: 'enc-challenge' }, 'enc-key') }),
  }), env);
  assert.equal((await res.json()).challenge, 'enc-challenge');
});

test('加密事件可解密处理', async (t) => {
  const { db, env } = fixture(t);
  await seedGroupBoard(db);
  env.FEISHU_ENCRYPT_KEY = 'enc-key';
  const log = [];
  const service = createFeishuService({ fetcher: fakeFeishuApi(log), now: () => NOW });
  const res = await service.handle(new Request('https://rank.example.com/feishu/event', {
    method: 'POST', body: JSON.stringify({ encrypt: await encryptForFeishu(messageEvent({ eventId: 'evt-enc', openId: 'ou_2' }), 'enc-key') }),
  }), env);
  assert.equal(res.status, 200);
  assert.equal(sentTitles(log).length, 1);
  assert.match(sentTitles(log)[0], /飞书测试群 · Token 排行榜（今日）/);
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
  const text = cards[0].elements[0].text.content;
  assert.match(text, /🥇 \*\*张三\*\*　3\.00M/);
  assert.match(text, /🥈 \*\*李四\*\*　1\.20M.*gpt-5\.2/);
  assert.ok(!text.includes('王五'), '本群隐藏的成员不能出现在榜单上');
  assert.match(text, /claude-sonnet-4\.5/);
  const note = cards[0].elements.at(-1).elements[0].content;
  assert.match(note, /成员 3 人/);
  assert.match(note, /更新于 1 分钟前/);
});

test('「榜单 本周」按一周总量聚合', async (t) => {
  const { db, env } = fixture(t);
  await seedGroupBoard(db);
  const log = [];
  const service = createFeishuService({ fetcher: fakeFeishuApi(log), now: () => NOW });
  await fire(service, env, messageEvent({ openId: 'ou_2', text: '榜单 本周', eventId: 'evt-week' }));
  const text = sentCards(log)[0].elements[0].text.content;
  assert.match(sentTitles(log)[0], /（本周）/);
  assert.match(text, /张三\*\*　5\.00M/); // 3M 今日 + 2M 一周前
});

test('榜内成员附带自己的名次，未上榜成员收到加入提示', async (t) => {
  const { db, env } = fixture(t);
  await seedGroupBoard(db);
  db.prepare("INSERT INTO users(id,openid,nickname,avatar_url,created_at,updated_at) VALUES(9,'feishu:ou_9','赵六',NULL,1,1)").run();
  const log = [];
  const service = createFeishuService({ fetcher: fakeFeishuApi(log), now: () => NOW });
  await fire(service, env, messageEvent({ openId: 'ou_2', eventId: 'evt-me' }));
  assert.match(sentCards(log)[0].elements[1].text.content, /你排第 \*\*2\*\* 名（1\.20M tokens）/);
  await fire(service, env, messageEvent({ openId: 'ou_9', eventId: 'evt-join-hint' }));
  assert.match(sentCards(log).at(-1).elements[1].text.content, /你还未上榜/);
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
  assert.match(sentTitles(log)[0], /广场 · Token 排行榜（今日）/);
  const text = sentCards(log)[0].elements[0].text.content;
  assert.match(text, /王五/); // 广场榜不受单群 hidden 影响（王五未全局隐藏，仅本群隐藏）
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
  assert.match(sentCards(log)[0].elements[0].text.content, new RegExp(`npx tokenrank-client@latest connect https://rank\\.example\\.com ${token}`));
  await fire(service, env, messageEvent({ chatId: 'oc_p2p', chatType: 'p2p', openId: 'ou_new', text: '绑定', eventId: 'evt-bind2' }));
  assert.equal(db.prepare('SELECT COUNT(*) c FROM users WHERE openid=?').get('feishu:ou_new').c, 1);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM connect_tokens WHERE user_id=?').get(user.id).c, 1);
  assert.match(sentCards(log).at(-1).elements[0].text.content, new RegExp(token));
});

test('群里「绑定」绝不泄露接入码，只引导单聊', async (t) => {
  const { db, env } = fixture(t);
  await seedGroupBoard(db);
  const log = [];
  const service = createFeishuService({ fetcher: fakeFeishuApi(log), now: () => NOW });
  await fire(service, env, messageEvent({ openId: 'ou_1', text: '绑定', eventId: 'evt-bind-group' }));
  const cards = sentCards(log);
  assert.equal(cards.length, 1);
  const flat = JSON.stringify(cards[0]);
  assert.ok(!flat.includes('ct-1'), '群里不能出现任何接入码');
  assert.match(flat, /单聊/);
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
  assert.match(sentCards(log).at(-1).elements[0].text.content, /已经在榜单里/);
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
  assert.match(card.header.title.content, /我的用量 · 张三/);
  const text = card.elements[0].text.content;
  assert.match(text, /\*\*今日\*\*　3\.00M tokens　·　1 次调用/);
  assert.match(text, /\*\*本周\*\*　5\.00M tokens/);
  assert.match(text, /claude-code \/ claude-sonnet-4\.5/);
  assert.match(text, /今日广场排名\*\*　第 2 名/); // 王五 5M 第一（仅本群隐藏，广场可见）
});

test('群里「我的」引导到单聊，避免用量公开泄露', async (t) => {
  const { db, env } = fixture(t);
  await seedGroupBoard(db);
  const log = [];
  const service = createFeishuService({ fetcher: fakeFeishuApi(log), now: () => NOW });
  await fire(service, env, messageEvent({ openId: 'ou_1', text: '我的', eventId: 'evt-my-group' }));
  const flat = JSON.stringify(sentCards(log)[0]);
  assert.ok(!flat.includes('3.00M'), '群里不能出现个人用量数字');
  assert.match(flat, /单聊/);
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
  assert.match(sentTitles(log)[0], /使用帮助/);
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
