/**
 * 统计服务：全部基于云端真实答题记录聚合，不使用任何示例数据。
 * 所有查询都限定在当前登录账号的 user_id 范围内，与题库隔离口径一致。
 */
import { supabase } from '../supabase/client';
import { getOwnerId } from './ownerId';
import type { DayStat, QuestionType, StatsSummary, SubjectStat, TypeStat } from '../types/quiz';

interface AttemptRow {
  created_at: string;
  correct: boolean;
  bank_id: string | null;
  question_id: string | null;
}

/** 科目为空的题目在统计里的分组名 */
export const UNCLASSIFIED = '未分类';

interface KeyAgg {
  attempts: number;
  correct: number;
  masteredQuestions: number;
}

function log(stage: string, error: unknown): void {
  console.error(`[stats] ${stage} failed:`, error);
}

function dayKey(date: Date): string {
  const y = date.getFullYear();
  const m = `${date.getMonth() + 1}`.padStart(2, '0');
  const d = `${date.getDate()}`.padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** 近 7 日（含今天）的日期桶 */
function buildBuckets(): Map<string, DayStat> {
  const buckets = new Map<string, DayStat>();
  const today = new Date();
  for (let i = 6; i >= 0; i -= 1) {
    const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() - i);
    const key = dayKey(d);
    buckets.set(key, { date: key, label: `${d.getMonth() + 1}/${d.getDate()}`, count: 0, correct: 0 });
  }
  return buckets;
}

/** 连续打卡天数：从今天（或昨天）往前连续有作答记录的天数 */
function streakFrom(days: Set<string>): number {
  let streak = 0;
  const cursor = new Date();
  if (!days.has(dayKey(cursor))) {
    cursor.setDate(cursor.getDate() - 1);
    if (!days.has(dayKey(cursor))) return 0;
  }
  while (days.has(dayKey(cursor))) {
    streak += 1;
    cursor.setDate(cursor.getDate() - 1);
  }
  return streak;
}

/**
 * 已掌握题目集合（与错题本同口径）：该题最近一次作答正确，
 * 且它没有还挂在错题本的「待消灭」里。答对过一次但后来答错的题不算掌握。
 */
function masteredQuestionIds(attempts: AttemptRow[], openWrong: Set<string>): Set<string> {
  const last = new Map<string, { at: number; correct: boolean }>();
  for (const a of attempts) {
    if (!a.question_id) continue;
    const at = new Date(a.created_at).getTime();
    const cur = last.get(a.question_id);
    if (!cur || at >= cur.at) last.set(a.question_id, { at, correct: a.correct });
  }
  const set = new Set<string>();
  last.forEach((v, qid) => {
    if (v.correct && !openWrong.has(qid)) set.add(qid);
  });
  return set;
}

/** 按任意维度（题型 / 科目）聚合作答次数、答对次数与已掌握题数 */
function aggregateAttemptsByKey(
  attempts: AttemptRow[],
  keyById: Map<string, string>,
  mastered: Set<string>,
  unknownKey: string,
): Map<string, KeyAgg> {
  const agg = new Map<string, KeyAgg>();
  const bump = (key: string) => {
    const cur = agg.get(key) ?? { attempts: 0, correct: 0, masteredQuestions: 0 };
    agg.set(key, cur);
    return cur;
  };
  for (const a of attempts) {
    const cur = bump((a.question_id ? keyById.get(a.question_id) : undefined) || unknownKey);
    cur.attempts += 1;
    if (a.correct) cur.correct += 1;
  }
  // 已删除的题目查不到归属，不计入分子，避免掌握数超过题目总数
  mastered.forEach((qid) => {
    const known = keyById.get(qid);
    if (known) bump(known).masteredQuestions += 1;
  });
  return agg;
}

