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
 *   host                 监听地址（默认 127.0.0.1；对外请用 HTTPS 反代）
 *   allow_insecure_http  host 非回环且确需明文 HTTP 时设为 true
 *   db_path              SQLite 路径（默认 ~/.tokenrank-server/tokenrank.db）
 *   public_origin        生成接入命令用的地址（默认 http://127.0.0.1:<port>）
 *   feishu_app_id / feishu_app_secret / feishu_verification_token（可选）
 *                        HTTP 回调必须配置 verification token 或 encrypt key
 */
import { createServer } from 'node:http';
import { createReadStream, existsSync, mkdirSync, readFileSync, chmodSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, extname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import worker from './src/worker.js';
import { openD1 } from './src/d1-node.mjs';

const ROOT = join(homedir(), '.tokenrank-server');
const configPath = process.env.TOKENRANK_SERVER_CONFIG || join(ROOT, 'config.json');
let fileConfig = {};
if (existsSync(configPath)) fileConfig = JSON.parse(readFileSync(configPath, 'utf8'));
const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost', '[::1]']);
const cfg = {
  port: Number(fileConfig.port || process.env.PORT || 8790),
  // 默认只监听回环地址；对外服务请用 nginx/caddy 终止 TLS 后反代到本机。
  host: fileConfig.host || process.env.TOKENRANK_HOST || '127.0.0.1',
  allowInsecureHttp: fileConfig.allow_insecure_http === true || process.env.TOKENRANK_ALLOW_INSECURE_HTTP === '1',
  dbPath: fileConfig.db_path || process.env.TOKENRANK_DB || join(ROOT, 'tokenrank.db'),
  publicOrigin: fileConfig.public_origin || process.env.PUBLIC_ORIGIN,
  feishuAppId: fileConfig.feishu_app_id || process.env.FEISHU_APP_ID,
  feishuAppSecret: fileConfig.feishu_app_secret || process.env.FEISHU_APP_SECRET,
  feishuVerificationToken: fileConfig.feishu_verification_token || process.env.FEISHU_VERIFICATION_TOKEN,
  feishuRemindersEnabled: fileConfig.feishu_reminders_enabled === true || process.env.FEISHU_REMINDERS_ENABLED === '1',
};
mkdirSync(ROOT, { recursive: true, mode: 0o700 });
if (process.platform !== 'win32') {
  // 配置里有飞书应用密钥，目录和文件只允许当前用户读取。
  try { chmodSync(ROOT, 0o700); } catch {}
  try { if (existsSync(configPath)) chmodSync(configPath, 0o600); } catch {}
}
if (!LOOPBACK.has(cfg.host) && !cfg.allowInsecureHttp) {
  console.error(`拒绝在 ${cfg.host} 上以明文 HTTP 监听。请保持 host=127.0.0.1 并用 HTTPS 反向代理，`);
  console.error('或确认风险后设置 TOKENRANK_ALLOW_INSECURE_HTTP=1。');
  process.exit(1);
}
if (!existsSync(cfg.dbPath)) {
  console.error(`数据库不存在：${cfg.dbPath}。请先用 schema.sql 初始化：`);
  console.error(`  node --experimental-strip-types -e "…" 或 sqlite3 ${cfg.dbPath} < schema.sql`);
  process.exit(1);
}
const env = {
  DB: openD1(cfg.dbPath),
  // 网页应用 OAuth 的 redirect_uri 依赖 PUBLIC_BASE_URL；Node 部署下默认取 public_origin，
  // 保证授权跳转与 token 交换两处地址一致（Cloudflare 部署用 wrangler vars，不受影响）
  PUBLIC_BASE_URL: process.env.PUBLIC_BASE_URL || cfg.publicOrigin,
  // 微信侧未部署：留空使 /api/wx/session 返回 503（不影响飞书与采集上报）
  WX_APPID: '', WX_REMINDERS_ENABLED: '0',
  FEISHU_REMINDERS_ENABLED: cfg.feishuRemindersEnabled ? '1' : '0',
  ...(cfg.feishuAppId ? { FEISHU_APP_ID: cfg.feishuAppId } : {}),
  ...(cfg.feishuAppSecret ? { FEISHU_APP_SECRET: cfg.feishuAppSecret } : {}),
  ...(cfg.feishuVerificationToken ? { FEISHU_VERIFICATION_TOKEN: cfg.feishuVerificationToken } : {}),
};
if (process.platform !== 'win32') { try { chmodSync(cfg.dbPath, 0o600); } catch {} }

const ctxOf = () => ({ waitUntil: (p) => { p.catch((err) => console.error('async:', err?.message)); } });
const MAX_BODY_BYTES = Number(process.env.TOKENRANK_MAX_BODY_BYTES || 1024 * 1024);
const SECURITY_HEADERS = { 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'x-frame-options': 'DENY' };
// 不信任客户端 Host，生成接入命令等 URL 时只使用显式配置的 public_origin。
const baseOrigin = cfg.publicOrigin || `http://127.0.0.1:${cfg.port}`;

// 安装脚本与分发包：只放行固定几种路径，其余一律走 API 路由。
// 白名单 + 目录归属校验，避免路径穿越；对外 TLS 由前置反代/Ingress 终止。
const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), 'public');
const STATIC_TYPES = {
  '.sh': 'text/x-shellscript; charset=utf-8',
  '.ps1': 'text/plain; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.sha256': 'text/plain; charset=utf-8',
  '.gz': 'application/gzip',
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  // Trae 采集扩展安装包：二进制流，安装脚本按 sha256 校验后落盘
  '.vsix': 'application/octet-stream',
};
const STATIC_ALLOW = [
  /^\/(?:install|update)(?:-trae)?\.(?:sh|ps1)$/,
  /^\/version\.txt$/,
  /^\/dl\/[\w.+-]+$/,
  // Trae 扩展分发：latest.json 指针 + 版本目录内的 vsix 与校验和
  /^\/dl\/trae-extension\/latest\.json$/,
  /^\/dl\/trae-extension\/[\w.]+\/[\w.+-]+\.(?:vsix|sha256)$/,
  /^\/releases\/[\w.]+\/[\w.+-]+$/,
  // 飞书网页应用（复刻小程序界面）：/app/ 入口与其静态资源
  /^\/app\/$/,
  /^\/app\/[\w-]+\.(?:html|css|js|svg|png)$/,
  /^\/app\/assets\/badges\/(?:tiers\/)?[\w-]+\.png$/,
  /^\/app\/vendor\/qrcode-generator-(?:1\.4\.4\.js|LICENSE\.txt)$/,
];
function staticFile(pathname) {
  if (!STATIC_ALLOW.some((re) => re.test(pathname))) return null;
  const rel = pathname.replace(/^\/+/, '');
  const candidates = rel.endsWith('/') ? [rel + 'index.html', rel.replace(/\/$/, '')] : [rel];
  for (const candidate of candidates) {
    const abs = join(PUBLIC_DIR, candidate);
    if (!abs.startsWith(PUBLIC_DIR + sep)) continue;
    try {
      const st = statSync(abs);
      if (st.isFile()) return { abs, size: st.size };
    } catch {
      // 尝试下一个候选
    }
  }
  return null;
}

