/**
 * 题号导航（答题卡式题号条）：
 * - 收起时是一条横向可滚动的题号条，自动跟随当前题
 * - 展开后是网格答题卡 + 图例，点击任意题号直接跳转
 * 颜色语义来自父页面传入的 states，本组件不持有业务状态。
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import type { Theme } from '../constants/theme';
import { useTheme } from '../store/ThemeContext';

/**
 * 单道题的作答态；当前题由 current 单独表达。
 * manual = 该题对错由 AI 判定（简答题），不是机器比对标准答案，橙色区别于答错。
 * seen = 背题模式下已浏览。
 */
export type NavState = 'todo' | 'correct' | 'wrong' | 'manual' | 'seen';

const CELL = 34;
const GAP = 6;

export function QuestionNav({
  total,
  current,
  states,
  browseMode = false,
  onJump,
}: {
  total: number;
  current: number;
  states: NavState[];
  /** 背题模式没有对错，文案与图例改为「已浏览」 */
  browseMode?: boolean;
  onJump: (index: number) => void;
}) {
  const t = useTheme();
  const styles = useMemo(() => buildStyles(t), [t]);
  const c = t.palette;
  const scroller = useRef<ScrollView>(null);
  const [open, setOpen] = useState(false);

  // 当前题变化时把题号条滚到可视区中部
  useEffect(() => {
    if (open) return;
    scroller.current?.scrollTo({ x: Math.max(0, current * (CELL + GAP) - 90), animated: true });
  }, [current, open]);

  const toggle = useCallback(() => setOpen((v) => !v), []);

  const answeredCount = states.filter((s) => s !== 'todo').length;
  const correctCount = states.filter((s) => s === 'correct').length;
  const wrongCount = states.filter((s) => s === 'wrong').length;
  const manualCount = states.filter((s) => s === 'manual').length;
  const seenCount = states.filter((s) => s === 'seen').length;

  const cellBg = (s: NavState) =>
    s === 'correct'
      ? styles.cellCorrect
      : s === 'wrong'
        ? styles.cellWrong
        : s === 'manual'
          ? styles.cellManual
          : s === 'seen'
            ? styles.cellSeen
            : styles.cellTodo;
  const cellFg = (s: NavState) =>
    s === 'correct'
      ? styles.textGood
      : s === 'wrong'
        ? styles.textBad
        : s === 'manual'
          ? styles.textWarn
          : s === 'seen'
            ? styles.textSeen
            : styles.textIdle;

  const cells = Array.from({ length: total }, (_v, i) => {
    const s = states[i] ?? 'todo';
    const isCurrent = i === current;
    return (
      <Pressable
        key={`nav_${i}`}
        accessibilityRole="button"
        accessibilityLabel={`第 ${i + 1} 题`}
        onPress={() => onJump(i)}
        style={({ pressed }) => [styles.cell, cellBg(s), isCurrent ? styles.cellCurrent : null, pressed ? styles.pressed : null]}
      >
        <Text style={[styles.cellText, cellFg(s)]}>{i + 1}</Text>
      </Pressable>
    );
  });

  const legend = (
    <View style={styles.legendRow}>
      <View style={styles.legendItem}>
        <View style={[styles.legendDot, styles.legendBorder]} />
        <Text style={styles.legendText}>当前题</Text>
      </View>
      {correctCount > 0 ? (
        <View style={styles.legendItem}>
          <View style={[styles.legendDot, { backgroundColor: c.successSoft, borderColor: c.success }]} />
          <Text style={styles.legendText}>答对 {correctCount}</Text>
        </View>
      ) : null}
      {wrongCount > 0 ? (
        <View style={styles.legendItem}>
          <View style={[styles.legendDot, { backgroundColor: c.dangerSoft, borderColor: c.danger }]} />
          <Text style={styles.legendText}>答错 {wrongCount}</Text>
        </View>
      ) : null}
      {manualCount > 0 ? (
        <View style={styles.legendItem}>
          <View style={[styles.legendDot, { backgroundColor: c.warnSoft, borderColor: c.warn }]} />
          <Text style={styles.legendText}>AI 判定 {manualCount}</Text>
        </View>
      ) : null}
      {seenCount > 0 ? (
        <View style={styles.legendItem}>
          <View style={[styles.legendDot, { backgroundColor: c.accentSoft, borderColor: c.accent }]} />
          <Text style={styles.legendText}>已浏览 {seenCount}</Text>
        </View>
      ) : null}
      <View style={styles.legendItem}>
        <View style={[styles.legendDot, { backgroundColor: c.surface, borderColor: c.border }]} />
        <Text style={styles.legendText}>
          {browseMode ? '未看' : '未作答'} {Math.max(0, total - answeredCount)}
        </Text>
      </View>
    </View>
  );

  return (
    <View style={styles.wrap}>
      <View style={styles.headRow}>
        <Text style={styles.label}>题号</Text>
        <Text style={styles.meta} numberOfLines={1}>
          第 {current + 1}/{total} 题 · {browseMode ? '已浏览' : '已作答'} {answeredCount}
        </Text>
        <Pressable accessibilityRole="button" onPress={toggle} hitSlop={8} style={({ pressed }) => [styles.toggle, pressed ? styles.pressed : null]}>
          <Text style={styles.toggleText}>{open ? '收起答题卡' : '展开答题卡'}</Text>
        </Pressable>
      </View>

      {open ? (
        <View style={styles.gridOuter}>
          <ScrollView style={styles.gridBox} contentContainerStyle={styles.grid} showsVerticalScrollIndicator={false}>
            {cells}
          </ScrollView>
          {legend}
        </View>
      ) : (
        <ScrollView ref={scroller} horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.strip}>
          {cells}
        </ScrollView>
      )}
    </View>
  );
}

