/** 题库卡片：整卡使用当前主题的卡面、圆角与阴影，进度条底槽走 track */
import React, { useMemo } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { Theme } from '../constants/theme';
import { useTheme } from '../store/ThemeContext';
import { ChevronIcon } from './icons';
import type { Bank } from '../types/quiz';

interface Props {
  bank: Bank;
  onOpen: () => void;
  onDelete?: () => void;
}

export function BankCard({ bank, onOpen, onDelete }: Props) {
  const t = useTheme();
  const styles = useMemo(() => buildStyles(t), [t]);
  const c = t.palette;
  const ratio = bank.questionCount > 0 ? bank.reviewedCount / bank.questionCount : 0;
  const pending = bank.questionCount - bank.reviewedCount;
  // 正确率来自统计服务，已是 0-100 百分数；没作答过就不显示徽标
  const attempts = bank.attempts ?? 0;
  const rate = attempts > 0 ? Math.max(0, Math.min(100, Math.round(bank.accuracy ?? 0))) : null;

  return (
    <Pressable
      accessibilityRole="button"
      onPress={onOpen}
      style={({ pressed }) => [styles.card, pressed ? styles.pressed : null]}
    >
      <View style={styles.topRow}>
        <Text style={styles.name} numberOfLines={1}>
          {bank.name}
        </Text>
        <ChevronIcon size={16} color={c.textMuted} />
      </View>

      <Text style={styles.meta} numberOfLines={1}>
        {bank.sourceFile ? `${bank.sourceFile} · ` : ''}
        {bank.createdAt ? bank.createdAt.slice(0, 10) : ''}
      </Text>

      <View style={styles.statRow}>
        <Text style={styles.count}>{bank.questionCount}</Text>
        <Text style={styles.countLabel}>题</Text>
        <View style={styles.badge}>
          <Text style={styles.badgeText}>{bank.isAiBank ? 'AI 辅助' : '本地识别'}</Text>
        </View>
        {pending > 0 ? (
          <View style={[styles.badge, styles.badgeWarn]}>
            <Text style={[styles.badgeText, styles.badgeWarnText]}>{pending} 答案待确认</Text>
          </View>
        ) : null}
        {rate !== null ? (
          <View style={[styles.badge, rate >= 80 ? styles.badgeGood : rate >= 60 ? styles.badgeMid : styles.badgeLow]}>
            <Text style={[styles.badgeText, rate >= 80 ? styles.badgeGoodText : rate >= 60 ? styles.badgeMidText : styles.badgeLowText]}>
              正确率 {rate}%
            </Text>
          </View>
        ) : null}
      </View>

      <View style={styles.track}>
        <View style={[styles.fill, { width: `${Math.round(Math.max(0, Math.min(1, ratio)) * 100)}%` }]} />
      </View>
      <Text style={styles.progressText}>
        已确认 {bank.reviewedCount}/{bank.questionCount}
        {attempts > 0 ? ` · 累计作答 ${attempts} 次` : ''}
      </Text>
    </Pressable>
  );
}

function buildStyles(t: Theme) {
  const c = t.palette;
  const sp = t.spacing;
  return StyleSheet.create({
    card: {
      backgroundColor: t.cardBg,
      borderRadius: t.cardRadius,
      borderWidth: t.borderWidth,
      borderColor: c.border,
      padding: sp.lg,
      ...t.shadow.card,
    },
    pressed: { opacity: 0.92 },
    topRow: { flexDirection: 'row', alignItems: 'center', gap: sp.sm },
    name: { flex: 1, fontSize: 15.5, fontWeight: '700', color: c.text },
    meta: { marginTop: sp.xs, fontSize: 11.5, color: c.textMuted },
    statRow: { flexDirection: 'row', alignItems: 'baseline', gap: 6, marginTop: sp.sm, flexWrap: 'wrap' },
    count: { fontSize: 21, fontWeight: '800', color: c.primary },
    countLabel: { fontSize: 12, color: c.textSub },
    badge: {
      paddingHorizontal: sp.sm,
      paddingVertical: 2,
      borderRadius: t.radius.pill,
      backgroundColor: c.primarySoft,
    },
    badgeText: { fontSize: 11, fontWeight: '600', color: c.primaryDark },
    badgeWarn: { backgroundColor: c.warnSoft },
    badgeWarnText: { color: c.warn },
    badgeGood: { backgroundColor: c.successSoft },
    badgeGoodText: { color: c.success, fontWeight: '700' },
    badgeMid: { backgroundColor: c.primarySoft },
    badgeMidText: { color: c.primaryDark, fontWeight: '700' },
    badgeLow: { backgroundColor: c.dangerSoft },
    badgeLowText: { color: c.danger, fontWeight: '700' },
    track: {
      marginTop: sp.md,
      height: 5,
      borderRadius: t.radius.pill,
      backgroundColor: c.track,
      overflow: 'hidden',
    },
    fill: { height: 5, borderRadius: t.radius.pill, backgroundColor: c.primary },
    progressText: { marginTop: sp.xs, fontSize: 11, color: c.textMuted },
  });
}
