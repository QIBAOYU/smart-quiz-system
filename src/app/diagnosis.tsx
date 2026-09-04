/**
 * AI 薄弱点诊断：把统计页同口径的真实数据交给 AI，换一份「问题在哪 + 今天怎么做」的报告。
 *
 * 单次请求、数据量小，因此进度放在页内呈现，不占用顶部全局 AI 任务条；
 * 作答样本不足 5 次时直接不调 AI —— 数据太少时模型给出的「薄弱点」纯属猜测。
 */
import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Card, Tag } from '../components/ui';
import { useTheme } from '../store/ThemeContext';
import { RelayUnavailableError, type Diagnosis } from '../services/aiService';
import { runDiagnosis } from '../services/aiPlusService';
import { loadStats } from '../services/statsService';

type Phase = 'checking' | 'thin' | 'running' | 'ready' | 'failed';

/** 低于这个作答次数就不值得让 AI 下结论 */
const MIN_ATTEMPTS = 5;

export default function DiagnosisScreen() {
  const t = useTheme();
  const c = t.palette;
  const insets = useSafeAreaInsets();
  const [phase, setPhase] = useState<Phase>('checking');
  const [report, setReport] = useState<Diagnosis | null>(null);
  const [errText, setErrText] = useState('');
  const [meta, setMeta] = useState({ attempts: 0, accuracy: 0, wrong: 0 });

  const start = useCallback(async () => {
    setPhase('running');
    setErrText('');
    try {
      const result = await runDiagnosis();
      setReport(result);
      setPhase('ready');
    } catch (error) {
      console.error('[diagnosis] failed:', error);
      setErrText(
        error instanceof RelayUnavailableError
          ? 'AI 服务暂时不可用。请检查网络，或到「设置 → AI 供应商」确认配置后重试。'
          : '这次诊断没有成功，请稍后重试。',
      );
      setPhase('failed');
    }
  }, []);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const s = await loadStats();
        if (!alive) return;
        setMeta({ attempts: s?.totalAttempts ?? 0, accuracy: Math.round(s?.accuracy ?? 0), wrong: s?.wrongPending ?? 0 });
        if ((s?.totalAttempts ?? 0) < MIN_ATTEMPTS) {
          setPhase('thin');
          return;
        }
        await start();
      } catch (error) {
        console.error('[diagnosis] load stats failed:', error);
        if (!alive) return;
        setErrText('读取作答记录时出错，请检查网络后重试。');
        setPhase('failed');
      }
    })().catch((error) => console.error('[diagnosis] bootstrap failed:', error));
    return () => {
      alive = false;
    };
  }, [start]);

  const busy = phase === 'checking' || phase === 'running';

  return (
    <View style={[styles.root, { backgroundColor: c.bg, paddingTop: insets.top + t.spacing.sm }]}>
      <View style={styles.nav}>
        <Pressable
          accessibilityRole="button"
          onPress={() => (router.canGoBack() ? router.back() : router.replace('/stats'))}
          hitSlop={12}
          style={styles.back}
        >
          <Text style={[styles.backText, { color: c.primary }]}>‹ 返回</Text>
        </Pressable>
        <Text style={[styles.navTitle, { color: c.text }]}>薄弱点诊断</Text>
        <Pressable
          accessibilityRole="button"
          onPress={() => {
            if (busy) return;
            start().catch((error) => console.error('[diagnosis] retry failed:', error));
          }}
          hitSlop={10}
          style={styles.navRight}
        >
          <Text style={[styles.refresh, { color: busy ? c.textMuted : c.primary }]}>重新诊断</Text>
        </Pressable>
      </View>

      <ScrollView style={{ flex: 1 }} contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        {busy ? (
          <View style={styles.center}>
            <ActivityIndicator color={c.primary} />
            <Text style={[styles.runningText, { color: c.textSub }]}>
              {phase === 'checking' ? '正在汇总你的作答数据…' : 'AI 正在分析薄弱环节…'}
            </Text>
            <Text style={[styles.hint, { color: c.textMuted }]}>
              报告只依据你已经产生的真实作答记录，不会编造没练过的科目。
            </Text>
          </View>
        ) : null}

        {phase === 'thin' ? (
          <Card style={styles.block}>
            <Text style={[styles.thinTitle, { color: c.text }]}>作答记录还太少</Text>
            <Text style={[styles.thinDesc, { color: c.textSub }]}>
              你目前累计作答 {meta.attempts} 次。样本太少时任何「薄弱点」都只是猜测，先累计满 {MIN_ATTEMPTS}{' '}
              次作答再来诊断，结论才有参考价值。
            </Text>
            <Pressable
              accessibilityRole="button"
              onPress={() => router.push('/')}
              style={({ pressed }) => [styles.primaryBtn, { backgroundColor: c.primary, opacity: pressed ? 0.9 : 1 }]}
            >
              <Text style={[styles.primaryText, { color: c.onPrimary }]}>先去刷几题</Text>
            </Pressable>
          </Card>
        ) : null}

        {phase === 'failed' ? (
          <Card style={styles.block}>
            <Text style={[styles.thinTitle, { color: c.text }]}>诊断未完成</Text>
            <Text style={[styles.thinDesc, { color: c.textSub }]}>{errText}</Text>
            <Pressable
              accessibilityRole="button"
              onPress={() => {
                start().catch((error) => console.error('[diagnosis] retry failed:', error));
              }}
              style={({ pressed }) => [styles.primaryBtn, { backgroundColor: c.primary, opacity: pressed ? 0.9 : 1 }]}
            >
              <Text style={[styles.primaryText, { color: c.onPrimary }]}>再试一次</Text>
            </Pressable>
          </Card>
        ) : null}

        {phase === 'ready' && report ? (
          <View>
            <Card style={styles.block}>
              <View style={styles.tagRow}>
                <Tag label={`累计 ${meta.attempts} 次作答`} tone="neutral" />
                <Tag label={`正确率 ${meta.accuracy}%`} tone={meta.accuracy >= 80 ? 'success' : meta.accuracy >= 60 ? 'primary' : 'danger'} />
                <Tag label={`待消灭错题 ${meta.wrong} 题`} tone={meta.wrong > 0 ? 'warn' : 'success'} />
              </View>
              <Text style={[styles.summary, { color: c.text }]}>{report.summary || 'AI 未给出总体判断，下面是分项结论。'}</Text>
              <Text style={[styles.hint, { color: c.textMuted }]}>
                数据口径与统计页完全一致：已掌握 = 该题最近一次答对且未挂在错题本里。
              </Text>
            </Card>

            {report.points.length > 0 ? (
              <View>
                <Text style={[styles.section, { color: c.textMuted }]}>主要薄弱点</Text>
                {report.points.map((p, i) => (
                  <Card key={`${p.title}_${i}`} style={styles.point}>
                    <View style={styles.pointHead}>
                      <View style={[styles.index, { backgroundColor: c.accentSoft }]}>
                        <Text style={[styles.indexText, { color: c.accent }]}>{i + 1}</Text>
                      </View>
                      <Text style={[styles.pointTitle, { color: c.text }]}>{p.title || '薄弱点'}</Text>
                    </View>
                    {p.detail ? <Text style={[styles.pointDetail, { color: c.textSub }]}>{p.detail}</Text> : null}
                    {p.action ? (
                      <View style={[styles.actionBox, { backgroundColor: c.primarySoft, borderRadius: t.radius.md }]}>
                        <Text style={[styles.actionText, { color: c.primaryDark }]}>建议：{p.action}</Text>
                      </View>
                    ) : null}
                  </Card>
                ))}
              </View>
            ) : null}

            {report.plan.length > 0 ? (
              <Card style={styles.block}>
                <Text style={[styles.cardTitle, { color: c.textMuted }]}>接下来的练习安排</Text>
                {report.plan.map((item, i) => (
                  <View key={`${item}_${i}`} style={styles.planRow}>
                    <View style={[styles.checkbox, { borderColor: c.border }]}>
                      <Text style={[styles.planIndex, { color: c.textMuted }]}>{i + 1}</Text>
                    </View>
                    <Text style={[styles.planText, { color: c.text }]}>{item}</Text>
                  </View>
                ))}
              </Card>
            ) : null}

            <View style={styles.footerRow}>
              <Pressable
                accessibilityRole="button"
                onPress={() => {
                  console.log('[diagnosis] 底部按钮：去消灭错题（footerRow 左）');
                  router.push('/wrong');
                }}
                style={({ pressed }) => [
                  styles.ghostBtn,
                  { borderColor: c.border, backgroundColor: t.cardBg, opacity: pressed ? 0.9 : 1, borderRadius: t.radius.md },
                ]}
              >
                <Text style={[styles.ghostText, { color: c.text }]}>去消灭错题</Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                onPress={() => {
                  console.log('[diagnosis] 底部按钮：按计划开刷（footerRow 右）');
                  router.push('/');
                }}
                style={({ pressed }) => [
                  styles.primaryBtn,
                  { flex: 1, marginTop: 0, backgroundColor: c.primary, opacity: pressed ? 0.9 : 1, borderRadius: t.radius.md },
                ]}
              >
                <Text style={[styles.primaryText, { color: c.onPrimary }]}>按计划开刷</Text>
              </Pressable>
            </View>

            <Text style={[styles.disclaimer, { color: c.textMuted }]}>
              报告由 AI 依据你的作答数据生成，仅供练习参考；题目本身的对错仍以题库里的答案为准。
            </Text>
          </View>
        ) : null}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  nav: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, marginBottom: 8 },
  back: { width: 64 },
  backText: { fontSize: 15, fontWeight: '600' },
  navTitle: { flex: 1, textAlign: 'center', fontSize: 16, fontWeight: '700' },
  navRight: { width: 76, alignItems: 'flex-end' },
  refresh: { fontSize: 13, fontWeight: '600' },
  content: { paddingHorizontal: 16, paddingBottom: 40 },
  center: { alignItems: 'center', paddingTop: 60, gap: 10 },
  runningText: { fontSize: 13.5, fontWeight: '600' },
  hint: { fontSize: 11.5, lineHeight: 17 },
  block: { marginBottom: 12 },
  thinTitle: { fontSize: 16, fontWeight: '800' },
  thinDesc: { fontSize: 13, lineHeight: 20, marginTop: 8 },
  primaryBtn: { height: 44, alignItems: 'center', justifyContent: 'center', marginTop: 14 },
  primaryText: { fontSize: 14.5, fontWeight: '700' },
  tagRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 10 },
  summary: { fontSize: 15, lineHeight: 23, fontWeight: '700' },
  section: { fontSize: 12.5, fontWeight: '700', marginBottom: 6, marginTop: 4 },
  point: { marginBottom: 10 },
  pointHead: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  index: { width: 22, height: 22, borderRadius: 11, alignItems: 'center', justifyContent: 'center' },
  indexText: { fontSize: 12, fontWeight: '800' },
  pointTitle: { flex: 1, fontSize: 15, fontWeight: '800' },
  pointDetail: { fontSize: 13, lineHeight: 20, marginTop: 8 },
  actionBox: { paddingHorizontal: 10, paddingVertical: 8, marginTop: 10 },
  actionText: { fontSize: 12.5, lineHeight: 19, fontWeight: '600' },
  cardTitle: { fontSize: 12.5, fontWeight: '700', marginBottom: 8 },
  planRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 8, paddingVertical: 5 },
  checkbox: { width: 20, height: 20, borderRadius: 6, borderWidth: 1.2, alignItems: 'center', justifyContent: 'center' },
  planIndex: { fontSize: 11, fontWeight: '700' },
  planText: { flex: 1, fontSize: 13.5, lineHeight: 20 },
  footerRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 4 },
  ghostBtn: { flex: 1, height: 44, alignItems: 'center', justifyContent: 'center', borderWidth: 1 },
  ghostText: { fontSize: 14, fontWeight: '700' },
  disclaimer: { fontSize: 11, lineHeight: 17, marginTop: 14, textAlign: 'center' },
});
