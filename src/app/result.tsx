/**
 * 练习结果页：分数概览 + 逐题回顾 + 错题入本提示。
 * 视觉层跟随用户所选主题，业务逻辑与跳转保持不变。
 */
import React, { useMemo } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { Theme } from '../constants/theme';
import { modeLabels, typeLabels } from '../constants/theme';
import { useTheme } from '../store/ThemeContext';
import { Card, SectionTitle, Tag } from '../components/ui';
import { CheckIcon, CloseIcon } from '../components/icons';
import { formatScore } from '../services/quizEngine';
import { getSession } from '../store/sessionStore';

export default function ResultScreen() {
  const t = useTheme();
  const styles = useMemo(() => buildStyles(t), [t]);
  const insets = useSafeAreaInsets();
  const session = useMemo(() => getSession(), []);

  const stats = useMemo(() => {
    const records = session?.records ?? [];
    const total = session?.questions.length ?? 0;
    const answered = records.length;
    const correct = records.filter((r) => r.correct).length;
    const accuracy = answered === 0 ? 0 : Math.round((correct / answered) * 100);
    // 得分口径：没有 score 的记录（断点恢复的老数据）按对错折算，不会凭空少给分
    const score = records.reduce((sum, r) => sum + (r.score ?? (r.correct ? 1 : 0)), 0);
    const partial = records.filter((r) => (r.score ?? (r.correct ? 1 : 0)) === 0.5).length;
    return { total, answered, correct, wrong: answered - correct, accuracy, score, partial };
  }, [session]);

  const byType = useMemo(() => {
    const map = new Map<string, { attempts: number; correct: number }>();
    (session?.records ?? []).forEach((r) => {
      const q = session?.questions.find((item) => item.id === r.questionId);
      if (!q) return;
      const cur = map.get(q.type) ?? { attempts: 0, correct: 0 };
      map.set(q.type, { attempts: cur.attempts + 1, correct: cur.correct + (r.correct ? 1 : 0) });
    });
    return Array.from(map.entries()).map(([type, v]) => ({ type, ...v }));
  }, [session]);

  const tone = stats.accuracy >= 80 ? 'success' : stats.accuracy >= 50 ? 'warn' : 'danger';
  const headline = stats.accuracy >= 80 ? '稳得很' : stats.accuracy >= 50 ? '再有把握一点' : '值得再刷一轮';

  /** 模考用时：从进入考试页到交卷的墙上时间。日常练习不显示，因为中途退出重进会让它失真 */
  const elapsedLabel = useMemo(() => {
    if (session?.mode !== 'exam') return '';
    const start = new Date(session.startedAt).getTime();
    if (!Number.isFinite(start)) return '';
    const min = Math.max(1, Math.round((Date.now() - start) / 60000));
    return min >= 60 ? `${Math.floor(min / 60)} 小时 ${min % 60} 分` : `${min} 分钟`;
  }, [session]);

  if (!session) {
    return (
      <View style={[styles.root, { paddingTop: insets.top }]}>
        <View style={styles.emptyWrap}>
          <Text style={styles.emptyText}>这一轮没有可展示的作答记录</Text>
          <Pressable accessibilityRole="button" onPress={() => router.replace('/')} style={styles.primaryBtn}>
            <Text style={styles.primaryBtnText}>回首页</Text>
          </Pressable>
        </View>
      </View>
    );
  }

  return (
    <View style={[styles.root, { paddingTop: insets.top }]}>
      <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerStyle={styles.scroll}>
        <Card style={styles.scoreCard} padded>
          <Text style={styles.scoreKicker}>{modeLabels[session.mode] ?? '练习'} · {session.bankName}</Text>
          <View style={styles.scoreRow}>
            <View style={styles.scoreLeft}>
              <Text style={[styles.scoreValue, { color: t.palette[tone === 'success' ? 'success' : tone === 'warn' ? 'warn' : 'danger'] }]}>
                {stats.accuracy}
              </Text>
              <Text style={styles.scoreUnit}>% 正确率</Text>
            </View>
            <View style={styles.scoreRight}>
              <Text style={styles.headline}>{headline}</Text>
              <View style={styles.tagRow}>
                <Tag label={`共 ${stats.total} 题`} tone="neutral" />
                <Tag label={`已答 ${stats.answered}`} tone="primary" />
                <Tag label={`错 ${stats.wrong}`} tone={stats.wrong > 0 ? 'danger' : 'success'} />
                {stats.partial > 0 ? <Tag label={`得分 ${formatScore(stats.score)}`} tone="ai" /> : null}
                {elapsedLabel ? <Tag label={`用时 ${elapsedLabel}`} tone="ai" /> : null}
                {stats.answered < stats.total ? <Tag label={`未作答 ${stats.total - stats.answered}`} tone="neutral" /> : null}
              </View>
            </View>
          </View>
          <View style={styles.track}>
            <View style={[styles.fill, { width: `${Math.max(2, stats.accuracy)}%` }]} />
          </View>
          {stats.partial > 0 ? (
            <Text style={{ fontSize: 11.5, color: t.palette.textMuted, marginTop: 8, lineHeight: 17 }}>
              多选题漏选得半分、错选不得分：本轮有 {stats.partial} 题拿到半分，合计得分 {formatScore(stats.score)} /{' '}
              {stats.answered} 分。正确率与错题本仍按「全对才算答对」统计，两个口径各说各的事。
            </Text>
          ) : null}
        </Card>

        {byType.length > 0 ? (
          <Card style={styles.block} padded>
            <SectionTitle title="分题型表现" hint="看哪类题还需要加强" />
            <View style={styles.typeList}>
              {byType.map((row) => {
                const acc = row.attempts === 0 ? 0 : Math.round((row.correct / row.attempts) * 100);
                return (
                  <View key={row.type} style={styles.typeRow}>
                    <Text style={styles.typeLabel}>{typeLabels[row.type] ?? row.type}</Text>
                    <View style={styles.typeBar}>
                      <View style={[styles.typeFill, { width: `${Math.max(3, acc)}%` }]} />
                    </View>
                    <Text style={styles.typeValue}>{acc}%</Text>
                    <Text style={styles.typeCount}>{row.correct}/{row.attempts}</Text>
                  </View>
                );
              })}
            </View>
          </Card>
        ) : null}

        <Card style={styles.block} padded>
          <SectionTitle title="逐题回顾" hint="点题目可以看当时怎么答的" />
          <View style={styles.reviewList}>
            {(session?.questions ?? []).slice(0, 40).map((q, i) => {
              const rec = (session?.records ?? []).find((r) => r.questionId === q.id);
              const ok = rec ? rec.correct : null;
              const half = ok === false && (rec?.score ?? 0) === 0.5;
              return (
                <View key={q.id} style={styles.reviewRow}>
                  <View style={styles.reviewIndex}>
                    <Text style={styles.reviewIndexText}>{i + 1}</Text>
                  </View>
                  <View style={styles.reviewBody}>
                    <Text style={styles.reviewStem} numberOfLines={2}>
                      {q.stem}
                    </Text>
                    <Text style={styles.reviewMeta}>
                      {typeLabels[q.type] ?? q.type}
                      {rec?.manual ? ' · 手动判定' : ''}
                      {ok === null ? ' · 未作答' : ''}
                      {half ? ' · 漏选得半分' : ''}
                    </Text>
                    {rec?.reason ? (
                      <Text style={{ fontSize: 11, color: t.palette.textMuted, lineHeight: 16, marginTop: 2 }} numberOfLines={2}>
                        {rec.reason}
                      </Text>
                    ) : null}
                  </View>
                  {ok === null ? (
                    <Text style={styles.reviewSkip}>—</Text>
                  ) : ok ? (
                    <CheckIcon size={17} color={t.palette.success} />
                  ) : half ? (
                    <Text style={{ fontSize: 14, fontWeight: '700', color: t.palette.warn }}>0.5</Text>
                  ) : (
                    <CloseIcon size={17} color={t.palette.danger} />
                  )}
                </View>
              );
            })}
          </View>
        </Card>

        {stats.wrong > 0 ? (
          <View style={styles.hintRow}>
            <Text style={styles.hintText}>{stats.wrong} 道错题已自动进入错题本，建议明天用「错题模式」再清一遍。</Text>
          </View>
        ) : null}

        <View style={styles.actions}>
          <Pressable
            accessibilityRole="button"
            onPress={() => router.replace({ pathname: '/quiz', params: { id: session.bankId, name: session.bankName } })}
            style={({ pressed }) => [styles.primaryBtn, pressed ? styles.pressed : null]}
          >
            <Text style={styles.primaryBtnText}>再来一轮</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            onPress={() => router.replace('/wrong')}
            style={({ pressed }) => [styles.secondaryBtn, pressed ? styles.pressed : null]}
          >
            <Text style={styles.secondaryBtnText}>查看错题本</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            onPress={() => router.replace('/')}
            style={({ pressed }) => [styles.ghostBtn, pressed ? styles.pressed : null]}
          >
            <Text style={styles.ghostBtnText}>返回首页</Text>
          </Pressable>
        </View>

        <View style={{ height: sp_bottom(insets.bottom) }} />
      </ScrollView>
    </View>
  );
}

