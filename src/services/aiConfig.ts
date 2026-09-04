/**
 * AI 供应商配置（存本机 SecureStore，绝不写进云数据库）
 *
 * - 内置供应商：平台自带免费模型，无需任何 Key，开箱可用
 * - 自定义供应商：DeepSeek / OpenAI / 智谱 / 通义 / Kimi / 豆包 / Gemini / Claude / MiniMax / MiMo / 自定义
 * - 协议按域名自动区分：anthropic.com → Anthropic /v1/messages；googleapis → Gemini；其余按 OpenAI 兼容
 */
import { useCallback, useEffect, useState } from 'react';
import * as Network from 'expo-network';
import * as SecureStore from 'expo-secure-store';

export type AiProtocol = 'openai' | 'anthropic' | 'gemini';
export type AiCapability = 'text' | 'vision' | 'both';

/**
 * 内置免费通道：
 *  - 'zhipu' = 模型一（智谱 GLM 免费模型，Key 由云函数保管，不消耗平台账号额度）
 *  - 'qwen'  = 模型二（通义千问，走平台 Meoo AI 网关，消耗平台账号额度）
 */
export type BuiltinChannel = 'zhipu' | 'qwen';

export interface BuiltinChannelInfo {
  id: BuiltinChannel;
  /** 界面上的序号名 */
  name: string;
  label: string;
  textModel: string;
  visionModel: string;
  desc: string;
}

export const BUILTIN_CHANNELS: BuiltinChannelInfo[] = [
  {
    id: 'zhipu',
    name: '模型一',
    label: '智谱 GLM',
    textModel: 'glm-4.7-flash',
    visionModel: 'glm-4.6v-flash',
    desc: '免费额度独立，识图走 glm-4.6v-flash，优先推荐',
  },
  {
    id: 'qwen',
    name: '模型二',
    label: '通义千问',
    textModel: 'qwen3.6-plus',
    visionModel: 'qwen3-vl-plus',
    desc: '平台网关内置，会消耗平台账号额度',
  },
];

export function findBuiltinChannel(id: string | undefined): BuiltinChannelInfo {
  return BUILTIN_CHANNELS.find((item) => item.id === id) ?? BUILTIN_CHANNELS[0];
}

export interface AiConfig {
  /** 内置为 'builtin'，其余取预设 id 或 'custom' */
  providerId: string;
  label: string;
  baseUrl: string;
  apiKey: string;
  /** 文字模型 */
  model: string;
  /** 视觉模型（仅文字模型时留空） */
  visionModel: string;
  capability: AiCapability;
  /** auto = 按域名与预设自动推导；manual = 用户手填 */
  protocolMode: 'auto' | 'manual';
  protocol: AiProtocol;
  /** true = 走内置免费模型；false = 走下面填写的供应商 */
  useBuiltin: boolean;
  /** 内置免费模型选哪一档，见 BUILTIN_CHANNELS */
  builtinChannel: BuiltinChannel;
  /** 模型号是否自动带出 */
  autoModel: boolean;
  lastTest: { ok: boolean; at: number; latencyMs?: number; error?: string } | null;
}

export interface ProviderPreset {
  id: string;
  label: string;
  baseUrl: string;
  protocol: AiProtocol;
  capability: AiCapability;
  textModels: string[];
  visionModels: string[];
  /** 取 Key 的入口说明（不放可点链接，避免过时） */
  keyHint: string;
  /** 模型号必须由用户从控制台复制（如豆包是推理接入点 ID） */
  manualModelOnly?: boolean;
}

