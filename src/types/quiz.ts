/** 智能刷题系统 —— 全局数据契约 */

export type QuestionType = 'choice' | 'tf' | 'fill' | 'short';

/**
 * 练习模式。
 * exam = 模拟考试：不即时判分、限时，交卷后统一出成绩；
 * review = 间隔重复复习：题池来自 quiz_reviews 里已到期的题目；
 * favorite = 收藏专练：题池来自 quiz_favorites 里用户手动收藏的题目。
 * 云端 quiz_attempts.mode / quiz_progress.mode 都是无约束 TEXT，新增取值不需要改表。
 */
export type QuizMode = 'seq' | 'random' | 'memorize' | 'wrong' | 'exam' | 'review' | 'favorite';

/** 解析阶段（尚未入库）的题目 */
export interface ParsedQuestion {
  key: string;
  type: QuestionType;
  stem: string;
  options: string[];
  answer: string;
  answerBool: boolean | null;
  explanation: string;
  confidence: number;
  reviewed: boolean;
  source: 'local' | 'ai';
  /** AI 识别的学科科目；空/未设置表示尚未分类 */
  subject?: string;
  /** 难度 1=简单 2=中等 3=困难；0 或未设置 = 未标注 */
  difficulty?: number;
}

/** 题库 */
export interface Bank {
  id: string;
  name: string;
  sourceFile: string | null;
  isAiBank: boolean;
  questionCount: number;
  reviewedCount: number;
  createdAt: string;
  /** 该题库历史作答次数，0 或 undefined 表示还没练过 */
  attempts?: number;
  /** 该题库正确率，已是 0-100 的百分数 */
  accuracy?: number;
}

/** 已入库题目 */
export interface Question {
  id: string;
  bankId: string;
  orderIndex: number;
  type: QuestionType;
  stem: string;
  options: string[];
  answer: string;
  answerBool: boolean | null;
  explanation: string;
  confidence: number;
  reviewed: boolean;
  /** AI 识别的学科科目，'' 表示尚未分类 */
  subject: string;
  /** 难度 1=简单 2=中等 3=困难；0 = 未标注 */
  difficulty: number;
}

/** 错题本条目 */
export interface WrongEntry {
  id: string;
  questionId: string;
  bankId: string;
  wrongCount: number;
  streakCorrect: number;
  resolved: boolean;
  question?: Question | null;
}

export interface AppSettings {
  defaultMode: QuizMode;
  allowTypeConvert: boolean;
  hapticOnWrong: boolean;
  /** 每日刷题目标题数，0 = 不设目标 */
  dailyGoal: number;
  /** 模拟考试每题限时秒数，0 = 不限时 */
  examSecondsPerQuestion: number;
}

/** 间隔重复复习计划的一条记录（Leitner 盒子简化版） */
export interface ReviewPlan {
  questionId: string;
  bankId: string;
  /** 记忆档位 1-5，对应 1/2/4/7/15 天后再见；答对升档，答错降回 1 */
  box: number;
  /** ISO 时间，到期后进入复习题池 */
  dueAt: string;
  lastReviewAt: string | null;
  reviewCount: number;
}

/** 单日统计 */
export interface DayStat {
  /** MM-DD */
  label: string;
  /** YYYY-MM-DD */
  date: string;
  count: number;
  correct: number;
}

/**
 * 分题型统计（全局与单题库同口径）。
 * total = 该题型题目总数；masteredQuestions = 已掌握题数（该题最近一次答对且未挂在错题本待消灭里）。
 * 主口径是 masteredQuestions / total，attempts 与 correct 是「作答次数」口径，仅作副行参考。
 */
export interface TypeStat {
  type: QuestionType;
  total: number;
  attempts: number;
  correct: number;
  masteredQuestions: number;
}

/**
 * 分科目统计。口径与 TypeStat 一致，额外给出作答正确率，
 * 便于「哪科最薄弱」一眼可见；subject = '未分类' 表示这些题还没跑 AI 科目识别。
 */
export interface SubjectStat {
  subject: string;
  /** 该科目题目总数 */
  total: number;
  attempts: number;
  correct: number;
  /** 0-100，按作答次数口径（correct / attempts） */
  accuracy: number;
  masteredQuestions: number;
}

export interface StatsSummary {
  totalAttempts: number;
  totalCorrect: number;
  accuracy: number;
  bankCount: number;
  questionCount: number;
  /** 已掌握题数：该题最近一次作答正确、且未挂在错题本待消灭里，与 byType 的 masteredQuestions 同口径 */
  masteredQuestions: number;
  wrongPending: number;
  masteredCount: number;
  todayCount: number;
  streakDays: number;
  last7: DayStat[];
  byBank: Array<{ id: string; name: string; count: number; accuracy: number }>;
  byType: TypeStat[];
  /** 分科目表现，按题量多→少排序 */
  bySubject: SubjectStat[];
}

/** 一次练习的会话 */
export interface QuizSession {
  bankId: string;
  bankName: string;
  mode: QuizMode;
  questions: Question[];
}

/** 单题作答结果 */
export interface AnswerRecord {
  questionId: string;
  correct: boolean;
  manual: boolean;
  /** 判分说明：简答题的 AI 评语、AI 判定结果的自查提示 */
  reason?: string;
  /** 当时提交的作答原文：选择题为选项字母串，填空/简答为文本 */
  given?: string;
  /**
   * 本题得分：1 = 全对，0.5 = 多选漏选且无错选，0 = 不得分。
   * 只服务本轮练习/模考的得分口径；correct 仍是「全对才为真」，错题本与正确率口径不受影响。
   */
  score?: number;
}

/** 进度里单题的状态：真实作答结果，或背题模式仅浏览过的标记 */
export interface ProgressAnswer {
  correct: boolean;
  manual: boolean;
  /** true = 背题模式只浏览过、未作答，不计入「已作答」 */
  seen?: boolean;
  /** 本题得分（1 / 0.5 / 0），断点恢复时靠它保住多选题的半分；老进度行没有这个字段 */
  score?: number;
  /** 当时的判分说明，恢复后简答题仍能看回 AI 的评语 */
  reason?: string;
  /** 当时的作答原文，恢复后回显选中项 / 输入内容 */
  given?: string;
}

/** 保存下来的断点进度（按「题库 + 模式」各存一条，互不覆盖） */
export interface SavedProgress {
  bankId: string;
  bankName: string;
  mode: QuizMode;
  /** 本次会话的题目顺序 */
  questionIds: string[];
  /** questionId -> 作答结果 / 浏览标记 */
  answers: Record<string, ProgressAnswer>;
  /** 上次停留的题号下标 */
  cursor: number;
  total: number;
  updatedAt: string;
}
