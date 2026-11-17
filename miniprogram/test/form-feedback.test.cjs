const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm'), path = require('node:path');
const S = require('../utils/subscriptions');
const plain = value => JSON.parse(JSON.stringify(value));
const input = (field, value) => ({ currentTarget: { dataset: { field } }, detail: { value } });
const tap = dataset => ({ currentTarget: { dataset } });
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const record = { id: 'record', kind: 'topup', amount_minor: 2000, currency: 'USD', day: '2026-10-10', notes: '原备注' };
const item = { id: 'record', name: 'Claude', plan: 'Pro', price_minor: 2000, currency: 'USD', cycle: 'month', start_day: '2026-10-10', status: 'active', notes: '原备注', api_key: true };
const list = { items: [item], topups: [{ vendor: 'deepseek', currency: 'USD', records: [record] }] };

function fixture(page, overrides = {}, delayRender = false) {
  let definition, epoch = 0;
  const navigation = [], scrolls = [], guards = [], modals = [], saved = [], callbacks = [], redirects = [];
  const api = { accountEpoch: () => epoch, peekSubscriptions: () => null, subscriptions: async () => list,
    createSubscription: async body => saved.push(plain(body)), createTopup: async body => saved.push(plain(body)), ...overrides };
  const wx = { setNavigationBarTitle() {}, getStorageSync: () => 'CNY', showToast() {},
    enableAlertBeforeUnload: options => guards.push(options.message), disableAlertBeforeUnload: () => guards.push('off'),
    navigateBack: () => navigation.push('back'), pageScrollTo: options => scrolls.push(plain(options)), showModal: options => modals.push(options),
    redirectTo: options => redirects.push(options) };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../pages', page, page + '.js'), 'utf8'), {
    require: id => id.endsWith('/api') ? api : S, wx, Page: value => { definition = value; }, Date,
  });
  const p = { ...definition, data: plain(definition.data), setData(patch, done) {
    for (const [key, value] of Object.entries(patch)) {
      const parts = key.split('.'); let target = this.data;
      while (parts.length > 1) target = target[parts.shift()];
      target[parts[0]] = value;
    }
    if (done) { if (delayRender) callbacks.push(done); else done(); }
  } };
  return { p, navigation, scrolls, guards, modals, saved, redirects, api, changeAccount: () => { epoch++; },
    render() { while (callbacks.length) callbacks.shift()(); } };
}

function fill(p, page) {
  if (page === 'subscription-edit') { p.input(input('name', 'Claude')); p.input(input('price', '20')); }
  else p.input(input('amount', '20'));
}

test('订阅提交后先渲染全部就地错误，再按名称、价格、天数、日期顺序定位首错', async () => {
  const f = fixture('subscription-edit', {}, true), { p } = f;
  await p.onLoad();
  p.setData({ 'form.cycle': 'custom', 'form.custom_days': '0', 'form.start_day': '9999-01-01' });
  await p.save();
  assert.deepEqual(Object.keys(p.data.fieldErrors), ['name', 'price', 'custom_days', 'start_day']);
  assert.equal(p.data.errorField, 'name'); assert.equal(f.saved.length, 0); assert.equal(f.scrolls.length, 0);
  f.render(); assert.equal(f.scrolls.at(-1).selector, '#field-name');
  const steps = [['name', 'Claude', 'price'], ['price', '20', 'custom_days'], ['custom_days', '30', 'start_day']];
  for (const [field, value, next] of steps) {
    p.input(input(field, value));
    assert.equal(p.data.fieldErrors[field], undefined); assert.equal(p.data.errorField, next);
    await p.save(); f.render(); assert.equal(f.scrolls.at(-1).selector, '#field-' + next); assert.equal(f.saved.length, 0);
  }
  p.pickDate(input('start_day', p.data.today));
  assert.deepEqual(plain(p.data.fieldErrors), {}); assert.equal(p.data.error, '');
  p.pickCurrency({ detail: { value: '1' } });
  await p.save();
  assert.equal(f.saved[0].custom_days, 30); assert.equal(f.saved[0].currency, 'USD'); assert.equal(f.saved[0].start_day, p.data.today);
  assert.deepEqual(f.navigation, ['back']); assert.equal(f.guards.at(-1), 'off');
});

