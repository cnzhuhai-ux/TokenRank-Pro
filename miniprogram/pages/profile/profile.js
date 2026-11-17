const api = require('../../utils/api');
const reminderPrompt = require('../../utils/reminder-prompt');
const flow = require('../../utils/flow');
const usage = require('../../utils/usage');
const { quickShare } = require('../../utils/quick-share');
const { profileEditor } = require('../../utils/profile-editor');
const sections = ['trendExpanded', 'breakdownExpanded', 'cacheExpanded', 'profileExpanded'];

function presentUsage(result) {
  const view = usage.present(result);
  const daily = view.daily.map(day => {
    const hasValue = typeof day.tokens === 'number' && Number.isFinite(day.tokens) && day.tokens >= 0;
    // Older usage responses fill absent dates with zero and have no reported flag.
    const valueAvailable = !day.future && day.reported !== false && hasValue && (day.tokens > 0 || day.reported === true);
    const statusText = day.future ? '未到日期' : day.reported === false ? '未同步'
      : !valueAvailable ? '同步状态未确认' : day.tokens === 0 ? '已同步 · 零用量' : '';
    return { ...day, valueAvailable, statusText, exact: valueAvailable ? day.exact : '' };
  });
  const values = daily.filter(day => day.valueAvailable).map(day => day.tokens);
  const peak = Math.max(0, ...values);
  return { ...view, daily: daily.map(day => ({ ...day,
    height: day.valueAvailable && day.tokens > 0 ? Math.max(3, Math.round(day.tokens / peak * 100)) : 0 })),
    peakText: values.length ? usage.formatTokens(peak) : '—',
    creditsExact: view.creditsDisplay.available ? result.credits.total.toLocaleString('en-US', { maximumFractionDigits: 6 }) : '' };
}

function daySelection(view, day) {
  const daily = view.daily;
  const trendStart = daily.length ? daily[0].day : '';
  const trendEnd = daily.length ? daily[daily.length - 1].day : '';
  if (!daily.length) return { selectedDay: null, trendStart, trendEnd, canPrevious: false, canNext: false };
  const selected = day && day >= trendStart && day <= trendEnd ? day : trendEnd;
  const selectedDay = daily.find(item => item.day === selected) || {
    day: selected, tokens: null, exact: '', valueAvailable: false, statusText: '暂无该日数据',
  };
  return { selectedDay, trendStart, trendEnd, canPrevious: selected > trendStart, canNext: selected < trendEnd };
}

