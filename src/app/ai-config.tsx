/**
 * AI 供应商配置（单页交互式）
 *
 * 选择厂商 → 填 API Key → 模型号自动/手动 → 选择模型能力 → 真实连接测试。
 * 配置只存本机安全存储，不上传云端；调用时经 ai-relay 云函数按域名自动选协议。
 */
import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { dialog } from '../components/dialog';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import {
  BUILTIN_CONFIG,
  BUILTIN_CHANNELS,
  PRESETS,
  applyPreset,
  checkOnline,
  describeMode,
  detectProtocol,
  findPreset,
  loadAiConfig,
  normalizeBaseUrl,
  protocolLabel,
  resetAiConfig,
  saveAiConfig,
  type AiCapability,
  type AiConfig,
  type AiProtocol,
} from '../services/aiConfig';
import { testConnection, type TestResult } from '../services/aiService';
import { QWEN_DAILY_LIMIT, refreshQuota, useQuota } from '../services/quotaService';
import { useTheme } from '../store/ThemeContext';
import { SectionTitle, Tag } from '../components/ui';
import { useTaskInset } from '../components/AiTaskLayer';
import { CheckIcon, CloseIcon } from '../components/icons';

const CAPABILITIES: { value: AiCapability; label: string; desc: string }[] = [
  { value: 'both', label: '文字 + 视觉', desc: '可解析含图片的题库' },
  { value: 'text', label: '仅文字', desc: '只处理文本类题库' },
  { value: 'vision', label: '仅视觉', desc: '以图片识别为主' },
];

/**
 * 模型二（千问）当日额度徽标。
 * 额度在服务端按「真正打到千问上游的请求」计数，用完当天停用；模型一（智谱）不限次、永不停用。
 */
function ChannelQuotaBadge() {
  const { remaining, loaded } = useQuota();
  const c = useTheme().palette;
  if (!loaded) return null;
  const exhausted = remaining <= 0;
  return (
    <Text style={{ fontSize: 11.5, fontWeight: '700', color: exhausted ? c.danger : c.textSub }}>
      {exhausted ? '今日已停用' : `今日剩 ${remaining}/${QWEN_DAILY_LIMIT}`}
    </Text>
  );
}

/** 内置双档位的额度说明：把「谁计数、谁不停用、什么时候刷新」讲清楚 */
function BuiltinQuotaLine() {
  const { used, remaining, loaded } = useQuota();
  const c = useTheme().palette;
  useEffect(() => {
    void refreshQuota();
  }, []);
  return (
    <Text style={[styles.keyHint, { color: c.textMuted }]}>
      模型一的智谱 Key 由服务端保管、额度独立，不限次数，被限流时可以一直重试碰运气。模型二走平台网关、会消耗平台账号额度，
      每人每天最多 {QWEN_DAILY_LIMIT} 次{loaded ? `（今日已用 ${used} 次，剩余 ${remaining} 次）` : ''}，用完当天停用，次日 00:00 自动刷新。
      模型一被限流时云函数会自动改用模型二完成这一次请求，这一次同样计入模型二的当日额度。
    </Text>
  );
}

const PROTOCOLS: { value: AiProtocol; label: string }[] = [
  { value: 'openai', label: 'OpenAI 兼容' },
  { value: 'anthropic', label: 'Anthropic' },
  { value: 'gemini', label: 'Gemini' },
];

