/**
 * ai-relay：统一 AI 网关
 *
 * 让 App 里配置的任意供应商走同一套调用方式：
 *  - provider 为空或 kind = "builtin" → 使用平台内置免费模型（Meoo AI / qwen3.6-plus）
 *  - provider 为自定义 → 按域名自动区分 OpenAI 兼容 / Anthropic / Gemini 协议
 *
 * 输入（JSON）：
 *  {
 *    action: "chat" | "test",
 *    provider?: { kind, base_url, api_key, model, protocol? },
 *    system?: string,
 *    user?: string,
 *    messages?: [{ role, content }],
 *    json?: boolean, max_tokens?: number, temperature?: number
 *  }
 * 输出：
 *  chat → { content, model, protocol }
 *  test → { ok, latencyMs, sample, model, protocol, error? }
 *
 * 安全：只做受限转发。强制 https、拒绝内网/元数据地址；不落库、不缓存任何 Key，
 * 用户 API Key 仅在本次请求内用于转发，日志只记录脱敏摘要。
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const functionName = 'ai-relay';
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
const MEOO_AI_BASE_URL = 'https://api.meoo.host';
const MEOO_CHAT_PATH = '/meoo-ai/compatible-mode/v1/chat/completions';
const BUILTIN_MODEL = 'qwen3.6-plus';
const AK = Deno.env.get('MEOO_PROJECT_API_KEY') || '';
/**
 * 内置「模型一」= 智谱 GLM 免费模型。
 * Key 只存在云函数密钥 ZHIPU_FREE_API_KEY 里，绝不下发到前端、不写库、不进日志。
 */
const ZHIPU_CHAT_URL = 'https://open.bigmodel.cn/api/paas/v4/chat/completions';
const ZHIPU_TEXT_MODEL = 'glm-4.7-flash';
const ZHIPU_AK = Deno.env.get('ZHIPU_FREE_API_KEY') || '';
const MAX_TIMEOUT_MS = 55000;

type Protocol = 'openai' | 'anthropic' | 'gemini';

interface Provider {
  kind?: 'builtin' | 'custom';
  /** 内置通道档位：'zhipu' = 模型一，'qwen'/缺省 = 模型二 */
  channel?: 'zhipu' | 'qwen';
  base_url?: string;
  api_key?: string;
  model?: string;
  protocol?: Protocol;
}

interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

function jsonHeaders(): Record<string, string> {
  return { 'Content-Type': 'application/json' };
}

function fail(message: string, status = 400): Response {
  return new Response(JSON.stringify({ error: message }), { status, headers: jsonHeaders() });
}

/**
 * 登录态校验：拿请求里的 access_token 去 Auth 服务换真实用户。
 * 匿名密钥（anon key）不是合法的用户 token，换不到任何身份 → 返回 null → 401。
 * 网关的 verify_jwt 只验签名，光靠它挡不住持有安装包内匿名密钥的人，必须在这里二次校验。
 */
async function requireAuth(req: Request): Promise<{ userId: string; token: string } | null> {
  const header = req.headers.get('Authorization') ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!token || !SUPABASE_URL || !SUPABASE_ANON_KEY) return null;
  try {
    const probe = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
    const { data, error } = await probe.auth.getUser(token);
    if (error || !data.user) return null;
    return { userId: data.user.id, token };
  } catch (_) {
    return null;
  }
}

function unauthorized(): Response {
  return new Response(JSON.stringify({ error: '请先登录后再使用此功能' }), { status: 401, headers: jsonHeaders() });
}

function maskKey(key: string): string {
  if (!key) return '(empty)';
  if (key.length <= 8) return '****';
  return `${key.slice(0, 4)}****${key.slice(-4)}`;
}

/* ---------------- 内置「模型二 · 千问」每人每天额度 ---------------- */

/** 每人每天最多打到千问上游的次数；智谱「模型一」不计数 */
const QWEN_DAILY_LIMIT = 2;

