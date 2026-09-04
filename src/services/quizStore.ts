/**
 * 云端数据访问层：题库 / 题目 / 答题记录 / 错题本 / 设置
 * 所有方法内部完成错误日志打印，调用方只需处理返回值与友好提示。
 *
 * 按账号隔离：每张表都有 user_id，只读写当前登录账号自己的行。
 * 云端 RLS 要求 user_id = auth.uid()，未登录或伪造他人 id 都拿不到数据，
 * 安装包里的匿名密钥不再能读写任何业务表。
 */
import { supabase } from '../supabase/client';
import { getOwnerId } from './ownerId';
import { UNCLASSIFIED } from './statsService';
import type {
  AppSettings,
  Bank,
  ParsedQuestion,
  Question,
  QuestionType,
  QuizMode,
  WrongEntry,
} from '../types/quiz';

function log(stage: string, error: unknown): void {
  console.error(`[quizStore] ${stage} failed:`, error);
}

function toQuestion(row: Record<string, unknown>): Question {
  const raw = row.options;
  let options: string[] = [];
  if (Array.isArray(raw)) options = raw.map((v) => String(v));
  else if (typeof raw === 'string') {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) options = parsed.map((v) => String(v));
    } catch (error) {
      log('parse options', error);
    }
  }
  return {
    id: String(row.id),
    bankId: String(row.bank_id),
    orderIndex: Number(row.order_index ?? 0),
    type: (String(row.type ?? 'short') as QuestionType),
    stem: String(row.stem ?? ''),
    options,
    answer: String(row.answer ?? ''),
    answerBool: row.answer_bool === null || row.answer_bool === undefined ? null : Boolean(row.answer_bool),
    explanation: String(row.explanation ?? ''),
    confidence: Number(row.confidence ?? 0.5),
    reviewed: Boolean(row.reviewed),
    subject: String(row.subject ?? ''),
    difficulty: Math.max(0, Math.min(3, Number(row.difficulty ?? 0))),
  };
}

function toBank(row: Record<string, unknown>): Bank {
  return {
    id: String(row.id),
    name: String(row.name ?? '未命名题库'),
    sourceFile: row.source_file ? String(row.source_file) : null,
    isAiBank: Boolean(row.is_ai_bank),
    questionCount: Number(row.question_count ?? 0),
    reviewedCount: Number(row.reviewed_count ?? 0),
    createdAt: String(row.created_at ?? ''),
  };
}

/* ---------------- 题库 ---------------- */

/**
 * 拉取题库清单。
 *
 * 返回 null = 请求失败（网络 / RLS / 网关），与「确实一个题库都没有」的空数组严格区分。
 * 两者混为一谈时，一次偶发的网络抖动就会让首页显示「导入第一份资料」的空态引导，
 * 用户会以为数据全丢，甚至重新导入造成整库重复。
 */
export async function listBanks(): Promise<Bank[] | null> {
  const userId = await getOwnerId();
  if (!userId) return [];
  const { data, error } = await supabase
    .from('quiz_banks')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false });
  if (error) {
    log('listBanks', error);
    return null;
  }
  return (data ?? []).map((row) => toBank(row as Record<string, unknown>));
}

export async function getBank(bankId: string): Promise<Bank | null> {
  const userId = await getOwnerId();
  if (!userId) return null;
  const { data, error } = await supabase
    .from('quiz_banks')
    .select('*')
    .eq('id', bankId)
    .eq('user_id', userId)
    .maybeSingle();
  if (error) {
    log('getBank', error);
    return null;
  }
  return data ? toBank(data as Record<string, unknown>) : null;
}

/**
 * 删除题库。题目有外键级联会自动清掉，但作答记录 / 错题 / 断点进度这三张表
 * 的 bank_id 没有外键，必须在这里一起删，否则统计页与错题本会残留「已删除的题库」。
 * 每条删除都带 user_id，避免误删他人同名 bank_id 的行。
 */