/** 以「该分组题目总数」为基准生成分组列表，没有作答记录的分组也要出现 */
function buildKeyStats(
  keyTotal: Map<string, number>,
  agg: Map<string, KeyAgg>,
): Array<{ key: string; total: number; attempts: number; correct: number; masteredQuestions: number }> {
  const keys = new Set<string>(Array.from(keyTotal.keys()));
  agg.forEach((_v, k) => keys.add(k));
  return Array.from(keys)
    .map((key) => {
      const total = keyTotal.get(key) ?? 0;
      const v = agg.get(key);
      return {
        key,
        total,
        attempts: v?.attempts ?? 0,
        correct: v?.correct ?? 0,
        masteredQuestions: Math.min(total, v?.masteredQuestions ?? 0),
      };
    })
    .sort((a, b) => b.total - a.total || b.attempts - a.attempts);
}

type KeyRow = ReturnType<typeof buildKeyStats>[number];

function toTypeStats(rows: KeyRow[]): TypeStat[] {
  return rows.map((v) => ({
    type: v.key as QuestionType,
    total: v.total,
    attempts: v.attempts,
    correct: v.correct,
    masteredQuestions: v.masteredQuestions,
  }));
}

function toSubjectStats(rows: KeyRow[]): SubjectStat[] {
  return rows.map((v) => ({
    subject: v.key,
    total: v.total,
    attempts: v.attempts,
    correct: v.correct,
    accuracy: v.attempts > 0 ? Math.round((v.correct / v.attempts) * 100) : 0,
    masteredQuestions: v.masteredQuestions,
  }));
}

/**
 * 作答明细的扫描上限：按 created_at 倒序取最近 N 条。
 * 不加限制时每次进统计页都会把该账号的 quiz_attempts 全表拉回端侧，
 * 刷到几千条之后明显变慢。总量仍用 count 精确统计，
 * 因此「总作答次数」不受影响，只有分题库 / 分题型 / 分科目的
 * 作答次数与「已掌握」判定基于最近这些记录（判「最近一次作答」正好只需要近期数据）。
 */
const ATTEMPT_SCAN_LIMIT = 5000;

