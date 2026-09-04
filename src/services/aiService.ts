/**
 * AI 能力层：统一通过 ai-relay 云函数调用「当前配置的供应商」
 *
 * - 内置供应商 → 平台免费模型
 * - 自定义供应商 → 由云函数按域名自动选协议
 * - 离线 / 供应商不可用 → 调用方捕获后退回本地规则（简答题有本地关键词兜底判分）
 *
 * 所有提示词都在内部做好约束：只输出 JSON、不编造、不改题干。
 */
import { supabaseUrl } from '../supabase/client';
import { authHeaders } from './ownerId';
import { findBuiltinChannel, getCachedAiConfig, type AiConfig } from './aiConfig';
import type { ParsedQuestion, Question, QuestionType } from '../types/quiz';

const RELAY_URL = `${supabaseUrl}/functions/v1/ai-relay`;
const RELAY_TIMEOUT = 58000;

export class RelayUnavailableError extends Error {
  constructor(message = 'AI 服务暂不可用') {
    super(message);
    this.name = 'RelayUnavailableError';
  }
}

function providerPayload(cfg: AiConfig): Record<string, unknown> {
  if (cfg.useBuiltin) {
    // 内置分两档：模型一（智谱免费）/ 模型二（千问 · 平台网关），由 ai-relay 按 channel 选上游与 Key
    const ch = findBuiltinChannel(cfg.builtinChannel);
    return { kind: 'builtin', channel: ch.id, model: cfg.model || ch.textModel };
  }
  return {
    kind: 'custom',
    base_url: cfg.baseUrl,
    api_key: cfg.apiKey,
    model: cfg.model,
    protocol: cfg.protocol,
  };
}

import {
  isQuotaExceededMessage,
  isZhipuBusyMessage,
  reportFallback,
  reportQuotaExceeded,
  reportZhipuBusy,
  syncRemaining,
} from './quotaService';

interface RelayOptions {
  system: string;
  user: string;
  json?: boolean;
  maxTokens?: number;
  temperature?: number;
  config?: AiConfig;
}

/**
 * 云函数在响应里回传额度信号，端侧统一在这里翻成提示：
 *  - code = qwen_quota_exceeded → 模型二今日已停用
 *  - fellBack = true → 智谱这次没走通，已自动改用模型二（扣 1 次额度）
 *  - qwenRemaining → 本次之后今日剩余次数
 * 只加提示，不改变原有的抛错与返回行为。
 */
function handleRelaySignal(json: Record<string, unknown>, body: Record<string, unknown>, errorMessage?: string): void {
  try {
    if (json.code === 'qwen_quota_exceeded' || (errorMessage && isQuotaExceededMessage(errorMessage))) {
      reportQuotaExceeded();
      return;
    }
    const remaining = typeof json.qwenRemaining === 'number' ? json.qwenRemaining : undefined;
    if (json.fellBack === true) {
      reportFallback(remaining);
      return;
    }
    if (typeof remaining === 'number') syncRemaining(remaining);
    const fromZhipu = (body.provider as Record<string, unknown> | undefined)?.channel === 'zhipu';
    if (fromZhipu && errorMessage && isZhipuBusyMessage(errorMessage)) reportZhipuBusy();
  } catch (error) {
    console.error('[aiService] 额度提示处理失败:', error);
  }
}

