import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const authSource = readFileSync(new URL('../public/app/auth.js', import.meta.url), 'utf8');
const context = { module: { exports: {} }, URL, Uint8Array, Date };
vm.runInNewContext(authSource, context);
const Auth = context.module.exports;
const BASE = 'https://workup.oortcloudsmart.com:2443/bus/apaas-tokenrank';

/** 模拟浏览器导航和存储；任何新增登录网络请求都会使测试失败。 */
function browser(href = BASE + '/app/index.html#/me?period=week') {
  const stored = new Map(), session = new Map(), navigation = [], events = [];
  const storage = map => ({
    getItem: key => map.get(key) || null, setItem: (key, value) => map.set(key, value),
    removeItem: key => map.delete(key),
  });
  const root = {
    localStorage: storage(stored), sessionStorage: storage(session),
    crypto: { getRandomValues: values => values.fill(17) },
    location: { href, get hash() { return new URL(this.href).hash; }, assign: url => navigation.push(url) },
    history: { replaceState(state, title, path) {
      events.push('clean'); root.location.href = new URL(path, root.location.href).href;
    } },
    fetch() { throw new Error('前端跳转回调不应调用登录或业务接口'); },
  };
  return { root, api: Auth.create(root), navigation, stored, session, events };
}

/** 使用真实发起登录保存的 state 构造回调，不接受无请求上下文的结果。 */
async function callback(h, payload = 'access_token=platform-secret&tenant_id=t1') {
  await h.api.authorize();
  const state = new URL(h.navigation.at(-1)).searchParams.get('state');
  h.root.location.href = BASE + '/app/index.html?' + payload + '&state=' + state;
  return state;
}

test('未登录自动跳统一登录页，回调保留网关前缀并正确编码', async () => {
  const h = browser(); assert.equal(await h.api.login(), null);
  const login = new URL(h.navigation[0]);
  assert.equal(login.pathname, '/bus/apaas-web/loginPage/index.html');
  assert.equal(login.searchParams.get('redirect_uri'), BASE + '/app/index.html');
  assert.equal(login.searchParams.get('appname'), 'TokenRank');
  assert.match(login.searchParams.get('state'), /^[a-f0-9]{48}$/);
  assert.equal(login.hash, '');
  assert.equal(h.api.path('/api/me'), '/bus/apaas-tokenrank/api/me');
  assert.equal(h.api.appUrl, BASE + '/app/');
});

test('回调清除 URL 敏感参数，恢复原页面且不替换业务会话', async () => {
  const h = browser(); await callback(h);
  const data = await h.api.login();
  assert.equal(h.events[0], 'clean');
  assert.equal(h.root.location.href, BASE + '/app/index.html#/me?period=week');
  assert.equal(data.callback.accessToken, 'platform-secret');
  assert.equal(data.callback.tenantId, 't1'); assert.equal(data.callback.verified, false);
  assert.equal(h.api.callback(), data.callback);
  assert.equal(h.api.token(), ''); assert.equal(h.session.size, 0); assert.equal(h.stored.size, 0);
});

test('非法 state、过期和重放都被拒绝，并清除地址栏令牌', async () => {
  for (const mode of ['wrong', 'expired', 'replay']) {
    const h = browser(); const state = await callback(h);
    const key = [...h.session.keys()][0], pending = JSON.parse(h.session.get(key));
    if (mode === 'wrong') h.root.location.href = h.root.location.href.replace(state, 'wrong');
    if (mode === 'expired') { pending.created -= 660000; h.session.set(key, JSON.stringify(pending)); }
    if (mode === 'replay') {
      await h.api.login();
      h.root.location.href = BASE + '/app/index.html?access_token=secret&state=' + state;
    }
    await assert.rejects(h.api.login(), /state/);
    assert.equal(h.api.callback(), null);
    assert.doesNotMatch(h.root.location.href, /secret|access_token/);
    assert.equal(h.navigation.length, 1);
  }
});

