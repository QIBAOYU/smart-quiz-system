/**
 * AI 批量出类似题：整库选母题，一次生成一批。
 *
 * 逐题点开「添加AI生成类似题」在几十题的库里太麻烦，这里把选题做成一等公民：
 * - 自动选题：按题库规模挑 5 / 10 / 20 道母题（优先答案已核对且有答案的题）
 * - 手动选题：逐题勾选，或一键全选（上限 SIMILAR_BATCH_LIMIT，再多用户等不起）
 * 每道母题各出 1 题，结果可以追加进本题库，也可以单独存成一个 AI 题库。
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { dialog } from '../components/dialog';
import { Segmented } from '../components/Segmented';
import { Card, LoadingBlock, Tag } from '../components/ui';
import { SparkIcon } from '../components/icons';
import { useTaskInset } from '../components/AiTaskLayer';
import { useTheme } from '../store/ThemeContext';
import { useApp } from '../store/AppContext';
import { useAiStatus } from '../services/aiConfig';
import { listQuestions } from '../services/quizStore';
import {
  pickSimilarSources,
  runSimilarBatch,
  SIMILAR_BATCH_LIMIT,
  SIMILAR_BATCH_SIZES,
} from '../services/aiPlusService';
import { typeLabels } from '../constants/theme';
import type { Question } from '../types/quiz';

type PickMode = 'auto' | 'manual';
type Target = 'newBank' | 'append';

export default function SimilarBatchScreen() {
  const { id, name } = useLocalSearchParams<{ id: string; name: string }>();
  const insets = useSafeAreaInsets();
  const taskInset = useTaskInset();
  const t = useTheme();
  const c = t.palette;
  const ai = useAiStatus();
  const { beginAiTask, updateAiTask, finishAiTask, refreshBanks } = useApp();

  const [questions, setQuestions] = useState<Question[]>([]);
  const [loading, setLoading] = useState(true);
  const [mode, setMode] = useState<PickMode>('auto');
  const [size, setSize] = useState<number>(10);
  const [picked, setPicked] = useState<Record<string, boolean>>({});
  const [target, setTarget] = useState<Target>('newBank');
  const [running, setRunning] = useState(false);

  useEffect(() => {
    if (!id) {
      setLoading(false);
      return;
    }
    let alive = true;
    (async () => {
      try {
        const list = await listQuestions(id);
        if (alive) setQuestions(list);
      } catch (error) {
        console.error('[similar-batch] load failed:', error);
        if (alive) dialog.alert('加载失败', '题库内容暂时读不出来，请稍后重试。');
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [id]);

  /** 题库规模决定的自适应档位：小库不必出 20 题 */
  const sizes = useMemo(() => {
    const tiers = SIMILAR_BATCH_SIZES.filter((n) => n < questions.length);
    return tiers.length > 0 ? tiers : [Math.min(questions.length, SIMILAR_BATCH_SIZES[0])];
  }, [questions.length]);

  const allCount = Math.min(questions.length, SIMILAR_BATCH_LIMIT);
  const pickedIds = useMemo(() => Object.keys(picked).filter((k) => picked[k]), [picked]);

  const sources = useMemo<Question[]>(() => {
    if (mode === 'manual') return questions.filter((q) => picked[q.id]);
    const want = size === 0 ? allCount : Math.min(size, allCount);
    return pickSimilarSources(questions, want);
  }, [allCount, mode, picked, questions, size]);

  const sourceIds = useMemo(() => new Set(sources.map((q) => q.id)), [sources]);

  const toggle = useCallback(
    (qid: string) => {
      if (running) return;
      setPicked((prev) => {
        const next = { ...prev };
        if (next[qid]) {
          delete next[qid];
          return next;
        }
        const used = Object.keys(next).filter((k) => next[k]).length;
        if (used >= SIMILAR_BATCH_LIMIT) {
          dialog.alert('最多选这么多', `逐题串行生成，一次最多 ${SIMILAR_BATCH_LIMIT} 道母题，先取消几题吧。`);
          return prev;
        }
        next[qid] = true;
        return next;
      });
    },
    [running],
  );

  const selectAll = useCallback(() => {
    const next: Record<string, boolean> = {};
    questions.slice(0, SIMILAR_BATCH_LIMIT).forEach((q) => {
      next[q.id] = true;
    });
    setPicked(next);
  }, [questions]);

  const clearAll = useCallback(() => setPicked({}), []);

  const start = useCallback(async () => {
    if (running) return;
    if (!ai.aiUsable) {
      dialog.alert('暂时无法使用 AI', ai.online ? '请先在「设置 → AI 供应商」完成配置。' : '当前没有网络，联网后可让 AI 出题。');
      return;
    }
    if (sources.length === 0) {
      dialog.alert('还没有母题', '请至少勾选一道母题，或改用自动选题。');
      return;
    }
    setRunning(true);
    const taskId = beginAiTask(`AI 批量出类似题（${sources.length} 题）`, sources.length);
    let cancelled = false;
    try {
      const r = await runSimilarBatch({
        bankId: id,
        bankName: name || '题库',
        sources,
        target,
        onProgress: (p) => updateAiTask(taskId, { done: p.done, total: p.total, collected: p.collected }),
        shouldAbort: () => cancelled,
      });
      if (!r) throw new Error('题库写入失败');
      finishAiTask(taskId, 'done', `已生成 ${r.inserted} 题`);
      await refreshBanks();
      const tail = [
        r.failed > 0 ? `另有 ${r.failed} 道母题没能出成。` : '',
        r.inserted < r.expected ? `实际写入 ${r.inserted} 题，还有 ${r.expected - r.inserted} 题没能存到云端。` : '',
        'AI 生成的答案标记为「答案待确认」，建议抽查。',
      ]
        .filter(Boolean)
        .join(' ');
      if (r.bankId === null) {
        dialog.alert('已追加到本题库', `${r.inserted} 道类似题已加在「${r.name}」末尾。${tail}`, [
          { text: '知道了' },
          { text: '回题库查看', onPress: () => router.replace({ pathname: '/bank', params: { id, name } }) },
        ]);
      } else {
        dialog.alert('类似题题库已生成', `《${r.name}》共 ${r.inserted} 题。${tail}`, [
          { text: '知道了' },
          { text: '去刷题', onPress: () => router.replace({ pathname: '/quiz', params: { id: r.bankId as string, name: r.name } }) },
        ]);
      }
    } catch (error) {
      console.error('[similar-batch] failed:', error);
      finishAiTask(taskId, 'failed', '批量出题失败');
      dialog.alert('批量出题未完成', 'AI 请求中断，请稍后重试。');
    } finally {
      cancelled = true;
      setRunning(false);
    }
  }, [ai.aiUsable, ai.online, beginAiTask, finishAiTask, id, name, refreshBanks, running, sources, target, updateAiTask]);

  if (!id) {
    return (
      <View style={[styles.root, { backgroundColor: c.bg, paddingTop: insets.top + taskInset + 10 }]}>
        <Text style={[styles.emptyText, { color: c.textSub }]}>缺少题库参数，请从题库详情页重新进入。</Text>
      </View>
    );
  }

  return (
    <View style={[styles.root, { backgroundColor: c.bg, paddingTop: insets.top + taskInset + 10 }]}>
      <View style={styles.nav}>
        <Pressable
          accessibilityRole="button"
          onPress={() => (router.canGoBack() ? router.back() : router.replace('/'))}
          hitSlop={12}
          style={styles.back}
        >
          <Text style={[styles.backText, { color: c.primary }]}>‹ 返回</Text>
        </Pressable>
        <Text style={[styles.navTitle, { color: c.text }]} numberOfLines={1}>
          AI 批量出题
        </Text>
        <View style={styles.navSpace} />
      </View>

      <FlatList
        data={questions}
        keyExtractor={(item) => item.id}
        contentContainerStyle={styles.list}
        keyboardShouldPersistTaps="handled"
        ListHeaderComponent={
          <View>
            <Card style={{ marginBottom: 12 }}>
              <Text style={[styles.cardTitle, { color: c.text }]}>给「{name || '本题库'}」批量出类似题</Text>
              <Text style={[styles.cardDesc, { color: c.textSub }]}>
                每道母题各出 1 道同考点、换情境的新题，含答案与解析。逐题串行生成，{sources.length} 题约需
                {Math.max(1, Math.ceil(sources.length * 0.6))} 分钟，可切到其他页面，顶部进度条会一直显示。
              </Text>
              <View style={styles.tagRow}>
                <Tag label={`题库 ${questions.length} 题`} tone="neutral" />
                <Tag label={`本次 ${sources.length} 题`} tone="primary" />
                {questions.length > SIMILAR_BATCH_LIMIT ? (
                  <Tag label={`单次上限 ${SIMILAR_BATCH_LIMIT} 题`} tone="warn" />
                ) : null}
              </View>
            </Card>

            <Text style={[styles.label, { color: c.textMuted }]}>选题方式</Text>
            <Segmented
              options={[
                { value: 'auto', label: '自动选题' },
                { value: 'manual', label: '手动选题' },
              ]}
              value={mode}
              onChange={(v) => setMode(v as PickMode)}
              stretch
              style={{ marginBottom: 10 }}
            />

            {mode === 'auto' ? (
              <View style={styles.chipRow}>
                {sizes.map((n) => (
                  <Pressable
                    key={`s_${n}`}
                    accessibilityRole="button"
                    onPress={() => setSize(n)}
                    style={[
                      styles.chip,
                      {
                        backgroundColor: size === n ? c.primary : t.cardBg,
                        borderColor: size === n ? c.primary : c.border,
                        borderRadius: t.radius.pill,
                      },
                    ]}
                  >
                    <Text style={[styles.chipText, { color: size === n ? c.onPrimary : c.textSub }]}>{n} 题</Text>
                  </Pressable>
                ))}
                <Pressable
                  accessibilityRole="button"
                  onPress={() => setSize(0)}
                  style={[
                    styles.chip,
                    {
                      backgroundColor: size === 0 ? c.primary : t.cardBg,
                      borderColor: size === 0 ? c.primary : c.border,
                      borderRadius: t.radius.pill,
                    },
                  ]}
                >
                  <Text style={[styles.chipText, { color: size === 0 ? c.onPrimary : c.textSub }]}>
                    全部 {allCount} 题
                  </Text>
                </Pressable>
              </View>
            ) : (
              <View style={styles.chipRow}>
                <Pressable
                  accessibilityRole="button"
                  onPress={selectAll}
                  style={[styles.chip, { borderColor: c.border, borderRadius: t.radius.pill, backgroundColor: t.cardBg }]}
                >
                  <Text style={[styles.chipText, { color: c.textSub }]}>全选前 {allCount} 题</Text>
                </Pressable>
                <Pressable
                  accessibilityRole="button"
                  onPress={clearAll}
                  style={[styles.chip, { borderColor: c.border, borderRadius: t.radius.pill, backgroundColor: t.cardBg }]}
                >
                  <Text style={[styles.chipText, { color: c.textSub }]}>清空</Text>
                </Pressable>
                <Text style={[styles.pickCount, { color: c.textMuted }]}>已选 {pickedIds.length} 题</Text>
              </View>
            )}

            <Text style={[styles.label, { color: c.textMuted, marginTop: 16 }]}>生成结果放在哪</Text>
            <Segmented
              options={[
                { value: 'newBank', label: '新建 AI 题库' },
                { value: 'append', label: '追加到本题库' },
              ]}
              value={target}
              onChange={(v) => setTarget(v as Target)}
              stretch
              style={{ marginBottom: 6 }}
            />
            <Text style={[styles.targetHint, { color: c.textMuted }]}>
              {target === 'newBank'
                ? '存成「题库名 · 类似题」，与原题分开，可单独刷、单独导出。'
                : '接在本题库最后一题之后，和原题混在一起刷。'}
            </Text>

            <Text style={[styles.sectionTitle, { color: c.text }]}>
              {mode === 'manual' ? '勾选母题（点任意一题）' : '本次使用的母题'}
            </Text>
          </View>
        }
        ItemSeparatorComponent={() => <View style={{ height: 8 }} />}
        ListEmptyComponent={loading ? <LoadingBlock label="正在载入题目…" /> : <View style={{ height: 8 }} />}
        renderItem={({ item, index }) => {
          const isSource = mode === 'manual' ? !!picked[item.id] : sourceIds.has(item.id);
          return (
            <Pressable
              accessibilityRole="button"
              onPress={() => (mode === 'manual' ? toggle(item.id) : undefined)}
              style={({ pressed }) => [
                styles.row,
                {
                  backgroundColor: t.cardBg,
                  borderColor: isSource ? c.primary : c.border,
                  borderRadius: t.radius.md,
                  opacity: mode === 'manual' && pressed ? 0.92 : isSource || mode === 'manual' ? 1 : 0.62,
                },
              ]}
            >
              <View
                style={[
                  styles.box,
                  {
                    borderColor: isSource ? c.primary : c.border,
                    backgroundColor: isSource ? c.primary : 'transparent',
                  },
                ]}
              >
                {isSource ? <Text style={[styles.boxTick, { color: c.onPrimary }]}>✓</Text> : null}
              </View>
              <View style={{ flex: 1 }}>
                <Text style={[styles.rowStem, { color: c.text }]} numberOfLines={2}>
                  {index + 1}. {item.stem}
                </Text>
                <View style={styles.rowMeta}>
                  <Text style={{ fontSize: 11, color: c.textMuted }}>{typeLabels[item.type] ?? item.type}</Text>
                  {item.subject ? <Text style={{ fontSize: 11, color: c.textMuted }}>{item.subject}</Text> : null}
                  {!item.reviewed ? <Text style={{ fontSize: 11, color: c.warn }}>答案待确认</Text> : null}
                </View>
              </View>
            </Pressable>
          );
        }}
      />

      <View style={[styles.footer, { backgroundColor: c.bg, borderTopColor: c.border, paddingBottom: insets.bottom + 10 }]}>
        <Pressable
          accessibilityRole="button"
          onPress={() => {
            start().catch((error) => console.error('[similar-batch] start failed:', error));
          }}
          disabled={running || sources.length === 0}
          style={({ pressed }) => [
            styles.goBtn,
            {
              backgroundColor: c.primary,
              borderRadius: t.radius.md,
              opacity: running || sources.length === 0 || pressed ? 0.85 : 1,
              ...t.shadow.card,
            },
          ]}
        >
          <SparkIcon size={16} color={c.onPrimary} />
          <Text style={[styles.goText, { color: c.onPrimary }]}>
            {running ? 'AI 正在出题…' : `生成 ${sources.length} 道类似题`}
          </Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  nav: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, marginBottom: 8 },
  back: { width: 64 },
  backText: { fontSize: 15, fontWeight: '600' },
  navTitle: { flex: 1, textAlign: 'center', fontSize: 16.5, fontWeight: '800' },
  navSpace: { width: 64 },
  list: { paddingHorizontal: 16, paddingBottom: 24 },
  cardTitle: { fontSize: 15, fontWeight: '800', lineHeight: 22 },
  cardDesc: { fontSize: 12.5, lineHeight: 20, marginTop: 6 },
  tagRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 10 },
  label: { fontSize: 12, fontWeight: '700', marginBottom: 8 },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8 },
  chip: { paddingHorizontal: 12, paddingVertical: 6, borderWidth: 1 },
  chipText: { fontSize: 12.5, fontWeight: '700' },
  pickCount: { fontSize: 12, fontWeight: '600' },
  targetHint: { fontSize: 11.5, lineHeight: 18 },
  sectionTitle: { fontSize: 13.5, fontWeight: '800', marginTop: 18, marginBottom: 10 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, borderWidth: 1, padding: 12 },
  box: { width: 20, height: 20, borderRadius: 6, borderWidth: 1.5, alignItems: 'center', justifyContent: 'center' },
  boxTick: { fontSize: 12, fontWeight: '900', lineHeight: 15 },
  rowStem: { fontSize: 13.5, lineHeight: 20 },
  rowMeta: { flexDirection: 'row', gap: 8, marginTop: 4, flexWrap: 'wrap' },
  footer: { borderTopWidth: StyleSheet.hairlineWidth, paddingHorizontal: 16, paddingTop: 10 },
  goBtn: { height: 48, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6 },
  goText: { fontSize: 15, fontWeight: '800' },
  emptyText: { fontSize: 13.5, paddingHorizontal: 20 },
});
