/**
 * doc-parse：文档解析 + AI 出题服务
 *
 * 输入（JSON）：
 *  - mode: "extract"            —— 仅提取文本：{ filename, mime, base64 }（文件 ≤ 4MB）
 *  - mode: "gen"                —— 文本 → 结构化题目：{ text, hint? }（非流式 JSON 输出）
 *  - mode: "parse"              —— 一步到位：{ filename, mime, base64, hint? }
 *  - mode: "vision-start"       —— 图片识题（异步建任务）：{ imageBase64, mime } 或 { imageUrl, hint? }
 *  - mode: "vision-status"      —— 轮询识题结果：{ jobId }
 *
 * 输出：
 *  - extract: { text }
 *  - gen/parse: { questions: [{ type, stem, options, answer, answerBool, explanation, confidence }] }
 *  - vision-start: { jobId }
 *  - vision-status: { status: "running" | "done" | "error", questions?, error? }
 *
 * ⚠️ 识图为什么必须异步：视觉模型单张图实测 70s，网关 60s 硬超时，同步返回时客户端只能拿到 504。
 *    所以 vision-start 落一条 running 任务后立刻返回 jobId，AI 调用丢到后台继续跑（实测响应返回后
 *    isolate 不会被杀，日志里仍能看到 vision job done），结果写回 quiz_vision_jobs，前端轮询取。
 *
 * 内置免费模型两档：模型一 = 智谱（文本 glm-4.7-flash / 识图 glm-4.6v-flash，AK 读 ZHIPU_FREE_API_KEY）；
 * 模型二 = Meoo AI（文本 qwen3.6-plus / 识图 qwen3-vl-plus，AK 读 MEOO_PROJECT_API_KEY）。
 * 两把 Key 都只在服务端，不落前端。
 * PDF 文本提取使用 pdfjs-dist（esm.sh），docx 解压 word/document.xml 提取段落。
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const MEOO_AI_BASE_URL = 'https://api.meoo.host';
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
const AK = Deno.env.get('MEOO_PROJECT_API_KEY') || '';
const MODEL = 'qwen3.6-plus';
const MEOO_CHAT_URL = `${MEOO_AI_BASE_URL}/meoo-ai/compatible-mode/v1/chat/completions`;
/** 内置「模型一」= 智谱 GLM 免费模型，Key 只存云函数密钥 */
const ZHIPU_CHAT_URL = 'https://open.bigmodel.cn/api/paas/v4/chat/completions';
const ZHIPU_TEXT_MODEL = 'glm-4.7-flash';
const ZHIPU_VISION_MODEL = 'glm-4.6v-flash';
const ZHIPU_AK = Deno.env.get('ZHIPU_FREE_API_KEY') || '';

/* ---------------- 内置「模型二 · 千问」每人每天额度 ---------------- */

/** 每人每天最多打到千问上游的次数；智谱「模型一」不计数，用户可自行反复重试 */
const QWEN_DAILY_LIMIT = 2;

/** 额度用完后返回给端侧的固定标识 + 提示语（端侧靠「额度已用完」识别并弹全局提示） */
class QuotaExceededError extends Error {
  constructor() {
    super('模型二（千问）今日 2 次免费额度已用完，请改用模型一（智谱）重试，或明天 00:00 后再来');
    this.name = 'QuotaExceededError';
  }
}

/**
 * 原子「检查 + 扣一次」，计数放在数据库，改客户端绕不过去。
 * 自然日按东八区算，次日 00:00 自动是新的一行。
 */
async function consumeQwenCall(token: string): Promise<boolean> {
  if (!token) return true;
  try {
    const { data, error } = await userClient(token).rpc('consume_qwen_quota', { p_limit: QWEN_DAILY_LIMIT });
    if (error) throw error;
    const row = (Array.isArray(data) ? data[0] : data) as { allowed?: boolean } | undefined;
    return row?.allowed === true;
  } catch (error) {
    // 计数表读不到时放行：额度是省成本的软限制，不该因为库抖动把导入整个弄挂
    console.error(`[${functionName}] consume_qwen_quota failed ${reqId}, allow by default:`, (error as Error).message);
    return true;
  }
}

