/* Public snapshots never pass through the signed-in data cache or storage. */
(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.TokenRankShare = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';
  const styles = ['usage', 'tools', 'receipt', 'daily', 'weekly', 'group-insights', 'milestone', 'calendar', 'comparison'];
  const ID = /^[0-9a-f]{24}$/;
  let config = {};
  const poster = () => root.TokenRankPoster;
  function configure(options = {}) { config = { ...config, ...options }; return api; }
  function idOf(value) { if (value?.transient || value?.private) throw new Error('群内临时 PK 仅当前页面可见，不能公开分享或下载'); const id = typeof value === 'string' ? value : value?.id; if (!ID.test(id || '')) throw new Error('分享链接无效，请重新生成'); return id; }
  function baseUrl() { const url = new URL(config.baseUrl || '/app/', root.location?.href || 'http://localhost/app/'); url.hash = ''; url.search = ''; if (url.pathname === '/') url.pathname = '/app/'; if (!/^https?:$/.test(url.protocol)) throw new Error('分享地址必须是网页链接'); return url; }
  function link(value) { const url = baseUrl(); url.hash = '/share/' + idOf(value); return url.href; }
  async function nativeRequest(path, options = {}, publicRead = false) {
    const response = await root.fetch(config.resolvePath ? config.resolvePath(path) : path, { method: options.method || 'GET', headers: { Accept: 'application/json', ...(options.body ? { 'Content-Type': 'application/json' } : {}) }, credentials: publicRead ? 'omit' : 'same-origin', cache: 'no-store', ...(options.body ? { body: JSON.stringify(options.body) } : {}) });
    let data; try { data = await response.json(); } catch { data = {}; }
    if (!response.ok) throw Object.assign(new Error(data.error || (response.status === 404 ? '分享记录已失效或已被取消，请重新生成' : `请求失败（${response.status}），请稍后再试`)), { status: response.status, statusCode: response.status, code: data.code });
    return data;
  }
  const request = (path, options) => config.request ? config.request(path, options || {}) : nativeRequest(path, options);
  async function read(value) {
    const id = idOf(value), record = await nativeRequest('/api/shares/' + id, {}, true);
    if (record.id !== id || !Number.isFinite(record.expires_at) || record.expires_at <= Date.now()) throw Object.assign(new Error('分享记录已过期，请重新生成'), { status: 404, code: 'SHARE_EXPIRED' });
    return record;
  }
  async function create(options = {}) {
    const style = options.style || 'usage'; if (!styles.includes(style)) throw new Error('不支持的分享类型');
    if (options.transient || options.private || options.opponent) throw new Error('群内临时 PK 不生成公开链接，请仅在当前页面查看');
    if (style === 'comparison') return compare(options.source_id);
    const body = { style, period: options.period || (style === 'group-insights' ? 'day' : 'all') };
    for (const key of ['group_id', 'day', 'week', 'month', 'day_snapshot', 'week_snapshot', 'calendar_snapshot', 'snapshot', 'achievement_snapshot', 'badge_id', 'rule_version', 'show_amount']) if (options[key] !== undefined) body[key] = options[key];
    if (options.milestone_id && !body.badge_id) body.badge_id = options.milestone_id;
    // Amounts are opt-in, never inherited from a private calendar response.
    delete body.show_amount;
    if (options.show_amount === true || options.display?.show_amount === true) body.show_amount = true;
    if (style === 'calendar') {
      if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(body.month || '')) throw new Error('请选择日历月份');
      const calendarBody = { style, month: body.month };
      if (body.calendar_snapshot !== undefined) calendarBody.calendar_snapshot = body.calendar_snapshot;
      if (body.show_amount === true) calendarBody.show_amount = true;
      return request('/api/shares', { method: 'POST', body: calendarBody });
    }
    if (style === 'group-insights') {
      if (!/^[a-z0-9]+$/.test(body.group_id || '')) throw new Error('请选择群榜后再分享');
      const path = '/api/groups/' + body.group_id + '/insights';
      if (body.snapshot === undefined) body.snapshot = (await request(path + '?period=' + encodeURIComponent(body.period))).snapshot;
      return request(path + '/share', { method: 'POST', body: { period: body.period, snapshot: body.snapshot } });
    }
    if (style === 'daily' && body.day_snapshot === undefined) {
      if (!body.day) throw new Error('请选择日报日期');
      body.day_snapshot = (await request('/api/my/daily?day=' + encodeURIComponent(body.day))).snapshot;
    }
    if (style === 'weekly' && body.week_snapshot === undefined) {
      const report = await request('/api/my/weekly' + (body.week ? '?week=' + encodeURIComponent(body.week) : ''));
      body.week_snapshot = report.snapshot;
      if (!body.week) body.week = report.weekly?.week_start || report.from;
    }
    if (style === 'milestone') {
      if (body.achievement_snapshot === undefined || !body.badge_id) {
        const catalogue = await request('/api/my/achievements');
        if (body.achievement_snapshot === undefined) body.achievement_snapshot = catalogue.snapshot;
        if (!body.badge_id) {
          const earned = (catalogue.families || []).flatMap(f => f.badges || []).filter(b => b.earned);
          const badge = earned.sort((a, b) => (b.priority || 0) - (a.priority || 0))[0];
          if (!badge) throw new Error('尚未解锁成就，请同步用量后查看');
          body.badge_id = badge.id;
        }
      }
    }
    // 409 is surfaced intact: never silently replace the user's reviewed snapshot.
    return request('/api/shares', { method: 'POST', body });
  }
  function revoke(value) { return request('/api/shares/' + idOf(value) + '/revoke', { method: 'POST' }); }
  function compare(value) { return request('/api/shares/' + idOf(value) + '/compare', { method: 'POST' }); }
  async function copyText(text) {
    try { if (root.navigator?.clipboard?.writeText) { await root.navigator.clipboard.writeText(text); return true; } } catch { /* Feishu webview may deny clipboard. Try native selection. */ }
    const doc = root.document;
    if (doc?.body && doc.execCommand) {
      const area = doc.createElement('textarea'); area.value = text; area.setAttribute('readonly', ''); area.setAttribute('aria-label', '分享链接'); doc.body.appendChild(area); area.select();
      let copied = false; try { copied = doc.execCommand('copy'); } finally { area.remove(); } if (copied) return true;
    }
    return false;
  }
  async function copyLink(value) { const record = await read(value), url = link(record); return { url, copied: await copyText(url) }; }
  async function share(value) {
    // Fresh anonymous validation prevents knowingly distributing revoked cards.
    const record = await read(value), url = link(record), data = { title: `Token 群排名 · ${poster()?.titles[record.style || 'usage'] || '用量快照'}`, url };
    if (root.navigator?.share) {
      try { if (!root.navigator.canShare || root.navigator.canShare(data)) { await root.navigator.share(data); return { shared: true, url }; } }
      catch (error) { if (error.name === 'AbortError') return { shared: false, cancelled: true, url }; }
    }
    return { shared: false, ...await copyLink(record) };
  }
  async function download(value, options = {}) {
    const record = await read(value); if (!poster()) throw new Error('图片模块未加载，请刷新后导出');
    const canvas = await poster().create(record, link(record), options), blob = await poster().toBlob(canvas);
    // Revalidate after asynchronous decoding/drawing so revocation never exports stale content.
    await read(record.id);
    if (options.blobOnly) return { blob, canvas };
    const url = root.URL.createObjectURL(blob), a = root.document.createElement('a');
    a.href = url; a.download = `tokenrank-${record.style || 'usage'}-${record.id}.png`; root.document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => root.URL.revokeObjectURL(url), 1000);
    return { downloaded: true };
  }
  function element(doc, tag, text, className) { const el = doc.createElement(tag); if (text !== undefined) el.textContent = text; if (className) el.className = className; return el; }
  const mounts = new WeakMap();
  function render(container, record, options = {}) {
    if (!container || !poster()) throw new Error('分享展示模块未加载');
    if (record.transient || options.transient) return renderTransient(container, record);
    if (record.expires_at !== undefined && record.expires_at <= Date.now()) { container.replaceChildren(element(container.ownerDocument || root.document, 'p', '分享记录已过期，请重新生成')); return { destroy() { container.replaceChildren(); } }; }
    const doc = container.ownerDocument || root.document, data = poster().describe(record), token = {};
    mounts.set(container, token); container.replaceChildren();
    const card = element(doc, 'section', undefined, 'os-card share-card'), title = element(doc, 'h2', data.title);
    card.append(title, element(doc, 'p', data.nickname));
    if (record.style === 'milestone') {
      const path = poster().badgePath(record.usage?.milestone);
      if (path) { const image = element(doc, 'img'); image.src = path; image.alt = record.usage.milestone.label || '已解锁奖章'; image.width = 240; image.height = 240; card.append(image); }
    }
    const dl = element(doc, 'dl');
    for (const [label, value] of data.lines) dl.append(element(doc, 'dt', label), element(doc, 'dd', value));
    card.append(dl);
    if (data.calendar) {
      const table = element(doc, 'table'), caption = element(doc, 'caption', '日历快照：未同步不等于零用量'), body = element(doc, 'tbody'); table.append(caption, body);
      for (const day of poster().calendarDays(data.calendar)) { const tr = element(doc, 'tr'); tr.append(element(doc, 'th', day.day), element(doc, 'td', poster().dayText(day, data.calendar.show_amount === true))); body.append(tr); }
      card.append(table);
    }
    const status = element(doc, 'p', '', 'share-status'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
    const actions = element(doc, 'div', undefined, 'share-actions');
    const active = () => mounts.get(container) === token && card.parentNode === container && !options.signal?.aborted && (!options.onAlive || options.onAlive());
    function button(label, fn, primary = false) {
      const b = element(doc, 'button', label, 'os-btn' + (primary ? '' : ' outline')); b.type = 'button';
      b.addEventListener('click', async () => { if (!active()) return; b.disabled = true; status.textContent = '正在处理…'; try { await fn(); } catch (error) { if (active()) { status.textContent = error.message; if ((error.status || error.statusCode) === 404) { title.textContent = '分享记录已失效'; actions.replaceChildren(); card.replaceChildren(title, status); } options.onError?.(error); } } finally { if (active()) b.disabled = false; } }); actions.append(b); return b;
    }
    function resultLink(result, success) {
      if (!active()) return;
      status.replaceChildren();
      if (result.copied || result.shared) status.textContent = success;
      else if (result.cancelled) status.textContent = '已取消系统分享';
      else { status.append(element(doc, 'span', '浏览器未允许自动复制，请长按或选择链接复制。')); const input = element(doc, 'input'); input.type = 'text'; input.value = result.url; input.readOnly = true; input.setAttribute('aria-label', '分享链接'); status.append(input); input.select(); }
    }
    if (!options.transient) {
      button('复制链接', async () => { resultLink(await copyLink(record), '链接已复制'); }, true);
      button('系统分享', async () => resultLink(await share(record), '分享已完成或链接已复制'));
      button('下载图片', async () => { await download(record); if (active()) status.textContent = '图片已生成，请在浏览器下载列表中查看'; });
      if (record.usage && !['milestone', 'calendar'].includes(record.style) && options.onCompare) button('公开 PK', async () => { const compared = await compare(record); if (active()) options.onCompare(compared); });
      if (options.owner) button('撤销分享', async () => { const approve = options.confirm ? await options.confirm('撤销后，原链接及相关公开 PK 将无法查看。') : root.confirm?.('撤销后，原链接及相关公开 PK 将无法查看。继续撤销？'); if (!approve) { status.textContent = '已保留分享'; return; } await revoke(record); if (active()) { dl.replaceChildren(); actions.replaceChildren(); title.textContent = '分享已撤销'; status.textContent = '原链接及相关公开 PK 已失效'; card.replaceChildren(title, status); options.onRevoke?.(record); } });
      card.append(element(doc, 'p', '公开快照可匿名查看；二维码打开网页，不是微信小程序码。撤销或过期后链接失效。'));
    }
    card.append(actions, status); container.append(card);
    return { destroy() { if (active()) { mounts.delete(container); container.replaceChildren(); } } };
  }
  async function mountRoute(container, value, options = {}) {
    const token = {}; mounts.set(container, token); container.replaceChildren(element(container.ownerDocument || root.document, 'p', '正在读取公开快照…'));
    const alive = () => mounts.get(container) === token && !options.signal?.aborted && (!options.onAlive || options.onAlive());
    try { if (!alive()) return null; const record = await read(value); if (!alive()) return null; return render(container, record, options); }
    catch (error) { if (alive()) { container.replaceChildren(element(container.ownerDocument || root.document, 'p', error.message)); options.onError?.(error); } return null; }
  }
  function renderTransient(container, data) {
    // Only self and aggregate numbers. Never retain, encode, export or publish the
    // transient opponent's identity/avatar/profile, even if the caller passes it.
    const doc = container.ownerDocument || root.document; mounts.delete(container);
    const own = data?.usage?.summary?.tokens, peer = data?.comparison?.source?.usage?.summary?.tokens;
    data = { self_tokens: data?.self_tokens ?? own, difference_tokens: data?.difference_tokens ?? (Number.isFinite(own) && Number.isFinite(peer) ? own - peer : undefined) };
    const card = element(doc, 'section', undefined, 'os-card'); card.append(element(doc, 'h2', '群内临时 PK'), element(doc, 'p', '仅当前页面可见，不生成公开链接或图片。'), element(doc, 'p', `我的用量：${Number.isFinite(data?.self_tokens) ? data.self_tokens.toLocaleString('zh-CN') : '暂无记录'} tokens`), element(doc, 'p', `用量差值：${Number.isFinite(data?.difference_tokens) ? data.difference_tokens.toLocaleString('zh-CN') : '暂无可比数据'} tokens`)); container.replaceChildren(card);
  }
  const api = { configure, styles, create, read, revoke, compare, link, copyLink, share, download, render, mountRoute, renderTransient };
  return api;
});
