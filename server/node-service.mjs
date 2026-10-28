/**
 * Token 群排名 · Node 单进程部署入口（方案 A：本机/自有服务器，不依赖 Cloudflare）。
 *
 * 组成：
 *   - HTTP 服务：复用 server/src/worker.js 的全部路由（同步客户端上报 / 管理接口）
 *   - 定时任务：每 5 分钟跑一次 worker.scheduled（消息提醒等）
 *   - 飞书长连接：@larksuiteoapi/node-sdk 的 WSClient 主动连出收事件，
 *     不需要公网回调地址；事件直接进 feishu.js 的 dispatch
 *
 * 配置（~/.tokenrank-server/config.json 或环境变量，文件优先）：
 *   port                 监听端口（默认 8790）
 *   db_path              SQLite 路径（默认 ~/.tokenrank-server/tokenrank.db）
 *   feishu_app_id / feishu_app_secret / feishu_verification_token（可选）
 *   public_origin        生成接入命令用的地址（默认 http://127.0.0.1:<port>）
 */
import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import worker from './src/worker.js';
import { openD1 } from './src/d1-node.mjs';

const ROOT = join(homedir(), '.tokenrank-server');
const configPath = process.env.TOKENRANK_SERVER_CONFIG || join(ROOT, 'config.json');
let fileConfig = {};
if (existsSync(configPath)) fileConfig = JSON.parse(readFileSync(configPath, 'utf8'));
const cfg = {
  port: Number(fileConfig.port || process.env.PORT || 8790),
  dbPath: fileConfig.db_path || process.env.TOKENRANK_DB || join(ROOT, 'tokenrank.db'),
  publicOrigin: fileConfig.public_origin || process.env.PUBLIC_ORIGIN,
  feishuAppId: fileConfig.feishu_app_id || process.env.FEISHU_APP_ID,
  feishuAppSecret: fileConfig.feishu_app_secret || process.env.FEISHU_APP_SECRET,
  feishuVerificationToken: fileConfig.feishu_verification_token || process.env.FEISHU_VERIFICATION_TOKEN,
};
mkdirSync(ROOT, { recursive: true });
if (!existsSync(cfg.dbPath)) {
  console.error(`数据库不存在：${cfg.dbPath}。请先用 schema.sql 初始化：`);
  console.error(`  node --experimental-strip-types -e "…" 或 sqlite3 ${cfg.dbPath} < schema.sql`);
  process.exit(1);
}
const env = {
  DB: openD1(cfg.dbPath),
  // 微信侧未部署：留空使 /api/wx/session 返回 503（不影响飞书与采集上报）
  WX_APPID: '', WX_REMINDERS_ENABLED: '0',
  ...(cfg.feishuAppId ? { FEISHU_APP_ID: cfg.feishuAppId } : {}),
  ...(cfg.feishuAppSecret ? { FEISHU_APP_SECRET: cfg.feishuAppSecret } : {}),
  ...(cfg.feishuVerificationToken ? { FEISHU_VERIFICATION_TOKEN: cfg.feishuVerificationToken } : {}),
};

const ctxOf = () => ({ waitUntil: (p) => { p.catch((err) => console.error('async:', err?.message)); } });

const server = createServer(async (req, res) => {
  try {
    const url = `http://${req.headers.host || '127.0.0.1'}${req.url}`;
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const request = new Request(url, {
      method: req.method,
      headers: req.headers,
      body: ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks),
    });
    const response = await worker.fetch(request, env, ctxOf());
    const headers = {};
    response.headers.forEach((v, k) => { headers[k] = v; });
    res.writeHead(response.status, headers);
    if (response.body) for await (const chunk of response.body) res.write(chunk);
    res.end();
  } catch (err) {
    console.error('http:', err?.message);
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'internal error' }));
  }
});

server.listen(cfg.port, '0.0.0.0', () => {
  console.log(`[tokenrank] http://0.0.0.0:${cfg.port}  db=${cfg.dbPath}`);
});

// 定时任务：对齐 Worker 的 */5 cron
setInterval(() => {
  worker.scheduled({ cron: '*/5 * * * *' }, env, ctxOf()).catch((err) => console.error('cron:', err?.message));
}, 5 * 60 * 1000).unref();

// 飞书长连接：出站 WebSocket 收事件，不需要公网回调地址
if (cfg.feishuAppId && cfg.feishuAppSecret) {
  const { feishu } = await import('./src/feishu.js');
  const origin = cfg.publicOrigin || `http://127.0.0.1:${cfg.port}`;
  try {
    const lark = await import('@larksuiteoapi/node-sdk');
    const wsClient = new lark.WSClient({ appId: cfg.feishuAppId, appSecret: cfg.feishuAppSecret, loggerLevel: lark.LoggerLevel.info });
    await wsClient.start({
      eventDispatcher: new lark.EventDispatcher({}).register({
        'im.message.receive_v1': async (data) => {
          try {
            await feishu._internals.dispatch(env, origin, data?.event ?? data);
          } catch (err) {
            console.error('feishu dispatch:', err?.message);
          }
        },
      }),
    });
    console.log(`[tokenrank] 飞书长连接已启动 app=${cfg.feishuAppId}`);
  } catch (err) {
    console.error('飞书长连接启动失败（HTTP 服务不受影响）:', err?.message);
  }
} else {
  console.log('[tokenrank] 未配置飞书凭证，跳过长连接');
}
