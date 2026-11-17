/* 仅负责统一登录页跳转和回调接收，不签发或替换业务会话。 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.TokenRankAuth = api.create(root);
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const LOGIN_URL = 'https://workup.oortcloudsmart.com:2443/bus/apaas-web/loginPage/index.html';
  const CALLBACK_KEYS = ['access_token', 'accessToken', 'tenant_id', 'tenantId', 'state', 'nonce', 'error'];

  /** 按部署目录隔离业务会话，兼容根路径和网关路径。 */
  function create(root) {
    const current = new URL(root.location.href);
    const prefix = current.pathname.match(/^(.*)\/app(?:\/(?:index\.html)?)?$/)?.[1] || '';
    const tokenKey = prefix ? `tr_token:${current.origin}${prefix}` : 'tr_token';
    const pendingKey = `tr_login_pending:${current.origin}${prefix}`;
    const path = value => prefix + value;
    const appUrl = current.origin + prefix + '/app/';
    let callbackResult = null;
    const token = () => root.localStorage.getItem(tokenKey) || '';
    const clear = () => root.localStorage.removeItem(tokenKey);

    /** 回调只表示收到登录结果，不把平台令牌当业务会话。 */
    async function login({ isPublic = false } = {}) {
      callbackResult = null;
      const callback = consumeCallback(root, pendingKey);
      if (callback) { callbackResult = callback; return { callback }; }
      if (token()) return { token: token() };
      if (!isPublic) await authorize(root, current, pendingKey);
      return null;
    }
    return {
      path, appUrl, token, clear, login, callback: () => callbackResult,
      authorize: () => { callbackResult = null; return authorize(root, current, pendingKey); },
    };
  }

  /** 一次性随机 state 绑定原页面；回调地址不携带查询或 hash。 */
  async function authorize(root, current, pendingKey) {
    const loginUrl = new URL(root.TokenRankLoginConfig?.loginUrl || LOGIN_URL);
    if (loginUrl.protocol !== 'https:') throw new Error('统一登录地址必须使用 HTTPS');
    const state = Array.from(root.crypto.getRandomValues(new Uint8Array(24)),
      value => value.toString(16).padStart(2, '0')).join('');
    root.sessionStorage.setItem(pendingKey, JSON.stringify({
      state, route: root.location.hash || '#/groups', created: Date.now(),
    }));
    loginUrl.searchParams.set('appname', 'TokenRank');
    loginUrl.searchParams.set('redirect_uri', current.origin + current.pathname);
    loginUrl.searchParams.set('state', state);
    root.location.assign(loginUrl.href);
  }

  /** 先移除地址栏凭证，再验证一次性 state；原始令牌仅保留在内存。 */
  function consumeCallback(root, pendingKey) {
    const url = new URL(root.location.href), q = url.searchParams;
    if (!['access_token', 'accessToken', 'tenant_id', 'tenantId', 'state', 'error'].some(key => q.has(key))) {
      return null;
    }
    const accessToken = q.get('access_token') || q.get('accessToken');
    const tenantId = q.get('tenant_id') || q.get('tenantId') || '';
    const returnedState = q.get('state'), error = q.get('error');
    let pending;
    try { pending = JSON.parse(root.sessionStorage.getItem(pendingKey)); } catch { /* 无效状态拒绝回调。 */ }
    root.sessionStorage.removeItem(pendingKey);
    for (const key of CALLBACK_KEYS) q.delete(key);
    url.hash = pending?.route?.startsWith('#/') ? pending.route : '#/groups';
    root.history.replaceState(null, '', url.pathname + url.search + url.hash);
    if (!pending?.state || returnedState !== pending.state ||
        Date.now() - pending.created > 600000 || !(pending.created <= Date.now())) {
      throw new Error('登录 state 校验失败或已过期，请重新登录');
    }
    if (error || !accessToken) throw new Error('登录授权未完成，请重新登录');
    return { accessToken, tenantId, verified: false };
  }

  return { create };
});