test('充值就地校验金额和日期；切为校准余额后 0 可保存，先定位金额再定位日期', async () => {
  const f = fixture('topup-edit', {}, true), { p } = f;
  await p.onLoad(); p.setData({ 'form.day': '9999-01-01' });
  await p.save(); assert.equal(f.scrolls.length, 0);
  assert.deepEqual(Object.keys(p.data.fieldErrors), ['amount', 'day']);
  f.render(); assert.equal(f.scrolls.at(-1).selector, '#field-amount');
  p.input(input('amount', '0')); assert.equal(p.data.errorField, 'amount');
  p.pickKind(tap({ key: 'balance' })); assert.equal(p.data.fieldErrors.amount, undefined);
  await p.save(); f.render(); assert.equal(f.scrolls.at(-1).selector, '#field-day'); assert.equal(f.saved.length, 0);
  p.pickDate({ detail: { value: p.data.today } }); await p.save();
  assert.equal(f.saved[0].amount, 0); assert.equal(f.saved[0].kind, 'balance'); assert.equal(f.saved[0].day, p.data.today);
  assert.deepEqual(f.navigation, ['back']); assert.equal(f.guards.at(-1), 'off');
});

test('失焦只校验操作过的字段；输入或切换类型即时更新已有错误，不清掉其他错误', async () => {
  const f = fixture('subscription-edit'), { p } = f;
  await p.onLoad(); p.validateField(input('name'));
  assert.deepEqual(Object.keys(p.data.fieldErrors), ['name']); assert.equal(f.scrolls.length, 0);
  p.input(input('price', 'abc')); p.validateField(input('price'));
  assert.deepEqual(Object.keys(p.data.fieldErrors), ['name', 'price']);
  p.input(input('name', 'Claude')); assert.deepEqual(Object.keys(p.data.fieldErrors), ['price']);
  p.pick(tap({ field: 'cycle', key: 'custom' })); p.input(input('custom_days', '0')); p.validateField(input('custom_days'));
  assert.ok(p.data.fieldErrors.custom_days);
  p.pick(tap({ field: 'cycle', key: 'month' })); assert.equal(p.data.fieldErrors.custom_days, undefined); assert.ok(p.data.fieldErrors.price);
  const g = fixture('topup-edit'); await g.p.onLoad(); g.p.validateField(input('amount'));
  assert.equal(g.p.data.fieldErrors.amount, '请填写有效的充值金额');
  g.p.pickKind(tap({ key: 'balance' })); assert.equal(g.p.data.fieldErrors.amount, '请填写有效的余额');
});