export async function loadStats(): Promise<StatsSummary> {
  const empty: StatsSummary = {
    totalAttempts: 0,
    totalCorrect: 0,
    accuracy: 0,
    bankCount: 0,
    questionCount: 0,
    masteredQuestions: 0,
    wrongPending: 0,
    masteredCount: 0,
    todayCount: 0,
    streakDays: 0,
    last7: [],
    byBank: [],
    byType: [],
    bySubject: [],
  };

  const since = new Date();
  since.setDate(since.getDate() - 6);
  since.setHours(0, 0, 0, 0);

  // 未登录（会话恢复中 / 已退出）直接返回空壳：uuid 列用空串过滤会被 PostgREST 判成非法 uuid 并 400
  const userId = await getOwnerId();
  if (!userId) return empty;
  const [attemptsRes, totalRes, totalCorrectRes, recentRes, banksRes, wrongRes, typeRes] = await Promise.all([
    supabase
      .from('quiz_attempts')
      .select('created_at, correct, bank_id, question_id')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(ATTEMPT_SCAN_LIMIT),
    // 总量与答对数走精确 count：明细被截断时，首页与统计页的大数字依然真实
    supabase.from('quiz_attempts').select('id', { count: 'exact', head: true }).eq('user_id', userId),
    supabase
      .from('quiz_attempts')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', userId)
      .eq('correct', true),
    supabase
      .from('quiz_attempts')
      .select('created_at, correct, bank_id, question_id')
      .eq('user_id', userId)
      .gte('created_at', since.toISOString()),
    supabase.from('quiz_banks').select('id, name, question_count').eq('user_id', userId),
    supabase.from('quiz_wrong_book').select('resolved, question_id').eq('user_id', userId),
    supabase.from('quiz_questions').select('id, type, subject').eq('user_id', userId),
  ]);

  if (attemptsRes.error) log('load attempts', attemptsRes.error);
  if (totalRes.error) log('count attempts', totalRes.error);
  if (banksRes.error) log('load banks', banksRes.error);

  const attempts = (attemptsRes.data ?? []) as AttemptRow[];
  const recent = (recentRes.data ?? []) as AttemptRow[];
  const banks = (banksRes.data ?? []) as Array<Record<string, unknown>>;
  const wrong = (wrongRes.data ?? []) as Array<{ resolved: boolean; question_id: string | null }>;
  const questions = (typeRes.data ?? []) as Array<{ id: string; type: string; subject: string | null }>;

  const totalAttempts = Number(totalRes.count ?? attempts.length);
  const totalCorrect = Number(totalCorrectRes.count ?? attempts.filter((a) => a.correct).length);

  const buckets = buildBuckets();
  const activeDays = new Set<string>();
  for (const a of recent) {
    const key = dayKey(new Date(a.created_at));
    const bucket = buckets.get(key);
    if (bucket) {
      bucket.count += 1;
      if (a.correct) bucket.correct += 1;
    }
    activeDays.add(dayKey(new Date(a.created_at)));
  }

  const todayKey = dayKey(new Date());
  const bankNameById = new Map(banks.map((b) => [String(b.id), String(b.name ?? '未命名题库')]));
  const bankAgg = new Map<string, { count: number; correct: number }>();
  for (const a of attempts) {
    const id = a.bank_id ?? 'unknown';
    const cur = bankAgg.get(id) ?? { count: 0, correct: 0 };
    cur.count += 1;
    if (a.correct) cur.correct += 1;
    bankAgg.set(id, cur);
  }
  // 统计页要展示「每个题库」，因此以云端题库清单为基准补齐未作答的题库，不再截断
  const allBankIds = new Set<string>(banks.map((b) => String(b.id)));
  bankAgg.forEach((_v, id) => allBankIds.add(id));
  const byBank = Array.from(allBankIds)
    .map((id) => {
      const v = bankAgg.get(id) ?? { count: 0, correct: 0 };
      return {
        id,
        name: bankNameById.get(id) ?? '已删除的题库',
        count: v.count,
        accuracy: v.count ? Math.round((v.correct / v.count) * 100) : 0,
      };
    })
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));

  const typeById = new Map(questions.map((q) => [q.id, q.type]));
  const typeTotal = new Map<string, number>();
  questions.forEach((q) => typeTotal.set(q.type, (typeTotal.get(q.type) ?? 0) + 1));
  const subjectById = new Map(questions.map((q) => [q.id, q.subject || UNCLASSIFIED]));
  const subjectTotal = new Map<string, number>();
  questions.forEach((q) => {
    const key = q.subject || UNCLASSIFIED;
    subjectTotal.set(key, (subjectTotal.get(key) ?? 0) + 1);
  });
  const openWrong = new Set(wrong.filter((w) => !w.resolved && w.question_id).map((w) => String(w.question_id)));
  const openMastered = masteredQuestionIds(attempts, openWrong);
  const byType = toTypeStats(buildKeyStats(typeTotal, aggregateAttemptsByKey(attempts, typeById, openMastered, 'short')));
  const bySubject = toSubjectStats(
    buildKeyStats(subjectTotal, aggregateAttemptsByKey(attempts, subjectById, openMastered, UNCLASSIFIED)),
  );
  // 每题只属于一个题型，故各题型已掌握题数之和即全局已掌握题数
  const masteredQuestions = byType.reduce((sum, v) => sum + v.masteredQuestions, 0);

  return {
    totalAttempts,
    totalCorrect,
    accuracy: totalAttempts ? Math.round((totalCorrect / totalAttempts) * 100) : 0,
    bankCount: banks.length,
    questionCount: questions.length,
    masteredQuestions,
    wrongPending: wrong.filter((w) => !w.resolved).length,
    masteredCount: wrong.filter((w) => w.resolved).length,
    todayCount: buckets.get(todayKey)?.count ?? 0,
    streakDays: streakFrom(activeDays),
    last7: Array.from(buckets.values()),
    byBank,
    byType,
    bySubject,
  };
}

