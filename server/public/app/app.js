/* Token 群排名 · 飞书网页应用（复刻小程序界面与交互） */
(() => {
  'use strict';
  const $ = (sel) => document.querySelector(sel);
  const page = $('#page');
  const state = { tab: 'groups', period: 'day', scope: 'all', token: localStorage.getItem('tr_token') || '', me: null };

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
      const d = await api(`/api/leaderboard?scope=global&period=${state.period}`);
      const rows = d.entries.map((e) => `
        <div class="row ${state.me && e.rank === d.me?.rank && e.nickname === d.me?.nickname ? 'me' : ''}">
          <div class="rank num">${e.rank}</div>
          ${avatar(e.avatar_url, e.nickname)}
          <div class="who"><div class="nick">${esc(e.nickname)}</div>${e.top_model ? `<div class="sub">${esc(e.top_model)}</div>` : ''}</div>
          <div class="amt num">${fmt(e.tokens)}</div>
        </div>`).join('');
      body.innerHTML = `
        <div class="list-header"><span>全站排名 · ${d.total} 人</span><span>Token 用量</span></div>
        ${rows || '<div class="empty">这个时间段还没有人上报用量</div>'}
        ${d.me ? `<div class="row me">
            <div class="rank num">${d.me.rank}</div>
            ${avatar(state.me?.avatar_url, state.me?.nickname)}
            <div class="who"><div class="nick">${esc(state.me?.nickname || '')} 我</div>
              <div class="sub">我的全站排名${d.me.top_model ? ' · ' + esc(d.me.top_model) : ''}</div></div>
            <div class="amt num">${fmt(d.me.tokens)}</div>
          </div>` : ''}
        <div class="footnote">数据由用户电脑上报，仅供参考</div>`;
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
      body.innerHTML = `
        <div class="section"><span class="t">${label}</span><span class="more">完整分析</span></div>
        <div class="caption">${sum.users || 0} 位公开用户 · ${details.length} 种${dimension === 'tools' ? '工具' : '模型'}</div>
        <div class="donut-wrap">
          <svg width="220" height="220" viewBox="0 0 220 220">${arcs}</svg>
          <div class="donut-center"><div class="v num">${fmt(sum.tokens || 0)}</div><div class="k">Tokens</div></div>
        </div>
        ${details.slice(0, 10).map((x) => `
          <div class="dist">
            <div class="head"><span class="name">${esc(x.name)}</span><span class="pct num">${(x.percent || 0).toFixed(1)}%</span></div>
            <div class="bar"><i style="width:${Math.min(100, x.percent || 0)}%"></i></div>
            <div class="meta"><span>${fmt(x.tokens)} tokens</span><span>${x.preferred_users || 0} 人常用 · ${x.users || 0} 人用过</span></div>
          </div>`).join('')}
        <div class="footnote">仅代表已上报数据 · 数据由用户电脑上报，仅供参考</div>`;
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
    const when = usage.last_report_at ? `${bj(usage.last_report_at).slice(5, 16).replace('T', ' ')} 同步` : '暂未同步';
    body.innerHTML = `
      <div class="section"><span class="t">我的用量</span><span class="more">详情</span></div>
      <div class="hero">
        <div class="num-line">
          <span class="big num">${esc(heroUnit.length > 1 ? heroUnit.slice(0, -1).join(' ') : heroUnit[0])}</span>
          ${heroUnit.length > 1 ? `<span class="unit">${esc(heroUnit.at(-1))}</span>` : ''}
          <span class="tail">tokens</span>
        </div>
        <div class="full num">今日 · ${full(usage.summary.requests)} 次调用</div>
      </div>
      <div class="stats">
        <div><div class="v num">${fmt(usage.lifetime_tokens)}</div><div class="k">累计 tokens</div></div>
        <div><div class="v num">${usage.activity?.active_days ?? 0} 天</div><div class="k">活跃天数</div></div>
        <div><div class="v num">${usage.activity?.current_streak ?? 0} 天</div><div class="k">连续记录</div></div>
      </div>
      <div class="list-header"><span>已加入群榜</span><span>${rankings.groups.length} 个</span></div>
      ${rankings.groups.map((g) => `
        <div class="group-row">
          <div class="l1"><span class="name">${esc(g.name)}</span><span class="when">${g.updated_at ? Math.max(1, Math.round((Date.now() - g.updated_at) / 60000)) + ' 分钟前' : '暂未更新'}</span></div>
          <div class="l2">
            <span class="rank">群内 <span class="num">${g.my_rank ?? '—'}</span>　${fmt(g.my_tokens)} tokens</span>
            <span class="members">${g.members} 人已加入</span>
          </div>
        </div>`).join('') || '<div class="empty">还没有加入群榜：把机器人拉进飞书群，在群里发「加入」</div>'}
      <div class="footnote">数据由用户电脑上报，仅供参考</div>`;
  }

  // ── 页面：我的 ──
  async function renderMe() {
    page.innerHTML = `
      <div class="pagebar">我的用量</div>
      ${tabsRow([...periods, ['all', '累计']], state.mePeriod || 'all')}
      <div id="body"></div>`;
    const period = state.mePeriod || 'all';
    const d = await api(`/api/my/usage?period=${period}`);
    const labels = { day: '今日', week: '近7天', month: '近30天', all: '累计' };
    const heroUnit = fmt(d.summary.tokens).split(' ');
    const activeDays = d.activity?.active_days ?? 0;
    const cost = d.summary.cost && d.summary.cost.usd_micros != null ? `$${(d.summary.cost.usd_micros / 1e6).toFixed(4)}USD` : null;
    $('#body').innerHTML = `
      <div class="hero">
        <div class="label">${labels[period]} · 总用量 · 含缓存</div>
        <div class="num-line">
          <span class="big num">${esc(heroUnit.length > 1 ? heroUnit.slice(0, -1).join(' ') : heroUnit[0])}</span>
          ${heroUnit.length > 1 ? `<span class="unit">${esc(heroUnit.at(-1))}</span>` : ''}
        </div>
        <div class="full num">${full(d.summary.tokens)} tokens</div>
        <div class="full">${d.from === '0000-01-01' ? (d.first_day || '') : d.from} — ${d.to} · 北京时间${d.last_report_at ? ' · 同步于 ' + bj(d.last_report_at).slice(5, 16).replace('T', ' ') : ''}</div>
        ${cost ? `<div class="full">API 等值估算${cost} · 仅供参考，不等同账单</div>` : ''}
      </div>
      <a class="btn" href="#" onclick="return false">转发我的用量</a>
      <a class="btn ghost" href="#" onclick="return false">分享图片</a>
      <div class="stats">
        <div><div class="v num">${full(d.summary.requests)}</div><div class="k">调用次数</div></div>
        <div><div class="v num">${activeDays} 天</div><div class="k">活跃天数</div></div>
      </div>
      <div class="links">
        <a href="#" data-go="square">广场排名</a>
        <a href="#" data-go="groups">我的群榜</a>
      </div>
      <div class="footnote">${d.has_history ? `已上报 ${d.reported_days || 0} 天 · 自 ${d.first_day || '—'}` : '暂无同步记录：单聊机器人发「绑定」接入电脑'}</div>`;
    page.querySelectorAll('[data-go]').forEach((a) => a.addEventListener('click', (e) => { e.preventDefault(); switchTab(a.dataset.go); }));
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
