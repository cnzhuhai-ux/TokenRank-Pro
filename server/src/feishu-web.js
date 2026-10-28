/**
 * 飞书网页应用登录：OAuth 授权码 → 用户身份 → 复用 users/mp_sessions 会话体系。
 *
 * 流程：网页应用在前端跳转 open.feishu.cn 授权页（免登或一次性确认）→
 * 带 code 回跳 /app/ → 前端 POST /api/feishu/session {code} →
 * 这里用授权码换 user_access_token → 拉取 open_id/昵称/头像 →
 * 复用 bindAccount 建号（openid = 'feishu:<open_id>'，与机器人同一账号体系）→
 * 签发 mp_sessions 会话 token（30 天），网页端以 Bearer 调用既有 /api/*。
 */

const FEISHU_BASE = 'https://open.feishu.cn';

export function createFeishuWebService({ fetcher = (...args) => fetch(...args), now = () => Date.now() } = {}) {
  /** 网页端配置：授权页地址与回跳地址（redirect_uri 必须与授权请求一致） */
  function webConfig(env, origin) {
    const redirectUri = `${(env.PUBLIC_BASE_URL || origin).replace(/\/+$/, '')}/app/`;
    return {
      app_id: env.FEISHU_APP_ID || null,
      redirect_uri: redirectUri,
      authorize_url: env.FEISHU_APP_ID
        ? `${FEISHU_BASE}/open-apis/authen/v1/authorize?app_id=${encodeURIComponent(env.FEISHU_APP_ID)}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code`
        : null,
    };
  }

  async function exchangeCode(env, code) {
    let res;
    try {
      res = await fetcher(`${FEISHU_BASE}/open-apis/authen/v2/oauth2/token`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(10000),
        body: JSON.stringify({ grant_type: 'authorization_code', client_id: env.FEISHU_APP_ID,
          client_secret: env.FEISHU_APP_SECRET, code, redirect_uri: `${String(env.PUBLIC_BASE_URL || '').replace(/\/+$/, '')}/app/` }),
      });
    } catch { throw new Error('连接飞书服务超时，请稍后重试'); }
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.code !== 0 || !data.access_token) throw new Error('飞书登录失败，请重试');
    return data.access_token;
  }

  async function userInfo(env, userAccessToken) {
    let res;
    try {
      res = await fetcher(`${FEISHU_BASE}/open-apis/authen/v1/user_info`, {
        headers: { authorization: `Bearer ${userAccessToken}` }, signal: AbortSignal.timeout(10000),
      });
    } catch { throw new Error('连接飞书服务超时，请稍后重试'); }
    const data = await res.json().catch(() => ({}));
    const user = data?.data;
    if (!res.ok || data.code !== 0 || !user?.open_id) throw new Error('飞书登录态已过期，请重新登录');
    return { openId: user.open_id, name: user.name || '', avatarUrl: user.avatar_240 || user.avatar_96 || null };
  }

  return { webConfig, exchangeCode, userInfo };
}
