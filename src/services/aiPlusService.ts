/**
 * AI 增强能力的端侧编排：薄弱点诊断、批量补解析、错题变式重练、AI 出模拟卷。
 *
 * 全部走 ai-relay 而不是 doc-parse：ai-relay 跟随用户在「设置 → AI 供应商」里配置的
 * 模型，doc-parse 只走内置模型；这几项能力都是「多次小请求 + 端侧聚合回写」，
 * 编排放端侧也便于把进度实时喂给全局 AiTask 进度条。
 */
import {
  diagnoseWeakness,
  generateExplanations,
  generateMockPaper,
  generateSimilarQuestions,
  RelayUnavailableError,
  type Diagnosis,
  type DiagnosisInput,
  type DiagnosisRow,
  type PaperSlot,
  type SimilarSource,
} from './aiService';
import { createBankWithQuestions, insertQuestionsAfter, listQuestions, listWrongEntries, updateQuestion } from './quizStore';
import { loadStats } from './statsService';
import { typeShortLabels } from '../constants/theme';
import type { ParsedQuestion, Question, QuestionType } from '../types/quiz';

export interface StepProgress {
  done: number;
  total: number;
  collected: number;
}

/** AI 模拟卷的可选题量 */
export const PAPER_SIZES = [10, 20, 30];

/** 变式一次最多出多少题：逐题串行，再多会让用户等太久 */
const VARIANT_LIMIT = 12;

/** 给模型的命题参考题数量：太多会挤占输出预算，8 题足够体现考点与难度风格 */
const SAMPLE_COUNT = 8;

/* ---------------- 薄弱点诊断 ---------------- */

/**
 * 取数口径全部复用 statsService，保证报告里的数字和统计页完全一致，
 * 不出现「诊断说 62%、统计页显示 65%」这种两套算法。
 */
export async function runDiagnosis(): Promise<Diagnosis> {
  const [stats, wrong] = await Promise.all([loadStats(), listWrongEntries()]);
  const subjects: DiagnosisRow[] = (stats?.bySubject ?? []).map((s) => ({
    key: s.subject,
    total: s.total,
    attempts: s.attempts,
    accuracy: s.accuracy,
    mastered: s.masteredQuestions,
  }));
  const types: DiagnosisRow[] = (stats?.byType ?? []).map((x) => ({
    key: typeShortLabels[x.type] ?? x.type,
    total: x.total,
    attempts: x.attempts,
    accuracy: x.attempts > 0 ? Math.round((x.correct / x.attempts) * 100) : 0,
    mastered: x.masteredQuestions,
  }));
  const input: DiagnosisInput = {
    accuracy: stats?.accuracy ?? 0,
    attempts: stats?.totalAttempts ?? 0,
    wrongPending: stats?.wrongPending ?? 0,
    questionCount: stats?.questionCount ?? 0,
    subjects,
    types,
    wrongSamples: wrong
      .filter((w) => !w.resolved && !!w.question)
      .slice(0, 12)
      .map((w) => ({
        stem: (w.question as Question).stem,
        wrongCount: w.wrongCount,
        subject: (w.question as Question).subject ?? '',
      })),
  };
  return diagnoseWeakness(input);
}

/* ---------------- 批量补解析 ---------------- */

export interface ExplainOutcome {
  /** 成功写回云端的题数 */
  written: number;
  /** 缺解析且已送 AI 的题数 */
  targets: number;
  /** 模型认为给定答案有疑点的题目，供人工抽查 */
  doubts: { stem: string; note: string }[];
}

/** 判断题目是否「有答案、缺解析」：与补答案（无答案）互斥，两者不会互相覆盖 */
export function needsExplanation(q: Question): boolean {
  if (String(q.explanation || '').trim()) return false;
  const hasAnswer = q.type === 'tf' ? q.answerBool !== null : String(q.answer || '').trim().length > 0;
  return hasAnswer;
}

/** 为「有答案、没解析」的题目批量补写解析；只写 explanation，不动答案与确认状态 */
export async function explainBank(
  bankId: string,
  onProgress: (p: StepProgress) => void,
  shouldAbort: () => boolean,
): Promise<ExplainOutcome> {
  const all = await listQuestions(bankId);
  const targets = all.filter(needsExplanation);
  if (targets.length === 0) return { written: 0, targets: 0, doubts: [] };
  const map = await generateExplanations(
    targets,
    (p) => onProgress({ done: p.done, total: p.total, collected: p.collected }),
    shouldAbort,
  );
  let written = 0;
  const doubts: { stem: string; note: string }[] = [];
  for (const [index, item] of map.entries()) {
    if (shouldAbort()) break;
    const target = targets[index];
    if (!target) continue;
    const ok = await updateQuestion(target.id, { explanation: item.explanation });
    if (!ok) continue;
    written += 1;
    if (item.note) doubts.push({ stem: target.stem.slice(0, 30), note: item.note });
  }
  return { written, targets: targets.length, doubts };
}