/** 单个题库的分题型表现（与全局统计同口径） */
export type BankTypeStat = TypeStat;

/** 单个题库的详细统计 */
export interface BankStats {
  bankId: string;
  bankName: string;
  questionCount: number;
  reviewedCount: number;
  attempts: number;
  correct: number;
  /** 0-100 百分数 */
  accuracy: number;
  todayCount: number;
  streakDays: number;
  last7: DayStat[];
  byType: BankTypeStat[];
  wrongPending: number;
  masteredCount: number;
}

/** 单题库统计详情：只聚合该题库的作答记录 */
export async function loadBankStats(bankId: string): Promise<BankStats | null> {
  const since = new Date();
  since.setDate(since.getDate() - 6);
  since.setHours(0, 0, 0, 0);

  const userId = await getOwnerId();
  if (!userId) return null;
  const [bankRes, attemptsRes, totalRes, totalCorrectRes, recentRes, wrongRes, questionsRes] = await Promise.all([
    supabase
      .from('quiz_banks')
      .select('id, name, question_count, reviewed_count')
      .eq('id', bankId)
      .eq('user_id', userId)
      .maybeSingle(),
    supabase
      .from('quiz_attempts')
      .select('created_at, correct, question_id')
      .eq('bank_id', bankId)
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(ATTEMPT_SCAN_LIMIT),
    supabase.from('quiz_attempts').select('id', { count: 'exact', head: true }).eq('bank_id', bankId).eq('user_id', userId),
    supabase
      .from('quiz_attempts')
      .select('id', { count: 'exact', head: true })
      .eq('bank_id', bankId)
      .eq('user_id', userId)
      .eq('correct', true),
    supabase
      .from('quiz_attempts')
      .select('created_at, correct, question_id')
      .eq('bank_id', bankId)
      .eq('user_id', userId)
      .gte('created_at', since.toISOString()),
    supabase
      .from('quiz_wrong_book')
      .select('resolved, wrong_count, question_id')
      .eq('bank_id', bankId)
      .eq('user_id', userId),
    supabase.from('quiz_questions').select('id, type, reviewed').eq('bank_id', bankId).eq('user_id', userId),
  ]);

  if (bankRes.error) log('load bank', bankRes.error);
  if (attemptsRes.error) log('load bank attempts', attemptsRes.error);
  if (!bankRes.data) return null;

  const bank = bankRes.data as Record<string, unknown>;
  const attempts = (attemptsRes.data ?? []) as AttemptRow[];
  const recent = (recentRes.data ?? []) as AttemptRow[];
  const wrong = (wrongRes.data ?? []) as Array<{ resolved: boolean; wrong_count: number; question_id: string | null }>;
  const questions = (questionsRes.data ?? []) as Array<{ id: string; type: string; reviewed: boolean }>;

  const totalAttempts = Number(totalRes.count ?? attempts.length);
  const totalCorrect = Number(totalCorrectRes.count ?? attempts.filter((a) => a.correct).length);

  const buckets = buildBuckets();
  const activeDays = new Set<string>();
  for (const a of recent) {
    const bucket = buckets.get(dayKey(new Date(a.created_at)));
    if (bucket) {
      bucket.count += 1;
      if (a.correct) bucket.correct += 1;
    }
    activeDays.add(dayKey(new Date(a.created_at)));
  }

  const typeById = new Map(questions.map((q) => [q.id, q.type]));
  const typeTotal = new Map<string, number>();
  questions.forEach((q) => typeTotal.set(q.type, (typeTotal.get(q.type) ?? 0) + 1));
  const openWrong = new Set(wrong.filter((w) => !w.resolved && w.question_id).map((w) => String(w.question_id)));
  const byType = toTypeStats(
    buildKeyStats(
      typeTotal,
      aggregateAttemptsByKey(attempts, typeById, masteredQuestionIds(attempts, openWrong), 'short'),
    ),
  );

  const reviewedFromQuestions = questions.filter((q) => q.reviewed).length;

  return {
    bankId,
    bankName: String(bank.name ?? '未命名题库'),
    questionCount: Number(bank.question_count ?? questions.length),
    reviewedCount: Number(bank.reviewed_count ?? reviewedFromQuestions),
    attempts: totalAttempts,
    correct: totalCorrect,
    accuracy: totalAttempts ? Math.round((totalCorrect / totalAttempts) * 100) : 0,
    todayCount: buckets.get(dayKey(new Date()))?.count ?? 0,
    streakDays: streakFrom(activeDays),
    last7: Array.from(buckets.values()),
    byType,
    wrongPending: wrong.filter((w) => !w.resolved).length,
    masteredCount: wrong.filter((w) => w.resolved).length,
  };
}

