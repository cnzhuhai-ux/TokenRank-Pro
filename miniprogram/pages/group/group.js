const api = require('../../utils/api');
const { presentGroupInsights } = require('../../utils/group-insights');
const reminderPrompt = require('../../utils/reminder-prompt');
const { quickShare } = require('../../utils/quick-share');
const { drawAchievementPoster, ACHIEVEMENT_HEIGHT } = require('../../utils/achievement-poster');
const flow = require('../../utils/flow');
const updatePrompt = require('../../utils/update-prompt');
const { loadCodeImage } = require('../../utils/share-code');
const { drawGroupPoster } = require('../../utils/group-poster');
const { profileEditor } = require('../../utils/profile-editor');
const { presentEntries, presentMe } = require('../../utils/leaderboard');
const { loadAvatarImage } = require('../../utils/share-avatar');
const { drawRankingPoster, rankingAvatarUrls, rankingPosterHeight } = require('../../utils/ranking-poster');

Page({
  ...quickShare(api, wx),
  ...profileEditor(api, wx, { requireAvatar: true, onSaved(user) {
    this._continueProfile = true;
    if (this._visible) return this.continueProfile(user);
  } }),
  data: { insights: null, insightsLoading: false, insightsError: '', periods: flow.PERIODS, period: 'day', id: '', name: '', joined: null,
    user: null, members: 0, entries: [], me: null, loading: true, refreshing: false, refreshError: '', boardReady: false, error: '', missing: false,
    total: null, hasMore: false, nextOffset: null, snapshot: '', loadingMore: false, moreError: '',
    nickname: '', avatarUrl: '', avatarDraft: '', saving: false, profileError: '',
    nicknameReady: false, nicknameFocus: false, privacyBusy: false, avatarNative: true, sourceName: '', draftName: '', named: true, canRename: false, myHidden: false, visibilitySaving: false,
    enterState: 'idle', enterError: '', joining: false, groupExists: false, owner_id: null, posterPath: '', shareCardPath: '', posterError: '',
    posterStyles: ['我的群内成绩', '完整排行榜', 'Token 榜单'], posterStyleIndex: 0, posterStyle: 'achievement', posterGenerating: false,
    connState: 'pending', connText: '', hasReported: false, updated_fmt: '' },
  onLoad(options) {
    this._accountEpoch = api.accountEpoch();
    const id = options.g || options.id || '';
    // 从已加入的群列表或接入页返回时保留群上下文；卡片进入必须识别当前真实微信群。
    this._needsResolve = !['mine', 'connect'].includes(options.from) || !id;
    const missing = !id && options.enter !== '1' && options.create !== '1';
    const savedStyle = wx.getStorageSync('group_poster_style');
    const styleIndex = savedStyle === 'original' ? 2 : savedStyle === 'ranking' ? 1 : 0;
    this.setData({ id, missing, sourceName: flow.sourceName(options), enterState: this._needsResolve ? 'idle' : 'ready',
      posterStyle: ['achievement', 'ranking', 'original'][styleIndex], posterStyleIndex: styleIndex });
  },
  onShow() {
    wx.showShareMenu({ menus: ['shareAppMessage'], withShareTicket: true });
    this._visible = true;
    this._unloaded = false;
    this.syncAccount();
    if (this.data.missing) return;
    if (this.data.enterState === 'profile') {
      this.checkNicknamePrivacy();
      if (this._continueProfile && flow.hasProfile(this.data.user)) return this.continueProfile(this.data.user);
      return;
    }
    if (this._refreshAfterPk && !this._needsResolve) { this._refreshAfterPk = false; return this.init({ force: true }); }
    return this._needsResolve ? this.tryEnterGroup() : this.init();
  },
  onReady() { this.buildQuickCover(); },
  onHide() {
    this.clearQuickShare();
    this._visible = false;
    this._enterRequest = (this._enterRequest || 0) + 1;
    this._entering = false;
    this._pkPrompt = false;
    this._insightsRequest = (this._insightsRequest || 0) + 1;
    this.setData({ joining: false, refreshing: false, insightsLoading: false, loadingMore: false, posterGenerating: false, visibilitySaving: false, nicknameFocus: false });
    this._requestId = (this._requestId || 0) + 1;
    this._posterVersion = (this._posterVersion || 0) + 1;
  },
  onUnload() { this._unloaded = true; this._privacyCheck = (this._privacyCheck || 0) + 1; this.onHide(); },
  onReachBottom() { if (!this.data.moreError) return this.loadMore(); },
  async onPullDownRefresh() {
    if (this.data.enterState === 'profile') { wx.stopPullDownRefresh(); return; }
    try { await (this._needsResolve ? this.tryEnterGroup() : this.init({ force: true })); }
    finally { wx.stopPullDownRefresh(); }
  },
  resetBoard(patch = {}) {
    this.clearQuickShare();
    this._boardSnapshot = null;
    this._boardQuery = null;
    this._boardValid = false;
    this._boardPermission = '';
    this._posterVersion = (this._posterVersion || 0) + 1;
    this._insightsRequest = (this._insightsRequest || 0) + 1;
    this.setData({ entries: [], me: null, total: null, hasMore: false, nextOffset: null, snapshot: '',
      boardReady: false, loading: false, refreshing: false, refreshError: '', error: '', loadingMore: false, moreError: '', updated_fmt: '',
      insights: null, insightsLoading: false, insightsError: '', posterPath: '', shareCardPath: '', posterError: '', posterGenerating: false, ...patch });
  },
  syncAccount() {
    const epoch = api.accountEpoch();
    if (this._accountEpoch === undefined) this._accountEpoch = epoch;
    if (this._accountEpoch === epoch && !api.accountState()) return true;
    this._accountEpoch = epoch;
    this._requestId = (this._requestId || 0) + 1;
    this._enterRequest = (this._enterRequest || 0) + 1;
    this._entering = false;
    this._groupRef = '';
    this._continueProfile = false;
    this._profileMode = '';
    this._dirty = false;
    this._privacyCheck = (this._privacyCheck || 0) + 1;
    this.resetBoard({ user: null, joined: null, name: '', members: 0, owner_id: null, myHidden: false, canRename: false,
      connState: 'pending', connText: '', hasReported: false, nickname: '', avatarUrl: '', avatarDraft: '', profileError: '',
      saving: false, visibilitySaving: false, joining: false, enterError: '', enterState: this._needsResolve ? 'idle' : 'ready' });
    return !api.accountState();
  },
  boardMatches() {
    const query = this._boardQuery;
    return !!query && !!this._boardSnapshot && this.data.boardReady && this.data.joined === true &&
      query.id === this.data.id && query.period === this.data.period && query.epoch === api.accountEpoch() && !api.accountState();
  },
  requestCurrent(request, id, period, epoch) {
    if (!this._visible || this._unloaded || request !== this._requestId) return false;
    if (epoch !== api.accountEpoch() || api.accountState()) { this.syncAccount(); return false; }
    return id === this.data.id && period === this.data.period;
  },
  permissionKey(user, info) {
    return JSON.stringify([user?.user_id, info.joined === true, !!user?.rank_hidden, !!info.my_hidden]);
  },
  permissionError(error) {
    return [401, 403, 404, 409, 428].includes(error.statusCode) ||
      ['ACCOUNT_INACTIVE', 'ACCOUNT_DELETED', 'ACCOUNT_DISABLED', 'PROFILE_REQUIRED', 'BOARD_CHANGED'].includes(error.code);
  },
  revokeBoard(error) {
    this._requestId = (this._requestId || 0) + 1;
    this.resetBoard({ joined: null, canRename: false, error: error.message || '暂时无法查看本群排名，请重试' });
  },
  async tryEnterGroup() {
    if (this._entering) return;
    this._entering = true;
    const attempt = this._enterRequest = (this._enterRequest || 0) + 1;
    const epoch = api.accountEpoch();
    const current = () => {
      if (!this._visible || attempt !== this._enterRequest) return false;
      if (epoch !== api.accountEpoch() || api.accountState()) { this.syncAccount(); return false; }
      return true;
    };
    this._requestId = (this._requestId || 0) + 1;
    this.resetBoard({ joined: null });
    this._groupRef = '';
    if (flow.enteredFromPrivateChat()) { this._entering = false; this.setData({ enterState: 'private', missing: false, loading: false }); return; }
    this.setData({ enterState: 'resolving', enterError: '', missing: false });
    try {
      const group = await flow.resolveCurrentGroup({}, current);
      if (!current()) return;
      if (!group.joined) {
        if (!group.group_ref) throw new Error('暂时未能识别本群，请重试。');
        this._groupRef = group.group_ref;
        this.setData({ id: group.id || '', name: group.name, members: group.members || 0, joined: false,
          groupExists: !!group.exists, enterState: 'confirm', loading: false });
        return;
      }
      if (!group.id) throw new Error('暂时未能找到本群榜单，请重试。');
      this._needsResolve = false;
      this.setData({ id: group.id, name: group.name, joined: true, enterState: 'ready', enterError: '' });
      await this.init({ joined: true });
    } catch (err) {
      if (current()) this.setData({ enterState: 'failed', enterError: err.message, loading: false });
    } finally { if (attempt === this._enterRequest) this._entering = false; }
  },
  async confirmJoin() {
    if (this._entering || this.data.joining || this.data.enterState !== 'confirm' || !this._groupRef) return;
    this._entering = true;
    const attempt = this._enterRequest = (this._enterRequest || 0) + 1;
    const epoch = api.accountEpoch();
    const current = () => {
      if (!this._visible || attempt !== this._enterRequest) return false;
      if (epoch !== api.accountEpoch() || api.accountState()) { this.syncAccount(); return false; }
      return true;
    };
    this.setData({ joining: true, enterError: '' });
    try {
      const user = await api.ensureLogin();
      if (!current()) return;
      if (!flow.hasProfile(user)) { this.beginProfile(user, 'join'); return; }
      const draft = this.data.groupExists ? '' : this.data.draftName.trim();
      if ([...draft].length > 100) { wx.showToast({ title: '群名最多 100 个字', icon: 'none' }); return; }
      const group = await flow.resolveCurrentGroup({ confirm: true, expected_group_ref: this._groupRef, ...(draft ? { name: draft } : {}) }, current);
      if (!current()) return;
      if (!group.id || !group.joined) throw new Error('加入未完成，请重新识别当前微信群');
      this._needsResolve = false;
      this.setData({ id: group.id, name: group.name, joined: true, enterState: 'ready', joining: false });
      await this.init({ joined: true });
    } catch (err) {
      if (current() && err.statusCode === 428) {
        const user = await api.ensureLogin({ force: true }).catch(() => null);
        if (user && current()) { this.beginProfile(user, 'join'); return; }
      }
      // A rejected group name keeps the user on the confirm step to edit it.
      if (current() && err.statusCode === 400 && /群名不可用/.test(err.message || '')) { wx.showToast({ title: err.message, icon: 'none' }); return; }
      if (current()) this.setData({ enterState: 'failed', enterError: err.message, loading: false });
    } finally {
      if (attempt === this._enterRequest) { this._entering = false; this.setData({ joining: false }); }
    }
  },
  cancelJoin() {
    if (this.data.joining) return;
    if (getCurrentPages().length > 1) wx.navigateBack({ delta: 1 });
    else this.goHome();
  },
  beginProfile(user, mode) {
    this._profileMode = mode;
    this._requestId = (this._requestId || 0) + 1;
    this.resetBoard({ enterState: 'profile', user, joining: false,
      nickname: this._dirty ? this.data.nickname : user.nickname || '',
      avatarUrl: this.data.avatarDraft || user.avatar_url || '', profileError: '' });
    this.checkNicknamePrivacy();
  },
  async continueProfile(user) {
    if (!flow.hasProfile(user) || !this._visible || this._unloaded) return;
    this._continueProfile = false;
    if (this._profileMode === 'join') {
      this.setData({ enterState: 'confirm' });
      return this.confirmJoin();
    }
    this.setData({ enterState: 'ready' });
    return this.init({ force: true });
  },
  showInfo(user, info) {
    const permission = this.permissionKey(user, info);
    if (this._boardSnapshot && (info.joined !== true || (this._boardPermission && this._boardPermission !== permission))) {
      this.resetBoard({ loading: info.joined === true });
    }
    this._boardPermission = permission;
    const owner = !!user && info.owner_id === user.user_id;
    this.setData({ user, name: info.name, members: info.members, joined: info.joined,
      owner_id: info.owner_id, myHidden: !!info.my_hidden, named: info.named !== false, canRename: info.can_rename ?? owner, ...flow.connection(user) });
  },
  showBoard(lb) {
    const changed = this._boardSnapshot !== lb;
    this._boardSnapshot = lb;
    this._boardQuery = { id: this.data.id, period: this.data.period, epoch: api.accountEpoch() };
    this._boardValid = true;
    if (changed) {
      this._posterVersion = (this._posterVersion || 0) + 1;
      this.setData({ posterPath: '', shareCardPath: '', posterError: '',
        entries: presentEntries(lb.entries, lb.me),
        total: lb.total ?? null, hasMore: !!lb.has_more, nextOffset: lb.next_offset ?? null,
        snapshot: lb.snapshot || '', loadingMore: false, moreError: '' });
    }
    this.setData({
      members: lb.members ?? this.data.members,
      me: presentMe(lb.me),
      updated_fmt: api.fmtRelTime(lb.updated_at), boardReady: true, loading: false, refreshing: false, refreshError: '', error: '',
    });
    if (this.data.hasReported || lb.me) {
      this.prepareQuickShare({ groupId: this.data.id, stamp: `${lb.snapshot || lb.updated_at}:${lb.me?.tokens}:${this.data.name}` });
    } else this.clearQuickShare();
    this.promptConnect();
  },
  promptConnect() {
    if (!this._visible || this.data.enterState !== 'ready') return;
    updatePrompt.maybePrompt(wx, this.data.user);
    reminderPrompt.maybePrompt(api, wx, this.data.user, () => this._visible);
  },
  openPk(e) {
    if (!this._visible || this._pkPrompt || this.data.loading || this.data.refreshing || this._boardValid === false ||
      api.accountState() || (this._boardQuery && !this.boardMatches()) || this.data.joined !== true || !this.data.snapshot) return;
    const entry = this.data.entries.find(item => item.rank === Number(e.currentTarget.dataset.rank));
    if (!entry) return;
    if (entry.isMe) { this.goMine(); return; }
    const { id, period, snapshot } = this.data, request = this._requestId, epoch = api.accountEpoch();
    const label = this.data.periods.find(item => item.key === period)?.label || '同期';
    this._pkPrompt = true;
    wx.showModal({ title: '和 TA PK', content: `${entry.nickname}\n${label} · ${entry.tokens_fmt} tokens\n对比双方同期用量。`,
      confirmText: '进入PK', cancelText: '取消',
      success: result => {
        this._pkPrompt = false;
        if (!result.confirm || !this._visible || request !== this._requestId || epoch !== api.accountEpoch()) return;
        this._refreshAfterPk = true;
        wx.navigateTo({ url: '/pages/compare/compare?g=' + encodeURIComponent(id) + '&period=' + period +
          '&rank=' + entry.rank + '&snapshot=' + snapshot });
      }, fail: () => { this._pkPrompt = false; } });
  },
  async init(options = {}) {
    if (!this.data.id) return;
    this.syncAccount();
    const requestId = this._requestId = (this._requestId || 0) + 1;
    const { id, period } = this.data, epoch = api.accountEpoch();
    const current = () => this.requestCurrent(requestId, id, period, epoch);
    if (api.accountState()) { this.resetBoard({ error: '请重新登录后使用' }); return; }
    const cachedUser = options.force === true ? null : api.peekMe();
    const cachedInfo = options.force === true ? null : api.peekGroup(id);
    const cachedBoard = options.force === true ? null : api.peekLeaderboard({ scope: 'group', id, period });
    if (!this.boardMatches() && (this._boardSnapshot || this.data.boardReady || this.data.insights)) this.resetBoard();
    if (this._boardSnapshot && cachedInfo && (cachedInfo.joined !== true ||
      (cachedUser && this._boardPermission !== this.permissionKey(cachedUser, cachedInfo)))) this.resetBoard();
    if (cachedUser && cachedInfo && cachedBoard && cachedInfo.joined) {
      this.showInfo(cachedUser, cachedInfo);
      if (!flow.hasProfile(cachedUser)) { this.beginProfile(cachedUser, 'member'); return; }
      this.showBoard(cachedBoard);
      this.loadInsights(options);
      return;
    }
    const keepBoard = this.boardMatches();
    // A retained list is only a visual fallback. Sharing and PK wait for a validated read.
    this.clearQuickShare();
    this._boardValid = false;
    this._posterVersion = (this._posterVersion || 0) + 1;
    this._insightsRequest = (this._insightsRequest || 0) + 1;
    if (keepBoard) this.setData({ loading: false, refreshing: true, refreshError: '', error: '',
      loadingMore: false, insightsLoading: false, posterPath: '', shareCardPath: '', posterError: '', posterGenerating: false });
    else this.resetBoard({ loading: true });
    try {
      await api.ensureSession();
      if (!current()) return;
      if (api.groupPage) {
        const result = await api.groupPage(id, period, options);
        if (!current()) return;
        this.showInfo(result.user, result.group);
        if (!result.group.joined) { this.resetBoard(); return; }
        if (!flow.hasProfile(result.user)) { this.beginProfile(result.user, 'member'); return; }
        if (!result.board) throw new Error('群榜暂不可用，请重试');
        this.showBoard(result.board);
        if (result.insights) this.setData({ insights: presentGroupInsights(result.insights), insightsLoading: false, insightsError: '' });
        else this.setData({ insights: null, insightsLoading: false, insightsError: result.insights_error || '群数据暂不可用，请重试' });
        return;
      }
      // Membership already confirmed by the card entry: load the board alongside user and group info.
      const board = options.joined === true ? api.fetchLeaderboard({ scope: 'group', id, period }, options) : null;
      board?.catch(() => {});
      const [user, info] = await Promise.all([api.ensureLogin(options), api.groupInfo(id, options)]);
      if (!current()) return;
      this.showInfo(user, info);
      if (!info.joined) { this.resetBoard(); return; }
      if (!flow.hasProfile(user)) { this.beginProfile(user, 'member'); return; }
      const lb = await (board || api.fetchLeaderboard({ scope: 'group', id, period }, options));
      if (!current()) return;
      this.showBoard(lb);
      this.loadInsights(options);
    } catch (err) {
      if (!current()) return;
      if (this.permissionError(err)) {
        this.revokeBoard(err);
        if (err.statusCode === 428) {
          const retryRequest = this._requestId;
          const user = await api.ensureLogin({ force: true }).catch(() => null);
          if (user && this.requestCurrent(retryRequest, id, period, epoch)) this.beginProfile(user, 'member');
        }
      } else if (this.boardMatches()) {
        this.setData({ loading: false, refreshing: false, refreshError: err.message || '刷新失败，请重试', error: '' });
      } else this.setData({ loading: false, refreshing: false, error: err.message || '群榜暂不可用，请重试' });
    }
  },
  async loadInsights(options = {}) {
    const { id, period } = this.data, request = this._requestId, epoch = api.accountEpoch();
    const attempt = this._insightsRequest = (this._insightsRequest || 0) + 1;
    const current = () => attempt === this._insightsRequest && this.requestCurrent(request, id, period, epoch);
    const cached = options.force ? null : api.peekGroupInsights?.(id, period);
    const stale = !!cached && Number(cached.updated_at || 0) < Number(this._boardSnapshot?.updated_at || 0);
    if (cached && !stale) { this.setData({ insights: presentGroupInsights(cached), insightsLoading: false, insightsError: '' }); return; }
    this.setData({ insightsLoading: true, insightsError: '' });
    try {
      const result = await api.groupInsights(id, period, { ...options, force: options.force === true || stale });
      if (current()) this.setData({ insights: presentGroupInsights(result), insightsLoading: false });
    } catch (error) {
      if (!current()) return;
      if (this.permissionError(error)) this.revokeBoard(error);
      else this.setData({ insightsLoading: false, insightsError: error.statusCode >= 500 ? '暂时无法汇总本群用量，请重试' : error.message || '群数据暂不可用' });
    }
  },
  retryInsights() { if (this.data.refreshing || !this._boardValid || !this.boardMatches()) return; return this.loadInsights({ force: true }); },
  scrollToInsights() { wx.pageScrollTo?.({ selector: '#group-overview', duration: 250 }); },
  openGroupReport() { if (!this._boardValid || !this.boardMatches()) return; wx.navigateTo({ url: '/pages/group-report/group-report?g=' + encodeURIComponent(this.data.id) + '&period=' + this.data.period }); },
  async loadMore() {
    if (!this._visible || this.data.enterState !== 'ready' || this.data.joined !== true || this.data.loading || this.data.refreshing || this.data.loadingMore ||
      !this._boardValid || !this.boardMatches() || !this.data.hasMore || !this.data.snapshot) return;
    const requestId = this._requestId, epoch = api.accountEpoch();
    const { id, period, snapshot, nextOffset } = this.data;
    const current = () => this.requestCurrent(requestId, id, period, epoch);
    this.setData({ loadingMore: true, moreError: '' });
    try {
      // Always validate continuation against current server data, even within
      // the first-page cache TTL. A changed ranking must start over.
      const lb = await api.fetchLeaderboard({ scope: 'group', id, period, offset: nextOffset, snapshot }, { force: true });
      if (!current()) return;
      if (lb.snapshot !== snapshot) { const err = new Error('榜单已有更新'); err.statusCode = 409; throw err; }
      this.setData({ entries: this.data.entries.concat(presentEntries(lb.entries, this.data.me)),
        total: lb.total, hasMore: !!lb.has_more, nextOffset: lb.next_offset ?? null, loadingMore: false });
    } catch (err) {
      if (!current()) return;
      if (err.statusCode === 428) {
        this.revokeBoard(err);
        const profileRequest = this._requestId;
        const user = await api.ensureLogin({ force: true }).catch(() => null);
        if (user && this.requestCurrent(profileRequest, id, period, epoch)) { this.beginProfile(user, 'member'); return; }
      } else if (err.statusCode === 409) {
        // A changed snapshot can contain removed members. Discard it before requesting a new first page.
        this.resetBoard();
        await this.init({ force: true });
        if (this._visible && this.data.id === id && this.data.period === period && this._boardValid && !this.data.error)
          wx.showToast({ title: '榜单有更新，已刷新', icon: 'none' });
      } else if (this.permissionError(err)) this.revokeBoard(err);
      else this.setData({ moreError: err.message || '加载失败，请重试', loadingMore: false });
    } finally { if (current()) this.setData({ loadingMore: false }); }
  },
  load() { return this.init({ force: true }); },
  async toggleGroupVisibility(e) {
    if (this.data.visibilitySaving || this.data.refreshing || this.data.loading || !this.boardMatches()) return;
    const hidden = !e.detail.value, id = this.data.id, epoch = api.accountEpoch();
    // This setting belongs to the group, so a period change must not discard its result.
    const current = () => this._visible && !this._unloaded && this.data.id === id && epoch === api.accountEpoch() && !api.accountState();
    this.setData({ visibilitySaving: true });
    try {
      await api.setGroupVisibility(id, hidden);
      if (!current()) return;
      this.resetBoard({ myHidden: hidden });
      wx.showToast({ title: hidden ? '已在本群隐藏' : '已在本群显示', icon: 'none' });
      await this.init({ force: true });
    } catch (err) {
      if (current()) {
        if (this.permissionError(err)) this.revokeBoard(err);
        else this.setData({ myHidden: this.data.myHidden });
        wx.showToast({ title: err.message || '设置失败，请重试', icon: 'none' });
      }
    } finally { if (this._visible && this.data.id === id && epoch === api.accountEpoch()) this.setData({ visibilitySaving: false }); }
  },
  onDraftName(e) { this.setData({ draftName: e.detail.value }); },
  rename() {
    const named = this.data.named;
    wx.showModal({ title: named ? '修改群榜名称' : '给群榜起个名字', editable: true, content: named ? this.data.name : '',
      placeholderText: '建议填微信群名，最多 100 字',
      success: async res => {
        const value = (res.content || '').trim();
        if (!res.confirm || !value) return;
        if ([...value].length > 100) { wx.showToast({ title: '群名最多 100 个字', icon: 'none' }); return; }
        try {
          await api.renameGroup(this.data.id, value);
          wx.showToast({ title: '已改名', icon: 'success' });
          await this.init({ force: true });
        } catch (err) { wx.showToast({ title: err.message, icon: 'none' }); }
      },
    });
  },
  async buildPoster() {
    if (this._boardValid === false || api.accountState() || (this._boardQuery && !this.boardMatches())) return;
    if (this.data.posterStyle === 'achievement' && !this._quickRecord) return;
    if (this._posterBusy) { this._posterPending = true; return; }
    this._posterBusy = true;
    const version = this._posterVersion, epoch = api.accountEpoch();
    const current = () => version === this._posterVersion && epoch === api.accountEpoch() && !api.accountState();
    const data = { ...this.data, scope: 'group', day: this._boardSnapshot?.day, achievement: this._quickRecord };
    this.setData({ posterError: '', posterGenerating: true });
    try {
      const node = await new Promise(resolve => wx.createSelectorQuery().in(this)
        .select('#poster').fields({ node: true, size: true }).exec(res => resolve(res && res[0] && res[0].node)));
      if (!node || !current()) return;
      const urls = data.posterStyle === 'achievement' ? [data.achievement.user.avatar_url].filter(Boolean) : rankingAvatarUrls(data);
      const [codeImage, images] = await Promise.all([loadCodeImage(node), Promise.all(urls.map(url => loadAvatarImage(node, url)))]);
      if (!current()) return;
      const avatarImages = Object.fromEntries(urls.map((url, index) => [url, images[index]]));
      const ctx = node.getContext('2d');
      const exportImage = (width, height) => new Promise((resolve, reject) => wx.canvasToTempFilePath({
        canvas: node, destWidth: width, destHeight: height, fileType: 'png',
        success: r => resolve(r.tempFilePath), fail: reject,
      }));
      const width = data.posterStyle !== 'original' ? 1000 : 750;
      const height = data.posterStyle === 'achievement' ? ACHIEVEMENT_HEIGHT : data.posterStyle === 'ranking' ? rankingPosterHeight(data) : 1150;
      const coverHeight = data.posterStyle !== 'original' ? 800 : 600;
      node.width = width; node.height = height;
      this.drawPoster(ctx, width, height, codeImage, avatarImages, data);
      const posterPath = await exportImage(width, height);
      if (!current()) return;
      node.width = width; node.height = coverHeight;
      this.drawShareCard(ctx, width, coverHeight, codeImage, avatarImages, data);
      const shareCardPath = await exportImage(width, coverHeight);
      if (current()) this.setData({ posterPath, shareCardPath });
    } catch (err) { if (current()) this.setData({ posterError: err.message || '分享图生成失败，请重试' }); }
    finally {
      this._posterBusy = false;
      if (current()) this.setData({ posterGenerating: false });
      if (this._posterPending) {
        this._posterPending = false;
        if (this._visible && !this.data.loading) this.buildPoster();
      }
    }
  },
  drawShareCard(ctx, W, H, codeImage, avatarImages = {}, data = this.data) {
    if (data.posterStyle === 'achievement') drawAchievementPoster(ctx, { ...data.achievement, cover: true, codeImage, avatarImage: avatarImages[data.achievement.user.avatar_url] });
    else if (data.posterStyle === 'ranking') drawRankingPoster(ctx, { data, cover: true, codeImage, avatarImages });
    else drawGroupPoster(ctx, { data, cover: true, codeImage, avatarImages });
  },
  drawPoster(ctx, W, H, codeImage, avatarImages = {}, data = this.data) {
    if (data.posterStyle === 'achievement') drawAchievementPoster(ctx, { ...data.achievement, codeImage, avatarImage: avatarImages[data.achievement.user.avatar_url] });
    else if (data.posterStyle === 'ranking') drawRankingPoster(ctx, { data, codeImage, avatarImages });
    else drawGroupPoster(ctx, { data, codeImage, avatarImages });
  },
  changePosterStyle(e) {
    const index = Number(e.detail.value);
    if (![0, 1, 2].includes(index) || index === this.data.posterStyleIndex) return;
    const posterStyle = ['achievement', 'ranking', 'original'][index];
    wx.setStorageSync('group_poster_style', posterStyle);
    this._posterVersion = (this._posterVersion || 0) + 1;
    this.setData({ posterStyle, posterStyleIndex: index, posterPath: '', shareCardPath: '' });
    return this.buildPoster();
  },

  async previewPoster() {
    const request=this._requestId,epoch=api.accountEpoch();
    if(!this.data.posterPath)await this.buildPoster();
    if(this._visible && request===this._requestId && epoch===api.accountEpoch() && this.data.posterPath)wx.previewImage({ urls: [this.data.posterPath] });
  },
  retryQuickShare() {
    if (!this._boardValid || !this.boardMatches() || this.data.refreshing) return;
    const lb = this._boardSnapshot;
    return this.prepareQuickShare({ groupId: this.data.id, stamp: `${lb.snapshot || lb.updated_at}:${lb.me?.tokens}:${this.data.name}` });
  },
  switchPeriod(e) {
    const period = e.currentTarget.dataset.key;
    if (period === this.data.period || !this.data.periods.some(item => item.key === period)) return;
    this.resetBoard({ period });
    return this.init();
  },
  goConnect() { wx.navigateTo({ url: flow.connectUrl(this.data.id) }); },
  goHome() { wx.switchTab({ url: '/pages/index/index' }); },
  goMine() { wx.switchTab({ url: '/pages/profile/profile' }); },
  goSquare() { wx.switchTab({ url: '/pages/square/square' }); },
  onShareAppMessage(options = {}) {
    const active = !api.accountState() && (!this._boardQuery || this.boardMatches()) && this._boardValid !== false;
    if (active && options.target?.dataset?.kind !== 'board') {
      const personal = this.quickShareCard();
      if (personal) return personal;
    }
    const card = flow.shareCard();
    const named = active && this.data.joined === true && this.data.name;
    // The card opens the recipient's own group; carry the source name so that page can say where the card came from.
    return { ...card, title: named ? `${this.data.name} · ${this.data.members} 人已加入` : card.title,
      path: named ? `${card.path}&src=${encodeURIComponent([...this.data.name].slice(0, 30).join(''))}` : card.path,
      imageUrl: (active && this.data.shareCardPath) || '/assets/share-cover.png' };
  },
});