/**
 * 按前端传来的档位选上游。
 * 智谱密钥缺失时自动退回千问，不让「选了模型一」变成整条链路不可用。
 */
function aiTarget(channel: unknown, kind: 'text' | 'vision') {
  const useZhipu = channel === 'zhipu' && Boolean(ZHIPU_AK);
  if (useZhipu) {
    return {
      channel: 'zhipu' as const,
      url: ZHIPU_CHAT_URL,
      key: ZHIPU_AK,
      model: kind === 'text' ? ZHIPU_TEXT_MODEL : ZHIPU_VISION_MODEL,
    };
  }
  return {
    channel: 'qwen' as const,
    url: MEOO_CHAT_URL,
    key: AK,
    model: kind === 'text' ? MODEL : VISION_MODEL,
  };
}

/**
 * 智谱免费模型实测会被限流（HTTP 429 / code 1305「该模型当前访问量过大」），
 * 所以「模型一」失败时补一次「模型二」，避免整条导入链路直接不可用。
 * 代价：这一次会消耗平台额度，日志必须打 fallback 标记。
 */
async function genQuestionsSafe(text: string, channel: unknown, token: string): Promise<GenQuestion[]> {
  if (channel === 'zhipu' && ZHIPU_AK && AK) {
    try {
      return await genQuestions(text, 'zhipu', token);
    } catch (error) {
      if (error instanceof QuotaExceededError) throw error;
      console.error(`[${functionName}] zhipu text failed ${reqId}, fallback=qwen:`, (error as Error).message);
      return genQuestions(text, 'qwen', token);
    }
  }
  return genQuestions(text, channel, token);
}

/** 识图跑在后台任务里（前端轮询、4 分钟封顶），没有 60s 网关压力，可以直接重试一次 */
async function visionQuestionsSafe(imageUrl: string, hint: string, channel: unknown, token: string): Promise<GenQuestion[]> {
  if (channel === 'zhipu' && ZHIPU_AK && AK) {
    try {
      return await visionQuestions(imageUrl, hint, 'zhipu', token);
    } catch (error) {
      if (error instanceof QuotaExceededError) throw error;
      console.error(`[${functionName}] zhipu vision failed ${reqId}, fallback=qwen:`, (error as Error).message);
      return visionQuestions(imageUrl, hint, 'qwen', token);
    }
  }
  return visionQuestions(imageUrl, hint, channel, token);
}

const MAX_FILE_BYTES = 4 * 1024 * 1024;

const functionName = 'doc-parse';
const reqId = crypto.randomUUID().slice(0, 8);

type GenQuestion = {
  type: 'choice' | 'tf' | 'fill' | 'short';
  stem: string;
  options: string[];
  answer: string;
  answerBool: boolean | null;
  explanation: string;
  confidence: number;
};

function jsonHeaders(): Record<string, string> {
  return { 'Content-Type': 'application/json' };
}

function badRequest(message: string): Response {
  return new Response(JSON.stringify({ error: message }), { status: 400, headers: jsonHeaders() });
}

/**
 * 登录态校验：拿请求里的 access_token 去 Auth 服务换真实用户。
 * 匿名密钥（anon key）不是合法的用户 token，换不到身份 → 401。
 */
async function requireAuth(req: Request): Promise<{ userId: string; token: string } | null> {
  const header = req.headers.get('Authorization') ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!token || !SUPABASE_URL || !SUPABASE_ANON_KEY) return null;
  try {
    const probe = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
    const { data, error } = await probe.auth.getUser(token);
    if (error || !data.user) return null;
    // token 一并返回：识图任务表走 RLS(user_id = auth.uid())，读写都要带用户身份
    return { userId: data.user.id, token };
  } catch (_) {
    return null;
  }
}

function unauthorized(): Response {
  return new Response(JSON.stringify({ error: '请先登录后再使用此功能' }), { status: 401, headers: jsonHeaders() });
}

/* ---------------- 文件文本提取 ---------------- */

function decodeBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function decodeTextBytes(bytes: Uint8Array): string {
  // 优先 UTF-8；含大量替换符时回退 GBK（Edge Runtime 内置 GBK 解码支持有限，尽力而为）
  const utf8 = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  const bad = (utf8.match(/\uFFFD/g) || []).length;
  if (bad > utf8.length * 0.02) {
    try {
      return new TextDecoder('gbk', { fatal: false }).decode(bytes);
    } catch (_) {
      return utf8;
    }
  }
  return utf8;
}

async function extractFromTxt(bytes: Uint8Array): Promise<string> {
  return decodeTextBytes(bytes);
}

async function extractFromDocx(bytes: Uint8Array): Promise<string> {
  const jszipMod = await import('https://esm.sh/jszip@3.10.1');
  const JSZip = ((jszipMod as unknown as { default?: unknown }).default ?? jszipMod) as {
    loadAsync(data: Uint8Array): Promise<{ file(path: string): { async(type: 'string'): Promise<string> } | null }>;
  };
  const zip = await JSZip.loadAsync(bytes);
  const docFile = zip.file('word/document.xml');
  if (!docFile) throw new Error('docx 缺少 word/document.xml');
  const xml = await docFile.async('string');

  const paras: string[] = [];
  const pRegex = /<w:p[ >][\s\S]*?<\/w:p>/g;
  let m: RegExpExecArray | null;
  while ((m = pRegex.exec(xml)) !== null) {
    const pXml = m[0];
    let line = '';
    const tRegex = /<w:t(?:[^>]*)>([\s\S]*?)<\/w:t>/g;
    let t: RegExpExecArray | null;
    while ((t = tRegex.exec(pXml)) !== null) {
      line += t[1]
        .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
        .replace(/&quot;/g, '"').replace(/&apos;/g, "'");
    }
    if (line.trim()) paras.push(line.trim());
  }
  return paras.join('\n');
}

async function extractFromPdf(bytes: Uint8Array): Promise<string> {
  const pdfjs: any = await import('https://esm.sh/pdfjs-dist@4.10.38/legacy/build/pdf.mjs');
  const TypedArray = Object.getPrototypeOf(new Uint8Array()).constructor;
  let output = '';
  try {
    const doc = await pdfjs.getDocument({ data: bytes, isEvalSupported: false, useWorkerFetch: false }).promise;
    const pages: string[] = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      const lines: string[] = [];
      let lastY: number | null = null;
      let cur = '';
      for (const item of content.items as any[]) {
        if (typeof item.str !== 'string') continue;
        const y = item.transform ? Math.round(item.transform[5]) : null;
        if (lastY !== null && y !== null && Math.abs(y - lastY) > 2) {
          if (cur.trim()) lines.push(cur.trim());
          cur = item.str;
        } else {
          cur += item.str;
        }
        lastY = y;
      }
      if (cur.trim()) lines.push(cur.trim());
      pages.push(lines.join('\n'));
    }
    output = pages.join('\n\n');
  } finally {
    try {
      // 断开 TypedArray 扩展，防止 pdfjs 全局补丁影响后续请求
      Object.setPrototypeOf(TypedArray, TypedArray);
    } catch (_) { /* noop */ }
  }
  return output;
}

function looksLikeBinaryGarbage(text: string): boolean {
  if (!text) return true;
  const bad = (text.match(/\uFFFD/g) || []).length;
  return bad > text.length * 0.3;
}

/**
 * 图片魔数识别：文件头是这些字节就一定是图片，绝不可能是 pdf/docx/txt。
 * 老版本客户端可能把图片当文档传进来，文本管道若硬解（GBK 兜底会把二进制
 * 变成一堆伪中文），就会产出乱码"题目"，所以在这里直接拦掉。
 */