/** 总错题本按题库分组的汇总行 */
export interface WrongBankGroup {
  bankId: string;
  bankName: string;
  /** 待消灭（未掌握）错题数 */
  pending: number;
  /** 错 3 次以上的顽固错题数 */
  heavy: number;
  /** 已攻克错题数 */
  mastered: number;
  /** 该题库错题记录总数 */
  total: number;
}

/** 错题本分组汇总：每个题库一行，点击进入该题库的错题练习 */
export async function loadWrongGroups(): Promise<WrongBankGroup[]> {
  const userId = await getOwnerId();
  if (!userId) return [];
  const [wrongRes, banksRes] = await Promise.all([
    supabase.from('quiz_wrong_book').select('bank_id, wrong_count, resolved').eq('user_id', userId),
    supabase.from('quiz_banks').select('id, name').eq('user_id', userId),
  ]);
  if (wrongRes.error) log('load wrong groups', wrongRes.error);
  if (banksRes.error) log('load banks for wrong groups', banksRes.error);

  const rows = (wrongRes.data ?? []) as Array<{ bank_id: string | null; wrong_count: number; resolved: boolean }>;
  const banks = (banksRes.data ?? []) as Array<Record<string, unknown>>;
  const nameById = new Map(banks.map((b) => [String(b.id), String(b.name ?? '未命名题库')]));

  const agg = new Map<string, WrongBankGroup>();
  for (const r of rows) {
    const id = r.bank_id ?? 'unknown';
    const cur =
      agg.get(id) ??
      ({ bankId: id, bankName: nameById.get(id) ?? '已删除的题库', pending: 0, heavy: 0, mastered: 0, total: 0 } satisfies WrongBankGroup);
    cur.total += 1;
    if (r.resolved) cur.mastered += 1;
    else {
      cur.pending += 1;
      if (Number(r.wrong_count ?? 0) >= 3) cur.heavy += 1;
    }
    agg.set(id, cur);
  }

  return Array.from(agg.values()).sort((a, b) => b.pending - a.pending || b.total - a.total || a.bankName.localeCompare(b.bankName));
}

/** 错题本按科目分组的汇总行 */
export interface WrongSubjectGroup {
  subject: string;
  /** 待消灭（未掌握）错题数 */
  pending: number;
  /** 错 3 次以上的顽固错题数 */
  heavy: number;
  /** 已攻克错题数 */
  mastered: number;
  /** 该科目错题记录总数 */
  total: number;
}

/**
 * 错题本按科目汇总：quiz_wrong_book 本身不存科目，
 * 靠 question_id 回查 quiz_questions.subject；查不到的（含已删题）归「未分类」。
 */
