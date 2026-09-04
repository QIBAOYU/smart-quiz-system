/**
 * 错题本三种范围：
 * - 不带参数：错题总览（WrongGroups），可在「按科目 / 按题库」两种分组间切换
 * - 带 bankId：只列出该题库的错题
 * - 带 subject：只列出该科目的错题（错题可能来自多个题库），支持只刷这一科
 * 三种范围共用同一套列表 UI，支持逐题重做、一键刷完整组错题、标记已掌握。
 */
import React, { useCallback, useMemo, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { dialog } from '../components/dialog';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import type { Theme } from '../constants/theme';
import { typeLabels } from '../constants/theme';
import { useTheme } from '../store/ThemeContext';
import { ChevronIcon, SparkIcon } from '../components/icons';
import { Tag } from '../components/ui';
import { WrongGroups } from '../components/WrongGroups';
import { listWrongEntries, markWrongResolved } from '../services/quizStore';
import { UNCLASSIFIED } from '../services/statsService';
import { createVariantBank } from '../services/aiPlusService';
import { useAiStatus } from '../services/aiConfig';
import { useApp } from '../store/AppContext';
import { startSession } from '../store/sessionStore';
import type { Question, WrongEntry } from '../types/quiz';

export default function WrongScreen() {
  const params = useLocalSearchParams<{ bankId?: string; subject?: string; name?: string }>();
  const bankId = typeof params.bankId === 'string' ? params.bankId : '';
  const subject = typeof params.subject === 'string' ? params.subject : '';
  const name = typeof params.name === 'string' && params.name ? params.name : subject || '本题库';
  if (!bankId && !subject) return <WrongGroups />;
  return <BankWrongList bankId={bankId} subject={subject} bankName={name} />;
}

/**
 * 单组错题列表。bankId 与 subject 二选一：
 * 按科目时先取全量错题，再用题目自身的 subject 字段过滤（错题表不存科目，避免多份口径）。
 */
function BankWrongList({ bankId, subject, bankName }: { bankId: string; subject: string; bankName: string }) {
  const t = useTheme();
  const styles = useMemo(() => buildStyles(t), [t]);
  const insets = useSafeAreaInsets();
  const c = t.palette;
  const [entries, setEntries] = useState<WrongEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const { beginAiTask, updateAiTask, finishAiTask, refreshBanks } = useApp();
  const ai = useAiStatus();
  const [variantWorking, setVariantWorking] = useState(false);

  const fetchAll = useCallback(async () => {
    try {
      const rows = await listWrongEntries(bankId || undefined);
      setEntries(subject ? rows.filter((e) => (e.question?.subject || UNCLASSIFIED) === subject) : rows);
    } catch (error) {
      console.error('[wrong] load failed:', error);
      dialog.alert('加载失败', '错题本读取时出现问题，请返回后重新进入。');
    } finally {
      setLoading(false);
    }
  }, [bankId, subject]);

  useFocusEffect(
    useCallback(() => {
      fetchAll().catch((error) => console.error('[wrong] focus load failed:', error));
    }, [fetchAll]),
  );

  const onResolve = useCallback((entry: WrongEntry) => {
    dialog.alert('标记为已掌握', `《${entry.question ? typeLabels[entry.question.type] : '题目'}」将从错题本移出，答错后会重新收录。`, [
      { text: '取消', style: 'cancel' },
      {
        text: '已掌握',
        onPress: () => {
          markWrongResolved(entry.questionId)
            .then((ok: boolean) => {
              if (!ok) {
                dialog.alert('操作未生效', '云端没有更新这条记录，请检查网络后重试。');
                return;
              }
              setEntries((prev) => prev.filter((e) => e.questionId !== entry.questionId));
            })
            .catch((error: unknown) => {
              console.error('[wrong] resolve failed:', error);
              dialog.alert('操作失败', '更新错题状态时出现问题，请稍后重试。');
            });
        },
      },
    ]);
  }, []);

  const onRedo = useCallback((entry: WrongEntry) => {
    const q = entry.question;
    if (!q) {
      dialog.alert('无法重做', '这道题对应的原始题目已被删除。');
      return;
    }
    startSession({ bankId: q.bankId, bankName: `${bankName} · 错题`, mode: 'wrong', questions: [q] });
    router.push('/session');
  }, [bankName]);

  const redoAll = useCallback(() => {
    const list = entries.filter((e) => !e.resolved && e.question).map((e) => e.question as Question);
    if (list.length === 0) {
      dialog.alert('暂无错题', subject ? `${subject}的错题都已攻克，先去刷几道新题吧。` : '这个题库的错题都已攻克，先去刷几道新题吧。');
      return;
    }
    // 按科目刷题是跨题库题池，会话 bankId 取首题归属（断点进度键需要合法 uuid）
    startSession({ bankId: bankId || list[0].bankId, bankName: `${bankName} · 错题`, mode: 'wrong', questions: list });
    router.push('/session');
  }, [entries, bankId, bankName, subject]);

  const pending = entries.filter((e) => !e.resolved);

  /**
   * AI 变式重练：给错得最多的前 12 题各出 1 道「同考点、换情境」的题，存成一个新的 AI 题库。
   * 与「一键刷完错题」的区别是：重做原题只能验证记忆，变式题才能验证是否真的会了这个考点。
   */
  const doVariant = useCallback(async () => {
    const targets = entries.filter((e) => !e.resolved && e.question);
    setVariantWorking(true);
    const taskId = beginAiTask('AI 生成错题变式', Math.min(targets.length, 12));
    let cancelled = false;
    try {
      const scopeName = subject ? subject : bankName;
      const result = await createVariantBank(
        bankId,
        scopeName,
        (p) => updateAiTask(taskId, { done: p.done, total: p.total, collected: p.collected }),
        () => cancelled,
        subject,
      );
      if (!result) {
        finishAiTask(taskId, 'cancelled', '没有可生成变式的错题');
        dialog.alert('暂无错题', '这组错题都已攻克，先去刷几道新题吧。');
        return;
      }
      finishAiTask(taskId, 'done', `变式题 ${result.inserted} 题`);
      await refreshBanks();
      dialog.alert(
        '变式题已生成',
        result.inserted < result.expected
          ? `《${result.name}》共生成 ${result.expected} 题，实际写入 ${result.inserted} 题，可重新生成补齐。`
          : `《${result.name}》共 ${result.inserted} 题，已作为一个新题库保存。AI 生成的答案标记为「答案待确认」，建议抽查。`,
        [
          { text: '知道了' },
          {
            text: '去刷题',
            onPress: () => router.push({ pathname: '/quiz', params: { id: result.bankId, name: result.name } }),
          },
        ],
      );
    } catch (error) {
      console.error('[wrong] variant failed:', error);
      finishAiTask(taskId, 'failed', '变式题生成失败');
      dialog.alert('生成未完成', 'AI 请求中断，请稍后重试。');
    } finally {
      cancelled = true;
      setVariantWorking(false);
    }
  }, [bankId, bankName, beginAiTask, entries, finishAiTask, refreshBanks, subject, updateAiTask]);

  const askVariant = useCallback(() => {
    if (variantWorking) return;
    if (!ai.aiUsable) {
      dialog.alert('暂时无法使用 AI', ai.online ? '请先在「设置 → AI 供应商」完成配置。' : '当前没有网络，联网后可生成变式题。');
      return;
    }
    const n = entries.filter((e) => !e.resolved && e.question).length;
    if (n === 0) {
      dialog.alert('暂无错题', '这组错题都已攻克，先去刷几道新题吧。');
      return;
    }
    dialog.alert(
      'AI 生成变式题重练',
      `将为错得最多的 ${Math.min(n, 12)} 道错题各出 1 道「同考点、换情境」的变式题，存成一个新的 AI 题库。逐题生成，需要一点时间。`,
      [
        { text: '取消', style: 'cancel' },
        {
          text: '开始生成',
          onPress: () => {
            doVariant().catch((error) => console.error('[wrong] variant failed:', error));
          },
        },
      ],
    );
  }, [ai.aiUsable, ai.online, doVariant, entries, variantWorking]);

  const listHeader = (
    <View style={styles.headCard}>
      <Text style={styles.headTitle}>{subject ? `${subject} · 错题` : bankName}</Text>
      <Text style={styles.headDesc}>
        {subject
          ? `${subject}共 ${pending.length} 道待复习错题（可能来自多个题库），点击卡片可直接重做该题；连续答对两次的题目会自动移出错题本。`
          : `本题库共 ${pending.length} 道待复习错题，点击卡片可直接重做该题；连续答对两次的题目会自动移出错题本。`}
      </Text>
      <Pressable accessibilityRole="button" onPress={redoAll} style={({ pressed }) => [styles.allBtn, pressed ? styles.pressed : null]}>
        <Text style={styles.allBtnText}>{subject ? '一键刷完本科错题' : '一键刷完本题库错题'}</Text>
      </Pressable>
      <Pressable
        accessibilityRole="button"
        onPress={askVariant}
        disabled={variantWorking}
        style={({ pressed }) => [
          {
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 6,
            height: 42,
            marginTop: 8,
            borderWidth: 1.4,
            borderColor: c.accent,
            backgroundColor: c.accentSoft,
            borderRadius: t.radius.md,
            opacity: pressed || variantWorking ? 0.85 : 1,
          },
        ]}
      >
        <SparkIcon size={14} color={c.accent} />
        <Text style={{ fontSize: 13, fontWeight: '700', color: c.accent }}>
          {variantWorking ? 'AI 正在生成变式题…' : 'AI 生成变式题重练'}
        </Text>
      </Pressable>
      <View style={styles.legendRow}>
        <View style={styles.legendItem}>
          <View style={[styles.legendDot, { backgroundColor: c.danger }]} />
          <Text style={styles.legendText}>错 3 次以上</Text>
        </View>
        <View style={styles.legendItem}>
          <View style={[styles.legendDot, { backgroundColor: c.warn }]} />
          <Text style={styles.legendText}>错 1-2 次</Text>
        </View>
        <View style={styles.legendItem}>
          <View style={[styles.legendDot, { backgroundColor: c.success }]} />
          <Text style={styles.legendText}>即将掌握</Text>
        </View>
      </View>
    </View>
  );

  return (
    <View style={[styles.root, { paddingTop: insets.top + t.spacing.sm }]}>
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
          错题本
        </Text>
        <Pressable accessibilityRole="button" onPress={() => router.replace('/wrong')} hitSlop={12} style={styles.navRight}>
          <Text style={styles.switchText}>全部</Text>
        </Pressable>
      </View>

      {loading ? (
        <View style={styles.loading}>
          <ActivityIndicator color={c.primary} />
        </View>
      ) : (
        <FlatList
          data={entries}
          keyExtractor={(item) => item.id}
          ListHeaderComponent={entries.length > 0 ? listHeader : null}
          contentContainerStyle={styles.list}
          ItemSeparatorComponent={() => <View style={{ height: t.spacing.sm }} />}
          ListEmptyComponent={
            <View style={styles.emptyWrap}>
              <Text style={styles.emptyTitle}>{subject ? '本科暂无错题' : '本题库暂无错题'}</Text>
              <Text style={styles.emptyDesc}>
                {subject ? `${subject}的题目你还没答错过，或者错题都已攻克。` : '这个题库的题目你还没答错过，或者错题都已攻克。'}
              </Text>
              <Pressable accessibilityRole="button" onPress={() => router.replace('/')} style={styles.emptyBtn}>
                <Text style={styles.emptyBtnText}>开始刷题</Text>
              </Pressable>
            </View>
          }
          renderItem={({ item }) => {
            const q = item.question as Question | null | undefined;
            const heavy = item.wrongCount >= 3;
            const nearMaster = item.streakCorrect > 0;
            return (
              <Pressable
                accessibilityRole="button"
                onPress={() => onRedo(item)}
                style={({ pressed }) => [styles.item, pressed ? styles.pressed : null]}
              >
                <View style={styles.itemTop}>
                  <Tag label={q ? typeLabels[q.type] : '题目'} tone={heavy ? 'danger' : 'neutral'} />
                  <Tag
                    label={nearMaster ? `已连对 ${item.streakCorrect} 次` : `错 ${item.wrongCount} 次`}
                    tone={nearMaster ? 'success' : heavy ? 'danger' : 'warn'}
                  />
                  <View style={styles.flex} />
                  <ChevronIcon size={16} color={c.textMuted} />
                </View>
                <Text style={styles.stem} numberOfLines={3}>
                  {q ? q.stem : '原题目已被删除'}
                </Text>
                {q && q.options.length > 0 ? (
                  <Text style={styles.opts} numberOfLines={2}>
                    {q.options.map((o, i) => `${String.fromCharCode(65 + i)}. ${o}`).join('   ')}
                  </Text>
                ) : null}
                {q && q.answer ? (
                  <View style={styles.answerRow}>
                    <Text style={styles.answerLabel}>正确答案</Text>
                    <Text style={styles.answerValue} numberOfLines={2}>
                      {q.answer}
                    </Text>
                  </View>
                ) : null}
                <View style={styles.actions}>
                  <Pressable
                    accessibilityRole="button"
                    onPress={() => onRedo(item)}
                    style={({ pressed }) => [styles.redoBtn, pressed ? styles.pressed : null]}
                  >
                    <Text style={styles.redoText}>重做这道题</Text>
                  </Pressable>
                  <Pressable
                    accessibilityRole="button"
                    onPress={() => onResolve(item)}
                    style={({ pressed }) => [styles.masterBtn, pressed ? styles.pressed : null]}
                  >
                    <Text style={styles.masterText}>标记已掌握</Text>
                  </Pressable>
                </View>
              </Pressable>
            );
          }}
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
    navRight: { width: 64, alignItems: 'flex-end' },
    switchText: { fontSize: 13, color: c.textSub, fontWeight: '600' },
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
    headTitle: { fontSize: 15.5, fontWeight: '800', color: c.text },
    headDesc: { fontSize: 12.5, lineHeight: 19, color: c.textSub, marginTop: sp.xs },
    allBtn: {
      height: 42,
      marginTop: sp.md,
      borderRadius: r.md,
      backgroundColor: c.primary,
      alignItems: 'center',
      justifyContent: 'center',
      ...t.shadow.raised,
    },
    allBtnText: { fontSize: 13.5, fontWeight: '700', color: c.onPrimary },
    legendRow: { flexDirection: 'row', gap: sp.md, marginTop: sp.md },
    legendItem: { flexDirection: 'row', alignItems: 'center', gap: 5 },
    legendDot: { width: 7, height: 7, borderRadius: r.pill },
    legendText: { fontSize: 11.5, color: c.textMuted },
    item: {
      backgroundColor: t.cardBg,
      borderRadius: t.cardRadius,
      borderWidth: t.borderWidth,
      borderColor: c.border,
      padding: sp.lg,
      marginBottom: sp.md,
      gap: sp.sm,
      ...t.shadow.card,
    },
    itemTop: { flexDirection: 'row', alignItems: 'center', gap: sp.sm },
    flex: { flex: 1 },
    stem: { fontSize: 14.5, lineHeight: 22, color: c.text, fontWeight: '600' },
    opts: { fontSize: 12.5, lineHeight: 19, color: c.textSub },
    answerRow: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      gap: sp.sm,
      backgroundColor: c.successSoft,
      borderRadius: r.md,
      padding: sp.md,
    },
    answerLabel: { fontSize: 11.5, fontWeight: '700', color: c.success },
    answerValue: { flex: 1, fontSize: 12.5, lineHeight: 19, color: c.success },
    actions: { flexDirection: 'row', gap: sp.sm, marginTop: sp.xs },
    redoBtn: {
      flex: 1,
      height: 40,
      borderRadius: r.md,
      backgroundColor: c.primary,
      alignItems: 'center',
      justifyContent: 'center',
      ...t.shadow.raised,
    },
    redoText: { fontSize: 13, fontWeight: '700', color: c.onPrimary },
    masterBtn: {
      flex: 1,
      height: 40,
      borderRadius: r.md,
      borderWidth: t.borderWidth,
      borderColor: c.border,
      backgroundColor: t.chipBg,
      alignItems: 'center',
      justifyContent: 'center',
    },
    masterText: { fontSize: 13, fontWeight: '600', color: c.textSub },
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
