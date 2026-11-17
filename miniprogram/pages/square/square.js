const api = require('../../utils/api');
const flow = require('../../utils/flow');
const { presentEntries, presentMe } = require('../../utils/leaderboard');
const { presentAnalysis } = require('../../utils/analytics');
Page({
  data: { periods: flow.PERIODS, period: 'day', periodIndex: 0, metric: 'tokens', entries: [], me: null, user: null,
    loading: true, refreshing: false, refreshError: '', error: '', updated_fmt: '',
    total: null, hasMore: false, nextOffset: null, snapshot: '', loadingMore: false, moreError: '', mode: 'ranking', insights: null },
  onShow() { this._visible = true; return this.load(); },
  onHide() { this._visible = false; this._requestId = (this._requestId || 0) + 1; this.setData({ loadingMore: false, refreshing: false }); },
  onReachBottom() { if (!this.data.moreError) return this.loadMore(); },
  onUnload() { this.onHide(); },
  async onPullDownRefresh() { try { await this.refresh(); } finally { wx.stopPullDownRefresh(); } },
  refresh() { return this.load({ force: true }); },
  queryKey() { return [this.data.period, this.data.mode, this.data.mode === 'ranking' ? this.data.metric : '', api.accountEpoch()].join(':'); },
  startLoad(key) {
    const keep = this._displayKey === key;
    if (!keep) this._displayKey = '';
    this.setData({ loading: !keep, refreshing: keep, error: '', refreshError: '', loadingMore: false, moreError: '',
      ...(!keep ? { entries: [], me: null, insights: null, total: null, hasMore: false, nextOffset: null, snapshot: '', updated_fmt: '' } : {}) });
    return keep;
  },
  loadFailed(err, keep) {
    const message = err.message || '数据暂不可用，请重试';
    this.setData({ loading: false, refreshing: false, ...(keep ? { refreshError: message } : { error: message }) });
  },
  present(entries) { return presentEntries(entries, this.data.me, this.data.metric); },
  showBoard(lb) {
    const key = this.queryKey();
    const changed = this._board !== lb || this._displayKey !== key;
    this._board = lb; this._displayKey = key;
    this.setData({ ...(changed ? { entries: presentEntries(lb.entries, lb.me, this.data.metric), total: lb.total ?? null,
      hasMore: !!lb.has_more, nextOffset: lb.next_offset ?? null, snapshot: lb.snapshot || '' } : {}),
      loadingMore: false, moreError: '', me: presentMe(lb.me, this.data.metric), updated_fmt: api.fmtRelTime(lb.updated_at),
      loading: false, refreshing: false, refreshError: '', error: '' });
  },
  async load(options = {}) {
    this.setData({ periodIndex: Math.max(0, this.data.periods.findIndex(item => item.key === this.data.period)) });
    if (this.data.mode !== 'ranking') return this.loadInsights(options);
    const requestId = this._requestId = (this._requestId || 0) + 1;
    const period = this.data.period, metric = this.data.metric || 'tokens', key = this.queryKey();
    const current = () => requestId === this._requestId && key === this.queryKey();
    this.setData({ user: api.peekMe() || null });
    const cached = options.force === true ? null : api.peekLeaderboard({ scope: 'global', period, metric });
    if (cached) { this.showBoard(cached); return; }
    const keep = this.startLoad(key);
    try {
      await api.ensureSession().catch(() => null);
      if (!current()) return;
      // Own avatar/profile loads in parallel; a slow profile cannot hold up the ranking.
      api.ensureLogin(options).then(user => { if (current()) this.setData({ user }); }).catch(() => {});
      const lb = await api.fetchLeaderboard({ scope: 'global', period, metric }, options);
      if (current()) this.showBoard(lb);
    } catch (err) { if (current()) this.loadFailed(err, keep); }
  },
  // Continuation must match the first page's snapshot or the list restarts.
  async loadMore() {
    if (this.data.mode !== 'ranking') return;
    if (!this._visible || this.data.loading || this.data.refreshing || this.data.loadingMore || !this.data.hasMore || !this.data.snapshot) return;
    const requestId = this._requestId, key = this.queryKey();
    const { period, snapshot, nextOffset } = this.data, metric = this.data.metric || 'tokens';
    const current = () => this._visible && requestId === this._requestId && key === this.queryKey();
    this.setData({ loadingMore: true, moreError: '' });
    try {
      const lb = await api.fetchLeaderboard({ scope: 'global', period, metric, offset: nextOffset, snapshot }, { force: true });
      if (!current()) return;
      if (lb.snapshot !== snapshot) { const err = new Error('榜单已有更新'); err.statusCode = 409; throw err; }
      this.setData({ entries: this.data.entries.concat(this.present(lb.entries)), total: lb.total ?? this.data.total,
        hasMore: !!lb.has_more, nextOffset: lb.next_offset ?? null, loadingMore: false });
    } catch (err) {
      if (!current()) return;
      if (err.statusCode === 409) {
        await this.refresh();
        if (this._visible && key === this.queryKey() && !this.data.error && !this.data.refreshError) wx.showToast({ title: '榜单有更新，已刷新', icon: 'none' });
      } else this.setData({ moreError: err.message || '加载失败，请重试', loadingMore: false });
    } finally { if (current()) this.setData({ loadingMore: false }); }
  },
  pickPeriod(e) {
    const item = this.data.periods[Number(e.detail.value)];
    if (item) return this.switchPeriod({ currentTarget: { dataset: { key: item.key } } });
  },
  switchPeriod(e) {
    const period = e.currentTarget.dataset.key;
    if (!this.data.periods.some(item => item.key === period) || period === this.data.period) return;
    this.setData({ period }); return this.load();
  },
  switchMetric(e) {
    const metric = e.currentTarget.dataset.key;
    if (!['tokens', 'credits'].includes(metric) || metric === this.data.metric) return;
    this.setData({ metric }); return this.load({ force: true });
  },
  switchMode(e) {
    const mode = e.currentTarget.dataset.key;
    if (!['ranking', 'tools', 'models'].includes(mode) || mode === this.data.mode) return;
    this.setData({ mode }); return this.load();
  },
  showInsights(result) {
    this._displayKey = this.queryKey();
    this.setData({ insights: presentAnalysis(result), loading: false, refreshing: false, refreshError: '', error: '',
      me: null, updated_fmt: api.fmtRelTime(result.updated_at) });
  },
  async loadInsights(options = {}) {
    const requestId = this._requestId = (this._requestId || 0) + 1, key = this.queryKey();
    const query = { scope: 'public', period: this.data.period, dimension: this.data.mode };
    const cached = options.force === true ? null : api.peekAnalysis?.(query);
    if (cached) { this.showInsights(cached); return; }
    const keep = this.startLoad(key);
    try {
      const result = await api.analysis(query, options);
      if (requestId === this._requestId && key === this.queryKey()) this.showInsights(result);
    } catch (err) { if (requestId === this._requestId && key === this.queryKey()) this.loadFailed(err, keep); }
  },
  goTrends() { wx.navigateTo({ url: '/pages/trends/trends?period=' + (['month', 'last_month'].includes(this.data.period) ? this.data.period : 'week') + '&dimension=' + (this.data.mode === 'models' ? 'models' : 'tools') }); },
  goAnalysis(e) {
    const name = e.currentTarget?.dataset?.name;
    wx.navigateTo({ url: '/pages/analysis/analysis?scope=public&period=' + this.data.period +
      '&dimension=' + (this.data.mode === 'models' ? 'models' : 'tools') + (name ? '&name=' + encodeURIComponent(name) : '') });
  },
  goConnect() { wx.navigateTo({ url: flow.connectUrl() }); },
  goMine() { wx.switchTab({ url: '/pages/profile/profile' }); },
  onShareAppMessage() { return this.data.mode === 'ranking' ? { title: 'AI 编码 Token 广场榜', path: '/pages/square/square', imageUrl: '/assets/share-cover.png' }
    : { title: `${this.data.mode === 'models' ? '模型' : '工具'} · 广场使用分布`, path: '/pages/analysis/analysis?scope=public&period=' + this.data.period + '&dimension=' + this.data.mode, imageUrl: '/assets/share-cover.png' }; },
});
