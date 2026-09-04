/**
 * 文档解析云函数客户端
 *
 * 网关对单次请求有 60s 硬超时，因此：
 *  - 文本 AI 解析采用「前端切片 + 逐片串行请求」：每片约 900 字，单片实测 ~16s 返回，天然产出进度。
 *  - 图片识题单张实测 ~70s，切不动，改走「云函数建任务立刻返回 jobId + 前端轮询结果」。
 */
import { File } from 'expo-file-system';
import { supabaseUrl } from '../supabase/client';
import { authHeaders } from './ownerId';
import { getCachedAiConfig } from './aiConfig';
import { isQuotaExceededMessage, isZhipuBusyMessage, reportQuotaExceeded, reportZhipuBusy } from './quotaService';
import type { ParsedQuestion, QuestionType } from '../types/quiz';

const FUNCTION_URL = `${supabaseUrl}/functions/v1/doc-parse`;
const CHUNK_SIZE = 900;
const MAX_CHUNKS = 40;

export class AiBusyError extends Error {
  constructor() {
    super('当前AI模型繁忙');
    this.name = 'AiBusyError';
  }
}

interface GenQuestionDto {
  type?: string;
  stem?: string;
  options?: string[];
  answer?: string;
  answerBool?: boolean | null;
  explanation?: string;
  confidence?: number;
}

const VALID_TYPES: QuestionType[] = ['choice', 'tf', 'fill', 'short'];

function normalizeDto(dto: GenQuestionDto, index: number, source: 'ai' | 'local'): ParsedQuestion | null {
  const stem = String(dto.stem ?? '').trim();
  if (stem.length < 3) return null;
  const rawType = String(dto.type ?? 'short') as QuestionType;
  const type: QuestionType = VALID_TYPES.includes(rawType) ? rawType : 'short';
  const options = Array.isArray(dto.options) ? dto.options.map((o) => String(o)).filter(Boolean) : [];
  const answerBool = dto.answerBool === true || dto.answerBool === false ? dto.answerBool : null;
  return {
    key: `a_${index}_${Math.random().toString(36).slice(2, 8)}`,
    type,
    stem,
    options: type === 'choice' ? options : [],
    answer: String(dto.answer ?? ''),
    answerBool: type === 'tf' ? answerBool : null,
    explanation: String(dto.explanation ?? ''),
    confidence: Math.max(0.05, Math.min(0.98, Number(dto.confidence ?? 0.8))),
    reviewed: false,
    source,
  };
}

