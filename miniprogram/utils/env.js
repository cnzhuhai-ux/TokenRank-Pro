/**
 * 部署配置：小程序请求的服务端域名。
 *
 * 部署前必须把占位域名改成你自己的 HTTPS 域名，并同步配置微信后台的
 * request / uploadFile 合法域名。保留 example.com 占位时，网络请求会直接报错，
 * 避免把用户数据发到示例地址或上游作者的公网服务。
 *
 * 测试可通过自定义 require 注入 env 模块覆盖。
 */
const BASE_URL = 'https://tokenrank.example.com';

function isConfigured() {
  const match = /^https:\/\/([^/?#]+)/i.exec(String(BASE_URL));
  if (!match) return false;
  const host = match[1].toLowerCase().replace(/:\d+$/, '');
  return !!host && !/(^|\.)example\.(com|org|net)$/.test(host);
}

function assertConfigured() {
  if (!isConfigured()) throw new Error('小程序尚未配置服务端域名：请修改 miniprogram/utils/env.js 的 BASE_URL');
}

module.exports = { BASE_URL, isConfigured, assertConfigured };
