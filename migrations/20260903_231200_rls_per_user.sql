-- 收口：删除全部 22 条 USING (true) 的匿名策略，改为仅本人可读写自己的行。
-- 未登录（auth.uid() 为 NULL）时一律匹配不到任何行。

DROP POLICY IF EXISTS anon_select_quiz_banks ON quiz_banks;
DROP POLICY IF EXISTS anon_insert_quiz_banks ON quiz_banks;
DROP POLICY IF EXISTS anon_update_quiz_banks ON quiz_banks;
DROP POLICY IF EXISTS anon_delete_quiz_banks ON quiz_banks;
DROP POLICY IF EXISTS anon_select_quiz_questions ON quiz_questions;
DROP POLICY IF EXISTS anon_insert_quiz_questions ON quiz_questions;
DROP POLICY IF EXISTS anon_update_quiz_questions ON quiz_questions;
DROP POLICY IF EXISTS anon_delete_quiz_questions ON quiz_questions;
DROP POLICY IF EXISTS anon_select_quiz_attempts ON quiz_attempts;
DROP POLICY IF EXISTS anon_insert_quiz_attempts ON quiz_attempts;
DROP POLICY IF EXISTS anon_delete_quiz_attempts ON quiz_attempts;
DROP POLICY IF EXISTS anon_select_quiz_wrong_book ON quiz_wrong_book;
DROP POLICY IF EXISTS anon_insert_quiz_wrong_book ON quiz_wrong_book;
DROP POLICY IF EXISTS anon_update_quiz_wrong_book ON quiz_wrong_book;
DROP POLICY IF EXISTS anon_delete_quiz_wrong_book ON quiz_wrong_book;
DROP POLICY IF EXISTS anon_select_quiz_progress ON quiz_progress;
DROP POLICY IF EXISTS anon_insert_quiz_progress ON quiz_progress;
DROP POLICY IF EXISTS anon_update_quiz_progress ON quiz_progress;
DROP POLICY IF EXISTS anon_delete_quiz_progress ON quiz_progress;
DROP POLICY IF EXISTS anon_select_quiz_settings ON quiz_settings;
DROP POLICY IF EXISTS anon_insert_quiz_settings ON quiz_settings;
DROP POLICY IF EXISTS anon_update_quiz_settings ON quiz_settings;

-- quiz_banks
CREATE POLICY users_select_own_quiz_banks ON quiz_banks
FOR SELECT USING (user_id = auth.uid());
CREATE POLICY users_insert_own_quiz_banks ON quiz_banks
FOR INSERT WITH CHECK (user_id = auth.uid());
CREATE POLICY users_update_own_quiz_banks ON quiz_banks
FOR UPDATE USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());
CREATE POLICY users_delete_own_quiz_banks ON quiz_banks
FOR DELETE USING (user_id = auth.uid());

-- quiz_questions
CREATE POLICY users_select_own_quiz_questions ON quiz_questions
FOR SELECT USING (user_id = auth.uid());
CREATE POLICY users_insert_own_quiz_questions ON quiz_questions
FOR INSERT WITH CHECK (user_id = auth.uid());
CREATE POLICY users_update_own_quiz_questions ON quiz_questions
FOR UPDATE USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());
CREATE POLICY users_delete_own_quiz_questions ON quiz_questions
FOR DELETE USING (user_id = auth.uid());

-- quiz_attempts
CREATE POLICY users_select_own_quiz_attempts ON quiz_attempts
FOR SELECT USING (user_id = auth.uid());
CREATE POLICY users_insert_own_quiz_attempts ON quiz_attempts
FOR INSERT WITH CHECK (user_id = auth.uid());
CREATE POLICY users_delete_own_quiz_attempts ON quiz_attempts
FOR DELETE USING (user_id = auth.uid());

-- quiz_wrong_book
CREATE POLICY users_select_own_quiz_wrong_book ON quiz_wrong_book
FOR SELECT USING (user_id = auth.uid());
CREATE POLICY users_insert_own_quiz_wrong_book ON quiz_wrong_book
FOR INSERT WITH CHECK (user_id = auth.uid());
CREATE POLICY users_update_own_quiz_wrong_book ON quiz_wrong_book
FOR UPDATE USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());
CREATE POLICY users_delete_own_quiz_wrong_book ON quiz_wrong_book
FOR DELETE USING (user_id = auth.uid());

-- quiz_progress
CREATE POLICY users_select_own_quiz_progress ON quiz_progress
FOR SELECT USING (user_id = auth.uid());
CREATE POLICY users_insert_own_quiz_progress ON quiz_progress
FOR INSERT WITH CHECK (user_id = auth.uid());
CREATE POLICY users_update_own_quiz_progress ON quiz_progress
FOR UPDATE USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());
CREATE POLICY users_delete_own_quiz_progress ON quiz_progress
FOR DELETE USING (user_id = auth.uid());

-- quiz_settings
CREATE POLICY users_select_own_quiz_settings ON quiz_settings
FOR SELECT USING (user_id = auth.uid());
CREATE POLICY users_insert_own_quiz_settings ON quiz_settings
FOR INSERT WITH CHECK (user_id = auth.uid());
CREATE POLICY users_update_own_quiz_settings ON quiz_settings
FOR UPDATE USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());
