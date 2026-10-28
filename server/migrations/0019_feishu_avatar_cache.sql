-- 飞书卡片头像缓存：本地头像（D1 blob 或外链）上传飞书后换得的 img_key
CREATE TABLE IF NOT EXISTS feishu_avatar_cache (
  user_id INTEGER PRIMARY KEY,
  image_key TEXT NOT NULL,
  source TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