const server = createServer(async (req, res) => {
  try {
    const declared = Number(req.headers['content-length'] || 0);
    if (declared > MAX_BODY_BYTES) {
      res.writeHead(413, { ...SECURITY_HEADERS, 'content-type': 'application/json', connection: 'close' });
      res.end(JSON.stringify({ error: 'payload too large' }));
      req.destroy();
      return;
    }
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        res.writeHead(413, { ...SECURITY_HEADERS, 'content-type': 'application/json', connection: 'close' });
        res.end(JSON.stringify({ error: 'payload too large' }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    }
    // 只接受 origin-form 路径，避免绝对形式请求绕过 public_origin 造成 Host 注入。
    const target = String(req.url || '/');
    if (req.method === 'GET' || req.method === 'HEAD') {
      const queryAt = target.indexOf('?');
      const pathname = queryAt === -1 ? target : target.slice(0, queryAt);
      // 飞书工作台入口配的是 /app（无尾斜杠）：补斜杠跳转，且保留 ?code=&state= 供 OAuth 换会话
      if (pathname === '/app') {
        res.writeHead(301, { ...SECURITY_HEADERS, location: '/app/' + (queryAt === -1 ? '' : target.slice(queryAt)) });
        res.end();
        return;
      }
      const hit = staticFile(pathname);
      if (hit) {
        res.writeHead(200, {
          ...SECURITY_HEADERS,
          'content-type': STATIC_TYPES[extname(hit.abs)] || 'application/octet-stream',
          'content-length': String(hit.size),
          'cache-control': 'no-store',
        });
        if (req.method === 'HEAD') { res.end(); return; }
        createReadStream(hit.abs).on('error', () => res.destroy()).pipe(res);
        return;
      }
    }
    const request = new Request(new URL(target.startsWith('/') ? target : '/', baseOrigin), {
      method: req.method,
      headers: req.headers,
      body: ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks),
    });
    const response = await worker.fetch(request, env, ctxOf());
    const headers = { ...SECURITY_HEADERS };
    response.headers.forEach((v, k) => { headers[k] = v; });
    res.writeHead(response.status, headers);
    if (response.body) for await (const chunk of response.body) res.write(chunk);
    res.end();
  } catch (err) {
    console.error('http:', err?.message);
    res.writeHead(500, { ...SECURITY_HEADERS, 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'internal error' }));
  }
});
server.requestTimeout = 30_000;
server.headersTimeout = 15_000;
server.keepAliveTimeout = 5_000;

server.listen(cfg.port, cfg.host, () => {
  console.log(`[tokenrank] http://${cfg.host}:${cfg.port}  db=${cfg.dbPath}`);
  if (!LOOPBACK.has(cfg.host)) console.warn('[tokenrank] 当前直接以明文 HTTP 对外监听，请确保前面有 HTTPS 反向代理。');
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
