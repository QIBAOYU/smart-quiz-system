-- 六张业务表增加账号归属列（旧的 device_id 列保留不动，历史数据不销毁）
ALTER TABLE quiz_banks ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE;
ALTER TABLE quiz_questions ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE;
ALTER TABLE quiz_attempts ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE;
ALTER TABLE quiz_wrong_book ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE;
ALTER TABLE quiz_progress ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE;
ALTER TABLE quiz_settings ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_banks_user_created ON quiz_banks (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_questions_user_bank ON quiz_questions (user_id, bank_id);
CREATE INDEX IF NOT EXISTS idx_attempts_user_created ON quiz_attempts (user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_wrong_user_bank ON quiz_wrong_book (user_id, bank_id);
CREATE INDEX IF NOT EXISTS idx_progress_user_bank_mode ON quiz_progress (user_id, bank_id, mode);

-- 设置表主键由 device_id 换成 user_id：按账号唯一。
-- 用户已确认「登录后从零开始」，先清空旧的设备级设置行，再收紧为 NOT NULL。
DELETE FROM quiz_settings;
ALTER TABLE quiz_settings DROP CONSTRAINT IF EXISTS quiz_settings_pkey;
ALTER TABLE quiz_settings ALTER COLUMN user_id SET NOT NULL;
ALTER TABLE quiz_settings ADD CONSTRAINT quiz_settings_pkey PRIMARY KEY (user_id);
