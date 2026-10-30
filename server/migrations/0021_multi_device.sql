-- 一个接入码接入多台电脑：每台设备一条状态，日桶按天相加后再进榜单。
-- 只把现有的「最近一次完整上报」设备标为 active，历史数字不会因为升级而跳变；
-- 其他旧设备在下次完整上报后自动加入。
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

INSERT OR IGNORE INTO usage_device_state (user_id, device_id, source_at, active, last_report_at, updated_at)
  SELECT user_id, device_id, source_at, 1, updated_at, updated_at FROM usage_sync_state;

DROP VIEW IF EXISTS public_usage;
DROP VIEW IF EXISTS ranked_usage;

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

CREATE TRIGGER IF NOT EXISTS usage_device_state_account_insert
BEFORE INSERT ON usage_device_state
WHEN NOT EXISTS (SELECT 1 FROM users WHERE id=NEW.user_id)
BEGIN SELECT RAISE(ABORT, 'ACCOUNT_NOT_FOUND'); END;
CREATE TRIGGER IF NOT EXISTS usage_device_state_account_update
BEFORE UPDATE ON usage_device_state
WHEN NOT EXISTS (SELECT 1 FROM users WHERE id=NEW.user_id)
BEGIN SELECT RAISE(ABORT, 'ACCOUNT_NOT_FOUND'); END;
