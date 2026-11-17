/* Token 群排名 · 飞书网页应用；原生路由与账号隔离交互。 */
(() => {
  'use strict';
  const M = window.TokenRankModel, A = window.TokenRankAuth, page = document.querySelector('#page');
  const $ = selector => page.querySelector(selector);
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const full = value => Math.max(0, Number(value) || 0).toLocaleString('en-US', { maximumFractionDigits: 2 });
  const fmt = value => Number(value) >= 1e8 ? (value / 1e8).toFixed(2) + ' 亿' : Number(value) >= 1e4 ? (value / 1e4).toFixed(2).replace(/\.?0+$/, '') + ' 万' : full(value);
  let token = A.token(), route, current, user, ready = false, force = false;
  const guard = M.createGuard();
  async function request(path, options = {}) {
    if (!/^\/api\//.test(path)) throw new Error('不允许访问外部接口');
    const sentWith = token, method = options.method || 'GET';
    if (method !== 'GET') cache.clear();
    const headers = { ...(options.headers || {}), ...(sentWith ? { authorization: 'Bearer ' + sentWith } : {}) };
    const form = options.body instanceof FormData;
    if (options.body != null && !form) headers['content-type'] = 'application/json';
    // Bearer-only writes; never attach ambient cookies. JSON mutations cannot be forged by cross-site forms.
    const response = await fetch(A.path(path), { method, headers, credentials: 'omit', cache: 'no-store', body: options.body == null ? undefined : form ? options.body : JSON.stringify(options.body) });
    const data = await response.json();
    if (sentWith !== token) throw Object.assign(new Error('账号已变化'), { stale: true });
    if (!response.ok) {
      if (response.status === 401) {
        token = ''; A.clear(); cache.clear(); guard.invalidate(); ready = false;
        authorize().catch(error => loginMask('登录失败', error.message));
      }
      throw Object.assign(new Error(data.error || '加载失败，请稍后重试'), { status: response.status, code: data.code });
    }
    if (method !== 'GET') cache.clear();
    return data;
  }
  const write = (path, body = {}, method = 'POST') => request(path, { method, body });
  window.TokenRankShare?.configure({ request, baseUrl: A.appUrl, resolvePath: A.path });
  const cache = M.createCache({ request, account: () => token });
  const read = path => cache.read(path, { force });
  function go(next) {
    const hash = M.routeHash(next);
    if (location.hash !== hash) history.pushState({ trApp: true }, '', hash);
    render();
  }
  function patch(changes) { go({ ...route, ...changes }); }
  function link(next, label, cls = '') { return `<a class="${cls}" href="${esc(M.routeHash(next))}">${esc(label)}</a>`; }
  function tabs(items, active, key) {
    return `<div class="tabs">${items.map(([value, label]) => `<button class="tab ${value === active ? 'active' : ''}" data-set="${key}" data-value="${esc(value)}" aria-pressed="${value === active}">${esc(label)}</button>`).join('')}</div>`;
  }
  const periodTabs = () => tabs(route.name === 'me' ? [...M.periods, ['all', '累计']] : M.periods, route.period, 'period');
  const metricTabs = () => tabs([['tokens', 'Token 榜'], ['credits', 'Credits 榜']], route.metric, 'metric');
  const dimensions = () => tabs([['tools', '工具'], ['models', '模型']], route.dimension, 'dimension');
  const note = text => `<div class="footnote">${esc(text)}</div>`;
  const empty = text => `<div class="empty">${esc(text)}</div>`;
  function heading(title, back = false) {
    return `<header class="pagebar">${back ? '<button class="back" data-back>返回</button>' : ''}<h1>${esc(title)}</h1><button class="refresh" data-refresh>刷新</button></header>`;
  }
  function costBlock(cost) {
    const view = M.costView(cost);
    return `<div class="cost"><strong>${esc(view.label)} · ${esc(view.amount)}${view.available ? ' USD' : ''}</strong><div>${esc(view.note)}</div><div>仅供参考，不等同实际账单</div></div>`;
  }
  function creditsBlock(credits) {
    if (!credits || credits.status === 'unavailable' || !Number.isFinite(credits.total)) return '';
    return `<div class="num-line"><span class="big num">${fmt(credits.total)}</span><span class="tail">Credits${credits.status === 'partial' ? ' · 已记录部分' : ''}</span></div>`;
  }
  function hero(data, label) {
    const s = data.summary || {};
    if (data.has_history === false) return empty('本期没有同步记录，未同步不代表零用量') + costBlock(data.cost);
    return `<div class="hero"><div class="label">${esc(label)} · 总用量含缓存</div><div class="num-line"><span class="big num">${fmt(s.tokens)}</span><span class="tail">tokens</span></div><div class="full">${full(s.tokens)} tokens · ${full(s.requests)} 次调用</div>${creditsBlock(data.credits)}<div class="full">${esc(data.from || data.day || '')} — ${esc(data.to || data.day || '')} · 北京时间</div></div>${costBlock(data.cost)}`;
  }
  function stats(data) {
    if (data.has_history === false) return '';
    const s = data.summary || {};
    return `<div class="stats dense">${[['input_tokens', '输入'], ['output_tokens', '输出'], ['cache_read', '缓存读'], ['cache_write', '缓存写']].map(([key, label]) => `<div><div class="v num">${fmt(s[key])}</div><div class="k">${label}</div></div>`).join('')}</div>`;
  }
  function syncBlock(profile) {
    const health = profile?.sync_health;
    const statusLabels = { online: '同步器在线', checking: '正在检查', error: '同步异常，请检查电脑同步器', stopped: '同步器已停止', unreachable: '暂未联系到同步器', unknown: '暂无同步器状态' };
    const label = typeof health === 'string' ? health : health?.label || health?.message || statusLabels[health?.state] || health?.status;
    return `<div class="sync">同步状态：${esc(label || (profile?.last_report_at ? '已有上报记录' : '暂无同步记录'))}<div>${profile?.last_report_at ? '最近上报 ' + esc(new Date(profile.last_report_at + 8 * 3600000).toISOString().slice(0, 16).replace('T', ' ')) + ' · 北京时间' : '单聊飞书机器人发送「绑定」，接入电脑后开始记录'}</div></div>`;
  }
  const robotNote = () => note('仅统计已上报数据；分享会生成可撤销的公开快照，请勿分享接入凭证。');
  function shareControls(options) {
    if (!window.TokenRankShare) return note('分享模块未加载，刷新页面后再试');
    return `<button class="btn ghost" data-share="${esc(JSON.stringify(options))}">创建分享卡片</button><div class="share-result"></div>`;
  }
  const palette = ['var(--green)', 'var(--orange)', 'var(--chart-3)', 'var(--chart-4)', 'var(--chart-5)', 'var(--text2)'];
  function donuts(rows, people = false) {
    return '<div class="donut-row">' + (people ? [['tokens', '常用人数']] : [['tokens', 'Tokens'], ['credits', 'Credits']]).map(([key, label]) => {
      const total = rows.reduce((sum, row) => sum + Math.max(0, Number(row[key]) || 0), 0);
      if (!total) return `<div class="donut-cell"><div class="donut-empty">${key === 'credits' ? '该维度暂无积分明细' : label + ' 暂无已记录分项'}</div></div>`;
      let cursor = 0;
      const circles = rows.map((row, index) => { const pct = Math.max(0, Number(row[key]) || 0) / total * 100; const start = cursor; cursor += pct; return `<circle cx="60" cy="60" r="48" pathLength="100" fill="none" stroke="${palette[index % palette.length]}" stroke-width="14" stroke-dasharray="${pct} ${100 - pct}" stroke-dashoffset="${-start}" transform="rotate(-90 60 60)"><title>${esc(row.name)} ${pct.toFixed(1)}%</title></circle>`; }).join('');
      return `<div class="donut-cell"><div class="donut-wrap"><svg viewBox="0 0 120 120" width="190" height="190" role="img" aria-label="${label} 分布">${circles}</svg><div class="donut-center"><div class="v">${fmt(total)}</div><div class="k">${label}</div></div></div></div>`;
    }).join('') + '</div>';
  }
  function trendBars(daily) {
    const max = Math.max(1, ...daily.map(d => Number(d.tokens) || 0));
    return `<div class="bars analysis-bars" aria-label="每日用量">${daily.map(d => `<div class="bar-col" title="${esc(d.day)} · ${d.reported === false ? '未同步' : full(d.tokens) + ' tokens'}"><span class="v">${d.reported === false ? '—' : fmt(d.tokens)}</span><div class="bar-fill" style="height:${d.reported === false || d.future ? 0 : Math.max(1, (d.tokens || 0) / max * 100)}%"></div><span class="k">${esc(d.day?.slice(5))}</span></div>`).join('')}</div>`;
  }
  function analysisBlock(data) {
    if (!data) return empty('分析暂不可用，请刷新后重试');
    const mode = route.analysisView || 'share', basis = route.analysisBasis || 'tokens';
    const rows = (data.items || []).map(r => basis === 'users' ? { ...r, percent: r.preferred_percent || 0 } : r);
    const daily = (data.daily || []).map(d => { const parts = route.category ? (d.parts || []).filter(p => p.name === route.category) : d.parts; return { ...d, parts, ...(route.category ? { tokens: d.reported === false ? null : (parts || []).reduce((s, p) => s + (p.tokens || 0), 0) } : {}) }; });
    const max = Math.max(1, ...daily.map(d => d.tokens || 0));
    return tabs([['share', '占比'], ['trend', '趋势'], ['detail', '明细']], mode, 'analysisView') + tabs([['tokens', 'Token 用量'], ['users', '常用人数']], basis, 'analysisBasis') + (mode === 'share' ? donuts(basis === 'users' ? rows.map(r => ({ ...r, tokens: r.preferred_users })) : rows, basis === 'users') : '') + (mode !== 'share' && basis === 'users' ? note('常用人数仅有周期汇总；下方日趋势仍为真实 Token 用量，不推算每日常用人数。') : '') + `<label class="field">趋势分类<select data-analysis-category><option value="">全部分类</option>${rows.map(r => `<option value="${esc(r.name)}" ${route.category === r.name ? 'selected' : ''}>${esc(r.name)}</option>`).join('')}</select></label><div class="caption">${Number.isFinite(data.summary?.users) ? full(data.summary.users) + ' 位用户 · ' : ''}${data.from && data.to ? esc(data.from) + ' — ' + esc(data.to) + ' · ' : ''}仅代表已上报数据</div>
      ${daily.length && mode !== 'share' ? `<details class="trend-details" ${mode === 'detail' ? 'open' : ''}><summary>逐日占比与分项明细</summary>${daily.map(d => `<details><summary>${esc(d.day)} · ${d.reported ? fmt(d.tokens) + ' tokens' + (Number.isFinite(d.credits) ? ' · ' + full(d.credits) + ' Credits' : '') : '未同步'}</summary>${(d.parts || []).map(p => `<p>${esc(p.name)} · ${fmt(p.tokens)} tokens · ${d.tokens ? (p.tokens / d.tokens * 100).toFixed(1) : '0'}%${Number.isFinite(p.credits) ? ' · ' + full(p.credits) + ' Credits' : ''}</p>`).join('') || note('暂无分项记录')}</details>`).join('')}</details><div class="bars analysis-bars" aria-label="每日 Token 用量">${daily.map(d => `<div class="bar-col" title="${esc(d.day)} · ${d.reported ? full(d.tokens) + ' tokens' : '未同步'}"><span class="v">${d.reported ? fmt(d.tokens) : '—'}</span><div class="bar-fill" style="height:${d.reported ? Math.max(1, (d.tokens || 0) / max * 100) : 0}%"></div><span class="k">${esc(d.day?.slice(5))}</span></div>`).join('')}</div>` : ''}
      ${rows.map(row => `<div class="dist"><div class="head"><span class="name">${esc(row.name)}</span>${route.dimension === 'tools' && ['me', 'square'].includes(route.name) ? link({ ...route, view: 'analysis', dimension: 'models', tool: row.name }, '模型明细', 'more') : ''}${route.name === 'square' ? `<button class="more" data-audience="${esc(row.name)}">常用人数与用户</button>` : ''}<span class="pct num">${Number(row.percent || 0).toFixed(1)}%</span></div><div class="bar"><i style="width:${Math.max(0, Math.min(100, row.percent || 0))}%"></i></div><div class="meta"><span>${fmt(row.tokens)} tokens${Number(row.credits) > 0 ? ' · ' + full(row.credits) + ' Credits' : ''}</span><span>${Number.isFinite(row.users) ? full(row.users) + ' 人用过 · ' + full(row.preferred_users) + ' 人常用 · ' + full(row.preferred_percent) + '%' : ''}</span></div></div>`).join('') || empty('该周期暂无分项记录；接入电脑并同步后可查看工具与模型分布')}`;
  }
  let audienceVersion = 0;
  async function audience(button) {
    const routeAlive = current, version = ++audienceVersion, alive = () => routeAlive() && version === audienceVersion, context = { ...route }, name = button.dataset.audience;
    let box = $('#audience'); if (!box) { page.insertAdjacentHTML('beforeend', '<section id="audience" aria-live="polite"></section>'); box = $('#audience'); }
    let board = null;
    async function load() {
      const q = new URLSearchParams({ period: context.period, dimension: context.dimension, name, ...(context.tool ? { tool: context.tool } : {}), ...(board?.has_more ? { offset: board.next_offset, snapshot: board.snapshot } : {}) });
      const data = await read('/api/insights/users?' + q); if (!alive() || !box.isConnected) return;
      board = M.mergeBoard(board, data);
      box.innerHTML = `<h2>${esc(name)} · ${full(board.total)} 位常用用户</h2>` + board.entries.map(e => `<div class="row">${avatar(e)}<span>${esc(e.nickname)}</span><span>${fmt(e.tokens)} tokens · ${e.percent}%</span></div>`).join('') + (board.has_more ? '<button class="btn ghost" id="audience-more">加载更多用户</button>' : note('已显示全部常用用户'));
      if ($('#audience-more')) $('#audience-more').onclick = e => mutate(e.currentTarget, load, () => {});
    }
    return mutate(button, load, () => { box.scrollIntoView?.(); });
  }
  async function squareTrends(alive) {
    const context = { ...route }, period = route.period === 'day' ? 'week' : route.period;
    $('#body').innerHTML = dimensions() + tabs([['users', '常用人数'], ['tokens', 'Token 用量']], route.trendMetric, 'trendMetric') + `<label class="field">截至日期<input type="date" id="trend-end" max="${M.shiftDay(M.beijingDay(), -1)}" value="${esc(route.end || M.shiftDay(M.beijingDay(), -1))}"></label><div id="trend-list"></div>`;
    $('#trend-end').onchange = e => { if (M.validDay(e.target.value)) patch({ end: e.target.value }); };
    let board = null;
    async function load() {
      const q = new URLSearchParams({ period, dimension: context.dimension, metric: context.trendMetric, ...(context.end ? { end: context.end } : {}), ...(board?.has_more ? { offset: board.next_offset, snapshot: board.snapshot } : {}) });
      const data = await read('/api/insights/trends?' + q); if (!alive()) return;
      board = M.mergeBoard(board, data);
      $('#trend-list').innerHTML = note(`${data.from} — ${data.to} · 对比 ${data.previous_from} — ${data.previous_to}`) + board.entries.map(e => `<div class="group-row"><strong>${e.rank}. ${esc(e.name)}</strong><p>${full(e.users)} 位常用 · ${fmt(e.tokens)} tokens${Number.isFinite(e.credits) ? ' · ' + full(e.credits) + ' Credits' : ''}</p><p>排名变化 ${e.rank_change == null ? '新上榜' : e.rank_change > 0 ? '+' + e.rank_change : e.rank_change} · 上期 ${e.previous_users ?? '—'} 人 / ${e.previous_tokens == null ? '—' : fmt(e.previous_tokens)} tokens</p><button data-audience="${esc(e.name)}">查看常用用户</button></div>`).join('') + (board.has_more ? '<button class="btn ghost" id="trend-more">加载更多趋势</button>' : note('已显示全部趋势'));
      if ($('#trend-more')) $('#trend-more').onclick = e => mutate(e.currentTarget, load, () => {});
    }
    await load();
  }
  async function groups(alive) {
    page.innerHTML = heading('我的群榜') + periodTabs() + '<div id="body" aria-live="polite">' + empty('加载群榜…') + '</div>';
    const data = await read('/api/my/groups-overview?period=' + route.period);
    if (!alive()) return;
    user = data.user;
    $('#body').innerHTML = syncBlock(user) + `<div class="list-header"><span>已加入群榜</span><span>${data.rankings.groups.length} 个</span></div>` +
      data.rankings.groups.map(group => `<a class="group-row group-link" href="${esc(M.routeHash({ name: 'group', id: group.id, period: route.period }))}"><div class="l1"><span class="name">${esc(group.name)}</span><span class="when">查看群榜 ›</span></div><div class="l2"><span class="rank">群内 <span class="num">${group.my_rank ?? '—'}</span></span><span class="members">${full(group.members)} 人已加入</span></div><div class="l3">${fmt(group.my_tokens)} tokens${Number(group.my_credits) > 0 ? ' · ' + full(group.my_credits) + ' Credits' : ''}</div></a>`).join('') +
      (data.rankings.groups.length ? '' : empty('还没有加入群榜：把机器人拉进飞书群，在群里发送「加入」'));
  }
  function avatar(entry) {
    const url = entry.avatar_url;
    return url && /^(https?:\/\/|\/avatars\/)/.test(url) ? `<img class="avatar" src="${esc(url)}" referrerpolicy="no-referrer" alt="">` : `<span class="avatar-ph">${esc([...String(entry.nickname || '?')][0])}</span>`;
  }
  function boardHTML(board) {
    const credit = route.metric === 'credits';
    window.__trBoard = board;
    function row(entry, mine = false) {
      return `<div class="row ${mine ? 'me' : ''}"><span class="rank num">${esc(entry.rank)}</span>${avatar(entry)}<div class="who"><div class="nick">${esc(entry.nickname || (mine ? user?.nickname : '') || '未命名')}${mine ? ' · 我' : ''}</div><div class="sub">${esc([entry.top_tool, entry.top_model].filter(Boolean).join(' · ') || (!entry.tokens && !entry.credits ? '尚未上报' : '已记录用量'))}</div><div class="sub alt">${credit ? fmt(entry.tokens) + ' tokens' : Number(entry.credits) > 0 ? full(entry.credits) + ' Credits' : ''}</div></div><span class="amt num">${credit ? full(entry.credits) : fmt(entry.tokens)}</span>${route.name === 'group' && !credit && !mine ? `<button class="more" data-pk="${entry.rank}">PK</button>` : ''}</div>`;
    }
    return `<div class="list-header"><span>${full(board.total)} 人 · ${credit ? 'Credits 用量' : 'Token 用量'}</span><span>已显示 ${board.entries.length} 人</span></div>${board.entries.map(e => row(e, e.rank === board.me?.rank)).join('') || empty('本期暂无上报成员；请通过飞书机器人加入群榜并接入电脑')}${board.me ? '<div class="fixed-mine" aria-label="我的排名"><a href="' + esc(M.routeHash({ name: 'me', period: route.period })) + '">查看我的用量</a>' + row({ ...board.me, nickname: user?.nickname, avatar_url: user?.avatar_url }, true) + '</div>' : note('本期暂无我的公开排名，可通过机器人查看加入或显示状态')}
      ${board.has_more ? '<button class="btn ghost" id="load-more">加载更多</button>' : note('已显示全部排名')}`;
  }
  function mountBoard(board, alive) {
    const box = $('#board');
    box.innerHTML = boardHTML(board);
    const more = box.querySelector('#load-more');
    if (more) more.addEventListener('click', async () => {
      more.disabled = true; more.textContent = '加载中…';
      try {
        const next = await read(M.boardPath(route, board.next_offset, board.snapshot));
        if (!alive()) return;
        mountBoard(M.mergeBoard(board, next), alive);
      } catch (error) {
        if (!alive() || error.stale) return;
        if (error.status === 409) {
          box.innerHTML = empty('榜单已有更新，不能拼接旧排名。请刷新榜单后重新加载。') + '<button class="btn" data-refresh>刷新榜单</button>';
        } else { more.disabled = false; more.textContent = '重新加载更多'; showError(error); }
      }
    });
  }
  async function group(alive) {
    page.innerHTML = heading(route.name === 'group-analysis' ? '群数据分析' : '群榜详情', true) + periodTabs() + '<div id="body">' + empty('加载群数据…') + '</div>';
    const data = await read('/api/groups/' + route.id + '/page?period=' + route.period);
    if (!alive()) return;
    user = data.user;
    const prefix = `<div class="section"><span class="t">${esc(data.group.name)}</span><span>${full(data.group.members)} 人</span></div>` + syncBlock(user);
    window.__trGroup = data.group;
    const actions = `<div class="links">${data.group.can_rename ? '<button class="more" data-group-rename>修改群名</button>' : ''}<button class="more" data-group-visibility="${!data.group.my_hidden}">${data.group.my_hidden ? '在群榜显示我' : '在群榜隐藏我'}</button><button class="more" data-group-leave>退出群榜</button></div>`;
    if (!data.board) { $('#body').innerHTML = prefix + empty('需先加入群榜并完善昵称头像。请在飞书群发送「加入」，单聊机器人查看账号接入状态。'); return; }
    if (route.name === 'group-analysis') {
      const report = data.insights;
      $('#body').innerHTML = prefix + (report ? hero(report, '群公开成员用量') + `<div class="caption">${full(report.summary?.active_users)} 人活跃 · ${full(report.summary?.reported_users)} 人已上报 · 隐藏成员不纳入统计</div>` + stats(report) + dimensions() + analysisBlock(report[route.dimension]) + shareControls({ style: 'group-insights', group_id: route.id, period: route.period, snapshot: report.snapshot }) : empty(data.insights_error || '群分析暂不可用，请刷新后重试')) + robotNote();
    } else {
      $('#body').innerHTML = prefix + actions + `<div class="links">${link({ ...route, name: 'group-analysis' }, '群数据分析')}</div>` + metricTabs() + '<div id="board"></div>' + robotNote();
      const board = route.metric === 'credits' ? await read(M.boardPath(route)) : data.board;
      if (alive()) mountBoard(M.mergeBoard(null, board), alive);
    }
  }
  async function square(alive) {
    page.innerHTML = heading('广场排名') + periodTabs() + tabs([['sum', '双榜'], ['analysis', '分析'], ['trend', '趋势']], route.view, 'view') + '<div id="body">' + empty('加载广场…') + '</div>';
    if (route.view === 'trend') return squareTrends(alive);
    if (route.view === 'analysis') {
      const bundle = await read('/api/insights?period=' + route.period + '&dimension=tools&bundle=1');
      let data = bundle[route.dimension];
      if (!data) data = route.dimension === 'tools' ? bundle : await read('/api/insights?period=' + route.period + '&dimension=models');
      if (route.tool) data = await read('/api/insights?period=' + route.period + '&dimension=models&tool=' + encodeURIComponent(route.tool));
      if (alive()) $('#body').innerHTML = dimensions() + (route.tool ? note('工具模型下钻：' + route.tool) + link({ ...route, tool: '' }, '返回全部模型') : '') + analysisBlock(data) + note('Credits 为工具自报积分；未覆盖的分项不按零费用解释。');
    } else {
      $('#body').innerHTML = metricTabs() + '<div id="board">' + empty('加载排名…') + '</div>';
      const board = await read(M.boardPath({ ...route, id: '' }));
      if (alive()) mountBoard(M.mergeBoard(null, board), alive);
    }
  }
  function dateNav(previous, next, key, title) {
    return `<div class="nav-row"><button class="nav-btn" ${previous ? `data-set="${key}" data-value="${esc(previous)}"` : 'disabled'}>上一${key === 'month' ? '月' : key === 'week' ? '周' : '天'}</button><span class="nav-title">${esc(title)}</span><button class="nav-btn" ${next ? `data-set="${key}" data-value="${esc(next)}"` : 'disabled'}>下一${key === 'month' ? '月' : key === 'week' ? '周' : '天'}</button></div>`;
  }
  async function me(alive) {
    page.innerHTML = heading('我的用量', route.view !== 'sum') + tabs([['sum', '汇总'], ['cal', '日历'], ['daily', '日报'], ['trend', '走势'], ['analysis', '分析']], route.view, 'view') + (['sum', 'analysis'].includes(route.view) ? periodTabs() : '') + '<div id="body">' + empty('加载我的用量…') + '</div>';
    if (route.view === 'analysis') {
      const bundle = await read('/api/my/analysis?period=' + route.period + '&dimension=tools&bundle=1');
      let data = bundle[route.dimension] || (route.dimension === 'tools' ? bundle : await read('/api/my/analysis?period=' + route.period + '&dimension=models'));
      if (route.tool) data = await read('/api/my/analysis?period=' + route.period + '&dimension=models&tool=' + encodeURIComponent(route.tool));
      if (alive()) $('#body').innerHTML = dimensions() + (route.tool ? note('工具模型下钻：' + route.tool) + link({ ...route, tool: '' }, '返回全部模型') : '') + analysisBlock(data);
      return;
    }
    if (route.view === 'cal') return calendar(alive);
    if (route.view === 'daily') return daily(alive);
    if (route.view === 'trend') return weekly(alive);
    const data = await read('/api/my/overview?period=' + route.period);
    if (!alive()) return;
    user = data.user;
    $('#body').innerHTML = syncBlock(user) + (data.usage ? hero(data.usage, '我的用量') + `<div class="stats"><div><div class="v num">${full(data.usage.summary?.active_days)} 天</div><div class="k">活跃天数</div></div><div><div class="v num">${full(data.usage.activity?.current_streak)} 天</div><div class="k">连续记录</div></div></div>` + stats(data.usage) + trendBars((data.usage.daily || []).filter(d => d.day >= data.usage.from && d.day <= data.usage.to)) + shareControls({ style: 'usage', period: route.period }) : empty(data.usage_error?.error || '用量暂不可用，请刷新后重试')) + `<div class="links">${link({ name: 'settings' }, '设置与接入')}${link({ name: 'achievements' }, '成就图鉴')}${link({ name: 'groups', period: route.period === 'all' ? 'day' : route.period }, '我的群榜')}</div>` + robotNote();
  }
  async function daily(alive) {
    const day = route.day || M.shiftDay(M.beijingDay(), -1);
    const data = await read('/api/my/daily?day=' + day);
    if (!alive()) return;
    $('#body').innerHTML = dateNav(data.previous_day, data.next_day, 'day', day) + `<div class="caption">选择日期 <input class="date-pick" id="daily-date" type="date" value="${day}" max="${M.shiftDay(M.beijingDay(), -1)}" aria-label="日报日期"></div>` + (data.has_history ? hero(data, day) + stats(data) + analysisBlock({ items: data.tools }) + analysisBlock({ items: data.models }) + note('主力工具：' + (data.top_tool?.name || '暂无分项') + ' · 主力模型：' + (data.top_model?.name || '暂无分项')) + shareControls({ style: 'daily', day, day_snapshot: data.snapshot }) : empty('这一天没有同步记录；未同步不代表零用量或零费用')) + note('日报只展示已结束的自然日 · 北京时间');
    $('#daily-date').addEventListener('change', event => { if (M.validDay(event.target.value) && event.target.value < M.beijingDay()) patch({ day: event.target.value }); });
  }
  async function calendar(alive) {
    const month = route.month || M.beijingDay().slice(0, 7);
    const data = await read('/api/my/calendar?month=' + month);
    if (!alive()) return;
    const map = M.heatmap(route.range === 'month' ? { ...data, heatmap: null, daily: data.daily.map(d => ({ ...d, details: data.heatmap?.daily?.find(h => h.day === d.day)?.details })) } : data);
    const prefKey = 'tr_calendar_display:' + (user?.id || token), pref = JSON.parse(localStorage.getItem(prefKey) || '{"device":true,"model":true,"cost":false}');
    $('#body').innerHTML = tabs([['quarter', '近13周'], ['month', '本月']], route.range, 'range') + `<div class="links">${[['device', '显示设备'], ['model', '显示模型'], ['cost', '显示费用']].map(([key, label]) => `<label><input type="checkbox" data-calendar-pref="${key}" ${pref[key] ? 'checked' : ''}>${label}</label>`).join('')}</div>` + dateNav(data.previous_month, data.next_month, 'month', month) + `<div class="caption">${esc(map.from)} — ${esc(map.to)} · 北京时间 · ${map.extended ? '近13周' : '本月'}</div><div class="heatmap-scroll"><div class="heatmap" style="--weeks:${Math.ceil(map.days.length / 7)}">${map.days.map(day => `<button class="heat-cell level-${day.level} ${day.outside ? 'outside' : ''} ${day.future ? 'future' : ''}" data-calendar-day="${esc(day.day)}" ${day.outside || day.future ? 'disabled' : ''} aria-label="${esc(day.day + ' · ' + day.statusText + (day.reported ? ' · ' + full(day.tokens) + ' tokens' : ''))}" title="${esc(day.day + ' · ' + day.statusText)}"><span>${Number(day.day.slice(-2))}</span></button>`).join('')}</div></div><div class="caption">颜色深浅表示 Token 用量；空白表示未同步或范围外，已同步零用量会单独标注。</div><div id="day-detail" aria-live="polite"></div><label class="field"><input type="checkbox" id="share-amount">在公开日历分享中包含费用金额（默认不公开）</label>` + shareControls({ style: 'calendar', month, calendar_snapshot: data.snapshot });
    let chosen;
    $('#body').querySelectorAll('[data-calendar-pref]').forEach(box => { box.onchange = () => { pref[box.dataset.calendarPref] = box.checked; localStorage.setItem(prefKey, JSON.stringify(pref)); if (chosen) select(chosen); }; });
    function select(day) {
      chosen = day;
      const c = M.costView(day.details?.cost || day.cost);
      $('#day-detail').innerHTML = `<div class="section"><span class="t">${esc(day.day)}</span><span>${esc(day.statusText)}</span></div><div class="hero"><div class="full">${day.reported ? full(day.tokens) + ' tokens' : '暂无用量记录'}</div>${pref.device ? `<div class="full">设备：${esc(day.details?.device?.label || '暂无设备信息')}（当前选定设备）</div>` : ''}${pref.model ? `<div class="full">主力模型：${esc(day.details?.top_model?.name || '暂无模型分项')}</div>` : ''}${pref.cost ? `<div class="full">${esc(c.label)} · ${esc(c.amount)}${c.available ? ' USD' : ''}</div><div class="full">${esc(c.note)} · 非实际账单</div>` : ''}</div>${day.reported && day.day < data.today ? `<div class="links">${link({ ...route, view: 'daily', day: day.day }, '查看当日日报')}</div>` : note(day.day === data.today ? '今天进行中，结束后可查看日报' : '未同步日期不按零用量或零费用统计')}`;
    }
    $('#body').querySelectorAll('[data-calendar-day]').forEach(button => button.addEventListener('click', () => select(map.days.find(d => d.day === button.dataset.calendarDay))));
    const selected = map.days.find(d => d.day === route.day && !d.outside && !d.future) || [...map.days].reverse().find(d => d.reported) || map.days.find(d => !d.outside && !d.future);
    if (selected) select(selected);
  }
  async function weekly(alive) {
    const week = route.week || M.shiftDay(M.monday(M.beijingDay()), -7);
    const data = await read('/api/my/weekly?week=' + week);
    if (!alive()) return;
    const w = data.weekly || {}, max = Math.max(1, ...data.daily.map(d => d.tokens || 0));
    const comparison = w.comparison_status === 'comparable' ? `较上期 ${w.change_tokens >= 0 ? '+' : ''}${w.change_percent}% · 上期 ${fmt(w.previous_tokens)} tokens` : w.comparison_status === 'zero_base' ? `上期已记录零用量 · 本期 ${fmt(data.summary.tokens)} tokens，不计算增长百分比` : w.comparison_status === 'ongoing' ? '本周进行中，暂不比较' : '上期数据不足，暂无可比';
    $('#body').innerHTML = dateNav(data.previous_week, data.next_week, 'week', data.from + ' — ' + data.to) + hero(data, '周走势') + `<div class="caption">${esc(comparison)} · ${full(w.reported_days)}/7 天有记录</div><div class="bars">${data.daily.map(d => `<div class="bar-col" title="${esc(d.day + ' · ' + (d.future ? '未到日期' : d.reported ? full(d.tokens) + ' tokens' : '未同步'))}"><span class="v">${d.reported ? fmt(d.tokens) : '—'}</span><div class="bar-fill" style="height:${d.future || !d.reported ? 0 : Math.max(1, (d.tokens || 0) / max * 100)}%"></div><span class="k">${esc(d.day.slice(5))}</span></div>`).join('')}</div>` + stats(data) + note(`峰值：${w.peak ? w.peak.day + ' · ' + fmt(w.peak.tokens) + ' tokens' : '暂无非零记录'} · 主力模型：${w.top_model?.name || '暂无模型分项'}`) + analysisBlock({ items: data.tools }) + `<div class="links">${(data.groups || []).map(g => link({ name: 'group', id: g.id, period: 'week' }, g.name)).join('')}</div>` + `<label class="field">周报群成绩<select id="weekly-group"><option value="">不附群成绩</option>${(data.groups || []).map(g => `<option value="${esc(g.id)}">${esc(g.name)}</option>`).join('')}</select></label><div id="weekly-standing"></div>` + shareControls({ style: 'weekly', week, week_snapshot: data.snapshot });
    $('#weekly-group').onchange = async e => { const id = e.target.value, button = $('[data-share]'), options = { style: 'weekly', week, week_snapshot: data.snapshot, ...(id ? { group_id: id } : {}) }; button.dataset.share = JSON.stringify(options); $('#weekly-standing').textContent = id ? '分享将附所选群在该自然周的成绩，由服务端按周报日期核算；不会使用当前滚动近7天排名。' : ''; };
    $('#body').insertAdjacentHTML('beforeend', note('走势按北京时间自然日；未同步不视为零用量'));
    return;
  }
  let displayLease = null;
  async function releaseDisplay() {
    const lease = displayLease; displayLease = null;
    if (lease && !lease.confirmed && lease.identity === token) await write('/api/my/achievements/release', { claim_id: lease.id }).catch(() => {});
  }
  async function playBadge(badge, image, alive, lease = null) {
    const motion = !matchMedia('(prefers-reduced-motion: reduce)').matches && localStorage.getItem('tr_reduce_motion') !== 'true';
    try {
      await image.decode(); if (!alive() || !image.isConnected || document.hidden) return;
      // Wait for an actual rendered frame before acknowledging first presentation.
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      if (!alive() || !image.isConnected || document.hidden) return;
      if (motion && image.animate) await image.animate([{ transform: 'scale(.6)', opacity: 0 }, { transform: 'scale(1.08)', opacity: 1 }, { transform: 'scale(1)', opacity: 1 }], { duration: 850, easing: 'ease-out' }).finished;
      if (!alive() || !image.isConnected || document.hidden) return;
      if (lease) { if (lease.expires_at <= Date.now() || lease.identity !== token) throw new Error('成就展示已过期，请刷新重试'); await write('/api/my/achievements/confirm', { claim_id: lease.id }); lease.confirmed = true; if (displayLease === lease) displayLease = null; }
    } catch (error) { if (alive()) showError(error); }
    finally { if (lease && !lease.confirmed) await releaseDisplay(); }
  }
  async function achievements(alive) {
    page.innerHTML = heading('成就图鉴', true) + '<div id="body">' + empty('加载成就图鉴…') + '</div>';
    let prepared = null;
    if (!route.family) prepared = await write('/api/my/achievements/prepare');
    if (!alive()) { if (prepared?.claim_id) await write('/api/my/achievements/release', { claim_id: prepared.claim_id }); return; }
    const catalogue = prepared?.catalogue || await read('/api/my/achievements');
    if (!alive()) return;
    if (prepared?.claim_id && prepared.badge) { displayLease = { id: prepared.claim_id, expires_at: prepared.expires_at, identity: token, confirmed: false }; route = { ...route, family: prepared.badge.family, badge: prepared.badge.id }; }
    const family = catalogue.families.find(f => f.id === route.family);
    if (route.family && !family) { $('#body').innerHTML = empty('该成就不存在，请返回图鉴重新选择'); return; }
    if (family) {
      const badges = family.badges || [], badge = badges.find(b => b.id === route.badge) || [...badges].reverse().find(b => b.earned) || badges[0];
      $('#body').innerHTML = `<div class="section"><span class="t">${esc(family.label)}</span><span>${family.enabled ? '已达成 ' + badges.filter(b => b.earned).length + '/' + badges.length : '暂未开放'}</span></div>${badge ? `<img class="badge-detail ${badge.earned ? '' : 'locked'}" src="${esc(M.badgeArt(badge))}" alt="${esc(badge.label)}"><div class="badge-info"><h2>${esc(badge.label)} · ${fmt(badge.threshold)} ${esc(badge.unit)}</h2><p>${esc(badge.metric_label)}：${fmt(badge.current)} ${esc(badge.unit)}</p><progress max="${badge.threshold}" value="${Math.min(badge.threshold, Math.max(0, badge.current))}" aria-label="达成进度"></progress><p>${badge.earned ? '已达成 · ' + esc(badge.achieved_day || '') : '未达成 · 还差 ' + fmt(Math.max(0, badge.threshold - badge.current)) + ' ' + esc(badge.unit)}</p></div><div class="tier-list">${badges.map(b => link({ ...route, badge: b.id }, `${b.tier} 阶 · ${fmt(b.threshold)} ${b.unit} · ${b.earned ? '已达成' : '未达成'}`, 'tier')).join('')}</div>` : empty(family.metric_label || '指标尚未接入，暂未开放')}` + `<label class="field"><input type="checkbox" id="reduce-motion" ${localStorage.getItem('tr_reduce_motion') === 'true' ? 'checked' : ''}>减少动态效果</label>${badge?.earned ? '<button class="btn ghost" id="replay">重播成就动画</button>' + shareControls({ style: 'milestone', badge_id: badge.id, achievement_snapshot: catalogue.snapshot }) : ''}`;
      $('#reduce-motion').onchange = e => localStorage.setItem('tr_reduce_motion', String(e.target.checked));
      if ($('#replay')) $('#replay').onclick = e => mutate(e.currentTarget, () => playBadge(badge, $('.badge-detail'), alive), () => {});
      if (displayLease) await playBadge(badge, $('.badge-detail'), alive, displayLease);
    } else {
      $('#body').innerHTML = `<div class="caption">已达成 ${full(catalogue.earned_count)} 枚 · ${esc(catalogue.as_of)} · 北京时间</div><div class="badge-grid">${catalogue.families.map(f => {
        const badge = [...(f.badges || [])].reverse().find(b => b.earned) || f.badges?.[0] || f;
        return `<a href="${esc(M.routeHash({ name: 'achievements', family: f.id }))}" class="badge-tile"><img src="${esc(M.badgeArt(badge))}" class="${f.badges?.some(b => b.earned) ? '' : 'locked'}" alt=""><strong>${esc(f.label)}</strong><span>${f.enabled ? f.badges.filter(b => b.earned).length + ' / ' + f.badges.length : '暂未开放'}</span></a>`;
      }).join('')}</div>` + note('成就按已上报数据计算，仅展示进度；未接入产出数据的成就不会虚构达成。');
    }
  }
  // Mutations capture the current route and identity; stale completions must never repaint it.
  async function mutate(button, action, after = () => render()) {
    const alive = current, identity = token;
    if (button.disabled) return;
    button.disabled = true;
    try { await action(); if (alive() && identity === token) await after(); }
    catch (error) { if (alive() && identity === token) { showError(error); if ([403, 409, 428].includes(error.status)) { cache.clear(); } } }
    finally { if (alive() && button.isConnected) button.disabled = false; }
  }
  function field(name, label, value = '', type = 'text', attrs = '') {
    return `<label class="field">${esc(label)}<input name="${name}" type="${type}" value="${esc(value)}" ${attrs}></label>`;
  }
  const labels = { week: '每周', month: '每月', quarter: '每季', year: '每年', custom: '自定义', active: '订阅中', paused: '已暂停', cancelled: '已取消', topup: '充值', balance: '校准余额', pending: '已预约', sending: '正在发送', sent: '已发送', failed: '发送失败', unknown: '状态待核实', needs_permission: '需要授权' };
  const labelOf = value => labels[value] || value;
  function selectField(name, label, values, value) {
    return `<label class="field">${esc(label)}<select name="${name}">${values.map(v => `<option value="${esc(v)}" ${v === value ? 'selected' : ''}>${esc(labelOf(v))}</option>`).join('')}</select></label>`;
  }
  async function subscriptions(alive) {
    page.innerHTML = heading('订阅与充值') + '<div id="body">' + empty('加载账本…') + '</div>';
    const data = await read('/api/subscriptions'); if (!alive()) return;
    const money = (v, c = 'USD') => `${esc(c)} ${full((v || 0) / 100)}`;
    $('#body').innerHTML = note('手工记录实际支出；API 等值为估算，不代表真实账单。') +
      (data.summary?.usd ? `<div class="hero">月均 ${money(data.summary.usd.monthly_minor)} · 累计 ${money(data.summary.usd.spent_minor)}</div>` : '') +
      `<div class="links"><button data-ledger-new="subscriptions">新增订阅</button><button data-ledger-new="topups">记录充值 / 校准余额</button></div><div id="ledger-editor"></div>` +
      (data.items || []).map(i => `<div class="group-row"><strong>${esc(i.name)} ${esc(i.plan)}</strong><p>${money(i.price_minor, i.currency)} / ${esc(labelOf(i.cycle))} · ${esc(labelOf(i.status))} · 下次 ${esc(i.next_renewal_day || '—')}</p>${i.period ? `<p>本期 ${i.period.paid_back ? '已回本' : '未回本'} · ${i.period.ratio ?? '—'} 倍 · 剩余 ${i.period.days_left} 天</p>` : ''}<button data-ledger-edit="subscriptions" data-id="${i.id}">编辑</button><button data-ledger-delete="subscriptions" data-id="${i.id}">删除</button></div>`).join('') +
      (data.topups || []).map(t => `<div class="group-row"><strong>${esc(t.vendor)} · 估算余额 ${money(t.remaining_minor, t.currency)}</strong><p>已用 ${money(t.spent_minor, t.currency)} · ${t.days_left == null ? '暂无消耗速度' : '约剩 ' + t.days_left + ' 天'}</p>${t.records.map(r => `<p>${esc(r.day)} · ${r.kind === 'balance' ? '校准余额' : '充值'} ${money(r.amount_minor, r.currency)} <button data-ledger-edit="topups" data-id="${r.id}">编辑</button><button data-ledger-delete="topups" data-id="${r.id}">删除</button></p>`).join('')}</div>`).join('') + (!data.items?.length && !data.topups?.length ? empty('账本尚无记录，点击新增订阅或记录充值开始') : '');
    function editor(kind, id) {
      const item = kind === 'subscriptions' ? data.items?.find(i => i.id === id) : (data.topups || []).flatMap(t => t.records.map(r => ({ ...r, vendor: t.vendor, currency: t.currency }))).find(i => i.id === id);
      const i = item || {}, topup = kind === 'topups';
      $('#ledger-editor').innerHTML = `<form id="ledger-form" class="form"><h2>${id ? '编辑' : '新增'}${topup ? '充值记录' : '订阅'}</h2>` + (topup ? field('vendor', '服务标识', i.vendor || 'deepseek', 'text', 'required') + selectField('kind', '类型', ['topup', 'balance'], i.kind || 'topup') + field('amount', '金额', i.amount_minor == null ? '' : i.amount_minor / 100, 'number', 'required min="0" max="1000000000" step="0.01"') + field('day', '日期', i.day || M.beijingDay(), 'date', `required max="${M.beijingDay()}"`) : field('name', '服务名称', i.name, 'text', 'required maxlength="100"') + field('plan', '套餐', i.plan) + field('price', '价格', i.price_minor == null ? '' : i.price_minor / 100, 'number', 'required min="0.01" max="1000000" step="0.01"') + selectField('cycle', '计费周期', ['week', 'month', 'quarter', 'year', 'custom'], i.cycle || 'month') + field('custom_days', '自定义周期天数', i.custom_days, 'number', 'min="1" max="3650"') + field('start_day', '开始日期', i.start_day || M.beijingDay(), 'date', `required max="${M.beijingDay()}"`) + selectField('status', '状态', ['active', 'paused', 'cancelled'], i.status || 'active') + field('ended_day', '结束日期（暂停或取消时）', i.ended_day || M.beijingDay(), 'date') + `<label class="field"><input type="checkbox" name="api_key" ${i.api_key ? 'checked' : ''}>API Key 订阅</label>`) + selectField('currency', '币种', ['CNY', 'USD', 'EUR', 'GBP', 'HKD', 'JPY'], i.currency || 'CNY') + field('notes', '备注', i.notes) + '<button class="btn" type="submit">保存记录</button><button type="button" id="close-editor">取消编辑</button></form>';
      $('#close-editor').onclick = () => { $('#ledger-editor').replaceChildren(); };
      $('#ledger-form').onsubmit = e => { e.preventDefault(); const form = e.currentTarget, body = Object.fromEntries(new FormData(form)); if (topup) body.amount = Number(body.amount); else { body.price = Number(body.price); body.custom_days = body.cycle === 'custom' ? Number(body.custom_days) : null; body.api_key = form.elements.api_key.checked; if (body.status === 'active') delete body.ended_day; } mutate(form.querySelector('[type=submit]'), () => write('/api/' + kind + (id ? '/' + id : ''), body)); };
      $('#ledger-editor').scrollIntoView?.({ block: 'nearest' });
    }
    $('#body').onclick = e => { const b = e.target.closest('button'); if (!b) return; if (b.dataset.ledgerNew) editor(b.dataset.ledgerNew); if (b.dataset.ledgerEdit) editor(b.dataset.ledgerEdit, b.dataset.id); if (b.dataset.ledgerDelete && confirm('删除这笔记录？删除后无法恢复。')) mutate(b, () => write('/api/' + b.dataset.ledgerDelete + '/' + b.dataset.id, {}, 'DELETE')); };
  }
  function logout() { token = ''; user = null; A.clear(); cache.clear(); guard.invalidate(); ready = false; loginMask('已退出登录', '重新授权后可查看群榜与个人用量'); }
  async function settings(alive) {
    page.innerHTML = heading('个人设置', true) + '<div id="body"></div>';
    const profile = await read('/api/me'); if (!alive()) return; user = profile;
    $('#body').innerHTML = `<form id="profile-form" class="form">${avatar(profile)}${field('nickname', '昵称', profile.nickname, 'text', 'required maxlength="16"')}${field('avatar', '头像（JPG / PNG / WebP）', '', 'file', 'accept="image/png,image/jpeg,image/webp"')}<button class="btn">保存资料</button></form><label class="field"><input id="ranking-hidden" type="checkbox" ${profile.rank_hidden ? 'checked' : ''}>不参与公开排名</label><div class="links">${link({ name: 'help' }, '接入电脑与同步状态')}${link({ name: 'email' }, '邮箱登记')}${link({ name: 'reminders' }, '飞书提醒')}</div><button class="btn ghost" id="logout">退出登录</button><button class="btn ghost" id="delete-account">注销账号</button>`;
    $('#profile-form').onsubmit = e => { e.preventDefault(); const form = e.currentTarget, body = new FormData(); body.set('nickname', form.elements.nickname.value); const file = form.elements.avatar.files[0]; if (file) body.set('avatar', file); mutate(form.querySelector('button'), () => request('/api/profile', { method: 'POST', body })); };
    $('#ranking-hidden').onchange = e => { const box = e.currentTarget; mutate(box, () => write('/api/profile/ranking', { hidden: box.checked })); };
    $('#logout').onclick = logout;
    $('#delete-account').onclick = e => { if (prompt('注销会删除用量、群关系、分享与接入凭证，无法恢复。输入 DELETE_ACCOUNT 继续。') === 'DELETE_ACCOUNT') mutate(e.currentTarget, () => write('/api/account', { confirm: 'DELETE_ACCOUNT' }, 'DELETE'), logout); };
  }
  async function email(alive) {
    page.innerHTML = heading('邮箱登记', true) + '<div id="body"></div>';
    const data = await read('/api/email-registration'); if (!alive()) return;
    $('#body').innerHTML = note('当前仅登记意向，尚未验证邮箱，也不会发送日报邮件。') + `<form class="form" id="email-form">${field('email', '邮箱地址', data.email, 'email', 'required')}<label class="field"><input name="consent" type="checkbox" required>同意仅为日报邮件意向保存邮箱，可随时删除</label><button class="btn">保存登记</button></form>${data.registered ? '<button class="btn ghost" id="remove-email">删除登记</button>' : ''}`;
    $('#email-form').onsubmit = e => { e.preventDefault(); const f = e.currentTarget; mutate(f.querySelector('button'), () => write('/api/email-registration', { email: f.elements.email.value, consent: f.elements.consent.checked, consent_version: data.consent_version, expected_revision: data.revision })); };
    if ($('#remove-email')) $('#remove-email').onclick = e => { if (confirm('删除已登记的邮箱？')) mutate(e.currentTarget, () => write('/api/email-registration', { expected_revision: data.revision }, 'DELETE')); };
  }
  async function reminders(alive) {
    page.innerHTML = heading('飞书提醒', true) + '<div id="body"></div>';
    const data = await request('/api/reminders'); if (!alive()) return;
    $('#body').innerHTML = note(`渠道：${data.channel === 'feishu' ? '飞书单聊' : '微信'} · 每次预约仅提醒一次`) + data.kinds.map(k => `<div class="group-row"><strong>${esc(k.label)}</strong><p>${esc(labelOf(k.appointment?.state) || '未预约')}${k.appointment?.report_day ? ' · 日报 ' + esc(k.appointment.report_day) : ''}</p>${k.available && !data.authorization_required && data.has_reported ? `<button data-reserve="${k.key}">预约一次</button>${k.appointment?.state === 'pending' ? `<button data-cancel-reminder="${k.key}" data-id="${k.appointment.id}">取消预约</button>` : ''}` : `<p>${esc(k.unavailable_reason || k.reason || (data.authorization_required ? '请在微信小程序完成授权' : '请先接入电脑并完成首次同步'))}</p>`}</div>`).join('');
    $('#body').onclick = e => { const b = e.target.closest('button'); if (!b) return; if (b.dataset.reserve) { b.dataset.requestId ||= M.oauthState(crypto); mutate(b, () => write('/api/reminders/' + b.dataset.reserve, { request_id: b.dataset.requestId })); } if (b.dataset.cancelReminder) mutate(b, () => write('/api/reminders/' + b.dataset.cancelReminder, { id: b.dataset.id }, 'DELETE')); };
  }
  async function share(alive) {
    page.innerHTML = heading('公开分享', true) + '<div id="public-share"></div>';
    const box = $('#public-share');
    await window.TokenRankShare.mountRoute(box, route.id, { onCompare: record => { if (alive()) window.TokenRankShare.render(box, record, { owner: true }); }, onError: showError });
    if (alive() && !token) box.insertAdjacentHTML('beforeend', '<button class="btn ghost" data-login>登录后参与 PK</button>');
  }
  async function help() {
    page.innerHTML = heading('使用说明') + `<div class="help"><h3>接入电脑</h3><p>在飞书单聊机器人发送「绑定」，或在这里获取专属安装命令。命令含接入凭证，请勿公开转发。</p><button class="btn" id="getcmd">获取接入命令</button><div id="cmd" aria-live="polite"></div><h3>群内命令</h3><p><b>加入</b>：上榜本群<br><b>榜单 [今日|本周|本月|总榜]</b>：查看群排名<br><b>隐藏 / 显示 / 退出</b>：管理我的排名</p><h3>单聊命令</h3><p><b>绑定</b>：接入电脑　<b>我的</b>：个人用量　<b>榜单</b>：广场榜</p><h3>统计与分享</h3><p>总用量含缓存，按北京时间自然日统计。用量来自个人电脑上报，仅供交流参考，不等同厂商账单。不上传代码、对话内容、提示词、项目名和文件路径。用量、日报、周报、日历和成就可生成可撤销公开快照；群内临时 PK 不生成公开链接或图片。</p><button class="btn ghost" id="logout">退出登录</button></div>`;
    const alive = current;
    $('#getcmd').addEventListener('click', async event => {
      const button = event.currentTarget; button.disabled = true;
      try {
        // Credentials deliberately bypass the shared read cache.
        const data = await request('/api/connect/token');
        if (!alive()) return;
        $('#cmd').innerHTML = `<h3>macOS / Linux</h3><code class="cmd">${esc(data.install_command || '安装命令暂不可用，请单聊机器人发送「绑定」')}</code><h3>Windows PowerShell</h3><code class="cmd">${esc(data.install_command_windows || 'Windows 安装命令暂不可用，请联系管理员')}</code>`;
        $('#cmd').insertAdjacentHTML('beforeend', `<p>接入码（仅本人使用）</p><code>${esc(data.token)}</code>${syncBlock(data)}<p>AI 接入指引：将上方对应系统的安装命令交给电脑上的 AI 助手，要求先解释步骤，再经你允许执行；不要公开命令或接入码。安装完成后回此页刷新同步状态。</p><button class="btn ghost" id="rotate-code">重置接入码</button>`);
        $('#rotate-code').onclick = e => { if (confirm('重置将使旧接入码失效，所有电脑需重新接入，继续？')) mutate(e.currentTarget, () => write('/api/connect/token')); };
      } catch (error) { if (alive()) showError(error); }
      finally { if (alive()) button.disabled = false; }
    });
    $('#logout').addEventListener('click', logout);
  }
  function showError(error) {
    if (error.stale || error.status === 401) return;
    const toast = document.querySelector('#toast'); toast.textContent = error.message; toast.hidden = false;
    clearTimeout(showError.timer); showError.timer = setTimeout(() => { toast.hidden = true; }, 4000);
  }
  async function render() {
    if (!ready && M.parseRoute(location.hash).name !== 'share') return;
    current = guard.next(); const alive = current;
    await releaseDisplay(); if (!alive()) return;
    route = M.parseRoute(location.hash);
    document.querySelectorAll('.tabbar button').forEach(button => {
      const active = button.dataset.tab === (route.name.startsWith('group') ? 'groups' : route.name === 'achievements' ? 'me' : route.name);
      button.classList.toggle('active', active); button.setAttribute('aria-current', active ? 'page' : 'false');
    });
    try { await ({ groups, group, 'group-analysis': group, square, me, achievements, help, subscriptions, settings, email, reminders, share })[route.name](alive); }
    catch (error) { if (alive() && !error.stale && error.status !== 401) page.insertAdjacentHTML('beforeend', `<div role="alert" class="empty">${esc(error.message)}<button class="btn ghost" data-refresh>重新加载</button></div>`); }
    finally { if (alive()) force = false; }
  }
  page.addEventListener('change', event => { if (event.target.matches('[data-analysis-category]')) patch({ category: event.target.value, analysisView: 'trend' }); });
  page.addEventListener('click', async event => {
    const button = event.target.closest('button'); if (!button) return;
    if (button.hasAttribute('data-login')) { authorize().catch(error => loginMask('登录失败', error.message)); return; }
    if (button.hasAttribute('data-share')) {
      const alive = current, box = button.parentElement.querySelector('.share-result');
      return mutate(button, async () => { const options = JSON.parse(button.dataset.share); if (options.style === 'calendar') options.show_amount = !!$('#share-amount')?.checked; const record = await window.TokenRankShare.create(options); if (alive() && box?.isConnected) window.TokenRankShare.render(box, record, { owner: true, onError: showError, onCompare: r => { if (alive()) window.TokenRankShare.render(box, r, { owner: true }); } }); }, () => {});
    }
    if (button.hasAttribute('data-group-rename')) { const name = prompt('输入新的群榜名称', window.__trGroup?.name || ''); if (name?.trim()) return mutate(button, () => write('/api/groups/' + route.id + '/rename', { name: name.trim() })); }
    if (button.hasAttribute('data-group-visibility')) return mutate(button, () => write('/api/groups/' + route.id + '/visibility', { hidden: button.dataset.groupVisibility === 'true' }));
    if (button.hasAttribute('data-group-leave') && confirm('退出此群榜？个人用量会保留，重新加入需回飞书群操作。')) return mutate(button, () => write('/api/groups/' + route.id + '/leave'), () => go({ name: 'groups' }));
    if (button.hasAttribute('data-pk')) { const alive = current, path = '/api/groups/' + route.id + '/compare', body = { period: route.period, rank: Number(button.dataset.pk), snapshot: window.__trBoard.snapshot }; return mutate(button, async () => { const record = await write(path, body); if (!alive()) return; let box = $('#pk-result'); if (!box) { page.insertAdjacentHTML('beforeend', '<div id="pk-result"></div>'); box = $('#pk-result'); } window.TokenRankShare.renderTransient(box, { ...record, self_tokens: record.usage.summary.tokens, difference_tokens: record.usage.summary.tokens - record.comparison.source.usage.summary.tokens }); box.scrollIntoView?.(); }, () => {}); }
    if (button.hasAttribute('data-audience')) return audience(button);
    if (button.hasAttribute('data-set')) patch({ [button.dataset.set]: button.dataset.value });
    if (button.hasAttribute('data-back')) {
      // App-owned history supports browser back; a direct deep link gets a deterministic parent.
      if (history.state?.trApp) history.back(); else go(M.parentRoute(route));
    }
    if (button.hasAttribute('data-refresh')) { force = true; cache.clear(); render(); }
  });
  document.querySelectorAll('.tabbar button').forEach(button => button.addEventListener('click', () => go({ name: button.dataset.tab })));
  addEventListener('hashchange', render);
  addEventListener('pagehide', () => { guard.invalidate(); releaseDisplay(); });
  document.addEventListener?.('visibilitychange', () => { if (document.hidden) { guard.invalidate(); releaseDisplay(); } else if (ready) render(); });
  function loginMask(title, subtitle) {
    document.querySelector('.login-mask')?.remove();
    document.body.insertAdjacentHTML('beforeend', `<div class="login-mask"><div class="t">${esc(title)}</div><div class="s">${esc(subtitle)}</div><button class="btn" id="authorize">前往登录</button></div>`);
    document.querySelector('#authorize').addEventListener('click', () => authorize().catch(error => { document.querySelector('.login-mask .s').textContent = error.message; }));
  }
  async function authorize() {
    await A.authorize();
  }
  async function login() {
    const data = await A.login({ isPublic: M.parseRoute(location.hash).name === 'share' });
    if (data?.callback) {
      loginMask('已返回 TokenRank', '已收到统一登录回调，业务接口统一鉴权待接入。');
      return;
    }
    token = A.token();
    if (!token && M.parseRoute(location.hash).name === 'share') return render();
    if (!token) return;
    ready = true; document.querySelector('.login-mask')?.remove(); await render();
  }
  login().catch(error => loginMask('登录失败', error.message));
})();