for (const page of ['subscription-edit', 'topup-edit']) {
  test(page + ' 保存失败保留输入和离开提醒，渲染后滚到页顶，重试保持原保存方式', async () => {
    const bodies = [], method = page === 'subscription-edit' ? 'createSubscription' : 'createTopup';
    const f = fixture(page, { [method]: async body => { bodies.push(plain(body)); if (bodies.length === 1) throw Error('网络中断，请重试'); } }, true), { p } = f;
    await p.onLoad(); fill(p, page); p.input(input('notes', '保留输入'));
    const before = plain(p.data.form);
    await (page === 'subscription-edit' ? p.saveAndNext() : p.save());
    assert.equal(p.data.errorAction, 'save'); assert.equal(p.data.errorField, ''); assert.equal(p.data.busy, false);
    assert.deepEqual(plain(p.data.form), before); assert.equal(f.guards.length, 1); assert.equal(f.navigation.length, 0); assert.equal(f.scrolls.length, 0);
    p.validateField(input(page === 'subscription-edit' ? 'price' : 'amount'));
    assert.equal(p.data.errorAction, 'save');
    f.render(); assert.equal(f.scrolls.at(-1).scrollTop, 0);
    await p.retry();
    assert.deepEqual(bodies[1], bodies[0]); assert.equal(p.data.error, ''); assert.equal(f.guards.at(-1), 'off');
    if (page === 'subscription-edit') { assert.equal(p.data.added, 1); assert.equal(p.data.form.name, ''); assert.equal(f.navigation.length, 0); }
    else assert.deepEqual(f.navigation, ['back']);
  });

  test(page + ' 读取失败可强制重试，重复重试只读一次，成功后恢复原币日期', async () => {
    const pending = deferred(), forces = [];
    const f = fixture(page, { subscriptions: async options => { forces.push(options.force); if (forces.length === 1) throw Error('读取失败'); return pending.promise; } }), { p } = f;
    await p.onLoad({ id: 'record' }); assert.equal(p.data.errorAction, 'load'); assert.equal(p.data.loading, false); assert.equal(p.data.form, null);
    const retry = p.retry(); await p.retry(); assert.deepEqual(forces, [false, true]);
    pending.resolve(list); await retry;
    assert.equal(p.data.loading, false); assert.equal(p.data.error, ''); assert.equal(p.data.form.currency, 'USD');
    assert.equal(p.data.form[page === 'subscription-edit' ? 'start_day' : 'day'], '2026-10-10');
    assert.equal(f.guards.length, 0);
  });

  test(page + ' 保存期间锁定输入和选择，重复保存只发一次请求', async () => {
    const pending = deferred(), bodies = [], method = page === 'subscription-edit' ? 'createSubscription' : 'createTopup';
    const f = fixture(page, { [method]: body => { bodies.push(plain(body)); return pending.promise; } }), { p } = f;
    await p.onLoad(); fill(p, page); const before = plain(p.data.form), saving = p.save();
    assert.equal(p.data.busy, true); p.input(input('notes', '不能写入')); p.pickCurrency({ detail: { value: '1' } });
    if (page === 'subscription-edit') {
      p.pick(tap({ field: 'cycle', key: 'year' })); p.pickDate(input('start_day', '2026-01-01'));
      p.toggleApiKey({ detail: { value: true } }); p.choosePreset(tap({ index: 0 })); p.goTopup(); await p.saveAndNext();
    } else { p.pickKind(tap({ key: 'balance' })); p.pickDate({ detail: { value: '2026-01-01' } }); }
    await p.save(); await p.retry();
    assert.deepEqual(plain(p.data.form), before); assert.equal(bodies.length, 1); assert.equal(f.redirects.length, 0);
    pending.resolve(); await saving; assert.equal(p.data.busy, false); assert.deepEqual(f.navigation, ['back']);
  });

  for (const rejected of [false, true]) {
    test(page + ' 账号切换后忽略迟到的读取' + (rejected ? '错误' : '成功'), async () => {
      const pending = deferred(), f = fixture(page, { subscriptions: () => pending.promise }), { p } = f;
      const loading = p.onLoad({ id: 'record' }); f.changeAccount();
      if (rejected) pending.reject(Error('旧账号错误')); else pending.resolve(list);
      await loading; assert.equal(p.data.form, null); assert.equal(p.data.error, ''); assert.equal(f.scrolls.length, 0);
    });

    test(page + ' 账号切换后忽略迟到的保存' + (rejected ? '错误' : '成功') + '，也阻止旧表单再次提交', async () => {
      const pending = deferred(), method = page === 'subscription-edit' ? 'createSubscription' : 'createTopup'; let calls = 0;
      const f = fixture(page, { [method]: () => { calls++; return pending.promise; } }), { p } = f;
      await p.onLoad(); fill(p, page); const before = plain(p.data.form), saving = p.save(); f.changeAccount();
      if (rejected) pending.reject(Error('旧账号错误')); else pending.resolve();
      await saving; assert.equal(p.data.error, ''); assert.equal(f.navigation.length, 0); assert.equal(f.scrolls.length, 0);
      p.input(input('notes', '不能跨账号修改')); await p.save(); assert.deepEqual(plain(p.data.form), before); assert.equal(calls, 1);
    });
  }

  test(page + ' 旧错误的渲染回调不会在修正字段、开始重试或切换账号后滚动', async () => {
    const field = page === 'subscription-edit' ? 'name' : 'amount';
    const f = fixture(page, {}, true); await f.p.onLoad(); await f.p.save();
    f.p.input(input(field, page === 'subscription-edit' ? 'Claude' : '20')); f.render(); assert.equal(f.scrolls.length, 0);
    const g = fixture(page, {}, true); await g.p.onLoad(); await g.p.save(); g.changeAccount(); g.render(); assert.equal(g.scrolls.length, 0);
    const method = page === 'subscription-edit' ? 'createSubscription' : 'createTopup';
    const pending = deferred(); let calls = 0;
    const h = fixture(page, { [method]: async () => { if (++calls === 1) throw Error('读取超时'); return pending.promise; } }, true);
    await h.p.onLoad(); fill(h.p, page); await h.p.save(); const retry = h.p.retry(); h.render();
    assert.equal(h.scrolls.length, 0); pending.resolve(); await retry;
    const k = fixture(page, { [method]: async () => { throw Error('旧请求错误'); } }, true);
    await k.p.onLoad(); fill(k.p, page); await k.p.save(); k.changeAccount(); k.render(); assert.equal(k.scrolls.length, 0);
  });

  test(page + ' 删除保留确认，重复点击只弹一次，失败后重试仍需确认，成功解除离开提醒', async () => {
    let deletes = 0;
    const method = page === 'subscription-edit' ? 'deleteSubscription' : 'deleteTopup';
    const f = fixture(page, { peekSubscriptions: () => list, [method]: async id => { assert.equal(id, 'record'); if (++deletes === 1) throw Error('删除失败'); } }), { p } = f;
    await p.onLoad({ id: 'record' }); p.input(input('notes', '未保存备注'));
    p.remove(); p.remove(); assert.equal(f.modals.length, 1); assert.equal(deletes, 0);
    await f.modals[0].success({ confirm: false }); assert.equal(deletes, 0);
    p.remove(); await f.modals[1].success({ confirm: true });
    assert.equal(p.data.errorAction, 'remove'); assert.equal(deletes, 1); assert.equal(p.data.form.notes, '未保存备注'); assert.equal(f.navigation.length, 0);
    p.retry(); assert.equal(f.modals.length, 3); assert.equal(deletes, 1);
    await f.modals[2].success({ confirm: true }); assert.equal(deletes, 2); assert.deepEqual(f.navigation, ['back']); assert.equal(f.guards.at(-1), 'off');
  });

  test(page + ' 删除确认期间切换账号后不删除旧记录', async () => {
    const method = page === 'subscription-edit' ? 'deleteSubscription' : 'deleteTopup'; let deletes = 0;
    const f = fixture(page, { peekSubscriptions: () => list, [method]: async () => { deletes++; } }), { p } = f;
    await p.onLoad({ id: 'record' }); p.remove(); f.changeAccount(); await f.modals[0].success({ confirm: true });
    assert.equal(deletes, 0); assert.equal(f.navigation.length, 0);
  });
}