/** 额度用完：单独一个错误类型，好让端侧给出「换模型一 / 明天再来」的准确提示 */
class QuotaExceededError extends Error {
  constructor() {
    super(`模型二（千问）今日 ${QWEN_DAILY_LIMIT} 次免费额度已用完，请改用模型一（智谱）重试，或明天 00:00 后再来`);
    this.name = 'QuotaExceededError';
  }
}

/**
 * 原子「检查 + 扣一次」。计数放在数据库而不是端侧，改客户端也绕不过去。
 * 自然日按东八区算，次日 00:00 自动是新的一行。
 */
async function consumeQwenCall(token: string): Promise<{ allowed: boolean; remaining: number }> {
  if (!token || !SUPABASE_URL || !SUPABASE_ANON_KEY) return { allowed: true, remaining: QWEN_DAILY_LIMIT };
  try {
    const db = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { global: { headers: { Authorization: `Bearer ${token}` } } });
    const { data, error } = await db.rpc('consume_qwen_quota', { p_limit: QWEN_DAILY_LIMIT });
    if (error) throw error;
    const row = (Array.isArray(data) ? data[0] : data) as { allowed?: boolean; remaining?: number } | undefined;
    return { allowed: row?.allowed === true, remaining: Number(row?.remaining ?? 0) };
  } catch (error) {
    // 计数表读不到时放行：额度是省成本的软限制，不该因为库抖动把 AI 整个弄挂
    console.error(`[${functionName}] consume_qwen_quota failed, allow by default:`, (error as Error).message);
    return { allowed: true, remaining: QWEN_DAILY_LIMIT };
  }
}

/* ---------------- 地址安全校验（防开放代理 / SSRF） ---------------- */

const BLOCKED_HOSTS = new Set([
  'localhost',
  'metadata.google.internal',
  'metadata.goog',
  'kubernetes.default.svc',
]);

function assertSafeUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch (_) {
    throw new Error('接口地址不是合法 URL');
  }
  if (url.protocol !== 'https:') throw new Error('仅支持 https 接口地址');
  const host = url.hostname.toLowerCase();
  if (BLOCKED_HOSTS.has(host)) throw new Error('不允许访问该地址');
  if (host === '::1' || host.startsWith('127.') || host.startsWith('10.') || host.startsWith('192.168.') || host.startsWith('169.254.')) {
    throw new Error('不允许访问内网地址');
  }
  // 172.16.0.0/12
  if (host.startsWith('172.')) {
    const second = Number(host.split('.')[1]);
    if (second >= 16 && second <= 31) throw new Error('不允许访问内网地址');
  }
  return url;
}

function detectProtocol(base: string, hint?: Protocol): Protocol {
  if (hint === 'openai' || hint === 'anthropic' || hint === 'gemini') return hint;
  const host = base.toLowerCase();
  if (host.includes('anthropic.com')) return 'anthropic';
  if (host.includes('generativelanguage.googleapis.com') || host.includes('gemini.google')) return 'gemini';
  return 'openai';
}

function trimBase(base: string): string {
  return base.replace(/\/+$/, '');
}

function openaiEndpoint(base: string): string {
  const b = trimBase(base);
  const withVersion = /\/v\d+[^/]*$/.test(b) ? b : `${b}/v1`;
  return `${withVersion}/chat/completions`;
}

function anthropicEndpoint(base: string): string {
  const b = trimBase(base).replace(/\/v1$/, '');
  return `${b}/v1/messages`;
}

function geminiEndpoint(base: string, model: string, key: string): string {
  const b = trimBase(base).replace(/\/v1beta$/, '').replace(/\/v1alpha$/, '');
  const version = /\/v1beta|\/v1alpha/.test(trimBase(base)) ? '' : '/v1beta';
  return `${b}${version}/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(key)}`;
}

/* ---------------- 三种协议的请求构造 ---------------- */

interface BuiltRequest {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
  parse: (json: any) => string;
}

