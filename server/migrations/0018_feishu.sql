-- 飞书机器人接入：见 docs/feishu.md
-- 用户头像：飞书资料头像是公网 URL，直接存列（与微信版的 avatar_path 文件并存，优先用文件）
ALTER TABLE users ADD COLUMN avatar_url TEXT;

-- 事件幂等：飞书回调失败会重试，event_id 只处理一次；过期行由事件处理过程顺手清理
CREATE TABLE IF NOT EXISTS feishu_event_log (
  event_id TEXT PRIMARY KEY,
  seen_at INTEGER NOT NULL
);
