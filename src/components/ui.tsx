/**
 * 共享 UI 原语（主题感知）
 *
 * 层次感规则：
 * - flat：卡片靠柔光投影分层
 * - neumorphic：靠双向柔光（亮边 + 暗边）
 * - sketch：靠墨线描边 + 硬边偏移投影
 */
import React from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View, type ViewStyle } from 'react-native';
import { useTheme } from '../store/ThemeContext';

type Tone = 'neutral' | 'primary' | 'success' | 'danger' | 'warn' | 'ai';

export function Card({
  children,
  style,
  onPress,
  padded = true,
  tone = 'raised',
}: {
  children: React.ReactNode;
  style?: ViewStyle;
  onPress?: () => void;
  padded?: boolean;
  /** raised = 有投影分层；flat = 与背景同色无投影；inset = 内凹 */
  tone?: 'raised' | 'flat' | 'inset';
}) {
  const t = useTheme();
  const p = t.palette;
  const shadowSet = tone === 'raised' ? t.shadow.card : tone === 'inset' ? t.shadow.inset : ({} as ViewStyle);
  const base: ViewStyle = {
    backgroundColor: t.cardBg,
    borderRadius: t.cardRadius,
    padding: padded ? t.spacing.lg : 0,
    borderWidth: t.borderWidth,
    borderColor: p.border,
    ...(tone === 'flat' ? {} : shadowSet),
  };
  if (t.tone === 'neumorphic') {
    base.borderColor = p.border;
    base.backgroundColor = p.surface;
  }
  const inner = <View style={[base, style]}>{children}</View>;
  if (!onPress) return inner;
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [t.tone === 'neumorphic' ? {} : { transform: [{ scale: pressed ? 0.985 : 1 }] }, { opacity: pressed ? 0.92 : 1 }]}
    >
      {inner}
    </Pressable>
  );
}

export function SectionTitle({
  title,
  hint,
  action,
  style,
}: {
  title: string;
  hint?: string;
  action?: React.ReactNode;
  style?: ViewStyle;
}) {
  const t = useTheme();
  return (
    <View style={[styles.sectionHead, style]}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: t.spacing.sm }}>
        <View style={{ width: 3, height: 15, borderRadius: 2, backgroundColor: t.palette.primary }} />
        <Text style={[styles.sectionTitle, { color: t.palette.text }]}>{title}</Text>
      </View>
      {action ?? (hint ? <Text style={[styles.sectionHint, { color: t.palette.textMuted }]}>{hint}</Text> : null)}
    </View>
  );
}

export function Tag({ label, tone = 'neutral' }: { label: string; tone?: Tone }) {
  const t = useTheme();
  const p = t.palette;
  const map: Record<Tone, { bg: string; fg: string }> = {
    neutral: { bg: p.track, fg: p.textSub },
    primary: { bg: p.primarySoft, fg: p.primaryDark },
    success: { bg: p.successSoft, fg: p.success },
    danger: { bg: p.dangerSoft, fg: p.danger },
    warn: { bg: p.warnSoft, fg: p.warn },
    ai: { bg: p.accentSoft, fg: p.accent },
  };
  const c = map[tone];
  return (
    <View
      style={[
        styles.tag,
        {
          backgroundColor: c.bg,
          borderColor: t.tone === 'sketch' ? p.border : 'transparent',
        },
      ]}
    >
      <Text style={[styles.tagText, { color: c.fg }]}>{label}</Text>
    </View>
  );
}

export function PrimaryButton({
  label,
  onPress,
  loading,
  disabled,
  tone = 'primary',
  style,
  size = 'md',
}: {
  label: string;
  onPress: () => void;
  loading?: boolean;
  disabled?: boolean;
  tone?: 'primary' | 'accent' | 'ghost' | 'danger' | 'soft';
  style?: ViewStyle;
  size?: 'sm' | 'md';
}) {
  const t = useTheme();
  const p = t.palette;
  const bg =
    tone === 'accent' ? p.accent : tone === 'ghost' ? 'transparent' : tone === 'danger' ? p.danger : tone === 'soft' ? p.primarySoft : p.primary;
  const fg = tone === 'ghost' ? p.textSub : tone === 'soft' ? p.primaryDark : p.onPrimary;
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      disabled={disabled || loading}
      style={({ pressed }) => [
        styles.button,
        {
          height: size === 'sm' ? 40 : 50,
          borderRadius: t.tone === 'sketch' ? t.radius.md : t.radius.md,
          backgroundColor: bg,
          opacity: disabled ? 0.45 : pressed ? 0.9 : 1,
          borderWidth: tone === 'ghost' ? 1.2 : t.tone === 'sketch' ? 1.4 : 0,
          borderColor: tone === 'ghost' ? p.border : t.tone === 'sketch' ? p.border : 'transparent',
          ...(tone === 'primary' || tone === 'accent' ? t.shadow.card : {}),
        },
        style,
      ]}
    >
      {loading ? <ActivityIndicator size="small" color={fg} /> : <Text style={[styles.buttonText, { color: fg, fontSize: size === 'sm' ? 14 : 16 }]}>{label}</Text>}
    </Pressable>
  );
}

