/**
 * 云端数据作用域：所有业务表的读写都以「当前登录账号的 user_id」为准。
 *
 * 未登录时返回空串：查询会命中 0 行，写入会被数据库行级权限（RLS）拒绝，
 * 调用方本来就有 try/catch 与失败提示，不会崩，只是拿不到数据。
 * 根布局的登录门禁保证正常路径下这里永远拿得到真实 uid。
 */
import { supabase } from '../supabase/client';

export async function getOwnerId(): Promise<string> {
  try {
    const { data } = await supabase.auth.getSession();
    return data.session?.user.id ?? '';
  } catch (error) {
    console.error('[ownerId] 读取登录态失败:', error);
    return '';
  }
}

/**
 * 云函数请求头：三个 Edge Function 都只允许登录态调用，
 * 必须带上当前会话的 access_token，未登录时返回空头 → 函数会回 401。
 */
export async function authHeaders(): Promise<Record<string, string>> {
  try {
    const { data } = await supabase.auth.getSession();
    const token = data.session?.access_token;
    return token ? { Authorization: `Bearer ${token}` } : {};
  } catch (error) {
    console.error('[ownerId] 读取访问令牌失败:', error);
    return {};
  }
}