/* ---------------- 错题变式重练 ---------------- */

export interface BankOutcome {
  bankId: string;
  name: string;
  inserted: number;
  expected: number;
}

function toSimilarSource(q: Question): SimilarSource {
  return {
    type: q.type,
    stem: q.stem,
    options: q.options,
    answer: q.answer,
    answerBool: q.answerBool,
    explanation: q.explanation,
    subject: q.subject,
  };
}

/**
 * 错题变式：为错题本里错得最多的前 N 题各出 1 道变式题，攒成一个新题库。
 *
 * 逐题串行而不是一次给多题：一次喂多题时模型容易只抓第一个考点，
 * 变式练习要的恰恰是「每道母题都被换掉情境」，宁可慢一点也要对得上错题本。
 */
export async function createVariantBank(
  bankId: string,
  scopeName: string,
  onProgress: (p: StepProgress) => void,
  shouldAbort: () => boolean,
  subject = '',
): Promise<BankOutcome | null> {
  const wrong = await listWrongEntries(bankId || undefined);
  const sources = wrong
    .filter((w) => !w.resolved && !!w.question)
    .filter((w) => !subject || (w.question as Question).subject === subject)
    .sort((a, b) => b.wrongCount - a.wrongCount)
    .slice(0, VARIANT_LIMIT)
    .map((w) => w.question as Question);
  if (sources.length === 0) return null;

  const drafts: ParsedQuestion[] = [];
  for (let i = 0; i < sources.length; i += 1) {
    if (shouldAbort()) break;
    try {
      const list = await generateSimilarQuestions(toSimilarSource(sources[i]), 1);
      drafts.push(...list);
    } catch (error) {
      console.error(`[aiPlus] 第 ${i + 1} 道变式题生成失败:`, error);
    }
    onProgress({ done: i + 1, total: sources.length, collected: drafts.length });
  }
  if (drafts.length === 0) throw new RelayUnavailableError('变式题未能生成');

  const name = `${scopeName} · 错题变式`.slice(0, 40);
  const result = await createBankWithQuestions(name, null, true, drafts);
  if (!result) return null;
  return { bankId: result.bankId, name, inserted: result.inserted, expected: result.expected };
}

/* ---------------- 整库批量出类似题 ---------------- */

/** 批量出题的母题上限：逐题串行请求 AI，再多用户等太久，一批也吃不下 */
export const SIMILAR_BATCH_LIMIT = 30;

/** 自适应档位：按题库规模给几个常用出题量 */
export const SIMILAR_BATCH_SIZES = [5, 10, 20];

/**
 * 自动挑选母题：优先「已核对且有答案」的题 —— 母题答案本身就是错的，
 * 生成的整批类似题会一起跑偏。可用母题不够时退回全库，
 * 够用时按排序均匀取样，避免总是集中在题库开头那几题。
 */
export function pickSimilarSources(questions: Question[], count: number): Question[] {
  if (questions.length === 0 || count <= 0) return [];
  const usable = questions.filter(
    (q) => q.reviewed && (q.type === 'tf' ? q.answerBool !== null : String(q.answer || '').trim().length > 0),
  );
  const pool = usable.length >= count ? usable : questions;
  if (pool.length <= count) return pool.slice(0, SIMILAR_BATCH_LIMIT);
  const step = pool.length / count;
  const out: Question[] = [];
  for (let i = 0; i < count; i += 1) out.push(pool[Math.floor(i * step)]);
  return out.slice(0, SIMILAR_BATCH_LIMIT);
}

export interface SimilarBatchOutcome {
  /** 落成新的 AI 题库时给出新库 id；追加进本题库时为 null */
  bankId: string | null;
  name: string;
  inserted: number;
  expected: number;
  /** 一道题都没生成出来的母题数，用于如实告诉用户「N 道没出成」 */
  failed: number;
}

/**
 * 整库批量出类似题：每道母题各出 1 题。
 *
 * 与错题变式同理，逐题串行而不是一次喂多题：一次给多题时模型只会抓第一个考点，
 * 批量出题要的恰恰是「每道母题都被换掉情境」，宁可慢一点也要题题对得上。
 */
