/**
 * 全量备份 / 恢复
 *
 * 为什么需要：题库、作答记录、错题本、断点进度都只存在云端，账号一旦注销或云端误删
 * 就没有第二次机会。这里把当前账号的六张表原样导出成一个 JSON 文件，
 * 交给系统分享面板存到网盘/微信收藏，需要时再整份灌回来。
 *
 * 恢复策略：一律作为「新数据」写入（重新生成 uuid），不覆盖、不删除现有内容 ——
 * 备份文件可能来自半年前，直接覆盖会把用户这些天的做题记录抹掉。
 * 因此恢复前必须由调用方明确告知「会产生重复题库」，让用户自己决定。
 */
import { File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import * as DocumentPicker from 'expo-document-picker';
import { supabase } from '../supabase/client';
import { getOwnerId } from './ownerId';

const BACKUP_KIND = 'quiz-backup';
const BACKUP_VERSION = 1;
const PAGE = 1000;
const MAX_PAGES = 50;

type Row = Record<string, unknown>;

export interface BackupPayload {
  kind: typeof BACKUP_KIND;
  version: number;
  exportedAt: string;
  banks: Row[];
  questions: Row[];
  attempts: Row[];
  wrongBook: Row[];
  progress: Row[];
  settings: Row | null;
}

export interface BackupSummary {
  ok: boolean;
  message: string;
  counts?: { banks: number; questions: number; attempts: number; wrongBook: number; progress: number };
}

export interface RestoreSummary {
  ok: boolean;
  message: string;
  counts?: { banks: number; questions: number; attempts: number; wrongBook: number; progress: number };
}

/**
 * 分页读全表。
 *
 * 不做分页的话，PostgREST 默认单次返回上限会把大题库截断，
 * 用户以为备份完整、恢复时才发现少了一半题目。
 */
async function pagedRows(
  make: (from: number, to: number) => PromiseLike<{ data: unknown[] | null; error: { message: string } | null }>,
  label: string,
): Promise<Row[]> {
  const out: Row[] = [];
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const { data, error } = await make(page * PAGE, page * PAGE + PAGE - 1);
    if (error) throw new Error(`${label}读取失败：${error.message}`);
    const rows = (data ?? []) as Row[];
    out.push(...rows);
    if (rows.length < PAGE) break;
  }
  return out;
}

function stamp(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
}

/** 读取当前账号的全部云端数据（内存对象，不落盘） */
export async function collectBackup(): Promise<BackupPayload> {
  const userId = await getOwnerId();
  if (!userId) throw new Error('请先登录后再备份数据');
  const [banks, questions, attempts, wrongBook, progress, settingsRows] = await Promise.all([
    pagedRows((f, t) => supabase.from('quiz_banks').select('*').eq('user_id', userId).order('created_at', { ascending: true }).range(f, t), '题库'),
    pagedRows((f, t) => supabase.from('quiz_questions').select('*').eq('user_id', userId).order('order_index', { ascending: true }).range(f, t), '题目'),
    pagedRows((f, t) => supabase.from('quiz_attempts').select('*').eq('user_id', userId).order('created_at', { ascending: true }).range(f, t), '作答记录'),
    pagedRows((f, t) => supabase.from('quiz_wrong_book').select('*').eq('user_id', userId).order('updated_at', { ascending: true }).range(f, t), '错题本'),
    pagedRows((f, t) => supabase.from('quiz_progress').select('*').eq('user_id', userId).order('updated_at', { ascending: true }).range(f, t), '断点进度'),
    pagedRows((f, t) => supabase.from('quiz_settings').select('*').eq('user_id', userId).range(f, t), '设置'),
  ]);
  return {
    kind: BACKUP_KIND,
    version: BACKUP_VERSION,
    exportedAt: new Date().toISOString(),
    banks,
    questions,
    attempts,
    wrongBook,
    progress,
    settings: settingsRows[0] ?? null,
  };
}

