/**
 * 断点进度：按「账号 + 题库 + 模式」各存一条，互不覆盖
 * 唯一索引 (bank_id, mode) 保证 upsert 命中同一行；bank_id 是全局唯一 UUID，
 * 因此不需要把它扩进唯一索引，读写额外带 user_id 做账号隔离。
 */
import { supabase } from '../supabase/client';
import { getOwnerId } from './ownerId';
import type { ProgressAnswer, QuizMode, SavedProgress } from '../types/quiz';

const TABLE = 'quiz_progress';

function log(stage: string, error: unknown): void {
  console.error(`[progress] ${stage} failed:`, error);
}

/** 落库形状：字段必须都是确定值，supabase-js 的 Json 类型会因 undefined 拒绝整个 payload */
interface AnswerMap {
  [questionId: string]: { correct: boolean; manual: boolean; seen: boolean; reason: string; given: string; score?: number };
}

function toProgress(row: Record<string, unknown>): SavedProgress {
  const rawIds = row.question_ids;
  const questionIds = Array.isArray(rawIds) ? rawIds.map((v) => String(v)) : [];
  const rawAnswers = row.answers;
  const answers: AnswerMap =
    rawAnswers && typeof rawAnswers === 'object' && !Array.isArray(rawAnswers) ? (rawAnswers as AnswerMap) : {};
  return {
    bankId: String(row.bank_id),
    bankName: String(row.bank_name ?? '题库'),
    mode: (String(row.mode ?? 'seq') as QuizMode),
    questionIds,
    answers,
    cursor: Number(row.cursor ?? 0),
    total: Number(row.total ?? questionIds.length),
    updatedAt: String(row.updated_at ?? new Date().toISOString()),
  };
}

/** 保存 / 覆盖某个模式下的进度 */
export async function saveProgress(progress: SavedProgress): Promise<boolean> {
  const userId = await getOwnerId();
  // 未登录时 user_id 为空串，uuid 列上的 eq. 过滤会被 PostgREST 判 400，必须在这里挡住
  if (!userId) return false;
  const answers: AnswerMap = {};
  Object.entries(progress.answers ?? {}).forEach(([qid, a]) => {
    const entry: AnswerMap[string] = {
      correct: a.correct === true,
      manual: a.manual === true,
      seen: a.seen === true,
      reason: typeof a.reason === 'string' ? a.reason : '',
      given: typeof a.given === 'string' ? a.given : '',
    };
    // jsonb 里不能出现 undefined，因此只在真有值的时候挂 score，否则续练时多选题的半分会被折算成 0
    if (typeof a.score === 'number' && Number.isFinite(a.score)) entry.score = a.score;
    answers[qid] = entry;
  });
  const payload: {
    bank_id: string;
    mode: string;
    question_ids: string[];
    answers: AnswerMap;
    cursor: number;
    total: number;
    bank_name: string;
    user_id: string;
    updated_at: string;
  } = {
    bank_id: progress.bankId,
    mode: progress.mode,
    question_ids: progress.questionIds,
    answers,
    cursor: progress.cursor,
    total: progress.total,
    bank_name: progress.bankName,
    user_id: userId,
    updated_at: new Date().toISOString(),
  };
  const { error } = await supabase.from(TABLE).upsert(payload, { onConflict: 'bank_id,mode' });
  if (error) {
    log('save', error);
    return false;
  }
  const { data, error: checkErr } = await supabase
    .from(TABLE)
    .select('id')
    .eq('bank_id', progress.bankId)
    .eq('mode', progress.mode)
    .eq('user_id', userId)
    .maybeSingle();
  if (checkErr) log('verify', checkErr);
  if (!data) {
    log('verify', '写入后未查到进度行，可能被权限策略拦截');
    return false;
  }
  return true;
}

/** 某题库下所有模式的进度 */
export async function listProgress(bankId: string): Promise<SavedProgress[]> {
  const userId = await getOwnerId();
  if (!userId) return [];
  const { data, error } = await supabase
    .from(TABLE)
    .select('*')
    .eq('bank_id', bankId)
    .eq('user_id', userId)
    .order('updated_at', { ascending: false });
  if (error) {
    log('list', error);
    return [];
  }
  return (data ?? []).map((row) => toProgress(row as Record<string, unknown>));
}

/** 全部题库的未完成进度（首页「继续上次」用） */
export async function listAllProgress(): Promise<SavedProgress[]> {
  const userId = await getOwnerId();
  if (!userId) return [];
  const { data, error } = await supabase
    .from(TABLE)
    .select('*')
    .eq('user_id', userId)
    .order('updated_at', { ascending: false })
    .limit(60);
  if (error) {
    log('listAll', error);
    return [];
  }
  return (data ?? []).map((row) => toProgress(row as Record<string, unknown>));
}

export async function loadProgress(bankId: string, mode: QuizMode): Promise<SavedProgress | null> {
  const userId = await getOwnerId();
  if (!userId) return null;
  const { data, error } = await supabase
    .from(TABLE)
    .select('*')
    .eq('bank_id', bankId)
    .eq('mode', mode)
    .eq('user_id', userId)
    .maybeSingle();
  if (error) {
    log('load', error);
    return null;
  }
  return data ? toProgress(data as Record<string, unknown>) : null;
}

/** 删除进度：不传 mode 则清掉该题库全部模式 */
export async function clearProgress(bankId: string, mode?: QuizMode): Promise<boolean> {
  const userId = await getOwnerId();
  if (!userId) return false;
  let query = supabase.from(TABLE).delete().eq('bank_id', bankId).eq('user_id', userId);
  if (mode) query = query.eq('mode', mode);
  const { error } = await query;
  if (error) {
    log('clear', error);
    return false;
  }
  return true;
}

/** 真实作答过的题数（不含背题模式的浏览标记） */
export function answeredCount(progress: SavedProgress): number {
  return Object.values(progress.answers ?? {}).filter((a) => !a.seen).length;
}

/** 背题模式浏览过的题数 */
export function seenCount(progress: SavedProgress): number {
  return Object.values(progress.answers ?? {}).filter((a) => a.seen === true).length;
}

/** 进度完成度：背题看浏览数，其余模式看真实作答数 */
export function progressDone(progress: SavedProgress): number {
  return progress.mode === 'memorize' ? seenCount(progress) : answeredCount(progress);
}

/** 是否已经练完（进度到最后一题且全部作答） */
export function isFinished(progress: SavedProgress): boolean {
  return progress.total > 0 && answeredCount(progress) >= progress.total;
}