export async function runSimilarBatch(opts: {
  bankId: string;
  bankName: string;
  sources: Question[];
  target: 'newBank' | 'append';
  onProgress: (p: StepProgress) => void;
  shouldAbort: () => boolean;
}): Promise<SimilarBatchOutcome | null> {
  const { bankId, bankName, sources, target, onProgress, shouldAbort } = opts;
  if (sources.length === 0) return null;

  const drafts: ParsedQuestion[] = [];
  let failed = 0;
  for (let i = 0; i < sources.length; i += 1) {
    if (shouldAbort()) break;
    try {
      const list = await generateSimilarQuestions(toSimilarSource(sources[i]), 1);
      if (list.length === 0) failed += 1;
      drafts.push(...list);
    } catch (error) {
      failed += 1;
      console.error(`[aiPlus] 第 ${i + 1} 道母题的类似题生成失败:`, error);
    }
    onProgress({ done: i + 1, total: sources.length, collected: drafts.length });
  }
  if (drafts.length === 0) throw new RelayUnavailableError('类似题未能生成');

  if (target === 'append') {
    // 追加到末尾：afterOrderIndex 传 null 即「排在最后一题之后」，由 quizStore 取最大排序号
    const inserted = await insertQuestionsAfter(bankId, null, drafts);
    return { bankId: null, name: bankName, inserted, expected: drafts.length, failed };
  }
  const name = `${bankName} · 类似题`.slice(0, 40);
  const result = await createBankWithQuestions(name, null, true, drafts);
  if (!result) return null;
  return { bankId: result.bankId, name, inserted: result.inserted, expected: result.expected, failed };
}

/* ---------------- AI 出模拟卷 ---------------- */

const PAPER_TYPES: QuestionType[] = ['choice', 'tf', 'fill', 'short'];

/**
 * 按权重把 count 个名额分给 keys（最大余数法保证总数精确），再交错排列。
 * 交错是为了避免「前 10 题全是同一个科目」这种读起来很怪的卷面。
 */
function allocate(keys: string[], weights: number[], count: number): string[] {
  if (keys.length === 0 || count <= 0) return [];
  const total = weights.reduce((s, w) => s + w, 0) || keys.length;
  const exact = weights.map((w) => (w / total) * count);
  const taken = exact.map((v) => Math.floor(v));
  let left = count - taken.reduce((s, v) => s + v, 0);
  const byFraction = exact.map((v, i) => ({ i, frac: v - Math.floor(v) })).sort((a, b) => b.frac - a.frac);
  for (const item of byFraction) {
    if (left <= 0) break;
    taken[item.i] += 1;
    left -= 1;
  }
  const queues = taken.map((n, i) => ({ key: keys[i], n }));
  const out: string[] = [];
  while (out.length < count) {
    let progressed = false;
    for (const q of queues) {
      if (q.n > 0 && out.length < count) {
        out.push(q.key);
        q.n -= 1;
        progressed = true;
      }
    }
    if (!progressed) break;
  }
  return out;
}

/** 命题清单：题型与科目都按题库自身占比分配，让卷子贴合这个库的实际范围 */
export function buildPaperSlots(questions: Question[], count: number): PaperSlot[] {
  const typeWeights = PAPER_TYPES.map((tp) => Math.max(1, questions.filter((q) => q.type === tp).length));
  const subjectKeys = Array.from(new Set(questions.map((q) => String(q.subject || '')).filter(Boolean)));
  const subjects = subjectKeys.length > 0 ? subjectKeys : ['通用'];
  const subjectWeights = subjects.map((s) => Math.max(1, questions.filter((q) => q.subject === s).length));
  const types = allocate(PAPER_TYPES.slice(), typeWeights, count);
  const subs = allocate(subjects, subjectWeights, count);
  return types.map((tp, i) => ({ type: tp as QuestionType, subject: subs[i] ?? '通用' }));
}

/**
 * AI 出模拟卷：按题库分布命题，单独存成一个 AI 题库。
 * 落库而不是一次性用完：模拟卷要能反复刷、能导出、能进统计，落库后这些能力都是现成的。
 */
export async function createMockPaper(
  bankId: string,
  bankName: string,
  count: number,
  onProgress: (p: StepProgress) => void,
  shouldAbort: () => boolean,
): Promise<BankOutcome | null> {
  const questions = await listQuestions(bankId);
  if (questions.length === 0) return null;
  const slots = buildPaperSlots(questions, count);
  const samples: SimilarSource[] = questions.slice(0, SAMPLE_COUNT).map(toSimilarSource);
  const drafts = await generateMockPaper(
    slots,
    samples,
    (p) => onProgress({ done: p.done, total: p.total, collected: p.collected }),
    shouldAbort,
  );
  if (drafts.length === 0) throw new RelayUnavailableError('模拟卷未能生成');
  const now = new Date();
  const stamp = `${now.getMonth() + 1}.${now.getDate()}`;
  const name = `${bankName} · 模拟卷 ${stamp}`.slice(0, 40);
  const result = await createBankWithQuestions(name, null, true, drafts);
  if (!result) return null;
  return { bankId: result.bankId, name, inserted: result.inserted, expected: result.expected };
}