function buildOpenai(url: string, key: string, model: string, messages: ChatMessage[], opts: ReqOpts): BuiltRequest {
  const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n');
  const rest = messages.filter((m) => m.role !== 'system');
  const body: Record<string, unknown> = {
    model,
    messages: [...(system ? [{ role: 'system', content: system }] : []), ...rest],
    temperature: opts.temperature ?? 0.2,
    max_tokens: opts.maxTokens ?? 1024,
    stream: false,
  };
  if (opts.json) body.response_format = { type: 'json_object' };
  // 关闭思考模式可显著降低时延（不支持该参数的网关会忽略）
  body.enable_thinking = false;
  return {
    url,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body,
    parse: (json) => String(json?.choices?.[0]?.message?.content ?? ''),
  };
}

function buildAnthropic(url: string, key: string, model: string, messages: ChatMessage[], opts: ReqOpts): BuiltRequest {
  const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n');
  const rest = messages.filter((m) => m.role !== 'system');
  const body: Record<string, unknown> = {
    model,
    max_tokens: opts.maxTokens ?? 1024,
    temperature: opts.temperature ?? 0.2,
    messages: rest.map((m) => ({ role: m.role, content: m.content })),
  };
  if (system) body.system = system;
  return {
    url,
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
    },
    body,
    parse: (json) => {
      const parts = Array.isArray(json?.content) ? json.content : [];
      return parts.map((p: any) => (typeof p?.text === 'string' ? p.text : '')).join('').trim();
    },
  };
}

function buildGemini(url: string, model: string, messages: ChatMessage[], opts: ReqOpts): BuiltRequest {
  const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n');
  const rest = messages.filter((m) => m.role !== 'system');
  const body: Record<string, unknown> = {
    contents: rest.map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] })),
    generationConfig: {
      temperature: opts.temperature ?? 0.2,
      maxOutputTokens: opts.maxTokens ?? 1024,
      ...(opts.json ? { responseMimeType: 'application/json' } : {}),
    },
  };
  if (system) body.systemInstruction = { parts: [{ text: system }] };
  return {
    url,
    headers: { 'Content-Type': 'application/json' },
    body,
    parse: (json) => {
      const parts = json?.candidates?.[0]?.content?.parts;
      return Array.isArray(parts) ? parts.map((p: any) => String(p?.text ?? '')).join('').trim() : '';
    },
  };
}

interface ReqOpts {
  json?: boolean;
  maxTokens?: number;
  temperature?: number;
}

/* ---------------- 统一调用 ---------------- */