function detectImageMagic(bytes: Uint8Array): string | null {
  const b = (i: number) => bytes[i];
  if (bytes.length > 3 && b(0) === 0xff && b(1) === 0xd8 && b(2) === 0xff) return 'JPEG 图片';
  if (bytes.length > 7 && b(0) === 0x89 && b(1) === 0x50 && b(2) === 0x4e && b(3) === 0x47) return 'PNG 图片';
  if (bytes.length > 5 && b(0) === 0x47 && b(1) === 0x49 && b(2) === 0x46) return 'GIF 图片';
  if (bytes.length > 11 && b(0) === 0x52 && b(1) === 0x49 && b(2) === 0x46 && b(3) === 0x46 && b(8) === 0x57 && b(9) === 0x45 && b(10) === 0x42 && b(11) === 0x50) return 'WebP 图片';
  if (bytes.length > 1 && b(0) === 0x42 && b(1) === 0x4d) return 'BMP 图片';
  return null;
}

async function extractText(filename: string, mime: string, base64: string): Promise<string> {
  const bytes = decodeBase64(base64);
  if (bytes.byteLength === 0) throw new Error('文件内容为空');
  if (bytes.byteLength > MAX_FILE_BYTES) throw new Error('文件超过 4MB，请拆分后再导入');

  const imageMagic = detectImageMagic(bytes);
  if (imageMagic) {
    console.error(`[${functionName}] extract ${reqId} 收到图片文件被当作文档上传: ${imageMagic}`);
    throw new Error(`这是一张${imageMagic}，文本管道读不出图片里的题目。请回到导入页改用「拍照 / 相册识题」`);
  }

  const lower = (filename || '').toLowerCase();
  const isPdf = lower.endsWith('.pdf') || mime === 'application/pdf';
  const isDocx = lower.endsWith('.docx') || mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  const isDoc = lower.endsWith('.doc') || mime === 'application/msword';
  const isTxtLike = /\.(txt|md|csv|gift)$/.test(lower) || (mime || '').startsWith('text/');

  let text = '';
  if (isPdf) {
    text = await extractFromPdf(bytes);
  } else if (isDocx) {
    text = await extractFromDocx(bytes);
  } else if (isTxtLike) {
    text = await extractFromTxt(bytes);
  } else if (isDoc) {
    throw new Error('暂不支持旧版 .doc 格式，请在 Word 中另存为 .docx 后重试');
  } else {
    // 未知名扩展时按纯文本尝试
    text = await extractFromTxt(bytes);
    if (looksLikeBinaryGarbage(text)) throw new Error('无法识别该文件格式，支持 PDF / docx / txt / md');
  }

  if (looksLikeBinaryGarbage(text)) {
    throw new Error('该 PDF 疑似扫描图片型，提取不到文字，请使用文字版资料');
  }
  return text.trim();
}

/* ---------------- AI 出题 ---------------- */

const GEN_SYSTEM_PROMPT = `你是题库整理专家。用户会给你一份学习资料的片段文本，你的任务是把其中**可以用于练习的题目**整理成结构化 JSON。

规则：
1. 识别文本里的所有题目：选择题、判断题、填空题、简答题。没有题目的纯知识点文本，请基于知识点出 3-8 道典型练习题（选择/判断/简答）。
2. 严格按给定 JSON 格式输出，不要输出任何 JSON 以外的内容（不要 markdown 代码块标记）。
3. 字段说明：
   - type: "choice"（单选）| "tf"（判断）| "fill"（填空）| "short"（简答）
   - stem: 题干文本（去掉题号，保留完整语义；填空题用 ____ 表示空位）
   - options: 选择题选项字符串数组（如 ["A. xxx","B. xxx"]），非选择题给 []
   - answer: 正确答案。选择题填选项字母（如 "B"）；判断题填 "正确" 或 "错误"；填空题填答案文本（多个空用 ||| 分隔）；简答题填要点文本
   - answerBool: 判断题为 true/false，其他题型为 null
   - explanation: 简要解析（没有就给空字符串）
   - confidence: 0-1 的置信度，资料原文明确的题给 0.9+，推断出的题给 0.6-0.8
4. 忠实于原文，不要编造原文中不存在且无法推断的题目。
5. 选择题答案必须与选项字母对应；若原文给了答案行（如"答案：A"）必须采用。`;

