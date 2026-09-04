/**
 * 账号体系：账号名 + 密码（平台按 basic_auth 方案自动生成虚拟邮箱登录）。
 * 本版不含邮箱/短信验证码，也不支持自助找回密码。
 *
 * - 会话持久化由平台生成的 src/supabase/client.ts 负责（真机走 expo-secure-store），
 *   这里只消费会话，不自己存 token。
 * - onAuthStateChange 回调内禁止直接 await 数据库，否则会与 token 刷新互相等待造成死锁，
 *   因此读取 profiles 用 setTimeout 推到下一个宏任务。
 */
import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { Session } from '@supabase/supabase-js';
import { supabase, supabaseUrl } from '../supabase/client';
import { clearAttemptQueue } from '../services/offlineQueue';

const VIRTUAL_DOMAIN = '@meoo.local';

/** 返回 null 表示成功，否则是给用户看的中文原因 */
export type AuthResult = string | null;

interface AuthContextValue {
  userId: string | null;
  username: string | null;
  /** 首次会话恢复是否完成；未完成前不能判定「未登录」 */
  ready: boolean;
  signIn: (account: string, password: string) => Promise<AuthResult>;
  signUp: (account: string, password: string) => Promise<AuthResult>;
  signOut: () => Promise<void>;
  /** 先校验原密码，再设置新密码；返回 null 表示成功 */
  changePassword: (currentPassword: string, newPassword: string) => Promise<AuthResult>;
  /** 永久删除账号及其全部云端数据，返回 null 表示成功 */
  deleteAccount: () => Promise<AuthResult>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function normalizeAccount(raw: string): string {
  return String(raw ?? '').trim().toLowerCase();
}

export function accountError(account: string): string | null {
  if (!account) return '请输入账号';
  if (account.length < 3) return '账号至少 3 个字符';
  if (account.length > 20) return '账号不超过 20 个字符';
  if (!/^[a-z0-9_.-]+$/.test(account)) return '账号只能用字母、数字、下划线、点或减号';
  return null;
}

export function passwordError(password: string): string | null {
  if (!password) return '请输入密码';
  if (password.length < 6) return '密码至少 6 位';
  return null;
}

/** 把 Supabase 的英文报错翻译成用户能看懂的话，绝不直接展示原始 message */
function translate(message: string | undefined, fallback: string): string {
  const m = String(message ?? '');
  if (/invalid login credentials/i.test(m)) return '账号或密码不正确';
  if (/already registered|already exists|already been registered/i.test(m)) return '该账号已被注册，请换一个或直接登录';
  if (/rate limit|too many requests|for security/i.test(m)) return '操作过于频繁，请稍后再试';
  if (/failed to fetch|network|timeout|fetch failed/i.test(m)) return '网络连接失败，请检查网络后重试';
  if (/invalid email/i.test(m)) return '账号格式不正确，请重新输入';
  return fallback;
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [username, setUsername] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  const loadProfile = useCallback(async (uid: string) => {
    try {
      const { data, error } = await supabase.from('profiles').select('username').eq('id', uid).maybeSingle();
      if (error) {
        console.error('[auth] 读取账号信息失败:', error);
        return;
      }
      const name = data ? String((data as Record<string, unknown>).username ?? '') : '';
      setUsername(name || null);
    } catch (error) {
      console.error('[auth] loadProfile failed:', error);
    }
  }, []);

  useEffect(() => {
    let alive = true;

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, next) => {
      if (!alive) return;
      setSession(next);
      setReady(true);
      if (!next) {
        setUsername(null);
        return;
      }
      const uid = next.user.id;
      setTimeout(() => {
        if (alive) void loadProfile(uid);
      }, 0);
    });

    supabase.auth
      .getSession()
      .then(({ data }) => {
        if (!alive) return;
        setSession(data.session ?? null);
        setReady(true);
        if (data.session) void loadProfile(data.session.user.id);
      })
      .catch((error) => {
        console.error('[auth] 读取登录态失败:', error);
        if (alive) setReady(true);
      });

    return () => {
      alive = false;
      subscription.unsubscribe();
    };
  }, [loadProfile]);

  const signIn = useCallback(async (account: string, password: string): Promise<AuthResult> => {
    const invalid = accountError(account) ?? passwordError(password);
    if (invalid) return invalid;
    try {
      const { error } = await supabase.auth.signInWithPassword({
        email: `${normalizeAccount(account)}${VIRTUAL_DOMAIN}`,
        password,
      });
      if (error) return translate(error.message, '登录失败，请稍后重试');
      return null;
    } catch (error) {
      console.error('[auth] signIn failed:', error);
      return '网络异常，登录未完成';
    }
  }, []);

  const signUp = useCallback(async (account: string, password: string): Promise<AuthResult> => {
    const invalid = accountError(account) ?? passwordError(password);
    if (invalid) return invalid;
    const name = normalizeAccount(account);
    try {
      const { data, error } = await supabase.auth.signUp({
        email: `${name}${VIRTUAL_DOMAIN}`,
        password,
        options: { data: { username: name } },
      });
      if (error) return translate(error.message, '注册失败，请稍后重试');

      // 少数环境会要求邮件确认而不直接给会话；这里补一次登录，避免用户卡在门外
      if (!data.session) {
        const retry = await supabase.auth.signInWithPassword({ email: `${name}${VIRTUAL_DOMAIN}`, password });
        if (retry.error) return translate(retry.error.message, '账号已创建，请用新账号登录');
      }
      return null;
    } catch (error) {
      console.error('[auth] signUp failed:', error);
      return '网络异常，注册未完成';
    }
  }, []);

  const signOut = useCallback(async (): Promise<void> => {
    try {
      const { error } = await supabase.auth.signOut();
      if (error) console.error('[auth] 退出登录失败:', error);
    } catch (error) {
      console.error('[auth] signOut failed:', error);
    }
  }, []);

  /**
   * 修改密码：先用原密码登一次做身份校验，通过后再更新密码。
   *
   * 为什么必须先登录：平台把改密码当敏感操作，要求会话有近期登录记录，
   * 否则直接 updateUser 会被拒。用原密码重新登录既完成了「验证原密码」，
   * 又顺带让会话变新鲜，一步到位。
   * 任一步失败都停在原密码上，不会出现「密码改了但用户以为没改」的中间态。
   */
  const changePassword = useCallback(async (currentPassword: string, newPassword: string): Promise<AuthResult> => {
    if (!currentPassword) return '请输入原密码';
    const invalid = passwordError(newPassword);
    if (invalid) return invalid;
    if (currentPassword === newPassword) return '新密码与原密码相同，请换一个';
    try {
      const { data } = await supabase.auth.getSession();
      const email = data.session?.user.email;
      if (!email) return '登录态已失效，请重新登录后再试';

      const verified = await supabase.auth.signInWithPassword({ email, password: currentPassword });
      if (verified.error) {
        const message = String(verified.error.message ?? '');
        if (/invalid login credentials/i.test(message)) return '原密码不正确';
        return translate(verified.error.message, '原密码校验失败，请稍后重试');
      }

      const { error } = await supabase.auth.updateUser({ password: newPassword });
      if (error) {
        const message = String(error.message ?? '');
        if (/requires a recent|reauthent|fresh/i.test(message)) return '身份校验已过期，请重新登录后立即再试';
        return translate(error.message, '密码修改失败，请稍后重试');
      }
      return null;
    } catch (error) {
      console.error('[auth] changePassword failed:', error);
      return '网络异常，密码修改未完成';
    }
  }, []);

  /**
   * 注销账号：只能由云函数用服务角色完成（客户端匿名密钥删不掉 auth 用户本体）。
   * 函数内部会先清干净六张业务表，任何一步失败都不会删账号，避免留下「号在、数据半残」。
   */
  const deleteAccount = useCallback(async (): Promise<AuthResult> => {
    try {
      const { data } = await supabase.auth.getSession();
      const token = data.session?.access_token;
      if (!token) return '登录态已失效，请重新登录后再试';
      const response = await fetch(`${supabaseUrl}/functions/v1/account-close`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ confirm: 'DELETE_MY_ACCOUNT' }),
      });
      const text = await response.text();
      let result: Record<string, unknown> = {};
      try {
        result = text ? (JSON.parse(text) as Record<string, unknown>) : {};
      } catch (error) {
        console.error('[auth] 注销响应不是 JSON:', error);
      }
      if (!response.ok || result.ok !== true) {
        return String(result.error ?? `注销失败（${response.status}），请稍后重试`);
      }
      // 内存里攒着没发出去的作答记录必须丢掉，否则会把已注销账号的记录写进下一个登录的账号
      clearAttemptQueue();
      await signOut();
      return null;
    } catch (error) {
      console.error('[auth] deleteAccount failed:', error);
      return '网络异常，注销未完成';
    }
  }, [signOut]);

  const value = useMemo<AuthContextValue>(
    () => ({
      userId: session?.user.id ?? null,
      username: username ?? session?.user.email?.split('@')[0] ?? null,
      ready,
      signIn,
      signUp,
      signOut,
      changePassword,
      deleteAccount,
    }),
    [session, username, ready, signIn, signUp, signOut, changePassword, deleteAccount],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth 必须在 AuthProvider 内使用');
  return ctx;
}
