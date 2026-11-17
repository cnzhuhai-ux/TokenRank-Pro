const api = require('../../utils/api');
const { TOPUP_PRESETS, CURRENCIES, symbol, topupForm, topupBody } = require('../../utils/subscriptions');
const beijingToday = () => new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
const KINDS = [{ key: 'topup', label: '充值' }, { key: 'balance', label: '校准余额' }];
const FIELDS = ['amount', 'day'];
Page({
  data: { id: '', vendor: 'deepseek', name: '', icon: '', loading: false, busy: false, error: '', errorField: '', errorAction: '', fieldErrors: {}, today: '', form: null, kinds: KINDS,
    currencyLabels: CURRENCIES.map(c => `${c.label} ${c.symbol}`), currencyIndex: 0, symbol: '¥' },
  withCurrency(c) { return { symbol: symbol(c), currencyIndex: Math.max(0, CURRENCIES.findIndex(x => x.key === c)) }; },
  async onLoad(options = {}) {
    const today = beijingToday(), id = options.id ? decodeURIComponent(options.id) : '';
    const preset = TOPUP_PRESETS.find(p => p.key === (options.vendor || 'deepseek')) || TOPUP_PRESETS[0];
    this._epoch = api.accountEpoch();
    this.setData({ id, today, vendor: preset.key, name: preset.name, icon: preset.icon });
    wx.setNavigationBarTitle({ title: id ? '编辑充值记录' : preset.name + ' 充值' });
    if (!id) {
      const last = (api.peekSubscriptions()?.topups || []).find(t => t.vendor === preset.key);
      const form = topupForm(null, today, last ? last.currency : preset.currency);
      if (options.kind === 'balance') form.kind = 'balance';
      this.setData({ form, ...this.withCurrency(form.currency) }); return;
    }
    return this.load();
  },
  async load(force = false) {
    if (this.data.loading || !this.data.id || this._epoch !== api.accountEpoch()) return;
    const epoch = this._epoch;
    this.setData({ loading: true, error: '', errorField: '', errorAction: '' });
    try {
      const data = (!force && api.peekSubscriptions()) || await api.subscriptions({ force });
      if (epoch !== api.accountEpoch()) return;
      const record = (data.topups || []).flatMap(t => t.records).find(r => r.id === this.data.id);
      if (!record) { this.requestError('这条记录已不存在，请返回刷新', 'load'); return; }
      const form = topupForm(record, this.data.today);
      this.setData({ form, fieldErrors: {}, ...this.withCurrency(form.currency) });
    } catch (error) {
      if (epoch === api.accountEpoch()) this.requestError(error.message || '暂时无法读取充值记录', 'load');
    } finally { if (epoch === api.accountEpoch()) this.setData({ loading: false }); }
  },
  validationPatch(fieldErrors) {
    const errorField = FIELDS.find(field => fieldErrors[field]) || '';
    return { fieldErrors, errorField, error: fieldErrors[errorField] || '', errorAction: '' };
  },
  changed(patch) {
    if (this.data.busy || this._epoch !== api.accountEpoch()) return;
    const form = { ...this.data.form };
    for (const [key, value] of Object.entries(patch)) if (key.startsWith('form.')) form[key.slice(5)] = value;
    const { errors = {} } = topupBody(form, this.data.vendor, this.data.today), fieldErrors = {};
    for (const field of Object.keys(this.data.fieldErrors)) if (errors[field]) fieldErrors[field] = errors[field];
    this.setData({ ...patch, ...this.validationPatch(fieldErrors) });
    if (!this._guarded && wx.enableAlertBeforeUnload) { this._guarded = true; wx.enableAlertBeforeUnload({ message: '修改还没保存，确定离开？' }); }
  },
  validateField(e) {
    const field = e.currentTarget.dataset.field;
    if (this.data.busy || !this.data.form || !FIELDS.includes(field) || this._epoch !== api.accountEpoch()) return;
    const { errors = {} } = topupBody(this.data.form, this.data.vendor, this.data.today), fieldErrors = { ...this.data.fieldErrors };
    if (errors[field]) fieldErrors[field] = errors[field]; else delete fieldErrors[field];
    this.setData(this.data.errorField || errors[field] ? this.validationPatch(fieldErrors) : { fieldErrors });
  },
  input(e) { this.changed({ ['form.' + e.currentTarget.dataset.field]: e.detail.value }); },
  pickKind(e) { this.changed({ 'form.kind': e.currentTarget.dataset.key }); },
  pickDate(e) { this.changed({ 'form.day': e.detail.value }); },
  pickCurrency(e) { const c = CURRENCIES[Number(e.detail.value)]; if (c) this.changed({ 'form.currency': c.key, ...this.withCurrency(c.key) }); },
  leave() {
    if (this._guarded && wx.disableAlertBeforeUnload) wx.disableAlertBeforeUnload();
    this._guarded = false;
    wx.navigateBack();
  },
  requestError(error, errorAction) {
    const epoch = this._epoch;
    this.setData({ error, errorField: '', errorAction }, () => {
      if (epoch === api.accountEpoch() && this.data.error === error && this.data.errorAction === errorAction) wx.pageScrollTo?.({ scrollTop: 0, duration: 160 });
    });
  },
  retry() {
    if (this.data.busy || this.data.loading || this._epoch !== api.accountEpoch()) return;
    if (this.data.errorAction === 'load') return this.load(true);
    if (this.data.errorAction === 'save') return this.save();
    if (this.data.errorAction === 'remove') return this.remove();
  },
  async save() {
    if (this.data.busy || this._confirming || !this.data.form || this._epoch !== api.accountEpoch()) return;
    const { body, error, field, errors } = topupBody(this.data.form, this.data.vendor, this.data.today);
    if (error) {
      const epoch = this._epoch;
      this.setData(this.validationPatch(errors), () => {
        if (epoch === api.accountEpoch() && this.data.errorField === field) wx.pageScrollTo?.({ selector: '#field-' + field, duration: 160 });
      });
      return;
    }
    const epoch = api.accountEpoch();
    this.setData({ busy: true, error: '', errorField: '', errorAction: '', fieldErrors: {} });
    try {
      await (this.data.id ? api.updateTopup(this.data.id, body) : api.createTopup(body));
      if (epoch === api.accountEpoch()) this.leave();
    } catch (err) { if (epoch === api.accountEpoch()) this.requestError(err.message || '保存尚未确认，请重试', 'save'); }
    finally { if (epoch === api.accountEpoch()) this.setData({ busy: false }); }
  },
  remove() {
    if (this.data.busy || this._confirming || !this.data.id || !this.data.form || this._epoch !== api.accountEpoch()) return;
    const epoch = api.accountEpoch();
    this._confirming = true;
    wx.showModal({ title: '删除记录', content: '只删除这条记录，不影响 DeepSeek 账户。', confirmText: '删除', confirmColor: '#FA5151',
      success: async result => {
        this._confirming = false;
        if (!result.confirm || this.data.busy || epoch !== api.accountEpoch()) return;
        this.setData({ busy: true, error: '', errorField: '', errorAction: '' });
        try { await api.deleteTopup(this.data.id); if (epoch === api.accountEpoch()) this.leave(); }
        catch (err) { if (epoch === api.accountEpoch()) this.requestError(err.message || '删除尚未确认，请重试', 'remove'); }
        finally { if (epoch === api.accountEpoch()) this.setData({ busy: false }); }
      }, complete: () => { this._confirming = false; } });
  },
});