export const PRESETS: ProviderPreset[] = [
  {
    id: 'builtin',
    label: '平台内置（免费）',
    baseUrl: '',
    protocol: 'openai',
    capability: 'both',
    textModels: ['glm-4.7-flash', 'qwen3.6-plus'],
    visionModels: ['glm-4.6v-flash', 'qwen3-vl-plus'],
    keyHint: '无需 API Key，开箱可用；下面可切换「模型一 智谱 / 模型二 千问」，联网时走它，断网自动退回本地解析',
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com',
    protocol: 'openai',
    capability: 'text',
    textModels: ['deepseek-chat'],
    visionModels: [],
    keyHint: '在 DeepSeek 开放平台的 API Keys 页面创建',
  },
  {
    id: 'openai',
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    protocol: 'openai',
    capability: 'both',
    textModels: ['gpt-4o-mini', 'gpt-4.1-mini'],
    visionModels: ['gpt-4o'],
    keyHint: '在 platform.openai.com 的 API keys 中创建',
  },
  {
    id: 'zhipu',
    label: '智谱 GLM',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    protocol: 'openai',
    capability: 'both',
    textModels: ['glm-4.7-flash', 'glm-4-plus'],
    visionModels: ['glm-4.6v-flash', 'glm-4v-plus'],
    keyHint: '在智谱开放平台「API Key 管理」创建；flash 系列有免费额度',
  },
  {
    id: 'qwen',
    label: '通义千问',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    protocol: 'openai',
    capability: 'both',
    textModels: ['qwen-plus', 'qwen-turbo'],
    visionModels: ['qwen-vl-plus'],
    keyHint: '在阿里云百炼控制台创建 API Key',
  },
  {
    id: 'kimi',
    label: '月之暗面 Kimi',
    baseUrl: 'https://api.moonshot.cn/v1',
    protocol: 'openai',
    capability: 'text',
    textModels: ['kimi-k2-0905-preview', 'moonshot-v1-8k'],
    visionModels: [],
    keyHint: '在 platform.moonshot.cn 的 API 密钥页创建',
  },
  {
    id: 'doubao',
    label: '豆包（火山方舟）',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    protocol: 'openai',
    capability: 'both',
    textModels: [],
    visionModels: [],
    keyHint: '在火山方舟创建推理接入点后，把接入点 ID（ep-xxx）填进模型号',
    manualModelOnly: true,
  },
  {
    id: 'gemini',
    label: 'Gemini',
    baseUrl: 'https://generativelanguage.googleapis.com',
    protocol: 'gemini',
    capability: 'both',
    textModels: ['gemini-2.5-flash'],
    visionModels: ['gemini-2.5-flash'],
    keyHint: '在 Google AI Studio 创建 API Key',
  },
  {
    id: 'claude',
    label: 'Claude',
    baseUrl: 'https://api.anthropic.com',
    protocol: 'anthropic',
    capability: 'both',
    textModels: ['claude-sonnet-4-5'],
    visionModels: ['claude-sonnet-4-5'],
    keyHint: '在 console.anthropic.com 创建 API Key（自动走 /v1/messages 协议）',
  },
  {
    id: 'minimax',
    label: 'MiniMax',
    baseUrl: 'https://api.minimaxi.com/v1',
    protocol: 'openai',
    capability: 'text',
    textModels: ['MiniMax-M2.5'],
    visionModels: [],
    keyHint: '在 MiniMax 开放平台创建 API Key',
  },
  {
    id: 'mimo',
    label: 'MiMo',
    baseUrl: '',
    protocol: 'openai',
    capability: 'both',
    textModels: [],
    visionModels: [],
    keyHint: 'MiMo 需按官方文档填写接口地址与模型号（本预设不预置地址）',
    manualModelOnly: true,
  },
  {
    id: 'grok',
    label: 'Grok（xAI）',
    baseUrl: 'https://api.x.ai/v1',
    protocol: 'openai',
    capability: 'both',
    textModels: ['grok-4.3', 'grok-4-fast'],
    visionModels: ['grok-4.3'],
    keyHint: '在 console.x.ai 创建 API Key；接口兼容 OpenAI /chat/completions',
  },
  {
    id: 'custom',
    label: '自定义',
    baseUrl: '',
    protocol: 'openai',
    capability: 'text',
    textModels: [],
    visionModels: [],
    keyHint: '任何 OpenAI 兼容 /v1/chat/completions 网关都可接入',
    manualModelOnly: true,
  },
];

