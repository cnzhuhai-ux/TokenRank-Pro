/**
 * 飞书机器人接入：一个飞书群（chat_id）对应一张榜，群里发命令看榜、上榜、接入电脑。
 *
 * 身份模型（与微信版对齐，全部复用现有表）：
 *   - 用户锚点：users.openid = 'feishu:<open_id>'（自建应用内稳定）
 *   - 群绑定：rank_groups.group_openid_hash = sha256('feishu:chat:<chat_id>')，
 *     与微信 opengid 哈希共用同一列，一群一榜语义不变
 *   - 会话外不存任何消息内容；接入码等凭证只通过单聊发送，绝不在群里展示
 *
 * 配置（wrangler.toml / secrets）：
 *   FEISHU_APP_ID / FEISHU_APP_SECRET         — 自建应用凭证（secret 建议 put）
 *   FEISHU_VERIFICATION_TOKEN（可选）          — 事件 token 校验
 *   FEISHU_ENCRYPT_KEY（可选）                 — 事件加密密钥（开放平台配了 Encrypt Key 才需要）
 */

import {
  hexToken, groupId, beijingDay, beijingDaysAgo, sanitizeName, sanitizeGroupName,
} from './lib.js';

const FEISHU_BASE = 'https://open.feishu.cn';
const OPENID_PREFIX = 'feishu:';
const CHAT_HASH_PREFIX = 'feishu:chat:';
const DEFAULT_GROUP_NAME = '本群 Token 排名';
const EVENT_MAX_AGE_MS = 10 * 60 * 1000;
const BOARD_LIMIT = 10;
const EVENT_LOG_TTL_MS = 7 * 86_400_000;

export const PERIOD_LABELS = { day: '今日', week: '本周', month: '本月', all: '总榜' };