async function callModel(provider: Provider | undefined, messages: ChatMessage[], opts: ReqOpts, token: string) {
  const isBuiltin = !provider || provider.kind !== 'custom';
  if (isBuiltin) {
    const wantZhipu = provider?.channel === 'zhipu';
    // 智谱密钥没配好时不能直接失败：退回千问通道，保证内置功能始终可用
    const useZhipu = wantZhipu && Boolean(ZHIPU_AK);
    if (wantZhipu && !ZHIPU_AK) {
      console.error(`[${functionName}] builtin ZHIPU_FREE_API_KEY 未配置，本次退回千问通道`);
    }
    if (!useZhipu && !AK) throw new Error('内置 AI 未配置');
    const requested = String(provider?.model ?? '').trim();
    // 档位与模型号错配时以档位为准，避免把 glm 模型号发给千问网关（反之亦然）
    const model = useZhipu
      ? requested.includes('glm')
        ? requested
        : ZHIPU_TEXT_MODEL
      : requested.includes('glm') || !requested
        ? BUILTIN_MODEL
        : requested;
    // 只有真正打到千问上游才扣额度；智谱不限次，用户可以一直重试碰运气
    let qwenRemaining: number | null = null;
    if (!useZhipu) {
      const quota = await consumeQwenCall(token);
      if (!quota.allowed) throw new QuotaExceededError();
      qwenRemaining = quota.remaining;
    }
    const built = buildOpenai(
      useZhipu ? ZHIPU_CHAT_URL : `${MEOO_AI_BASE_URL}${MEOO_CHAT_PATH}`,
      useZhipu ? ZHIPU_AK : AK,
      model,
      messages,
      opts,
    );
    const reqId = crypto.randomUUID().slice(0, 8);
    const started = Date.now();
    const response = await fetchWithTimeout(built.url, built.headers, built.body);
    const text = await response.text();
    if (!response.ok) {
      console.error(
        `[${functionName}] builtin upstream ${reqId} channel=${useZhipu ? 'zhipu' : 'qwen'} model=${model} status=${response.status}: ${text.slice(0, 300)}`,
      );
      throw new Error(response.status === 429 ? 'AI 模型繁忙，请稍后重试' : `内置 AI 异常（${response.status}）`);
    }
    const content = built.parse(JSON.parse(text));
    console.info(
      `[${functionName}] builtin ok ${reqId} channel=${useZhipu ? 'zhipu' : 'qwen'} model=${model} chars=${content.length} qwenLeft=${qwenRemaining ?? '-'} durationMs=${Date.now() - started}`,
    );
    return { content, model, protocol: 'openai' as Protocol, qwenRemaining, fellBack: false };
  }

  const base = String(provider?.base_url ?? '').trim();
  const key = String(provider?.api_key ?? '').trim();
  const model = String(provider?.model ?? '').trim();
  if (!base) throw new Error('请填写接口地址');
  if (!model) throw new Error('请填写模型编号');
  assertSafeUrl(base);
  if (!key) throw new Error('请填写 API Key');

  const protocol = detectProtocol(base, provider?.protocol);
  let built: BuiltRequest;
  if (protocol === 'anthropic') {
    built = buildAnthropic(anthropicEndpoint(base), key, model, messages, opts);
  } else if (protocol === 'gemini') {
    built = buildGemini(geminiEndpoint(base, model, key), model, messages, opts);
  } else {
    built = buildOpenai(openaiEndpoint(base), key, model, messages, opts);
  }

  const reqId = crypto.randomUUID().slice(0, 8);
  const started = Date.now();
  console.info(`[${functionName}] relay ${reqId} protocol=${protocol} model=${model} key=${maskKey(key)}`);
  const response = await fetchWithTimeout(built.url, built.headers, built.body);
  const text = await response.text();
  if (!response.ok) {
    console.error(`[${functionName}] upstream ${reqId} status=${response.status}: ${text.slice(0, 300)}`);
    const hint =
      response.status === 401 || response.status === 403
        ? '鉴权失败：API Key 无效或没有该模型权限'
        : response.status === 404
          ? '模型或地址不存在：检查模型编号与接口地址'
          : response.status === 429
            ? '触发供应商限流（429），稍后重试'
            : `供应商返回 ${response.status}`;
    throw new Error(hint);
  }
  let json: any;
  try {
    json = JSON.parse(text);
  } catch (_) {
    throw new Error('供应商返回的不是 JSON');
  }
  const content = built.parse(json);
  if (!content) throw new Error('供应商返回内容为空，可能模型编号不对');
  console.info(`[${functionName}] relay ok ${reqId} chars=${content.length} durationMs=${Date.now() - started}`);
  return { content, model, protocol, qwenRemaining: null as number | null, fellBack: false };
}

/**
 * 内置「模型一」智谱免费模型实测会被限流（code 1305 / HTTP 429），失败时补一次「模型二」千问。
 * 这一次会消耗千问的每日额度，所以日志与响应都要标出 fallback，端侧据此提示用户。
 * 网关有 60s 硬超时：只有「失败得很快」才重试，慢失败直接抛错，否则两次叠加必然整体超时。
 */
