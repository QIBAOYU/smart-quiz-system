/**
 * 后台 AI 解析任务层
 *
 * 展开态：顶格固定的进度条，不随页面滚动、也不遮挡内容（页面通过 useTaskInset 预留高度）。
 * 收起态：右上角胶囊，随时可以再点开查看进度 —— 解决"关掉之后进程没地方看"的问题。
 */
import React, { useEffect, useRef } from 'react';
import { Animated, Easing, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../store/ThemeContext';
import { CloseIcon, SparkIcon } from './icons';
import { useApp } from '../store/AppContext';

export const TASK_BAR_HEIGHT = 66;

/** 页面顶部需要为任务条让出的高度 */
export function useTaskInset(): number {
  const { aiTask, taskBarVisible } = useApp();
  if (!aiTask || !taskBarVisible) return 0;
  return TASK_BAR_HEIGHT;
}

function IndeterminateBar({ track, fill }: { track: string; fill: string }) {
  const value = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.timing(value, { toValue: 1, duration: 1200, easing: Easing.inOut(Easing.ease), useNativeDriver: false }),
    );
    loop.start();
    return () => loop.stop();
  }, [value]);
  const width = value.interpolate({ inputRange: [0, 0.5, 1], outputRange: ['8%', '60%', '8%'] });
  const left = value.interpolate({ inputRange: [0, 0.5, 1], outputRange: ['0%', '30%', '82%'] });
  return (
    <View style={[styles.indetTrack, { backgroundColor: track }]}>
      <Animated.View style={[styles.indetFill, { width, left, backgroundColor: fill }]} />
    </View>
  );
}

export function AiTaskLayer() {
  const { aiTask, taskBarVisible, setTaskBarVisible, clearAiTask } = useApp();
  const insets = useSafeAreaInsets();
  const t = useTheme();
  const c = t.palette;
  if (!aiTask) return null;

  const ratio = aiTask.total > 0 ? aiTask.done / aiTask.total : 0;
  const running = aiTask.status === 'running';
  const statusText =
    aiTask.status === 'done'
      ? `已完成 · 共 ${aiTask.collected} 题`
      : aiTask.status === 'failed'
        ? aiTask.message || '解析失败'
        : aiTask.status === 'cancelled'
          ? '已取消'
          : `第 ${aiTask.done}/${aiTask.total} 段 · 已识别 ${aiTask.collected} 题`;
  const tone = aiTask.status === 'failed' ? c.danger : aiTask.status === 'cancelled' ? c.textSub : c.primary;

  if (!taskBarVisible) {
    return (
      <Pressable
        accessibilityRole="button"
        onPress={() => setTaskBarVisible(true)}
        style={[styles.pill, { top: insets.top + 10, backgroundColor: c.primary, ...t.shadow.float }]}
      >
        <SparkIcon size={15} color={c.onPrimary} />
        <Text style={[styles.pillText, { color: c.onPrimary }]}>
          {running ? `AI 解析中 ${aiTask.done}/${aiTask.total}` : '查看解析结果'}
        </Text>
      </Pressable>
    );
  }

  return (
    <View
      style={[
        styles.bar,
        {
          paddingTop: insets.top + 8,
          backgroundColor: c.tabBar,
          borderColor: c.border,
          ...t.shadow.card,
        },
      ]}
    >
      <View style={styles.barRow}>
        <View style={styles.barLeft}>
          <Text style={[styles.label, { color: c.text }]} numberOfLines={1}>
            {aiTask.label}
          </Text>
          <Text style={[styles.status, { color: tone }]} numberOfLines={1}>
            {statusText}
          </Text>
        </View>
        <Pressable accessibilityRole="button" onPress={() => setTaskBarVisible(false)} hitSlop={10} style={styles.iconBtn}>
          <Text style={[styles.collapseText, { color: c.primary }]}>收起</Text>
        </Pressable>
        <Pressable accessibilityRole="button" onPress={clearAiTask} hitSlop={10} style={styles.iconBtn}>
          <CloseIcon size={16} color={c.textMuted} />
        </Pressable>
      </View>
      {running ? (
        <IndeterminateBar track={c.track} fill={c.primary} />
      ) : (
        <View style={[styles.finishedTrack, { backgroundColor: c.track }]}>
          <View style={[styles.finishedFill, { width: `${Math.round(ratio * 100)}%`, backgroundColor: tone }]} />
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    zIndex: 50,
    borderBottomWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 16,
    paddingBottom: 12,
    minHeight: TASK_BAR_HEIGHT,
    justifyContent: 'center',
  },
  barRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  barLeft: { flex: 1 },
  label: { fontSize: 13, fontWeight: '700' },
  status: { fontSize: 12, marginTop: 2 },
  iconBtn: { paddingHorizontal: 4, paddingVertical: 4 },
  collapseText: { fontSize: 12, fontWeight: '600' },
  indetTrack: { height: 4, borderRadius: 999, marginTop: 8, overflow: 'hidden' },
  indetFill: { position: 'absolute', top: 0, bottom: 0, borderRadius: 999 },
  finishedTrack: { height: 4, borderRadius: 999, marginTop: 8, overflow: 'hidden' },
  finishedFill: { height: '100%', borderRadius: 999 },
  pill: {
    position: 'absolute',
    right: 16,
    zIndex: 50,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 7,
  },
  pillText: { fontSize: 12, fontWeight: '700' },
});