Page({
  ...quickShare(api, wx),
  ...profileEditor(api, wx, { onSaved(user) {
    this.setData({ profileComplete: flow.hasProfile(user) });
    wx.showToast({ title: '资料已保存', icon: 'success' });
  } }),
  data: { user: null, nickname: '', avatarUrl: '', avatarDraft: '', saving: false, loading: true, error: '', profileError: '',
    periods: usage.PERIODS, period: 'day', usage: null, usageLoading: true, usageError: '',
    expanded: false, trendExpanded: false, breakdownExpanded: false, cacheExpanded: false,
    profileExpanded: false, profileComplete: false, selectedDay: null, trendStart: '', trendEnd: '', canPrevious: false, canNext: false,
    nicknameReady: false, nicknameFocus: false, privacyBusy: false, avatarNative: true,
    connState: 'pending', connText: '', hasReported: false },
  onShow() { this._visible = true; this._unloaded = false; this.checkNicknamePrivacy(); return this.load(); },
  async toggleRanking(e) {
    const hidden = !e.detail.value;
    this.setData({ rankingSaving: true });
    try {
      const user = await api.setRanking(hidden);
      if (this._unloaded) return;
      this.setData({ user: { ...this.data.user, ...user } });
      wx.showToast({ title: hidden ? '已关闭排名' : '已恢复排名', icon: 'none' });
    } catch (err) {
      if (!this._unloaded) { this.setData({ user: { ...this.data.user } }); wx.showToast({ title: err.message || '设置失败，请重试', icon: 'none' }); }
    } finally { if (!this._unloaded) this.setData({ rankingSaving: false }); }
  },
  onHide() { this._visible = false; this.clearQuickShare(); this._requestId = (this._requestId || 0) + 1; this.setData({ nicknameFocus: false }); },
  onUnload() { this._unloaded = true; this._privacyCheck = (this._privacyCheck || 0) + 1; this.onHide(); },
  async onPullDownRefresh() { try { await this.load({ force: true }); } finally { wx.stopPullDownRefresh(); } },
  showUser(user, profileRevision) {
    if (profileRevision === (this._profileRevision || 0)) {
      const profileComplete = flow.hasProfile(user);
      const profileExpanded = this._profilePanelInitialized ? this.data.profileExpanded : !profileComplete;
      this._profilePanelInitialized = true;
      this.setData({ user, nickname: this._dirty ? this.data.nickname : user.nickname || '', profileComplete, profileExpanded,
        avatarUrl: this.data.avatarDraft || user.avatar_url || '', loading: false, ...flow.connection(user) });
    } else this.setData({ loading: false });
    reminderPrompt.maybePrompt(api, wx, user, () => this._visible);
  },
  showUsage(result) {
    const view = presentUsage(result);
    this.setData({ usage: view, usageLoading: false, usageError: '', ...daySelection(view, this.data.selectedDay?.day) });
    this.prepareUsageShare(result);
  },
  async load(options = {}) {
    const requestId = this._requestId = (this._requestId || 0) + 1;
    const profileRevision = this._profileRevision || 0;
    const period = this.data.period;
    const cachedUser = options.force === true ? null : api.peekMe();
    const cachedUsage = options.force === true ? null : api.peekUsage(period);
    if (cachedUser && cachedUsage) {
      this.showUser(cachedUser, profileRevision);
      this.setData({ error: '' });
      this.showUsage(cachedUsage);
      return;
    }
    const cachedView = cachedUsage ? presentUsage(cachedUsage) : null;
    this.setData({ loading: !cachedUser, error: '', usageLoading: !cachedUsage, usageError: '', usage: cachedView,
      ...(cachedView ? daySelection(cachedView, this.data.selectedDay?.day) : {}) });
    if (cachedUser) this.showUser(cachedUser, profileRevision);
    try {
      await api.ensureSession();
      if (requestId !== this._requestId) return;
      if (api.myOverview) {
        const result = await api.myOverview(period, options);
        if (requestId !== this._requestId) return;
        this.showUser(result.user, profileRevision);
        if (result.usage) this.showUsage(result.usage);
        else this.setData({ usageLoading: false, usageError: result.usage_error?.error || '用量暂不可用' });
        return;
      }
      await Promise.all([
        api.ensureLogin(options).then(user => { if (requestId === this._requestId) this.showUser(user, profileRevision); }),
        api.myUsage(period, options).then(result => {
          if (requestId === this._requestId) this.showUsage(result);
        }).catch(err => { if (requestId === this._requestId) this.setData({ usageLoading: false, usageError: err.message }); }),
      ]);
    } catch (err) {
      if (requestId === this._requestId) this.setData({ loading: false, usageLoading: false, error: err.message });
    }
  },
  switchPeriod(e) {
    const period = e.currentTarget.dataset.key;
    if (!usage.PERIODS.some(p => p.key === period) || period === this.data.period) return;
    this.clearQuickShare();
    this.setData({ period, expanded: false, selectedDay: null, trendStart: '', trendEnd: '', canPrevious: false, canNext: false });
    return this.load();
  },
  toggleSection(e) {
    const key = e.currentTarget.dataset.section;
    if (!sections.includes(key) || key === 'profileExpanded' && (this.data.saving || this.data.privacyBusy || !this.data.user)) return;
    this.setData({ [key]: !this.data[key], ...(key === 'profileExpanded' ? { nicknameFocus: false } : {}) });
  },
  chooseDate(day) {
    if (!this.data.usage || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return;
    const date = new Date(day + 'T00:00:00Z');
    if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== day) return;
    if (!this.data.trendStart || day < this.data.trendStart || day > this.data.trendEnd) return;
    this.setData(daySelection(this.data.usage, day));
  },
  pickDate(e) { this.chooseDate(e.detail.value); },
  stepDay(e) {
    const delta = Number(e.currentTarget.dataset.delta);
    if (![1, -1].includes(delta) || !this.data.selectedDay) return;
    const date = new Date(this.data.selectedDay.day + 'T00:00:00Z');
    date.setUTCDate(date.getUTCDate() + delta);
    this.chooseDate(date.toISOString().slice(0, 10));
  },
  selectDay(e) {
    const index = Number(e.currentTarget.dataset.index);
    if (Number.isInteger(index) && this.data.usage?.daily[index]) this.chooseDate(this.data.usage.daily[index].day);
  },
  toggleDetails() { this.setData({ expanded: !this.data.expanded }); },
  onReady() { this.buildQuickCover(); },
  prepareUsageShare(result) {
    if (!result.has_history) { this.clearQuickShare(); return; }
    this.prepareQuickShare({ stamp: `${result.summary.tokens}:${result.last_report_at || ''}` });
  },
  goShare() { wx.navigateTo({ url: usage.shareUrl(this.data.period) }); },
  goTools() { wx.navigateTo({ url: usage.shareUrl(this.data.period) + '&style=tools' }); },
  goCalendar() { wx.navigateTo({ url: '/pages/calendar/calendar' }); },
  goAchievements() { wx.navigateTo({ url: '/pages/achievements/achievements' }); },
  goDaily() { wx.navigateTo({ url: '/pages/daily/daily' }); },
  goWeekly() { wx.navigateTo({ url: '/pages/weekly/weekly' }); },
  goAnalysis() { wx.navigateTo({ url: '/pages/analysis/analysis?scope=mine&period=' + this.data.period }); },
  goConnect() { wx.navigateTo({ url: flow.connectUrl() }); },
  goReminders() { wx.navigateTo({ url: '/pages/reminders/reminders' }); },
  goGroups() { wx.switchTab({ url: '/pages/index/index' }); },
  goAbout() { wx.navigateTo({ url: '/pages/about/about' }); },
  onShareAppMessage() { return this.quickShareCard() || { title: 'Token 用量统计', path: '/pages/index/index' }; },
  goAccount() { wx.navigateTo({ url: '/pages/account/account' }); },
});