export async function deleteBank(bankId: string): Promise<boolean> {
  const userId = await getOwnerId();
  if (!userId) return false;
  const orphans = ['quiz_attempts', 'quiz_wrong_book', 'quiz_progress'] as const;
  for (const table of orphans) {
    const { error } = await supabase.from(table).delete().eq('bank_id', bankId).eq('user_id', userId);
    if (error) log(`deleteBank ${table}`, error);
  }
  const { error } = await supabase.from('quiz_banks').delete().eq('id', bankId).eq('user_id', userId);
  if (error) {
    log('deleteBank', error);
    return false;
  }
  return true;
}

export async function renameBank(bankId: string, name: string): Promise<boolean> {
  const userId = await getOwnerId();
  if (!userId) return false;
  // RLS 拦截或题目不存在时 update 的 error 仍是 null，必须回读受影响行数才能判定成败
  const { data, error } = await supabase
    .from('quiz_banks')
    .update({ name, updated_at: new Date().toISOString() })
    .eq('id', bankId)
    .eq('user_id', userId)
    .select('id');
  if (error) {
    log('renameBank', error);
    return false;
  }
  if (!data || data.length === 0) {
    log('renameBank', '没有行被更新（策略拦截或题库已不存在）');
    return false;
  }
  return true;
}

/** 建库写题的结果：inserted < expected 表示部分题目没落库（题库仍保留已写入的部分） */
export interface BankWriteResult {
  bankId: string;
  inserted: number;
  expected: number;
}

/**
 * 创建题库并批量写入题目，失败返回 null。
 *
 * 分批插入中途失败时**不再整库回滚删除**：客户端没有多语句事务入口，
 * 删库会把已经写成功的那部分题目一起丢掉。改为「回读校正」——
 * 用真实题数刷新 question_count / reviewed_count，并把 inserted 交给调用方，
 * 让界面如实告诉用户「N 题已入库，M 题失败」，而不是留下一个计数对不上的半份题库。
 */
export async function createBankWithQuestions(
  name: string,
  sourceFile: string | null,
  isAiBank: boolean,
  questions: ParsedQuestion[],
): Promise<BankWriteResult | null> {
  const userId = await getOwnerId();
  if (!userId) return null;
  const now = new Date().toISOString();
  const { data: bankRow, error: bankErr } = await supabase
    .from('quiz_banks')
    .insert({
      name,
      source_file: sourceFile,
      is_ai_bank: isAiBank,
      question_count: questions.length,
      reviewed_count: questions.filter((q) => q.reviewed).length,
      user_id: userId,
      created_at: now,
      updated_at: now,
    })
    .select('id')
    .maybeSingle();
  if (bankErr || !bankRow) {
    log('createBank', bankErr ?? 'no row returned');
    return null;
  }
  const bankId = String((bankRow as Record<string, unknown>).id);

  const rows = questions.map((q, i) => ({
    bank_id: bankId,
    type: q.type,
    stem: q.stem,
    options: q.options,
    answer: q.answer,
    answer_bool: q.answerBool,
    explanation: q.explanation || null,
    confidence: q.confidence,
    reviewed: q.reviewed,
    order_index: i,
    user_id: userId,
    difficulty: q.difficulty && q.difficulty > 0 ? q.difficulty : null,
  }));

  // 分批插入，避免单次请求体过大被网关截断
  const CHUNK = 100;
  let failedFrom = -1;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const slice = rows.slice(i, i + CHUNK);
    const { error } = await supabase.from('quiz_questions').insert(slice);
    if (error) {
      log(`insert questions chunk ${i / CHUNK}`, error);
      failedFrom = i;
      break;
    }
  }

  // 回读校正：以云端真实题数为准，计数不再凭预期值写死
  await refreshBankCounts(bankId);
  if (failedFrom >= 0) {
    return { bankId, inserted: failedFrom, expected: rows.length };
  }
  return { bankId, inserted: rows.length, expected: rows.length };
}

