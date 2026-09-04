import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { colors, radius, shadow, spacing } from '../constants/theme';
import { SparkIcon, UploadIcon } from './icons';

const STEPS = [
  { title: '导入资料', desc: '支持 PDF / Word 试卷、知识点总结、复习提纲' },
  { title: '校对题目', desc: '逐题检查识别结果，标记答案确认状态，低置信度会提醒' },
  { title: '开始刷题', desc: '顺序、随机、背题、错题重练四种模式随时切换' },
];

/** 首页空态：明确告诉用户下一步做什么，避免"进来一片空白" */
export function EmptyGuide({ onImport }: { onImport: () => void }) {
  return (
    <View style={styles.wrap}>
      <View style={styles.hero}>
        <View style={styles.heroIcon}>
          <UploadIcon size={26} color="#fff" />
        </View>
        <Text style={styles.title}>还没有题库</Text>
        <Text style={styles.subtitle}>
          导入一份试卷或复习资料，系统会自动识别题目、选项与答案，
          校对之后就能立刻开始刷题。
        </Text>
      </View>

      <Pressable accessibilityRole="button" onPress={onImport} style={({ pressed }) => [styles.cta, pressed ? styles.ctaPressed : null]}>
        <UploadIcon size={20} color="#fff" />
        <Text style={styles.ctaText}>导入题库资料</Text>
      </Pressable>

      <View style={styles.steps}>
        {STEPS.map((s, i) => (
          <View key={s.title} style={styles.step}>
            <View style={styles.stepIndex}>
              <Text style={styles.stepIndexText}>{i + 1}</Text>
            </View>
            <View style={styles.stepBody}>
              <Text style={styles.stepTitle}>{s.title}</Text>
              <Text style={styles.stepDesc}>{s.desc}</Text>
            </View>
          </View>
        ))}
      </View>

      <View style={styles.tip}>
        <SparkIcon size={14} color={colors.accent} />
        <Text style={styles.tipText}>
          识别以本地规则为主，题目多、排版复杂时可开启 AI 辅助解析提升准确率。
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { paddingTop: spacing.md },
  hero: { alignItems: 'center', paddingHorizontal: spacing.xl },
  heroIcon: {
    width: 62,
    height: 62,
    borderRadius: radius.xl,
    backgroundColor: colors.primarySoft,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing.lg,
  },
  title: { fontSize: 20, fontWeight: '800', color: colors.text, marginBottom: spacing.sm },
  subtitle: {
    fontSize: 14,
    lineHeight: 22,
    color: colors.textSub,
    textAlign: 'center',
    maxWidth: 300,
  },
  cta: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    height: 52,
    borderRadius: radius.lg,
    backgroundColor: colors.primary,
    marginTop: spacing.xl,
    marginHorizontal: spacing.lg,
    ...shadow.float,
  },
  ctaPressed: { opacity: 0.9 },
  ctaText: { color: '#fff', fontSize: 16, fontWeight: '700' },
  steps: {
    marginTop: spacing.xxl,
    marginHorizontal: spacing.lg,
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    padding: spacing.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    gap: spacing.lg,
    ...shadow.card,
  },
  step: { flexDirection: 'row', gap: spacing.md },
  stepIndex: {
    width: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: colors.primarySoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stepIndexText: { fontSize: 12, fontWeight: '800', color: colors.primaryDark },
  stepBody: { flex: 1 },
  stepTitle: { fontSize: 14.5, fontWeight: '700', color: colors.text },
  stepDesc: { fontSize: 12.5, lineHeight: 19, color: colors.textSub, marginTop: 2 },
  tip: {
    flexDirection: 'row',
    gap: spacing.sm,
    alignItems: 'flex-start',
    marginHorizontal: spacing.lg,
    marginTop: spacing.lg,
    marginBottom: spacing.xl,
    backgroundColor: colors.warnSoft,
    borderRadius: radius.md,
    padding: spacing.md,
  },
  tipText: { flex: 1, fontSize: 12, lineHeight: 18, color: '#92400e' },
});
