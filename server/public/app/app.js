/* Token 群排名 · 飞书网页应用（复刻小程序界面与交互） */
(() => {
  'use strict';
  const $ = (sel) => document.querySelector(sel);
  const page = $('#page');
  const state = { tab: 'groups', period: 'day', scope: 'all', token: localStorage.getItem('tr_token') || '', me: null, meView: 'sum' };

  // ── 工具 ──
  const fmt = (n) => {
    n = Math.max(0, Math.round(Number(n) || 0));
    if (n >= 1e8) return (n / 1e8).toFixed(2) + ' 亿';
    if (n >= 1e4) return (n / 1e4).toFixed(2).replace(/\.?0+$/, '') + ' 万';
    return n.toLocaleString('en-US');
  };
  const full = (n) => (Math.max(0, Math.round(Number(n) || 0))).toLocaleString('en-US');
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const bj = (ms) => new Date(ms + 8 * 3600000).toISOString();
  const bjDay = (ms = Date.now()) => bj(ms).slice(0, 10);
  async function api(path, { silent } = {}) {
    const res = await fetch(path, state.token ? { headers: { authorization: `Bearer ${state.token}` } } : undefined);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      if (res.status === 401) { logout('登录已过期，请重新登录'); throw new Error('unauthorized'); }
      if (!silent) toast(data.error || '加载失败');
      throw new Error(data.error || '加载失败');
    }
    return data;
  }
  let toastTimer;
  function toast(msg) {
    const el = $('#toast'); el.textContent = msg; el.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => { el.hidden = true; }, 2200);
  }
  function logout(msg) {
    localStorage.removeItem('tr_token'); state.token = ''; state.me = null;
    if (msg) toast(msg);
    login();
  }

  // ── 登录 ──
  async function login() {
    const qs = new URLSearchParams(location.search);
    const code = qs.get('code');
    const cfg = await fetch('/api/feishu/session').then((r) => r.json()).catch(() => ({}));
    if (!cfg.app_id) return renderLoginMask('登录服务未配置', '请联系管理员在服务端配置飞书凭证');
    if (code) {
      try {
        const res = await fetch('/api/feishu/session', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ code }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || '登录失败');
        state.token = data.token; state.me = data.user;
        localStorage.setItem('tr_token', data.token);
        history.replaceState(null, '', '/app/');
        return boot();
      } catch (err) { return renderLoginMask('登录失败', err.message + '，请重试'); }
    }
    if (!state.token) {
      const state_ = Math.random().toString(36).slice(2);
      sessionStorage.setItem('tr_oauth_state', state_);
      location.href = cfg.authorize_url + '&state=' + state_;
      return;
    }
    try { state.me = await api('/api/me'); boot(); }
    catch { /* logout 已处理 */ }
  }
  function renderLoginMask(t, s) {
    document.body.insertAdjacentHTML('beforeend',
      `<div class="login-mask"><div class="t">${esc(t)}</div><div class="s">${esc(s || '正在打开飞书授权…')}</div></div>`);
  }

  // ── 通用片段 ──
  const periods = [['day', '今日'], ['week', '近7天'], ['month', '近30天']];
  const periodLabels = { day: '今日', week: '近7天', month: '近30天', all: '累计' };
  const avatar = (url, nick) => url
    ? `<img class="avatar" src="${esc(url)}" referrerpolicy="no-referrer" alt="">`
    : `<div class="avatar-ph">${esc((nick || '?').slice(0, 1))}</div>`;
  function tabsRow(items, active, attr = 'data-p') {
    return `<div class="tabs">${items.map(([key, label]) =>
      `<button class="tab ${key === active ? 'active' : ''}" ${attr}="${key}">${esc(label)}</button>`).join('')}</div>`;
  }
  function bindTabRow(row, attr, fn) {
    row.querySelectorAll('.tab').forEach((b) => b.addEventListener('click', () => fn(b.getAttribute(attr))));
  }
  // 北京时间日期工具（与服务端口径一致：day 均为 YYYY-MM-DD）
  const dayShift = (day, n) => new Date(Date.parse(day + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);
  const mondayOf = (day) => dayShift(day, -((new Date(day + 'T00:00:00Z').getUTCDay() + 6) % 7));
  const heroNum = (n) => {
    const parts = fmt(n).split(' ');
    return { big: parts.length > 1 ? parts.slice(0, -1).join(' ') : parts[0], unit: parts.length > 1 ? parts.at(-1) : '' };
  };
  // credits 与 tokens 用同一套大数字样式：数字放大 + 橙色，单位收尾。
  const creditNum = (n) => {
    n = Math.max(0, Number(n) || 0);
    if (n >= 1e8) return { big: (n / 1e8).toFixed(2), unit: '亿' };
    if (n >= 1e4) return { big: (n / 1e4).toFixed(2).replace(/\.?0+$/, ''), unit: '万' };
    return { big: (Math.round(n * 100) / 100).toLocaleString('en-US', { maximumFractionDigits: 2 }), unit: '' };
  };
  const creditsTotal = (c) => (c && c.status !== 'unavailable' && Number(c.total) > 0 ? Number(c.total) : null);
  const creditsText = (total) => { const c = creditNum(total); return c.big + (c.unit ? ' ' + c.unit : ''); };
  const heroLine = (big, unit, tail) =>
    `<div class="num-line"><span class="big num">${esc(big)}</span>${unit ? `<span class="unit">${esc(unit)}</span>` : ''}<span class="tail">${esc(tail)}</span></div>`;
  const creditsHero = (total) => (total == null ? '' : (() => { const c = creditNum(total); return heroLine(c.big, c.unit, 'Credits'); })());
  /** credits 区块：大数字与 tokens 完全同款，下面补一行计费工具说明。 */
  const creditsBlock = (c) => {
    const total = creditsTotal(c);
    if (total == null) return '';
    const tools = (c.tools || []).map((t) => t[0]).slice(0, 2).join('、');
    return creditsHero(total) + (tools ? `<div class="credit-note">Credits 计费工具：${esc(tools)}</div>` : '');
  };
  const statsCredits = (total) => (total == null ? '' :
    `<div><div class="v num">${esc(creditsText(total))}</div><div class="k">累计 Credits</div></div>`);
  const inlineCredits = (total) => (total == null ? '' :
    `<span class="credits"> · ${esc(creditsText(total))} Credits</span>`);
  const distBlock = (title, items, limit = 4) => {
    const rows = (items || []).filter((x) => !x.unclassified).slice(0, limit);
    if (!rows.length) return '';
    return `<div class="section"><span class="t">${esc(title)}</span></div>` + rows.map((x) => `
      <div class="dist">
        <div class="head"><span class="name">${esc(x.name)}</span><span class="pct num">${(x.percent || 0).toFixed(1)}%</span></div>
        <div class="bar"><i style="width:${Math.min(100, x.percent || 0)}%"></i></div>
        <div class="meta"><span>${fmt(x.tokens)} tokens</span></div>
      </div>`).join('');
  };

  // ── 页面：广场（总榜/工具/模型） ──
  async function renderSquare() {
    page.innerHTML = `
      <div class="pagebar">广场排名</div>
      ${tabsRow(periods, state.period)}
      ${tabsRow([['all', '总榜'], ['tools', '工具'], ['models', '模型']], state.scope, 'data-s')}
      <div id="body"></div>`;
    const tabRows = page.querySelectorAll('.tabs');
    bindTabRow(tabRows[0], 'data-p', (p) => { state.period = p; renderSquare(); });
    bindTabRow(tabRows[1], 'data-s', (s) => { state.scope = s; renderSquare(); });
    const body = $('#body');
    if (state.scope === 'all') {
      state.metric = state.metric || 'tokens';
      const metricTabs = tabsRow([['tokens', 'Token 榜'], ['credits', 'Credits 榜']], state.metric, 'data-m');
      body.innerHTML = `${metricTabs}<div id="board"></div>`;
      bindTabRow($('#board').previousElementSibling, 'data-m', (m) => { state.metric = m; renderSquare(); });
      const d = await api(`/api/leaderboard?scope=global&period=${state.period}&metric=${state.metric}`);
      const creditsView = state.metric === 'credits';
      const amt = (e) => creditsView ? creditsText(e.credits) : fmt(e.tokens);
      // 另一维度补角：Token 榜带 Credits，Credits 榜带 tokens，同一行读齐两个口径
      const alt = (e) => creditsView
        ? (Number(e.tokens) > 0 ? `<div class="sub alt">${fmt(e.tokens)} tokens</div>` : '')
        : (Number(e.credits) > 0 ? `<div class="sub alt">${esc(creditsText(e.credits))} Credits</div>` : '');
      const rows = d.entries.map((e) => `
        <div class="row ${state.me && e.rank === d.me?.rank && e.nickname === d.me?.nickname ? 'me' : ''}">
          <div class="rank num">${e.rank}</div>
          ${avatar(e.avatar_url, e.nickname)}
          <div class="who"><div class="nick">${esc(e.nickname)}</div>${e.top_model ? `<div class="sub">${esc(e.top_model)}</div>` : ''}${alt(e)}</div>
          <div class="amt num">${amt(e)}</div>
        </div>`).join('');
      $('#board').innerHTML = `
        <div class="list-header"><span>全站排名 · ${d.total} 人</span><span>${creditsView ? 'Credits 用量（Qoder 等）' : 'Token 用量'}</span></div>
        ${rows || '<div class="empty">这个时间段还没有人上报用量</div>'}
        ${d.me ? `<div class="row me">
            <div class="rank num">${d.me.rank}</div>
            ${avatar(state.me?.avatar_url, state.me?.nickname)}
            <div class="who"><div class="nick">${esc(state.me?.nickname || '')} 我</div>
              <div class="sub">我的全站排名${d.me.top_model ? ' · ' + esc(d.me.top_model) : ''}</div>${alt(d.me)}</div>
            <div class="amt num">${creditsView ? amt(d.me) : fmt(d.me.tokens)}</div>
          </div>` : ''}
        <div class="footnote">${creditsView ? 'Credits 为 Qoder 等按 Credits 计费工具的自报数字' : '数据由用户电脑上报，仅供参考'}</div>`;
    } else {
      const dimension = state.scope;
      const d = await api(`/api/insights?period=${state.period}&dimension=${dimension}`);
      const label = dimension === 'tools' ? '工具使用分布' : '模型使用分布';
      const sum = d.summary || {};
      const details = (d.items || []).filter((x) => !x.unclassified);
      const colors = ['#fa8919', '#7a9e7e', '#8e9aaf', '#c9b27c', '#b5651d', '#c8c8c8', '#9e7bb5', '#5b8c5a'];
      const R = 70, C = 2 * Math.PI * R;
      let offset = 0;
      const arcs = details.slice(0, 8).map((x, i) => {
        const len = (x.percent || 0) / 100 * C;
        const arc = `<circle r="${R}" cx="110" cy="110" fill="none" stroke="${colors[i % colors.length]}" stroke-width="26"
          stroke-dasharray="${len} ${C - len}" stroke-dashoffset="${-offset}" transform="rotate(-90 110 110)"></circle>`;
        offset += len;
        return arc;
      }).join('');
      const creditsByTool = d.credits && d.credits.scope === 'tools';
      const rowCredits = (x) => (creditsByTool && Number(x.credits) > 0 ? ` · ${esc(creditsText(x.credits))} Credits` : '');
      body.innerHTML = `
        <div class="section"><span class="t">${label}</span><span class="more">完整分析</span></div>
        <div class="caption">${sum.users || 0} 位公开用户 · ${details.length} 种${dimension === 'tools' ? '工具' : '模型'}${creditsByTool && sum.credits > 0 ? ` · ${esc(creditsText(sum.credits))} Credits` : ''}</div>
        <div class="donut-wrap">
          <svg width="220" height="220" viewBox="0 0 220 220">${arcs}</svg>
          <div class="donut-center"><div class="v num">${fmt(sum.tokens || 0)}</div><div class="k">Tokens</div></div>
        </div>
        ${details.slice(0, 10).map((x) => `
          <div class="dist">
            <div class="head"><span class="name">${esc(x.name)}</span><span class="pct num">${(x.percent || 0).toFixed(1)}%</span></div>
            <div class="bar"><i style="width:${Math.min(100, x.percent || 0)}%"></i></div>
            <div class="meta"><span>${fmt(x.tokens)} tokens${rowCredits(x)}</span><span>${x.preferred_users || 0} 人常用 · ${x.users || 0} 人用过</span></div>
          </div>`).join('')}
        <div class="footnote">${creditsByTool ? 'Credits 按工具归属，由电脑上报的积分明细汇总' : 'Credits 只按工具上报，模型维度没有积分明细'} · 仅代表已上报数据 · 数据由用户电脑上报，仅供参考</div>`;
    }
  }

  // ── 页面：群榜 ──
  async function renderGroups() {
    page.innerHTML = `
      <div class="pagebar">我的群榜</div>
      <div class="list-header"><span>每个群一张榜</span><a href="#" data-go="help" style="color:var(--green);font-size:13px;text-decoration:none">使用说明</a></div>
      ${tabsRow(periods, state.period)}
      <div id="body"></div>`;
    bindTabRow(page.querySelector('.tabs'), 'data-p', (p) => { state.period = p; renderGroups(); });
    page.querySelector('[data-go="help"]').addEventListener('click', (e) => { e.preventDefault(); switchTab('help'); });
    const body = $('#body');
    const usage = await api(`/api/my/usage?period=${state.period}`);
    const rankings = await api(`/api/my/rankings?period=${state.period}`).catch(() => ({ groups: [] }));
    const heroUnit = fmt(usage.summary.tokens).split(' ');
    const statCells = [
      `<div><div class="v num">${fmt(usage.lifetime_tokens)}</div><div class="k">累计 tokens</div></div>`,
      statsCredits(Number(usage.lifetime_credits) > 0 ? Number(usage.lifetime_credits) : null),
      `<div><div class="v num">${usage.activity?.active_days ?? 0} 天</div><div class="k">活跃天数</div></div>`,
      `<div><div class="v num">${usage.activity?.current_streak ?? 0} 天</div><div class="k">连续记录</div></div>`,
    ].filter(Boolean);
    body.innerHTML = `
      <div class="section"><span class="t">我的用量</span><span class="more">详情</span></div>
      <div class="hero">
        ${heroLine(heroUnit.length > 1 ? heroUnit.slice(0, -1).join(' ') : heroUnit[0], heroUnit.length > 1 ? heroUnit.at(-1) : '', 'tokens')}
        <div class="full num">${periodLabels[state.period]} · ${full(usage.summary.requests)} 次调用</div>
        ${creditsBlock(usage.credits)}
      </div>
      <div class="stats${statCells.length > 3 ? ' dense' : ''}">
        ${statCells.join('')}
      </div>
      <div class="list-header"><span>已加入群榜</span><span>${rankings.groups.length} 个</span></div>
      ${rankings.groups.map((g) => `
        <div class="group-row">
          <div class="l1"><span class="name">${esc(g.name)}</span><span class="when">${g.updated_at ? Math.max(1, Math.round((Date.now() - g.updated_at) / 60000)) + ' 分钟前' : '暂未更新'}</span></div>
          <div class="l2">
            <span class="rank">群内 <span class="num">${g.my_rank ?? '—'}</span></span>
            <span class="members">${g.members} 人已加入</span>
          </div>
          <div class="l3">${fmt(g.my_tokens)} tokens${inlineCredits(g.my_credits > 0 ? g.my_credits : null)}</div>
        </div>`).join('') || '<div class="empty">还没有加入群榜：把机器人拉进飞书群，在群里发「加入」</div>'}
      <div class="footnote">数据由用户电脑上报，仅供参考</div>`;
  }

  // ── 页面：我的（汇总 / 日报 / 日历 / 走势） ──
  const meViews = [['sum', '汇总'], ['daily', '日报'], ['cal', '日历'], ['trend', '走势']];
  async function renderMe() {
    const view = state.meView || 'sum';
    page.innerHTML = `
      <div class="pagebar">我的用量</div>
      ${tabsRow(meViews, view, 'data-mv')}
      ${view === 'sum' ? tabsRow([...periods, ['all', '累计']], state.mePeriod || 'all', 'data-p') : ''}
      <div id="body"></div>`;
    bindTabRow(page.querySelector('.tabs'), 'data-mv', (v) => { state.meView = v; renderMe(); });
    if (view === 'sum') bindTabRow(page.querySelectorAll('.tabs')[1], 'data-p', (p) => { state.mePeriod = p; renderMe(); });
    const body = $('#body');
    if (view === 'daily') return renderMeDaily(body);
    if (view === 'cal') return renderMeCalendar(body);
    if (view === 'trend') return renderMeTrend(body);
    return renderMeSum(body);
  }

  async function renderMeSum(body) {
    const period = state.mePeriod || 'all';
    const d = await api(`/api/my/usage?period=${period}`);
    const hero = heroNum(d.summary.tokens);
    const activeDays = d.activity?.active_days ?? 0;
    const cost = d.cost && d.cost.usd_micros != null ? `$${(d.cost.usd_micros / 1e6).toFixed(4)}USD` : null;
    body.innerHTML = `
      <div class="hero">
        <div class="label">${periodLabels[period]} · 总用量 · 含缓存</div>
        ${heroLine(hero.big, hero.unit, 'tokens')}
        <div class="full num">${full(d.summary.tokens)} tokens</div>
        ${creditsBlock(d.credits)}
        <div class="full">${d.from === '0000-01-01' ? (d.first_day || '') : d.from} — ${d.to} · 北京时间${d.last_report_at ? ' · 同步于 ' + bj(d.last_report_at).slice(5, 16).replace('T', ' ') : ''}</div>
        ${cost ? `<div class="full">API 等值估算${cost} · 仅供参考，不等同账单</div>` : ''}
      </div>
      <a class="btn" href="#" onclick="return false">转发我的用量</a>
      <a class="btn ghost" href="#" onclick="return false">分享图片</a>
      <div class="stats">
        <div><div class="v num">${full(d.summary.requests)}</div><div class="k">调用次数</div></div>
        <div><div class="v num">${activeDays} 天</div><div class="k">活跃天数</div></div>
        ${creditsTotal(d.credits) != null ? `<div><div class="v num">${esc(creditsText(d.credits.total))}</div><div class="k">本期 Credits</div></div>` : ''}
      </div>
      <div class="links">
        <a href="#" data-go="square">广场排名</a>
        <a href="#" data-go="groups">我的群榜</a>
      </div>
      <div class="footnote">${d.has_history ? `已上报 ${d.reported_days || 0} 天 · 自 ${d.first_day || '—'}` : '暂无同步记录：单聊机器人发「绑定」接入电脑'}</div>`;
    body.querySelectorAll('[data-go]').forEach((a) => a.addEventListener('click', (e) => { e.preventDefault(); switchTab(a.dataset.go); }));
  }

  // 日报：默认昨天，前后切换 + 日期直选
  async function renderMeDaily(body) {
    state.dailyDay = state.dailyDay || dayShift(bjDay(), -1);
    const day = state.dailyDay;
    const d = await api(`/api/my/daily?day=${day}`);
    const nav = `
      <div class="nav-row">
        <button class="nav-btn" id="d-prev" ${d.previous_day ? '' : 'disabled'}>‹ 前一天</button>
        <span class="nav-title">${day}${day === dayShift(bjDay(), -1) ? '（昨天）' : ''}</span>
        <button class="nav-btn" id="d-next" ${d.next_day ? '' : 'disabled'}>后一天 ›</button>
      </div>
      <div class="caption" style="text-align:center;padding-top:0">跳到 <input type="date" id="d-pick" class="date-pick" value="${day}" max="${dayShift(bjDay(), -1)}"></div>`;
    if (!d.has_history) {
      body.innerHTML = `${nav}
        <div class="hero"><div class="label">${day} · 无上报记录</div>
          <div class="full">这一天电脑没有同步数据（未开机或同步器未运行）</div></div>
        <div class="footnote">日报只展示已经结束的自然日 · 北京时间</div>`;
    } else {
      const s = d.summary, hero = heroNum(s.tokens);
      const cost = d.cost && d.cost.usd_micros != null ? '$' + (d.cost.usd_micros / 1e6).toFixed(2) : null;
      body.innerHTML = `${nav}
        <div class="hero">
          <div class="label">${day} · 总用量 · 含缓存</div>
          <div class="num-line"><span class="big num">${esc(hero.big)}</span>${hero.unit ? `<span class="unit">${esc(hero.unit)}</span>` : ''}<span class="tail">tokens</span></div>
          <div class="full num">${full(s.tokens)} tokens</div>
          ${creditsBlock(d.credits)}
          ${cost ? `<div class="full">API 等值估算${cost}USD · 仅供参考，不等同账单</div>` : ''}
        </div>
        <div class="stats">
          <div><div class="v num">${full(s.requests)}</div><div class="k">调用次数</div></div>
          <div><div class="v num">${fmt(s.input_tokens)}</div><div class="k">输入</div></div>
          <div><div class="v num">${fmt(s.output_tokens)}</div><div class="k">输出</div></div>
        </div>
        <div class="stats">
          <div><div class="v num">${fmt(s.cache_read)}</div><div class="k">缓存读</div></div>
          <div><div class="v num">${fmt(s.cache_write)}</div><div class="k">缓存写</div></div>
          <div><div class="v" style="font-size:15px">${esc(d.top_tool ? d.top_tool.name : '—')}</div><div class="k">常用工具</div></div>
        </div>
        ${distBlock('工具分布', d.tools)}
        ${distBlock('模型分布', d.models)}
        <div class="footnote">首次上报 ${d.first_day || '—'} · 点击日历页的有记录日期也可到达这里</div>`;
    }
    if (d.previous_day) $('#d-prev').addEventListener('click', () => { state.dailyDay = d.previous_day; renderMeDaily(body); });
    if (d.next_day) $('#d-next').addEventListener('click', () => { state.dailyDay = d.next_day; renderMeDaily(body); });
    const pick = $('#d-pick');
    pick.addEventListener('change', () => {
      const v = pick.value;
      if (v && v < bjDay()) { state.dailyDay = v; renderMeDaily(body); }
    });
  }

  // 日历：整月格子，有记录的日期可点进日报
  async function renderMeCalendar(body) {
    state.calMonth = state.calMonth || bjDay().slice(0, 7);
    const d = await api(`/api/my/calendar?month=${state.calMonth}`);
    const firstDow = (new Date(d.month + '-01T00:00:00Z').getUTCDay() + 6) % 7;
    const cells = [];
    for (let i = 0; i < firstDow; i++) cells.push('<div class="cal-cell pad"></div>');
    for (const day of d.daily) {
      const cls = ['cal-cell', day.future ? 'future' : '', day.reported ? (day.tokens > 0 ? 'has' : 'zero') : '', day.day === d.today ? 'today' : ''].join(' ');
      const clickable = day.reported && !day.future && day.day < d.today;
      cells.push(`<div class="${cls}"${clickable ? ` data-day="${day.day}" style="cursor:pointer"` : ''}>
        <span class="d">${Number(day.day.slice(-2))}</span>
        ${day.reported && day.tokens > 0 ? `<span class="t num">${fmt(day.tokens)}</span>` : ''}</div>`);
    }
    body.innerHTML = `
      <div class="nav-row">
        <button class="nav-btn" id="c-prev" ${d.previous_month ? '' : 'disabled'}>‹ 上月</button>
        <span class="nav-title">${d.month} · 使用日历</span>
        <button class="nav-btn" id="c-next" ${d.next_month ? '' : 'disabled'}>下月 ›</button>
      </div>
      <div class="caption" style="text-align:center">月用量 ${d.summary.tokens != null ? fmt(d.summary.tokens) + ' tokens' : '暂无'} · 记录 ${d.summary.reported_days || 0}/${d.summary.elapsed_days || 0} 天 · 活跃 ${d.summary.active_days || 0} 天</div>
      <div class="cal-grid">${['一', '二', '三', '四', '五', '六', '日'].map((w) => `<div class="cal-head">${w}</div>`).join('')}${cells.join('')}</div>
      <div class="footnote">绿底为有上报的日期，点击可看当日日报 · 北京时间</div>`;
    if (d.previous_month) $('#c-prev').addEventListener('click', () => { state.calMonth = d.previous_month; renderMeCalendar(body); });
    if (d.next_month) $('#c-next').addEventListener('click', () => { state.calMonth = d.next_month; renderMeCalendar(body); });
    body.querySelectorAll('[data-day]').forEach((el) => el.addEventListener('click', () => {
      state.dailyDay = el.dataset.day; state.meView = 'daily'; renderMe();
    }));
  }

  // 走势：按周 7 日柱状图 + 环比
  async function renderMeTrend(body) {
    state.weekStart = state.weekStart || dayShift(mondayOf(bjDay()), -7);
    const d = await api(`/api/my/weekly?week=${state.weekStart}`);
    const w = d.weekly;
    const max = Math.max(1, ...d.daily.map((x) => x.tokens || 0));
    const bars = d.daily.map((x) => `
      <div class="bar-col" title="${x.day}${x.reported ? ' · ' + full(x.tokens) + ' tokens' : ''}">
        <span class="v num">${x.reported && x.tokens ? fmt(x.tokens) : ''}</span>
        <div class="bar-fill" style="height:${x.future ? 0 : Math.max(2, Math.round((x.tokens || 0) / max * 100))}%"></div>
        <span class="k">${x.day.slice(8)}日</span>
      </div>`).join('');
    const change = w.comparison_status === 'comparable'
      ? `<span class="${w.change_tokens >= 0 ? 'change-up' : 'change-down'}">${w.change_tokens >= 0 ? '▲' : '▼'} ${Math.abs(w.change_percent)}%（上期 ${fmt(w.previous_tokens)}）</span>`
      : w.comparison_status === 'ongoing' ? '<span class="change-down">本周进行中</span>'
      : '<span class="change-down">上期数据不足，暂无可比</span>';
    const hero = heroNum(d.summary.tokens);
    const cost = d.cost && d.cost.usd_micros != null ? '$' + (d.cost.usd_micros / 1e6).toFixed(2) : null;
    body.innerHTML = `
      <div class="nav-row">
        <button class="nav-btn" id="w-prev" ${d.previous_week ? '' : 'disabled'}>‹ 上周</button>
        <span class="nav-title">${d.from} ~ ${d.to}${w.complete ? '' : '（进行中）'}</span>
        <button class="nav-btn" id="w-next" ${d.next_week ? '' : 'disabled'}>下周 ›</button>
      </div>
      <div class="hero">
        <div class="label">周走势 · 总用量 · 含缓存 · 较上期 ${change}</div>
        <div class="num-line"><span class="big num">${esc(hero.big)}</span>${hero.unit ? `<span class="unit">${esc(hero.unit)}</span>` : ''}<span class="tail">tokens</span></div>
        <div class="full num">${full(d.summary.tokens)} tokens · ${w.reported_days}/7 天有记录</div>
        ${creditsBlock(d.credits)}
      </div>
      <div class="bars">${bars}</div>
      <div class="stats">
        <div><div class="v num">${w.peak ? fmt(w.peak.tokens) : '—'}</div><div class="k">单日峰值${w.peak ? ' · ' + w.peak.day.slice(5).replace('-', '/') : ''}</div></div>
        <div><div class="v" style="font-size:15px">${esc(w.top_model ? w.top_model.name : '—')}</div><div class="k">常用模型</div></div>
        <div><div class="v num">${cost ?? '—'}</div><div class="k">成本估算</div></div>
      </div>
      <div class="footnote">柱高按本周单日最大用量归一 · 走势按北京时间自然日</div>`;
    if (d.previous_week) $('#w-prev').addEventListener('click', () => { state.weekStart = d.previous_week; renderMeTrend(body); });
    if (d.next_week) $('#w-next').addEventListener('click', () => { state.weekStart = d.next_week; renderMeTrend(body); });
  }

  // ── 页面：说明 ──
  async function renderHelp() {
    page.innerHTML = `<div class="pagebar">使用说明</div><div class="help" id="body">
      <p>接入、更新、统计口径和卸载</p>
      <h3>接入电脑</h3>
      <p>在电脑终端运行你的接入命令。</p>
      ${state.token ? '<a class="btn" href="#" id="getcmd">获取接入命令</a><div id="cmd"></div>' : '<p style="color:var(--text2)">登录后可获取专属接入命令；也可以在飞书单聊机器人发「绑定」。</p>'}
      <h3>群内命令</h3>
      <p><b>榜单 [今日|本周|本月|总榜]</b>　看本群排行<br><b>加入</b>　上榜本群<br><b>隐藏 / 显示 / 退出</b>　管理我的排名</p>
      <h3>单聊命令</h3>
      <p><b>绑定</b>　接入电脑　<b>我的</b>　个人用量　<b>榜单</b>　广场榜</p>
      <h3>统计口径</h3>
      <p>总用量含缓存，按北京时间自然日统计。这是各人电脑自报的数字，只能当交流参考，不等于厂商账单。不上传代码、对话内容、提示词、项目名和文件路径。</p>
    </div>`;
    const btn = $('#getcmd');
    if (btn) btn.addEventListener('click', async () => {
      try {
        const d = await api('/api/connect/token', { silent: false });
        $('#cmd').innerHTML = `<code class="cmd">${esc(d.install_command)}</code>`;
      } catch { /* toast 已提示 */ }
    });
  }

  // ── Tab 框架 ──
  const views = { groups: renderGroups, square: renderSquare, me: renderMe, help: renderHelp };
  async function render() {
    try { await views[state.tab](); }
    catch (err) { if (err.message !== 'unauthorized') page.insertAdjacentHTML('beforeend', `<div class="empty">加载失败：${esc(err.message)}</div>`); }
  }
  function switchTab(tab) {
    state.tab = tab;
    document.querySelectorAll('.tabbar button').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
    page.innerHTML = '<div class="empty">加载中…</div>';
    render();
  }
  document.querySelectorAll('.tabbar button').forEach((b) => b.addEventListener('click', () => switchTab(b.dataset.tab)));

  function boot() {
    const mask = document.querySelector('.login-mask');
    if (mask) mask.remove();
    render();
  }
  login();
})();
