/**
 * 跨页面的一次性会话数据（题目序列、作答轨迹）。
 * 放模块级单例而不是路由参数：题目数组很大，序列化进 URL 会超长且不可读。
 *
 * 支持从「断点进度」恢复：传入 records 与 startIndex 即可续练。
 */
import type { AnswerRecord, Question, QuizMode } from '../types/quiz';

interface SessionData {
  bankId: string;
  bankName: string;
  mode: QuizMode;
  questions: Question[];
  records: AnswerRecord[];
  startedAt: number;
  /** 恢复进度时的起始题号下标 */
  startIndex: number;
  /** 背题模式下已浏览过的题目 id（答题卡据此恢复「已浏览」态） */
  seenIds: string[];
}

let current: SessionData | null = null;

export interface StartSessionInput {
  bankId: string;
  bankName: string;
  mode: QuizMode;
  questions: Question[];
  records?: AnswerRecord[];
  startIndex?: number;
  seenIds?: string[];
}

export function startSession(input: StartSessionInput): void {
  current = {
    bankId: input.bankId,
    bankName: input.bankName,
    mode: input.mode,
    questions: input.questions,
    records: input.records ? [...input.records] : [],
    startedAt: Date.now(),
    startIndex: Math.max(0, Math.min(input.startIndex ?? 0, Math.max(0, input.questions.length - 1))),
    seenIds: input.seenIds ? [...input.seenIds] : [],
  };
}

export function addRecord(record: AnswerRecord): void {
  if (!current) return;
  // 跳回旧题重做时同一道题只保留最新一次结果，避免「已作答 / 正确数」被重复计数
  const at = current.records.findIndex((r) => r.questionId === record.questionId);
  if (at >= 0) current.records.splice(at, 1, record);
  else current.records.push(record);
}

export function getSession(): SessionData | null {
  return current;
}

export function clearSession(): void {
  current = null;
}