function safeParseQuestions(raw: string): GenQuestion[] {
  let text = raw.trim();
  // 剥掉可能的 ```json 包裹
  if (text.startsWith('```')) {
    text = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  }
  // 截取第一个 { 或 [ 到最后一个 } 或 ]
  const start = Math.min(...['{', '['].map(c => { const i = text.indexOf(c); return i === -1 ? Infinity : i; }));
  const end = Math.max(text.lastIndexOf('}'), text.lastIndexOf(']'));
  if (start === Infinity || end === -1) throw new Error('AI 返回内容无法解析');
  text = text.slice(start, end + 1);

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (_) {
    // 宽松修复：去掉控制字符再试一次
    parsed = JSON.parse(text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, ''));
  }

  const arr = Array.isArray(parsed) ? parsed : (parsed as { questions?: unknown[] }).questions;
  if (!Array.isArray(arr)) throw new Error('AI 返回缺少 questions 数组');

  const out: GenQuestion[] = [];
  for (const q of arr as any[]) {
    if (!q || typeof q.stem !== 'string' || !q.stem.trim()) continue;
    const type = ['choice', 'tf', 'fill', 'short'].includes(q.type) ? q.type : 'choice';
    const options = Array.isArray(q.options)
      ? (q.options as unknown[]).map(o => String(o)).filter(s => s.trim())
      : [];
    const answer = typeof q.answer === 'string' ? q.answer : (q.answer === true ? '正确' : q.answer === false ? '错误' : '');
    const conf = typeof q.confidence === 'number' && q.confidence > 0 && q.confidence <= 1 ? q.confidence : 0.7;
    out.push({
      type,
      stem: q.stem.trim(),
      options,
      answer,
      answerBool: type === 'tf' ? (typeof q.answerBool === 'boolean' ? q.answerBool : answer.includes('错') || answer === 'F' ? false : true) : null,
      explanation: typeof q.explanation === 'string' ? q.explanation : '',
      confidence: Math.round(conf * 100) / 100,
    });
  }
  return out;
}

async function genQuestions(text: string, channel: unknown, token: string): Promise<GenQuestion[]> {
  if (!text.trim()) throw new Error('文本内容为空');
  // 单次只处理一个分片：分片由前端切分并逐片上报进度。
  // 网关有 60s 硬超时，因此分片必须小，且关闭思考模式以压缩推理耗时。
  const clipped = text.length > 1000 ? text.slice(0, 1000) : text;

  const target = aiTarget(channel, 'text');
  // 只有真正打到千问上游才扣额度；智谱不限次
  if (target.channel === 'qwen' && !(await consumeQwenCall(token))) throw new QuotaExceededError();
  const response = await fetch(target.url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${target.key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: target.model,
      messages: [
        { role: 'system', content: GEN_SYSTEM_PROMPT },
        { role: 'user', content: `请把下面的资料片段整理成题目 JSON：\n\n${clipped}` },
      ],
      temperature: 0.2,
      max_tokens: 2048,
      enable_thinking: false,
      stream: false,
    }),
  });

  if (!response.ok) {
    const errBody = await response.text();
    console.error(
      `[${functionName}] upstream ${reqId} channel=${target.channel} model=${target.model} status=${response.status}: ${errBody.slice(0, 300)}`,
    );
    if (response.status === 429) throw new Error('AI 模型繁忙，请稍后重试');
    throw new Error(`AI 服务异常（${response.status}）`);
  }

  const data = await response.json();
  const content: string = data?.choices?.[0]?.message?.content ?? '';
  if (!content) throw new Error('AI 返回为空');
  const questions = safeParseQuestions(content);
  if (questions.length === 0) throw new Error('AI 未识别到可用的题目');
  return questions;
}

/* ---------------- 图片识题（视觉模型） ---------------- */

const VISION_MODEL = 'qwen3-vl-plus';
/** base64 字符数上限，约等于 4.5MB 原图；端侧已压到 1MB 以内，这里只挡异常请求 */
const MAX_IMAGE_BASE64_CHARS = 6 * 1024 * 1024;