test('套餐弹层取消不改输入；选择期间锁定重复操作，渲染后恢复；当前套餐有 selected 状态', async () => {
  const f = fixture('subscription-edit', {}, true), { p } = f;
  await p.onLoad(); const before = plain(p.data.form);
  p.choosePreset(tap({ index: 0 })); assert.equal(p.data.sheet.name, 'Claude');
  p.choosePreset(tap({ index: 1 })); assert.equal(p.data.sheet.name, 'Claude'); await p.save(); assert.equal(f.saved.length, 0);
  p.closeSheet(); assert.equal(p.data.sheet, null); assert.deepEqual(plain(p.data.form), before); assert.equal(f.guards.length, 0);
  p.choosePlan(tap({ index: 0 })); assert.deepEqual(plain(p.data.form), before);
  p.choosePreset(tap({ index: 0 })); p.choosePlan(tap({ index: 0 }));
  assert.equal(p.data.sheet, null); assert.equal(p.data.sheetBusy, true); assert.equal(p.data.form.name, 'Claude'); assert.equal(p.data.form.price, '20');
  p.choosePlan(tap({ index: 3 })); p.choosePreset(tap({ index: 1 })); await p.save();
  assert.equal(p.data.form.price, '20'); assert.equal(p.data.sheet, null); assert.equal(f.saved.length, 0);
  f.render(); assert.equal(p.data.sheetBusy, false); assert.equal(f.guards.length, 1);
  p.choosePreset(tap({ index: 0 })); assert.equal(p.data.sheet.plans[0].selected, true); assert.equal(p.data.sheet.plans[1].selected, false); p.closeSheet();
  p.input(input('price', '21')); assert.equal(p.data.selected, '');
});

test('按量充值跳转防重复操作，跳转结束后可再次使用', async () => {
  const f = fixture('subscription-edit'); await f.p.onLoad(); f.p.goTopup(); f.p.goTopup();
  assert.equal(f.redirects.length, 1); assert.match(f.redirects[0].url, /topup-edit\?vendor=deepseek$/);
  f.redirects[0].complete(); f.p.goTopup(); assert.equal(f.redirects.length, 2);
});
