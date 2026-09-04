/**
 * 错题本总览：按题库分组的错题数据汇总，每个题库一行，点击进入该题库的错题练习。
 * 数据全部来自云端 quiz_wrong_book，无示例数据。
 */
import React, { useCallback, useMemo, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native';
import { useFocusEffect } from 'expo-router';
import { router } from 'expo-router';
import type { Theme } from '../constants/theme';
import { useTheme } from '../store/ThemeContext';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Tag } from './ui';
import { loadWrongGroups, loadWrongSubjectGroups, type WrongBankGroup, type WrongSubjectGroup } from '../services/statsService';

/** 科目 / 题库两个分组维度统一成同一种行，便于共用列表渲染 */
type WrongRow = {
  key: string;
  title: string;
  pending: number;
  heavy: number;
  mastered: number;
  params: Record<string, string>;
};

type Dimension = 'subject' | 'bank';

export function WrongGroups() {
  const t = useTheme();
  const styles = useMemo(() => buildStyles(t), [t]);
  const c = t.palette;
  const insets = useSafeAreaInsets();
  const [bankGroups, setBankGroups] = useState<WrongBankGroup[]>([]);
  const [subjectGroups, setSubjectGroups] = useState<WrongSubjectGroup[]>([]);
  const [dimension, setDimension] = useState<Dimension>('subject');
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      const [banks, subjects] = await Promise.all([loadWrongGroups(), loadWrongSubjectGroups()]);
      setBankGroups(banks);
      setSubjectGroups(subjects);
    } catch (error) {
      console.error('[wrong-groups] load failed:', error);
    } finally {
      setLoading(false);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      load().catch((error) => console.error('[wrong-groups] focus load failed:', error));
    }, [load]),
  );

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    load().finally(() => setRefreshing(false));
  }, [load]);

  const rows = useMemo<WrongRow[]>(() => {
    if (dimension === 'subject') {
      return subjectGroups.map((g) => ({
        key: `s:${g.subject}`,
        title: g.subject,
        pending: g.pending,
        heavy: g.heavy,
        mastered: g.mastered,
        params: { subject: g.subject, name: g.subject },
      }));
    }
    return bankGroups.map((g) => ({
      key: `b:${g.bankId}`,
      title: g.bankName,
      pending: g.pending,
      heavy: g.heavy,
      mastered: g.mastered,
      params: { bankId: g.bankId, name: g.bankName },
    }));
  }, [bankGroups, dimension, subjectGroups]);

  const openRow = useCallback((row: WrongRow) => {
    router.push({ pathname: '/wrong', params: row.params });
  }, []);

  const totalPending = rows.reduce((sum, g) => sum + g.pending, 0);

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
        <Text style={styles.navTitle}>错题本</Text>
        <View style={styles.navRight} />
      </View>

      <View style={styles.segWrap}>
        {(['bank', 'subject'] as Dimension[]).map((d) => (
          <Pressable
            key={d}
            accessibilityRole="button"
            onPress={() => setDimension(d)}
            style={[styles.segItem, dimension === d ? styles.segItemActive : null]}
          >
            <Text style={[styles.segText, dimension === d ? styles.segTextActive : null]}>
              {d === 'subject' ? '科目' : '题库'}
            </Text>
          </Pressable>
        ))}
      </View>

      {loading ? (
        <View style={styles.loading}>
          <ActivityIndicator color={c.primary} />
        </View>
      ) : (
        <FlatList
          data={rows}
          keyExtractor={(item) => item.key}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={c.primary} />}
          contentContainerStyle={styles.list}
          ListHeaderComponent={
            rows.length > 0 ? (
              <View style={styles.headCard}>
                <Text style={styles.headTitle}>
                  {dimension === 'subject' ? '按科目汇总' : '按题库汇总'} · 共 {totalPending} 道待消灭错题
                </Text>
                <Text style={styles.headDesc}>
                  {dimension === 'subject'
                    ? '科目由 AI 自动识别，未识别的题目归入「未分类」。点击任意科目即可只刷该科错题（错题可能来自多个题库）。'
                    : '下面按题库汇总错题分布，点击任意一个题库即可进入该题库的错题练习。连续答对两次的题目会自动移出错题本。'}
                </Text>
              </View>
            ) : null
          }
          ItemSeparatorComponent={() => <View style={{ height: t.spacing.sm }} />}
          ListEmptyComponent={
            <View style={styles.emptyWrap}>
              <Text style={styles.emptyTitle}>还没有错题</Text>
              <Text style={styles.emptyDesc}>去刷题吧，答错的题目会收录到这里，可按科目或题库归类查看。</Text>
              <Pressable accessibilityRole="button" onPress={() => router.replace('/')} style={styles.emptyBtn}>
                <Text style={styles.emptyBtnText}>开始刷题</Text>
              </Pressable>
            </View>
          }
          renderItem={({ item }) => (
            <Pressable
              accessibilityRole="button"
              onPress={() => openRow(item)}
              style={({ pressed }) => [styles.item, pressed ? styles.pressed : null]}
            >
              <View style={styles.itemHead}>
                <Text style={styles.bankName} numberOfLines={1}>
                  {item.title}
                </Text>
                <View style={styles.flex} />
                <Tag
                  label={item.pending > 0 ? `待消灭 ${item.pending} 题` : '已全部掌握'}
                  tone={item.pending > 0 ? 'danger' : 'success'}
                />
              </View>
              <View style={styles.statRow}>
                <View style={styles.statCell}>
                  <Text style={[styles.statValue, { color: c.danger }]}>{item.pending}</Text>
                  <Text style={styles.statLabel}>待消灭</Text>
                </View>
                <View style={styles.statCell}>
                  <Text style={[styles.statValue, { color: c.warn }]}>{item.heavy}</Text>
                  <Text style={styles.statLabel}>错 3 次以上</Text>
                </View>
                <View style={styles.statCell}>
                  <Text style={[styles.statValue, { color: c.success }]}>{item.mastered}</Text>
                  <Text style={styles.statLabel}>已攻克</Text>
                </View>
                <Pressable accessibilityRole="button" onPress={() => openRow(item)} style={styles.goBtn}>
                  <Text style={styles.goText}>去练习 ›</Text>
                </Pressable>
              </View>
            </Pressable>
          )}
        />
      )}
    </View>
  );
}

