/**
 * 艾宾浩斯遗忘曲线卡片。
 *
 * 实测点：把题按「最近一次答对距今多少天」分桶，看这些桶里的题现在还记得多少。
 * 理论线：R = 100 · e^(-t/S)，S 由上面那批实测点拟合出来，所以虚线是「你自己的遗忘速度」，
 * 不是抄来的教科书曲线。
 */
import React, { useCallback, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import type { StyleProp, ViewStyle } from 'react-native';
import Svg, { Circle, G, Line, Path, Polyline, Text as SvgText } from 'react-native-svg';
import { useFocusEffect } from 'expo-router';
import { useTheme } from '../store/ThemeContext';
import { loadForgettingCurve, type ForgettingCurve } from '../services/statsService';

const CHART_HEIGHT = 168;

function CurveChart({ curve }: { curve: ForgettingCurve }) {
  const t = useTheme();
  const c = t.palette;
  const { width } = useWindowDimensions();
  const w = Math.max(260, width - 74);
  const h = CHART_HEIGHT;
  const padL = 32;
  const padR = 8;
  const padT = 10;
  const padB = 22;
  const innerW = w - padL - padR;
  const innerH = h - padT - padB;
  const n = curve.buckets.length;

  const xAt = (i: number) => padL + (n <= 1 ? innerW / 2 : (i * innerW) / (n - 1));
  const yAt = (r: number) => padT + (1 - Math.max(0, Math.min(100, r)) / 100) * innerH;

  const theoryPath = curve.theory
    .map((p, i) => `${i === 0 ? 'M' : 'L'}${xAt(i).toFixed(1)} ${yAt(p.retention).toFixed(1)}`)
    .join(' ');
  const areaPath = `${theoryPath} L${xAt(n - 1).toFixed(1)} ${yAt(0).toFixed(1)} L${xAt(0).toFixed(1)} ${yAt(0).toFixed(1)} Z`;

  const filled = curve.buckets
    .map((b, i) => ({ ...b, i }))
    .filter((b) => b.sample > 0);
  const measuredPoints = filled.map((b) => `${xAt(b.i).toFixed(1)},${yAt(b.retention).toFixed(1)}`).join(' ');

  return (
    <Svg width={w} height={h}>
      <Path d={areaPath} fill={c.primary} fillOpacity={0.08} />
      {[0, 50, 100].map((r) => (
        <G key={`grid-${r}`}>
          <Line
            x1={padL}
            y1={yAt(r)}
            x2={w - padR}
            y2={yAt(r)}
            stroke={c.border}
            strokeWidth={r === 0 ? 1 : 0.6}
            strokeDasharray={r === 0 ? undefined : '3 3'}
          />
          <SvgText x={padL - 5} y={yAt(r) + 3.5} fill={c.textMuted} fontSize={9} textAnchor="end">
            {`${r}%`}
          </SvgText>
        </G>
      ))}
      <Path d={theoryPath} fill="none" stroke={c.accent} strokeWidth={1.8} strokeDasharray="5 4" />
      {filled.length >= 2 ? (
        <Polyline points={measuredPoints} fill="none" stroke={c.primary} strokeWidth={2} strokeLinejoin="round" />
      ) : null}
      {filled.map((b) => (
        <G key={`dot-${b.label}`}>
          <Circle cx={xAt(b.i)} cy={yAt(b.retention)} r={4} fill={c.primary} stroke={t.cardBg} strokeWidth={1.4} />
          <SvgText
            x={xAt(b.i)}
            y={yAt(b.retention) - 8}
            fill={c.textSub}
            fontSize={9}
            fontWeight="600"
            textAnchor="middle"
          >
            {`${b.sample}`}
          </SvgText>
        </G>
      ))}
      {curve.buckets.map((b, i) => (
        <SvgText key={`x-${b.label}`} x={xAt(i)} y={h - 6} fill={c.textMuted} fontSize={8.5} textAnchor="middle">
          {b.label}
        </SvgText>
      ))}
    </Svg>
  );
}

export function ForgettingCurveCard({ bankId, style }: { bankId?: string; style?: StyleProp<ViewStyle> }) {
  const t = useTheme();
  const c = t.palette;
  const [curve, setCurve] = useState<ForgettingCurve | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      setCurve(await loadForgettingCurve(bankId));
    } catch (error) {
      console.error('[curve] 读取遗忘曲线失败:', error);
    } finally {
      setLoading(false);
    }
  }, [bankId]);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  return (
    <View style={[styles.card, { backgroundColor: t.cardBg, borderColor: c.border, borderRadius: t.radius.md, ...t.shadow.card }, style]}>
      <Text style={styles.title}>遗忘曲线（艾宾浩斯）</Text>
      <Text style={[styles.hint, { color: c.textMuted }]}>
        按「最近一次答对距今几天」分组，看这些题现在还记得多少；虚线 R = e^(-t/S) 是按你的真实数据拟合出的遗忘速度。
      </Text>

      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator color={c.primary} />
        </View>
      ) : !curve || curve.sample === 0 ? (
        <Text style={[styles.empty, { color: c.textMuted }]}>
          还没有可统计的作答。答对过题目之后回到这里，就能看到你的记忆衰减曲线。
        </Text>
      ) : (
        <View>
          <CurveChart curve={curve} />
          <View style={styles.legend}>
            <View style={[styles.legendDash, { backgroundColor: c.accent }]} />
            <Text style={[styles.legendText, { color: c.textSub }]}>
              理论曲线 S≈{curve.stabilityDays} 天
            </Text>
            <View style={[styles.legendDot, { backgroundColor: c.primary }]} />
            <Text style={[styles.legendText, { color: c.textSub }]}>实测留存（数字=题数）</Text>
          </View>
          <View style={[styles.summary, { borderTopColor: c.border }]}>
            <Text style={[styles.summaryText, { color: c.textSub }]}>
              参与统计 {curve.sample} 题 · 现在仍记得 {curve.remembered} 题（{curve.currentRetention}%）
            </Text>
            <Text style={[styles.summarySub, { color: c.textMuted }]}>
              {curve.enough
                ? `S 越大说明忘得越慢；答对后拖到 ${curve.buckets.filter((b) => b.sample > 0).slice(-1)[0]?.label ?? '更久'} 的那批题，是当前记得最牢的一组。`
                : '样本还少（不足 8 题），曲线会随刷题次数增多越来越准。'}
            </Text>
          </View>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { padding: 14, marginBottom: 14, gap: 6 },
  title: { fontSize: 13, fontWeight: '600', color: '#7b8494' },
  hint: { fontSize: 11.5, lineHeight: 17 },
  center: { paddingVertical: 26, alignItems: 'center' },
  empty: { fontSize: 12, lineHeight: 18, paddingVertical: 14 },
  legend: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 2, flexWrap: 'wrap' },
  legendDash: { width: 14, height: 2, borderRadius: 1 },
  legendDot: { width: 8, height: 8, borderRadius: 4, marginLeft: 6 },
  legendText: { fontSize: 11 },
  summary: { marginTop: 8, paddingTop: 8, borderTopWidth: StyleSheet.hairlineWidth, gap: 3 },
  summaryText: { fontSize: 12 },
  summarySub: { fontSize: 11, lineHeight: 16 },
});
