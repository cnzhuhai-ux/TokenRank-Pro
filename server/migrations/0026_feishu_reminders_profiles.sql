-- Additive, re-runnable migration. Preserve all existing user-entered names conservatively.
CREATE TABLE IF NOT EXISTS user_profile_preferences (
 user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
 nickname_custom INTEGER NOT NULL DEFAULT 0
);
INSERT OR IGNORE INTO user_profile_preferences(user_id,nickname_custom)
 SELECT id,1 FROM users WHERE nickname IS NOT NULL AND nickname<>'';
CREATE TABLE IF NOT EXISTS feishu_reminder_jobs (
 user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 kind TEXT NOT NULL CHECK(kind IN ('daily','sync_error')),
 id TEXT NOT NULL, request_id TEXT NOT NULL, template_id TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('pending','sending','sent','cancelled','needs_permission','failed','unknown','skipped')),
 scheduled_at INTEGER, week_start TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
 attempted_at INTEGER, last_sent_at INTEGER, error_code TEXT,
 PRIMARY KEY(user_id,kind)
);
CREATE INDEX IF NOT EXISTS idx_feishu_reminder_due ON feishu_reminder_jobs(state,scheduled_at);
CREATE TABLE IF NOT EXISTS feishu_reminder_failure_runs (
 user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, device_id TEXT NOT NULL,
 state TEXT NOT NULL, error_since INTEGER, event_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL,
 PRIMARY KEY(user_id,device_id)
);
CREATE TRIGGER IF NOT EXISTS user_profile_preferences_account_insert BEFORE INSERT ON user_profile_preferences
WHEN NOT EXISTS(SELECT 1 FROM users WHERE id=NEW.user_id) BEGIN SELECT RAISE(ABORT,'ACCOUNT_NOT_FOUND'); END;
CREATE TRIGGER IF NOT EXISTS user_profile_preferences_account_update BEFORE UPDATE ON user_profile_preferences
WHEN NOT EXISTS(SELECT 1 FROM users WHERE id=NEW.user_id) BEGIN SELECT RAISE(ABORT,'ACCOUNT_NOT_FOUND'); END;
CREATE TRIGGER IF NOT EXISTS feishu_reminder_jobs_account_insert BEFORE INSERT ON feishu_reminder_jobs
WHEN NOT EXISTS(SELECT 1 FROM users WHERE id=NEW.user_id) BEGIN SELECT RAISE(ABORT,'ACCOUNT_NOT_FOUND'); END;
CREATE TRIGGER IF NOT EXISTS feishu_reminder_jobs_account_update BEFORE UPDATE ON feishu_reminder_jobs
WHEN NOT EXISTS(SELECT 1 FROM users WHERE id=NEW.user_id) BEGIN SELECT RAISE(ABORT,'ACCOUNT_NOT_FOUND'); END;
CREATE TRIGGER IF NOT EXISTS feishu_reminder_failure_runs_account_insert BEFORE INSERT ON feishu_reminder_failure_runs
WHEN NOT EXISTS(SELECT 1 FROM users WHERE id=NEW.user_id) BEGIN SELECT RAISE(ABORT,'ACCOUNT_NOT_FOUND'); END;
CREATE TRIGGER IF NOT EXISTS feishu_reminder_failure_runs_account_update BEFORE UPDATE ON feishu_reminder_failure_runs
WHEN NOT EXISTS(SELECT 1 FROM users WHERE id=NEW.user_id) BEGIN SELECT RAISE(ABORT,'ACCOUNT_NOT_FOUND'); END;