/** 导出备份文件并打开系统分享面板 */
export async function exportBackup(): Promise<BackupSummary> {
  try {
    const payload = await collectBackup();
    if (payload.banks.length === 0) {
      return { ok: false, message: '当前账号还没有题库，无需备份。' };
    }
    const name = `刷题备份-${stamp()}.json`;
    const file = new File(Paths.cache, name);
    if (file.exists) file.delete();
    file.create();
    file.write(JSON.stringify(payload));

    const counts = {
      banks: payload.banks.length,
      questions: payload.questions.length,
      attempts: payload.attempts.length,
      wrongBook: payload.wrongBook.length,
      progress: payload.progress.length,
    };
    const available = await Sharing.isAvailableAsync();
    if (!available) {
      return { ok: true, message: `备份文件已生成（${name}），但这台设备不支持系统分享。`, counts };
    }
    await Sharing.shareAsync(file.uri, { mimeType: 'application/json', dialogTitle: '导出题库备份' });
    return { ok: true, message: '备份文件已生成，请选择保存位置。', counts };
  } catch (error) {
    console.error('[backup] 导出失败:', error);
    return { ok: false, message: error instanceof Error ? error.message : '备份未完成，请稍后重试。' };
  }
}

function parseBackup(text: string): BackupPayload {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (error) {
    console.error('[backup] JSON 解析失败:', error);
    throw new Error('这个文件不是合法的 JSON 备份文件');
  }
  const p = data as Partial<BackupPayload>;
  if (p.kind !== BACKUP_KIND) throw new Error('这个文件不是刷题 App 的备份文件');
  if (p.version !== BACKUP_VERSION) throw new Error(`备份文件版本（${String(p.version)}）与当前 App 不匹配`);
  if (!Array.isArray(p.banks) || !Array.isArray(p.questions)) throw new Error('备份文件内容不完整，缺少题库或题目');
  return {
    kind: BACKUP_KIND,
    version: BACKUP_VERSION,
    exportedAt: String(p.exportedAt ?? ''),
    banks: p.banks,
    questions: p.questions,
    attempts: Array.isArray(p.attempts) ? p.attempts : [],
    wrongBook: Array.isArray(p.wrongBook) ? p.wrongBook : [],
    progress: Array.isArray(p.progress) ? p.progress : [],
    settings: p.settings && typeof p.settings === 'object' ? p.settings : null,
  };
}