export function findPreset(id: string): ProviderPreset {
  return PRESETS.find((p) => p.id === id) ?? PRESETS[0];
}

export function detectProtocol(baseUrl: string): AiProtocol {
  const host = (baseUrl || '').toLowerCase();
  if (host.includes('anthropic.com')) return 'anthropic';
  if (host.includes('generativelanguage.googleapis.com')) return 'gemini';
  return 'openai';
}

export function normalizeBaseUrl(value: string): string {
  return String(value || '').trim().replace(/\s+/g, '').replace(/\/+$/, '');
}

export function protocolLabel(p: AiProtocol): string {
  if (p === 'anthropic') return 'Anthropic /v1/messages';
  if (p === 'gemini') return 'Gemini generateContent';
  return 'OpenAI 兼容 /chat/completions';
}

export const BUILTIN_CONFIG: AiConfig = {
  providerId: 'builtin',
  label: '平台内置（免费）',
  baseUrl: '',
  apiKey: '',
  model: 'glm-4.7-flash',
  visionModel: 'glm-4.6v-flash',
  capability: 'both',
  protocolMode: 'auto',
  protocol: 'openai',
  useBuiltin: true,
  builtinChannel: 'zhipu',
  autoModel: true,
  lastTest: null,
};

const STORAGE_KEY = 'quiz_ai_config';

let cached: AiConfig = BUILTIN_CONFIG;
const listeners = new Set<() => void>();

function notify(): void {
  listeners.forEach((fn) => fn());
}

