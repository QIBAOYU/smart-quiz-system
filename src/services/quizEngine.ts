import type { ParsedQuestion, Question, QuizMode } from '../types/quiz';

export function shuffle<T>(list: T[]): T[] {
  const arr = [...list];
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = arr[i];
    arr[i] = arr[j];
    arr[j] = tmp;
  }
  return arr;
}

/** 按模式生成一次练习的题目序列 */
export function buildSession<T extends { orderIndex?: number }>(
  questions: T[],
  mode: QuizMode,
  limit = 0,
): T[] {
  let list: T[];
  if (mode === 'random') list = shuffle(questions);
  else if (mode === 'seq') {
    list = [...questions].sort((a, b) => (a.orderIndex ?? 0) - (b.orderIndex ?? 0));
  } else list = [...questions];
  if (mode === 'memorize') list = [...questions];
  return limit > 0 ? list.slice(0, limit) : list;
}

const FULL_TO_HALF: Record<string, string> = {
  '（': '(', '）': ')', '，': ',', '。': '.', '；': ';', '：': ':', '？': '?', '、': ',',
  'Ａ': 'A', 'Ｂ': 'B', 'Ｃ': 'C', 'Ｄ': 'D', 'ａ': 'a', 'ｂ': 'b', 'ｃ': 'c', 'ｄ': 'd',
  '０': '0', '１': '1', '２': '2', '３': '3', '４': '4', '５': '5', '６': '6', '７': '7', '８': '8', '９': '9',
};

export function normalizeText(value: string): string {
  return (value || '')
    .replace(/[\u3000\s]/g, '')
    .split('')
    .map((c) => FULL_TO_HALF[c] ?? c)
    .join('')
    .toLowerCase();
}

/** 从 "A. 选项内容" 中取出字母 */
export function letterOf(optionText: string, index: number): string {
  const m = /^\s*([A-H])\s*[.、．)）]/.exec(optionText || '');
  return m ? m[1].toUpperCase() : String.fromCharCode(65 + index);
}

export function optionBody(optionText: string): string {
  return (optionText || '').replace(/^\s*[A-H]\s*[.、．)）]\s*/, '').trim();
}

/** 正确答案字母集合（支持多选 "AB"） */
export function answerLetters(question: Question | ParsedQuestion): string[] {
  const raw = (question.answer || '').toUpperCase();
  const letters = raw.match(/[A-H]/g) ?? [];
  const uniq = Array.from(new Set(letters));
  if (uniq.length > 0) return uniq.sort();
  const body = normalizeText(question.answer);
  const opts = (question.options ?? []) as string[];
  const hit = opts.findIndex((o) => normalizeText(optionBody(o)) === body && body.length > 0);
  return hit >= 0 ? [letterOf(opts[hit], hit)] : [];
}

export function isMultiAnswer(question: Question | ParsedQuestion): boolean {
  return answerLetters(question).length > 1;
}

function sameSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sa = [...a].sort();
  const sb = [...b].sort();
  return sa.every((v, i) => v === sb[i]);
}

const SYNONYM_GROUPS = [
  ['正确', '对', '是', 'true', 't', '√'],
  ['错误', '错', '否', 'false', 'f', '×'],
];

function tfValue(value: string): boolean | null {
  const v = normalizeText(value);
  if (!v) return null;
  for (const g of SYNONYM_GROUPS) if (g.includes(v)) return g === SYNONYM_GROUPS[0];
  return null;
}

/** 填空题：逐空比对，允许多答案（/ 或 ||| 分隔）与等价写法 */
function checkFill(expected: string, given: string): boolean {
  const blanks = (expected || '').split(/\|\|\||[\/；;]/).map((s) => s.trim()).filter(Boolean);
  const givenBlanks = (given || '').split(/\|\|\||[\/；;]/).map((s) => s.trim());
  const targets = blanks.length > 0 ? blanks : [expected];
  const givens = givenBlanks.length === targets.length ? givenBlanks : [given];
  return targets.every((t, i) => {
    const g = givens[i] ?? '';
    const accepted = t.split(/[\/、,，]/).map((s) => normalizeText(s)).filter(Boolean);
    const gn = normalizeText(g);
    if (!gn) return false;
    return accepted.some((a) => gn === a || (a.length >= 2 && gn.includes(a)) || (gn.length >= 2 && a.includes(gn)));
  });
}

