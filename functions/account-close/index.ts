/**
 * account-close：账号注销
 *
 * 为什么必须放在云函数：客户端拿到的匿名密钥无法删除 auth.users 里的账号本体，
 * 只有服务角色密钥能做到。服务角色密钥只存在于函数运行环境，绝不下发到 App。
 *
 * 安全设计：
 *  1. 网关 verify_jwt = true 只验签名，安装包里的匿名密钥也是合法 JWT，挡不住伪造调用；
 *     因此函数体内再用 access_token 向 Auth 服务换真实 uid 做二次校验。
 *  2. 只允许注销「调用者自己」的账号：uid 来自 token，不接受请求体传入的任意 user id。
 *  3. 必须带固定确认串，避免误触发。
 *
 * 输入：POST { confirm: "DELETE_MY_ACCOUNT" }，Header: Authorization: Bearer <access_token>
 * 输出：{ ok: true, deleted: { banks, questions, attempts, wrongBook, progress, settings } }
 *       失败：{ error: "中文原因" }
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';

const CONFIRM_TOKEN = 'DELETE_MY_ACCOUNT';

/**
 * 服务角色客户端在模块加载时建一次即可：密钥来自函数运行环境，
 * 且所有请求都以「调用者自己的 uid」为删除条件，不存在跨账号复用的风险。
 */
const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } });

interface Row {
  count?: number;
}

function jsonHeaders(): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  };
}

function reply(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: jsonHeaders() });
}

/** 用请求里的 access_token 换真实 uid；换不到就是未登录 */
async function requireUserId(req: Request): Promise<string | null> {
  const header = req.headers.get('Authorization') ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!token || !SUPABASE_URL || !SUPABASE_ANON_KEY) return null;
  try {
    const probe = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { persistSession: false } });
    const { data, error } = await probe.auth.getUser(token);
    if (error || !data.user) return null;
    return data.user.id;
  } catch (error) {
    console.error('[account-close] 校验登录态失败:', error);
    return null;
  }
}

/** 删除一张表里该账号的全部行，返回删除条数（RLS 对服务角色不生效，能删干净） */
async function purge(table: string, column: string, uid: string): Promise<number> {
  try {
    const { data, error } = await admin.from(table).delete().eq(column, uid).select('id');
    if (error) {
      console.error(`[account-close] 删除 ${table} 失败:`, error);
      return -1;
    }
    const rows = (data ?? []) as Row[];
    return rows.length;
  } catch (error) {
    console.error(`[account-close] 删除 ${table} 异常:`, error);
    return -1;
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: jsonHeaders() });
  if (req.method !== 'POST') return reply({ error: '不支持的请求方式' }, 405);
  if (!SUPABASE_URL || !SERVICE_ROLE_KEY) return reply({ error: '云端未就绪，暂时无法注销账号' }, 500);

  const uid = await requireUserId(req);
  if (!uid) return reply({ error: '请先登录后再注销账号' }, 401);

  let confirm = '';
  try {
    const body = (await req.json()) as { confirm?: unknown };
    confirm = String(body?.confirm ?? '');
  } catch (error) {
    console.error('[account-close] 请求体解析失败:', error);
    return reply({ error: '请求格式不正确' }, 400);
  }
  if (confirm !== CONFIRM_TOKEN) return reply({ error: '缺少注销确认，操作已取消' }, 400);

  // 先删题目再删题库：题目对题库有外键，顺序反了会被约束挡住
  const deleted = {
    attempts: await purge('quiz_attempts', 'user_id', uid),
    wrongBook: await purge('quiz_wrong_book', 'user_id', uid),
    progress: await purge('quiz_progress', 'user_id', uid),
    reviews: await purge('quiz_reviews', 'user_id', uid),
    favorites: await purge('quiz_favorites', 'user_id', uid),
    questions: await purge('quiz_questions', 'user_id', uid),
    banks: await purge('quiz_banks', 'user_id', uid),
    settings: await purge('quiz_settings', 'user_id', uid),
  };

  // 业务数据没清干净时不要删 auth 用户：否则账号还在、数据半残，用户既登不回来也没法重试
  if (Object.values(deleted).some((n) => n < 0)) {
    return reply({ error: '云端数据未能全部清除，账号注销已中止，请稍后重试' }, 500);
  }

  const { error: profileErr } = await admin.from('profiles').delete().eq('id', uid);
  if (profileErr) console.error('[account-close] 删除 profiles 失败:', profileErr);

  const { error } = await admin.auth.admin.deleteUser(uid);
  if (error) {
    console.error('[account-close] 删除账号失败:', error);
    return reply({ error: '账号删除失败，请稍后重试' }, 500);
  }

  return reply({ ok: true, deleted });
});
