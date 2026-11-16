/* Token 群排名 · 飞书网页应用；原生路由、只读数据页。 */
(() => {
  'use strict';
  const M = window.TokenRankModel, page = document.querySelector('#page');
  const $ = selector => page.querySelector(selector);
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const full = value => Math.max(0, Number(value) || 0).toLocaleString('en-US', { maximumFractionDigits: 2 });
  const fmt = value => Number(value) >= 1e8 ? (value / 1e8).toFixed(2) + ' 亿' : Number(value) >= 1e4 ? (value / 1e4).toFixed(2).replace(/\.?0+$/, '') + ' 万' : full(value);
  let token = localStorage.getItem('tr_token') || '', route, current, user, ready = false, force = false;
  const guard = M.createGuard();
  async function request(path) {
    const sentWith = token;
    const response = await fetch(path, { headers: sentWith ? { authorization: 'Bearer ' + sentWith } : {}, cache: 'no-store' });
    const data = await response.json();
    if (sentWith !== token) throw Object.assign(new Error('账号已变化'), { stale: true });
    if (!response.ok) {
      if (response.status === 401) {
        token = ''; localStorage.removeItem('tr_token'); cache.clear(); guard.invalidate(); ready = false;
        loginMask('登录已过期', '请重新通过飞书授权登录');
      }
      throw Object.assign(new Error(data.error || '加载失败，请稍后重试'), { status: response.status, code: data.code });
    }
    return data;
  }
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
  const robotNote = () => note('网页暂不生成分享卡片。需要在飞书交流用量，请单聊机器人发送「我的」，或在群里发送「榜单」。');
  function analysisBlock(data) {
    if (!data) return empty('分析暂不可用，请刷新后重试');
    const rows = data.items || [];
    const daily = data.daily || [];
    const max = Math.max(1, ...daily.map(d => d.tokens || 0));
    return `<div class="caption">${Number.isFinite(data.summary?.users) ? full(data.summary.users) + ' 位用户 · ' : ''}${data.from && data.to ? esc(data.from) + ' — ' + esc(data.to) + ' · ' : ''}仅代表已上报数据</div>
      ${daily.length ? `<div class="bars analysis-bars" aria-label="每日 Token 用量">${daily.map(d => `<div class="bar-col" title="${esc(d.day)} · ${d.reported ? full(d.tokens) + ' tokens' : '未同步'}"><span class="v">${d.reported ? fmt(d.tokens) : '—'}</span><div class="bar-fill" style="height:${d.reported ? Math.max(1, (d.tokens || 0) / max * 100) : 0}%"></div><span class="k">${esc(d.day?.slice(5))}</span></div>`).join('')}</div>` : ''}
      ${rows.map(row => `<div class="dist"><div class="head"><span class="name">${esc(row.name)}</span><span class="pct num">${Number(row.percent || 0).toFixed(1)}%</span></div><div class="bar"><i style="width:${Math.max(0, Math.min(100, row.percent || 0))}%"></i></div><div class="meta"><span>${fmt(row.tokens)} tokens${Number(row.credits) > 0 ? ' · ' + full(row.credits) + ' Credits' : ''}</span><span>${Number.isFinite(row.users) ? full(row.users) + ' 人用过' : ''}</span></div></div>`).join('') || empty('该周期暂无分项记录；接入电脑并同步后可查看工具与模型分布')}`;
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
    function row(entry, mine = false) {
      return `<div class="row ${mine ? 'me' : ''}"><span class="rank num">${esc(entry.rank)}</span>${avatar(entry)}<div class="who"><div class="nick">${esc(entry.nickname || (mine ? user?.nickname : '') || '未命名')}${mine ? ' · 我' : ''}</div><div class="sub">${esc([entry.top_tool, entry.top_model].filter(Boolean).join(' · ') || (!entry.tokens && !entry.credits ? '尚未上报' : '已记录用量'))}</div><div class="sub alt">${credit ? fmt(entry.tokens) + ' tokens' : Number(entry.credits) > 0 ? full(entry.credits) + ' Credits' : ''}</div></div><span class="amt num">${credit ? full(entry.credits) : fmt(entry.tokens)}</span></div>`;
    }
    return `<div class="list-header"><span>${full(board.total)} 人 · ${credit ? 'Credits 用量' : 'Token 用量'}</span><span>已显示 ${board.entries.length} 人</span></div>${board.entries.map(e => row(e, e.rank === board.me?.rank)).join('') || empty('本期暂无上报成员；请通过飞书机器人加入群榜并接入电脑')}${board.me ? row({ ...board.me, nickname: user?.nickname, avatar_url: user?.avatar_url }, true) : note('本期暂无我的公开排名，可通过机器人查看加入或显示状态')}
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
    if (!data.board) { $('#body').innerHTML = prefix + empty('需先加入群榜并完善昵称头像。请在飞书群发送「加入」，单聊机器人查看账号接入状态。'); return; }
    if (route.name === 'group-analysis') {
      const report = data.insights;
      $('#body').innerHTML = prefix + (report ? hero(report, '群公开成员用量') + `<div class="caption">${full(report.summary?.active_users)} 人活跃 · ${full(report.summary?.reported_users)} 人已上报 · 隐藏成员不纳入统计</div>` + stats(report) + dimensions() + analysisBlock(report[route.dimension]) : empty(data.insights_error || '群分析暂不可用，请刷新后重试')) + robotNote();
    } else {
      $('#body').innerHTML = prefix + `<div class="links">${link({ ...route, name: 'group-analysis' }, '群数据分析')}</div>` + metricTabs() + '<div id="board"></div>' + robotNote();
      const board = route.metric === 'credits' ? await read(M.boardPath(route)) : data.board;
      if (alive()) mountBoard(M.mergeBoard(null, board), alive);
    }
  }
  async function square(alive) {
    page.innerHTML = heading('广场排名') + periodTabs() + tabs([['sum', '双榜'], ['analysis', '分析']], route.view === 'analysis' ? 'analysis' : 'sum', 'view') + '<div id="body">' + empty('加载广场…') + '</div>';
    if (route.view === 'analysis') {
      const bundle = await read('/api/insights?period=' + route.period + '&dimension=tools&bundle=1');
      let data = bundle[route.dimension];
      if (!data) data = route.dimension === 'tools' ? bundle : await read('/api/insights?period=' + route.period + '&dimension=models');
      if (alive()) $('#body').innerHTML = dimensions() + analysisBlock(data) + note('Credits 为工具自报积分；未覆盖的分项不按零费用解释。');
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
      const data = bundle[route.dimension] || (route.dimension === 'tools' ? bundle : await read('/api/my/analysis?period=' + route.period + '&dimension=models'));
      if (alive()) $('#body').innerHTML = dimensions() + analysisBlock(data);
      return;
    }
    if (route.view === 'cal') return calendar(alive);
    if (route.view === 'daily') return daily(alive);
    if (route.view === 'trend') return weekly(alive);
    const data = await read('/api/my/overview?period=' + route.period);
    if (!alive()) return;
    user = data.user;
    $('#body').innerHTML = syncBlock(user) + (data.usage ? hero(data.usage, '我的用量') + `<div class="stats"><div><div class="v num">${full(data.usage.activity?.active_days)} 天</div><div class="k">活跃天数</div></div><div><div class="v num">${full(data.usage.activity?.current_streak)} 天</div><div class="k">连续记录</div></div></div>` + stats(data.usage) : empty(data.usage_error?.error || '用量暂不可用，请刷新后重试')) + `<div class="links">${link({ name: 'achievements' }, '成就图鉴')}${link({ name: 'groups', period: route.period === 'all' ? 'day' : route.period }, '我的群榜')}</div>` + robotNote();
  }
  async function daily(alive) {
    const day = route.day || M.shiftDay(M.beijingDay(), -1);
    const data = await read('/api/my/daily?day=' + day);
    if (!alive()) return;
    $('#body').innerHTML = dateNav(data.previous_day, data.next_day, 'day', day) + `<div class="caption">选择日期 <input class="date-pick" id="daily-date" type="date" value="${day}" max="${M.shiftDay(M.beijingDay(), -1)}" aria-label="日报日期"></div>` + (data.has_history ? hero(data, day) + stats(data) + analysisBlock({ items: data.tools }) + analysisBlock({ items: data.models }) : empty('这一天没有同步记录；未同步不代表零用量或零费用')) + note('日报只展示已结束的自然日 · 北京时间');
    $('#daily-date').addEventListener('change', event => { if (M.validDay(event.target.value) && event.target.value < M.beijingDay()) patch({ day: event.target.value }); });
  }
  async function calendar(alive) {
    const month = route.month || M.beijingDay().slice(0, 7);
    const data = await read('/api/my/calendar?month=' + month);
    if (!alive()) return;
    const map = M.heatmap(data);
    $('#body').innerHTML = dateNav(data.previous_month, data.next_month, 'month', month) + `<div class="caption">${esc(map.from)} — ${esc(map.to)} · 北京时间 · ${map.extended ? '近13周' : '本月'}</div><div class="heatmap-scroll"><div class="heatmap" style="--weeks:${Math.ceil(map.days.length / 7)}">${map.days.map(day => `<button class="heat-cell level-${day.level} ${day.outside ? 'outside' : ''} ${day.future ? 'future' : ''}" data-calendar-day="${esc(day.day)}" ${day.outside || day.future ? 'disabled' : ''} aria-label="${esc(day.day + ' · ' + day.statusText + (day.reported ? ' · ' + full(day.tokens) + ' tokens' : ''))}" title="${esc(day.day + ' · ' + day.statusText)}"><span>${Number(day.day.slice(-2))}</span></button>`).join('')}</div></div><div class="caption">颜色深浅表示 Token 用量；空白表示未同步或范围外，已同步零用量会单独标注。</div><div id="day-detail" aria-live="polite"></div>`;
    function select(day) {
      const c = M.costView(day.details?.cost || day.cost);
      $('#day-detail').innerHTML = `<div class="section"><span class="t">${esc(day.day)}</span><span>${esc(day.statusText)}</span></div><div class="hero"><div class="full">${day.reported ? full(day.tokens) + ' tokens' : '暂无用量记录'}</div><div class="full">${esc(c.label)} · ${esc(c.amount)}${c.available ? ' USD' : ''}</div><div class="full">${esc(c.note)} · 非实际账单</div></div>${day.reported && day.day < data.today ? `<div class="links">${link({ ...route, view: 'daily', day: day.day }, '查看当日日报')}</div>` : note(day.day === data.today ? '今天进行中，结束后可查看日报' : '未同步日期不按零用量或零费用统计')}`;
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
    const comparison = w.comparison_status === 'comparable' ? `较上期 ${w.change_tokens >= 0 ? '+' : ''}${w.change_percent}% · 上期 ${fmt(w.previous_tokens)} tokens` : w.comparison_status === 'ongoing' ? '本周进行中，暂不比较' : '上期数据不足，暂无可比';
    $('#body').innerHTML = dateNav(data.previous_week, data.next_week, 'week', data.from + ' — ' + data.to) + hero(data, '周走势') + `<div class="caption">${esc(comparison)} · ${full(w.reported_days)}/7 天有记录</div><div class="bars">${data.daily.map(d => `<div class="bar-col" title="${esc(d.day + ' · ' + (d.future ? '未到日期' : d.reported ? full(d.tokens) + ' tokens' : '未同步'))}"><span class="v">${d.reported ? fmt(d.tokens) : '—'}</span><div class="bar-fill" style="height:${d.future || !d.reported ? 0 : Math.max(1, (d.tokens || 0) / max * 100)}%"></div><span class="k">${esc(d.day.slice(5))}</span></div>`).join('')}</div>` + stats(data) + note('走势按北京时间自然日；未同步不视为零用量');
  }
  async function achievements(alive) {
    page.innerHTML = heading('成就图鉴', true) + '<div id="body">' + empty('加载成就图鉴…') + '</div>';
    const catalogue = await read('/api/my/achievements');
    if (!alive()) return;
    const family = catalogue.families.find(f => f.id === route.family);
    if (route.family && !family) { $('#body').innerHTML = empty('该成就不存在，请返回图鉴重新选择'); return; }
    if (family) {
      const badges = family.badges || [], badge = badges.find(b => b.id === route.badge) || [...badges].reverse().find(b => b.earned) || badges[0];
      $('#body').innerHTML = `<div class="section"><span class="t">${esc(family.label)}</span><span>${family.enabled ? '已达成 ' + badges.filter(b => b.earned).length + '/' + badges.length : '暂未开放'}</span></div>${badge ? `<img class="badge-detail ${badge.earned ? '' : 'locked'}" src="${esc(M.badgeArt(badge))}" alt="${esc(badge.label)}"><div class="badge-info"><h2>${esc(badge.label)} · ${fmt(badge.threshold)} ${esc(badge.unit)}</h2><p>${esc(badge.metric_label)}：${fmt(badge.current)} ${esc(badge.unit)}</p><progress max="${badge.threshold}" value="${Math.min(badge.threshold, Math.max(0, badge.current))}" aria-label="达成进度"></progress><p>${badge.earned ? '已达成 · ' + esc(badge.achieved_day || '') : '未达成 · 还差 ' + fmt(Math.max(0, badge.threshold - badge.current)) + ' ' + esc(badge.unit)}</p></div><div class="tier-list">${badges.map(b => link({ ...route, badge: b.id }, `${b.tier} 阶 · ${fmt(b.threshold)} ${b.unit} · ${b.earned ? '已达成' : '未达成'}`, 'tier')).join('')}</div>` : empty(family.metric_label || '指标尚未接入，暂未开放')}` + note('网页成就图鉴仅供查看，不领取、不标记已展示，也不触发解锁播放');
    } else {
      $('#body').innerHTML = `<div class="caption">已达成 ${full(catalogue.earned_count)} 枚 · ${esc(catalogue.as_of)} · 北京时间</div><div class="badge-grid">${catalogue.families.map(f => {
        const badge = [...(f.badges || [])].reverse().find(b => b.earned) || f.badges?.[0] || f;
        return `<a href="${esc(M.routeHash({ name: 'achievements', family: f.id }))}" class="badge-tile"><img src="${esc(M.badgeArt(badge))}" class="${f.badges?.some(b => b.earned) ? '' : 'locked'}" alt=""><strong>${esc(f.label)}</strong><span>${f.enabled ? f.badges.filter(b => b.earned).length + ' / ' + f.badges.length : '暂未开放'}</span></a>`;
      }).join('')}</div>` + note('成就按已上报数据计算，仅展示进度；未接入产出数据的成就不会虚构达成。');
    }
  }
  async function help() {
    page.innerHTML = heading('使用说明') + `<div class="help"><h3>接入电脑</h3><p>在飞书单聊机器人发送「绑定」，或在这里获取专属安装命令。命令含接入凭证，请勿公开转发。</p><button class="btn" id="getcmd">获取接入命令</button><div id="cmd" aria-live="polite"></div><h3>群内命令</h3><p><b>加入</b>：上榜本群<br><b>榜单 [今日|本周|本月|总榜]</b>：查看群排名<br><b>隐藏 / 显示 / 退出</b>：管理我的排名</p><h3>单聊命令</h3><p><b>绑定</b>：接入电脑　<b>我的</b>：个人用量　<b>榜单</b>：广场榜</p><h3>统计与分享</h3><p>总用量含缓存，按北京时间自然日统计。用量来自个人电脑上报，仅供交流参考，不等同厂商账单。不上传代码、对话内容、提示词、项目名和文件路径。网页暂不生成分享卡片，请使用飞书机器人查询用量后在群内交流。</p><button class="btn ghost" id="logout">退出登录</button></div>`;
    const alive = current;
    $('#getcmd').addEventListener('click', async event => {
      const button = event.currentTarget; button.disabled = true;
      try {
        // Credentials deliberately bypass the shared read cache.
        const data = await request('/api/connect/token');
        if (!alive()) return;
        $('#cmd').innerHTML = `<h3>macOS / Linux</h3><code class="cmd">${esc(data.install_command || '安装命令暂不可用，请单聊机器人发送「绑定」')}</code><h3>Windows PowerShell</h3><code class="cmd">${esc(data.install_command_windows || 'Windows 安装命令暂不可用，请联系管理员')}</code>`;
      } catch (error) { if (alive()) showError(error); }
      finally { if (alive()) button.disabled = false; }
    });
    $('#logout').addEventListener('click', () => { token = ''; localStorage.removeItem('tr_token'); cache.clear(); guard.invalidate(); ready = false; loginMask('已退出登录', '重新授权后可查看群榜与个人用量'); });
  }
  function showError(error) {
    if (error.stale || error.status === 401) return;
    const toast = document.querySelector('#toast'); toast.textContent = error.message; toast.hidden = false;
    clearTimeout(showError.timer); showError.timer = setTimeout(() => { toast.hidden = true; }, 4000);
  }
  async function render() {
    if (!ready) return;
    route = M.parseRoute(location.hash); current = guard.next(); const alive = current;
    document.querySelectorAll('.tabbar button').forEach(button => {
      const active = button.dataset.tab === (route.name.startsWith('group') ? 'groups' : route.name === 'achievements' ? 'me' : route.name);
      button.classList.toggle('active', active); button.setAttribute('aria-current', active ? 'page' : 'false');
    });
    try { await ({ groups, group, 'group-analysis': group, square, me, achievements, help })[route.name](alive); }
    catch (error) { if (alive() && !error.stale && error.status !== 401) page.insertAdjacentHTML('beforeend', `<div role="alert" class="empty">${esc(error.message)}<button class="btn ghost" data-refresh>重新加载</button></div>`); }
    finally { if (alive()) force = false; }
  }
  page.addEventListener('click', event => {
    const button = event.target.closest('button'); if (!button) return;
    if (button.hasAttribute('data-set')) patch({ [button.dataset.set]: button.dataset.value });
    if (button.hasAttribute('data-back')) {
      // App-owned history supports browser back; a direct deep link gets a deterministic parent.
      if (history.state?.trApp) history.back(); else go(M.parentRoute(route));
    }
    if (button.hasAttribute('data-refresh')) { force = true; cache.clear(); render(); }
  });
  document.querySelectorAll('.tabbar button').forEach(button => button.addEventListener('click', () => go({ name: button.dataset.tab })));
  addEventListener('hashchange', render);
  function loginMask(title, subtitle) {
    document.querySelector('.login-mask')?.remove();
    document.body.insertAdjacentHTML('beforeend', `<div class="login-mask"><div class="t">${esc(title)}</div><div class="s">${esc(subtitle)}</div><button class="btn" id="authorize">通过飞书登录</button></div>`);
    document.querySelector('#authorize').addEventListener('click', () => authorize().catch(error => { document.querySelector('.login-mask .s').textContent = error.message; }));
  }
  async function authorize() {
    const config = await fetch('/api/feishu/session', { cache: 'no-store' }).then(r => r.json());
    if (!config.app_id || !config.authorize_url) throw new Error('飞书登录服务未配置，请联系管理员');
    const nonce = M.oauthState(crypto); sessionStorage.setItem('tr_oauth_state', nonce);
    sessionStorage.setItem('tr_oauth_route', location.hash || '#/groups');
    const url = new URL(config.authorize_url); url.searchParams.set('state', nonce); location.assign(url.href);
  }
  async function login() {
    const q = new URLSearchParams(location.search);
    if (q.has('code') || q.has('error')) {
      const valid = M.consumeOAuthState(sessionStorage, q.get('state'));
      const saved = sessionStorage.getItem('tr_oauth_route'); sessionStorage.removeItem('tr_oauth_route');
      history.replaceState(null, '', '/app/' + (saved?.startsWith('#/') ? saved : '#/groups'));
      if (!valid) throw new Error('授权 state 校验失败，请重新通过飞书登录');
      if (!q.get('code') || q.has('error')) throw new Error('飞书授权未完成，请重新登录');
      const response = await fetch('/api/feishu/session', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: q.get('code') }) });
      const data = await response.json();
      if (!response.ok || !data.token) throw new Error(data.error || '飞书登录失败，请重新授权');
      token = data.token; user = data.user; localStorage.setItem('tr_token', token); cache.clear();
    }
    if (!token) return loginMask('Token 群排名', '使用飞书账号查看群榜和个人用量');
    ready = true; document.querySelector('.login-mask')?.remove(); await render();
  }
  login().catch(error => loginMask('登录失败', error.message));
})();
