/* Browser poster renderer. QR encodes a public web URL, never a WeChat code. */
(function (root, factory) {
  const value = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = value;
  else root.TokenRankPoster = value;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';
  const titles = { usage: '个人用量', tools: 'AI 工具', receipt: '费用小票', daily: '用量日报', weekly: '用量周报', 'group-insights': '群分析', milestone: '我的成就', calendar: '用量日历', comparison: '公开 PK' };
  const number = value => typeof value === 'number' && Number.isFinite(value) ? value.toLocaleString('zh-CN') : '暂无记录';
  function cost(cost) {
    const available = cost && cost.status !== 'unavailable' && Number.isSafeInteger(cost.usd_micros) && cost.usd_micros >= 0;
    const notes = [cost?.unpriced_count || cost?.unpriced_models?.length ? `${cost.unpriced_count || cost.unpriced_models.length} 个模型未计价` : '', cost?.missing_days ? `${cost.missing_days} 天金额未同步` : '', cost?.missing_user_days ? `${cost.missing_user_days} 条成员记录金额未同步` : ''].filter(Boolean);
    return [available ? '$' + (cost.usd_micros / 1e6).toFixed(4) : '暂无费用记录', available ? cost.status === 'partial' ? '已计价部分 · API 等值估算' : 'API 等值估算（非实际账单）' : '请同步金额数据后查看', ...notes];
  }
  function describe(record) {
    const style = record.style || 'usage', u = style === 'group-insights' ? record.report || {} : record.usage || {};
    const s = u.summary || {}, lines = [], detail = u.calendar || record.calendar || u;
    const add = (label, value) => lines.push([label, String(value)]);
    add('统计日期', [u.from || detail.month, u.to].filter(Boolean).join(' — ') || '暂无日期');
    if (style === 'receipt') { const c = cost(u.cost); add(c[1], c[0]); c.slice(2).forEach(n => add('计价覆盖', n)); }
    else if (style === 'milestone') { const m = u.milestone || {}; add('已解锁成就', m.label || '成就'); add(m.metric_label || '累计进度', `${number(m.current)} ${m.unit || ''}`); if (m.achieved_day) add('达成日期', m.achieved_day); }
    else { add('总用量 · 含缓存', number(s.tokens) + ' tokens'); add('调用次数', number(s.requests)); }
    if (s.active_days !== undefined) add('活跃天数', number(s.active_days));
    if (style === 'daily') for (const key of ['input_tokens', 'output_tokens', 'cache_read', 'cache_write']) add(({ input_tokens: '输入', output_tokens: '输出', cache_read: '缓存读取', cache_write: '缓存写入' })[key], number(s[key]));
    if (style === 'weekly') { const w = u.weekly || {}; add('上期比较', w.comparison_status === 'comparable' && Number.isFinite(w.change_percent) ? `${w.change_percent > 0 ? '+' : ''}${w.change_percent}%` : ({ zero_base: '上期为零，无法计算百分比', no_previous: '暂无上期记录' })[w.comparison_status] || '记录不足，暂无可比数据'); if (w.peak) add('用量峰值', `${w.peak.day || ''} · ${number(w.peak.tokens)} tokens`); add('报告覆盖', `${number(w.reported_days)} 天已同步${w.complete === false ? ' · 本周尚未结束' : ''}`); }
    const tools = Array.isArray(u.tools) ? u.tools : u.tools?.items || u.tools?.categories || u.tools?.entries || [];
    if (['tools', 'usage', 'daily', 'weekly', 'group-insights'].includes(style)) tools.slice(0, style === 'tools' ? 5 : 2).forEach(t => add(t.name || '未分类', `${number(t.tokens)} tokens${Number.isFinite(t.percent) ? ` · ${t.percent}%` : ''}`));
    if (style === 'group-insights') { add('群榜', u.group?.name || '群分析'); add('统计范围', '当前公开成员汇总，不含隐身成员'); add('活跃成员', number(s.active_users)); const c = cost(u.cost); add(c[1], c[0]); c.slice(2).forEach(n => add('计价覆盖', n)); }
    if (style === 'calendar') { if (detail.show_amount === true) { const c = cost(detail.cost || detail.summary?.cost || detail.heatmap?.details?.cost || u.cost); add(c[1], c[0]); c.slice(2).forEach(n => add('计价覆盖', n)); } add('日历说明', '未同步不等于零用量；未来日期不计入'); }
    if (style === 'comparison') { const other = record.comparison?.source; add('对比对象（公开快照）', other?.user?.nickname || '公开分享者'); add('对方同口径用量', number(other?.usage?.summary?.tokens) + ' tokens'); if (Number.isFinite(s.tokens) && Number.isFinite(other?.usage?.summary?.tokens)) add('用量差值', number(s.tokens - other.usage.summary.tokens) + ' tokens'); }
    if (u.standing && style === 'usage') add('全站排名', u.standing.rank ? `第 ${u.standing.rank} 名` : '未参与公开排名');
    return { title: titles[style] || titles.usage, nickname: record.user?.nickname || (style === 'group-insights' ? u.group?.name : 'AI 玩家') || 'Token 群排名', lines, calendar: style === 'calendar' ? detail : null };
  }
  // Do not request arbitrary cross-origin avatars. Same-origin images are decoded
  // from a fetched blob; failure uses initials, never a tainted export canvas.
  async function avatar(url) {
    if (!url || !root.location || !root.Image) return null;
    let parsed; try { parsed = new URL(url, root.location.href); } catch { return null; }
    if (parsed.origin !== root.location.origin || !/^https?:$/.test(parsed.protocol)) return null;
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 4000);
    let objectUrl;
    try {
      const res = await root.fetch(parsed.href, { credentials: 'omit', cache: 'no-store', signal: controller.signal, redirect: 'error' });
      if (!res.ok || !/^image\/(png|jpeg|webp|gif)(?:;|$)/i.test(res.headers.get('content-type') || '')) return null;
      const blob = await res.blob(); if (blob.size > 2e6) return null;
      objectUrl = root.URL.createObjectURL(blob);
      return await new Promise(resolve => { const image = new root.Image(); image.onload = () => resolve(image); image.onerror = () => resolve(null); controller.signal.addEventListener('abort', () => { image.src = ''; resolve(null); }, { once: true }); image.src = objectUrl; });
    } catch { return null; } finally { clearTimeout(timer); if (objectUrl) root.URL.revokeObjectURL(objectUrl); }
  }
  function badgePath(badge) {
    const stages = { requests: ['code-leaves', [100, 1000, 10000, 100000], 3], models: ['neural-core', [1, 3, 5, 10], 2], tools: ['linked-loops', [2, 3, 5, 8], 1], active: ['steady-flame', [3, 7, 30, 100], 2], uploads: ['upload-calendar', [3, 7, 30, 100], 2], peak: ['milestone-peaks', [1e8, 5e8, 1e9, 5e9], 3], total: ['usage-orbit', [1e8, 1e9, 1e10, 1e11], 3] };
    const allowed = ['terminal', 'code-leaves', 'neural-core', 'linked-loops', 'build-modules', 'release-plane', 'value-bridge', 'impact-beacon', 'steady-flame', 'upload-calendar', 'milestone-peaks', 'usage-orbit'];
    if (!allowed.includes(badge?.art)) return null;
    const stage = stages[badge.family], index = stage?.[0] === badge.art ? stage[1].indexOf(badge.threshold) + 1 : 0;
    const path = '/app/assets/badges/' + (index && index !== stage[2] ? `tiers/${badge.art}-${index}` : badge.art) + '.png';
    return root.TokenRankAuth?.path ? root.TokenRankAuth.path(path) : path;
  }
  function calendarDays(calendar) {
    if (!calendar?.daily?.length) return calendar?.heatmap?.daily || [];
    const details = new Map((calendar.heatmap?.daily || []).map(day => [day.day, day.details]));
    return calendar.daily.map(day => ({ ...day, details: day.details || details.get(day.day) }));
  }
  function dayText(day, amounts = false) {
    const status = day.future ? '未来日期' : !day.reported ? '未同步' : day.tokens === 0 ? '已同步 · 零用量' : `${number(day.tokens)} tokens`;
    return status + (amounts && day.reported && !day.future ? ' · ' + cost(day.details?.cost || day.cost)[0] : '');
  }
  function drawQR(ctx, url, x, y, size, encoder = root.qrcode) {
    if (typeof encoder !== 'function') throw new Error('二维码库未加载，请刷新页面后导出');
    const qr = encoder(0, 'M'); qr.addData(url); qr.make();
    const count = qr.getModuleCount(), cell = Math.floor(size / (count + 8)), extent = (count + 8) * cell;
    if (cell < 1) throw new Error('分享链接过长，无法生成二维码');
    ctx.fillStyle = '#ffffff'; ctx.fillRect(x, y, extent, extent); ctx.fillStyle = '#111111';
    for (let r = 0; r < count; r++) for (let c = 0; c < count; c++) if (qr.isDark(r, c)) ctx.fillRect(x + (c + 4) * cell, y + (r + 4) * cell, cell, cell);
    return extent;
  }
  async function create(record, url, options = {}) {
    const doc = options.document || root.document; if (!doc) throw new Error('当前环境无法生成图片');
    if (record.transient || record.private) throw new Error('群内临时 PK 不生成公开图片');
    const data = describe(record), canvas = doc.createElement('canvas');
    const days = calendarDays(data.calendar), milestone = record.usage?.milestone;
    const badge = record.style === 'milestone' ? await avatar(badgePath(milestone)) : null;
    if (record.style === 'milestone' && !badge) throw new Error('奖章图片未加载，请刷新后导出或复制链接');
    canvas.width = 1000; canvas.height = Math.max(1400, 660 + data.lines.length * 85 + (days.length ? 70 + Math.ceil(days.length / 7) * 76 : 0) + (badge ? 430 : 0));
    const ctx = canvas.getContext('2d'); if (!ctx) throw new Error('当前浏览器不支持 Canvas 图片，请复制链接');
    // Paper/ink palette mirrors miniprogram/utils/usage-poster.js.
    const C = options.theme === 'ink' ? { bg: '#222c27', ink: '#f5edda', soft: '#b2b9a8', accent: '#d2b677', rule: '#526052' } : { bg: '#f7f3e9', ink: '#252c26', soft: '#727467', accent: '#a8392d', rule: '#d8d1c1' };
    ctx.fillStyle = C.bg; ctx.fillRect(0, 0, canvas.width, canvas.height);
    function text(value, x, y, size = 28, color = C.ink, max = 872) { ctx.fillStyle = color; ctx.font = `500 ${size}px system-ui, sans-serif`; let s = String(value); while (ctx.measureText(s).width > max && s.length > 1) s = s.slice(0, -2) + '…'; ctx.fillText(s, x, y); }
    text('Token 群排名', 64, 66, 26); text(data.title, 64, 138, 48, C.accent);
    const image = options.skipAvatar ? null : await avatar(record.user?.avatar_url);
    if (image) { ctx.save(); ctx.beginPath(); ctx.arc(104, 208, 40, 0, 2 * Math.PI); ctx.clip(); ctx.drawImage(image, 64, 168, 80, 80); ctx.restore(); }
    else { ctx.fillStyle = C.rule; ctx.beginPath(); ctx.arc(104, 208, 40, 0, 2 * Math.PI); ctx.fill(); text([...data.nickname][0] || 'T', 84, 222, 36); }
    text(data.nickname, 166, 222, 32, C.ink, 770);
    let y = 304;
    if (badge) { ctx.drawImage(badge, 290, y, 420, 420); y += 450; }
    if (record.style === 'receipt') { ctx.fillStyle = C.rule; ctx.fillRect(64, y - 26, 872, 2); text('API 等值估算 · 非实际账单', 64, y + 8, 26, C.accent); y += 60; }
    for (const [label, value] of data.lines) {
      text(label, 64, y, 22, C.soft); text(value, 64, y + 44, label.includes('总用量') || record.style === 'receipt' && value.startsWith('$') ? 46 : 30); y += 85;
      if (record.style === 'receipt') { ctx.fillStyle = C.rule; ctx.fillRect(64, y - 18, 872, 1); }
    }
    if (record.style === 'tools' || record.style === 'group-insights') {
      const tools = record.report?.tools?.items || record.usage?.tools || [];
      const rows = Array.isArray(tools) ? tools.slice(0, 5) : tools.items?.slice(0, 5) || [];
      // Replace text-only tool rows with proportional, labelled distribution bars.
      rows.forEach((tool, i) => { const width = Math.max(0, Math.min(100, Number(tool.percent) || 0)) * 8.72; ctx.fillStyle = C.accent; ctx.fillRect(64, 300 + (data.lines.length - rows.length + i) * 85 + 58, width, 6); });
    }
    if (days.length) {
      text('日历 · 按日期顺序', 64, y + 10, 24, C.soft); y += 36;
      days.forEach((d, i) => { const x = 64 + i % 7 * 124, top = y + Math.floor(i / 7) * 76; text(String(d.day || '').slice(5), x, top, 18); text(d.future ? '未来' : d.reported ? d.tokens === 0 ? '零用量' : number(d.tokens) : '未同步', x, top + 25, 15, C.soft, 116); if (data.calendar.show_amount === true && d.reported && !d.future) text(cost(d.details?.cost || d.cost)[0], x, top + 48, 13, C.soft, 116); });
    }
    const bottom = canvas.height - 280;
    drawQR(ctx, url, 676, bottom, 250, options.qrcode || root.qrcode);
    text('扫码打开网页快照', 64, bottom + 68, 26); text('网页二维码 · 非微信小程序码', 64, bottom + 112, 21, C.soft, 580);
    text('北京时间 · 上游总量（含缓存）', 64, bottom + 160, 21, C.soft, 580);
    text('内容为创建时快照，撤销或过期后不可查看', 64, bottom + 202, 20, C.soft, 580);
    return canvas;
  }
  function toBlob(canvas) { return new Promise((resolve, reject) => { try { canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('图片导出失败，请复制链接')), 'image/png'); } catch { reject(new Error('图片无法导出，请复制链接；外部头像已停用')); } }); }
  return { titles, describe, cost, drawQR, create, toBlob, avatar, badgePath, calendarDays, dayText };
});