const VISION_SYSTEM_PROMPT = `你是题库整理专家，擅长从试卷照片、屏幕截图、打印或手写资料图片中识别题目。

规则：
1. 先把图片里**所有可以用于练习的题目**逐字看清，再整理成结构化 JSON。题号后面的题干、选项字母、答案标记、解析文字都要忠实还原。
2. 识别题型：选择题、判断题、填空题、简答题。图片里只有知识点没有题目时，基于知识点出 3-8 道典型练习题。
3. 严格按给定 JSON 格式输出，不要输出任何 JSON 以外的内容（不要 markdown 代码块标记、不要解释文字）。
4. 字段说明：
   - type: "choice"（单选）| "tf"（判断）| "fill"（填空）| "short"（简答）
   - stem: 题干文本（去掉题号，保留完整语义；填空题用 ____ 表示空位）
   - options: 选择题选项字符串数组（如 ["A. xxx","B. xxx"]），非选择题给 []
   - answer: 正确答案。选择题填选项字母（如 "B"）；判断题填 "正确" 或 "错误"；填空题填答案文本（多个空用 ||| 分隔）；简答题填要点文本。图片里印了答案就必须照抄；没印答案时你自己按学科知识作答补上。
   - answerBool: 判断题为 true/false，其他题型为 null
   - explanation: 简要解析（图片里有解析就照抄，没有就自己补一句关键思路）
   - confidence: 0-1 的置信度。图片清晰且答案明确给 0.9+；字迹模糊或答案靠推断给 0.6-0.8
5. 数学公式用纯文本线性写法（如 ∫x²dx、lim(x→0) sinx/x、d/dx、√(x²+1)），不要输出 LaTeX 反斜杠命令。
6. 只输出图片里真实存在的题目，不要编造；一张图里有几题就输出几题。`;

/** 上游强制流式（非流式识图耗时长会被网关 504），在函数内聚合完再一次性返回 JSON */
async function readStreamContent(response: Response): Promise<string> {
  if (!response.body) throw new Error('AI 识图服务未返回数据');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let full = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const payload = trimmed.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      try {
        const json = JSON.parse(payload);
        const delta = json?.choices?.[0]?.delta?.content;
        if (typeof delta === 'string') full += delta;
      } catch (_) {
        // 半截 JSON 行直接忽略，下一帧会补齐
      }
    }
  }
  return full;
}

async function visionQuestions(imageUrl: string, hint: string, channel: unknown, token: string): Promise<GenQuestion[]> {
  const userText = hint
    ? `请把这张图片里的题目整理成 JSON。（补充说明：${hint}）`
    : '请把这张图片里的题目整理成 JSON。';

  const target = aiTarget(channel, 'vision');
  // 只有真正打到千问上游才扣额度；智谱不限次
  if (target.channel === 'qwen' && !(await consumeQwenCall(token))) throw new QuotaExceededError();
  const response = await fetch(target.url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${target.key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: target.model,
      messages: [
        { role: 'system', content: VISION_SYSTEM_PROMPT },
        {
          role: 'user',
          content: [
            { type: 'text', text: userText },
            { type: 'image_url', image_url: { url: imageUrl } },
          ],
        },
      ],
      temperature: 0.2,
      max_tokens: 4096,
      enable_thinking: false,
      stream: true,
    }),
  });

  if (!response.ok) {
    const errBody = await response.text();
    console.error(
      `[${functionName}] vision upstream ${reqId} channel=${target.channel} model=${target.model} status=${response.status}: ${errBody.slice(0, 300)}`,
    );
    if (response.status === 429) throw new Error('AI 模型繁忙，请稍后重试');
    throw new Error(`AI 识图服务异常（${response.status}）`);
  }

  const content = await readStreamContent(response);
  if (!content.trim()) throw new Error('AI 识图返回为空');
  const questions = safeParseQuestions(content);
  if (questions.length === 0) throw new Error('AI 未能从图片中识别出题目');
  return questions;
}

/* ---------------- 识图异步任务 ---------------- */

/** 任务保留时长：超过就在下次建任务时顺手清掉，避免表无限增长 */
const VISION_JOB_TTL_HOURS = 2;

