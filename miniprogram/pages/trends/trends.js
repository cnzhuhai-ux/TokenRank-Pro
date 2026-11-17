const api = require('../../utils/api');
const { trendsView } = require('../../utils/history');
const PERIODS = [{ key: 'week', label: '近 7 天' }, { key: 'month', label: '近 30 天' }, { key: 'last_month', label: '上个月' }];
const METRICS = [{ key: 'users', label: '使用人数' }, { key: 'tokens', label: 'Token 用量' }];
Page({
  data: { period: 'week', periods: PERIODS, periodIndex: 0, dimension: 'tools', metric: 'users', metrics: METRICS, metricIndex: 0, end: '',
    loading: true, refreshing: false, refreshError: '', error: '', report: null, loadingMore: false, moreError: '' },
  onLoad(options) {
    const periodIndex = Math.max(0, PERIODS.findIndex(item => item.key === options.period)), metricIndex = options.metric === 'tokens' ? 1 : 0;
    this.setData({ period: PERIODS[periodIndex].key, periodIndex, dimension: options.dimension === 'models' ? 'models' : 'tools',
      metric: METRICS[metricIndex].key, metricIndex, end: options.end || '' });
    wx.showShareMenu({ menus: ['shareAppMessage'], withShareTicket: true });
  },
  onShow() { this._visible = true; return this.load(); },
  onHide() { this._visible = false; this._requestId = (this._requestId || 0) + 1; this.setData({ refreshing: false, loadingMore: false }); },
  onUnload() { this.onHide(); },
  async onPullDownRefresh() { try { await this.refresh(); } finally { wx.stopPullDownRefresh(); } },
  refresh() { return this.load({ force: true }); },
  query() { return { period: this.data.period, dimension: this.data.dimension, metric: this.data.metric, end: this.data.end }; },
  queryKey(query = this.query()) { return JSON.stringify([query.period, query.dimension, query.metric, query.end]); },
  async load(options = {}) {
    const request = this._requestId = (this._requestId || 0) + 1, query = this.query(), key = this.queryKey(query);
    const current = () => request === this._requestId && key === this.queryKey();
    const cached = options.force === true ? null : api.peekTrends?.(query);
    if (cached) { this.showReport(cached, key); return; }
    const keep = options.force === true && !!this.data.report && this._displayKey === key;
    if (!keep) { this._raw = null; this._displayKey = ''; }
    this.setData({ loading: !keep, refreshing: keep, refreshError: '', error: '', ...(keep ? {} : { report: null }), loadingMore: false, moreError: '' });
    try {
      const report = await api.trends(query, options);
      if (!current()) return;
      this.showReport(report, key);
    } catch (error) {
      if (!current()) return;
      const message = error.message || '趋势榜暂不可用，请重试';
      this.setData({ loading: false, refreshing: false, error: keep ? '' : message, refreshError: keep ? message : '' });
    }
  },
  showReport(report, key = this.queryKey()) {
    // Keep expanded continuation pages when the same first-page snapshot is reused.
    if (this._raw !== report || !this.data.report || this._displayKey !== key) this.setData({ report: trendsView(report) });
    this._raw = report; this._displayKey = key;
    this.setData({ loading: false, refreshing: false, refreshError: '', error: '', loadingMore: false, moreError: '' });
  },
  pickPeriod(e) {
    const period = PERIODS[Number(e.detail?.value)];
    if (period) return this.switchOption({ currentTarget: { dataset: { field: 'period', value: period.key } } });
  },
  pickMetric(e) {
    const metric = METRICS[Number(e.detail?.value)];
    if (metric) return this.switchOption({ currentTarget: { dataset: { field: 'metric', value: metric.key } } });
  },
  switchOption(e) {
    const { field, value } = e.currentTarget.dataset;
    const allowed = { period: PERIODS.map(item => item.key), dimension: ['tools','models'], metric: METRICS.map(item => item.key) };
    if (!allowed[field]?.includes(value) || this.data[field] === value) return;
    this.setData({ [field]: value,
      ...(field === 'period' ? { periodIndex: PERIODS.findIndex(item => item.key === value), end: '' } : {}),
      ...(field === 'metric' ? { metricIndex: METRICS.findIndex(item => item.key === value) } : {}) }); return this.load();
  },
  onReachBottom() { if (!this.data.moreError) return this.loadMore(); },
  async loadMore() {
    if (!this._visible || this.data.loading || this.data.refreshing || this.data.loadingMore || !this.data.report?.has_more || this._displayKey !== this.queryKey()) return;
    const request = this._requestId, key = this._displayKey, first = this.data.report;
    const current = () => this._visible && request === this._requestId && key === this.queryKey();
    this.setData({ loadingMore: true, moreError: '' });
    try {
      const result = await api.trends({ ...this.query(), end: first.to, offset: first.next_offset, snapshot: first.snapshot }, { force: true });
      if (!current()) return;
      this.setData({ report: trendsView({ ...result, entries: [...first.entries, ...result.entries] }) });
    } catch (error) {
      if (!current()) return;
      if (error.statusCode === 409) { await this.refresh(); return; }
      this.setData({ moreError: error.message || '加载失败，请重试' });
    } finally { if (current()) this.setData({ loadingMore: false }); }
  },
  onShareAppMessage() { const r = this.data.report;
    return { title: (this.data.dimension === 'models' ? '模型' : '工具') + '趋势榜' + (r ? ' · ' + r.from.slice(5) + '—' + r.to.slice(5) : ''),
      path: '/pages/trends/trends?period=' + this.data.period + '&dimension=' + this.data.dimension + '&metric=' + this.data.metric + (r ? '&end=' + r.to : ''), imageUrl: '/assets/share-cover.png' };
  },
});