export function subscribeAiConfig(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function getCachedAiConfig(): AiConfig {
  return cached;
}

function sanitize(raw: Partial<AiConfig> | null): AiConfig {
  if (!raw || typeof raw !== 'object') return BUILTIN_CONFIG;
  const merged: AiConfig = { ...BUILTIN_CONFIG, ...raw };
  merged.baseUrl = normalizeBaseUrl(merged.baseUrl);
  if (merged.useBuiltin) {
    // 内置通道的模型号只由档位决定，避免老配置里残留「千问模型 + 智谱档位」这种错配
    const ch = findBuiltinChannel(merged.builtinChannel);
    merged.builtinChannel = ch.id;
    merged.model = ch.textModel;
    merged.visionModel = ch.visionModel;
    merged.capability = 'both';
    merged.protocol = 'openai';
  } else {
    merged.builtinChannel = findBuiltinChannel(merged.builtinChannel).id;
    merged.protocol = merged.protocolMode === 'manual' ? merged.protocol : detectProtocol(merged.baseUrl);
  }
  return merged;
}

export function applyPreset(cfg: AiConfig, presetId: string): AiConfig {
  const preset = findPreset(presetId);
  const builtin = preset.id === 'builtin';
  return sanitize({
    ...cfg,
    providerId: preset.id,
    label: preset.label,
    useBuiltin: builtin,
    baseUrl: preset.baseUrl,
    apiKey: builtin ? '' : cfg.providerId === preset.id ? cfg.apiKey : '',
    capability: preset.capability,
    protocolMode: 'auto',
    protocol: preset.protocol,
    autoModel: !preset.manualModelOnly,
    model: builtin ? findBuiltinChannel(cfg.builtinChannel).textModel : (preset.textModels[0] ?? ''),
    visionModel: builtin ? findBuiltinChannel(cfg.builtinChannel).visionModel : (preset.visionModels[0] ?? ''),
    lastTest: null,
  });
}

export async function loadAiConfig(): Promise<AiConfig> {
  try {
    const raw = await SecureStore.getItemAsync(STORAGE_KEY);
    if (!raw) {
      cached = BUILTIN_CONFIG;
      notify();
      return cached;
    }
    cached = sanitize(JSON.parse(raw) as Partial<AiConfig>);
    notify();
    return cached;
  } catch (error) {
    console.error('[aiConfig] 读取失败，回退内置供应商:', error);
    cached = BUILTIN_CONFIG;
    notify();
    return cached;
  }
}

export async function saveAiConfig(cfg: AiConfig): Promise<void> {
  cached = sanitize(cfg);
  notify();
  try {
    await SecureStore.setItemAsync(STORAGE_KEY, JSON.stringify(cached));
  } catch (error) {
    console.error('[aiConfig] 保存失败（仅本次运行内生效）:', error);
    throw new Error('本机安全存储不可用，配置只在今次运行内生效');
  }
}

export async function resetAiConfig(): Promise<void> {
  cached = BUILTIN_CONFIG;
  notify();
  try {
    await SecureStore.deleteItemAsync(STORAGE_KEY);
  } catch (error) {
    console.error('[aiConfig] 清除失败:', error);
  }
}

/* ---------------- 在线状态 ---------------- */

export async function checkOnline(): Promise<boolean> {
  try {
    const state = await Network.getNetworkStateAsync();
    return Boolean(state.isConnected && state.isInternetReachable !== false);
  } catch (error) {
    console.error('[aiConfig] 网络状态获取失败，按离线处理:', error);
    return false;
  }
}

export interface AiStatus {
  cfg: AiConfig;
  online: boolean;
  /** 顶格胶囊文案 */
  label: string;
  sub: string;
  /** 当前是否真的能用 AI */
  aiUsable: boolean;
}

export function describeMode(cfg: AiConfig, online: boolean): { label: string; sub: string; aiUsable: boolean } {
  const providerReady = cfg.useBuiltin ? true : Boolean(cfg.baseUrl && cfg.apiKey && cfg.model);
  const aiUsable = online && providerReady;
  if (!online) return { label: '纯本地', sub: '当前无网络，已自动切换本地解析', aiUsable: false };
  if (!providerReady) return { label: '纯本地', sub: '供应商未配置完整，暂用本地解析', aiUsable: false };
  if (cfg.useBuiltin) {
    const ch = findBuiltinChannel(cfg.builtinChannel);
    return { label: '本地 + AI', sub: `内置免费 · ${ch.name}（${ch.label}）`, aiUsable: true };
  }
  return { label: '本地 + AI', sub: `${cfg.label} · ${cfg.model}`, aiUsable: true };
}

/** 首页胶囊与设置页共用：配置 + 网络状态 */
export function useAiStatus(): AiStatus & { reload: () => void } {
  const [cfg, setCfg] = useState<AiConfig>(cached);
  const [online, setOnline] = useState(true);

  useEffect(() => {
    const unsubscribe = subscribeAiConfig(() => setCfg(cached));
    return () => {
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    let alive = true;
    const poll = () => {
      checkOnline()
        .then((v) => {
          if (alive) setOnline(v);
        })
        .catch((error) => console.error('[aiConfig] online check failed:', error));
    };
    poll();
    const timer = setInterval(poll, 15000);
    let removal: (() => void) | null = null;
    try {
      const sub = Network.addNetworkStateListener(() => poll());
      removal = () => sub.remove();
    } catch (error) {
      console.error('[aiConfig] 网络监听注册失败，改用轮询:', error);
    }
    return () => {
      alive = false;
      clearInterval(timer);
      if (removal) removal();
    };
  }, []);

  const reload = useCallback(() => {
    loadAiConfig()
      .then((c) => setCfg(c))
      .catch((error) => console.error('[aiConfig] reload failed:', error));
    checkOnline()
      .then(setOnline)
      .catch((error) => console.error('[aiConfig] reload online failed:', error));
  }, []);

  const described = describeMode(cfg, online);
  return { cfg, online, ...described, reload };
}
