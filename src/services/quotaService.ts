/**
 * 内置「模型二 · 千问」每人每天 2 次额度的端侧镜像。
 *
 * 真正的计数在数据库（consume_qwen_quota），端侧绕不过去；这里只做两件事：
 *  1. 读当日剩余额度，给「设置 → AI 模型配置」页显示「今日剩余 X/2」；
 *  2. 接住云函数回传的信号（本次已降级 / 今日已停用），交给全局浮层提示。
 *
 * 口径：一次真正打到千问上游的请求 = 一次额度，包含智谱失败后自动降级的那一次。
 * 智谱「模型一」不计数、当天不会被停用，用户可以一直重试碰运气。
 *
 * 模块级单例 + useSyncExternalStore，与 importStore 同一套路数。
 */
import { useSyncExternalStore } from 'react';
import { supabase } from '../supabase/client';
import { getOwnerId } from './ownerId';

/** 与两个云函数里的 QWEN_DAILY_LIMIT 保持一致 */
export const QWEN_DAILY_LIMIT = 2;

export interface BuiltinNotice {
  id: number;
  tone: 'warn' | 'danger';
  title: string;
  message: string;
  /** 有值时浮层显示「去切换」，点了直接进模型配置页 */
  actionLabel?: string;
  actionPath?: string;
}

export interface QuotaSnapshot {
  used: number;
  remaining: number;
  limit: number;
  loaded: boolean;
  /** 服务端豁免名单内的账号：只记录次数、永不拦截 */
  unlimited: boolean;
  notice: BuiltinNotice | null;
}

let snapshot: QuotaSnapshot = {
  used: 0,
  remaining: QWEN_DAILY_LIMIT,
  limit: QWEN_DAILY_LIMIT,
  loaded: false,
  unlimited: false,
  notice: null,
};

const listeners = new Set<() => void>();
let noticeSeq = 0;
let noticeTimer: ReturnType<typeof setTimeout> | null = null;

function commit(patch: Partial<QuotaSnapshot>): void {
  snapshot = { ...snapshot, ...patch };
  listeners.forEach((listener) => listener());
}

export function subscribeQuota(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getQuotaSnapshot(): QuotaSnapshot {
  return snapshot;
}

export function useQuota(): QuotaSnapshot {
  return useSyncExternalStore(subscribeQuota, getQuotaSnapshot);
}

/** 拉一次当日额度：进入配置页时调用；额度是服务端计数，端侧只读展示 */
export async function refreshQuota(): Promise<void> {
  try {
    const userId = await getOwnerId();
    if (!userId) return;
    const { data, error } = await supabase.rpc('get_qwen_quota', { p_limit: QWEN_DAILY_LIMIT });
    if (error) throw error;
    const row = (Array.isArray(data) ? data[0] : data) as
      | { used?: number; remaining?: number; unlimited?: boolean }
      | undefined;
    if (!row) return;
    commit({
      used: Number(row.used ?? 0),
      remaining: Number(row.remaining ?? 0),
      limit: QWEN_DAILY_LIMIT,
      loaded: true,
      unlimited: row.unlimited === true,
    });
  } catch (error) {
    console.error('[quota] 读取模型二当日额度失败:', error);
  }
}

/** 云函数已在响应里带了剩余次数，直接采纳，省一次查询 */
export function syncRemaining(remaining: number): void {
  const left = Math.max(0, Math.min(QWEN_DAILY_LIMIT, Math.round(remaining)));
  commit({ remaining: left, used: QWEN_DAILY_LIMIT - left, loaded: true });
}

export function dismissNotice(): void {
  if (noticeTimer) {
    clearTimeout(noticeTimer);
    noticeTimer = null;
  }
  if (!snapshot.notice) return;
  commit({ notice: null });
}

function showNotice(notice: Omit<BuiltinNotice, 'id'>): void {
  noticeSeq += 1;
  if (noticeTimer) clearTimeout(noticeTimer);
  commit({ notice: { ...notice, id: noticeSeq } });
  noticeTimer = setTimeout(() => {
    noticeTimer = null;
    commit({ notice: null });
  }, 9000);
}

/** 云函数回传 fellBack：智谱这次没走通，已自动改用模型二，等于扣了 1 次额度 */
export function reportFallback(remaining?: number): void {
  if (typeof remaining === 'number') syncRemaining(remaining);
  else void refreshQuota();
  const left = typeof remaining === 'number' ? `今日剩余 ${Math.max(0, remaining)} 次` : '本次已计入今日额度';
  showNotice({
    tone: 'warn',
    title: '模型一繁忙，已改用模型二',
    message: `智谱（模型一）正在限流，这一次由千问（模型二）完成，${left}。想省额度可以稍后再回模型一重试。`,
    actionLabel: '去切换',
    actionPath: '/ai-config',
  });
}

/** 今日额度已用完：只停用模型二，模型一不受影响 */
export function reportQuotaExceeded(): void {
  commit({ remaining: 0, used: QWEN_DAILY_LIMIT, loaded: true });
  showNotice({
    tone: 'danger',
    title: '模型二今日已停用',
    message: '千问（模型二）今日 2 次免费额度已用完，明天 00:00 自动恢复。现在可以切回模型一（智谱）继续重试，模型一不限次数。',
    actionLabel: '去切换',
    actionPath: '/ai-config',
  });
}

/** 智谱被限流且没能降级成功：前端明确提示换到模型二 */
export function reportZhipuBusy(): void {
  showNotice({
    tone: 'warn',
    title: '模型一当前访问量过大',
    message: '智谱（模型一）免费模型正在限流。可以切到模型二（千问）用今天的额度，或过一会儿再回来碰运气。',
    actionLabel: '去切换',
    actionPath: '/ai-config',
  });
}

/** 两个云函数用的是同一句提示语，端侧靠它识别「额度已用完」 */
export function isQuotaExceededMessage(message: string): boolean {
  return message.includes('额度已用完');
}

/** 智谱免费模型限流（HTTP 429 / code 1305）在云函数里被翻译成「繁忙」 */
export function isZhipuBusyMessage(message: string): boolean {
  return message.includes('繁忙') || message.includes('访问量过大') || message.includes('1305');
}