export async function loadWrongSubjectGroups(): Promise<WrongSubjectGroup[]> {
  const userId = await getOwnerId();
  if (!userId) return [];
  const [wrongRes, questionsRes] = await Promise.all([
    supabase.from('quiz_wrong_book').select('question_id, wrong_count, resolved').eq('user_id', userId),
    supabase.from('quiz_questions').select('id, subject').eq('user_id', userId),
  ]);
  if (wrongRes.error) log('load wrong subject groups', wrongRes.error);
  if (questionsRes.error) log('load questions for wrong subject groups', questionsRes.error);

  const rows = (wrongRes.data ?? []) as Array<{ question_id: string | null; wrong_count: number; resolved: boolean }>;
  const questions = (questionsRes.data ?? []) as Array<{ id: string; subject: string | null }>;
  const subjectById = new Map(questions.map((q) => [q.id, q.subject || UNCLASSIFIED]));

  const agg = new Map<string, WrongSubjectGroup>();
  for (const r of rows) {
    const subject = (r.question_id ? subjectById.get(r.question_id) : undefined) ?? UNCLASSIFIED;
    const cur = agg.get(subject) ?? { subject, pending: 0, heavy: 0, mastered: 0, total: 0 };
    cur.total += 1;
    if (r.resolved) cur.mastered += 1;
    else {
      cur.pending += 1;
      if (Number(r.wrong_count ?? 0) >= 3) cur.heavy += 1;
    }
    agg.set(subject, cur);
  }

  return Array.from(agg.values()).sort((a, b) => b.pending - a.pending || b.total - a.total || a.subject.localeCompare(b.subject));
}

/* ==================== 艾宾浩斯遗忘曲线 ==================== */

/** 曲线的一个分组：按「最近一次答对距今多少天」分桶 */
export interface CurveBucket {
  /** 组内代表天数，用于拟合 R = e^(-t/S) */
  day: number;
  label: string;
  /** 组内题数 */
  sample: number;
  /** 组内现在仍记得的题数 */
  remembered: number;
  /** 0-100 留存率 */
  retention: number;
}

export interface ForgettingCurve {
  buckets: CurveBucket[];
  /** 与 buckets 一一对应的理论留存率（同一批 x 坐标，画图时不用换算刻度） */
  theory: Array<{ day: number; retention: number }>;
  /** 拟合出的记忆强度 S（天），越大忘得越慢 */
  stabilityDays: number;
  sample: number;
  remembered: number;
  /** 0-100：所有参与统计的题里，现在还记得的比例 */
  currentRetention: number;
  /** 样本是否够画出一条有意义的曲线 */
  enough: boolean;
}

const CURVE_BUCKETS: Array<{ day: number; label: string; maxDay: number }> = [
  { day: 0, label: '当天', maxDay: 0 },
  { day: 1, label: '1天', maxDay: 1 },
  { day: 2, label: '2天', maxDay: 2 },
  { day: 3, label: '3天', maxDay: 3 },
  { day: 5, label: '4-6天', maxDay: 6 },
  { day: 10, label: '1-2周', maxDay: 14 },
  { day: 21, label: '2-4周', maxDay: 28 },
  { day: 40, label: '1月+', maxDay: Number.MAX_SAFE_INTEGER },
];

function emptyCurveBuckets(): CurveBucket[] {
  return CURVE_BUCKETS.map((b) => ({ day: b.day, label: b.label, sample: 0, remembered: 0, retention: 0 }));
}

/** 距今 N 天落在哪个桶（第一个上界够得着的桶） */
function curveBucketIndex(days: number): number {
  for (let i = 0; i < CURVE_BUCKETS.length; i += 1) {
    if (days <= CURVE_BUCKETS[i].maxDay) return i;
  }
  return CURVE_BUCKETS.length - 1;
}

/**
 * 网格搜索拟合记忆强度 S：让加权平方误差最小（题多的组说话更响）。
 * 比闭式解稳，遇到「一道都没忘」这种退化样本也不会炸出负数。
 */
