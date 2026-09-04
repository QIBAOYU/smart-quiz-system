/**
 * 题目收藏：把「值得反复看的题」从错题本里单独拎出来。
 *
 * 错题本是系统判定「你答错过」，收藏是用户自己判定「这题重要」，两者口径不同，
 * 混在一张表里会导致「清理已掌握错题」误删用户手动标记的重点题。
 *
 * 端侧缓存一份 questionId 集合，避免每道题都发一次请求：
 * 题库详情页一次渲染几十道题，逐题查收藏状态就是几十次请求。
 */
import { supabase } from '../supabase/client';
import { getOwnerId } from './ownerId';
import { useSyncExternalStore } from 'react';
import type { Question } from '../types/quiz';

let cachedIds: Set<string> = new Set();
let loadedOwner: string | null = null;
let loading = false;
const listeners = new Set<() => void>();

function emit(): void {
  listeners.forEach((fn) => fn());
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** 引用必须稳定，否则 useSyncExternalStore 会无限重渲染 */
function snapshot(): Set<string> {
  return cachedIds;
}

/** 换账号时必须清空，否则新账号会看到上一个账号的星标 */
export function resetFavorites(): void {
  cachedIds = new Set();
  loadedOwner = null;
  emit();
}

export async function loadFavoriteIds(): Promise<Set<string>> {
  const userId = await getOwnerId();
  if (!userId) {
    if (loadedOwner !== null) resetFavorites();
    return cachedIds;
  }
  if (loadedOwner === userId) return cachedIds;
  if (loading) return cachedIds;
  loading = true;
  try {
    const { data, error } = await supabase.from('quiz_favorites').select('question_id').eq('user_id', userId);
    if (error) {
      console.error('[favorites] 读取收藏失败:', error);
      return cachedIds;
    }
    cachedIds = new Set((data ?? []).map((row) => String((row as Record<string, unknown>).question_id)));
    loadedOwner = userId;
    emit();
  } finally {
    loading = false;
  }
  return cachedIds;
}

/**
 * 切换收藏状态，返回切换后的结果（true = 已收藏）。
 *
 * RLS 收紧后写失败是静默的，所以必须带 .select() 回读判定：
 * insert 被策略拦下时 error 仍可能为 null，只有回读行数为 0 才知道真没写进去。
 */
export async function toggleFavorite(question: Question): Promise<boolean | null> {
  const userId = await getOwnerId();
  if (!userId) return null;
  const had = cachedIds.has(question.id);
  if (had) {
    const { data, error } = await supabase
      .from('quiz_favorites')
      .delete()
      .eq('user_id', userId)
      .eq('question_id', question.id)
      .select('id');
    if (error) {
      console.error('[favorites] 取消收藏失败:', error);
      return null;
    }
    if (!data || data.length === 0) {
      // 云端没有这行（可能是别的设备已取消），本地直接对齐
      cachedIds = new Set(cachedIds);
      cachedIds.delete(question.id);
      emit();
      return false;
    }
    cachedIds = new Set(cachedIds);
    cachedIds.delete(question.id);
    emit();
    return false;
  }

  const { error } = await supabase
    .from('quiz_favorites')
    .insert({ user_id: userId, question_id: question.id, bank_id: question.bankId });
  if (error) {
    console.error('[favorites] 收藏失败:', error);
    return null;
  }
  cachedIds = new Set(cachedIds);
  cachedIds.add(question.id);
  emit();
  return true;
}

/** 收藏的题目（跨题库，按收藏时间倒序） */
export async function listFavoriteQuestions(limit = 300): Promise<Question[]> {
  const userId = await getOwnerId();
  if (!userId) return [];
  const { data, error } = await supabase
    .from('quiz_favorites')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) {
    console.error('[favorites] 读取收藏题目失败:', error);
    return [];
  }
  const ids = (data ?? []).map((row) => String((row as Record<string, unknown>).question_id));
  if (ids.length === 0) return [];
  const { listQuestionsByIds } = await import('./quizStore');
  const rows = await listQuestionsByIds(ids);
  const map = new Map(rows.map((q) => [q.id, q]));
  // 保持收藏时间顺序，而不是 quizStore 的默认顺序
  return ids.map((id) => map.get(id)).filter((q): q is Question => Boolean(q));
}

export function useFavorites(): { ids: Set<string>; count: number } {
  const ids = useSyncExternalStore(subscribe, snapshot, snapshot);
  return { ids, count: ids.size };
}
