import React, { useCallback, useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { dialog } from '../../components/dialog';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import { PALETTES, THEME_ORDER, modeDescriptions, modeLabels } from '../../constants/theme';
import { Card, SectionTitle, Switch, Tag } from '../../components/ui';
import { QuotaHint } from '../../components/QuotaHint';
import { useTaskInset } from '../../components/AiTaskLayer';
import { useApp } from '../../store/AppContext';
import { useAuth } from '../../store/AuthContext';
import { useTheme, useThemeState } from '../../store/ThemeContext';
import { describeMode, getCachedAiConfig, useAiStatus } from '../../services/aiConfig';
import { clearResolvedWrong, saveSettings } from '../../services/quizStore';
import { exportBackup, restoreBackup } from '../../services/backupService';
import type { QuizMode } from '../../types/quiz';

const MODES: QuizMode[] = ['seq', 'random', 'memorize', 'wrong'];

/** 每日刷题目标档位：0 = 不设目标 */
const DAILY_GOALS = [0, 10, 20, 30, 50];
/** 模拟考试每题限时档位（秒）：0 = 不限时 */
const EXAM_SECONDS = [0, 30, 45, 60, 90];

function Row({
  title,
  desc,
  right,
  onPress,
}: {
  title: string;
  desc?: string;
  right?: React.ReactNode;
  onPress?: () => void;
}) {
  const t = useTheme();
  const c = t.palette;
  const body = (
    <View style={styles.row}>
      <View style={styles.rowText}>
        <Text style={[styles.rowTitle, { color: c.text }]}>{title}</Text>
        {desc ? <Text style={[styles.rowDesc, { color: c.textMuted }]}>{desc}</Text> : null}
      </View>
      {right}
    </View>
  );
  if (!onPress) return body;
  return (
    <Pressable accessibilityRole="button" onPress={onPress} style={({ pressed }) => [{ opacity: pressed ? 0.9 : 1 }]}>
      {body}
    </Pressable>
  );
}

export default function SettingsScreen() {
  const insets = useSafeAreaInsets();
  const t = useTheme();
  const c = t.palette;
  const { themeId, setThemeId } = useThemeState();
  const taskInset = useTaskInset();
  const { settings, updateSettings, banks, refreshBanks } = useApp();
  const { userId, username, ready, signOut, deleteAccount } = useAuth();
  const [saving, setSaving] = useState(false);
  /** 数据类操作互斥：备份 / 恢复 / 注销同时进行会互相踩到云端数据 */
  const [busy, setBusy] = useState<'none' | 'export' | 'restore' | 'close'>('none');
  const ai = useAiStatus();

  const persist = useCallback(
    async (next: typeof settings) => {
      updateSettings(next);
      setSaving(true);
      const ok = await saveSettings(next);
      setSaving(false);
      if (!ok) {
        dialog.alert('保存失败', '设置未能写入云端，请稍后重试。');
      }
    },
    [updateSettings],
  );

  const questionTotal = banks.reduce((sum, b) => sum + b.questionCount, 0);
  const aiMode = useMemo(() => describeMode(getCachedAiConfig(), ai.online), [ai.online]);

  const onClearResolved = useCallback(() => {
    dialog.alert('清理已掌握错题', '将删除错题本中连续答对 2 次、已标记掌握的记录。未掌握的错题会全部保留。', [
      { text: '取消', style: 'cancel' },
      {
        text: '确定清理',
        style: 'destructive',
        onPress: async () => {
          try {
            await clearResolvedWrong();
            dialog.alert('已清理', '已掌握错题记录已删除。');
          } catch (error) {
            console.error('[settings] clearResolvedWrong failed:', error);
            dialog.alert('操作失败', '清理错题本时出现问题，请稍后重试。');
          }
        },
      },
    ]);
  }, []);

  const onSignOut = useCallback(() => {
    dialog.alert('退出登录', '退出后需要重新登录才能看到题库与做题记录。', [
      { text: '取消', style: 'cancel' },
      {
        text: '退出登录',
        style: 'destructive',
        onPress: async () => {
          try {
            await signOut();
            router.replace('/auth');
          } catch (error) {
            console.error('[settings] 退出登录失败:', error);
            dialog.alert('退出失败', '未能完成退出，请稍后重试。');
          }
        },
      },
    ]);
  }, [signOut]);

  /** 全量备份：六张表原样导出成一个 JSON 文件，交给系统分享面板存走 */
  const onExport = useCallback(async () => {
    if (busy !== 'none') return;
    setBusy('export');
    try {
      const r = await exportBackup();
      dialog.alert(r.ok ? '备份已完成' : '未能备份', r.message);
    } catch (error) {
      console.error('[settings] exportBackup failed:', error);
      dialog.alert('备份失败', '导出备份文件时出现问题，请稍后重试。');
    } finally {
      setBusy('none');
    }
  }, [busy]);

  /** 恢复一律作为新数据写入，不覆盖现有内容 —— 备份可能来自半年前 */
  const onRestore = useCallback(() => {
    if (busy !== 'none') return;
    dialog.alert('从备份文件恢复', '恢复会把备份里的题库与题目作为新数据写入当前账号，不会覆盖现有内容。若之前恢复过同一个文件，会出现重复题库。', [
      { text: '取消', style: 'cancel' },
      {
        text: '选择备份文件',
        onPress: () => {
          setBusy('restore');
          restoreBackup()
            .then(async (r) => {
              dialog.alert(r.ok ? '恢复已完成' : '恢复未完成', r.message);
              if (r.ok) await refreshBanks();
            })
            .catch((error) => {
              console.error('[settings] restoreBackup failed:', error);
              dialog.alert('恢复失败', '读取备份文件或写入云端时出现问题，请稍后重试。');
            })
            .finally(() => setBusy('none'));
        },
      },
    ]);
  }, [busy, refreshBanks]);

  const confirmClose = useCallback(() => {
    dialog.alert('最后确认', '注销后立即生效、不可撤销。确定要删除这个账号吗？', [
      { text: '我再想想', style: 'cancel' },
      {
        text: '确认注销账号',
        style: 'destructive',
        onPress: () => {
          setBusy('close');
          deleteAccount()
            .then((err) => {
              if (err) {
                dialog.alert('注销未完成', err);
                return;
              }
              dialog.alert('账号已注销', '该账号及其全部数据已从云端删除。');
              router.replace('/auth');
            })
            .catch((error) => {
              console.error('[settings] deleteAccount failed:', error);
              dialog.alert('注销失败', '注销过程中出现问题，请稍后重试。');
            })
            .finally(() => setBusy('none'));
        },
      },
    ]);
  }, [deleteAccount]);

  const onCloseAccount = useCallback(() => {
    if (busy !== 'none') return;
    dialog.alert(
      '注销账号',
      `将永久删除账号「${username ?? ''}」以及名下 ${banks.length} 个题库的全部题目、作答记录、错题本与断点进度。删除后无法找回。建议先做一次全量备份。`,
      [
        { text: '取消', style: 'cancel' },
        { text: '先导出备份', onPress: () => { void onExport(); } },
        { text: '继续注销', style: 'destructive', onPress: () => confirmClose() },
      ],
    );
  }, [banks.length, busy, confirmClose, onExport, username]);

  return (
    <View style={[styles.root, { paddingTop: insets.top + taskInset }]}>
      <Text style={[styles.title, { color: c.text }]}>设置</Text>
      <ScrollView contentInsetAdjustmentBehavior="automatic" showsVerticalScrollIndicator={false} contentContainerStyle={styles.scroll}>
        {/* 账号 */}
        <SectionTitle title="账号" hint={!ready ? '检查中…' : userId ? '已登录' : '未登录'} />
        <Card style={{ marginBottom: 8 }}>
          <Row
            title={username ? `当前账号：${username}` : '未登录'}
            desc="题库、作答记录、错题本与断点进度都挂在这个账号下，换设备登录后自动同步"
          />
          <View style={[styles.divider, { backgroundColor: c.border }]} />
          <Row
            title="修改密码"
            desc="需先验证原密码，再设置新密码；改完当前设备无需重新登录"
            onPress={() => router.push('/change-password')}
            right={<Text style={[styles.chev, { color: c.textMuted }]}>›</Text>}
          />
          <View style={[styles.divider, { backgroundColor: c.border }]} />
          <Row
            title="退出登录"
            desc="退出后需重新登录才能查看数据"
            onPress={onSignOut}
            right={<Text style={[styles.chev, { color: c.textMuted }]}>›</Text>}
          />
          <View style={[styles.divider, { backgroundColor: c.border }]} />
          <Row
            title={busy === 'close' ? '注销中…' : '注销账号'}
            desc="永久删除账号与全部数据，不可恢复"
            onPress={onCloseAccount}
            right={<Text style={[styles.chev, { color: c.danger }]}>›</Text>}
          />
        </Card>

        {/* AI 供应商 */}
        <SectionTitle title="AI 与解析" hint={ai.online ? '在线' : '离线'} />
        <Card style={{ marginBottom: 8 }}>
          <Row
            title="AI 供应商配置"
            desc="内置免费模型开箱可用，也可接入 DeepSeek、智谱、Claude 等自有 Key"
            onPress={() => router.push('/ai-config')}
            right={
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                <Tag label={aiMode.label} tone={aiMode.aiUsable ? 'success' : 'warn'} />
                <Text style={[styles.chev, { color: c.textMuted }]}>›</Text>
              </View>
            }
          />
          <View style={[styles.divider, { backgroundColor: c.border }]} />
          <Text style={[styles.statusLine, { color: c.textSub }]}>{ai.sub}</Text>
          <Text style={[styles.statusHint, { color: c.textMuted }]}>
            有网时走「本地规则 + AI 辅助」双通道；断网或供应商不可用时自动退回纯本地解析，不影响导入。
          </Text>
          <QuotaHint variant="inline" />
        </Card>

        {/* 外观风格 */}
        <SectionTitle title="界面风格" hint="配色与质感" />
        <View style={styles.themeGrid}>
          {THEME_ORDER.map((id) => {
            const p = PALETTES[id];
            const active = themeId === id;
            return (
              <Pressable
                key={id}
                accessibilityRole="button"
                onPress={() => setThemeId(id)}
                style={({ pressed }) => [
                  styles.themeCard,
                  {
                    backgroundColor: p.surface,
                    borderColor: active ? p.primary : p.border,
                    borderWidth: active ? 1.8 : 1,
                    borderRadius: 14,
                    opacity: pressed ? 0.92 : 1,
                  },
                ]}
              >
                <View style={[styles.themePreview, { backgroundColor: p.bg, borderRadius: 10, borderWidth: 1, borderColor: p.border }]}>
                  <View style={[styles.themeBar, { backgroundColor: p.primary }]} />
                  <View style={styles.themeDots}>
                    <View style={[styles.themeDot, { backgroundColor: p.accent }]} />
                    <View style={[styles.themeDot, { backgroundColor: p.success }]} />
                    <View style={[styles.themeDot, { backgroundColor: p.warn }]} />
                  </View>
                </View>
                <Text style={[styles.themeName, { color: p.text }]}>{p.name}</Text>
                <Text style={[styles.themeDesc, { color: p.textMuted }]} numberOfLines={2}>
                  {p.desc}
                </Text>
                {active ? <Tag label="使用中" tone="primary" /> : null}
              </Pressable>
            );
          })}
        </View>

        <SectionTitle title="刷题偏好" hint={saving ? '保存中…' : '自动保存到云端'} />
        <Card style={{ marginBottom: 8 }}>
          <Text style={[styles.groupLabel, { color: c.textSub }]}>默认练习模式</Text>
          <View style={styles.modeGrid}>
            {MODES.map((m) => (
              <Pressable
                key={m}
                accessibilityRole="button"
                onPress={() => persist({ ...settings, defaultMode: m }).catch((error) => console.error('[settings] 保存模式失败:', error))}
                style={[
                  styles.modeChip,
                  {
                    backgroundColor: settings.defaultMode === m ? c.primary : c.surfaceAlt,
                    borderColor: settings.defaultMode === m ? c.primary : c.border,
                    borderRadius: 999,
                  },
                ]}
              >
                <Text style={[styles.modeText, { color: settings.defaultMode === m ? c.onPrimary : c.textSub }]}>{modeLabels[m]}</Text>
              </Pressable>
            ))}
          </View>
          <Text style={[styles.modeDesc, { color: c.textMuted }]}>{modeDescriptions[settings.defaultMode]}</Text>
        </Card>

        <Card style={{ marginBottom: 8 }}>
          <Row
            title="答错时震动提醒"
            desc="判断题干与选项时提供更直接的反馈"
            right={<Switch value={settings.hapticOnWrong} onToggle={() => persist({ ...settings, hapticOnWrong: !settings.hapticOnWrong }).catch((error) => console.error('[settings] 保存失败:', error))} />}
          />
          <View style={[styles.divider, { backgroundColor: c.border }]} />
          <Row
            title="允许题型智能互转"
            desc="判断题在背题模式下转为选项形式，便于统一记忆"
            right={<Switch value={settings.allowTypeConvert} onToggle={() => persist({ ...settings, allowTypeConvert: !settings.allowTypeConvert }).catch((error) => console.error('[settings] 保存失败:', error))} />}
          />
          <View style={[styles.divider, { backgroundColor: c.border }]} />
          <Text style={[styles.groupLabel, { color: c.textSub }]}>每日刷题目标</Text>
          <View style={styles.modeGrid}>
            {DAILY_GOALS.map((g) => (
              <Pressable
                key={g}
                accessibilityRole="button"
                onPress={() => persist({ ...settings, dailyGoal: g }).catch((error) => console.error('[settings] 保存目标失败:', error))}
                style={[
                  styles.modeChip,
                  {
                    backgroundColor: settings.dailyGoal === g ? c.primary : c.surfaceAlt,
                    borderColor: settings.dailyGoal === g ? c.primary : c.border,
                    borderRadius: 999,
                  },
                ]}
              >
                <Text style={[styles.modeText, { color: settings.dailyGoal === g ? c.onPrimary : c.textSub }]}>
                  {g === 0 ? '不设目标' : `${g} 题`}
                </Text>
              </Pressable>
            ))}
          </View>
          <Text style={[styles.modeDesc, { color: c.textMuted }]}>
            {settings.dailyGoal > 0
              ? `今天答满 ${settings.dailyGoal} 题即算打卡完成，首页与统计页会显示今日进度。`
              : '不设目标时，首页只显示今日已刷题数，不显示进度。'}
          </Text>
          <View style={[styles.divider, { backgroundColor: c.border }]} />
          <Text style={[styles.groupLabel, { color: c.textSub }]}>模拟考试每题限时</Text>
          <View style={styles.modeGrid}>
            {EXAM_SECONDS.map((s) => (
              <Pressable
                key={s}
                accessibilityRole="button"
                onPress={() => persist({ ...settings, examSecondsPerQuestion: s }).catch((error) => console.error('[settings] 保存限时失败:', error))}
                style={[
                  styles.modeChip,
                  {
                    backgroundColor: settings.examSecondsPerQuestion === s ? c.primary : c.surfaceAlt,
                    borderColor: settings.examSecondsPerQuestion === s ? c.primary : c.border,
                    borderRadius: 999,
                  },
                ]}
              >
                <Text style={[styles.modeText, { color: settings.examSecondsPerQuestion === s ? c.onPrimary : c.textSub }]}>
                  {s === 0 ? '不限时' : `${s} 秒`}
                </Text>
              </Pressable>
            ))}
          </View>
          <Text style={[styles.modeDesc, { color: c.textMuted }]}>
            {settings.examSecondsPerQuestion > 0
              ? `整卷时限 = 题数 × ${settings.examSecondsPerQuestion} 秒，时间到自动交卷。`
              : '当前模考不限时长，只靠手动交卷。'}
          </Text>
        </Card>

        <SectionTitle title="数据" />
        <Card style={{ marginBottom: 8 }}>
          <Row title="题库数量" right={<Text style={[styles.value, { color: c.primaryDark }]}>{banks.length} 个</Text>} />
          <View style={[styles.divider, { backgroundColor: c.border }]} />
          <Row title="题目总数" right={<Text style={[styles.value, { color: c.primaryDark }]}>{questionTotal} 题</Text>} />
          <View style={[styles.divider, { backgroundColor: c.border }]} />
          <Row title="清理已掌握错题" desc="删除错题本中已标记掌握的记录" onPress={onClearResolved} right={<Text style={[styles.chev, { color: c.textMuted }]}>›</Text>} />
          <View style={[styles.divider, { backgroundColor: c.border }]} />
          <Row
            title={busy === 'export' ? '备份中…' : '导出全量备份'}
            desc="题库、题目、作答记录、错题本打包成 JSON 文件，可存进网盘或发给自己的邮箱"
            onPress={onExport}
            right={<Text style={[styles.chev, { color: c.textMuted }]}>›</Text>}
          />
          <View style={[styles.divider, { backgroundColor: c.border }]} />
          <Row
            title={busy === 'restore' ? '恢复中…' : '从备份文件恢复'}
            desc="选择之前的 JSON 备份，作为新数据写回当前账号"
            onPress={onRestore}
            right={<Text style={[styles.chev, { color: c.textMuted }]}>›</Text>}
          />
        </Card>

        <SectionTitle title="关于" />
        <Card>
          <View style={styles.aboutRow}>
            <Text style={[styles.appName, { color: c.text }]}>智能刷题</Text>
            <Tag label="v1.1" tone="primary" />
          </View>
          <Text style={[styles.aboutText, { color: c.textSub }]}>
            导入试卷或复习资料即可自动生成题库。本地规则解析保证离线可用与结果稳定，AI 辅助解析用于排版复杂、题量大的资料。
          </Text>
          <Text style={[styles.aboutText, { color: c.textSub }]}>
            题库、作答记录、错题本与断点进度按账号保存在云端，其他账号与未登录访客都读不到；API Key 与界面风格只保存在本机。
          </Text>
        </Card>

        {/* 署名：单独一行，不属于任何卡片 */}
        <View style={styles.credit}>
          <View style={[styles.creditLine, { backgroundColor: c.border }]} />
          <Text style={[styles.creditText, { color: c.textMuted }]}>本软件由雨不一制作</Text>
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, paddingHorizontal: 16 },
  title: { fontSize: 21, fontWeight: '800', marginBottom: 8 },
  scroll: { paddingBottom: 60 },
  groupLabel: { fontSize: 13, marginBottom: 10, fontWeight: '600' },
  modeGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  modeChip: { paddingHorizontal: 12, paddingVertical: 7, borderWidth: 1 },
  modeText: { fontSize: 12.5, fontWeight: '600' },
  modeDesc: { fontSize: 12, marginTop: 10, lineHeight: 18 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 4 },
  rowText: { flex: 1 },
  rowTitle: { fontSize: 14.5, fontWeight: '600' },
  rowDesc: { fontSize: 12, marginTop: 2, lineHeight: 17 },
  value: { fontSize: 14, fontWeight: '700' },
  chev: { fontSize: 17, marginTop: -2 },
  divider: { height: StyleSheet.hairlineWidth, marginVertical: 10 },
  statusLine: { fontSize: 12.5, fontWeight: '600' },
  statusHint: { fontSize: 11.5, lineHeight: 18, marginTop: 4 },
  themeGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  themeCard: { width: '48%', flexGrow: 1, padding: 12, gap: 6 },
  themePreview: { height: 46, padding: 8, justifyContent: 'space-between' },
  themeBar: { width: 34, height: 7, borderRadius: 4 },
  themeDots: { flexDirection: 'row', gap: 5 },
  themeDot: { width: 9, height: 9, borderRadius: 5 },
  themeName: { fontSize: 13.5, fontWeight: '700' },
  themeDesc: { fontSize: 11, lineHeight: 16 },
  aboutRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 8 },
  appName: { fontSize: 15.5, fontWeight: '700' },
  aboutText: { fontSize: 12.5, lineHeight: 20, marginTop: 4 },
  credit: { alignItems: 'center', marginTop: 28, marginBottom: 10, gap: 12 },
  creditLine: { height: StyleSheet.hairlineWidth, width: '55%' },
  creditText: { fontSize: 12.5, letterSpacing: 1.2, fontWeight: '600' },
});