/** 带用户身份的 DB 客户端：quiz_vision_jobs 的 RLS 是 user_id = auth.uid() */
function userClient(token: string) {
  return createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${token}` } },
  });
}

/**
 * 响应返回后继续跑后台任务。
 * 优先用 EdgeRuntime.waitUntil（Deno 官方后台任务口子）；运行时没暴露时退化成游离 Promise——
 * 实测本平台响应返回后 isolate 不会被立刻杀掉，AI 调用仍能跑完并写回结果。
 */
function runInBackground(task: Promise<unknown>): void {
  const rt = (globalThis as { EdgeRuntime?: { waitUntil?: (p: Promise<unknown>) => void } }).EdgeRuntime;
  if (rt && typeof rt.waitUntil === 'function') {
    rt.waitUntil(task);
    console.info(`[${functionName}] background task registered via EdgeRuntime.waitUntil ${reqId}`);
    return;
  }
  console.info(`[${functionName}] EdgeRuntime.waitUntil 不可用，退化为游离 Promise ${reqId}`);
  task.catch((error) => console.error(`[${functionName}] background task failed ${reqId}:`, error));
}

/** 后台跑视觉模型，结果/失败原因写回任务行 */
async function runVisionJob(jobId: string, token: string, imageUrl: string, hint: string, channel: unknown): Promise<void> {
  const db = userClient(token);
  const t0 = Date.now();
  try {
    const questions = await visionQuestionsSafe(imageUrl, hint, channel, token);
    const { error } = await db
      .from('quiz_vision_jobs')
      .update({ status: 'done', questions: questions as unknown as Record<string, unknown>[], error: null })
      .eq('id', jobId);
    if (error) throw new Error(`写回识图结果失败：${error.message}`);
    console.info(`[${functionName}] vision job done ${reqId} job=${jobId} questions=${questions.length} durationMs=${Date.now() - t0}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[${functionName}] vision job failed ${reqId} job=${jobId} durationMs=${Date.now() - t0}: ${message}`);
    const { error } = await db.from('quiz_vision_jobs').update({ status: 'error', error: message }).eq('id', jobId);
    if (error) console.error(`[${functionName}] vision job write-back failed ${reqId}: ${error.message}`);
  }
}

/* ---------------- 入口 ---------------- */

Deno.serve(async (req) => {
  const started = Date.now();
  try {
    const auth = await requireAuth(req);
    if (!auth) return unauthorized();
    const { userId, token } = auth;
    console.info(`[${functionName}] auth ok ${reqId} user=${userId.slice(0, 8)}`);
    if (!AK && !ZHIPU_AK) {
      console.error(`[${functionName}] ${reqId} missing MEOO_PROJECT_API_KEY and ZHIPU_FREE_API_KEY`);
      return badRequest('AI 服务未配置');
    }
    const body = await req.json();
    const mode: string = body.mode || 'gen';
    const channel: unknown = body.channel;
    console.info(
      `[${functionName}] request ${reqId} mode=${mode} channel=${String(channel ?? 'qwen')} zhipuKey=${ZHIPU_AK ? 'set' : 'unset'}`,
    );

    if (mode === 'vision-start') {
      const rawUrl = typeof body.imageUrl === 'string' ? body.imageUrl.trim() : '';
      let imageUrl = rawUrl;
      if (!imageUrl) {
        const raw = typeof body.imageBase64 === 'string' ? body.imageBase64.trim() : '';
        const b64 = raw.replace(/^data:[^;,]+;base64,/, '');
        if (!b64) return badRequest('缺少图片内容');
        if (b64.length > MAX_IMAGE_BASE64_CHARS) return badRequest('图片过大，请压缩后再试');
        const mime = String(body.mime || 'image/jpeg');
        if (!/^image\//i.test(mime)) return badRequest('仅支持 jpg / png / webp 图片');
        imageUrl = `data:${mime};base64,${b64}`;
      }
      const hint = typeof body.hint === 'string' ? body.hint : '';

      const db = userClient(token);
      // 顺手清掉本用户的过期任务，避免表无限增长
      const cutoff = new Date(Date.now() - VISION_JOB_TTL_HOURS * 3600 * 1000).toISOString();
      const { error: purgeError } = await db.from('quiz_vision_jobs').delete().lt('created_at', cutoff);
      if (purgeError) console.error(`[${functionName}] vision job purge failed ${reqId}: ${purgeError.message}`);

      const jobId = crypto.randomUUID();
      const { error: insertError } = await db.from('quiz_vision_jobs').insert({
        id: jobId,
        user_id: userId,
        status: 'running',
        questions: [],
        error: null,
      });
      if (insertError) {
        console.error(`[${functionName}] vision job insert failed ${reqId}: ${insertError.message}`);
        return new Response(JSON.stringify({ error: '识图任务创建失败，请稍后重试' }), { status: 500, headers: jsonHeaders() });
      }

      console.info(`[${functionName}] vision start ${reqId} job=${jobId} source=${rawUrl ? 'url' : 'base64'} kb=${Math.round(imageUrl.length / 1024)}`);
      runInBackground(runVisionJob(jobId, token, imageUrl, hint, channel));
      return new Response(JSON.stringify({ jobId }), { headers: jsonHeaders() });
    }

    if (mode === 'vision-status') {
      const jobId = typeof body.jobId === 'string' ? body.jobId.trim() : '';
      if (!jobId) return badRequest('缺少任务编号');
      const db = userClient(token);
      const { data: row, error } = await db
        .from('quiz_vision_jobs')
        .select('id,status,questions,error')
        .eq('id', jobId)
        .maybeSingle();
      if (error) {
        console.error(`[${functionName}] vision status query failed ${reqId} job=${jobId}: ${error.message}`);
        return new Response(JSON.stringify({ error: '查询识图进度失败，请重试' }), { status: 500, headers: jsonHeaders() });
      }
      if (!row) {
        console.error(`[${functionName}] vision status missing ${reqId} job=${jobId}`);
        return new Response(JSON.stringify({ error: '识图任务不存在或已过期，请重新识别' }), { status: 404, headers: jsonHeaders() });
      }
      // 结果不在这里删：客户端可能因网络抖动没收到，删了就再也取不回来；过期清理交给 vision-start
      if (row.status === 'done') {
        const questions = Array.isArray(row.questions) ? row.questions : [];
        console.info(`[${functionName}] vision status ${reqId} job=${jobId} done questions=${questions.length}`);
        return new Response(JSON.stringify({ status: 'done', questions }), { headers: jsonHeaders() });
      }
      if (row.status === 'error') {
        console.info(`[${functionName}] vision status ${reqId} job=${jobId} error=${row.error}`);
        return new Response(JSON.stringify({ status: 'error', error: row.error || 'AI 识图失败，请重试' }), { headers: jsonHeaders() });
      }
      return new Response(JSON.stringify({ status: 'running' }), { headers: jsonHeaders() });
    }

    let text = '';
    if (mode === 'extract' || mode === 'parse') {
      const { filename, mime, base64 } = body;
      if (typeof base64 !== 'string' || !base64) return badRequest('缺少文件内容');
      const t0 = Date.now();
      text = await extractText(String(filename || ''), String(mime || ''), base64);
      console.info(`[${functionName}] extract ${reqId} file=${String(filename || '').slice(0, 50)} chars=${text.length} durationMs=${Date.now() - t0}`);
      if (mode === 'extract') {
        return new Response(JSON.stringify({ text }), { headers: jsonHeaders() });
      }
    } else {
      text = typeof body.text === 'string' ? body.text : '';
    }

    const hint: string = typeof body.hint === 'string' ? body.hint : '';
    const questions = await genQuestionsSafe(hint ? `${text}\n\n（补充说明：${hint}）` : text, channel, token);
    console.info(`[${functionName}] done ${reqId} questions=${questions.length} durationMs=${Date.now() - started}`);
    return new Response(JSON.stringify({ questions }), { headers: jsonHeaders() });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[${functionName}] failed ${reqId}: ${message}`);
    if (error instanceof QuotaExceededError) {
      // 额度用完单独给 code + 429，端侧据此提示「换模型一 / 明天再来」
      return new Response(JSON.stringify({ error: message, code: 'qwen_quota_exceeded' }), { status: 429, headers: jsonHeaders() });
    }
    return new Response(JSON.stringify({ error: message }), { status: 500, headers: jsonHeaders() });
  }
});