export function Chip({
  label,
  active,
  onPress,
  style,
}: {
  label: string;
  active?: boolean;
  onPress?: () => void;
  style?: ViewStyle;
}) {
  const t = useTheme();
  const p = t.palette;
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [
        styles.chip,
        {
          backgroundColor: active ? p.primarySoft : t.chipBg,
          borderColor: active ? p.primary : t.tone === 'sketch' ? p.border : p.border,
          borderWidth: active ? 1.4 : t.tone === 'sketch' ? 1.2 : 1,
          opacity: pressed ? 0.85 : 1,
        },
        style,
      ]}
    >
      <Text style={[styles.chipText, { color: active ? p.primaryDark : p.textSub }]}>{label}</Text>
    </Pressable>
  );
}

export function Switch({ value, onToggle }: { value: boolean; onToggle: () => void }) {
  const t = useTheme();
  const p = t.palette;
  return (
    <Pressable
      accessibilityRole="switch"
      accessibilityState={{ checked: value }}
      onPress={onToggle}
      style={[
        styles.switch,
        {
          backgroundColor: value ? p.primary : p.track,
          borderColor: t.tone === 'sketch' ? p.border : 'transparent',
        },
      ]}
    >
      <View style={[styles.switchKnob, { backgroundColor: p.surface }, value ? styles.knobOn : null, t.shadow.inset]} />
    </Pressable>
  );
}

export function ProgressBar({ ratio, color, height = 6 }: { ratio: number; color?: string; height?: number }) {
  const t = useTheme();
  const clamped = Math.max(0, Math.min(1, ratio));
  return (
    <View style={{ height, borderRadius: t.radius.pill, backgroundColor: t.palette.track, overflow: 'hidden' }}>
      <View
        style={{
          width: `${clamped * 100}%`,
          height: '100%',
          borderRadius: t.radius.pill,
          backgroundColor: color ?? t.palette.primary,
        }}
      />
    </View>
  );
}

export function LoadingBlock({ label }: { label: string }) {
  const t = useTheme();
  return (
    <View style={styles.loading}>
      <ActivityIndicator color={t.palette.primary} />
      <Text style={[styles.loadingText, { color: t.palette.textSub }]}>{label}</Text>
    </View>
  );
}

export function StatTile({ value, label, tone = 'primary' }: { value: string; label: string; tone?: 'primary' | 'success' | 'danger' | 'neutral' }) {
  const t = useTheme();
  const p = t.palette;
  const fg = tone === 'success' ? p.success : tone === 'danger' ? p.danger : tone === 'neutral' ? p.text : p.primary;
  return (
    <Card tone={t.tone === 'neumorphic' ? 'raised' : 'raised'} style={{ flex: 1, alignItems: 'center', paddingVertical: t.spacing.lg }}>
      <Text style={[styles.statValue, { color: fg, fontSize: t.tone === 'sketch' ? 22 : 24 }]}>{value}</Text>
      <Text style={[styles.statLabel, { color: p.textMuted }]}>{label}</Text>
    </Card>
  );
}

export function Divider({ style }: { style?: ViewStyle }) {
  const t = useTheme();
  return <View style={[{ height: StyleSheet.hairlineWidth, backgroundColor: t.palette.border, marginVertical: t.spacing.md }, style]} />;
}

const styles = StyleSheet.create({
  sectionHead: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 12,
    marginTop: 22,
  },
  sectionTitle: { fontSize: 16, fontWeight: '700' },
  sectionHint: { fontSize: 12 },
  tag: { borderRadius: 999, paddingHorizontal: 8, paddingVertical: 3, borderWidth: 1 },
  tagText: { fontSize: 11, fontWeight: '600' },
  button: { alignItems: 'center', justifyContent: 'center', paddingHorizontal: 16 },
  buttonText: { fontWeight: '700' },
  chip: { borderRadius: 999, paddingHorizontal: 12, paddingVertical: 7 },
  chipText: { fontSize: 13, fontWeight: '600' },
  switch: { width: 46, height: 28, borderRadius: 999, padding: 3, justifyContent: 'center', borderWidth: 1 },
  switchKnob: { width: 22, height: 22, borderRadius: 11 },
  knobOn: { alignSelf: 'flex-end' },
  loading: { alignItems: 'center', justifyContent: 'center', paddingVertical: 30, gap: 8 },
  loadingText: { fontSize: 13 },
  statValue: { fontWeight: '800' },
  statLabel: { fontSize: 12, marginTop: 2 },
});