function chunk<T>(list: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

/**
 * 从备份文件恢复：选择 json → 校验 → 以新 id 写回云端。
 * partial = 有部分行没写成功（返回的 counts 是真实落库条数）。
 */
export async function restoreBackup(): Promise<RestoreSummary> {
  try {
    const userId = await getOwnerId();
    if (!userId) return { ok: false, message: '请先登录后再恢复数据。' };

    const picked = await DocumentPicker.getDocumentAsync({ type: ['application/json', 'text/plain', '*/*'] });
    if (picked.canceled) return { ok: false, message: '已取消恢复。' };
    const uri = picked.assets?.[0]?.uri;
    if (!uri) return { ok: false, message: '没有读到选中的文件，请重试。' };

    let payload: BackupPayload;
    try {
      payload = parseBackup(new File(uri).textSync());
    } catch (error) {
      console.error('[backup] 文件校验失败:', error);
      return { ok: false, message: error instanceof Error ? error.message : '备份文件无法识别。' };
    }

    const now = new Date().toISOString();
    const bankMap = new Map<string, string>();
    const questionMap = new Map<string, string>();
    let bankCount = 0;
    let questionCount = 0;

    // 题库与题目必须分两步：题目的 bank_id 是外键，必须先拿到新题库 id
    for (const bank of payload.banks) {
      const oldId = String(bank.id ?? '');
      const { data, error } = await supabase
        .from('quiz_banks')
        .insert({
          name: String(bank.name ?? '恢复的题库').slice(0, 40),
          source_file: bank.source_file ? String(bank.source_file) : null,
          is_ai_bank: Boolean(bank.is_ai_bank),
          question_count: Number(bank.question_count ?? 0),
          reviewed_count: Number(bank.reviewed_count ?? 0),
          user_id: userId,
          created_at: String(bank.created_at ?? now),
          updated_at: now,
        })
        .select('id')
        .maybeSingle();
      if (error || !data) {
        console.error('[backup] 恢复题库失败:', error);
        continue;
      }
      bankCount += 1;
      bankMap.set(oldId, String((data as Row).id));
    }

    const questionRows = payload.questions
      .filter((q) => bankMap.has(String(q.bank_id ?? '')))
      .map((q) => ({
        bank_id: bankMap.get(String(q.bank_id)) as string,
        type: String(q.type ?? 'choice'),
        stem: String(q.stem ?? ''),
        options: Array.isArray(q.options) ? (q.options as unknown[]).map((v) => String(v)) : [],
        answer: String(q.answer ?? ''),
        answer_bool: q.answer_bool === true || q.answer_bool === false ? q.answer_bool : null,
        explanation: q.explanation ? String(q.explanation) : null,
        confidence: Number(q.confidence ?? 0.5),
        reviewed: Boolean(q.reviewed),
        order_index: Number(q.order_index ?? 0),
        subject: q.subject ? String(q.subject) : null,
        difficulty: Number(q.difficulty ?? 0) > 0 ? Number(q.difficulty) : null,
        user_id: userId,
        created_at: String(q.created_at ?? now),
      }));
    for (const slice of chunk(questionRows, 100)) {
      const { data, error } = await supabase.from('quiz_questions').insert(slice).select('id, stem');
      if (error) {
        console.error('[backup] 恢复题目失败:', error);
        continue;
      }
      questionCount += (data ?? []).length;
    }

    // 题目 id 无法从 insert 结果直接对应回备份里的旧 id（同一次插入内顺序一致），
    // 因此按「备份题目顺序 + 新插入返回顺序」无法保证对齐 —— 改用题干+排序号回填。
    const restored = await pagedRows(
      (f, t) => supabase.from('quiz_questions').select('id, bank_id, stem, order_index').eq('user_id', userId).range(f, t),
      '恢复后的题目',
    );
    const keyOf = (bankId: string, stem: string, order: number) => `${bankId}|${String(stem).slice(0, 60)}|${order}`;
    const restoredKey = new Map<string, string>();
    restored.forEach((r) => restoredKey.set(keyOf(String(r.bank_id), String(r.stem), Number(r.order_index)), String(r.id)));
    payload.questions.forEach((q) => {
      const newBank = bankMap.get(String(q.bank_id ?? ''));
      if (!newBank) return;
      const hit = restoredKey.get(keyOf(newBank, String(q.stem ?? ''), Number(q.order_index ?? 0)));
      if (hit) questionMap.set(String(q.id ?? ''), hit);
    });

    let attemptCount = 0;
    const attemptRows = payload.attempts
      .filter((a) => questionMap.has(String(a.question_id ?? '')))
      .map((a) => ({
        question_id: questionMap.get(String(a.question_id)) as string,
        bank_id: bankMap.get(String(a.bank_id ?? '')) ?? null,
        correct: Boolean(a.correct),
        mode: String(a.mode ?? 'seq'),
        user_id: userId,
        created_at: String(a.created_at ?? now),
      }));
    for (const slice of chunk(attemptRows, 200)) {
      const { data, error } = await supabase.from('quiz_attempts').insert(slice).select('id');
      if (error) {
        console.error('[backup] 恢复作答记录失败:', error);
        continue;
      }
      attemptCount += (data ?? []).length;
    }

    let wrongCount = 0;
    const wrongRows = payload.wrongBook
      .filter((w) => questionMap.has(String(w.question_id ?? '')) && bankMap.has(String(w.bank_id ?? '')))
      .map((w) => ({
        question_id: questionMap.get(String(w.question_id)) as string,
        bank_id: bankMap.get(String(w.bank_id)) as string,
        wrong_count: Number(w.wrong_count ?? 1),
        streak_correct: Number(w.streak_correct ?? 0),
        resolved: Boolean(w.resolved),
        user_id: userId,
        updated_at: String(w.updated_at ?? now),
      }));
    for (const slice of chunk(wrongRows, 200)) {
      const { data, error } = await supabase.from('quiz_wrong_book').insert(slice).select('id');
      if (error) {
        console.error('[backup] 恢复错题本失败:', error);
        continue;
      }
      wrongCount += (data ?? []).length;
    }

    let progressCount = 0;
    for (const p of payload.progress) {
      const newBank = bankMap.get(String(p.bank_id ?? ''));
      if (!newBank) continue;
      const ids = Array.isArray(p.question_ids) ? (p.question_ids as unknown[]).map((v) => String(v)) : [];
      const mappedIds = ids.map((id) => questionMap.get(id)).filter((v): v is string => Boolean(v));
      const rawAnswers = (p.answers ?? {}) as Record<string, unknown>;
      // answers 的 jsonb 列类型是生成的 Json 联合，这里按 questionId -> ProgressAnswer 对象收窄一次，
      // 既保住 correct / reason / given 原文，又不会把 undefined 写进 jsonb
      const mappedAnswers: Record<string, Record<string, string | number | boolean | null>> = {};
      Object.keys(rawAnswers).forEach((id) => {
        const hit = questionMap.get(id);
        const value = rawAnswers[id];
        if (hit && value && typeof value === 'object') {
          mappedAnswers[hit] = value as Record<string, string | number | boolean | null>;
        }
      });
      // 顺序与作答都映射不到时，这条进度恢复出来会是「0 题的断点」，不如不写
      if (mappedIds.length === 0) continue;
      const { error } = await supabase
        .from('quiz_progress')
        .upsert(
          {
            bank_id: newBank,
            mode: String(p.mode ?? 'seq'),
            question_ids: mappedIds,
            answers: mappedAnswers,
            cursor: Number(p.cursor ?? 0),
            total: mappedIds.length,
            bank_name: String(p.bank_name ?? ''),
            user_id: userId,
            updated_at: now,
          },
          { onConflict: 'bank_id,mode' },
        );
      if (error) console.error('[backup] 恢复断点进度失败:', error);
      else progressCount += 1;
    }

    if (payload.settings) {
      const { error } = await supabase
        .from('quiz_settings')
        .upsert(
          {
            user_id: userId,
            default_mode: String(payload.settings.default_mode ?? 'seq'),
            allow_type_convert: payload.settings.allow_type_convert !== false,
            haptic_on_wrong: payload.settings.haptic_on_wrong !== false,
            updated_at: now,
          },
          { onConflict: 'user_id' },
        );
      if (error) console.error('[backup] 恢复设置失败:', error);
    }

    const counts = {
      banks: bankCount,
      questions: questionCount,
      attempts: attemptCount,
      wrongBook: wrongCount,
      progress: progressCount,
    };
    const expected = payload.banks.length;
    const partial = bankCount < expected || questionCount < questionRows.length;
    return {
      ok: true,
      message: partial
        ? `已恢复 ${bankCount}/${expected} 个题库、${questionCount} 题，其余未能写入云端，可再恢复一次或重新导入补齐。`
        : `已恢复 ${bankCount} 个题库、${questionCount} 题、${attemptCount} 条作答记录。`,
      counts,
    };
  } catch (error) {
    console.error('[backup] 恢复失败:', error);
    return { ok: false, message: error instanceof Error ? error.message : '恢复未完成，请稍后重试。' };
  }
}
