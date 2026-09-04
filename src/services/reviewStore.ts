/**
 * 间隔重复复习（Leitner 盒子简化版）。
 *
 * 只有 5 个档位、间隔 1/2/4/7/15 天，比完整 SM-2 少一堆需要调分的参数，
 * 但已经能实现「答得越熟，越晚再见」；答错直接降回第 1 档，明天再见。
 *
 * 每次作答都会 upsert 一行，所以复习计划是从日常刷题里自动长出来的，
 * 用户不需要先「加入复习计划」。
 */
import { supabase } from '../supabase/client';
import { getOwnerId } from './ownerId';
import type { Question, ReviewPlan } from '../types/quiz';

/** 档位 1-5 对应的间隔天数 */
const INTERVAL_DAYS = [1, 2, 4, 7, 15];
const MAX_BOX = INTERVAL_DAYS.length;

function isoAfterDays(days: number): string {
  return new Date(Date.now() + days * 86400000).toISOString();
}

function clampBox(value: unknown): number {
  const n = Number(value ?? 1);
  if (!Number.isFinite(n)) return 1;
  return Math.min(MAX_BOX, Math.max(1, Math.round(n)));
}

function toPlan(row: Record<string, unknown>): ReviewPlan {
  return {
    questionId: String(row.question_id ?? ''),
    bankId: String(row.bank_id ?? ''),
    box: clampBox(row.box),
    dueAt: String(row.due_at ?? ''),
    lastReviewAt: row.last_review_at ? String(row.last_review_at) : null,
    reviewCount: Number(row.review_count ?? 0),
  };
}

/**
 * 答完一题后更新记忆档位。
 *
 * 走 upsert 而非「先查后写」：日常刷题每题都要调一次，
 * 两次往返会把答题的等待时间放大一倍。
 * 失败只打日志 —— 复习计划是增值功能，不该因为它失败而让作答反馈报错。
 */
export async function upsertReview(questionId: string, bankId: string, correct: boolean): Promise<void> {
  const userId = await getOwnerId();
  if (!userId) return;
  const now = new Date().toISOString();
  const { data, error: readErr } = await supabase
    .from('quiz_reviews')
    .select('box, review_count')
    .eq('user_id', userId)
    .eq('question_id', questionId)
    .maybeSingle();
  if (readErr) {
    console.error('[reviews] 读取档位失败:', readErr);
    return;
  }
  const row = (data ?? null) as Record<string, unknown> | null;
  const prevBox = row ? clampBox(row.box) : 1;
  const prevCount = row ? Number(row.review_count ?? 0) : 0;
  const nextBox = correct ? Math.min(MAX_BOX, prevBox + 1) : 1;
  const payload = {
    user_id: userId,
    question_id: questionId,
    bank_id: bankId,
    box: nextBox,
    due_at: isoAfterDays(INTERVAL_DAYS[nextBox - 1]),
    last_review_at: now,
    review_count: prevCount + 1,
  };
  const { error } = await supabase
    .from('quiz_reviews')
    .upsert(payload, { onConflict: 'user_id,question_id' });
  if (error) console.error('[reviews] 写入复习计划失败:', error);
}

/** 已到期、该复习的题目 id（按到期时间由早到晚，越拖得久越先出现） */
export async function listDueQuestionIds(limit = 200): Promise<string[]> {
  const userId = await getOwnerId();
  if (!userId) return [];
  const { data, error } = await supabase
    .from('quiz_reviews')
    .select('question_id')
    .eq('user_id', userId)
    .lte('due_at', new Date().toISOString())
    .order('due_at', { ascending: true })
    .limit(limit);
  if (error) {
    console.error('[reviews] 读取到期题目失败:', error);
    return [];
  }
  return (data ?? []).map((row) => String((row as Record<string, unknown>).question_id));
}

/** 到期复习题（已按到期顺序排好，题目被删掉的会自动跳过） */
export async function listDueQuestions(limit = 200): Promise<Question[]> {
  const ids = await listDueQuestionIds(limit);
  if (ids.length === 0) return [];
  const { listQuestionsByIds } = await import('./quizStore');
  const rows = await listQuestionsByIds(ids);
  const map = new Map(rows.map((q) => [q.id, q]));
  return ids.map((id) => map.get(id)).filter((q): q is Question => Boolean(q));
}

export interface ReviewSummary {
  /** 今天该复习多少题 */
  due: number;
  /** 计划里一共多少题 */
  planned: number;
  /** 最高档（已很熟）的题数 */
  mastered: number;
}

/**
 * 复习概览。
 *
 * 三个数都走精确 count（head: true 不返回明细），
 * 避免为了算一个角标把上千行计划全拉下来。
 */
export async function loadReviewSummary(bankId?: string): Promise<ReviewSummary> {
  const empty: ReviewSummary = { due: 0, planned: 0, mastered: 0 };
  const userId = await getOwnerId();
  if (!userId) return empty;
  const now = new Date().toISOString();
  const scope = <T extends { eq: (col: string, v: string) => T }>(q: T) => (bankId ? q.eq('bank_id', bankId) : q);
  const [dueRes, plannedRes, masteredRes] = await Promise.all([
    scope(
      supabase.from('quiz_reviews').select('id', { count: 'exact', head: true }).eq('user_id', userId),
    ).lte('due_at', now),
    supabase.from('quiz_reviews').select('id', { count: 'exact', head: true }).eq('user_id', userId),
    scope(
      supabase
        .from('quiz_reviews')
        .select('id', { count: 'exact', head: true })
        .eq('user_id', userId)
        .gte('box', MAX_BOX),
    ),
  ]);
  if (dueRes.error || plannedRes.error) {
    console.error('[reviews] 统计复习概览失败:', dueRes.error ?? plannedRes.error);
    return empty;
  }
  return {
    due: dueRes.count ?? 0,
    planned: plannedRes.count ?? 0,
    mastered: masteredRes.count ?? 0,
  };
}

/** 某题库的到期题数，供题库详情页显示角标 */
export async function countDueForBank(bankId: string): Promise<number> {
  const summary = await loadReviewSummary(bankId);
  return summary.due;
}

export const REVIEW_INTERVALS = INTERVAL_DAYS;
export const REVIEW_MAX_BOX = MAX_BOX;
