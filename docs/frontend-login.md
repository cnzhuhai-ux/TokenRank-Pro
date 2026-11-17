# 前端统一登录跳转与回调

## 本次范围

仅改前端，不新增或修改服务端接口、数据库、部署配置及业务鉴权。
登录页协议参考用户提供的 `references/login-page.md`。

## 访问流程

1. 未持有原 TokenRank 业务会话时访问应用，自动跳转统一登录页。
2. 登录地址携带 `appname=TokenRank`、编码后的 `redirect_uri` 和随机一次性 `state`。
3. 回调仍进入原 `app/index.html`，读取 `access_token`、`tenant_id`，也兼容驼峰命名。
4. 前端立即清除地址栏敏感参数，验证 state（有效期10分钟），恢复原 hash 页面及筛选条件。
5. 显示“已收到统一登录回调，业务接口统一鉴权待接入”，不再自动跳转，避免循环。

示例业务入口：

```text
https://workup.oortcloudsmart.com:2443/bus/apaas-tokenrank/app/index.html
```

默认统一登录页：

```text
https://workup.oortcloudsmart.com:2443/bus/apaas-web/loginPage/index.html
```

回调地址不携带业务 query 或 hash，原 hash 在当前标签页的 sessionStorage 保存并于回调恢复。
请让统一登录在当前标签页跳回；缺失、错误、过期或重复使用的 state 均会拒绝回调。
未登录访问公开分享不强制跳转；主动点击参与操作时才进入统一登录。

## 平台令牌与业务会话

平台回调只在内存中接收，不写入 localStorage、sessionStorage、页面或日志。
接收结果通过以下方法读取，不代表服务端已验证成功：

```js
const result = window.TokenRankAuth.callback()
// result: { accessToken, tenantId, verified: false }，未收到回调时为 null。
```

本次不校验或交换平台 token，不将其写入 `tr_token`，也不发送到原有 TokenRank 业务接口。
原业务会话存在时仍按既有流程访问页面；服务端验证及统一业务鉴权属于后续独立工作。
刷新已清除参数的回调页面会丢失内存结果，无业务会话时会重新发起登录。

## 网关路径与测试环境

静态资源采用相对路径，接口、分享链接和成就资源保留 `/bus/apaas-tokenrank` 前缀。
网关应继续使用原有服务转发规则；本次没有修改服务端的路由匹配或部署配置。
如需切换测试登录页，在加载 `auth.js` 前设置：

```html
<script>
  window.TokenRankLoginConfig = {
    loginUrl: 'https://workup-dev.myoumuamua.com:6433/bus/apaas-web/loginPage/index.html'
  }
</script>
```

## 验证

```powershell
node --test server/test/frontend-login.test.mjs server/test/feishu-app.test.mjs
```

覆盖自动跳转、回调路径、state 校验与重放拒绝、URL 清理、原页面恢复、匿名分享及真实前端启动。
上述30项通过；分享回归另有2项既有失败，已在未修改的 `1229bba` 基线复现：
二维码库字节数受换行符影响，以及分享全类型测试的夹具未提供所需用量记录。