test('兼容驼峰回调，取消授权保留重试入口且不循环重定向', async () => {
  const h = browser(); await callback(h, 'accessToken=secret&tenantId=t2');
  const received = await h.api.login(); assert.equal(received.callback.tenantId, 't2');
  await callback(h, 'error=access_denied');
  await assert.rejects(h.api.login(), /授权未完成/);
  assert.equal(h.navigation.length, 2);
  assert.doesNotMatch(h.root.location.href, /access_denied|state=/);
});

test('原业务会话仍有效，公开分享不跳登录，根路径和服务目录会话隔离', async () => {
  const h = browser();
  assert.equal(await h.api.login({ isPublic: true }), null); assert.equal(h.navigation.length, 0);
  const key = 'tr_token:' + new URL(BASE).origin + '/bus/apaas-tokenrank';
  h.stored.set(key, 'business-session');
  assert.equal((await h.api.login()).token, 'business-session'); assert.equal(h.navigation.length, 0);
  const root = Auth.create({ ...h.root, location: { href: 'https://local.test/app/' } });
  assert.equal(root.token(), ''); assert.equal(root.path('/api/me'), '/api/me');
  h.api.clear(); await h.api.login(); assert.equal(h.navigation.length, 1);
});

test('自定义测试环境登录地址不改变回调来源，非 HTTPS 配置拒绝跳转', async () => {
  const h = browser();
  h.root.TokenRankLoginConfig = { loginUrl: 'https://login.test/loginPage/index.html' };
  await h.api.authorize(); assert.equal(new URL(h.navigation[0]).origin, 'https://login.test');
  h.root.TokenRankLoginConfig.loginUrl = 'javascript:alert(1)';
  await assert.rejects(h.api.authorize(), /HTTPS/); assert.equal(h.navigation.length, 1);
});

test('真实前端启动收到回调后显示接收结果，不向原服务发送平台令牌', async () => {
  const h = browser(), html = []; await callback(h);
  const node = {
    addEventListener() {}, remove() {}, insertAdjacentHTML(position, value) { html.push(value); },
  };
  const sandbox = {
    ...h.root, URL, URLSearchParams, Uint8Array, Date,
    document: { querySelector: () => node, querySelectorAll: () => [], body: node, addEventListener() {} },
    addEventListener() {},
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox); vm.runInContext(authSource, sandbox);
  vm.runInContext(readFileSync(new URL('../public/app/model.js', import.meta.url), 'utf8'), sandbox);
  vm.runInContext(readFileSync(new URL('../public/app/app.js', import.meta.url), 'utf8'), sandbox);
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.match(html.join(''), /已收到统一登录回调/);
  assert.doesNotMatch(html.join(''), /platform-secret/);
  assert.equal(h.navigation.length, 1); assert.equal(h.stored.size, 0);
});

test('入口脚本使用相对路径并先加载登录模块', () => {
  const html = readFileSync(new URL('../public/app/index.html', import.meta.url), 'utf8');
  assert.doesNotMatch(html, /(?:src|href)="\/app\//);
  assert.ok(html.indexOf('./auth.js') < html.indexOf('./app.js'));
});

test('网关部署中的公开分享、分享链接及成就资源保留服务前缀', async () => {
  const h = browser(), paths = [], id = 'a'.repeat(24);
  const sandbox = { ...h.root, URL, Date, TokenRankAuth: h.api };
  sandbox.fetch = async path => {
    paths.push(path); return Response.json({ id, expires_at: Date.now() + 60000 });
  };
  vm.createContext(sandbox);
  for (const file of ['model.js', 'poster.js', 'share.js']) {
    vm.runInContext(readFileSync(new URL('../public/app/' + file, import.meta.url), 'utf8'), sandbox);
  }
  sandbox.TokenRankShare.configure({ baseUrl: h.api.appUrl, resolvePath: h.api.path });
  await sandbox.TokenRankShare.read(id);
  assert.equal(paths[0], '/bus/apaas-tokenrank/api/shares/' + id);
  assert.equal(sandbox.TokenRankShare.link(id), BASE + '/app/#/share/' + id);
  assert.match(sandbox.TokenRankModel.badgeArt({ art: 'terminal' }), /^\/bus\/apaas-tokenrank\/app\/assets\//);
});