function sp_bottom(bottom: number): number {
  return bottom + 40;
}

function buildStyles(t: Theme) {
  const c = t.palette;
  const r = t.radius;
  const sp = t.spacing;
  return StyleSheet.create({
    root: { flex: 1, backgroundColor: c.bg },
    scroll: { paddingHorizontal: sp.lg, paddingTop: sp.lg },
    emptyWrap: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: sp.xl, gap: sp.lg },
    emptyText: { fontSize: 14, color: c.textSub, textAlign: 'center' },
    scoreCard: { marginBottom: sp.md },
    scoreKicker: { fontSize: 12, color: c.textMuted, fontWeight: '600' },
    scoreRow: { flexDirection: 'row', alignItems: 'flex-end', gap: sp.lg, marginTop: sp.sm },
    scoreLeft: { flexDirection: 'row', alignItems: 'baseline', gap: 4 },
    scoreValue: { fontSize: 44, fontWeight: '800', letterSpacing: -1 },
    scoreUnit: { fontSize: 13, color: c.textSub, fontWeight: '600' },
    scoreRight: { flex: 1 },
    headline: { fontSize: 15, fontWeight: '700', color: c.text },
    tagRow: { flexDirection: 'row', flexWrap: 'wrap', gap: sp.xs, marginTop: sp.xs },
    track: {
      height: 8,
      borderRadius: r.pill,
      backgroundColor: c.track,
      marginTop: sp.md,
      overflow: 'hidden',
    },
    fill: { height: 8, borderRadius: r.pill, backgroundColor: c.primary },
    block: { marginBottom: sp.md },
    typeList: { marginTop: sp.sm, gap: sp.sm },
    typeRow: { flexDirection: 'row', alignItems: 'center', gap: sp.sm },
    typeLabel: { width: 56, fontSize: 12.5, color: c.textSub, fontWeight: '600' },
    typeBar: { flex: 1, height: 6, borderRadius: r.pill, backgroundColor: c.track, overflow: 'hidden' },
    typeFill: { height: 6, borderRadius: r.pill, backgroundColor: c.accent },
    typeValue: { width: 38, fontSize: 12, color: c.text, fontWeight: '700', textAlign: 'right' },
    typeCount: { width: 40, fontSize: 11.5, color: c.textMuted, textAlign: 'right' },
    reviewList: { marginTop: sp.sm, gap: sp.xs },
    reviewRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: sp.sm,
      paddingVertical: sp.sm,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderColor: c.border,
    },
    reviewIndex: {
      width: 26,
      height: 26,
      borderRadius: r.sm,
      backgroundColor: c.surfaceAlt,
      alignItems: 'center',
      justifyContent: 'center',
    },
    reviewIndexText: { fontSize: 11.5, color: c.textSub, fontWeight: '700' },
    reviewBody: { flex: 1 },
    reviewStem: { fontSize: 13.5, color: c.text, lineHeight: 19 },
    reviewMeta: { fontSize: 11.5, color: c.textMuted, marginTop: 2 },
    reviewSkip: { fontSize: 14, color: c.textMuted, width: 18, textAlign: 'center' },
    hintRow: {
      backgroundColor: c.warnSoft,
      borderRadius: r.md,
      padding: sp.md,
      marginBottom: sp.md,
    },
    hintText: { fontSize: 12.5, lineHeight: 19, color: c.warn },
    actions: { gap: sp.sm, marginTop: sp.xs },
    primaryBtn: {
      height: 50,
      borderRadius: r.md,
      backgroundColor: c.primary,
      alignItems: 'center',
      justifyContent: 'center',
      ...t.shadow.raised,
    },
    primaryBtnText: { fontSize: 15.5, fontWeight: '700', color: c.onPrimary },
    secondaryBtn: {
      height: 48,
      borderRadius: r.md,
      borderWidth: t.borderWidth,
      borderColor: c.primary,
      backgroundColor: c.primarySoft,
      alignItems: 'center',
      justifyContent: 'center',
    },
    secondaryBtnText: { fontSize: 15, fontWeight: '700', color: c.primaryDark },
    ghostBtn: {
      height: 44,
      borderRadius: r.md,
      alignItems: 'center',
      justifyContent: 'center',
    },
    ghostBtnText: { fontSize: 14, fontWeight: '600', color: c.textSub },
    pressed: { opacity: 0.9 },
  });
}