async function post(body: Record<string, unknown>): Promise<Record<string, unknown>> {
  // 内置免费模型分两档，云函数按 channel 决定用智谱还是千问；选了自定义供应商时仍按现状走千问
  const cfg = getCachedAiConfig();
  const payload = { ...body, channel: cfg.useBuiltin ? cfg.builtinChannel : 'qwen' };
  const response = await fetch(FUNCTION_URL, {
    method: 'POST',
    // 云函数已收紧为「仅登录态可调用」，必须带当前会话的 access_token
    headers: { 'Content-Type': 'application/json', ...(await authHeaders()) },
    body: JSON.stringify(payload),
  });
  const text = await response.text();
  let json: Record<string, unknown> = {};
  try {
    json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch (error) {
    console.error('[docClient] 响应不是合法 JSON:', error, text.slice(0, 200));
    throw new Error('解析服务返回异常');
  }
  if (!response.ok) {
    const message = String(json.error ?? `解析服务异常（${response.status}）`);
    reportParseSignal(message);
    if (message.includes('繁忙')) throw new AiBusyError();
    throw new Error(message);
  }
  return json;
}

/**
 * 导入/识图链路的额度提示：云函数在「模型二今日停用」时会回带固定文案，
 * 智谱被限流且没能降级成功时回「繁忙」。这里只负责弹全局提示，
 * 原有 AiBusyError / Error 抛出行为保持不变。
 */
export function reportParseSignal(message: string): void {
  try {
    if (isQuotaExceededMessage(message)) {
      reportQuotaExceeded();
      return;
    }
    const cfg = getCachedAiConfig();
    if (cfg.useBuiltin && cfg.builtinChannel === 'zhipu' && isZhipuBusyMessage(message)) reportZhipuBusy();
  } catch (error) {
    console.error('[docClient] 额度提示处理失败:', error);
  }
}

/** 读取本地文档为 base64（Web 预览下 File 不可用时回退 data URL） */
export async function readAsBase64(uri: string): Promise<string> {
  const file = new File(uri);
  if (!file.exists) throw new Error('文件不存在或已被系统清理');
  const bytes = await file.bytes();
  let binary = '';
  const view = new Uint8Array(bytes);
  const STEP = 0x8000;
  for (let i = 0; i < view.length; i += STEP) {
    binary += String.fromCharCode(...view.subarray(i, i + STEP));
  }
  return btoa(binary);
}

/** 上传文件到云函数做文本提取 */
export async function extractText(filename: string, mime: string, base64: string): Promise<string> {
  const json = await post({ mode: 'extract', filename, mime, base64 });
  return String(json.text ?? '');
}

/** 识图轮询节奏：视觉模型单张实测 ~70s，上限给到 4 分钟，覆盖题目密集页 */
const VISION_POLL_INTERVAL_MS = 3000;
const VISION_POLL_TIMEOUT_MS = 240000;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 图片识题：压缩后的图片 base64 交给视觉模型，产出结构化题目。
 * 与文本通道不同，这里不需要本地正则兜底 —— 图片里本来就没有可提取的文本层。
 *
 * ⚠️ 必须走异步任务：视觉模型单张图实测 ~70s，超过网关 60s 硬超时，
 * 同步等结果客户端只会拿到 504。所以先 vision-start 拿 jobId，再轮询 vision-status。
 * onProgress 每秒数回调一次，供导入页显示「已等待 Ns」。
 */
export async function parseImageWithAI(
  base64: string,
  mime: string,
  onProgress?: (elapsedSec: number) => void,
): Promise<ParsedQuestion[]> {
  const started = await post({ mode: 'vision-start', imageBase64: base64, mime });
  const jobId = String(started.jobId ?? '');
  if (!jobId) throw new Error('识图任务创建失败，请重试');
  console.log(`[docClient] 识图任务已创建 job=${jobId}，图片 base64 ${Math.round(base64.length / 1024)}KB`);

  const t0 = Date.now();
  for (;;) {
    const elapsed = Date.now() - t0;
    if (elapsed > VISION_POLL_TIMEOUT_MS) {
      console.error(`[docClient] 识图超时 job=${jobId} elapsedMs=${elapsed}`);
      throw new Error('识图耗时过长，请换一张更清晰的图片或重试');
    }
    await delay(VISION_POLL_INTERVAL_MS);
    onProgress?.(Math.round((Date.now() - t0) / 1000));

    let json: Record<string, unknown>;
    try {
      json = await post({ mode: 'vision-status', jobId });
    } catch (error) {
      if (error instanceof AiBusyError) throw error;
      const message = error instanceof Error ? error.message : String(error);
      // 任务行已经没了（过期被清），再等也不会有结果，直接失败
      if (message.includes('不存在') || message.includes('已过期')) throw error;
      console.error(`[docClient] 识图轮询抖动 job=${jobId}，继续重试:`, message);
      continue;
    }

    const status = String(json.status ?? '');
    if (status === 'running') continue;
    if (status === 'error') {
      const failure = String(json.error ?? 'AI 识图失败，请重试');
      // 识图跑在后台任务里，额度用完 / 智谱限流都只体现在这条错误文案上，同样要弹全局提示
      reportParseSignal(failure);
      throw new Error(failure);
    }
    if (status !== 'done') throw new Error('识图任务状态异常，请重试');

    const list = Array.isArray(json.questions) ? (json.questions as GenQuestionDto[]) : [];
    const out: ParsedQuestion[] = [];
    list.forEach((dto, index) => {
      const q = normalizeDto(dto, index, 'ai');
      if (q) out.push(q);
    });
    console.log(`[docClient] 识图完成 job=${jobId} 耗时 ${Math.round((Date.now() - t0) / 1000)}s，返回 ${list.length} 条，规范化后 ${out.length} 题`);
    if (out.length === 0) throw new Error('AI 未能从图片中识别出题目');
    return out;
  }
}

/** 把长文本切成尽量按段落边界断开的小片 */
export function splitChunks(text: string, size = CHUNK_SIZE): string[] {
  const clean = text.trim();
  if (!clean) return [];
  const chunks: string[] = [];
  let rest = clean;
  while (rest.length > size && chunks.length < MAX_CHUNKS) {
    let cut = rest.lastIndexOf('\n', size);
    if (cut < size * 0.4) cut = size;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).trim();
  }
  if (rest.length > 0 && chunks.length < MAX_CHUNKS) chunks.push(rest);
  return chunks;
}

export interface AiParseProgress {
  done: number;
  total: number;
  collected: number;
}

/**
 * AI 辅助解析：逐片请求，每完成一片回调一次进度。
 * 单片失败不会中断整体，只在全部失败时抛错。
 */
export async function parseWithAI(
  text: string,
  onProgress: (p: AiParseProgress) => void,
  shouldAbort: () => boolean,
): Promise<ParsedQuestion[]> {
  const chunks = splitChunks(text);
  if (chunks.length === 0) return [];
  const out: ParsedQuestion[] = [];
  let failures = 0;

  for (let i = 0; i < chunks.length; i += 1) {
    if (shouldAbort()) break;
    try {
      const json = await post({ mode: 'gen', text: chunks[i] });
      const list = Array.isArray(json.questions) ? (json.questions as GenQuestionDto[]) : [];
      list.forEach((dto, j) => {
        const q = normalizeDto(dto, out.length + j, 'ai');
        if (q) out.push(q);
      });
    } catch (error) {
      if (error instanceof AiBusyError) throw error;
      failures += 1;
      console.error(`[docClient] AI 分片 ${i + 1}/${chunks.length} 失败:`, error);
    }
    onProgress({ done: i + 1, total: chunks.length, collected: out.length });
  }

  if (out.length === 0 && failures === chunks.length) {
    throw new Error('AI 未能解析出题目');
  }
  return out;
}
