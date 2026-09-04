/**
 * 导入流程的草稿仓库。
 *
 * 为什么不用页面 state：AI 解析是后台长任务，用户会切 tab、会退回首页，
 * 页面一卸载 state 就没了 —— 这正是上一版「关掉之后进程没地方看」的根因。
 * 这里把草稿和任务编排放在模块级单例，页面只做订阅与渲染。
 */
import { useSyncExternalStore } from 'react';
import { AiBusyError, extractText, parseImageWithAI, parseWithAI, readAsBase64, splitChunks } from '../services/docClient';
import { compressImageForVision, type ImageSource } from '../services/imageCompress';
import { solveMissingAnswers } from '../services/aiService';
import { normalizeText, parseQuestionsLocally, type LocalParseResult } from '../services/questionParser';
import type { ParsedQuestion } from '../types/quiz';

export type DraftPhase = 'empty' | 'extracting' | 'ready' | 'running' | 'done' | 'failed' | 'cancelled';

export interface ImportDraft {
  fileName: string;
  mime: string;
  uri: string;
  text: string;
  /** 本次草稿来自图片识题（而不是文档提取），页面据此切换文案与可用操作 */
  fromImage: boolean;
  /** 当前预览的题目（本地解析结果 + 已合并的 AI 结果） */
  questions: ParsedQuestion[];
  /** AI 单独产出的题目，供二次合并 */
  aiQuestions: ParsedQuestion[];
  stats: LocalParseResult['stats'] | null;
  phase: DraftPhase;
  message: string;
  savedBankId: string | null;
  /** AI 自动作答（补全缺失答案）是否正在运行 */
  solving: boolean;
}

export interface TaskApi {
  begin: (label: string, total: number) => string;
  update: (id: string, patch: { done?: number; total?: number; collected?: number }) => void;
  finish: (id: string, status: 'done' | 'failed' | 'cancelled', message?: string) => void;
}

const EMPTY: ImportDraft = {
  fileName: '',
  mime: '',
  uri: '',
  text: '',
  fromImage: false,
  questions: [],
  aiQuestions: [],
  stats: null,
  phase: 'empty',
  message: '',
  savedBankId: null,
  solving: false,
};

let draft: ImportDraft = { ...EMPTY };
const listeners = new Set<() => void>();

function emit(): void {
  listeners.forEach((l) => l());
}

function patch(next: Partial<ImportDraft>): void {
  draft = { ...draft, ...next };
  emit();
}

export function getDraft(): ImportDraft {
  return draft;
}

export function resetDraft(): void {
  abortFlag = true;
  draft = { ...EMPTY };
  emit();
}

export function useDraft(): ImportDraft {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    getDraft,
    getDraft,
  );
}

function signature(q: ParsedQuestion): string {
  return `${q.type}|${normalizeText(q.stem).slice(0, 40)}`;
}

/** 把 AI 题目并入预览列表，按题型+题干前缀去重 */
export function mergeAiQuestions(): number {
  const exist = new Set(draft.questions.map(signature));
  const extra = draft.aiQuestions.filter((q) => !exist.has(signature(q)));
  if (extra.length > 0) patch({ questions: [...draft.questions, ...extra] });
  return extra.length;
}

export function setQuestions(list: ParsedQuestion[]): void {
  patch({ questions: list });
}

/** 保存成功后记录题库 id，避免重复入库 */
export function markSaved(bankId: string): void {
  patch({ savedBankId: bankId });
}

/** 选文件 → 提取文本 → 本地解析，返回给页面做反馈文案 */
export async function ingestFile(
  asset: { name: string; uri: string; mimeType?: string | null },
): Promise<{ ok: boolean; error?: string; busy?: boolean; count: number }> {
  const mime = asset.mimeType || guessMime(asset.name);
  patch({
    fileName: asset.name,
    mime,
    uri: asset.uri,
    phase: 'extracting',
    message: '',
    questions: [],
    aiQuestions: [],
    stats: null,
    savedBankId: null,
    text: '',
    fromImage: false,
  });
  try {
    const base64 = await readAsBase64(asset.uri);
    const text = await extractText(asset.name, mime, base64);
    if (!text.trim()) {
      patch({ phase: 'failed', message: '未能从该文件提取到文本，请确认文件不是扫描件或图片型 PDF' });
      return { ok: false, error: '文件内容为空', count: 0 };
    }
    const result = parseQuestionsLocally(text);
    patch({
      text,
      questions: result.questions,
      stats: result.stats,
      phase: 'ready',
      message: '',
    });
    return { ok: true, count: result.questions.length };
  } catch (error) {
    const busy = error instanceof AiBusyError;
    const msg = busy ? '当前AI模型繁忙' : '文件解析失败，请重试或换一个文件';
    console.error('[importStore] ingest failed:', error);
    patch({ phase: 'failed', message: msg });
    return { ok: false, error: msg, busy, count: 0 };
  }
}