async function relay(body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RELAY_TIMEOUT);
  try {
    const response = await fetch(RELAY_URL, {
      method: 'POST',
      // 云函数已收紧为「仅登录态可调用」，必须带当前会话的 access_token
      headers: { 'Content-Type': 'application/json', ...(await authHeaders()) },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await response.text();
    let json: Record<string, unknown> = {};
    try {
      json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    } catch (error) {
      console.error('[aiService] 网关返回非 JSON:', error, text.slice(0, 160));
      throw new RelayUnavailableError('AI 网关返回异常，请稍后重试');
    }
    // test 分支即使额度用完也是 200 + ok:false，所以错误文案两边都要喂给信号处理
    const errorText = typeof json.error === 'string' ? json.error : undefined;
    if (!response.ok) {
      const message = String(json.error ?? `AI 网关异常（${response.status}）`);
      handleRelaySignal(json, body, message);
      throw new RelayUnavailableError(message);
    }
    handleRelaySignal(json, body, errorText);
    return json;
  } catch (error) {
    if (error instanceof RelayUnavailableError) throw error;
    console.error('[aiService] 调用 AI 网关失败:', error);
    throw new RelayUnavailableError('网络连接不稳定，AI 请求未完成');
  } finally {
    clearTimeout(timer);
  }
}

/** 一次对话式请求，返回文本内容 */
export async function relayChat(options: RelayOptions): Promise<string> {
  const cfg = options.config ?? getCachedAiConfig();
  const json = await relay({
    action: 'chat',
    provider: providerPayload(cfg),
    system: options.system,
    user: options.user,
    json: options.json ?? false,
    max_tokens: options.maxTokens ?? 1024,
    temperature: options.temperature ?? 0.1,
  });
  return String(json.content ?? '');
}

export interface TestResult {
  ok: boolean;
  message: string;
  latencyMs?: number;
  sample?: string;
  model?: string;
  protocol?: string;
}

/** 真实连接测试：发一条最小请求，验证地址 / Key / 模型号三件套 */
export async function testConnection(cfg: AiConfig): Promise<TestResult> {
  try {
    const json = await relay({
      action: 'test',
      provider: providerPayload(cfg),
      user: '只回复两个字：可用',
    });
    const ok = json.ok === true;
    return {
      ok,
      message: ok
        ? `连接成功 · ${Number(json.latencyMs ?? 0)}ms · ${String(json.protocol ?? 'openai')}`
        : String(json.error ?? '连接失败，请检查地址、Key 与模型号'),
      latencyMs: Number(json.latencyMs ?? 0),
      sample: String(json.sample ?? ''),
      model: String(json.model ?? cfg.model),
      protocol: String(json.protocol ?? ''),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('[aiService] 连接测试失败:', error);
    return { ok: false, message };
  }
}

/** 从模型返回里抠出 JSON（容错 ```json 包裹、前后废话） */
export function extractJson(raw: string): unknown {
  const text = String(raw ?? '').trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const body = fenced ? fenced[1].trim() : text;
  const starts = [body.indexOf('{'), body.indexOf('[')].filter((i) => i >= 0);
  if (starts.length === 0) return null;
  const first = Math.min(...starts);
  const last = Math.max(body.lastIndexOf('}'), body.lastIndexOf(']'));
  if (last <= first) return null;
  try {
    return JSON.parse(body.slice(first, last + 1));
  } catch (error) {
    console.error('[aiService] JSON 解析失败:', error, body.slice(first, first + 120));
    return null;
  }
}

/* ---------------- 简答题 AI 判分 ---------------- */

const JUDGE_SYSTEM = [
  '你是阅卷老师。给定一道简答题的题干、参考答案、考生作答，判断考生是否答对。',
  '总原则：看语义和逻辑，不看字面。整体意思说对了就算对，宽容认定。',
  '判分标准：',
  '1. 只要整体含义与逻辑同参考答案一致即可判对：允许同义表述、口语化改写、用自己的话复述、条理顺序不同、详略不同、要点合并或拆分。',
  '2. 答出核心要点且方向正确就算对；表述不完整、漏掉次要修饰或举例、少写一两个非关键词，都不作为判错理由。',
  '3. 专业术语是硬门槛：考生只要主动写到专业术语、专有名词、公式、符号、单位、数值、机构或人物名称，就必须与参考答案所指一致；术语用错、张冠李戴、概念混淆、公式或数值写错，其余内容再通顺也判错。',
  '4. 考生全程用日常语言、没有用术语，但把原理讲清楚了，不因「缺少术语」判错；反之意思讲反、答非所问、核心结论错误则判错。',
  '5. 两种解读都成立、拿不准时倾向判对，并在 reason 里点出需要自查的那一点。',
  '输出要求：只输出一个 JSON 对象，禁止任何解释性文字、禁止 Markdown 代码块。',
  'JSON 结构：{"correct": true 或 false, "reason": "不超过40字的中文判分理由"}',
].join('\n');

export interface JudgeResult {
  correct: boolean;
  reason: string;
  /** ai = 模型判分；local = 离线关键词兜底 */
  source: 'ai' | 'local';
}

/** 本地兜底判分：关键词覆盖率 */
function localJudge(reference: string, given: string): { correct: boolean; reason: string } {
  const ref = String(reference || '').toLowerCase();
  const ans = String(given || '').trim().toLowerCase();
  if (!ans) return { correct: false, reason: '未作答' };
  const tokens = ref
    .replace(/[\s，。、；：（）()【】\[\]"'“”·\-—]/g, '|')
    .split('|')
    .map((s) => s.trim())
    .filter((s) => s.length >= 2);
  const uniq = Array.from(new Set(tokens)).slice(0, 24);
  if (uniq.length === 0) return { correct: true, reason: '参考答案为空，默认已作答' };
  const hit = uniq.filter((t) => ans.includes(t.toLowerCase())).length;
  const ratio = hit / uniq.length;
  return {
    correct: ratio >= 0.4,
    reason: `关键词覆盖 ${Math.round(ratio * 100)}%（离线判定）`,
  };
}

/** 简答题判分：优先 AI，失败/离线自动退回本地关键词 */
export async function judgeShortAnswer(params: {
  stem: string;
  reference: string;
  given: string;
}): Promise<JudgeResult> {
  const { stem, reference, given } = params;
  if (!String(reference || '').trim()) {
    return { correct: String(given || '').trim().length > 0, reason: '本题无参考答案，按已作答处理', source: 'local' };
  }
  try {
    const content = await relayChat({
      system: JUDGE_SYSTEM,
      user: [
        `【题干】${stem}`,
        `【参考答案】${reference}`,
        `【考生作答】${given || '（空白）'}`,
        '请判分并只输出 JSON。',
      ].join('\n'),
      json: true,
      maxTokens: 200,
      temperature: 0,
    });
    const parsed = extractJson(content) as { correct?: unknown; reason?: unknown } | null;
    if (!parsed || typeof parsed.correct !== 'boolean') throw new RelayUnavailableError('判分结果无法解析');
    return {
      correct: parsed.correct,
      reason: String(parsed.reason ?? '').slice(0, 80),
      source: 'ai',
    };
  } catch (error) {
    console.error('[aiService] AI 判分失败，改用本地关键词判定:', error);
    const local = localJudge(reference, given);
    return { ...local, source: 'local' };
  }
}

/* ---------------- 无答案题库：AI 自动作答 ---------------- */

const SOLVE_SYSTEM = [
  '你是题库答案补全引擎。用户给你若干道题（只有题干与选项，没有答案），你需要作答。',
  '硬性规则：',
  '1. 必须忠实于题干本身，禁止编造题干里没有的事实，禁止改写题干或选项。',
  '2. 单选题只给一个字母；多选题给出全部正确字母（如 ABD）；判断题给 answerBool 布尔值；填空题每个空用 ||| 分隔；简答题给出要点式参考答案（80 字内）。',
  '3. 选项字母必须与输入中的 A/B/C/D 编号严格对应。',
  '4. 不确定的题目也要作答，但把 confidence 调低（0.3-0.5），并在 explanation 里写明「AI 推断，建议人工确认答案」。',
  '5. explanation 不超过 60 字，说明依据即可。',
  '输出要求：只输出 JSON，结构 {"items":[{"index":题号,"answer":"答案文本","answerBool":true/false/null,"explanation":"依据","confidence":0.0-1.0}]}，禁止多余文字与代码块。',
].join('\n');

export interface SolvedItem {
  index: number;
  answer: string;
  answerBool: boolean | null;
  explanation: string;
  confidence: number;
}

const SOLVE_BATCH = 12;

interface SolvableQuestion {
  type: string;
  stem: string;
  options?: string[];
  answer?: string;
  answerBool?: boolean | null;
}

function renderForSolve(list: { q: SolvableQuestion; index: number }[]): string {
  return list
    .map(({ q, index }) => {
      const opts = (q.options ?? []).map((o, i) => `${String.fromCharCode(65 + i)}. ${o}`).join(' | ');
      return [`${index + 1}. [${q.type}] ${q.stem}`, opts ? `选项：${opts}` : '', q.type === 'tf' ? '（判断题请给 answerBool）' : '']
        .filter(Boolean)
        .join('\n');
    })
    .join('\n\n');
}

/**
 * 为没有答案的题目补全答案（已入库题目与导入草稿都可复用）。
 * 分批（每批 12 题）串行请求，避免网关超时；单批失败不影响其他批。
 */
export async function solveMissingAnswers<T extends SolvableQuestion>(
  questions: T[],
  onProgress: (p: { done: number; total: number; solved: number }) => void,
  shouldAbort: () => boolean,
): Promise<Map<number, SolvedItem>> {
  const result = new Map<number, SolvedItem>();
  const jobs = questions
    .map((q, i) => ({ q, index: i }))
    .filter(({ q }) => !String(q.answer || '').trim() && (q.answerBool === null || q.answerBool === undefined));
  if (jobs.length === 0) return result;

  for (let start = 0; start < jobs.length; start += SOLVE_BATCH) {
    if (shouldAbort()) break;
    const batch = jobs.slice(start, start + SOLVE_BATCH);
    try {
      const content = await relayChat({
        system: SOLVE_SYSTEM,
        user: `请为以下 ${batch.length} 道题作答，按 index 返回：\n\n${renderForSolve(batch)}`,
        json: true,
        maxTokens: 2048,
        temperature: 0.1,
      });
      const parsed = extractJson(content) as { items?: SolvedItem[] } | null;
      const items = Array.isArray(parsed?.items) ? parsed.items : [];
      items.forEach((item) => {
        const idx = Number(item?.index);
        if (!Number.isFinite(idx)) return;
        // 模型可能返回 1 基或 0 基下标，两种都兼容
        const zeroBased = idx >= 1 && idx <= questions.length ? idx - 1 : -1;
        const target = zeroBased >= 0 ? zeroBased : idx;
        if (target < 0 || target >= questions.length) return;
        result.set(target, {
          index: target,
          answer: String(item.answer ?? ''),
          answerBool: item.answerBool === true || item.answerBool === false ? item.answerBool : null,
          explanation: String(item.explanation ?? ''),
          confidence: Math.max(0.1, Math.min(0.95, Number(item.confidence ?? 0.5))),
        });
      });
    } catch (error) {
      console.error(`[aiService] 补答案批次 ${start / SOLVE_BATCH + 1} 失败:`, error);
    }
    onProgress({
      done: Math.min(start + SOLVE_BATCH, jobs.length),
      total: jobs.length,
      solved: result.size,
    });
  }
  return result;
}

/* ---------------- 自定义供应商下的题目解析 ---------------- */

const PARSE_SYSTEM = [
  '你是题库整理专家。把用户提供的文档片段整理成标准题目数组。',
  '硬性规则：',
  '1. 只整理片段中真实存在的题目，禁止凭空补题、禁止把正文段落包装成题目。',
  '2. 题干与选项必须忠实原文，只允许去除编号、页眉页脚、多余空白。',
  '3. 题型只能是 choice（单选）、tf（判断）、fill（填空）、short（简答）四种。',
  '4. 选择题必须给出 options 数组，且每项以「A. 」「B. 」等字母前缀开头；answer 填正确选项字母。',
  '5. 判断题必须给 answerBool 布尔值，同时 answer 填「正确」或「错误」。',
  '6. 原文没有答案的题目，answer 留空字符串，并把 confidence 设为 0.3 以下。',
  '7. explanation 为原文给出的解析；原文没有则留空，禁止自行编造解析。',
  '输出要求：只输出 JSON，结构 {"questions":[{"type","stem","options","answer","answerBool","explanation","confidence"}]}，禁止任何多余文字与 Markdown 代码块。',
].join('\n');

const VALID_TYPES: QuestionType[] = ['choice', 'tf', 'fill', 'short'];

function normalizeParsed(dto: Record<string, unknown>, index: number): ParsedQuestion | null {
  const stem = String(dto.stem ?? '').trim();
  if (stem.length < 3) return null;
  const rawType = String(dto.type ?? 'short') as QuestionType;
  const type: QuestionType = VALID_TYPES.includes(rawType) ? rawType : 'short';
  const options = Array.isArray(dto.options) ? dto.options.map((o) => String(o)).filter(Boolean) : [];
  const answerBool = dto.answerBool === true || dto.answerBool === false ? dto.answerBool : null;
  return {
    key: `c_${index}_${Math.random().toString(36).slice(2, 8)}`,
    type,
    stem,
    options: type === 'choice' ? options : [],
    answer: String(dto.answer ?? ''),
    answerBool: type === 'tf' ? answerBool : null,
    explanation: String(dto.explanation ?? ''),
    confidence: Math.max(0.05, Math.min(0.98, Number(dto.confidence ?? 0.7))),
    reviewed: false,
    source: 'ai',
  };
}

/** 用当前配置的供应商解析文档片段（内置供应商仍走 doc-parse 通道） */
export async function parseQuestionsViaRelay(
  chunks: string[],
  onProgress: (p: { done: number; total: number; collected: number }) => void,
  shouldAbort: () => boolean,
): Promise<ParsedQuestion[]> {
  const out: ParsedQuestion[] = [];
  for (let i = 0; i < chunks.length; i += 1) {
    if (shouldAbort()) break;
    try {
      const content = await relayChat({
        system: PARSE_SYSTEM,
        user: `文档片段（第 ${i + 1}/${chunks.length} 段）：\n${chunks[i]}`,
        json: true,
        maxTokens: 2048,
        temperature: 0.1,
      });
      const parsed = extractJson(content) as { questions?: Record<string, unknown>[] } | null;
      const list = Array.isArray(parsed?.questions) ? parsed.questions : [];
      list.forEach((dto, j) => {
        const q = normalizeParsed(dto, out.length + j);
        if (q) out.push(q);
      });
    } catch (error) {
      console.error(`[aiService] 自定义供应商解析第 ${i + 1} 段失败:`, error);
    }
    onProgress({ done: i + 1, total: chunks.length, collected: out.length });
  }
  return out;
}

/* ---------------- 题目科目分类 ---------------- */

export const SUBJECT_OPTIONS = ['语文', '数学', '英语', '物理', '化学', '生物', '历史', '地理', '政治', '信息技术', '通用', '其他'] as const;

const CLASSIFY_SYSTEM = [
  '你是题目学科归类引擎。判断每道题属于哪个学科科目。',
  '可选科目（subject 只能取其一）：语文、数学、英语、物理、化学、生物、历史、地理、政治、信息技术、通用、其他。',
  '规则：',
  '1. 「政治」含道德与法治、思想政治、考研政治。',
  '2. 「通用」用于职场培训、安全生产、驾驶理论、生活常识等通识题。',
  '3. 依据题目实际考查内容判断；确实无法归类时选「其他」，禁止发明新科目名。',
  '输出要求：只输出 JSON {"items":[{"index":题号,"subject":"科目"}]}，禁止其他文字与代码块。',
].join('\n');

const CLASSIFY_BATCH = 15;

/**
 * 批量判定题目科目（每批 15 题串行，避开网关超时）。
 * 返回 Map<入参数组下标, 科目>；所有批次都失败时抛错，让调用方区分「AI 不可用」与「部分成功」。
 */
export async function classifySubjects(
  items: { stem: string }[],
  onProgress: (p: { done: number; total: number; classified: number }) => void,
  shouldAbort: () => boolean,
): Promise<Map<number, string>> {
  const result = new Map<number, string>();
  let okBatches = 0;
  for (let start = 0; start < items.length; start += CLASSIFY_BATCH) {
    if (shouldAbort()) break;
    const batch = items.slice(start, start + CLASSIFY_BATCH);
    const lines = batch.map((q, j) => `${start + j + 1}. ${q.stem.replace(/\s+/g, ' ').slice(0, 120)}`).join('\n');
    try {
      const content = await relayChat({
        system: CLASSIFY_SYSTEM,
        user: `请判断以下 ${batch.length} 道题的科目（编号已给出）：\n${lines}`,
        json: true,
        maxTokens: 1024,
        temperature: 0,
      });
      const parsed = extractJson(content) as { items?: { index?: unknown; subject?: unknown }[] } | null;
      const list = Array.isArray(parsed?.items) ? parsed.items : [];
      list.forEach((item) => {
        const no = Number(item?.index);
        if (!Number.isFinite(no)) return;
        const target = Math.floor(no) - 1;
        if (target < 0 || target >= items.length) return;
        const raw = String(item.subject ?? '').trim();
        result.set(target, (SUBJECT_OPTIONS as readonly string[]).includes(raw) ? raw : '其他');
      });
      okBatches += 1;
    } catch (error) {
      console.error(`[aiService] 科目分类批次 ${start / CLASSIFY_BATCH + 1} 失败:`, error);
    }
    onProgress({ done: Math.min(start + CLASSIFY_BATCH, items.length), total: items.length, classified: result.size });
  }
  if (items.length > 0 && okBatches === 0) throw new RelayUnavailableError('科目识别未完成');
  return result;
}

/* ---------------- AI 相似题 ---------------- */

export interface SimilarSource {
  type: QuestionType;
  stem: string;
  options: string[];
  answer: string;
  answerBool: boolean | null;
  explanation: string;
  subject?: string;
}

const SIMILAR_SYSTEM = [
  '你是命题专家。根据用户提供的「母题」生成相似题，用于举一反三练习。',
  '硬性规则：',
  '1. 与母题同题型、同知识点、难度相当；情境、数据、设问角度必须不同，禁止照抄母题题干或只换个别词。',
  '2. 题型只能是 choice、tf、fill、short；choice 必须给 4 个选项且有唯一正确答案，tf 必须给 answerBool。',
  '3. 答案必须正确且唯一；explanation 用 80 字内中文讲清思路。',
  '4. 涉及数值时重新设计自洽数据。',
  '输出要求：只输出 JSON {"questions":[{"type","stem","options","answer","answerBool","explanation","confidence"}]}，confidence 一律 0.6。禁止其他文字与代码块。',
].join('\n');

const FIND_SIMILAR_SYSTEM = [
  '你是相似题检索引擎。从候选题目中挑出与母题「题型相同且考查同一知识点」的题目。',
  '规则：宁缺毋滥，只挑真正可以举一反三的题；同一学科但知识点不同的不算相似；没有合适的就返回空数组。',
  '输出要求：只输出 JSON {"indices":[编号,...]}，编号为候选编号、从 1 开始。禁止其他文字与代码块。',
].join('\n');

function renderSimilarSource(q: SimilarSource): string {
  const opts = q.options.map((o, i) => `${String.fromCharCode(65 + i)}. ${o}`).join(' | ');
  const answerText = q.type === 'tf' ? (q.answerBool === null ? q.answer || '未给' : q.answerBool ? '正确' : '错误') : q.answer || '未给';
  return [
    `题型：${q.type}`,
    q.subject ? `科目：${q.subject}` : '',
    `题干：${q.stem}`,
    opts ? `选项：${opts}` : '',
    `参考答案：${answerText}`,
    q.explanation ? `解析：${q.explanation}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

/** 以母题生成 count 道相似题（返回解析草稿，未入库；科目沿用母题） */
export async function generateSimilarQuestions(source: SimilarSource, count: number): Promise<ParsedQuestion[]> {
  const content = await relayChat({
    system: SIMILAR_SYSTEM,
    user: `母题：\n${renderSimilarSource(source)}\n\n请生成 ${count} 道相似题，用于举一反三练习。`,
    json: true,
    maxTokens: count > 1 ? 2048 : 900,
    temperature: 0.8,
  });
  const parsed = extractJson(content) as { questions?: Record<string, unknown>[] } | null;
  const list = Array.isArray(parsed?.questions) ? parsed.questions : [];
  const out: ParsedQuestion[] = [];
  list.forEach((dto, j) => {
    if (out.length >= count) return;
    const q = normalizeParsed(dto, j);
    if (!q || q.stem.trim() === source.stem.trim()) return;
    q.subject = source.subject ?? '';
    out.push(q);
  });
  return out;
}

/** 从候选里挑相似题，返回候选数组下标（最多 maxPick 个）；没有则空数组 */
export async function findSimilarQuestions(
  source: SimilarSource,
  candidates: { type: QuestionType; stem: string }[],
  maxPick = 5,
): Promise<number[]> {
  if (candidates.length === 0) return [];
  const lines = candidates.map((q, i) => `${i + 1}. [${q.type}] ${q.stem.replace(/\s+/g, ' ').slice(0, 80)}`).join('\n');
  const content = await relayChat({
    system: FIND_SIMILAR_SYSTEM,
    user: `母题：\n${renderSimilarSource(source)}\n\n候选题目（共 ${candidates.length} 题）：\n${lines}\n\n最多挑 ${maxPick} 道相似题。`,
    json: true,
    maxTokens: 300,
    temperature: 0,
  });
  const parsed = extractJson(content) as { indices?: unknown } | null;
  const raw = Array.isArray(parsed?.indices) ? parsed.indices : [];
  const out: number[] = [];
  raw.forEach((v) => {
    const no = Number(v);
    if (!Number.isFinite(no)) return;
    const idx = Math.floor(no) - 1;
    if (idx >= 0 && idx < candidates.length && !out.includes(idx)) out.push(idx);
  });
  return out.slice(0, maxPick);
}

/* ---------------- 批量补解析 ---------------- */

const EXPLAIN_SYSTEM = [
  '你是题库解析撰写引擎。用户给出题干、选项与正确答案，你为每题补写「为什么是这个答案」的解析。',
  '硬性规则：',
  '1. 必须围绕给定的正确答案解释成立理由；选择题要说清正确项为何对、干扰项为何错。',
  '2. 禁止改写题干、选项或答案；禁止引入题目之外的新事实、新数据。',
  '3. 若你判断给定答案有误，仍然按给定答案写解析，但把疑点写进 note（不超过 30 字），供人工复核。',
  '4. explanation 60-120 字中文，不用 Markdown、不分段；没有疑点时 note 给空字符串。',
  '输出要求：只输出 JSON {"items":[{"index":题号,"explanation":"解析","note":"疑点或空串"}]}，禁止多余文字与代码块。',
].join('\n');

export interface ExplanationItem {
  explanation: string;
  /** 模型对给定答案的疑点提示，空串表示无异议 */
  note: string;
}

interface Explainable {
  type: string;
  stem: string;
  options?: string[];
  answer?: string;
  answerBool?: boolean | null;
  explanation?: string;
}

/** 解析输出比答案长得多，每批 8 题才不会撞 max_tokens 上限被截断 */
const EXPLAIN_BATCH = 8;

function answerTextOf(q: Explainable): string {
  if (q.type === 'tf') return q.answerBool === null || q.answerBool === undefined ? q.answer || '未给' : q.answerBool ? '正确' : '错误';
  return q.answer || '未给';
}

/**
 * 为「有答案、缺解析」的题目批量补写解析。
 * 返回 Map<入参数组下标, 解析>；单批失败不影响其他批。
 */
export async function generateExplanations<T extends Explainable>(
  questions: T[],
  onProgress: (p: { done: number; total: number; collected: number }) => void,
  shouldAbort: () => boolean,
): Promise<Map<number, ExplanationItem>> {
  const result = new Map<number, ExplanationItem>();
  const jobs = questions
    .map((q, index) => ({ q, index }))
    .filter(({ q }) => String(q.explanation ?? '').trim().length === 0 && answerTextOf(q) !== '未给');
  if (jobs.length === 0) return result;

  for (let start = 0; start < jobs.length; start += EXPLAIN_BATCH) {
    if (shouldAbort()) break;
    const batch = jobs.slice(start, start + EXPLAIN_BATCH);
    const lines = batch
      .map(({ q, index }) => {
        const opts = (q.options ?? []).map((o, i) => `${String.fromCharCode(65 + i)}. ${o}`).join(' | ');
        return [`${index + 1}. [${q.type}] ${q.stem}`, opts ? `选项：${opts}` : '', `正确答案：${answerTextOf(q)}`]
          .filter(Boolean)
          .join('\n');
      })
      .join('\n\n');
    try {
      const content = await relayChat({
        system: EXPLAIN_SYSTEM,
        user: `请为以下 ${batch.length} 道题补写解析（题号已给出）：\n\n${lines}`,
        json: true,
        maxTokens: 2048,
        temperature: 0.3,
      });
      const parsed = extractJson(content) as { items?: { index?: unknown; explanation?: unknown; note?: unknown }[] } | null;
      const items = Array.isArray(parsed?.items) ? parsed.items : [];
      items.forEach((item) => {
        const no = Number(item?.index);
        if (!Number.isFinite(no)) return;
        // 题号是「整库 1 基」，兼容模型按批内 1 基返回
        let target = Math.floor(no) - 1;
        if (target >= questions.length) target = Math.floor(no) - 1 - start;
        if (target < 0 || target >= questions.length) return;
        const text = String(item.explanation ?? '').trim();
        if (text.length < 8) return;
        result.set(target, { explanation: text.slice(0, 400), note: String(item.note ?? '').trim().slice(0, 60) });
      });
    } catch (error) {
      console.error(`[aiService] 补解析批次 ${start / EXPLAIN_BATCH + 1} 失败:`, error);
    }
    onProgress({ done: Math.min(start + EXPLAIN_BATCH, jobs.length), total: jobs.length, collected: result.size });
  }
  return result;
}

/* ---------------- 薄弱点诊断 ---------------- */

export interface DiagnosisRow {
  /** 维度名：科目名或题型中文名 */
  key: string;
  /** 该维度题目总数 */
  total: number;
  /** 作答次数 */
  attempts: number;
  /** 0-100 */
  accuracy: number;
  /** 已掌握题数 */
  mastered: number;
}

export interface DiagnosisInput {
  /** 总体作答正确率 0-100 */
  accuracy: number;
  attempts: number;
  /** 错题本待消灭题数 */
  wrongPending: number;
  questionCount: number;
  subjects: DiagnosisRow[];
  types: DiagnosisRow[];
  wrongSamples: { stem: string; wrongCount: number; subject: string }[];
}

export interface DiagnosisPoint {
  title: string;
  detail: string;
  action: string;
}

export interface Diagnosis {
  summary: string;
  points: DiagnosisPoint[];
  plan: string[];
}

const DIAGNOSE_SYSTEM = [
  '你是刷题应用的学习诊断顾问。根据用户给出的真实作答数据，指出薄弱环节并给出今天就能执行的下一步。',
  '硬性规则：',
  '1. 只能依据给定数据下结论，禁止编造未给出的科目、题型或题数。',
  '2. 作答次数少于 5 次的维度样本太少，不足以判断稳定性，不得当作主要薄弱点。',
  '3. points 最多 3 条，按影响从大到小排；title 不超过 12 字；detail 必须引用具体数字作为证据；action 是用户今天就能做的一步。',
  '4. plan 给 3-5 条练习安排，每条不超过 30 字、动词开头、可勾选执行。',
  '5. 全部中文，直说问题，不吹捧、不使用「您」。',
  '输出要求：只输出 JSON {"summary":"不超过60字的总体判断","points":[{"title","detail","action"}],"plan":["..."]}，禁止多余文字与代码块。',
].join('\n');

function renderRows(rows: DiagnosisRow[]): string {
  if (rows.length === 0) return '（暂无数据）';
  return rows
    .map((r) => `- ${r.key}：共 ${r.total} 题，已掌握 ${r.mastered} 题，作答 ${r.attempts} 次，正确率 ${Math.round(r.accuracy)}%`)
    .join('\n');
}

/** 薄弱点诊断：一次请求出整份报告，数据量小、不需要分批 */
export async function diagnoseWeakness(input: DiagnosisInput): Promise<Diagnosis> {
  const wrong = input.wrongSamples.length
    ? input.wrongSamples.map((w, i) => `${i + 1}. [${w.subject || '未分类'}·错 ${w.wrongCount} 次] ${w.stem.replace(/\s+/g, ' ').slice(0, 60)}`).join('\n')
    : '（错题本为空）';
  const content = await relayChat({
    system: DIAGNOSE_SYSTEM,
    user: [
      `总体：共 ${input.questionCount} 题，累计作答 ${input.attempts} 次，正确率 ${Math.round(input.accuracy)}%，错题本待消灭 ${input.wrongPending} 题。`,
      `分科目：\n${renderRows(input.subjects)}`,
      `分题型：\n${renderRows(input.types)}`,
      `最近错题样本：\n${wrong}`,
      '请给出诊断报告，只输出 JSON。',
    ].join('\n\n'),
    json: true,
    maxTokens: 1200,
    temperature: 0.3,
  });
  const parsed = extractJson(content) as {
    summary?: unknown;
    points?: { title?: unknown; detail?: unknown; action?: unknown }[];
    plan?: unknown;
  } | null;
  if (!parsed) throw new RelayUnavailableError('诊断结果无法解析');
  const points = (Array.isArray(parsed.points) ? parsed.points : []).slice(0, 3).map((p) => ({
    title: String(p?.title ?? '').trim().slice(0, 20),
    detail: String(p?.detail ?? '').trim().slice(0, 200),
    action: String(p?.action ?? '').trim().slice(0, 120),
  }));
  const plan = (Array.isArray(parsed.plan) ? parsed.plan : []).slice(0, 5).map((s) => String(s ?? '').trim().slice(0, 40)).filter(Boolean);
  const summary = String(parsed.summary ?? '').trim().slice(0, 160);
  if (!summary && points.length === 0 && plan.length === 0) throw new RelayUnavailableError('诊断结果为空');
  return { summary, points, plan };
}

/* ---------------- AI 出模拟卷 ---------------- */

const PAPER_SYSTEM = [
  '你是命题老师。用户给出「题号 → 题型 + 科目」的命题清单和若干参考题，你严格按清单逐题出卷。',
  '硬性规则：',
  '1. 题数、题型、科目必须与清单完全一致，不多不少，题号一一对应。',
  '2. 知识点与难度必须贴近参考题的考查范围；清单里没有参考题的科目，按该科目常见考点命题。',
  '3. 同卷内禁止重复题干与重复考点；choice 必须 4 个选项、唯一正确答案、不得出现「以上都对」这类无效选项。',
  '4. tf 必须给 answerBool 布尔值；fill 的空位用 ___ 表示、answer 用 ||| 分隔多空；short 给 80 字内参考答案。',
  '5. explanation 用 60-100 字讲清解题依据。',
  '输出要求：只输出 JSON {"questions":[{"index":清单题号,"type","stem","options","answer","answerBool","explanation","confidence"}]}，confidence 一律 0.6。禁止多余文字与代码块。',
].join('\n');

export interface PaperSlot {
  type: QuestionType;
  subject: string;
}

const TYPE_NAME: Record<QuestionType, string> = { choice: '单选', tf: '判断', fill: '填空', short: '简答' };

/** 一批 5 题：整卷题量多时靠小批保证每题的选项与解析都不被截断 */
const PAPER_BATCH = 5;

/**
 * 按命题清单生成整卷题目（返回未入库草稿）。
 * 题号是清单全局序号，模型漏题时按序号落位、不会错位；全部批次失败才抛错。
 */
export async function generateMockPaper(
  slots: PaperSlot[],
  samples: SimilarSource[],
  onProgress: (p: { done: number; total: number; collected: number }) => void,
  shouldAbort: () => boolean,
): Promise<ParsedQuestion[]> {
  const out: ParsedQuestion[] = [];
  const reference = samples.length
    ? samples.map((s, i) => `参考题 ${i + 1}：${renderSimilarSource(s).replace(/\n+/g, ' ')}`).join('\n')
    : '（无参考题，按科目常见考点命题）';

  for (let start = 0; start < slots.length; start += PAPER_BATCH) {
    if (shouldAbort()) break;
    const batch = slots.slice(start, start + PAPER_BATCH);
    const list = batch.map((s, j) => `第 ${start + j + 1} 题：${TYPE_NAME[s.type]}（${s.type}），科目「${s.subject}」`).join('\n');
    try {
      const content = await relayChat({
        system: PAPER_SYSTEM,
        user: [
          `命题清单（共 ${slots.length} 题，本批 ${batch.length} 题）：\n${list}`,
          `参考题：\n${reference}`,
          '请只命本批清单上的题，按题号返回。',
        ].join('\n\n'),
        json: true,
        maxTokens: 2048,
        temperature: 0.7,
      });
      const parsed = extractJson(content) as { questions?: Record<string, unknown>[] } | null;
      const items = Array.isArray(parsed?.questions) ? parsed.questions : [];
      const byIndex = new Map<number, Record<string, unknown>>();
      items.forEach((dto) => {
        const no = Number(dto?.index);
        if (Number.isFinite(no)) byIndex.set(Math.floor(no), dto);
      });
      batch.forEach((_slot, j) => {
        const globalNo = start + j + 1;
        const dto = byIndex.get(globalNo) ?? byIndex.get(j + 1);
        if (!dto) return;
        const q = normalizeParsed(dto, out.length);
        if (!q) return;
        q.subject = _slot.subject;
        out.push(q);
      });
    } catch (error) {
      console.error(`[aiService] 出卷批次 ${start / PAPER_BATCH + 1} 失败:`, error);
    }
    onProgress({ done: Math.min(start + PAPER_BATCH, slots.length), total: slots.length, collected: out.length });
  }
  if (slots.length > 0 && out.length === 0) throw new RelayUnavailableError('模拟卷未能生成');
  return out;
}