function fitStability(points: Array<{ t: number; r: number; w: number }>): number {
  if (points.length === 0) return 1;
  let best = 1;
  let bestErr = Number.POSITIVE_INFINITY;
  for (let s = 0.3; s <= 60; s *= 1.04) {
    let err = 0;
    for (const p of points) {
      const diff = p.r - 100 * Math.exp(-p.t / s);
      err += p.w * diff * diff;
    }
    if (err < bestErr) {
      bestErr = err;
      best = s;
    }
  }
  return Math.round(best * 10) / 10;
}

function buildCurve(buckets: CurveBucket[]): ForgettingCurve {
  const sample = buckets.reduce((sum, b) => sum + b.sample, 0);
  const remembered = buckets.reduce((sum, b) => sum + b.remembered, 0);
  const stabilityDays = fitStability(
    buckets.filter((b) => b.sample > 0).map((b) => ({ t: b.day, r: b.retention, w: b.sample })),
  );
  return {
    buckets,
    theory: buckets.map((b) => ({ day: b.day, retention: Math.round(100 * Math.exp(-b.day / stabilityDays)) })),
    stabilityDays,
    sample,
    remembered,
    currentRetention: sample > 0 ? Math.round((remembered / sample) * 100) : 0,
    enough: sample >= 8,
  };
}

/**
 * 遗忘曲线：只统计「至少答对过一次」的题，取两道锚点 ——
 * 距「最近一次答对」的天数决定落在哪个桶，「最近一次作答是否仍正确且错题已清」决定这题现在算不算还记得。
 * 不传 bankId 就是全部题库合并。作答明细同其他统计一样受 ATTEMPT_SCAN_LIMIT 限制，
 * 只保留最近若干条，因此极老的答对记录可能查不到锚点、该题会被跳过。
 */
export async function loadForgettingCurve(bankId?: string): Promise<ForgettingCurve> {
  const userId = await getOwnerId();
  if (!userId) return buildCurve(emptyCurveBuckets());

  const attemptsQuery = supabase
    .from('quiz_attempts')
    .select('created_at, correct, question_id')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(ATTEMPT_SCAN_LIMIT);
  const wrongQuery = supabase.from('quiz_wrong_book').select('question_id, resolved').eq('user_id', userId);

  const [attemptsRes, wrongRes] = await Promise.all([
    bankId ? attemptsQuery.eq('bank_id', bankId) : attemptsQuery,
    bankId ? wrongQuery.eq('bank_id', bankId) : wrongQuery,
  ]);
  if (attemptsRes.error) log('load curve attempts', attemptsRes.error);
  if (wrongRes.error) log('load curve wrong', wrongRes.error);

  const attempts = (attemptsRes.data ?? []) as AttemptRow[];
  const wrong = (wrongRes.data ?? []) as Array<{ question_id: string | null; resolved: boolean }>;
  const openWrong = new Set(wrong.filter((w) => !w.resolved && w.question_id).map((w) => String(w.question_id)));

  const last = new Map<string, { at: number; correct: boolean }>();
  const lastCorrectAt = new Map<string, number>();
  for (const a of attempts) {
    const qid = a.question_id;
    if (!qid) continue;
    const at = new Date(a.created_at).getTime();
    const cur = last.get(qid);
    if (!cur || at >= cur.at) last.set(qid, { at, correct: a.correct });
    if (a.correct) {
      const prev = lastCorrectAt.get(qid);
      if (prev === undefined || at > prev) lastCorrectAt.set(qid, at);
    }
  }

  const buckets = emptyCurveBuckets();
  const now = Date.now();
  lastCorrectAt.forEach((at, qid) => {
    const days = Math.max(0, Math.floor((now - at) / 86400000));
    const rememberedNow = Boolean(last.get(qid)?.correct) && !openWrong.has(qid);
    const bucket = buckets[curveBucketIndex(days)];
    bucket.sample += 1;
    if (rememberedNow) bucket.remembered += 1;
  });
  buckets.forEach((b) => {
    b.retention = b.sample > 0 ? Math.round((b.remembered / b.sample) * 100) : 0;
  });

  return buildCurve(buckets);
}