async function callModelWithFallback(provider: Provider | undefined, messages: ChatMessage[], opts: ReqOpts, token: string) {
  const canFallback = (!provider || provider.kind !== 'custom') && provider?.channel === 'zhipu' && Boolean(ZHIPU_AK) && Boolean(AK);
  if (!canFallback) return callModel(provider, messages, opts, token);
  const tag = crypto.randomUUID().slice(0, 8);
  const started = Date.now();
  try {
    return await callModel(provider, messages, opts, token);
  } catch (error) {
    if (error instanceof QuotaExceededError) throw error;
    const elapsed = Date.now() - started;
    const message = error instanceof Error ? error.message : String(error);
    if (elapsed > 15000) {
      console.error(`[${functionName}] zhipu slow fail ${tag} elapsedMs=${elapsed}, skip fallback: ${message}`);
      throw error;
    }
    console.error(`[${functionName}] zhipu failed ${tag} elapsedMs=${elapsed}, fallback=qwen: ${message}`);
    const r = await callModel({ ...provider, channel: 'qwen' }, messages, opts, token);
    return { ...r, fellBack: true };
  }
}

async function fetchWithTimeout(url: string, headers: Record<string, string>, body: Record<string, unknown>): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), MAX_TIMEOUT_MS);
  try {
    return await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/* ---------------- 入口 ---------------- */

Deno.serve(async (req) => {
  const reqId = crypto.randomUUID().slice(0, 8);
  try {
    const auth = await requireAuth(req);
    if (!auth) return unauthorized();
    const { userId, token } = auth;
    console.info(`[${functionName}] auth ok ${reqId} user=${userId.slice(0, 8)}`);
    const body = await req.json();
    const action: string = typeof body.action === 'string' ? body.action : 'chat';
    const provider: Provider | undefined = body.provider && typeof body.provider === 'object' ? body.provider : undefined;

    let messages: ChatMessage[] = [];
    if (Array.isArray(body.messages)) {
      messages = (body.messages as any[])
        .filter((m) => m && typeof m.content === 'string')
        .map((m) => ({ role: m.role === 'assistant' ? 'assistant' : m.role === 'system' ? 'system' : 'user', content: String(m.content) }));
    }
    if (typeof body.system === 'string' && body.system) messages = [{ role: 'system', content: body.system }, ...messages];
    if (typeof body.user === 'string' && body.user) messages = [...messages, { role: 'user', content: body.user }];
    if (messages.length === 0 && action !== 'test') return fail('缺少提示词内容');

    const opts: ReqOpts = {
      json: body.json === true,
      maxTokens: typeof body.max_tokens === 'number' ? Math.min(body.max_tokens, 4096) : undefined,
      temperature: typeof body.temperature === 'number' ? body.temperature : undefined,
    };

    if (action === 'test') {
      const started = Date.now();
      try {
        const r = await callModelWithFallback(provider, [{ role: 'user', content: '只回复两个字：可用' }], { maxTokens: 16, temperature: 0 }, token);
        return new Response(
          JSON.stringify({
            ok: true,
            latencyMs: Date.now() - started,
            sample: r.content.slice(0, 40),
            model: r.model,
            protocol: r.protocol,
            fellBack: r.fellBack,
            qwenRemaining: r.qwenRemaining,
          }),
          { headers: jsonHeaders() },
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const code = error instanceof QuotaExceededError ? 'qwen_quota_exceeded' : undefined;
        return new Response(
          JSON.stringify({ ok: false, error: message, code, latencyMs: Date.now() - started, model: provider?.model ?? BUILTIN_MODEL }),
          { headers: jsonHeaders() },
        );
      }
    }

    const r = await callModelWithFallback(provider, messages, opts, token);
    return new Response(
      JSON.stringify({
        content: r.content,
        model: r.model,
        protocol: r.protocol,
        fellBack: r.fellBack,
        qwenRemaining: r.qwenRemaining,
      }),
      { headers: jsonHeaders() },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[${functionName}] failed ${reqId}: ${message}`);
    if (error instanceof QuotaExceededError) {
      // 额度用完单独给一个 code，端侧据此提示「换模型一 / 明天再来」，而不是笼统的网关异常
      return new Response(JSON.stringify({ error: message, code: 'qwen_quota_exceeded' }), { status: 429, headers: jsonHeaders() });
    }
    return fail(message, 500);
  }
});
