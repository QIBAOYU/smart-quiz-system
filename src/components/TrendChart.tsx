import React from 'react';
import { StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { colors, radius, spacing } from '../constants/theme';
import type { DayStat } from '../types/quiz';

/** 近 7 日作答趋势：真实数据驱动的柱状图 */
export function TrendChart({ data }: { data: DayStat[] }) {
  const { width } = useWindowDimensions();
  const chartHeight = 132;
  const max = Math.max(1, ...data.map((d) => d.count));
  const innerWidth = width - spacing.lg * 2 - spacing.lg * 2 - 12;
  const slot = innerWidth / Math.max(1, data.length);

  return (
    <View>
      <View style={[styles.plot, { height: chartHeight }]}>
        {data.map((d) => {
          const total = (d.count / max) * (chartHeight - 26);
          const correct = d.count > 0 ? (d.correct / d.count) * total : 0;
          return (
            <View key={d.date} style={[styles.col, { width: slot }]}>
              <Text style={styles.value}>{d.count > 0 ? d.count : ''}</Text>
              <View style={styles.barTrack}>
                <View style={[styles.barBg, { height: Math.max(d.count > 0 ? 6 : 0, total) }]}>
                  <View style={[styles.barFg, { height: Math.max(0, correct) }]} />
                </View>
              </View>
            </View>
          );
        })}
      </View>
      <View style={styles.axis}>
        {data.map((d) => (
          <Text key={d.date} style={[styles.axisLabel, { width: slot }]}>
            {d.label}
          </Text>
        ))}
      </View>
      <View style={styles.legend}>
        <View style={[styles.legendDot, { backgroundColor: colors.primary }]} />
        <Text style={styles.legendText}>正确</Text>
        <View style={[styles.legendDot, { backgroundColor: '#dfe3f0' }]} />
        <Text style={styles.legendText}>作答</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  plot: { flexDirection: 'row', alignItems: 'flex-end' },
  col: { alignItems: 'center', justifyContent: 'flex-end', height: '100%' },
  value: { fontSize: 11, fontWeight: '700', color: colors.textSub, marginBottom: 4, height: 14 },
  barTrack: { width: '62%', flex: 1, justifyContent: 'flex-end' },
  barBg: { width: '100%', backgroundColor: '#dfe3f0', borderTopLeftRadius: radius.sm, borderTopRightRadius: radius.sm, justifyContent: 'flex-end' },
  barFg: { width: '100%', backgroundColor: colors.primary, borderTopLeftRadius: radius.sm, borderTopRightRadius: radius.sm },
  axis: { flexDirection: 'row', marginTop: spacing.sm, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border, paddingTop: 6 },
  axisLabel: { textAlign: 'center', fontSize: 10.5, color: colors.textMuted },
  legend: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: spacing.sm },
  legendDot: { width: 8, height: 8, borderRadius: 4 },
  legendText: { fontSize: 11, color: colors.textSub, marginRight: spacing.sm },
});
