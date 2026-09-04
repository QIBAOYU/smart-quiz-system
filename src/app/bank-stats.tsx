/**
 * 单题库统计详情：本题库正确率、近 7 日趋势、分题型数据，
 * 并提供只针对本题库的错题本入口。
 */
import React, { useCallback, useMemo, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native';
import { useFocusEffect, useLocalSearchParams, router } from 'expo-router';
import { typeShortLabels } from '../constants/theme';
import type { Theme } from '../constants/theme';
import { useTheme } from '../store/ThemeContext';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { StatTile, Tag } from '../components/ui';
import { TrendChart } from '../components/TrendChart';
import { loadBankStats, type BankStats } from '../services/statsService';

export default function BankStatsScreen() {
  const t = useTheme();
  const styles = useMemo(() => buildStyles(t), [t]);
  const c = t.palette;
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{ id?: string; name?: string }>();
  const bankId = typeof params.id === 'string' ? params.id : '';
  const fallbackName = typeof params.name === 'string' && params.name ? params.name : '题库';

  const [stats, setStats] = useState<BankStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    if (!bankId) {
      setLoading(false);
      return;
    }
    try {
      const s = await loadBankStats(bankId);
      setStats(s);
    } catch (error) {
      console.error('[bank-stats] load failed:', error);
    } finally {
      setLoading(false);
    }
  }, [bankId]);

  useFocusEffect(
    useCallback(() => {
      load().catch((error) => console.error('[bank-stats] focus load failed:', error));
    }, [load]),
  );

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    load().finally(() => setRefreshing(false));
  }, [load]);

  const title = stats?.bankName ?? fallbackName;
  // loadBankStats 返回的 accuracy 已是 0-100 百分数，只做兜底钳制
  const acc = stats ? Math.max(0, Math.min(100, Math.round(stats.accuracy))) : 0;

  if (loading) {
    return (
      <View style={[styles.root, { paddingTop: insets.top + t.spacing.md }]}>
        <View style={styles.center}>
          <ActivityIndicator color={c.primary} />
        </View>
      </View>
    );
  }

  return (
    <View style={[styles.root, { paddingTop: insets.top + t.spacing.md }]}>
      <View style={styles.nav}>
        <Pressable
          accessibilityRole="button"
          onPress={() => (router.canGoBack() ? router.back() : router.replace('/'))}
          hitSlop={12}
          style={styles.back}
        >
          <Text style={styles.backText}>‹ 返回</Text>
        </Pressable>
        <Text style={styles.navTitle} numberOfLines={1}>
          {title}
        </Text>
        <View style={styles.navRight} />
      </View>

      <FlatList
        data={stats ? stats.byType : []}
        keyExtractor={(item) => item.type}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={c.primary} />}
        contentContainerStyle={styles.list}
        ListHeaderComponent={
          <View>
            <Text style={styles.pageSub}>本题库独立统计，下拉可刷新</Text>

            <View style={styles.gridRow}>
              <View style={styles.gridCell}>
                <StatTile
                  value={stats && stats.attempts > 0 ? `${acc}%` : '—'}
                  label="题库正确率"
                  tone={acc >= 80 ? 'success' : acc >= 60 ? 'primary' : 'danger'}
                />
              </View>
              <View style={styles.gridCell}>
                <StatTile value={String(stats?.attempts ?? 0)} label="累计作答" />
              </View>
            </View>
            <View style={styles.gridRow}>
              <View style={styles.gridCell}>
                <StatTile value={String(stats?.questionCount ?? 0)} label="题目总数" tone="neutral" />
              </View>
              <View style={styles.gridCell}>
                <StatTile value={`${stats?.todayCount ?? 0} / ${stats?.streakDays ?? 0} 天`} label="今日题量 / 连续" tone="neutral" />
              </View>
            </View>

            <View style={styles.card}>
              <Text style={styles.cardTitle}>已确认题目</Text>
              <Text style={styles.bigLine}>
                {stats?.reviewedCount ?? 0}
                <Text style={styles.bigLineSub}> / {stats?.questionCount ?? 0} 题</Text>
              </Text>
              <Text style={styles.hintLine}>
                {stats && stats.questionCount > 0
                  ? `确认进度 ${Math.max(0, Math.min(100, Math.round(((stats.reviewedCount ?? 0) / stats.questionCount) * 100)))}%，未确认的题目建议先在题库页核对答案。`
                  : '本题库还没有题目。'}
              </Text>
            </View>

            <View style={styles.card}>
              <Text style={styles.cardTitle}>近 7 日本题库趋势</Text>
              <TrendChart data={stats?.last7 ?? []} />
            </View>

            <View style={styles.card}>
              <Text style={styles.cardTitle}>本题库错题</Text>
              <View style={styles.miniRow}>
                <View style={styles.mini}>
                  <Text style={[styles.miniValue, { color: c.danger }]}>{stats?.wrongPending ?? 0}</Text>
                  <Text style={styles.miniLabel}>待消灭错题</Text>
                </View>
                <View style={styles.miniDivider} />
                <View style={styles.mini}>
                  <Text style={[styles.miniValue, { color: c.success }]}>{stats?.masteredCount ?? 0}</Text>
                  <Text style={styles.miniLabel}>已攻克错题</Text>
                </View>
              </View>
              <Pressable
                accessibilityRole="button"
                onPress={() => router.push({ pathname: '/wrong', params: { bankId, name: title } })}
                style={({ pressed }) => [styles.wrongBtn, pressed ? styles.pressed : null]}
              >
                <Text style={styles.wrongBtnText}>进入本题库错题本</Text>
                <Tag label={`${stats?.wrongPending ?? 0} 题`} tone={(stats?.wrongPending ?? 0) > 0 ? 'danger' : 'neutral'} />
              </Pressable>
            </View>

            <Text style={styles.sectionLabel}>本题库分题型正确率</Text>
            <Text style={styles.sectionHint}>按「已掌握题数 / 本题型题目总数」计算，口径与统计页总掌握度一致</Text>
          </View>
        }
        renderItem={({ item }) => {
          // 主口径：已掌握题数 / 该题型题目总数；副行保留按作答次数的正确率
          const total = item.total ?? 0;
          const mastered = Math.min(item.masteredQuestions ?? 0, total);
          const rate = total > 0 ? Math.max(0, Math.min(100, Math.round((mastered / total) * 100))) : 0;
          const attemptRate =
            item.attempts > 0 ? Math.max(0, Math.min(100, Math.round((item.correct / item.attempts) * 100))) : 0;
          const barColor = rate >= 80 ? c.success : rate >= 60 ? c.primary : c.warn;
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
            <Text style={styles.emptyText}>本题库还没有可统计的题目或作答记录。</Text>
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
    center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
    nav: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: sp.lg, marginBottom: sp.xs },
    back: { width: 64 },
    backText: { fontSize: 15, color: c.primary, fontWeight: '600' },
    navTitle: { flex: 1, textAlign: 'center', fontSize: 16, fontWeight: '700', color: c.text },
    navRight: { width: 64 },
    list: { paddingHorizontal: sp.lg, paddingTop: sp.md, paddingBottom: sp.xxl * 2 },
    pageSub: { fontSize: 12.5, color: c.textMuted, marginBottom: sp.lg },
    gridRow: { flexDirection: 'row', gap: sp.md, marginBottom: sp.md },
    gridCell: { flex: 1 },
    card: cardBase,
    cardTitle: { fontSize: 13, color: c.textMuted, fontWeight: '600', marginBottom: sp.sm },
    bigLine: { fontSize: 24, fontWeight: '800', color: c.text },
    bigLineSub: { fontSize: 14, fontWeight: '600', color: c.textMuted },
    hintLine: { fontSize: 12, lineHeight: 19, color: c.textSub, marginTop: sp.xs },
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
    typeCard: { ...cardBase, padding: sp.md, marginBottom: sp.sm },
    typeHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: sp.sm },
    typeName: { fontSize: 14, fontWeight: '700', color: c.text },
    typeMeta: { fontSize: 12, color: c.textSub },
    track: { height: 7, borderRadius: r.pill, backgroundColor: c.track, overflow: 'hidden' },
    fill: { height: 7, borderRadius: r.pill },
    typeFoot: { fontSize: 11, color: c.textMuted, marginTop: 5 },
    emptyBlock: { paddingTop: sp.xl, alignItems: 'center' },
    emptyText: { fontSize: 12.5, color: c.textMuted },
    pressed: { opacity: 0.9 },
  });
}