function guessMime(name: string): string {
  const lower = name.toLowerCase();
  if (lower.endsWith('.pdf')) return 'application/pdf';
  if (lower.endsWith('.doc')) return 'application/msword';
  if (lower.endsWith('.docx')) return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  if (lower.endsWith('.pptx')) return 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
  if (lower.endsWith('.xlsx') || lower.endsWith('.xls')) return 'application/vnd.ms-excel';
  if (lower.endsWith('.md')) return 'text/markdown';
  return 'text/plain';
}

let abortFlag = false;

export function cancelAiParse(): void {
  abortFlag = true;
}

/**
 * 图片识题：压缩 → 视觉模型 → 直接产出结构化题目。
 *
 * 与文档通道完全不同的两点：
 *  1. 图片没有文本层，本地正则无从下手，所以不走 `parseQuestionsLocally`，题目全部来自 AI；
 *  2. 答案也一并由视觉模型给出（图里印了答案就照抄，没印就自己作答），因此不需要再跑「AI 自动作答」。
 *
 * 多张图片串行处理，逐张上报进度；单张失败不中断整体。
 */
export async function ingestImages(
  assets: ImageSource[],
  task: TaskApi,
): Promise<{ ok: boolean; error?: string; busy?: boolean; count: number }> {
  if (assets.length === 0) return { ok: false, error: '没有选择图片', count: 0 };

  const label = assets.length === 1 ? '图片' : `${assets.length} 张图片`;
  patch({
    fileName: assets.length === 1 ? assets[0].fileName || '题目图片.jpg' : `题目图片（${assets.length} 张）`,
    mime: 'image/jpeg',
    uri: assets[0].uri,
    phase: 'extracting',
    message: '',
    questions: [],
    aiQuestions: [],
    stats: null,
    savedBankId: null,
    text: '',
    fromImage: true,
  });
  abortFlag = false;

  const taskId = task.begin(`AI 识图解析${label}`, assets.length);
  const collected: ParsedQuestion[] = [];
  let failures = 0;
  let busy = false;

  for (let i = 0; i < assets.length; i += 1) {
    if (abortFlag) break;
    try {
      const image = await compressImageForVision(assets[i]);
      console.log(
        `[importStore] 图片 ${i + 1}/${assets.length} 压缩完成 ${image.width}x${image.height} ${(image.bytes / 1024).toFixed(0)}KB，开始识图`,
      );
      const list = await parseImageWithAI(image.base64, image.mime, (sec) => {
        // 识图单张实测 ~70s，任务条只有「张数」粒度，这里用草稿 message 补一个等待秒数，
        // 否则用户会以为卡死了。
        patch({ message: `AI 正在识别图片中的题目，已等待 ${sec}s…` });
      });
      console.log(`[importStore] 图片 ${i + 1}/${assets.length} 识图完成，识别 ${list.length} 题`);
      list.forEach((q) => collected.push(q));
    } catch (error) {
      if (error instanceof AiBusyError) {
        busy = true;
        console.error(`[importStore] 图片 ${i + 1}/${assets.length} 遇到模型繁忙:`, error);
        break;
      }
      failures += 1;
      console.error(`[importStore] 图片 ${i + 1}/${assets.length} 识图失败:`, error);
    }
    task.update(taskId, { done: i + 1, total: assets.length, collected: collected.length });
  }

  if (collected.length === 0) {
    const msg = busy
      ? '当前AI模型繁忙，请稍后重试'
      : abortFlag
        ? '已取消识图'
        : 'AI 未能从图片中识别出题目，请确认图片清晰、题目完整';
    console.error('[importStore] 识图整体失败:', msg, 'failures=', failures);
    task.finish(taskId, abortFlag ? 'cancelled' : 'failed', msg);
    patch({ phase: abortFlag ? 'cancelled' : 'failed', message: msg });
    return { ok: false, error: msg, busy, count: 0 };
  }

  patch({
    questions: collected,
    aiQuestions: collected,
    phase: 'ready',
    message:
      failures > 0
        ? `AI 识图完成，共识别 ${collected.length} 题（${failures} 张图片失败）`
        : `AI 识图完成，共识别 ${collected.length} 题`,
  });
  task.finish(taskId, abortFlag ? 'cancelled' : 'done', `已识别 ${collected.length} 题`);
  console.log('[importStore] 识图整体完成：', collected.length, '题，失败', failures, '张');
  return { ok: true, count: collected.length };
}