/** 与小程序端 miniprogram/utils/usage.js 的 compact() 完全一致：亿两位小数、万去尾零、万以下千分位整数 */
export function formatTokens(n) {
  const v = Math.max(0, Math.round(Number(n) || 0));
  if (v >= 1e8) return (v / 1e8).toFixed(2) + ' 亿';
  if (v >= 1e4) return (v / 1e4).toFixed(2).replace(/\.?0+$/, '') + ' 万';
  return String(v).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

export function periodRange(period, nowMs = Date.now()) {
  const today = beijingDay(nowMs);
  if (period === 'week') return [beijingDaysAgo(6, nowMs), today];
  if (period === 'month') return [beijingDaysAgo(29, nowMs), today];
  if (period === 'all') return ['0000-01-01', '9999-12-31'];
  return [today, today];
}

export async function feishuChatHash(chatId) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(CHAT_HASH_PREFIX + String(chatId)));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const md = (s) => String(s ?? '').replace(/[*`]/g, '');

// ───────────────────────────── 命令解析（纯函数，测试直测） ─────────────────────────────

const PERIOD_KEYS = [
  ['day', ['今日', '今天', 'today', 'day']],
  ['week', ['本周', '周榜', 'week', '7天']],
  ['month', ['本月', '月榜', 'month']],
  ['all', ['总', '全部', '总计', '总榜', 'all', 'lifetime']],
];
const RANK_HEADS = ['榜单', '排行榜', '排名', '榜', 'rank', 'board', 'top'];

/**
 * 解析用户消息为命令；不认识的返回 null（群里静默、单聊回帮助）。
 * 支持空格分隔（「榜单 本周」）与连写（「榜单本周」），自动剔除 @机器人 占位符。
 */
export function parseCommand(raw) {
  const text = String(raw ?? '')
    .replace(/@_user_\d+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\/+/, '');
  if (!text) return null;
  const lower = text.toLowerCase();
  const exact = {
    帮助: 'help', help: 'help', 菜单: 'help', menu: 'help',
    绑定: 'bind', 接入: 'bind', bind: 'bind', connect: 'bind',
    我的: 'my', 用量: 'my', my: 'my', me: 'my', mine: 'my',
    加入: 'join', join: 'join',
    退出: 'leave', leave: 'leave',
    隐藏: 'hide', hide: 'hide',
    显示: 'show', 展示: 'show', show: 'show',
  }[lower];
  if (exact) return { cmd: exact };

  const head = RANK_HEADS.find((h) => lower === h || lower.startsWith(h));
  if (!head) return null;
  const rest = lower.slice(head.length).trim();
  if (!rest) return { cmd: 'rank', period: 'day' };
  const period = PERIOD_KEYS.find(([, keys]) => keys.some((k) => rest === k || rest.startsWith(k)));
  return period ? { cmd: 'rank', period: period[0] } : null;
}

// ───────────────────────────── 卡片（纯函数，测试直测） ─────────────────────────────

function card(template, title, elements) {
  return { config: { wide_screen_mode: true }, header: { template, title: { tag: 'plain_text', content: title } }, elements };
}

export function helpCard({ groupReady }) {
  const lines = [
    '**群内命令**（先把我拉进群，@我 或直接发）',
    '**榜单 [今日|本周|本月|总榜]** — 看本群 Token 排行',
    '**加入** — 上榜本群（需先在单聊里完成电脑接入）',
    '**隐藏 / 显示** — 不退出地在本群隐藏/恢复自己的排名　**退出** — 退出本群榜',
    '**单聊命令**',
    '**绑定** — 获取电脑接入码和安装命令（接入码只发单聊）',
    '**我的** — 查看自己的用量日报　**榜单** — 看广场总榜',
  ];
  if (groupReady === false) lines.push('', '本群还没有榜单：先单聊我「绑定」接入电脑，再回群里发「加入」。');
  return card('turquoise', 'Token 群排名 · 使用帮助', [
    { tag: 'div', text: { tag: 'lark_md', content: lines.join('\n') } },
    { tag: 'note', elements: [{ tag: 'plain_text', content: '用量是各成员电脑自报的聚合数字，仅作交流参考，不等于厂商账单' }] },
  ]);
}

export function leaderboardCard({ title, entries, members, updatedAt, nowMs, footer }) {
  const medals = ['🥇', '🥈', '🥉'];
  const lines = entries.slice(0, BOARD_LIMIT).map((e, i) => {
    const mark = medals[i] || `${i + 1}.`;
    const model = e.top_model ? ` ｜ \`${md(e.top_model)}\`` : '';
    return `${mark} **${md(e.nickname)}**　${formatTokens(e.tokens)}${model}`;
  });
  const elements = [];
  if (lines.length) {
    elements.push({ tag: 'div', text: { tag: 'lark_md', content: lines.join('\n') } });
    if (entries.length > BOARD_LIMIT) {
      elements.push({ tag: 'note', elements: [{ tag: 'plain_text', content: `仅展示前 ${BOARD_LIMIT} 名，共 ${entries.length} 人有用量` }] });
    }
  } else {
    elements.push({ tag: 'div', text: { tag: 'lark_md', content: '这个时间段还没有人上报用量。先单聊我「绑定」接入电脑，再回来发「加入」上榜。' } });
  }
  if (footer) elements.push({ tag: 'div', text: { tag: 'lark_md', content: footer } });
  const bits = [];
  if (members != null) bits.push(`成员 ${members} 人`);
  if (updatedAt && nowMs && nowMs > updatedAt) bits.push(`更新于 ${Math.max(1, Math.round((nowMs - updatedAt) / 60000))} 分钟前`);
  if (bits.length) elements.push({ tag: 'note', elements: [{ tag: 'plain_text', content: bits.join(' · ') }] });
  return card('blue', title, elements);
}

export function connectCard(origin, token) {
  const command = `npx tokenrank-client@latest connect ${origin} ${token}`;
  return card('green', '电脑接入 · Token 群排名', [
    { tag: 'div', text: { tag: 'lark_md', content:
      '电脑装好 [Node.js 22+](https://nodejs.org) 后，在终端运行：\n`' + command + '`\n'
      + '运行一次即可，之后每 5 分钟自动上报一次按天汇总的数字。' } },
    { tag: 'div', text: { tag: 'lark_md', content:
      '**接入码**（重置即作废旧码，请勿转发）：\n`' + token + '`' } },
    { tag: 'hr' },
    { tag: 'div', text: { tag: 'lark_md', content: '接入后在群里发「**加入**」上榜，发「**榜单**」看排行。' } },
    { tag: 'note', elements: [{ tag: 'plain_text', content: '只上报每天的 token 数、调用次数和工具/模型名，不含代码、对话和文件路径' }] },
  ]);
}

export function textCard(title, content, template = 'grey') {
  return card(template, title, [{ tag: 'div', text: { tag: 'lark_md', content } }]);
}

// ───────────────────────────── 服务（可注入 fetcher/now 供测试） ─────────────────────────────