export async function refreshBankCounts(bankId: string): Promise<void> {
  const userId = await getOwnerId();
  if (!userId) return;
  const { count: total, error: e1 } = await supabase
    .from('quiz_questions')
    .select('id', { count: 'exact', head: true })
    .eq('bank_id', bankId)
    .eq('user_id', userId);
  const { count: reviewed, error: e2 } = await supabase
    .from('quiz_questions')
    .select('id', { count: 'exact', head: true })
    .eq('bank_id', bankId)
    .eq('user_id', userId)
    .eq('reviewed', true);
  if (e1 || e2) {
    log('refreshBankCounts', e1 ?? e2);
    return;
  }
  const { error } = await supabase
    .from('quiz_banks')
    .update({
      question_count: total ?? 0,
      reviewed_count: reviewed ?? 0,
      updated_at: new Date().toISOString(),
    })
    .eq('id', bankId)
    .eq('user_id', userId);
  if (error) log('updateBankCounts', error);
}

/* ---------------- 题目 ---------------- */

export async function listQuestions(bankId: string): Promise<Question[]> {
  const userId = await getOwnerId();
  if (!userId) return [];
  const { data, error } = await supabase
    .from('quiz_questions')
    .select('*')
    .eq('bank_id', bankId)
    .eq('user_id', userId)
    .order('order_index', { ascending: true });
  if (error) {
    log('listQuestions', error);
    return [];
  }
  return (data ?? []).map((row) => toQuestion(row as Record<string, unknown>));
}

/**
 * 跨题库按科目取题：首页「科目」TAB 的「只刷这科」要用。
 * subject 传 '未分类' 时匹配 subject 为 NULL 的题（与 statsService.UNCLASSIFIED 同口径）。
 */
export async function listQuestionsBySubject(subject: string, limit = 100): Promise<Question[]> {
  const userId = await getOwnerId();
  if (!userId) return [];
  let query = supabase.from('quiz_questions').select('*').eq('user_id', userId);
  query =
    subject === UNCLASSIFIED
      ? query.is('subject', null)
      : query.eq('subject', subject);
  const { data, error } = await query.order('order_index', { ascending: true }).limit(limit);
  if (error) {
    log('listQuestionsBySubject', error);
    return [];
  }
  return (data ?? []).map((row) => toQuestion(row as Record<string, unknown>));
}

export async function listQuestionsByIds(ids: string[]): Promise<Question[]> {
  if (ids.length === 0) return [];
  const userId = await getOwnerId();
  if (!userId) return [];
  const { data, error } = await supabase
    .from('quiz_questions')
    .select('*')
    .in('id', ids)
    .eq('user_id', userId);
  if (error) {
    log('listQuestionsByIds', error);
    return [];
  }
  return (data ?? []).map((row) => toQuestion(row as Record<string, unknown>));
}

export async function updateQuestion(
  id: string,
  patch: Partial<Pick<Question, 'stem' | 'options' | 'answer' | 'answerBool' | 'explanation' | 'reviewed' | 'type' | 'confidence' | 'subject' | 'difficulty'>>,
): Promise<boolean> {
  const userId = await getOwnerId();
  if (!userId) return false;
  const payload: {
    stem?: string;
    options?: string[];
    answer?: string;
    answer_bool?: boolean | null;
    explanation?: string | null;
    reviewed?: boolean;
    type?: string;
    confidence?: number;
    subject?: string | null;
    difficulty?: number | null;
  } = {};
  if (patch.stem !== undefined) payload.stem = patch.stem;
  if (patch.options !== undefined) payload.options = patch.options;
  if (patch.answer !== undefined) payload.answer = patch.answer;
  if (patch.answerBool !== undefined) payload.answer_bool = patch.answerBool;
  if (patch.explanation !== undefined) payload.explanation = patch.explanation || null;
  if (patch.reviewed !== undefined) payload.reviewed = patch.reviewed;
  if (patch.type !== undefined) payload.type = patch.type;
  if (patch.confidence !== undefined) payload.confidence = patch.confidence;
  if (patch.subject !== undefined) payload.subject = patch.subject || null;
  if (patch.difficulty !== undefined) payload.difficulty = patch.difficulty > 0 ? patch.difficulty : null;
  const { error } = await supabase.from('quiz_questions').update(payload).eq('id', id).eq('user_id', userId);
  if (error) {
    log('updateQuestion', error);
    return false;
  }
  return true;
}