/**
 * AI 辅助解析：逐片串行请求，进度写入全局任务条。
 * 与页面生命周期解耦 —— 用户退回首页、收起进度条，任务照跑，结果照存。
 */
export async function startAiParse(text: string, task: TaskApi): Promise<void> {
  const chunks = splitChunks(text);
  if (chunks.length === 0) {
    patch({ phase: 'failed', message: '没有可供 AI 解析的文本' });
    return;
  }
  abortFlag = false;
  patch({ phase: 'running', message: '', aiQuestions: [] });
  const taskId = task.begin(`AI 解析《${draft.fileName || '文档'}》`, chunks.length);
  let collected: ParsedQuestion[] = [];
  try {
    collected = await parseWithAI(
      text,
      (p) => {
        task.update(taskId, { done: p.done, total: p.total, collected: p.collected });
      },
      () => abortFlag,
    );
    patch({ aiQuestions: collected });
    if (abortFlag) {
      task.finish(taskId, 'cancelled', `已取消，已识别 ${collected.length} 题`);
      patch({ phase: 'cancelled' });
      return;
    }
    const added = mergeAiQuestions();
    task.update(taskId, { done: chunks.length, total: chunks.length, collected: collected.length });
    task.finish(taskId, 'done');
    patch({ phase: 'done', message: `AI 新增 ${added} 题（去重后）` });
  } catch (error) {
    const busy = error instanceof AiBusyError;
    const msg = busy ? '当前AI模型繁忙，已保留本地解析结果' : 'AI 解析中断，本地结果仍然可用';
    console.error('[importStore] ai parse failed:', error);
    task.finish(taskId, 'failed', msg);
    patch({ phase: 'failed', message: msg });
  }
}

let abortSolve = false;

export function cancelAiSolve(): void {
  abortSolve = true;
}

/**
 * AI 自动作答：草稿里只有题干、没有答案的题目，让 AI 逐批做题补全答案。
 * 同样放在模块级，用户退回首页任务也不中断。
 */
export async function startAiSolve(task: TaskApi): Promise<void> {
  const base = draft.questions;
  const missing = base.filter((q) => !q.answer && q.answerBool === null);
  if (missing.length === 0) {
    patch({ message: '所有题目都已有答案，无需补全' });
    return;
  }
  if (draft.solving) return;
  abortSolve = false;
  patch({ solving: true, message: '' });
  const taskId = task.begin(`AI 自动作答《${draft.fileName || '文档'}》`, Math.ceil(missing.length / 12));
  try {
    const map = await solveMissingAnswers(
      base,
      (p) => task.update(taskId, { done: p.done, total: p.total, collected: p.solved }),
      () => abortSolve,
    );
    if (map.size === 0) {
      task.finish(taskId, abortSolve ? 'cancelled' : 'failed', abortSolve ? '已取消自动作答' : 'AI 未能返回可用答案');
      patch({ solving: false, message: abortSolve ? '' : 'AI 未能返回可用答案，可稍后重试' });
      return;
    }
    const next = draft.questions.map((q, i) => {
      const hit = map.get(i);
      if (!hit) return q;
      if (q.type === 'tf') {
        if (hit.answerBool === null) {
          const t = hit.answer.trim();
          if (!t) return q;
          return { ...q, answer: t, explanation: hit.explanation || q.explanation, confidence: hit.confidence };
        }
        return {
          ...q,
          answer: hit.answerBool ? '正确' : '错误',
          answerBool: hit.answerBool,
          explanation: hit.explanation || q.explanation,
          confidence: hit.confidence,
        };
      }
      if (!hit.answer.trim()) return q;
      return { ...q, answer: hit.answer.trim(), explanation: hit.explanation || q.explanation, confidence: hit.confidence };
    });
    patch({ questions: next, solving: false, message: `AI 已补全 ${map.size} 题答案，请逐题确认答案` });
    console.log('[importStore] AI 自动作答完成：缺答案', missing.length, '题 → 已补全', map.size, '题');
    task.update(taskId, { done: Math.ceil(missing.length / 12), total: Math.ceil(missing.length / 12), collected: map.size });
    task.finish(taskId, abortSolve ? 'cancelled' : 'done', `已补全 ${map.size} 题答案`);
  } catch (error) {
    console.error('[importStore] ai solve failed:', error);
    task.finish(taskId, 'failed', 'AI 自动作答中断，已保留原有结果');
    patch({ solving: false, message: 'AI 自动作答中断，已保留原有结果' });
  }
}