export type GradeResult = 'correct' | 'wrong' | 'manual';

/** 判题：简答题返回 manual（自评） */
export function gradeAnswer(
  question: Question | ParsedQuestion,
  given: string | string[] | boolean | null,
): GradeResult {
  const value = Array.isArray(given) ? given.join('') : typeof given === 'boolean' ? (given ? '正确' : '错误') : (given ?? '');
  if (question.type === 'short') {
    return String(value).trim().length > 0 ? 'manual' : 'wrong';
  }
  if (question.type === 'tf') {
    const exp = question.answerBool ?? tfValue(question.answer ?? '');
    const got = typeof given === 'boolean' ? given : tfValue(String(value));
    if (exp === null || got === null) return 'wrong';
    return exp === got ? 'correct' : 'wrong';
  }
  if (question.type === 'fill') {
    return checkFill(question.answer ?? '', String(value)) ? 'correct' : 'wrong';
  }
  const expected = answerLetters(question);
  const gotLetters = (Array.isArray(given) ? given : [String(value)])
    .join('')
    .toUpperCase()
    .match(/[A-H]/g) ?? [];
  const uniq = Array.from(new Set(gotLetters));
  if (expected.length === 0 || uniq.length === 0) return 'wrong';
  return sameSet(expected, uniq) ? 'correct' : 'wrong';
}

export interface PickDiff {
  /** 选中的正确项 */
  hit: string[];
  /** 漏掉的正确项 */
  miss: string[];
  /** 多选的干扰项 */
  extra: string[];
}

/** 多选题的选项级差异，用于「漏选得半分」的反馈文案 */
export function diffPicks(question: Question | ParsedQuestion, given: string | string[]): PickDiff {
  const expected = answerLetters(question);
  const raw = Array.isArray(given) ? given.join('') : given;
  const got = Array.from(new Set((raw.toUpperCase().match(/[A-H]/g) ?? [])));
  return {
    hit: got.filter((l) => expected.includes(l)),
    miss: expected.filter((l) => !got.includes(l)),
    extra: got.filter((l) => !expected.includes(l)),
  };
}

/**
 * 单题得分：多选题「漏选且没有错选」给 0.5 分，错选不给分；其余题型对 1 分、错 0 分。
 *
 * 得分只用于本轮练习/模考的分数呈现，不写进 quiz_attempts ——
 * 正确率与错题本继续用「全对才算答对」的单一口径，避免同一次作答在两套指标里被算成不同的事。
 */
export function scoreOf(question: Question | ParsedQuestion, given: string | string[], result: GradeResult): number {
  if (result === 'correct' || result === 'manual') return 1;
  if (question.type !== 'choice') return 0;
  if (answerLetters(question).length < 2) return 0;
  const d = diffPicks(question, given);
  return d.extra.length === 0 && d.hit.length > 0 ? 0.5 : 0;
}

/** 把得分格式化成不带无意义小数的文本：1 → "1"，0.5 → "0.5" */
export function formatScore(value: number): string {
  return Number.isInteger(value) ? String(value) : String(Math.round(value * 10) / 10);
}

export function expectedDisplay(question: Question | ParsedQuestion): string {
  if (question.type === 'choice') return answerLetters(question).join('、');
  if (question.type === 'tf') return question.answerBool === false ? '错误' : question.answerBool === true ? '正确' : (question.answer || '—');
  return question.answer || '—';
}

export function confidenceLabel(confidence: number): { text: string; tone: 'high' | 'mid' | 'low' } {
  if (confidence >= 0.85) return { text: `置信 ${Math.round(confidence * 100)}%`, tone: 'high' };
  if (confidence >= 0.6) return { text: `置信 ${Math.round(confidence * 100)}%`, tone: 'mid' };
  return { text: `置信 ${Math.round(confidence * 100)}%`, tone: 'low' };
}