function buildStyles(t: Theme) {
  const c = t.palette;
  const r = t.radius;
  const sp = t.spacing;
  return StyleSheet.create({
    root: { flex: 1, backgroundColor: c.bg },
    nav: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: sp.lg, marginBottom: sp.md },
    back: { width: 64 },
    backText: { fontSize: 15, color: c.primary, fontWeight: '600' },
    navTitle: { flex: 1, textAlign: 'center', fontSize: 16, fontWeight: '700', color: c.text },
    navRight: { width: 64 },
    loading: { paddingVertical: sp.xxl * 2, alignItems: 'center' },
    list: { paddingHorizontal: sp.lg, paddingBottom: sp.xxl },
    headCard: {
      backgroundColor: c.surface,
      borderRadius: t.cardRadius,
      borderWidth: t.borderWidth,
      borderColor: c.border,
      padding: sp.lg,
      marginBottom: sp.lg,
      ...t.shadow.card,
    },
    headTitle: { fontSize: 15, fontWeight: '800', color: c.text },
    headDesc: { fontSize: 12.5, lineHeight: 19, color: c.textSub, marginTop: sp.xs },
    item: {
      backgroundColor: t.cardBg,
      borderRadius: t.cardRadius,
      borderWidth: t.borderWidth,
      borderColor: c.border,
      padding: sp.lg,
      ...t.shadow.card,
    },
    itemHead: { flexDirection: 'row', alignItems: 'center', gap: sp.sm },
    bankName: { maxWidth: '58%', fontSize: 14.5, fontWeight: '700', color: c.text },
    flex: { flex: 1 },
    statRow: { flexDirection: 'row', alignItems: 'center', gap: sp.md, marginTop: sp.md },
    statCell: { minWidth: 56 },
    statValue: { fontSize: 17, fontWeight: '800' },
    statLabel: { fontSize: 10.5, color: c.textMuted, marginTop: 1 },
    goBtn: {
      marginLeft: 'auto',
      paddingHorizontal: sp.md,
      paddingVertical: 6,
      borderRadius: r.pill,
      borderWidth: t.borderWidth,
      borderColor: c.primary,
      backgroundColor: c.primarySoft,
    },
    goText: { fontSize: 11.5, fontWeight: '700', color: c.primaryDark },
    segWrap: {
      flexDirection: 'row',
      alignSelf: 'center',
      marginBottom: sp.md,
      padding: 3,
      borderRadius: r.pill,
      backgroundColor: c.track,
    },
    segItem: { paddingHorizontal: sp.lg, paddingVertical: 6, borderRadius: r.pill },
    segItemActive: { backgroundColor: c.surface, ...t.shadow.raised },
    segText: { fontSize: 12.5, fontWeight: '700', color: c.textMuted },
    segTextActive: { color: c.primaryDark },
    pressed: { opacity: 0.92 },
    emptyWrap: { paddingTop: sp.xxl * 2, alignItems: 'center', paddingHorizontal: sp.xl, gap: sp.md },
    emptyTitle: { fontSize: 17, fontWeight: '800', color: c.text },
    emptyDesc: { fontSize: 13, lineHeight: 21, color: c.textSub, textAlign: 'center' },
    emptyBtn: {
      height: 44,
      paddingHorizontal: sp.xxl,
      borderRadius: r.md,
      backgroundColor: c.primary,
      alignItems: 'center',
      justifyContent: 'center',
      ...t.shadow.raised,
    },
    emptyBtnText: { fontSize: 14, fontWeight: '700', color: c.onPrimary },
  });
}
