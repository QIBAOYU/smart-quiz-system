/** 学习统计页：全部题库总览 + 分题型正确率 + 每个题库的独立数据（可下钻到单题库详情） */
import React, { useCallback, useMemo, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native';
import { useFocusEffect } from 'expo-router';
import { router } from 'expo-router';
import { typeShortLabels } from '../../constants/theme';
import type { Theme } from '../../constants/theme';
import { useTheme } from '../../store/ThemeContext';
import { StatTile, Tag } from '../../components/ui';
import { Segmented } from '../../components/Segmented';
import { TrendChart } from '../../components/TrendChart';
import { ForgettingCurveCard } from '../../components/ForgettingCurveCard';
import { useTaskInset } from '../../components/AiTaskLayer';
import { loadStats } from '../../services/statsService';
import type { StatsSummary } from '../../types/quiz';

export default function StatsScreen() {
  const t = useTheme();
  const styles = useMemo(() => buildStyles(t), [t]);
  const taskInset = useTaskInset();
  const [summary, setSummary] = useState<StatsSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  /** 底部列表的两个维度：分题库 / 分科目 */
  const [bankTab, setBankTab] = useState<'bank' | 'subject'>('bank');

  const load = useCallback(async () => {
    try {
      const s = await loadStats();
      setSummary(s);
    } catch (error) {
      console.error('[stats] load failed:', error);
    } finally {
      setLoading(false);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      load().catch((error) => console.error('[stats] focus load failed:', error));
    }, [load]),
  );

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    load().finally(() => setRefreshing(false));
  }, [load]);

  const openBankStats = useCallback((id: string, name: string) => {
    router.push({ pathname: '/bank-stats', params: { id, name } });
  }, []);

  /** 从科目行直接进入「只刷该科错题」的错题本 */
  const openSubjectWrong = useCallback((subject: string) => {
    router.push({ pathname: '/wrong', params: { subject, name: subject } });
  }, []);

  if (loading) {
    return (
      <View style={[styles.root, styles.center, { paddingTop: taskInset }]}>
        <ActivityIndicator color={t.palette.primary} />
      </View>
    );
  }

  const s = summary;
  // statsService 返回的 accuracy 已是 0-100 的百分数，这里只做兜底钳制，绝不能再乘 100
  const acc = s ? Math.max(0, Math.min(100, Math.round(s.accuracy))) : 0;
  // 总掌握度与分题型同口径：已掌握 = 该题最近一次答对且错题已清
  const allCount = s?.questionCount ?? 0;
  const masteredCount = Math.min(s?.masteredQuestions ?? 0, allCount);
  const masterRate = allCount > 0 ? Math.max(0, Math.min(100, Math.round((masteredCount / allCount) * 100))) : 0;
  const masterColor = masterRate >= 80 ? t.palette.success : masterRate >= 60 ? t.palette.primary : t.palette.warn;

  return (
    <View style={[styles.root, { paddingTop: taskInset }]}>
      <FlatList
        data={s ? s.byType : []}
        keyExtractor={(item) => item.type}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={t.palette.primary} />}
        contentContainerStyle={styles.list}
        ListHeaderComponent={
          <View>
            <Text style={styles.pageTitle}>学习统计</Text>
            <Text style={styles.pageSub}>下拉可刷新，数据来自你的作答记录</Text>

            <View style={styles.masterCard}>
              <View style={styles.masterHead}>
                <Text style={styles.masterTitle}>总掌握度</Text>
                <Text style={[styles.masterRate, { color: allCount > 0 ? masterColor : t.palette.textMuted }]}>
                  {allCount > 0 ? `${masterRate}%` : '—'}
                </Text>
              </View>
              <View style={styles.track}>
                <View style={[styles.fill, { width: `${Math.max(masterRate, 2)}%`, backgroundColor: masterColor }]} />
              </View>
              <Text style={styles.masterLine}>
                已掌握 {masteredCount} / 全部 {allCount} 题
              </Text>
              <Text style={styles.masterHint}>
                已掌握 = 该题最近一次答对，且没有还挂在错题本待消灭；从未作答的题不计入。
              </Text>
            </View>

            <View style={styles.gridRow}>
              <View style={styles.gridCell}>
                <StatTile value={`${acc}%`} label="总正确率" tone={acc >= 80 ? 'success' : acc >= 60 ? 'primary' : 'danger'} />
              </View>
              <View style={styles.gridCell}>
                <StatTile value={String(s?.totalAttempts ?? 0)} label="累计作答" />
              </View>
            </View>
            <View style={styles.gridRow}>
              <View style={styles.gridCell}>
                <StatTile value={String(s?.todayCount ?? 0)} label="今日题量" />
              </View>
              <View style={styles.gridCell}>
                <StatTile value={`${s?.streakDays ?? 0} 天`} label="连续刷题" tone="primary" />
              </View>
            </View>

            <View style={styles.card}>
              <Text style={styles.cardTitle}>近 7 日趋势</Text>
              <TrendChart data={s?.last7 ?? []} />
            </View>

            <View style={styles.card}>
              <Text style={styles.cardTitle}>掌握情况</Text>
              <View style={styles.miniRow}>
                <View style={styles.mini}>
                  <Text style={[styles.miniValue, { color: t.palette.success }]}>{s?.masteredCount ?? 0}</Text>
                  <Text style={styles.miniLabel}>已攻克错题</Text>
                </View>
                <View style={styles.miniDivider} />
                <View style={styles.mini}>
                  <Text style={[styles.miniValue, { color: t.palette.danger }]}>{s?.wrongPending ?? 0}</Text>
                  <Text style={styles.miniLabel}>待消灭错题</Text>
                </View>
                <View style={styles.miniDivider} />
                <View style={styles.mini}>
                  <Text style={[styles.miniValue, { color: t.palette.primary }]}>{s?.questionCount ?? 0}</Text>
                  <Text style={styles.miniLabel}>题库总题量</Text>
                </View>
              </View>
              <Pressable
                accessibilityRole="button"
                onPress={() => router.push('/wrong')}
                style={({ pressed }) => [styles.wrongBtn, pressed ? styles.pressed : null]}
              >
                <Text style={styles.wrongBtnText}>进入错题本</Text>
                <Tag label={`${s?.wrongPending ?? 0} 题`} tone={s && s.wrongPending > 0 ? 'danger' : 'neutral'} />
              </Pressable>
            </View>

            <ForgettingCurveCard />

            <View style={styles.card}>
              <Text style={styles.cardTitle}>AI 薄弱点诊断</Text>
              <Text style={styles.cardHint}>
                把分科目、分题型的真实表现交给 AI，让它指出最该补的地方，并给出今天就能执行的练习安排。
              </Text>
              <Pressable
                accessibilityRole="button"
                onPress={() => router.push('/diagnosis')}
                style={({ pressed }) => [styles.wrongBtn, pressed ? styles.pressed : null]}
              >
                <Text style={styles.wrongBtnText}>生成诊断报告</Text>
                <Tag label={`${s?.totalAttempts ?? 0} 次作答`} tone="ai" />
              </Pressable>
            </View>

            <View style={styles.card}>
              <Text style={styles.cardTitle}>分科目正确率</Text>
              <Text style={styles.cardHint}>
                科目由 AI 自动识别，未识别的题归入「未分类」。点击「错题」可只刷该科目的错题。
              </Text>
              {(s?.bySubject ?? []).length === 0 ? (
                <Text style={styles.emptyText}>还没有科目数据，导入题库后会自动进行 AI 科目识别。</Text>
              ) : (
                (s?.bySubject ?? []).map((sub) => {
                  const total = sub.total ?? 0;
                  const mastered = Math.min(sub.masteredQuestions ?? 0, total);
                  const rate = total > 0 ? Math.max(0, Math.min(100, Math.round((mastered / total) * 100))) : 0;
                  const barColor = rate >= 80 ? t.palette.success : rate >= 60 ? t.palette.primary : t.palette.warn;
                  return (
                    <View key={sub.subject} style={styles.bankRow}>
                      <View style={styles.bankHead}>
                        <Text style={styles.bankName} numberOfLines={1}>
                          {sub.subject}
                        </Text>
                        <Text style={[styles.bankRate, { color: barColor }]}>{total > 0 ? `${rate}%` : '—'}</Text>
                        <Pressable
                          accessibilityRole="button"
                          onPress={() => openSubjectWrong(sub.subject)}
                          style={({ pressed }) => [styles.bankBtn, pressed ? styles.bankBtnPressed : null]}
                        >
                          <Text style={styles.bankBtnText}>错题 ›</Text>
                        </Pressable>
                      </View>
                      <View style={styles.bankTrack}>
                        <View
                          style={[styles.bankFill, { width: `${Math.max(rate, 2)}%`, backgroundColor: barColor }]}
                        />
                      </View>
                      <Text style={styles.bankMeta}>
                        {total > 0
                          ? `掌握 ${mastered}/${total} 题 · ${
                              sub.attempts > 0 ? `作答 ${sub.attempts} 次，次数正确率 ${sub.accuracy}%` : '还没有作答记录'
                            }`
                          : '该科目暂无题目'}
                      </Text>
                    </View>
                  );
                })
              )}
            </View>

            <Text style={styles.sectionLabel}>分题型正确率</Text>
            <Text style={styles.sectionHint}>按「已掌握题数 / 本题型题目总数」计算，口径与顶部总掌握度一致</Text>
          </View>
        }
        renderItem={({ item }) => {
          // 主口径：已掌握题数 / 该题型题目总数；副行保留按作答次数的正确率
          const total = item.total ?? 0;
          const mastered = Math.min(item.masteredQuestions ?? 0, total);
          const rate = total > 0 ? Math.max(0, Math.min(100, Math.round((mastered / total) * 100))) : 0;
          const attemptRate =
            item.attempts > 0 ? Math.max(0, Math.min(100, Math.round((item.correct / item.attempts) * 100))) : 0;
          const barColor = rate >= 80 ? t.palette.success : rate >= 60 ? t.palette.primary : t.palette.warn;
          return (
            <View style={styles.typeCard}>
              <View style={styles.typeHead}>
                <Text style={styles.typeName}>{typeShortLabels[item.type] ?? item.type}</Text>
                <Text style={styles.typeMeta}>
                  {total > 0 ? `掌握 ${mastered}/${total} 题 · ${rate}%` : '本题型暂无题目'}
                </Text>
              </View>
              <View style={styles.track}>
                <View style={[styles.fill, { width: `${Math.max(rate, 2)}%`, backgroundColor: barColor }]} />
              </View>
              <Text style={styles.typeFoot}>
                {item.attempts > 0
                  ? `累计作答 ${item.attempts} 次，其中 ${item.correct} 次正确 · 次数正确率 ${attemptRate}%`
                  : '本题型还没有作答记录'}
              </Text>
            </View>
          );
        }}
        ListEmptyComponent={
          <View style={styles.emptyBlock}>
            <Text style={styles.emptyText}>还没有可统计的题目，先去导入一份题库吧。</Text>
          </View>
        }
        ListFooterComponent={
          <View style={styles.card}>
            <Text style={styles.cardTitle}>{bankTab === 'bank' ? '分题库表现' : '分科目表现'}</Text>
            <Text style={styles.cardHint}>
              {bankTab === 'bank'
                ? '点击「详情」可查看该题库的分题型数据与专属错题本'
                : '科目由 AI 自动识别；点击「错题」只刷该科错题（错题可能横跨多个题库）'}
            </Text>
            <Segmented
              options={[
                { value: 'bank', label: '题库' },
                { value: 'subject', label: '科目' },
              ]}
              value={bankTab}
              onChange={(v) => setBankTab(v as 'bank' | 'subject')}
              stretch
              style={{ marginBottom: 4 }}
            />
            {bankTab === 'subject' ? null : (s?.byBank ?? []).length === 0 ? (
              <Text style={styles.emptyText}>暂无题库，先去导入一份资料吧。</Text>
            ) : (
              (s?.byBank ?? []).map((b) => {
                const rate = Math.max(0, Math.min(100, Math.round(b.accuracy)));
                const barColor = rate >= 80 ? t.palette.success : rate >= 60 ? t.palette.primary : t.palette.warn;
                return (
                  <View key={b.id} style={styles.bankRow}>
                    <View style={styles.bankHead}>
                      <Text style={styles.bankName} numberOfLines={1}>
                        {b.name}
                      </Text>
                      <Text style={[styles.bankRate, { color: barColor }]}>{b.count > 0 ? `${rate}%` : '—'}</Text>
                      <Pressable
                        accessibilityRole="button"
                        onPress={() => openBankStats(b.id, b.name)}
                        style={({ pressed }) => [styles.bankBtn, pressed ? styles.bankBtnPressed : null]}
                      >
                        <Text style={styles.bankBtnText}>详情 ›</Text>
                      </Pressable>
                    </View>
                    <View style={styles.bankTrack}>
                      <View style={[styles.bankFill, { width: `${Math.max(rate, 2)}%`, backgroundColor: barColor }]} />
                    </View>
                    <Text style={styles.bankMeta}>{b.count > 0 ? `作答 ${b.count} 次` : '还没有作答记录'}</Text>
                  </View>
                );
              })
            )}
            {bankTab === 'subject' ? (
              (s?.bySubject ?? []).length === 0 ? (
                <Text style={styles.emptyText}>还没有识别出科目，导入题库后会自动进行 AI 科目识别。</Text>
              ) : (
                (s?.bySubject ?? []).map((sub) => {
                  const rate = Math.max(0, Math.min(100, Math.round(sub.accuracy)));
                  const barColor = rate >= 80 ? t.palette.success : rate >= 60 ? t.palette.primary : t.palette.warn;
                  return (
                    <View key={sub.subject} style={styles.bankRow}>
                      <View style={styles.bankHead}>
                        <Text style={styles.bankName} numberOfLines={1}>
                          {sub.subject}
                        </Text>
                        <Text style={[styles.bankRate, { color: sub.attempts > 0 ? barColor : t.palette.textMuted }]}>
                          {sub.attempts > 0 ? `${rate}%` : '—'}
                        </Text>
                        <Pressable
                          accessibilityRole="button"
                          onPress={() => openSubjectWrong(sub.subject)}
                          style={({ pressed }) => [styles.bankBtn, pressed ? styles.bankBtnPressed : null]}
                        >
                          <Text style={styles.bankBtnText}>错题 ›</Text>
                        </Pressable>
                      </View>
                      <View style={styles.bankTrack}>
                        <View
                          style={[styles.bankFill, { width: `${Math.max(sub.attempts > 0 ? rate : 0, 2)}%`, backgroundColor: barColor }]}
                        />
                      </View>
                      <Text style={styles.bankMeta}>
                        {sub.attempts > 0
                          ? `作答 ${sub.attempts} 次 · 共 ${sub.total} 题，已掌握 ${sub.masteredQuestions}`
                          : `共 ${sub.total} 题，还没有作答记录`}
                      </Text>
                    </View>
                  );
                })
              )
            ) : null}
          </View>
        }
      />
    </View>
  );
}