/**
 * 向已有题库写入题目（AI 类似题 / 跨题库复制的落点）。
 *
 * afterOrderIndex 传数字 = 精确插在该排序号之后。order_index 是 numeric，
 * 只需在「锚点题」与「下一题」之间取等分小数，一条 insert 即可落位，
 * 不必像整数排序号那样把后面整库逐行重排（百题级会打爆请求数）。
 * 传 null = 追加到题库末尾；同一位置反复插到间隙精度不足时自动退回末尾。
 */
export async function insertQuestionsAfter(
  bankId: string,
  afterOrderIndex: number | null,
  questions: ParsedQuestion[],
): Promise<number> {
  if (questions.length === 0) return 0;
  const userId = await getOwnerId();
  if (!userId) return 0;
  const { data: orderRows, error: eOrder } = await supabase
    .from('quiz_questions')
    .select('order_index')
    .eq('bank_id', bankId)
    .eq('user_id', userId);
  if (eOrder) {
    log('insertQuestionsAfter orders', eOrder);
    return 0;
  }
  const orders = (orderRows ?? [])
    .map((r) => Number((r as Record<string, unknown>).order_index ?? 0))
    .sort((a, b) => a - b);
  const maxOrder = orders.length > 0 ? orders[orders.length - 1] : -1;
  const anchor = afterOrderIndex === null ? maxOrder : afterOrderIndex;
  const successor = afterOrderIndex === null ? null : orders.find((o) => o > anchor) ?? null;
  const count = questions.length;
  const gap = successor === null ? 1 : successor - anchor;
  // 间隙被反复对半切到没有精度时退回末尾，避免排序号重合导致顺序不稳定
  const atTail = successor === null || gap / (count + 1) < 1e-7;
  const base = atTail ? maxOrder : anchor;
  const step = atTail ? 1 : gap / (count + 1);
  const rows = questions.map((q, i) => ({
    bank_id: bankId,
    type: q.type,
    stem: q.stem,
    options: q.options,
    answer: q.answer,
    answer_bool: q.answerBool,
    explanation: q.explanation || null,
    confidence: q.confidence,
    reviewed: q.reviewed,
    order_index: Number((base + step * (i + 1)).toFixed(7)),
    user_id: userId,
    subject: q.subject || null,
    difficulty: q.difficulty && q.difficulty > 0 ? q.difficulty : null,
  }));
  const { error } = await supabase.from('quiz_questions').insert(rows);
  if (error) {
    log('insertQuestionsAfter', error);
    return 0;
  }
  await refreshBankCounts(bankId);
  return rows.length;
}

/** 除指定题库外的其他题目（AI 找相似题的候选池），按新→旧限量返回 */
export async function listQuestionsFromOtherBanks(excludeBankId: string, limit = 200): Promise<Question[]> {
  const userId = await getOwnerId();
  if (!userId) return [];
  const { data, error } = await supabase
    .from('quiz_questions')
    .select('*')
    .eq('user_id', userId)
    .neq('bank_id', excludeBankId)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) {
    log('listQuestionsFromOtherBanks', error);
    return [];
  }
  return (data ?? []).map((row) => toQuestion(row as Record<string, unknown>));
}