export default function AiConfigScreen() {
  const insets = useSafeAreaInsets();
  const t = useTheme();
  const c = t.palette;
  const taskInset = useTaskInset();

  const [cfg, setCfg] = useState<AiConfig>(BUILTIN_CONFIG);
  const [online, setOnline] = useState(true);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<TestResult | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    loadAiConfig()
      .then((loaded) => setCfg(loaded))
      .catch((error) => console.error('[ai-config] 载入配置失败:', error));
    checkOnline()
      .then(setOnline)
      .catch((error) => console.error('[ai-config] 网络检测失败:', error));
  }, []);

  const patch = useCallback((next: Partial<AiConfig>) => {
    setCfg((prev) => {
      const merged = { ...prev, ...next, lastTest: null };
      if (merged.protocolMode === 'auto' && !merged.useBuiltin) {
        merged.protocol = detectProtocol(merged.baseUrl);
      }
      return merged;
    });
    setTestResult(null);
  }, []);

  const preset = findPreset(cfg.providerId);
  const mode = describeMode(cfg, online);

  const onPickProvider = useCallback(
    (id: string) => {
      setCfg((prev) => applyPreset(prev, id));
      setTestResult(null);
    },
    [],
  );

  const onSave = useCallback(async () => {
    if (!cfg.useBuiltin) {
      if (!normalizeBaseUrl(cfg.baseUrl)) {
        dialog.alert('还差一步', '请填写接口地址，例如 https://api.deepseek.com');
        return;
      }
      if (!cfg.apiKey.trim()) {
        dialog.alert('还差一步', '请填写该供应商的 API Key');
        return;
      }
      if (!cfg.model.trim()) {
        dialog.alert('还差一步', '请填写模型编号（可在供应商控制台复制）');
        return;
      }
    }
    setSaving(true);
    try {
      await saveAiConfig({ ...cfg, baseUrl: normalizeBaseUrl(cfg.baseUrl), model: cfg.model.trim(), visionModel: cfg.visionModel.trim() });
      dialog.alert('已保存到本机', online ? '当前为「本地 + AI」混合解析。' : '当前检测不到网络，会先走本地解析，联网后自动启用 AI。');
    } catch (error) {
      console.error('[ai-config] 保存失败:', error);
      dialog.alert('未能保存', '本机安全存储不可用，配置只在今次运行内生效。');
    } finally {
      setSaving(false);
    }
  }, [cfg, online]);

  const onTest = useCallback(async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const isOnline = await checkOnline();
      if (!isOnline) {
        setTestResult({ ok: false, message: '当前无网络，无法完成连接测试' });
        return;
      }
      const result = await testConnection({ ...cfg, baseUrl: normalizeBaseUrl(cfg.baseUrl) });
      setTestResult(result);
    } catch (error) {
      console.error('[ai-config] 连接测试异常:', error);
      setTestResult({ ok: false, message: '测试未完成，请稍后重试' });
    } finally {
      setTesting(false);
    }
  }, [cfg]);

  const onReset = useCallback(() => {
    dialog.alert('恢复内置供应商', '将清除自定义厂商与 API Key，回到平台内置免费模型。', [
      { text: '取消', style: 'cancel' },
      {
        text: '确定恢复',
        style: 'destructive',
        onPress: () => {
          resetAiConfig()
            .then(() => {
              setCfg(BUILTIN_CONFIG);
              setTestResult(null);
            })
            .catch((error) => console.error('[ai-config] 恢复失败:', error));
        },
      },
    ]);
  }, []);

  const labelStyle = [styles.fieldLabel, { color: c.textSub }];

  return (
    <View style={[styles.root, { paddingTop: insets.top + taskInset }]}>
      <View style={styles.nav}>
        <Pressable
          accessibilityRole="button"
          onPress={() => (router.canGoBack() ? router.back() : router.replace('/'))}
          hitSlop={12}
          style={styles.back}
        >
          <Text style={[styles.backText, { color: c.primary }]}>‹ 返回</Text>
        </Pressable>
        <Text style={[styles.navTitle, { color: c.text }]}>AI 供应商</Text>
        <View style={styles.navSpace} />
      </View>

      <ScrollView contentInsetAdjustmentBehavior="automatic" showsVerticalScrollIndicator={false} contentContainerStyle={styles.scroll}>
        {/* 当前模式 */}
        <View style={[styles.statusCard, { backgroundColor: t.cardBg, borderRadius: t.cardRadius, borderColor: c.border, ...t.shadow.card }]}>
          <View style={styles.statusRow}>
            <View style={[styles.dot, { backgroundColor: mode.aiUsable ? c.success : c.warn }]} />
            <Text style={[styles.statusLabel, { color: c.text }]}>{mode.label}</Text>
            <View style={{ flex: 1 }} />
            <Tag label={online ? '网络正常' : '离线'} tone={online ? 'success' : 'warn'} />
          </View>
          <Text style={[styles.statusSub, { color: c.textSub }]}>{mode.sub}</Text>
          <Text style={[styles.statusHint, { color: c.textMuted }]}>
            解析题库时始终先跑本地规则，AI 负责补复杂排版与不确定项；断网或供应商不可用时自动退回纯本地。
          </Text>
        </View>

        <SectionTitle title="选择供应商" hint="内置模型无需 Key" />
        <View style={styles.providerGrid}>
          {PRESETS.map((p) => {
            const active = cfg.providerId === p.id;
            return (
              <Pressable
                key={p.id}
                accessibilityRole="button"
                onPress={() => onPickProvider(p.id)}
                style={({ pressed }) => [
                  styles.providerChip,
                  {
                    backgroundColor: active ? c.primarySoft : t.chipBg,
                    borderColor: active ? c.primary : c.border,
                    borderRadius: t.radius.md,
                    opacity: pressed ? 0.9 : 1,
                  },
                ]}
              >
                <Text style={[styles.providerName, { color: active ? c.primaryDark : c.text }]} numberOfLines={1}>
                  {p.label}
                </Text>
                {active ? <CheckIcon size={13} color={c.primary} /> : null}
              </Pressable>
            );
          })}
        </View>
        <Text style={[styles.keyHint, { color: c.textMuted }]}>{preset.keyHint}</Text>

        {cfg.useBuiltin ? (
          <>
            <SectionTitle title="内置免费模型" hint="两档都无需 Key" />
            <View style={{ gap: 10 }}>
              {BUILTIN_CHANNELS.map((ch) => {
                const active = cfg.builtinChannel === ch.id;
                return (
                  <Pressable
                    key={ch.id}
                    accessibilityRole="button"
                    onPress={() => patch({ builtinChannel: ch.id, model: ch.textModel, visionModel: ch.visionModel })}
                    style={[
                      styles.channelCard,
                      {
                        backgroundColor: active ? c.primarySoft : t.cardBg,
                        borderColor: active ? c.primary : c.border,
                        borderRadius: t.radius.md,
                        ...t.shadow.card,
                      },
                    ]}
                  >
                    <View style={styles.channelHead}>
                      <Text style={[styles.channelName, { color: active ? c.primaryDark : c.text }]}>
                        {ch.name} · {ch.label}
                      </Text>
                      {ch.id === 'qwen' ? <ChannelQuotaBadge /> : null}
                      {active ? <CheckIcon size={14} color={c.primary} /> : null}
                    </View>
                    <Text style={[styles.channelModel, { color: c.textSub }]}>
                      文字 {ch.textModel}　识图 {ch.visionModel}
                    </Text>
                    <Text style={[styles.channelDesc, { color: c.textMuted }]}>{ch.desc}</Text>
                  </Pressable>
                );
              })}
            </View>
            <BuiltinQuotaLine />
          </>
        ) : null}

        {!cfg.useBuiltin ? (
          <>
            <SectionTitle title="接口与密钥" hint="仅存本机" />
            <View style={[styles.formCard, { backgroundColor: t.cardBg, borderRadius: t.cardRadius, borderColor: c.border, ...t.shadow.card }]}>
              <Text style={labelStyle}>接口地址</Text>
              <TextInput
                style={[styles.input, { backgroundColor: c.surfaceAlt, borderColor: c.border, borderRadius: t.radius.sm, color: c.text }]}
                value={cfg.baseUrl}
                onChangeText={(v) => patch({ baseUrl: v })}
                autoCapitalize="none"
                placeholder="https://api.example.com/v1"
                placeholderTextColor={c.textMuted}
              />
              <Text style={[styles.fieldFoot, { color: c.textMuted }]}>
                协议自动识别：{protocolLabel(detectProtocol(cfg.baseUrl))}
              </Text>

              <Text style={[styles.fieldLabel, { color: c.textSub, marginTop: 16 }]}>API Key</Text>
              <TextInput
                style={[styles.input, { backgroundColor: c.surfaceAlt, borderColor: c.border, borderRadius: t.radius.sm, color: c.text }]}
                value={cfg.apiKey}
                onChangeText={(v) => patch({ apiKey: v })}
                autoCapitalize="none"
                secureTextEntry
                placeholder="粘贴供应商生成的 Key"
                placeholderTextColor={c.textMuted}
              />
              <Text style={[styles.fieldFoot, { color: c.textMuted }]}>
                Key 保存在手机安全存储内，只在单次请求中转发给网关，不会写入云端数据库。
              </Text>
            </View>

            <SectionTitle title="模型编号" />
            <View style={[styles.formCard, { backgroundColor: t.cardBg, borderRadius: t.cardRadius, borderColor: c.border, ...t.shadow.card }]}>
              <View style={styles.switchRow}>
                <Pressable
                  accessibilityRole="button"
                  onPress={() => patch({ autoModel: true, model: preset.textModels[0] ?? cfg.model })}
                  style={[styles.segBtn, { backgroundColor: cfg.autoModel ? c.primary : c.surfaceAlt, borderColor: c.border, borderRadius: t.radius.sm }]}
                >
                  <Text style={[styles.segText, { color: cfg.autoModel ? c.onPrimary : c.textSub }]}>自动带出</Text>
                </Pressable>
                <Pressable
                  accessibilityRole="button"
                  onPress={() => patch({ autoModel: false })}
                  style={[styles.segBtn, { backgroundColor: !cfg.autoModel ? c.primary : c.surfaceAlt, borderColor: c.border, borderRadius: t.radius.sm }]}
                >
                  <Text style={[styles.segText, { color: !cfg.autoModel ? c.onPrimary : c.textSub }]}>手动填写</Text>
                </Pressable>
              </View>

              {cfg.autoModel && preset.textModels.length > 0 ? (
                <View style={styles.modelRow}>
                  {preset.textModels.map((m) => (
                    <Pressable
                      key={m}
                      accessibilityRole="button"
                      onPress={() => patch({ model: m })}
                      style={[
                        styles.modelChip,
                        {
                          backgroundColor: cfg.model === m ? c.primarySoft : c.surfaceAlt,
                          borderColor: cfg.model === m ? c.primary : c.border,
                          borderRadius: t.radius.pill,
                        },
                      ]}
                    >
                      <Text style={[styles.modelChipText, { color: cfg.model === m ? c.primaryDark : c.textSub }]}>{m}</Text>
                    </Pressable>
                  ))}
                </View>
              ) : null}

              <Text style={[styles.fieldLabel, { color: c.textSub, marginTop: 14 }]}>文字模型</Text>
              <TextInput
                style={[styles.input, { backgroundColor: c.surfaceAlt, borderColor: c.border, borderRadius: t.radius.sm, color: c.text }]}
                value={cfg.model}
                onChangeText={(v) => patch({ model: v })}
                autoCapitalize="none"
                placeholder={preset.manualModelOnly ? '如 ep-2025xxxx-xxxx（推理接入点 ID）' : '如 deepseek-chat'}
                placeholderTextColor={c.textMuted}
              />

              {cfg.capability !== 'text' ? (
                <>
                  <Text style={[styles.fieldLabel, { color: c.textSub, marginTop: 14 }]}>视觉模型</Text>
                  <TextInput
                    style={[styles.input, { backgroundColor: c.surfaceAlt, borderColor: c.border, borderRadius: t.radius.sm, color: c.text }]}
                    value={cfg.visionModel}
                    onChangeText={(v) => patch({ visionModel: v })}
                    autoCapitalize="none"
                    placeholder="如 glm-4.6v-flash"
                    placeholderTextColor={c.textMuted}
                  />
                </>
              ) : null}
            </View>

            <SectionTitle title="模型能力" />
            <View style={styles.capGrid}>
              {CAPABILITIES.map((item) => {
                const active = cfg.capability === item.value;
                return (
                  <Pressable
                    key={item.value}
                    accessibilityRole="button"
                    onPress={() => patch({ capability: item.value })}
                    style={[
                      styles.capCard,
                      {
                        backgroundColor: active ? c.primarySoft : t.cardBg,
                        borderColor: active ? c.primary : c.border,
                        borderRadius: t.radius.md,
                        ...t.shadow.inset,
                      },
                    ]}
                  >
                    <Text style={[styles.capTitle, { color: active ? c.primaryDark : c.text }]}>{item.label}</Text>
                    <Text style={[styles.capDesc, { color: c.textMuted }]}>{item.desc}</Text>
                  </Pressable>
                );
              })}
            </View>

            <SectionTitle title="请求协议" />
            <View style={[styles.formCard, { backgroundColor: t.cardBg, borderRadius: t.cardRadius, borderColor: c.border, ...t.shadow.card }]}>
              <View style={styles.switchRow}>
                <Pressable
                  accessibilityRole="button"
                  onPress={() => patch({ protocolMode: 'auto', protocol: detectProtocol(cfg.baseUrl) })}
                  style={[styles.segBtn, { backgroundColor: cfg.protocolMode === 'auto' ? c.primary : c.surfaceAlt, borderColor: c.border, borderRadius: t.radius.sm }]}
                >
                  <Text style={[styles.segText, { color: cfg.protocolMode === 'auto' ? c.onPrimary : c.textSub }]}>按域名自动</Text>
                </Pressable>
                <Pressable
                  accessibilityRole="button"
                  onPress={() => patch({ protocolMode: 'manual' })}
                  style={[styles.segBtn, { backgroundColor: cfg.protocolMode === 'manual' ? c.primary : c.surfaceAlt, borderColor: c.border, borderRadius: t.radius.sm }]}
                >
                  <Text style={[styles.segText, { color: cfg.protocolMode === 'manual' ? c.onPrimary : c.textSub }]}>手动指定</Text>
                </Pressable>
              </View>
              {cfg.protocolMode === 'manual' ? (
                <View style={[styles.modelRow, { marginTop: 12 }]}>
                  {PROTOCOLS.map((p) => (
                    <Pressable
                      key={p.value}
                      accessibilityRole="button"
                      onPress={() => patch({ protocol: p.value })}
                      style={[
                        styles.modelChip,
                        {
                          backgroundColor: cfg.protocol === p.value ? c.primarySoft : c.surfaceAlt,
                          borderColor: cfg.protocol === p.value ? c.primary : c.border,
                          borderRadius: t.radius.pill,
                        },
                      ]}
                    >
                      <Text style={[styles.modelChipText, { color: cfg.protocol === p.value ? c.primaryDark : c.textSub }]}>{p.label}</Text>
                    </Pressable>
                  ))}
                </View>
              ) : (
                <Text style={[styles.fieldFoot, { color: c.textMuted, marginTop: 10 }]}>
                  当前将使用：{protocolLabel(cfg.protocol)}
                </Text>
              )}
            </View>
          </>
        ) : (
          <View style={[styles.tipCard, { backgroundColor: c.primarySoft, borderRadius: t.radius.md, borderColor: c.border }]}>
            <Text style={[styles.tipText, { color: c.primaryDark }]}>
              内置免费模型已就绪（文字与视觉均可用），无需填 Key。想换成 DeepSeek、智谱、Claude 等供应商，点上方对应厂商即可。
            </Text>
          </View>
        )}

        {testResult ? (
          <View
            style={[
              styles.testCard,
              {
                backgroundColor: testResult.ok ? c.successSoft : c.dangerSoft,
                borderColor: testResult.ok ? c.success : c.danger,
                borderRadius: t.radius.md,
              },
            ]}
          >
            <View style={styles.testHead}>
              {testResult.ok ? <CheckIcon size={15} color={c.success} /> : <CloseIcon size={15} color={c.danger} />}
              <Text style={[styles.testTitle, { color: testResult.ok ? c.success : c.danger }]}>
                {testResult.ok ? '连接成功' : '连接失败'}
              </Text>
            </View>
            <Text style={[styles.testMsg, { color: c.textSub }]}>{testResult.message}</Text>
            {testResult.ok && testResult.sample ? (
              <Text style={[styles.testMsg, { color: c.textMuted }]}>模型回复：{testResult.sample}</Text>
            ) : null}
          </View>
        ) : null}

        <View style={{ height: 24 }} />
      </ScrollView>

      <View style={[styles.bottom, { backgroundColor: c.tabBar, borderColor: c.border, paddingBottom: insets.bottom + 12 }]}>
        <Pressable
          accessibilityRole="button"
          onPress={() => {
            onTest().catch((error) => console.error('[ai-config] 测试失败:', error));
          }}
          disabled={testing}
          style={({ pressed }) => [styles.ghostBtn, { borderColor: c.border, borderRadius: t.radius.md, opacity: pressed || testing ? 0.75 : 1 }]}
        >
          {testing ? <ActivityIndicator size="small" color={c.primary} /> : <Text style={[styles.ghostText, { color: c.textSub }]}>测试连接</Text>}
        </Pressable>
        <Pressable
          accessibilityRole="button"
          onPress={onReset}
          style={({ pressed }) => [styles.ghostBtn, { borderColor: c.border, borderRadius: t.radius.md, opacity: pressed ? 0.8 : 1 }]}
        >
          <Text style={[styles.ghostText, { color: c.textMuted }]}>恢复内置</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          onPress={() => {
            onSave().catch((error) => console.error('[ai-config] 保存失败:', error));
          }}
          disabled={saving}
          style={({ pressed }) => [styles.primaryBtn, { backgroundColor: c.primary, borderRadius: t.radius.md, opacity: saving || pressed ? 0.85 : 1, ...t.shadow.card }]}
        >
          <Text style={[styles.primaryText, { color: c.onPrimary }]}>保存配置</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  channelCard: { padding: 14, borderWidth: 1 },
  channelHead: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  channelName: { flex: 1, fontSize: 14.5, fontWeight: '800' },
  channelModel: { fontSize: 12, marginTop: 6 },
  channelDesc: { fontSize: 11.5, lineHeight: 17, marginTop: 4 },
  root: { flex: 1 },
  nav: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, marginBottom: 6, minHeight: 40 },
  back: { width: 64 },
  backText: { fontSize: 15, fontWeight: '600' },
  navTitle: { flex: 1, textAlign: 'center', fontSize: 16, fontWeight: '700' },
  navSpace: { width: 64 },
  scroll: { paddingHorizontal: 16, paddingBottom: 30 },
  statusCard: { padding: 16, marginTop: 6, borderWidth: 1 },
  statusRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  statusLabel: { fontSize: 16, fontWeight: '800' },
  statusSub: { fontSize: 12.5, marginTop: 6, lineHeight: 19 },
  statusHint: { fontSize: 11.5, marginTop: 8, lineHeight: 18 },
  providerGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  providerChip: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 12, paddingVertical: 9, borderWidth: 1.2, minWidth: 100 },
  providerName: { fontSize: 13, fontWeight: '600', flex: 1 },
  keyHint: { fontSize: 11.5, color: '#8a8a8a', marginTop: 10, lineHeight: 18 },
  formCard: { borderWidth: 1, padding: 14 },
  fieldLabel: { fontSize: 12, fontWeight: '700', marginBottom: 6 },
  input: { borderWidth: 1, paddingHorizontal: 12, height: 44, fontSize: 14 },
  fieldFoot: { fontSize: 11, marginTop: 6, lineHeight: 17 },
  switchRow: { flexDirection: 'row', gap: 8 },
  segBtn: { flex: 1, height: 38, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  segText: { fontSize: 13, fontWeight: '700' },
  modelRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 12 },
  modelChip: { paddingHorizontal: 11, paddingVertical: 6, borderWidth: 1 },
  modelChipText: { fontSize: 12, fontWeight: '600' },
  capGrid: { flexDirection: 'row', gap: 8 },
  capCard: { flex: 1, borderWidth: 1.2, padding: 12 },
  capTitle: { fontSize: 13, fontWeight: '700' },
  capDesc: { fontSize: 11, marginTop: 3, lineHeight: 16 },
  testCard: { borderWidth: 1, padding: 12, marginTop: 16 },
  testHead: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  testTitle: { fontSize: 13.5, fontWeight: '800' },
  testMsg: { fontSize: 12, marginTop: 5, lineHeight: 18 },
  tipCard: { borderWidth: 1, padding: 14, marginTop: 16 },
  tipText: { fontSize: 12.5, lineHeight: 20 },
  bottom: { flexDirection: 'row', gap: 8, paddingHorizontal: 16, paddingTop: 12, borderTopWidth: StyleSheet.hairlineWidth },
  primaryBtn: { flex: 2, height: 48, alignItems: 'center', justifyContent: 'center' },
  primaryText: { fontSize: 15.5, fontWeight: '700' },
  ghostBtn: { flex: 1.3, height: 48, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  ghostText: { fontSize: 13.5, fontWeight: '600' },
});