function buildStyles(t: Theme) {
  const c = t.palette;
  const r = t.radius;
  const sp = t.spacing;
  return StyleSheet.create({
    wrap: {
      marginTop: sp.md,
      paddingHorizontal: sp.lg,
    },
    headRow: { flexDirection: 'row', alignItems: 'center', gap: sp.sm, marginBottom: sp.sm },
    label: { fontSize: 11.5, fontWeight: '800', color: c.textMuted, letterSpacing: 0.5 },
    meta: { flex: 1, fontSize: 11.5, color: c.textMuted },
    toggle: {
      paddingHorizontal: sp.md,
      paddingVertical: 4,
      borderRadius: r.pill,
      borderWidth: t.borderWidth,
      borderColor: c.border,
      backgroundColor: t.chipBg,
    },
    toggleText: { fontSize: 11.5, fontWeight: '700', color: c.textSub },
    strip: { flexDirection: 'row', gap: GAP, paddingVertical: 2 },
    gridOuter: {
      borderWidth: t.borderWidth,
      borderColor: c.border,
      borderRadius: r.md,
      backgroundColor: t.cardBg,
      padding: sp.md,
      ...t.shadow.card,
    },
    gridBox: { maxHeight: 176 },
    grid: { flexDirection: 'row', flexWrap: 'wrap', gap: GAP, padding: 1 },
    cell: {
      width: CELL,
      height: CELL,
      borderRadius: r.sm,
      borderWidth: 1.2,
      alignItems: 'center',
      justifyContent: 'center',
    },
    cellCurrent: {
      borderColor: c.primary,
      borderWidth: 2,
      backgroundColor: c.primarySoft,
    },
    cellTodo: { borderColor: c.border, backgroundColor: c.surface },
    cellCorrect: { borderColor: c.success, backgroundColor: c.successSoft },
    cellWrong: { borderColor: c.danger, backgroundColor: c.dangerSoft },
    cellManual: { borderColor: c.warn, backgroundColor: c.warnSoft },
    cellSeen: { borderColor: c.accent, backgroundColor: c.accentSoft },
    cellText: { fontSize: 13, fontWeight: '700' },
    textIdle: { color: c.textMuted },
    textGood: { color: c.success },
    textBad: { color: c.danger },
    textWarn: { color: c.warn },
    textSeen: { color: c.accent },
    legendRow: { flexDirection: 'row', flexWrap: 'wrap', gap: sp.md, marginTop: sp.md },
    legendItem: { flexDirection: 'row', alignItems: 'center', gap: 5 },
    legendDot: { width: 11, height: 11, borderRadius: 3, borderWidth: 1.2 },
    legendBorder: { borderColor: c.primary },
    legendText: { fontSize: 11, color: c.textMuted },
    pressed: { opacity: 0.8 },
  });
}