export async function deleteQuestion(id: string, bankId: string): Promise<boolean> {
  const userId = await getOwnerId();
  if (!userId) return false;
  const { error } = await supabase.from('quiz_questions').delete().eq('id', id).eq('user_id', userId);
  if (error) {
    log('deleteQuestion', error);
    return false;
  }
  await refreshBankCounts(bankId);
  return true;
}

/* ---------------- 答题记录 ---------------- */

export async function recordAttempt(
  questionId: string,
  bankId: string,
  correct: boolean,
  mode: QuizMode,
): Promise<boolean> {
  const userId = await getOwnerId();
  if (!userId) return false;
  const { error } = await supabase.from('quiz_attempts').insert({
    question_id: questionId,
    bank_id: bankId,
    correct,
    mode,
    user_id: userId,
  });
  if (error) {
    log('recordAttempt', error);
    return false;
  }
  return true;
}

/**
 * 记录答题并同步错题本：答错累加，答对累计连对次数，连对 2 次视为已掌握。
 *
 * 返回 false = 至少有一步没落库。调用方必须把它放进补交队列（offlineQueue），
 * 否则用户看到的判分反馈一切正常，云端却一条记录都没留，
 * 错题本、正确率、打卡会静默失真。
 */
export async function submitAnswer(
  questionId: string,
  bankId: string,
  correct: boolean,
  mode: QuizMode,
): Promise<boolean> {
  const userId = await getOwnerId();
  if (!userId) return false;
  const saved = await recordAttempt(questionId, bankId, correct, mode);

  const { data, error } = await supabase
    .from('quiz_wrong_book')
    .select('*')
    .eq('question_id', questionId)
    .eq('user_id', userId)
    .maybeSingle();
  if (error) {
    log('loadWrongEntry', error);
    return false;
  }

  if (!data) {
    // 答对且错题本本来没有这条：无需写错题本，作答记录成功即算成功
    if (correct) return saved;
    const { error: insErr } = await supabase
      .from('quiz_wrong_book')
      .insert({
        question_id: questionId,
        bank_id: bankId,
        wrong_count: 1,
        streak_correct: 0,
        resolved: false,
        user_id: userId,
      });
    if (insErr) {
      log('insertWrongEntry', insErr);
      return false;
    }
    return saved;
  }

  const row = data as Record<string, unknown>;
  const next = {
    wrong_count: correct ? Number(row.wrong_count ?? 0) : Number(row.wrong_count ?? 0) + 1,
    streak_correct: correct ? Number(row.streak_correct ?? 0) + 1 : 0,
    resolved: correct ? Number(row.streak_correct ?? 0) + 1 >= 2 : false,
    updated_at: new Date().toISOString(),
  };
  const { error: upErr } = await supabase
    .from('quiz_wrong_book')
    .update(next)
    .eq('id', String(row.id))
    .eq('user_id', userId);
  if (upErr) {
    log('updateWrongEntry', upErr);
    return false;
  }
  return saved;
}

export async function listWrongEntries(bankId?: string): Promise<WrongEntry[]> {
  const userId = await getOwnerId();
  if (!userId) return [];
  let query = supabase
    .from('quiz_wrong_book')
    .select('*')
    .eq('user_id', userId)
    .order('updated_at', { ascending: false });
  if (bankId) query = query.eq('bank_id', bankId);
  const { data, error } = await query;
  if (error) {
    log('listWrongEntries', error);
    return [];
  }
  const rows = (data ?? []).map((r) => {
    const row = r as Record<string, unknown>;
    return {
      id: String(row.id),
      questionId: String(row.question_id),
      bankId: String(row.bank_id),
      wrongCount: Number(row.wrong_count ?? 0),
      streakCorrect: Number(row.streak_correct ?? 0),
      resolved: Boolean(row.resolved),
    } satisfies WrongEntry;
  });
  const questions = await listQuestionsByIds(rows.map((r) => r.questionId));
  const map = new Map(questions.map((q) => [q.id, q]));
  return rows.map((r) => ({ ...r, question: map.get(r.questionId) ?? null }));
}

