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

/** 飞书 HTTP 回调签名：sha256(timestamp + nonce + encryptKey + rawBody) */
export async function feishuSignature(timestamp, nonce, encryptKey, rawBody) {
  const data = new TextEncoder().encode(`${timestamp}${nonce}${encryptKey}${rawBody}`);
  const buf = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function constantTimeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}


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

// ───────────────────────────── 卡片（飞书卡片 JSON 2.0，复刻小程序白底列表规范） ─────────────────────────────
// 小程序视觉规范：白底、普通数字名次、圆头像、单行昵称、右对齐橙色成绩、细分隔线、
// 本人行突出（卡片不支持行底色，用整体加粗替代）、数字主导、无口号文案。

const mdEscape = (s) => String(s ?? '').replace(/[*`_[\]]/g, '');

function markdown(content, { size = 'normal' } = {}) {
  return { tag: 'markdown', content, ...(size !== 'normal' ? { text_size: size } : {}) };
}
function rowOf(columns) {
  return { tag: 'column_set', flex_mode: 'none', background_style: 'default', columns };
}
function col(weight, elements, { vertical = 'center' } = {}) {
  return { tag: 'column', width: 'weighted', weight, vertical_align: vertical, elements };
}
const divider = () => ({ tag: 'hr' });
const noteEl = (text) => markdown(`<font color='grey'>${mdEscape(text)}</font>`);
const cardBody = (elements) => ({
  schema: '2.0',
  config: { update_multi: true },
  body: { elements },
});

/** 把 formatTokens 的结果拆成数字与单位两段，供大数字排版（数字大、单位小） */
export function splitAmount(n) {
  const text = formatTokens(n);
  const at = text.lastIndexOf(' ');
  return at < 0 ? { num: text, unit: '' } : { num: text.slice(0, at), unit: text.slice(at + 1) };
}

export function helpCard({ groupReady, appUrl }) {
  const lines = [
    '### Token 群排名 · 使用帮助', '',
    '**群内命令**（把我拉进群后直接发）', '',
    '**榜单 [今日|本周|本月|总榜]**　看本群 Token 排行',
    '**加入**　上榜本群（需先在单聊完成电脑接入）',
    '**隐藏 / 显示**　在本群隐藏或恢复自己的排名',
    '**退出**　退出本群榜单', '',
    '**单聊命令**', '',
    '**绑定**　获取电脑接入码和安装命令（接入码只发单聊）',
    '**我的**　查看个人用量日报',
    '**榜单**　看广场总榜',
  ];
  if (groupReady === false) lines.push('', '本群还没有榜单：先单聊我「绑定」接入电脑，再回群里发「加入」。');
  return cardBody([
    markdown(lines.join('\n')),
    ...(appUrl ? [divider(), markdown(`[打开网页应用（群榜 / 我的用量）](${appUrl})`)] : []),
    divider(),
    noteEl('用量是各成员电脑自报的按天汇总数字，仅作交流参考，不等于厂商账单'),
  ]);
}

/** 千分位整数（对标小程序 integer()） */
export function integer(n) {
  return String(Math.max(0, Math.round(Number(n) || 0))).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

const avatarImg = (imgKey) => ({
  tag: 'img', img_key: imgKey, alt: { tag: 'plain_text', content: '头像' },
  // 32px 更贴合 1/14 列宽，减少左右留白；单行行高与头像同高，避免上下错位
  custom_width: 32, corner_radius: '16px',
});

const PERIOD_TABS = [['day', '今日'], ['week', '本周'], ['month', '本月'], ['all', '总榜']];

/** 榜单：对标小程序排行榜——表头行、名次+圆头像+昵称/灰色模型名+橙色成绩、本人灰底置顶行 */
export function leaderboardCard({ title, entries, members, updatedAt, nowMs, period = 'day', meUid, me, footer, appUrl }) {
  const elements = [];
  elements.push(markdown(`### ${mdEscape(title)}`));
  // 周期 Tab 行（仿小程序 tabs）：当前周期橙色加粗，其余灰色
  elements.push(markdown(PERIOD_TABS.map(([k, label]) =>
    k === period ? `**<font color='orange'>${label}</font>**` : `<font color='grey'>${label}</font>`).join('　')));
  elements.push(divider());
  // 五列单行（序号/头像/成员/模型/用量）：单行等高，头像垂直居中，各列左右对齐
  const credits2 = (n) => (Number(n) || 0).toFixed(2);
  const W_RANK = 1, W_AVATAR = 1, W_NAME = 5, W_MODEL = 4, W_VALUE = 3; // 合计 14
  const empty = "<font color='grey'></font>";
  const boardRow = ({ rank, entry, nameHtml, suffix = '', modelText, valueText, bold, grey }) => {
    const text = (content) => markdown(content);
    const columns = [
      col(W_RANK, [text(String(rank))]),
      col(W_AVATAR, [entry.img_key ? avatarImg(entry.img_key) : text(empty)]),
      col(W_NAME, [text(`${bold ? `**${nameHtml}**` : nameHtml}${suffix}`)]),
      col(W_MODEL, [text(modelText ? `<font color='grey'>${mdEscape(modelText)}</font>` : empty)]),
      col(W_VALUE, [text(`<font color='orange'>${bold ? '**' : ''}${valueText}${bold ? '**' : ''}</font>`)]),
    ];
    return grey
      ? { tag: 'column_set', flex_mode: 'none', background_style: 'grey', columns }
      : rowOf(columns);
  };
  const tokenEntries = entries.filter((e) => (e.tokens || 0) > 0);
  elements.push(rowOf([
    col(W_RANK, [markdown(`<font color='grey'>#</font>`)]),
    col(W_AVATAR, [markdown(empty)]),
    col(W_NAME, [markdown(`<font color='grey'>成员 · ${members ?? tokenEntries.length} 人</font>`)]),
    col(W_MODEL, [markdown(`<font color='grey'>模型</font>`)]),
    col(W_VALUE, [markdown(`<font color='grey'>Token 用量</font>`)]),
  ]));
  if (!tokenEntries.length) {
    elements.push(markdown('这个时间段还没有人上报 Token 用量。先单聊我「**绑定**」接入电脑，再回来发「**加入**」上榜。'));
  }
  tokenEntries.slice(0, BOARD_LIMIT).forEach((e, i) => {
    const mine = meUid != null && e.uid === meUid;
    elements.push(boardRow({ rank: i + 1, entry: e,
      nameHtml: mdEscape(String(e.nickname || '').slice(0, 14)), suffix: mine ? ' 我' : '',
      modelText: e.top_model || '', valueText: formatTokens(e.tokens), bold: mine }));
    elements.push(divider());
  });
  // 我的行：只有本人没出现在上面列表里（50 名外/未展示）才补一行灰底，避免与榜内行重复；
  // 纯 Credits 用户没有 token 数字，不在 Token 榜补 0 值行
  const meInTokensBoard = meUid != null && tokenEntries.slice(0, BOARD_LIMIT).some((e) => e.uid === meUid);
  if (me && (me.tokens || 0) > 0 && !meInTokensBoard) {
    elements.push(boardRow({ rank: me.rank, entry: {}, nameHtml: mdEscape(me.nickname), suffix: ' 我',
      modelText: me.top_model || '', valueText: formatTokens(me.tokens), bold: true, grey: true }));
  }
  // Credits 榜单（Qoder 等按 Credits 计费的工具），与 Token 榜并列
  const creditsEntries = entries.filter((e) => (e.credits || 0) > 0).sort((a, b) => b.credits - a.credits || a.uid - b.uid);
  if (creditsEntries.length) {
    elements.push(markdown(`### <font color='grey'>Credits 榜单</font>`));
    elements.push(markdown(`<font color='grey'>Qoder 等按 Credits 计费的工具</font>`));
    elements.push(rowOf([
      col(W_RANK, [markdown(`<font color='grey'>#</font>`)]),
      col(W_AVATAR, [markdown(empty)]),
      col(W_NAME, [markdown(`<font color='grey'>成员 · ${creditsEntries.length} 人</font>`)]),
      col(W_MODEL, [markdown(empty)]),
      col(W_VALUE, [markdown(`<font color='grey'>Credits</font>`)]),
    ]));
    creditsEntries.slice(0, BOARD_LIMIT).forEach((e, i) => {
      const mine = meUid != null && e.uid === meUid;
      elements.push(boardRow({ rank: i + 1, entry: e,
        nameHtml: mdEscape(String(e.nickname || '').slice(0, 14)), suffix: mine ? ' 我' : '',
        modelText: '', valueText: `${credits2(e.credits)} Credits`, bold: mine }));
      elements.push(divider());
    });
    const meInCreditsBoard = meUid != null && creditsEntries.slice(0, BOARD_LIMIT).some((e) => e.uid === meUid);
    if (me && (me.credits || 0) > 0 && !meInCreditsBoard) {
      elements.push(boardRow({ rank: me.credits_rank ?? '-', entry: {}, nameHtml: mdEscape(me.nickname), suffix: ' 我',
        modelText: '', valueText: `${credits2(me.credits)} Credits`, bold: true, grey: true }));
    }
    if (creditsEntries.length > BOARD_LIMIT) elements.push(noteEl(`Credits 榜单仅展示前 ${BOARD_LIMIT} 名，共 ${creditsEntries.length} 人有 Credits 用量`));
  }
  if (tokenEntries.length > BOARD_LIMIT) {
    elements.push(noteEl(`Token 榜仅展示前 ${BOARD_LIMIT} 名，共 ${tokenEntries.length} 人有用量`));
  }
  if (footer) elements.push(markdown(footer));
  if (appUrl) elements.push(markdown(`[打开网页版完整界面（工具 / 模型分布图）](${appUrl})`));
  const bits = [];
  if (updatedAt && nowMs && nowMs > updatedAt) bits.push(`更新于 ${Math.max(1, Math.round((nowMs - updatedAt) / 60000))} 分钟前`);
  bits.push('数据由用户电脑上报，仅供参考');
  elements.push(noteEl(bits.join(' · ')));
  return cardBody(elements);
}

export function connectCard(origin, token) {
  const base = String(origin || '').replace(/\/+$/, '');
  const sh = `curl -fsSL ${base}/install.sh | sh -s ${base} ${token}`;
  const ps = `& ([scriptblock]::Create((irm '${base}/install.ps1'))) '${base}' '${token}'`;
  return cardBody([
    markdown('### 电脑接入'),
    divider(),
    markdown('电脑装好 [Node.js 22+](https://nodejs.org) 后运行对应系统的命令（从本服务下载安装包，不走第三方源）：'),
    markdown('**macOS / Linux**\n`' + sh + '`'),
    markdown('**Windows PowerShell**\n`' + ps + '`'),
    markdown('运行一次即可，之后每 5 分钟自动上报一次按天汇总的数字。'),
    divider(),
    markdown(`**接入码**（重置即作废旧码，请勿转发）：\n\`${token}\``),
    divider(),
    markdown('接入后在群里发「**加入**」上榜，发「**榜单**」看排行。'),
    divider(),
    markdown(`[打开网页应用（群榜 / 我的用量）](${base}/app)`),
    noteEl('只上报每天的 token 数、调用次数和工具/模型名，不含代码、对话和文件路径'),
  ]);
}

export function textCard(title, content, appUrl) {
  return cardBody([markdown(`### ${mdEscape(title)}`), divider(), markdown(content),
    ...(appUrl ? [divider(), markdown(`[打开网页应用](${appUrl})`)] : [])]);
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

  // ── 头像：上传飞书换 img_key（卡片里展示圆形小头像），按来源缓存避免重复上传 ──

  async function uploadImage(env, bytes, mime) {
    const token = await tenantToken(env);
    const form = new FormData();
    form.append('image_type', 'message');
    form.append('image', new Blob([bytes], { type: mime || 'image/png' }), 'avatar.png');
    let res;
    try {
      res = await fetcher(`${FEISHU_BASE}/open-apis/im/v1/images?image_type=message`, {
        method: 'POST', headers: { authorization: `Bearer ${token}` }, body: form, signal: AbortSignal.timeout(15000),
      });
    } catch { throw new Error('feishu image upload unreachable'); }
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.code !== 0 || !data?.data?.image_key) throw new Error(`feishu image upload failed: ${data.code ?? res.status}`);
    return data.data.image_key;
  }

  async function avatarBytes(env, entry) {
    if (entry.avatar_path) {
      const row = await env.DB.prepare('SELECT content, mime_type FROM user_avatars WHERE user_id = ?1').bind(entry.uid).first();
      if (row?.content?.length) return { bytes: new Uint8Array(row.content), mime: row.mime_type };
    }
    if (entry.avatar_url) {
      try {
        const res = await fetcher(entry.avatar_url, { signal: AbortSignal.timeout(10000) });
        if (res.ok) return { bytes: new Uint8Array(await res.arrayBuffer()), mime: res.headers.get('content-type') || 'image/png' };
      } catch { /* 头像拉不到就退化为无头像 */ }
    }
    return null;
  }

  /** 失败返回 null（榜单退化为无头像列），不影响主流程 */
  async function ensureAvatarKey(env, entry) {
    try {
      const source = entry.avatar_path || entry.avatar_url;
      if (!source) return null;
      const cached = await env.DB.prepare('SELECT image_key, source FROM feishu_avatar_cache WHERE user_id = ?1').bind(entry.uid).first();
      if (cached && cached.source === source) return cached.image_key;
      const data = await avatarBytes(env, entry);
      if (!data) return null;
      const key = await uploadImage(env, data.bytes, data.mime);
      await env.DB.prepare(`INSERT INTO feishu_avatar_cache (user_id, image_key, source, updated_at) VALUES (?1, ?2, ?3, ?4)
        ON CONFLICT(user_id) DO UPDATE SET image_key = excluded.image_key, source = excluded.source, updated_at = excluded.updated_at`)
        .bind(entry.uid, key, source, now()).run();
      return key;
    } catch {
      return null;
    }
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
      env.DB.prepare(`SELECT u.id AS uid, u.nickname, u.avatar_path, u.avatar_url,
        SUM(ds.tokens) AS tokens, SUM(ds.requests) AS requests,
        SUM(COALESCE(json_extract(ds.credits_json,'$.total'),0)) AS credits
        FROM public_usage ds JOIN users u ON u.id = ds.user_id
        WHERE ds.day >= ?1 AND ds.day <= ?2${memberFilter}
        GROUP BY ds.user_id HAVING SUM(ds.tokens) > 0 OR SUM(COALESCE(json_extract(ds.credits_json,'$.total'),0)) > 0 ORDER BY SUM(ds.tokens) DESC, uid ASC`).bind(...binds).all(),
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
        avatar_path: r.avatar_path ?? null, avatar_url: r.avatar_url ?? null,
        tokens: r.tokens, requests: r.requests,
        credits: Math.round((r.credits || 0) * 1e6) / 1e6,
        top_model: topModel.get(r.uid) ?? null,
      })),
      updatedAt: upRow?.ts ?? null,
    };
  }

  /** 广场（全站）口径下的我的名次，供榜单置顶“我的行”；tokens 与 credits 双指标 */
  async function globalStanding(env, userId, from, to) {
    const mine = await env.DB.prepare(`SELECT SUM(ds.tokens) AS t, SUM(COALESCE(json_extract(ds.credits_json,'$.total'),0)) AS c
      FROM public_usage ds WHERE ds.user_id = ?1 AND ds.day >= ?2 AND ds.day <= ?3`)
      .bind(userId, from, to).first();
    const myTokens = mine?.t || 0, myCredits = mine?.c || 0;
    if (!myTokens && !myCredits) return null;
    const [aheadTokens, aheadCredits] = await Promise.all([
      env.DB.prepare(`SELECT COUNT(*) AS c FROM (
        SELECT ds.user_id, SUM(ds.tokens) AS total FROM public_usage ds
        WHERE ds.day >= ?2 AND ds.day <= ?3
        GROUP BY ds.user_id HAVING total > ?1 OR (total = ?1 AND ds.user_id < ?4))`)
        .bind(myTokens, from, to, userId).first(),
      myCredits > 0 ? env.DB.prepare(`SELECT COUNT(*) AS c FROM (
        SELECT ds.user_id, SUM(COALESCE(json_extract(ds.credits_json,'$.total'),0)) AS total FROM public_usage ds
        WHERE ds.day >= ?2 AND ds.day <= ?3
        GROUP BY ds.user_id HAVING total > ?1 OR (total = ?1 AND ds.user_id < ?4))`)
        .bind(myCredits, from, to, userId).first() : Promise.resolve(null),
    ]);
    return { rank: (aheadTokens?.c || 0) + 1, tokens: myTokens,
      credits: Math.round(myCredits * 1e6) / 1e6, credits_rank: aheadCredits ? (aheadCredits.c || 0) + 1 : null };
  }

  async function myGroupStanding(env, gid, userId, from, to) {
    const memberSql = 'AND ds.user_id IN (SELECT user_id FROM rank_group_members WHERE group_id = ?4 AND hidden = 0)';
    const mine = await env.DB.prepare(`SELECT SUM(ds.tokens) AS t, SUM(COALESCE(json_extract(ds.credits_json,'$.total'),0)) AS c FROM public_usage ds
      WHERE ds.user_id = ?1 AND ds.day >= ?2 AND ds.day <= ?3 ${memberSql}`)
      .bind(userId, from, to, gid).first();
    const myTokens = mine?.t || 0, myCredits = mine?.c || 0;
    if (!myTokens && !myCredits) return null;
    const [aheadTokens, aheadCredits] = await Promise.all([
      env.DB.prepare(`SELECT COUNT(*) AS c FROM (
        SELECT ds.user_id, SUM(ds.tokens) AS total FROM public_usage ds
        WHERE ds.day >= ?2 AND ds.day <= ?3 ${memberSql}
        GROUP BY ds.user_id HAVING total > ?1 OR (total = ?1 AND ds.user_id < ?5))`)
        .bind(myTokens, from, to, gid, userId).first(),
      myCredits > 0 ? env.DB.prepare(`SELECT COUNT(*) AS c FROM (
        SELECT ds.user_id, SUM(COALESCE(json_extract(ds.credits_json,'$.total'),0)) AS total FROM public_usage ds
        WHERE ds.day >= ?2 AND ds.day <= ?3 ${memberSql}
        GROUP BY ds.user_id HAVING total > ?1 OR (total = ?1 AND ds.user_id < ?5))`)
        .bind(myCredits, from, to, gid, userId).first() : Promise.resolve(null),
    ]);
    return { rank: (aheadTokens?.c || 0) + 1, tokens: myTokens,
      credits: Math.round(myCredits * 1e6) / 1e6, credits_rank: aheadCredits ? (aheadCredits.c || 0) + 1 : null };
  }

  async function personalSummary(env, userId, nowMs) {
    const today = beijingDay(nowMs);
    const weekFrom = beijingDaysAgo(6, nowMs);
    // 今日总量要先算出来才能算广场名次（阈值绑定），不能和其余查询混在同一个 Promise.all
    const todayRow = await env.DB.prepare(`SELECT SUM(tokens) AS t, SUM(requests) AS r,
      SUM(COALESCE(json_extract(credits_json,'$.total'),0)) AS c FROM ranked_usage WHERE user_id = ?1 AND day = ?2`)
      .bind(userId, today).first();
    const [weekRow, lifeRow, detailRows, standingRow, creditsStandingRow] = await Promise.all([
      env.DB.prepare(`SELECT SUM(tokens) AS t, SUM(COALESCE(json_extract(credits_json,'$.total'),0)) AS c
        FROM ranked_usage WHERE user_id = ?1 AND day >= ?2 AND day <= ?3`)
        .bind(userId, weekFrom, today).first(),
      env.DB.prepare(`SELECT SUM(tokens) AS t, SUM(COALESCE(json_extract(credits_json,'$.total'),0)) AS c, COUNT(*) AS days, MIN(day) AS first_day, MAX(updated_at) AS updated_at
        FROM ranked_usage WHERE user_id = ?1 AND (tokens > 0 OR requests > 0 OR COALESCE(json_extract(credits_json,'$.total'),0) > 0)`).bind(userId).first(),
      env.DB.prepare('SELECT models_json, tools_json FROM ranked_usage WHERE user_id = ?1 AND day >= ?2 AND day <= ?3')
        .bind(userId, weekFrom, today).all(),
      env.DB.prepare(`SELECT COUNT(*) AS c FROM (
        SELECT user_id, SUM(tokens) AS total FROM public_usage WHERE day = ?2 GROUP BY user_id
        HAVING total > ?1)`).bind(todayRow?.t || 0, today).first(),
      (todayRow?.c || 0) > 0 ? env.DB.prepare(`SELECT COUNT(*) AS c FROM (
        SELECT user_id, SUM(COALESCE(json_extract(credits_json,'$.total'),0)) AS total FROM public_usage WHERE day = ?2 GROUP BY user_id
        HAVING total > ?1)`).bind(todayRow?.c || 0, today).first() : Promise.resolve(null),
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
      todayCredits: Math.round((todayRow?.c || 0) * 1e6) / 1e6,
      week: weekRow?.t || 0,
      weekCredits: Math.round((weekRow?.c || 0) * 1e6) / 1e6,
      lifetime: lifeRow?.t || 0, days: lifeRow?.days || 0, firstDay: lifeRow?.first_day ?? null,
      lifetimeCredits: Math.round((lifeRow?.c || 0) * 1e6) / 1e6,
      lastReportAt: lifeRow?.updated_at ?? null,
      topModel: tally(detailRows.results, (r) => JSON.parse(r.models_json || '[]')),
      topTool: tally(detailRows.results, (r) => JSON.parse(r.tools_json || '[]')),
      globalRankToday: (todayRow?.t || 0) > 0 ? (standingRow?.c || 0) + 1 : null,
      creditsRankToday: creditsStandingRow ? (creditsStandingRow.c || 0) + 1 : null,
    };
  }

  /** 个人用量卡：对标小程序「我的用量」——橙色大数字、完整整数、日期区间、两列统计 */
  function personalCard(user, s, nowMs, appUrl) {
    if (!s.lifetime && !s.today && !s.todayCredits && !s.weekCredits) {
      return textCard('Token 群排名', '还没有收到你的用量。先在单聊里发「**绑定**」拿到接入命令，在电脑上运行即可。', appUrl);
    }
    // 纯 Credits 计费用户（Qoder 等）没有 token 数字，大数字位直接显示今日 Credits
    const creditsOnly = !s.today && !s.lifetime && !s.todayRequests && (s.todayCredits || s.lifetimeCredits);
    const hero = creditsOnly ? { num: (s.todayCredits || 0).toFixed(2), unit: 'Credits' } : splitAmount(s.today);
    const today = beijingDay(nowMs);
    const syncTime = s.lastReportAt
      ? new Date(s.lastReportAt + 8 * 3600000).toISOString().slice(5, 16).replace('T', ' ')
      : null;
    const statCell = (value, label) => col(4, [
      markdown(`**${value}**`),
      markdown(`<font color='grey'>${label}</font>`),
    ]);
    const elements = [
      markdown(creditsOnly ? `<font color='grey'>我的用量 · 今日 · Credits</font>` : `<font color='grey'>我的用量 · 今日 · 总用量 · 含缓存</font>`),
      markdown(`## <font color='orange'>${hero.num}${hero.unit ? ' ' + hero.unit : ''}</font>`),
      markdown(creditsOnly
        ? `<font color='grey'>Credits · 本周 ${(s.weekCredits || 0).toFixed(2)} · 累计 ${(s.lifetimeCredits || 0).toFixed(2)}${s.creditsRankToday ? ` · 今日 Credits 榜第 ${s.creditsRankToday} 名` : ''}</font>`
        : `<font color='grey'>tokens · ${integer(s.todayRequests)} 次调用 · 累计 ${formatTokens(s.lifetime)} · ${integer(s.lifetime)} tokens</font>`),
      markdown(`<font color='grey'>${s.firstDay ? `${s.firstDay} — ` : ''}${today} · 北京时间${syncTime ? ` · 同步于 ${syncTime}` : ''}</font>`),
      ...(!creditsOnly && (s.todayCredits || s.weekCredits) ? [markdown(
        `<font color='grey'>Credits（Qoder 等按 Credits 计费）：今日 ${s.todayCredits} · 本周 ${s.weekCredits}${s.creditsRankToday ? ` · Credits 榜第 ${s.creditsRankToday} 名` : ''}</font>`)] : []),
      divider(),
      rowOf(creditsOnly ? [
        statCell((s.todayCredits || 0).toFixed(2), '今日 Credits'),
        statCell((s.weekCredits || 0).toFixed(2), '本周 Credits'),
        statCell(s.days, '活跃天数'),
      ] : [
        statCell(integer(s.todayRequests), '今日调用'),
        statCell(formatTokens(s.week), '本周'),
        statCell(s.days, '活跃天数'),
      ]),
      divider(),
    ];
    if (s.topTool || s.topModel) {
      elements.push(markdown(`**本周偏好**　${[s.topTool, s.topModel].filter(Boolean).map(mdEscape).join(' / ')}`));
    }
    if (s.globalRankToday) elements.push(markdown(`**今日广场排名**　第 ${s.globalRankToday} 名`));
    if (s.lastReportAt && nowMs > s.lastReportAt) {
      elements.push(noteEl(`最近上报 ${Math.max(1, Math.round((nowMs - s.lastReportAt) / 60000))} 分钟前`));
    } else {
      elements.push(noteEl('数据由用户电脑上报，仅供参考'));
    }
    if (appUrl) elements.push(markdown(`[打开网页版完整界面（日报 / 日历 / 走势）](${appUrl})`));
    return cardBody(elements);
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
    const appUrl = `${origin}/app`;
    const reply = (cardBody) => sendCard(env, msg.chat_id, cardBody);
    if (!command) {
      if (!isGroup) await reply(helpCard({ appUrl }));
      return;
    }
    const account = ['rank', 'my', 'join', 'leave', 'hide', 'show'].includes(command.cmd)
      ? await accountByOpenId(env, openId) : null;

    if (command.cmd === 'help') return reply(helpCard({ groupReady: isGroup ? undefined : null, appUrl }));

    if (command.cmd === 'bind') {
      if (isGroup) {
        return reply(textCard('电脑接入', '接入码是私人凭证，不在群里发送。**请点我的头像进入单聊，发送「绑定」**。', appUrl));
      }
      const { user, token } = await bindAccount(env, openId);
      return reply(connectCard(origin, token));
    }

    if (command.cmd === 'my') {
      if (isGroup) return reply(textCard('我的用量', '个人用量只发单聊。**请单聊我发送「我的」**。', appUrl));
      if (!account) return reply(textCard('Token 群排名', '还没有你的账号。先发「**绑定**」接入电脑，再来查看用量。', appUrl));
      return reply(personalCard(account, await personalSummary(env, account.id, now()), now(), appUrl));
    }

    if (command.cmd === 'join') {
      if (!isGroup) return reply(textCard('加入群榜', '「加入」要在**群聊**里发：把我拉进群后，在群里发「加入」即可上榜。', appUrl));
      if (!account) return reply(textCard('Token 群排名', '先单聊我发「**绑定**」接入电脑，再回群里发「加入」上榜。', appUrl));
      const result = await joinGroup(env, account, msg.chat_id);
      const verb = result.created ? '已创建本群榜单，并把你加入榜单' : result.already ? '你已经在榜单里了' : '已把你加入本群榜单';
      return reply(textCard('加入群榜', `${verb}：**${mdEscape(result.group.name)}**。发「**榜单**」看看排名。`, appUrl));
    }

    if (['leave', 'hide', 'show'].includes(command.cmd)) {
      if (!isGroup) return reply(textCard('群设置', '「退出/隐藏/显示」要在**群聊**里发。', appUrl));
      if (!account) return reply(textCard('Token 群排名', '先单聊我发「**绑定**」接入电脑，再回来设置。', appUrl));
      const found = await groupByChatId(env, msg.chat_id);
      if (!found.id) return reply(textCard('群设置', '本群还没有榜单，先发「**加入**」创建。', appUrl));
      if (command.cmd === 'leave') {
        const res = await env.DB.prepare('DELETE FROM rank_group_members WHERE group_id = ?1 AND user_id = ?2')
          .bind(found.id, account.id).run();
        return reply(textCard('退出群榜', res.meta?.changes ? '已退出本群榜单，历史用量保留、不再出现在本群。' : '你本来就不在这张榜单里。', appUrl));
      }
      const hidden = command.cmd === 'hide' ? 1 : 0;
      const res = await env.DB.prepare('UPDATE rank_group_members SET hidden = ?1 WHERE group_id = ?2 AND user_id = ?3')
        .bind(hidden, found.id, account.id).run();
      if (!res.meta?.changes) return reply(textCard('群设置', '你还没加入本群榜单，先发「**加入**」。', appUrl));
      return reply(textCard('群排名可见性', hidden ? '已在本群隐藏你的排名；其他群和广场不受影响。' : '已恢复在本群显示你的排名。', appUrl));
    }

    // rank
    const nowMs = now();
    const [from, to] = periodRange(command.period, nowMs);
    if (isGroup) {
      const found = await groupByChatId(env, msg.chat_id);
      if (!found.id) {
        return reply(textCard('本群还没有榜单', '先单聊我发「**绑定**」接入电脑，再回群里发「**加入**」创建本群榜单。', appUrl));
      }
      const [board, memberCount, mine] = await Promise.all([
        boardRows(env, { groupId: found.id, from, to }),
        env.DB.prepare('SELECT COUNT(*) AS c FROM rank_group_members WHERE group_id = ?1').bind(found.id).first(),
        account ? myGroupStanding(env, found.id, account.id, from, to) : Promise.resolve(null),
      ]);
      const footerBits = [];
      if (mine) footerBits.push(`你排第 **${mine.rank}** 名 · ${formatTokens(mine.tokens)} tokens`);
      if (account && !(await membership(env, found.id, account.id))) footerBits.push('你还未上榜，发「**加入**」加入');
      // 头像换 img_key（仅前 10 行；失败退化无头像列）
      const shown = board.entries.slice(0, BOARD_LIMIT);
      await Promise.all(shown.map(async (e) => { e.img_key = await ensureAvatarKey(env, e); }));
      const meEntry = mine && account ? board.entries.find((e) => e.uid === account.id) : null;
      const me = mine ? { rank: mine.rank, tokens: mine.tokens, nickname: account.nickname, top_model: meEntry?.top_model ?? null } : null;
      return reply(leaderboardCard({
        title: `${mdEscape(found.name)} · Token 排行榜`,
        entries: board.entries, members: memberCount?.c ?? null, updatedAt: board.updatedAt, nowMs,
        period: command.period, meUid: account?.id ?? null, me,
        footer: footerBits.join('\n') || null, appUrl,
      }));
    }
    const board = await boardRows(env, { from, to });
    const shownAll = board.entries.slice(0, BOARD_LIMIT);
    await Promise.all(shownAll.map(async (e) => { e.img_key = await ensureAvatarKey(env, e); }));
    const mine = account ? await globalStanding(env, account.id, from, to) : null;
    const meEntry = mine ? board.entries.find((e) => e.uid === account.id) : null;
    const me = mine ? { rank: mine.rank, tokens: mine.tokens, nickname: account.nickname, top_model: meEntry?.top_model ?? null } : null;
    return reply(leaderboardCard({
      title: `广场 · Token 排行榜`,
      entries: board.entries, members: board.entries.length, updatedAt: board.updatedAt, nowMs,
      period: command.period, meUid: account?.id ?? null, me, footer: null, appUrl: `${origin}/app`,
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
    // 先取原始报文：加密事件的签名覆盖原始 body，必须先验签再解析。
    let rawBody;
    let body;
    try {
      rawBody = await request.text();
      body = JSON.parse(rawBody);
    } catch { return respond(); }

    // 启用加密策略时，飞书会带 X-Lark-Signature；未通过验签的请求一律不处理。
    if (env.FEISHU_ENCRYPT_KEY) {
      const timestamp = request.headers.get('x-lark-request-timestamp') || '';
      const nonce = request.headers.get('x-lark-request-nonce') || '';
      const signature = request.headers.get('x-lark-signature') || '';
      if (!timestamp || !nonce || !signature) return respond();
      const seconds = Number(timestamp);
      if (!Number.isFinite(seconds) || Math.abs(now() / 1000 - seconds) > EVENT_MAX_AGE_MS / 1000) return respond();
      const expected = await feishuSignature(timestamp, nonce, env.FEISHU_ENCRYPT_KEY, rawBody);
      if (!constantTimeEqual(signature.toLowerCase(), expected)) return respond();
    }

    // 未启用加密时，必须配置并校验 Verification Token；两者都没有时拒绝所有事件（fail closed）。
    if (!env.FEISHU_ENCRYPT_KEY && !env.FEISHU_VERIFICATION_TOKEN) return respond();

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
    if (env.FEISHU_VERIFICATION_TOKEN && !constantTimeEqual(String(header.token || ''), env.FEISHU_VERIFICATION_TOKEN)) return respond();
    if (header.app_id && header.app_id !== env.FEISHU_APP_ID) return respond();
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

  return { handle, _internals: { dispatch, boardRows, personalSummary, bindAccount, joinGroup, ensureAvatarKey } };
}

export const feishu = createFeishuService();
