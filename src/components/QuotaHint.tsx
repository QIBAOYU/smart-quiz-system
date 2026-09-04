/**
 * 内置免费模型的额度提醒条。
 *
 * 只在用户选了内置免费模型时出现：左边是模型二（千问）今日剩余次数，
 * 右边单独一小行写模型一的限流说明。计数在数据库，这里只读展示。
 */
import React, { useCallback } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import type { StyleProp, ViewStyle } from 'react-native';
import { useFocusEffect } from 'expo-router';
import { useTheme } from '../store/ThemeContext';
import { useAiStatus } from '../services/aiConfig';
import { refreshQuota, useQuota } from '../services/quotaService';

/** 模型一的固定说明，题库页与设置页共用同一句口径 */
export const ZHIPU_NOTE = '模型一不限次数，但访问限流较高，失败率较大';

export function QuotaHint({ variant = 'card', style }: { variant?: 'card' | 'inline'; style?: StyleProp<ViewStyle> }) {
  const t = useTheme();
  const c = t.palette;
  const ai = useAiStatus();
  const { used, remaining, limit, loaded, unlimited } = useQuota();

  useFocusEffect(
    useCallback(() => {
      void refreshQuota();
    }, []),
  );

  if (!ai.cfg.useBuiltin) return null;

  const exhausted = !unlimited && loaded && remaining <= 0;
  const unloaded = !loaded;
  const tone = unlimited ? c.success : exhausted ? c.danger : c.primary;
  const main = unlimited
    ? '模型二（千问）不限次数'
    : !loaded
      ? '模型二（千问）额度读取中…'
      : exhausted
        ? '模型二（千问）今日已停用'
        : `模型二（千问）今日剩 ${remaining}/${limit}`;

  return (
    <View
      style={
        variant === 'card'
          ? [
              styles.card,
              { backgroundColor: t.cardBg, borderColor: c.border, borderRadius: t.radius.md, ...t.shadow.card },
              style,
            ]
          : [styles.inline, style]
      }
    >
      <View style={styles.row}>
        <View style={[styles.dot, { backgroundColor: tone }]} />
        <Text style={[styles.main, { color: c.text }]}>{main}</Text>
        <Text style={[styles.note, { color: c.textMuted }]} numberOfLines={2}>
          {ZHIPU_NOTE}
        </Text>
      </View>
      {unloaded ? null : unlimited ? (
        <Text style={[styles.sub, { color: c.textMuted }]}>本账号已豁免每日额度，今日已调用 {used} 次，仍可继续正常使用。</Text>
      ) : exhausted ? (
        <Text style={[styles.sub, { color: c.textMuted }]}>明天 00:00 自动恢复；模型一不限次数，可以切回去继续重试。</Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    paddingHorizontal: 13,
    paddingVertical: 11,
    marginBottom: 10,
    gap: 4,
  },
  inline: {
    marginTop: 8,
    gap: 4,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: 6,
  },
  dot: { width: 7, height: 7, borderRadius: 4 },
  main: { fontSize: 12.5, fontWeight: '700' },
  note: { fontSize: 11, lineHeight: 16, flex: 1, minWidth: 130 },
  sub: { fontSize: 11, lineHeight: 16, paddingLeft: 13 },
});