/** 手动把某道题标记为已掌握（从错题本移出） */
export async function markWrongResolved(questionId: string): Promise<boolean> {
  const userId = await getOwnerId();
  if (!userId) return false;
  const { error } = await supabase
    .from('quiz_wrong_book')
    .update({ resolved: true, updated_at: new Date().toISOString() })
    .eq('question_id', questionId)
    .eq('user_id', userId);
  if (error) {
    log('markWrongResolved', error);
    return false;
  }
  return true;
}

export async function clearResolvedWrong(bankId?: string): Promise<void> {
  const userId = await getOwnerId();
  if (!userId) return;
  let query = supabase.from('quiz_wrong_book').delete().eq('resolved', true).eq('user_id', userId);
  if (bankId) query = query.eq('bank_id', bankId);
  const { error } = await query;
  if (error) log('clearResolvedWrong', error);
}

/* ---------------- 设置 ---------------- */

const DEFAULT_SETTINGS: AppSettings = {
  defaultMode: 'seq',
  allowTypeConvert: true,
  hapticOnWrong: true,
  dailyGoal: 20,
  examSecondsPerQuestion: 60,
};

export async function loadSettings(): Promise<AppSettings> {
  const userId = await getOwnerId();
  if (!userId) return DEFAULT_SETTINGS;
  const { data, error } = await supabase
    .from('quiz_settings')
    .select('*')
    .eq('user_id', userId)
    .maybeSingle();
  if (error) {
    log('loadSettings', error);
    return DEFAULT_SETTINGS;
  }
  if (!data) return DEFAULT_SETTINGS;
  const row = data as Record<string, unknown>;
  return {
    defaultMode: (String(row.default_mode ?? 'seq') as QuizMode),
    allowTypeConvert: Boolean(row.allow_type_convert),
    hapticOnWrong: Boolean(row.haptic_on_wrong),
    dailyGoal: Math.max(0, Math.min(500, Number(row.daily_goal ?? 20))),
    examSecondsPerQuestion: Math.max(0, Math.min(600, Number(row.exam_seconds_per_question ?? 60))),
  };
}

export async function saveSettings(settings: AppSettings): Promise<boolean> {
  const userId = await getOwnerId();
  if (!userId) return false;
  const { error } = await supabase
    .from('quiz_settings')
    .upsert(
      {
        user_id: userId,
        default_mode: settings.defaultMode,
        allow_type_convert: settings.allowTypeConvert,
        haptic_on_wrong: settings.hapticOnWrong,
        daily_goal: settings.dailyGoal,
        exam_seconds_per_question: settings.examSecondsPerQuestion,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'user_id' },
    );
  if (error) {
    log('saveSettings', error);
    return false;
  }
  return true;
}

/* ---------------- 全局搜索 ---------------- */

/**
 * 跨全部题库搜索题干 / 答案 / 解析。
 *
 * PostgREST 的 or 语法里逗号、括号、百分号、星号、双引号都是控制字符，
 * 用户输入一个逗号就会让整条 filter 解析失败，所以先剔除再拼 pattern。
 */
export async function searchQuestions(keyword: string, limit = 100): Promise<Question[]> {
  const safe = keyword.replace(/[,%()*".:]/g, ' ').trim().slice(0, 40);
  if (!safe) return [];
  const userId = await getOwnerId();
  if (!userId) return [];
  const pattern = `%${safe}%`;
  const { data, error } = await supabase
    .from('quiz_questions')
    .select('*')
    .eq('user_id', userId)
    .or(`stem.ilike.${pattern},answer.ilike.${pattern},explanation.ilike.${pattern}`)
    .order('bank_id', { ascending: true })
    .order('order_index', { ascending: true })
    .limit(limit);
  if (error) {
    log('searchQuestions', error);
    return [];
  }
  return (data ?? []).map((row) => toQuestion(row as Record<string, unknown>));
}