export function createFeishuService({ fetcher = (...args) => fetch(...args), now = () => Date.now() } = {}) {
  const tokenCache = new Map();
  const eventSeen = new Map();

  async function callApi(env, path, init = {}) {
    const token = await tenantToken(env);
    let res;
    try {
      res = await fetcher(FEISHU_BASE + path, {
        ...init,
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(init.headers || {}) },
        signal: AbortSignal.timeout(10000),
      });
    } catch { throw new Error(`feishu api unreachable: ${path}`); }
    const data = await res.json().catch(() => ({}));
    if (!res.ok || (data.code !== undefined && data.code !== 0)) {
      throw new Error(`feishu api ${path} error: ${data.code ?? res.status} ${data.msg || ''}`);
    }
    return data;
  }

  async function tenantToken(env) {
    const saved = tokenCache.get(env.FEISHU_APP_ID);
    if (saved && saved.expires > now()) return saved.token;
    let res;
    try {
      res = await fetcher(`${FEISHU_BASE}/open-apis/auth/v3/tenant_access_token/internal`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(10000),
        body: JSON.stringify({ app_id: env.FEISHU_APP_ID, app_secret: env.FEISHU_APP_SECRET }),
      });
    } catch { throw new Error('feishu token endpoint unreachable'); }
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.code !== 0 || !data.tenant_access_token) throw new Error('feishu tenant token failed');
    tokenCache.set(env.FEISHU_APP_ID, {
      token: data.tenant_access_token,
      expires: now() + Math.max(60, (Number(data.expire) || 7200) - 120) * 1000,
    });
    return data.tenant_access_token;
  }

  async function sendCard(env, chatId, cardBody) {
    await callApi(env, '/open-apis/im/v1/messages?receive_id_type=chat_id', {
      method: 'POST', body: JSON.stringify({ receive_id: chatId, msg_type: 'interactive', content: JSON.stringify(cardBody) }),
    });
  }

  async function chatInfo(env, chatId) {
    return (await callApi(env, `/open-apis/im/v1/chats/${encodeURIComponent(chatId)}`))?.data || null;
  }

  async function feishuUser(env, openId) {
    return (await callApi(env, `/open-apis/contact/v3/users/${encodeURIComponent(openId)}?user_id_type=open_id`))?.data?.user || null;
  }

  // ── 账号与接入码（语义与 worker.js 的微信流程一致） ──

  async function accountByOpenId(env, openId) {
    return env.DB.prepare('SELECT id, nickname, avatar_path, avatar_url, rank_hidden FROM users WHERE openid = ?1')
      .bind(OPENID_PREFIX + openId).first() ?? null;
  }

  async function ensureConnectToken(env, userId) {
    const existing = await env.DB.prepare('SELECT token FROM connect_tokens WHERE user_id = ?1').bind(userId).first();
    if (existing) return existing.token;
    const token = hexToken(16);
    await env.DB.prepare('INSERT INTO connect_tokens (token, user_id, created_at) VALUES (?1, ?2, ?3)')
      .bind(token, userId, now()).run();
    return token;
  }

  async function bindAccount(env, openId) {
    let user = await accountByOpenId(env, openId);
    if (!user) {
      let nickname = null, avatarUrl = null;
      try {
        const info = await feishuUser(env, openId);
        nickname = sanitizeName(info?.name);
        avatarUrl = info?.avatar?.avatar_240 || info?.avatar?.avatar_origin || null;
      } catch { /* 接口不可用时用兜底昵称建号，不阻塞接入 */ }
      const fallback = '飞书用户-' + String(openId).replace(/[^a-zA-Z0-9]/g, '').slice(-4).padStart(4, '0');
      const ins = await env.DB.prepare(
        'INSERT INTO users (openid, nickname, avatar_url, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?4)')
        .bind(OPENID_PREFIX + openId, nickname || fallback, avatarUrl, now()).run();
      user = { id: ins.meta.last_row_id, nickname: nickname || fallback };
    }
    return { user, token: await ensureConnectToken(env, user.id) };
  }

  // ── 群与榜单 ──

  async function groupByChatId(env, chatId) {
    const hash = await feishuChatHash(chatId);
    const row = await env.DB.prepare('SELECT id, name FROM rank_groups WHERE group_openid_hash = ?1 ORDER BY created_at, id LIMIT 1')
      .bind(hash).first();
    return row ? { ...row, hash } : { id: null, name: DEFAULT_GROUP_NAME, hash };
  }

  async function joinGroup(env, user, chatId) {
    const found = await groupByChatId(env, chatId);
    if (found.id) {
      const res = await env.DB.prepare('INSERT OR IGNORE INTO rank_group_members (group_id, user_id, joined_at) VALUES (?1, ?2, ?3)')
        .bind(found.id, user.id, now()).run();
      return { created: false, joined: true, already: !res.meta?.changes, group: found };
    }
    let name = null;
    try { name = sanitizeGroupName((await chatInfo(env, chatId))?.name); } catch { /* 用默认名 */ }
    const id = groupId();
    // 条件 INSERT 原子防并发；与微信 resolveGroup 同一套防重复建榜逻辑
    await env.DB.batch([
      env.DB.prepare(`INSERT OR IGNORE INTO rank_groups (id, name, owner_user_id, created_at, group_openid_hash)
        SELECT ?1, ?2, ?3, ?4, ?5 WHERE NOT EXISTS (SELECT 1 FROM rank_groups WHERE group_openid_hash = ?5)`)
        .bind(id, name || DEFAULT_GROUP_NAME, user.id, now(), found.hash),
      env.DB.prepare(`INSERT OR IGNORE INTO rank_group_members (group_id, user_id, joined_at)
        SELECT id, ?2, ?3 FROM rank_groups WHERE group_openid_hash = ?1 ORDER BY created_at, id LIMIT 1`)
        .bind(found.hash, user.id, now()),
    ]);
    const group = await groupByChatId(env, chatId);
    return { created: group.id === id, joined: true, already: false, group };
  }

  async function membership(env, groupIdVal, userId) {
    return env.DB.prepare('SELECT hidden FROM rank_group_members WHERE group_id = ?1 AND user_id = ?2')
      .bind(groupIdVal, userId).first() ?? null;
  }

  async function boardRows(env, { groupId: gid = null, from, to }) {
    const memberFilter = gid ? ` AND ds.user_id IN (SELECT user_id FROM rank_group_members WHERE group_id = ?3 AND hidden = 0)` : '';
    const binds = gid ? [from, to, gid] : [from, to];
    const [rows, modelRows, upRow] = await Promise.all([
      env.DB.prepare(`SELECT u.id AS uid, u.nickname, SUM(ds.tokens) AS tokens, SUM(ds.requests) AS requests
        FROM public_usage ds JOIN users u ON u.id = ds.user_id
        WHERE ds.day >= ?1 AND ds.day <= ?2${memberFilter}
        GROUP BY ds.user_id HAVING tokens > 0 ORDER BY tokens DESC, uid ASC`).bind(...binds).all(),
      env.DB.prepare(`SELECT ds.user_id AS uid, json_extract(je.value, '$[0]') AS model, SUM(json_extract(je.value, '$[1]')) AS t
        FROM public_usage ds, json_each(ds.models_json) je
        WHERE ds.day >= ?1 AND ds.day <= ?2${memberFilter}
        GROUP BY ds.user_id, model`).bind(...binds).all(),
      env.DB.prepare(`SELECT MAX(ds.updated_at) AS ts FROM public_usage ds WHERE ds.day >= ?1 AND ds.day <= ?2${memberFilter}`)
        .bind(...binds).first(),
    ]);
    const topModel = new Map();
    for (const r of modelRows.results) {
      const cur = topModel.get(r.uid);
      if (!cur || r.t > cur) topModel.set(r.uid, r.model);
    }
    return {
      entries: rows.results.map((r) => ({
        uid: r.uid,
        nickname: r.nickname || `飞书用户-${String(r.uid).slice(-4).padStart(4, '0')}`,
        tokens: r.tokens, requests: r.requests,
        top_model: topModel.get(r.uid) ?? null,
      })),
      updatedAt: upRow?.ts ?? null,
    };
  }

  async function myGroupStanding(env, gid, userId, from, to) {
    const mine = await env.DB.prepare(`SELECT SUM(ds.tokens) AS t FROM public_usage ds
      WHERE ds.user_id = ?1 AND ds.day >= ?2 AND ds.day <= ?3
      AND ds.user_id IN (SELECT user_id FROM rank_group_members WHERE group_id = ?4 AND hidden = 0)`)
      .bind(userId, from, to, gid).first();
    const myTokens = mine?.t || 0;
    if (!myTokens) return null;
    const ahead = await env.DB.prepare(`SELECT COUNT(*) AS c FROM (
      SELECT ds.user_id, SUM(ds.tokens) AS total FROM public_usage ds
      WHERE ds.day >= ?2 AND ds.day <= ?3
      AND ds.user_id IN (SELECT user_id FROM rank_group_members WHERE group_id = ?4 AND hidden = 0)
      GROUP BY ds.user_id HAVING total > ?1 OR (total = ?1 AND ds.user_id < ?5))`)
      .bind(myTokens, from, to, gid, userId).first();
    return { rank: (ahead?.c || 0) + 1, tokens: myTokens };
  }

  async function personalSummary(env, userId, nowMs) {
    const today = beijingDay(nowMs);
    const weekFrom = beijingDaysAgo(6, nowMs);
    // 今日总量要先算出来才能算广场名次（阈值绑定），不能和其余查询混在同一个 Promise.all
    const todayRow = await env.DB.prepare('SELECT SUM(tokens) AS t, SUM(requests) AS r FROM ranked_usage WHERE user_id = ?1 AND day = ?2')
      .bind(userId, today).first();
    const [weekRow, lifeRow, detailRows, standingRow] = await Promise.all([
      env.DB.prepare('SELECT SUM(tokens) AS t FROM ranked_usage WHERE user_id = ?1 AND day >= ?2 AND day <= ?3')
        .bind(userId, weekFrom, today).first(),
      env.DB.prepare(`SELECT SUM(tokens) AS t, COUNT(*) AS days, MIN(day) AS first_day, MAX(updated_at) AS updated_at
        FROM ranked_usage WHERE user_id = ?1 AND (tokens > 0 OR requests > 0)`).bind(userId).first(),
      env.DB.prepare('SELECT models_json, tools_json FROM ranked_usage WHERE user_id = ?1 AND day >= ?2 AND day <= ?3')
        .bind(userId, weekFrom, today).all(),
      env.DB.prepare(`SELECT COUNT(*) AS c FROM (
        SELECT user_id, SUM(tokens) AS total FROM public_usage WHERE day = ?2 GROUP BY user_id
        HAVING total > ?1)`).bind(todayRow?.t || 0, today).first(),
    ]);
    const tally = (rows, pick) => {
      const map = new Map();
      for (const row of rows) {
        for (const pair of pick(row) || []) {
          if (Array.isArray(pair) && typeof pair[0] === 'string') map.set(pair[0], (map.get(pair[0]) || 0) + (Number(pair[1]) || 0));
        }
      }
      return [...map.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
    };
    return {
      today: todayRow?.t || 0, todayRequests: todayRow?.r || 0,
      week: weekRow?.t || 0,
      lifetime: lifeRow?.t || 0, days: lifeRow?.days || 0, firstDay: lifeRow?.first_day ?? null,
      lastReportAt: lifeRow?.updated_at ?? null,
      topModel: tally(detailRows.results, (r) => JSON.parse(r.models_json || '[]')),
      topTool: tally(detailRows.results, (r) => JSON.parse(r.tools_json || '[]')),
      globalRankToday: (todayRow?.t || 0) > 0 ? (standingRow?.c || 0) + 1 : null,
    };
  }

  function personalCard(user, s, nowMs) {
    if (!s.lifetime && !s.today) {
      return connectHintCard('还没有收到你的用量。先在单聊里发「**绑定**」拿到接入命令，在电脑上运行即可。');
    }
    const lines = [
      `**今日**　${formatTokens(s.today)} tokens　·　${s.todayRequests} 次调用`,
      `**本周**　${formatTokens(s.week)} tokens`,
      `**累计**　${formatTokens(s.lifetime)} tokens　·　上报 ${s.days} 天` + (s.firstDay ? `（自 ${s.firstDay}）` : ''),
    ];
    if (s.topTool || s.topModel) {
      lines.push(`**本周偏好**　${[s.topTool, s.topModel].filter(Boolean).map(md).join(' / ')}`);
    }
    if (s.globalRankToday) lines.push(`**今日广场排名**　第 ${s.globalRankToday} 名`);
    return card('violet', `我的用量 · ${md(user.nickname || '')}`, [
      { tag: 'div', text: { tag: 'lark_md', content: lines.join('\n') } },
      ...(s.lastReportAt ? [{ tag: 'note', elements: [{ tag: 'plain_text',
        content: `最近上报 ${Math.max(1, Math.round((nowMs - s.lastReportAt) / 60000))} 分钟前（北京时间按天汇总）` }] }] : []),
    ]);
  }

  function connectHintCard(content) {
    return textCard('Token 群排名', content, 'orange');
  }

  // ── 事件分发 ──

  async function dispatch(env, origin, event) {
    const openId = event?.sender?.sender_id?.open_id;
    const msg = event?.message;
    if (!openId || !msg?.chat_id || msg.message_type !== 'text') return;
    const createdAt = Number(msg.create_time || 0);
    if (createdAt && Math.abs(now() - createdAt) > EVENT_MAX_AGE_MS) return;
    const isGroup = msg.chat_type === 'group';
    let text = '';
    try { text = String(JSON.parse(msg.content || '{}').text ?? ''); } catch { return; }
    const command = parseCommand(text);
    const reply = (cardBody) => sendCard(env, msg.chat_id, cardBody);
    if (!command) {
      if (!isGroup) await reply(helpCard({}));
      return;
    }
    const account = ['rank', 'my', 'join', 'leave', 'hide', 'show'].includes(command.cmd)
      ? await accountByOpenId(env, openId) : null;

    if (command.cmd === 'help') return reply(helpCard({ groupReady: isGroup ? undefined : null }));

    if (command.cmd === 'bind') {
      if (isGroup) {
        return reply(textCard('电脑接入', '接入码是私人凭证，不在群里发送。**请点我的头像进入单聊，发送「绑定」**。', 'orange'));
      }
      const { user, token } = await bindAccount(env, openId);
      return reply(connectCard(origin, token));
    }

    if (command.cmd === 'my') {
      if (isGroup) return reply(textCard('我的用量', '个人用量只发单聊。**请单聊我发送「我的」**。', 'grey'));
      if (!account) return reply(connectHintCard('还没有你的账号。先发「**绑定**」接入电脑，再来查看用量。'));
      return reply(personalCard(account, await personalSummary(env, account.id, now()), now()));
    }

    if (command.cmd === 'join') {
      if (!isGroup) return reply(textCard('加入群榜', '「加入」要在**群聊**里发：把我拉进群后，在群里发「加入」即可上榜。', 'grey'));
      if (!account) return reply(connectHintCard('先单聊我发「**绑定**」接入电脑，再回群里发「加入」上榜。'));
      const result = await joinGroup(env, account, msg.chat_id);
      const verb = result.created ? '已创建本群榜单，并把你加入榜单' : result.already ? '你已经在榜单里了' : '已把你加入本群榜单';
      return reply(textCard('加入群榜', `${verb}：**${md(result.group.name)}**。发「**榜单**」看看排名。`, 'green'));
    }

    if (['leave', 'hide', 'show'].includes(command.cmd)) {
      if (!isGroup) return reply(textCard('群设置', '「退出/隐藏/显示」要在**群聊**里发。', 'grey'));
      if (!account) return reply(connectHintCard('先单聊我发「**绑定**」接入电脑，再回来设置。'));
      const found = await groupByChatId(env, msg.chat_id);
      if (!found.id) return reply(textCard('群设置', '本群还没有榜单，先发「**加入**」创建。', 'grey'));
      if (command.cmd === 'leave') {
        const res = await env.DB.prepare('DELETE FROM rank_group_members WHERE group_id = ?1 AND user_id = ?2')
          .bind(found.id, account.id).run();
        return reply(textCard('退出群榜', res.meta?.changes ? '已退出本群榜单，历史用量保留、不再出现在本群。' : '你本来就不在这张榜单里。', 'grey'));
      }
      const hidden = command.cmd === 'hide' ? 1 : 0;
      const res = await env.DB.prepare('UPDATE rank_group_members SET hidden = ?1 WHERE group_id = ?2 AND user_id = ?3')
        .bind(hidden, found.id, account.id).run();
      if (!res.meta?.changes) return reply(textCard('群设置', '你还没加入本群榜单，先发「**加入**」。', 'grey'));
      return reply(textCard('群排名可见性', hidden ? '已在本群隐藏你的排名；其他群和广场不受影响。' : '已恢复在本群显示你的排名。', 'grey'));
    }

    // rank
    const nowMs = now();
    const [from, to] = periodRange(command.period, nowMs);
    if (isGroup) {
      const found = await groupByChatId(env, msg.chat_id);
      if (!found.id) {
        return reply(textCard('本群还没有榜单', '先单聊我发「**绑定**」接入电脑，再回群里发「**加入**」创建本群榜单。', 'orange'));
      }
      const [board, memberCount, mine] = await Promise.all([
        boardRows(env, { groupId: found.id, from, to }),
        env.DB.prepare('SELECT COUNT(*) AS c FROM rank_group_members WHERE group_id = ?1').bind(found.id).first(),
        account ? myGroupStanding(env, found.id, account.id, from, to) : Promise.resolve(null),
      ]);
      const footerBits = [];
      if (mine) footerBits.push(`你排第 **${mine.rank}** 名（${formatTokens(mine.tokens)} tokens）`);
      if (account && !(await membership(env, found.id, account.id))) footerBits.push('你还未上榜，发「**加入**」加入');
      return reply(leaderboardCard({
        title: `${md(found.name)} · Token 排行榜（${PERIOD_LABELS[command.period]}）`,
        entries: board.entries, members: memberCount?.c ?? null, updatedAt: board.updatedAt, nowMs,
        footer: footerBits.join('\n') || null,
      }));
    }
    const board = await boardRows(env, { from, to });
    return reply(leaderboardCard({
      title: `广场 · Token 排行榜（${PERIOD_LABELS[command.period]}）`,
      entries: board.entries, members: null, updatedAt: board.updatedAt, nowMs, footer: null,
    }));
  }

  // ── 事件回调入口：POST /feishu/event ──

  async function decryptBody(encryptKey, encryptB64) {
    const raw = Uint8Array.from(atob(encryptB64), (c) => c.charCodeAt(0));
    const keyBytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(encryptKey)));
    const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'AES-CBC' }, false, ['decrypt']);
    const plain = await crypto.subtle.decrypt({ name: 'AES-CBC', iv: raw.slice(0, 16) }, key, raw.slice(16));
    return JSON.parse(new TextDecoder().decode(plain));
  }

  async function handle(request, env, ctx) {
    const respond = () => Response.json({}, { headers: { 'cache-control': 'no-store' } });
    let body;
    try { body = await request.json(); } catch { return respond(); }
    // 开启加密策略时，url_verification 校验请求同样是密文，必须先解密再判断类型
    if (body?.encrypt) {
      if (!env.FEISHU_ENCRYPT_KEY) return respond();
      try { body = await decryptBody(env.FEISHU_ENCRYPT_KEY, body.encrypt); } catch { return respond(); }
    }
    if (body?.type === 'url_verification') {
      return Response.json({ challenge: String(body.challenge ?? '').slice(0, 256) }, { headers: { 'cache-control': 'no-store' } });
    }
    if (!env.FEISHU_APP_ID || !env.FEISHU_APP_SECRET) return respond();
    const header = body?.header;
    if (!header?.event_id || header.event_type !== 'im.message.receive_v1') return respond();
    if (env.FEISHU_VERIFICATION_TOKEN && header.token !== env.FEISHU_VERIFICATION_TOKEN) return respond();
    if (eventSeen.has(header.event_id)) return respond();
    eventSeen.set(header.event_id, now());
    if (eventSeen.size > 512) {
      for (const [id, ts] of eventSeen) {
        if (eventSeen.size <= 384) break;
        if (now() - ts > 3_600_000) eventSeen.delete(id);
      }
    }

    const origin = env.PUBLIC_BASE_URL || new URL(request.url).origin;
    const work = (async () => {
      // 飞书对失败回调会重试：event_id 落库幂等，同一条消息只处理一次
      const ins = await env.DB.prepare('INSERT OR IGNORE INTO feishu_event_log (event_id, seen_at) VALUES (?1, ?2)')
        .bind(header.event_id, now()).run();
      if (!ins.meta?.changes) return;
      await env.DB.prepare('DELETE FROM feishu_event_log WHERE seen_at < ?1')
        .bind(now() - EVENT_LOG_TTL_MS).run();
      await dispatch(env, origin, body.event);
    })();
    const guarded = work.catch((err) => { console.error('feishu event:', err?.message); });
    if (ctx?.waitUntil) ctx.waitUntil(guarded); else await guarded;
    return respond();
  }

  return { handle, _internals: { dispatch, boardRows, personalSummary, bindAccount, joinGroup } };
}

export const feishu = createFeishuService();