function buildStyles(t: Theme) {
  const c = t.palette;
  const r = t.radius;
  const sp = t.spacing;
  const cardBase = {
    backgroundColor: t.cardBg,
    borderRadius: t.cardRadius,
    borderWidth: t.borderWidth,
    borderColor: c.border,
    padding: sp.lg,
    marginBottom: sp.lg,
    ...t.shadow.card,
  };
  return StyleSheet.create({
    root: { flex: 1, backgroundColor: c.bg },
    center: { alignItems: 'center', justifyContent: 'center' },
    list: { paddingHorizontal: sp.lg, paddingTop: sp.md, paddingBottom: sp.xxl * 2 },
    pageTitle: { fontSize: 22, fontWeight: '800', color: c.text, marginTop: sp.sm },
    pageSub: { fontSize: 12.5, color: c.textMuted, marginTop: 2, marginBottom: sp.lg },
    gridRow: { flexDirection: 'row', gap: sp.md, marginBottom: sp.md },
    gridCell: { flex: 1 },
    masterCard: { ...cardBase, padding: sp.md },
    masterHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: sp.sm },
    masterTitle: { fontSize: 14, fontWeight: '700', color: c.text },
    masterRate: { fontSize: 22, fontWeight: '800' },
    masterLine: { fontSize: 12.5, color: c.textSub, marginTop: sp.sm },
    masterHint: { fontSize: 11, lineHeight: 17, color: c.textMuted, marginTop: 3 },
    card: cardBase,
    cardTitle: { fontSize: 13, color: c.textMuted, fontWeight: '600', marginBottom: sp.sm },
    cardHint: { fontSize: 11.5, color: c.textMuted, lineHeight: 17, marginBottom: sp.sm },
    miniRow: { flexDirection: 'row', alignItems: 'center', marginTop: sp.sm },
    mini: { flex: 1, alignItems: 'center' },
    miniValue: { fontSize: 22, fontWeight: '800' },
    miniLabel: { fontSize: 11.5, color: c.textMuted, marginTop: 2 },
    miniDivider: { width: StyleSheet.hairlineWidth, height: 34, backgroundColor: c.border },
    wrongBtn: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      marginTop: sp.lg,
      paddingTop: sp.md,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: c.border,
    },
    wrongBtnText: { fontSize: 13.5, fontWeight: '700', color: c.primary },
    sectionLabel: { fontSize: 13, color: c.textMuted, fontWeight: '600', marginBottom: 2 },
    sectionHint: { fontSize: 11.5, color: c.textMuted, lineHeight: 17, marginBottom: sp.sm },
    typeCard: {
      ...cardBase,
      padding: sp.md,
      marginBottom: sp.sm,
    },
    typeHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: sp.sm },
    typeName: { fontSize: 14, fontWeight: '700', color: c.text },
    typeMeta: { fontSize: 12, color: c.textSub },
    track: { height: 7, borderRadius: r.pill, backgroundColor: c.track, overflow: 'hidden' },
    fill: { height: 7, borderRadius: r.pill },
    typeFoot: { fontSize: 11, color: c.textMuted, marginTop: 5 },
    emptyBlock: { paddingTop: sp.xl, alignItems: 'center' },
    emptyText: { fontSize: 12.5, color: c.textMuted },
    bankRow: { paddingVertical: sp.md, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: c.border },
    bankHead: { flexDirection: 'row', alignItems: 'center', gap: sp.sm },
    bankName: { flex: 1, fontSize: 13.5, fontWeight: '600', color: c.text },
    bankMeta: { fontSize: 11, color: c.textMuted, marginTop: 4 },
    bankRate: { fontSize: 15, fontWeight: '800', minWidth: 40, textAlign: 'right' },
    bankBtn: {
      paddingHorizontal: sp.md,
      paddingVertical: 5,
      borderRadius: r.pill,
      borderWidth: t.borderWidth,
      borderColor: c.primary,
      backgroundColor: c.primarySoft,
    },
    bankBtnText: { fontSize: 11.5, fontWeight: '700', color: c.primaryDark },
    bankBtnPressed: { opacity: 0.75 },
    bankTrack: { marginTop: sp.sm, height: 6, borderRadius: r.pill, backgroundColor: c.track, overflow: 'hidden' },
    bankFill: { height: 6, borderRadius: r.pill },
    pressed: { opacity: 0.9 },
  });
}
