-- 「Token 群排名」D1 表结构（部署见 wrangler.toml.example 注释）
-- 原则：只存聚合数字、微信资料和用户自愿登记的私有邮箱，无原始明细、无 IP、无设备指纹。

-- 用户：openid 为唯一锚点（微信 wx.login → code2session；飞书用户为 'feishu:<open_id>'）
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  openid TEXT NOT NULL UNIQUE,
  nickname TEXT,
  avatar_path TEXT,
  avatar_url TEXT,                           -- 外链头像 URL（飞书资料头像，仅作展示）
  session_key TEXT,                          -- 微信会话密钥（解密 getGroupEnterInfo 用，永不返回）
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  disabled_at INTEGER,                      -- 后台停用：不上榜、拒绝上传，数据保留
  disabled_reason TEXT,
  rank_hidden INTEGER NOT NULL DEFAULT 0     -- 用户关闭排名：自己可见用量，不上任何榜
);

-- 小程序会话：随机 token，30 天有效
CREATE TABLE IF NOT EXISTS user_avatars (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  content BLOB NOT NULL,
  mime_type TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS mp_sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mp_sessions_user ON mp_sessions(user_id);

-- 采集接入码：客户端 Bearer 凭证；每用户一个活跃码（重置即作废旧码）
CREATE TABLE IF NOT EXISTS connect_tokens (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  device_id TEXT,                            -- 客户端自报随机设备 id（仅排查用，非指纹）
  created_at INTEGER NOT NULL,
  last_report_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_connect_user ON connect_tokens(user_id);

-- 一个真实微信群对应一张榜：只通过解密的群身份建立绑定和成员关系。
CREATE TABLE IF NOT EXISTS rank_groups (
  id TEXT PRIMARY KEY,                       -- 8 位随机短 id
  name TEXT NOT NULL,
  owner_user_id INTEGER NOT NULL,
  group_openid_hash TEXT,                    -- 微信群匿名标识哈希；空值仅兼容历史手动群
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_groups_oidhash ON rank_groups(group_openid_hash);
CREATE UNIQUE INDEX IF NOT EXISTS uq_groups_wechat_identity ON rank_groups(group_openid_hash) WHERE group_openid_hash IS NOT NULL;
CREATE TABLE IF NOT EXISTS rank_group_members (
  group_id TEXT NOT NULL,
  user_id INTEGER NOT NULL,
  joined_at INTEGER NOT NULL,
  hidden INTEGER NOT NULL DEFAULT 0,          -- 成员在本群隐藏自己的排名
  PRIMARY KEY (group_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_members_user ON rank_group_members(user_id);

-- 日桶：客户端按天上报；同日重报取 MAX（水位，防删本地日志回退榜单）
-- models_json / tools_json 为 [[名称, 当日该维 tokens], ...] ≤8 条，绝对量便于跨天聚合
CREATE TABLE IF NOT EXISTS daily_stats (
  user_id INTEGER NOT NULL,
  day TEXT NOT NULL,                         -- UTC YYYY-MM-DD
  tokens INTEGER NOT NULL DEFAULT 0,         -- input+output（不含缓存）
  cache_read INTEGER NOT NULL DEFAULT 0,
  cache_write INTEGER NOT NULL DEFAULT 0,
  requests INTEGER NOT NULL DEFAULT 0,
  models_json TEXT,
  tools_json TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, day)
);
CREATE INDEX IF NOT EXISTS idx_daily_day ON daily_stats(day);
CREATE TABLE IF NOT EXISTS usage_shares (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  fingerprint TEXT NOT NULL,
  snapshot_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER,
  UNIQUE(user_id, fingerprint)
);
CREATE INDEX IF NOT EXISTS idx_usage_shares_owner_time ON usage_shares(user_id, created_at);

-- Preserve the legacy UTC/input-output rows. Only fully initialized v2 sources enter rankings.
CREATE TABLE IF NOT EXISTS daily_totals (
  user_id INTEGER NOT NULL,
  device_id TEXT NOT NULL,
  day TEXT NOT NULL,
  tokens INTEGER NOT NULL,
  input_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  cache_read INTEGER NOT NULL,
  cache_write INTEGER NOT NULL,
  requests INTEGER NOT NULL,
  models_json TEXT NOT NULL,
  tools_json TEXT NOT NULL,
  source_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  cost_json TEXT,
  credits_json TEXT,
  tool_models_json TEXT,                    -- [[工具, 模型, tokens]]，旧同步器为 NULL
  PRIMARY KEY (user_id, device_id, day)
);
CREATE INDEX IF NOT EXISTS idx_totals_day ON daily_totals(day);
CREATE TABLE IF NOT EXISTS usage_sync_state (
  user_id INTEGER PRIMARY KEY,
  device_id TEXT NOT NULL,
  source_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
-- 每台电脑一条：同一接入码可同时接入多台电脑，active=1 的设备按天相加。
-- active 仍只在首次完整上报后置 1，避免上传到一半的历史提前进入榜单。
CREATE TABLE IF NOT EXISTS usage_device_state (
  user_id INTEGER NOT NULL,
  device_id TEXT NOT NULL,
  source_at INTEGER NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  last_report_at INTEGER,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, device_id)
);
CREATE INDEX IF NOT EXISTS idx_device_state_user ON usage_device_state(user_id);
-- 单台设备聚合为一行：数字相加，models/tools 取前 8、tool_models 取前 128，
-- cost/credits 合并为同一 JSON 形状，读取侧无需区分单设备还是多设备。
CREATE VIEW IF NOT EXISTS ranked_usage AS
SELECT d.user_id, d.day,
  SUM(d.tokens) AS tokens,
  SUM(d.input_tokens) AS input_tokens,
  SUM(d.output_tokens) AS output_tokens,
  SUM(d.cache_read) AS cache_read,
  SUM(d.cache_write) AS cache_write,
  SUM(d.requests) AS requests,
  (SELECT COALESCE(json_group_array(json_array(name, t)), '[]') FROM (
     SELECT json_extract(CASE WHEN je.type='array' THEN je.value ELSE '[]' END, '$[0]') AS name, SUM(json_extract(CASE WHEN je.type='array' THEN je.value ELSE '[]' END, '$[1]')) AS t
     FROM daily_totals x
     JOIN usage_device_state sx ON sx.user_id=x.user_id AND sx.device_id=x.device_id AND sx.active=1,
       json_each(CASE WHEN json_valid(x.models_json) THEN CASE WHEN json_type(x.models_json)='array' THEN x.models_json ELSE '[]' END ELSE '[]' END) je
     WHERE x.user_id=d.user_id AND x.day=d.day AND json_valid(x.models_json)
     GROUP BY name ORDER BY t DESC, name LIMIT 8)) AS models_json,
  (SELECT COALESCE(json_group_array(json_array(name, t)), '[]') FROM (
     SELECT json_extract(CASE WHEN je.type='array' THEN je.value ELSE '[]' END, '$[0]') AS name, SUM(json_extract(CASE WHEN je.type='array' THEN je.value ELSE '[]' END, '$[1]')) AS t
     FROM daily_totals x
     JOIN usage_device_state sx ON sx.user_id=x.user_id AND sx.device_id=x.device_id AND sx.active=1,
       json_each(CASE WHEN json_valid(x.tools_json) THEN CASE WHEN json_type(x.tools_json)='array' THEN x.tools_json ELSE '[]' END ELSE '[]' END) je
     WHERE x.user_id=d.user_id AND x.day=d.day AND json_valid(x.tools_json)
     GROUP BY name ORDER BY t DESC, name LIMIT 8)) AS tools_json,
  MAX(d.source_at) AS source_at,
  MAX(d.updated_at) AS updated_at,
  CASE WHEN COUNT(CASE WHEN json_valid(d.cost_json) THEN 1 END)=0 THEN NULL ELSE json_object(
    'basis', 'token_watcher_api_estimate', 'currency', 'USD',
    'usd_micros', SUM(CASE WHEN json_valid(d.cost_json) THEN json_extract(d.cost_json, '$.usd_micros') ELSE 0 END),
    'models', (SELECT COALESCE(json_group_array(json_array(name, amt)), '[]') FROM (
       SELECT json_extract(CASE WHEN je.type='array' THEN je.value ELSE '[]' END, '$[0]') AS name, SUM(json_extract(CASE WHEN je.type='array' THEN je.value ELSE '[]' END, '$[1]')) AS amt
       FROM daily_totals x
       JOIN usage_device_state sx ON sx.user_id=x.user_id AND sx.device_id=x.device_id AND sx.active=1,
         json_each(CASE WHEN json_valid(x.cost_json) THEN x.cost_json ELSE '{}' END, '$.models') je
       WHERE x.user_id=d.user_id AND x.day=d.day AND json_valid(x.cost_json) AND x.cost_json IS NOT NULL
       GROUP BY name ORDER BY amt DESC, name)),
    'unpriced_models', (SELECT COALESCE(json_group_array(name), '[]') FROM (
       SELECT DISTINCT je.value AS name
       FROM daily_totals x
       JOIN usage_device_state sx ON sx.user_id=x.user_id AND sx.device_id=x.device_id AND sx.active=1,
         json_each(CASE WHEN json_valid(x.cost_json) THEN x.cost_json ELSE '{}' END, '$.unpriced_models') je
       WHERE x.user_id=d.user_id AND x.day=d.day AND json_valid(x.cost_json) AND x.cost_json IS NOT NULL ORDER BY name)),
    'unpriced_tokens', SUM(CASE WHEN json_valid(d.cost_json) THEN json_extract(d.cost_json, '$.unpriced_tokens') ELSE 0 END)
  ) END AS cost_json,
  CASE WHEN COUNT(CASE WHEN json_valid(d.tool_models_json) THEN 1 END)=0 THEN NULL ELSE (
    SELECT COALESCE(json_group_array(json_array(tool, model, t)), '[]') FROM (
       SELECT json_extract(CASE WHEN je.type='array' THEN je.value ELSE '[]' END, '$[0]') AS tool, json_extract(CASE WHEN je.type='array' THEN je.value ELSE '[]' END, '$[1]') AS model,
         SUM(json_extract(CASE WHEN je.type='array' THEN je.value ELSE '[]' END, '$[2]')) AS t
       FROM daily_totals x
       JOIN usage_device_state sx ON sx.user_id=x.user_id AND sx.device_id=x.device_id AND sx.active=1,
         json_each(CASE WHEN json_valid(x.tool_models_json) THEN CASE WHEN json_type(x.tool_models_json)='array' THEN x.tool_models_json ELSE '[]' END ELSE '[]' END) je
       WHERE x.user_id=d.user_id AND x.day=d.day AND json_valid(x.tool_models_json) AND x.tool_models_json IS NOT NULL
       GROUP BY tool, model ORDER BY t DESC, tool, model LIMIT 128)) END AS tool_models_json,
  CASE WHEN COUNT(CASE WHEN json_valid(d.credits_json) THEN 1 END)=0 THEN NULL ELSE json_object(
    'total', ROUND(SUM(CASE WHEN json_valid(d.credits_json) THEN json_extract(d.credits_json, '$.total') ELSE 0 END), 6),
    'tools', (SELECT COALESCE(json_group_array(json_array(name, amt)), '[]') FROM (
       SELECT json_extract(CASE WHEN je.type='array' THEN je.value ELSE '[]' END, '$[0]') AS name, SUM(json_extract(CASE WHEN je.type='array' THEN je.value ELSE '[]' END, '$[1]')) AS amt
       FROM daily_totals x
       JOIN usage_device_state sx ON sx.user_id=x.user_id AND sx.device_id=x.device_id AND sx.active=1,
         json_each(CASE WHEN json_valid(x.credits_json) THEN x.credits_json ELSE '{}' END, '$.tools') je
       WHERE x.user_id=d.user_id AND x.day=d.day AND json_valid(x.credits_json) AND x.credits_json IS NOT NULL
       GROUP BY name ORDER BY amt DESC, name))
  ) END AS credits_json
FROM daily_totals d
JOIN usage_device_state s ON s.user_id=d.user_id AND s.device_id=d.device_id AND s.active=1
JOIN users usr ON usr.id=d.user_id AND usr.disabled_at IS NULL
GROUP BY d.user_id, d.day;
CREATE VIEW IF NOT EXISTS public_usage AS
  SELECT r.* FROM ranked_usage r JOIN users u ON u.id = r.user_id AND u.rank_hidden = 0;

-- usage_sync_state 仍是「账号最近一次完整上报」的摘要；写入时镜像到设备表，
-- 让旧代码与测试夹具无需改动即可让该设备生效。
CREATE TRIGGER IF NOT EXISTS usage_sync_state_device_insert AFTER INSERT ON usage_sync_state
BEGIN
  INSERT INTO usage_device_state (user_id, device_id, source_at, active, last_report_at, updated_at)
  VALUES (NEW.user_id, NEW.device_id, NEW.source_at, 1, NULL, NEW.updated_at)
  ON CONFLICT(user_id, device_id) DO UPDATE SET active=1,
    source_at=CASE WHEN NEW.source_at>source_at THEN NEW.source_at ELSE source_at END,
    updated_at=CASE WHEN NEW.updated_at>updated_at THEN NEW.updated_at ELSE updated_at END;
END;
CREATE TRIGGER IF NOT EXISTS usage_sync_state_device_update AFTER UPDATE OF device_id, source_at ON usage_sync_state
BEGIN
  INSERT INTO usage_device_state (user_id, device_id, source_at, active, last_report_at, updated_at)
  VALUES (NEW.user_id, NEW.device_id, NEW.source_at, 1, NULL, NEW.updated_at)
  ON CONFLICT(user_id, device_id) DO UPDATE SET active=1,
    source_at=CASE WHEN NEW.source_at>source_at THEN NEW.source_at ELSE source_at END,
    updated_at=CASE WHEN NEW.updated_at>updated_at THEN NEW.updated_at ELSE updated_at END;
END;

-- Stage complete per-account snapshots; existing rankings stay visible until commit.
CREATE TABLE IF NOT EXISTS usage_replacements (
  user_id INTEGER PRIMARY KEY,
  id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  source_at INTEGER NOT NULL,
  total_days INTEGER NOT NULL,
  batch_count INTEGER NOT NULL,
  client_version TEXT NOT NULL,
  collector_version TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('collecting','committing','complete')),
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS usage_replacement_chunks (
  user_id INTEGER NOT NULL,
  replacement_id TEXT NOT NULL,
  batch_index INTEGER NOT NULL,
  digest TEXT NOT NULL,
  days_json TEXT NOT NULL,
  PRIMARY KEY(user_id,replacement_id,batch_index)
);
CREATE TABLE IF NOT EXISTS usage_rebuild_guard (
  user_id INTEGER PRIMARY KEY,
  client_version TEXT NOT NULL,
  collector_version TEXT NOT NULL,
  source_at INTEGER NOT NULL
);

-- Prevent in-flight requests from recreating data after account deletion.
-- Legacy tables have no foreign keys. These guards apply at the write boundary,
-- including INSERT ... ON CONFLICT and batches; no tombstone or user identifier is retained.
CREATE TRIGGER IF NOT EXISTS user_avatars_account_insert
BEFORE INSERT ON user_avatars
WHEN NOT EXISTS (SELECT 1 FROM users WHERE id=NEW.user_id)
BEGIN SELECT RAISE(ABORT, 'ACCOUNT_NOT_FOUND'); END;

CREATE TRIGGER IF NOT EXISTS user_avatars_account_update
BEFORE UPDATE ON user_avatars
WHEN NOT EXISTS (SELECT 1 FROM users WHERE id=NEW.user_id)
BEGIN SELECT RAISE(ABORT, 'ACCOUNT_NOT_FOUND'); END;

CREATE TRIGGER IF NOT EXISTS mp_sessions_account_insert
BEFORE INSERT ON mp_sessions
WHEN NOT EXISTS (SELECT 1 FROM users WHERE id=NEW.user_id)
BEGIN SELECT RAISE(ABORT, 'ACCOUNT_NOT_FOUND'); END;

CREATE TRIGGER IF NOT EXISTS mp_sessions_account_update
BEFORE UPDATE ON mp_sessions
WHEN NOT EXISTS (SELECT 1 FROM users WHERE id=NEW.user_id)
BEGIN SELECT RAISE(ABORT, 'ACCOUNT_NOT_FOUND'); END;

CREATE TRIGGER IF NOT EXISTS connect_tokens_account_insert
BEFORE INSERT ON connect_tokens
WHEN NOT EXISTS (SELECT 1 FROM users WHERE id=NEW.user_id)
BEGIN SELECT RAISE(ABORT, 'ACCOUNT_NOT_FOUND'); END;

CREATE TRIGGER IF NOT EXISTS connect_tokens_account_update
BEFORE UPDATE ON connect_tokens
WHEN NOT EXISTS (SELECT 1 FROM users WHERE id=NEW.user_id)
BEGIN SELECT RAISE(ABORT, 'ACCOUNT_NOT_FOUND'); END;

CREATE TRIGGER IF NOT EXISTS rank_group_members_account_insert
BEFORE INSERT ON rank_group_members
WHEN NOT EXISTS (SELECT 1 FROM users WHERE id=NEW.user_id)
BEGIN SELECT RAISE(ABORT, 'ACCOUNT_NOT_FOUND'); END;

CREATE TRIGGER IF NOT EXISTS rank_group_members_account_update
BEFORE UPDATE ON rank_group_members
WHEN NOT EXISTS (SELECT 1 FROM users WHERE id=NEW.user_id)
BEGIN SELECT RAISE(ABORT, 'ACCOUNT_NOT_FOUND'); END;

CREATE TRIGGER IF NOT EXISTS daily_stats_account_insert
BEFORE INSERT ON daily_stats
WHEN NOT EXISTS (SELECT 1 FROM users WHERE id=NEW.user_id)
BEGIN SELECT RAISE(ABORT, 'ACCOUNT_NOT_FOUND'); END;

CREATE TRIGGER IF NOT EXISTS daily_stats_account_update
BEFORE UPDATE ON daily_stats
WHEN NOT EXISTS (SELECT 1 FROM users WHERE id=NEW.user_id)
BEGIN SELECT RAISE(ABORT, 'ACCOUNT_NOT_FOUND'); END;

CREATE TRIGGER IF NOT EXISTS usage_shares_account_insert
BEFORE INSERT ON usage_shares
WHEN NOT EXISTS (SELECT 1 FROM users WHERE id=NEW.user_id)
BEGIN SELECT RAISE(ABORT, 'ACCOUNT_NOT_FOUND'); END;

CREATE TRIGGER IF NOT EXISTS usage_shares_account_update
BEFORE UPDATE ON usage_shares
WHEN NOT EXISTS (SELECT 1 FROM users WHERE id=NEW.user_id)
BEGIN SELECT RAISE(ABORT, 'ACCOUNT_NOT_FOUND'); END;

CREATE TRIGGER IF NOT EXISTS daily_totals_account_insert
BEFORE INSERT ON daily_totals
WHEN NOT EXISTS (SELECT 1 FROM users WHERE id=NEW.user_id)
BEGIN SELECT RAISE(ABORT, 'ACCOUNT_NOT_FOUND'); END;

CREATE TRIGGER IF NOT EXISTS daily_totals_account_update
BEFORE UPDATE ON daily_totals
WHEN NOT EXISTS (SELECT 1 FROM users WHERE id=NEW.user_id)
BEGIN SELECT RAISE(ABORT, 'ACCOUNT_NOT_FOUND'); END;

CREATE TRIGGER IF NOT EXISTS usage_sync_state_account_insert
BEFORE INSERT ON usage_sync_state
WHEN NOT EXISTS (SELECT 1 FROM users WHERE id=NEW.user_id)
BEGIN SELECT RAISE(ABORT, 'ACCOUNT_NOT_FOUND'); END;

CREATE TRIGGER IF NOT EXISTS usage_sync_state_account_update
BEFORE UPDATE ON usage_sync_state
WHEN NOT EXISTS (SELECT 1 FROM users WHERE id=NEW.user_id)
BEGIN SELECT RAISE(ABORT, 'ACCOUNT_NOT_FOUND'); END;

CREATE TRIGGER IF NOT EXISTS usage_device_state_account_insert
BEFORE INSERT ON usage_device_state
WHEN NOT EXISTS (SELECT 1 FROM users WHERE id=NEW.user_id)
BEGIN SELECT RAISE(ABORT, 'ACCOUNT_NOT_FOUND'); END;

CREATE TRIGGER IF NOT EXISTS usage_device_state_account_update
BEFORE UPDATE ON usage_device_state
WHEN NOT EXISTS (SELECT 1 FROM users WHERE id=NEW.user_id)
BEGIN SELECT RAISE(ABORT, 'ACCOUNT_NOT_FOUND'); END;

CREATE TRIGGER IF NOT EXISTS usage_replacements_account_insert
BEFORE INSERT ON usage_replacements
WHEN NOT EXISTS (SELECT 1 FROM users WHERE id=NEW.user_id)
BEGIN SELECT RAISE(ABORT, 'ACCOUNT_NOT_FOUND'); END;

CREATE TRIGGER IF NOT EXISTS usage_replacements_account_update
BEFORE UPDATE ON usage_replacements
WHEN NOT EXISTS (SELECT 1 FROM users WHERE id=NEW.user_id)
BEGIN SELECT RAISE(ABORT, 'ACCOUNT_NOT_FOUND'); END;

CREATE TRIGGER IF NOT EXISTS usage_replacement_chunks_account_insert
BEFORE INSERT ON usage_replacement_chunks
WHEN NOT EXISTS (SELECT 1 FROM users WHERE id=NEW.user_id)
BEGIN SELECT RAISE(ABORT, 'ACCOUNT_NOT_FOUND'); END;

CREATE TRIGGER IF NOT EXISTS usage_replacement_chunks_account_update
BEFORE UPDATE ON usage_replacement_chunks
WHEN NOT EXISTS (SELECT 1 FROM users WHERE id=NEW.user_id)
BEGIN SELECT RAISE(ABORT, 'ACCOUNT_NOT_FOUND'); END;

CREATE TRIGGER IF NOT EXISTS usage_rebuild_guard_account_insert
BEFORE INSERT ON usage_rebuild_guard
WHEN NOT EXISTS (SELECT 1 FROM users WHERE id=NEW.user_id)
BEGIN SELECT RAISE(ABORT, 'ACCOUNT_NOT_FOUND'); END;

CREATE TRIGGER IF NOT EXISTS usage_rebuild_guard_account_update
BEFORE UPDATE ON usage_rebuild_guard
WHEN NOT EXISTS (SELECT 1 FROM users WHERE id=NEW.user_id)
BEGIN SELECT RAISE(ABORT, 'ACCOUNT_NOT_FOUND'); END;

CREATE TRIGGER IF NOT EXISTS rank_groups_account_insert
BEFORE INSERT ON rank_groups
WHEN NOT EXISTS (SELECT 1 FROM users WHERE id=NEW.owner_user_id)
BEGIN SELECT RAISE(ABORT, 'ACCOUNT_NOT_FOUND'); END;

CREATE TRIGGER IF NOT EXISTS rank_groups_account_update
BEFORE UPDATE ON rank_groups
WHEN NOT EXISTS (SELECT 1 FROM users WHERE id=NEW.owner_user_id)
BEGIN SELECT RAISE(ABORT, 'ACCOUNT_NOT_FOUND'); END;

CREATE TRIGGER IF NOT EXISTS rank_group_members_group_insert
BEFORE INSERT ON rank_group_members
WHEN NOT EXISTS (SELECT 1 FROM rank_groups WHERE id=NEW.group_id)
BEGIN SELECT RAISE(ABORT, 'GROUP_NOT_FOUND'); END;

CREATE TRIGGER IF NOT EXISTS rank_group_members_group_update
BEFORE UPDATE ON rank_group_members
WHEN NOT EXISTS (SELECT 1 FROM rank_groups WHERE id=NEW.group_id)
BEGIN SELECT RAISE(ABORT, 'GROUP_NOT_FOUND'); END;

-- Separate liveness from changed usage. No credentials, paths or raw error logs.
CREATE TABLE IF NOT EXISTS sync_agents (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id TEXT NOT NULL,
  client_version TEXT NOT NULL,
  collector_version TEXT,
  platform TEXT NOT NULL,
  state TEXT NOT NULL,
  error_code TEXT,
  source_day TEXT,
  check_started_at INTEGER,
  checked_at INTEGER,
  event_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  PRIMARY KEY(user_id, device_id)
);
CREATE INDEX IF NOT EXISTS idx_agents_seen ON sync_agents(last_seen_at);
CREATE TRIGGER IF NOT EXISTS sync_agents_account_insert
BEFORE INSERT ON sync_agents
WHEN NOT EXISTS (SELECT 1 FROM users WHERE id=NEW.user_id)
BEGIN SELECT RAISE(ABORT, 'ACCOUNT_NOT_FOUND'); END;
CREATE TRIGGER IF NOT EXISTS sync_agents_account_update
BEFORE UPDATE ON sync_agents
WHEN NOT EXISTS (SELECT 1 FROM users WHERE id=NEW.user_id)
BEGIN SELECT RAISE(ABORT, 'ACCOUNT_NOT_FOUND'); END;

-- Additive only: never rewrite or delete existing usage.
CREATE TABLE IF NOT EXISTS reminder_preferences (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  awaiting_first_report INTEGER NOT NULL DEFAULT 0,
  prompt_seen_at INTEGER
);
CREATE TABLE IF NOT EXISTS reminder_jobs (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK(kind IN ('weekly','daily','sync_error')),
  id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  template_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('pending','sending','sent','cancelled','needs_permission','failed','unknown','skipped')),
  scheduled_at INTEGER,
  week_start TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  attempted_at INTEGER,
  last_sent_at INTEGER,
  error_code TEXT,
  PRIMARY KEY(user_id,kind)
);
CREATE INDEX IF NOT EXISTS idx_reminder_due ON reminder_jobs(state,scheduled_at);
CREATE TABLE IF NOT EXISTS reminder_failure_runs (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id TEXT NOT NULL,
  state TEXT NOT NULL,
  error_since INTEGER,
  event_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  PRIMARY KEY(user_id,device_id)
);
CREATE TRIGGER IF NOT EXISTS reminder_preferences_account_insert BEFORE INSERT ON reminder_preferences
WHEN NOT EXISTS(SELECT 1 FROM users WHERE id=NEW.user_id) BEGIN SELECT RAISE(ABORT,'ACCOUNT_NOT_FOUND'); END;
CREATE TRIGGER IF NOT EXISTS reminder_jobs_account_insert BEFORE INSERT ON reminder_jobs
WHEN NOT EXISTS(SELECT 1 FROM users WHERE id=NEW.user_id) BEGIN SELECT RAISE(ABORT,'ACCOUNT_NOT_FOUND'); END;
CREATE TRIGGER IF NOT EXISTS reminder_failure_runs_account_insert BEFORE INSERT ON reminder_failure_runs
WHEN NOT EXISTS(SELECT 1 FROM users WHERE id=NEW.user_id) BEGIN SELECT RAISE(ABORT,'ACCOUNT_NOT_FOUND'); END;

CREATE TRIGGER IF NOT EXISTS reminder_preferences_account_update BEFORE UPDATE OF user_id ON reminder_preferences
WHEN NOT EXISTS(SELECT 1 FROM users WHERE id=NEW.user_id) BEGIN SELECT RAISE(ABORT,'ACCOUNT_NOT_FOUND'); END;
CREATE TRIGGER IF NOT EXISTS reminder_jobs_account_update BEFORE UPDATE OF user_id ON reminder_jobs
WHEN NOT EXISTS(SELECT 1 FROM users WHERE id=NEW.user_id) BEGIN SELECT RAISE(ABORT,'ACCOUNT_NOT_FOUND'); END;
CREATE TRIGGER IF NOT EXISTS reminder_failure_runs_account_update BEFORE UPDATE OF user_id ON reminder_failure_runs
WHEN NOT EXISTS(SELECT 1 FROM users WHERE id=NEW.user_id) BEGIN SELECT RAISE(ABORT,'ACCOUNT_NOT_FOUND'); END;

-- Optional private email registration only; no subscription or delivery is enabled.
CREATE TABLE IF NOT EXISTS email_registrations (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  email TEXT,
  consent_at INTEGER,
  consent_version TEXT,
  revision TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
-- A withdrawn row retains only its revision, preventing stale requests from restoring an address.
CREATE TRIGGER IF NOT EXISTS email_registrations_account_insert BEFORE INSERT ON email_registrations
WHEN NOT EXISTS(SELECT 1 FROM users WHERE id=NEW.user_id) BEGIN SELECT RAISE(ABORT,'ACCOUNT_NOT_FOUND'); END;
CREATE TRIGGER IF NOT EXISTS email_registrations_account_update BEFORE UPDATE OF user_id ON email_registrations
WHEN NOT EXISTS(SELECT 1 FROM users WHERE id=NEW.user_id) BEGIN SELECT RAISE(ABORT,'ACCOUNT_NOT_FOUND'); END;

-- Private ledger of a user's paid AI subscriptions; amounts in minor units (分 / 美分).
CREATE TABLE IF NOT EXISTS user_subscriptions (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  plan TEXT,
  price_minor INTEGER NOT NULL CHECK (price_minor > 0),
  currency TEXT NOT NULL CHECK (currency IN ('CNY','USD','EUR','GBP','HKD','JPY')),
  cycle TEXT NOT NULL CHECK (cycle IN ('week','month','quarter','year','custom')),
  custom_days INTEGER,
  start_day TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active','paused','cancelled')),
  ended_day TEXT,
  notes TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  api_key INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_user_subscriptions_user ON user_subscriptions(user_id);
CREATE TRIGGER IF NOT EXISTS user_subscriptions_account_insert BEFORE INSERT ON user_subscriptions
WHEN NOT EXISTS(SELECT 1 FROM users WHERE id=NEW.user_id) BEGIN SELECT RAISE(ABORT,'ACCOUNT_NOT_FOUND'); END;
CREATE TRIGGER IF NOT EXISTS user_subscriptions_account_update BEFORE UPDATE OF user_id ON user_subscriptions
WHEN NOT EXISTS(SELECT 1 FROM users WHERE id=NEW.user_id) BEGIN SELECT RAISE(ABORT,'ACCOUNT_NOT_FOUND'); END;

-- Prepaid API balances (DeepSeek): each top-up, and balances the user copied from the vendor console to recalibrate.
CREATE TABLE IF NOT EXISTS user_topups (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  vendor TEXT NOT NULL CHECK (vendor IN ('deepseek')),
  kind TEXT NOT NULL CHECK (kind IN ('topup','balance')),
  amount_minor INTEGER NOT NULL CHECK (amount_minor >= 0),
  currency TEXT NOT NULL CHECK (currency IN ('CNY','USD','EUR','GBP','HKD','JPY')),
  day TEXT NOT NULL,
  notes TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_user_topups_user ON user_topups(user_id);
CREATE TRIGGER IF NOT EXISTS user_topups_account_insert BEFORE INSERT ON user_topups
WHEN NOT EXISTS(SELECT 1 FROM users WHERE id=NEW.user_id) BEGIN SELECT RAISE(ABORT,'ACCOUNT_NOT_FOUND'); END;
CREATE TRIGGER IF NOT EXISTS user_topups_account_update BEFORE UPDATE OF user_id ON user_topups
WHEN NOT EXISTS(SELECT 1 FROM users WHERE id=NEW.user_id) BEGIN SELECT RAISE(ABORT,'ACCOUNT_NOT_FOUND'); END;

-- 飞书机器人事件去重：飞书对失败回调会重试，event_id 幂等只处理一次
CREATE TABLE IF NOT EXISTS feishu_event_log (
  event_id TEXT PRIMARY KEY,
  seen_at INTEGER NOT NULL
);

-- 飞书卡片头像缓存：头像需上传飞书换取 img_key 才能在卡片里展示（圆形小图）
CREATE TABLE IF NOT EXISTS feishu_avatar_cache (
  user_id INTEGER PRIMARY KEY,
  image_key TEXT NOT NULL,
  source TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
