/**
 * 逐题编辑卡：题干、选项、答案、解析、置信度。
 * 视觉跟随用户所选主题（配色 + 圆角 + 阴影层次），业务逻辑不变。
 */
import React, { useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import type { Theme } from '../constants/theme';
import { typeLabels } from '../constants/theme';
import { useTheme } from '../store/ThemeContext';
import { CheckIcon, ChevronIcon, SparkIcon, TrashIcon } from './icons';
import { dialog } from './dialog';
import { answerLetters, letterOf, normalizeText, optionBody } from '../services/quizEngine';
import type { ParsedQuestion, QuestionType } from '../types/quiz';

export type EditableQuestion = ParsedQuestion;

interface Props {
  value: EditableQuestion;
  order: number;
  onSave: (patch: Partial<EditableQuestion>) => void;
  onDelete: () => void;
  onToggleReview: () => void;
  /** 「添加AI生成类似题」入口，仅题库详情页提供 */
  onSimilar?: () => void;
  /** 是否已收藏（星标点亮） */
  favorite?: boolean;
  /** 收藏切换入口，仅题库详情页提供；导入草稿没有题目 id，不传即不渲染星标 */
  onToggleFavorite?: () => void;
}

const TYPES: QuestionType[] = ['choice', 'tf', 'fill', 'short'];

/** 难度档位：与 quiz_questions.difficulty 列同口径（1/2/3，0 = 未标注） */
const DIFFICULTIES: Array<{ value: number; label: string }> = [
  { value: 1, label: '简单' },
  { value: 2, label: '中等' },
  { value: 3, label: '困难' },
];

export function difficultyLabel(value: number): string {
  return DIFFICULTIES.find((d) => d.value === value)?.label ?? '';
}

/**
 * 入库前校验：脏题一旦保存，判分永远判不对（答案字母不在选项里、判断题认不出对错），
 * 而且错题本会静默积累。这里只做「能不能判分」的硬校验，不做主观质量判断。
 * 返回 null = 通过；否则是给用户看的中文原因。
 */
function validateDraft(draft: ParsedQuestion): string | null {
  const stem = String(draft.stem ?? '').replace(/\s/g, '');
  if (!stem) return '题干不能为空，请填写题目内容。';

  if (draft.type === 'choice') {
    const opts = draft.options ?? [];
    const used = opts.filter((o) => String(o).trim().length > 0);
    if (used.length < 2) return '选择题至少需要 2 个有内容的选项。';
    const bodies = used.map((o) => normalizeText(optionBody(o)));
    const dup = bodies.find((b, i) => b.length > 0 && bodies.indexOf(b) !== i);
    if (dup !== undefined) {
      const at = bodies.indexOf(dup);
      return `选项 ${letterOf(used[at], at)} 与前面的选项内容完全重复，请修改后再保存。`;
    }
    const letters = answerLetters(draft);
    if (letters.length === 0) return '未识别到有效答案，请在答案处填写选项字母（如 A 或 ABD）。';
    const valid = new Set(used.map((o, i) => letterOf(o, i)));
    const bad = letters.find((l) => !valid.has(l));
    if (bad) {
      return `答案包含选项 ${bad}，但本题只有 ${Array.from(valid).join('、')} 这几个选项，请检查。`;
    }
    return null;
  }

  if (draft.type === 'tf') {
    if (draft.answerBool === null && tfValueOf(draft.answer) === null) {
      return '判断题的答案无法判定对错，请填写「正确」或「错误」。';
    }
    return null;
  }

  if (draft.type === 'fill' && !String(draft.answer ?? '').trim()) {
    return '填空题必须至少有一个空的参考答案。';
  }
  return null;
}

/** 判断题答案文本 → 布尔；与 quizEngine 同口径，但不导出以免污染判分入口 */
function tfValueOf(value: string): boolean | null {
  const v = normalizeText(value);
  if (!v) return null;
  if (['正确', '对', '是', 'true', 't', '√'].includes(v)) return true;
  if (['错误', '错', '否', 'false', 'f', '×'].includes(v)) return false;
  return null;
}

export function QuestionEditor({ value, order, onSave, onDelete, onToggleReview, onSimilar, favorite = false, onToggleFavorite }: Props) {
  const t = useTheme();
  const styles = useMemo(() => buildStyles(t), [t]);
  const c = t.palette;

  const [open, setOpen] = useState(false);
  const [stem, setStem] = useState(value.stem);
  const [answer, setAnswer] = useState(value.answer);
  const [explain, setExplain] = useState(value.explanation);
  const [options, setOptions] = useState<string[]>(value.options.length ? value.options : []);
  const [difficulty, setDifficulty] = useState<number>(value.difficulty ?? 0);

  const commit = (patch: Partial<EditableQuestion>) => onSave(patch);

  const saveAll = () => {
    const patch: Partial<EditableQuestion> = {
      stem: stem.trim() || value.stem,
      answer: value.type === 'tf' ? value.answer : answer.trim(),
      explanation: explain.trim(),
      options: value.type === 'choice' ? options.filter((o) => o.trim().length > 0) : [],
      difficulty,
    };
    const problem = validateDraft({ ...value, ...patch });
    if (problem) {
      dialog.alert('这道题保存不了', problem);
      return;
    }
    commit(patch);
    setOpen(false);
  };

  const setOption = (index: number, text: string) => {
    const next = [...options];
    next[index] = text;
    setOptions(next);
  };

  const confidenceLabel = Math.round(value.confidence * 100);

  return (
    <View style={styles.card}>
      <View style={styles.headRow}>
        <View style={styles.orderBadge}>
          <Text style={styles.orderText}>{order}</Text>
        </View>
        <Pressable accessibilityRole="button" onPress={() => setOpen((v) => !v)} style={styles.typeChip}>
          <Text style={styles.typeChipText}>{typeLabels[value.type]}</Text>
          <ChevronIcon size={13} color={c.primaryDark} dir="down" />
        </Pressable>
        {value.subject ? (
          <View style={styles.subjectChip}>
            <Text style={styles.subjectChipText}>{value.subject}</Text>
          </View>
        ) : null}
        <View style={styles.flex} />
        {onToggleFavorite ? (
          <Pressable
            accessibilityRole="button"
            hitSlop={10}
            onPress={onToggleFavorite}
            style={styles.favBtn}
          >
            <Text style={[styles.favStar, { color: favorite ? c.warn : c.textMuted }]}>
              {favorite ? '★' : '☆'}
            </Text>
          </Pressable>
        ) : null}
        <Pressable
          accessibilityRole="button"
          hitSlop={8}
          onPress={onToggleReview}
          style={[styles.reviewPill, value.reviewed ? styles.reviewOn : styles.reviewOff]}
        >
          {value.reviewed ? <CheckIcon size={12} color={c.success} /> : null}
          <Text style={[styles.reviewText, value.reviewed ? styles.reviewTextOn : styles.reviewTextOff]}>
            {value.reviewed ? '答案已确认' : '答案待确认'}
          </Text>
        </Pressable>
        <Pressable accessibilityRole="button" hitSlop={10} onPress={onDelete} style={styles.delBtn}>
          <TrashIcon size={16} color={c.danger} />
        </Pressable>
      </View>

      <Text style={styles.stem} numberOfLines={open ? undefined : 2}>
        {stem || value.stem}
      </Text>

      {!open ? (
        <View style={styles.metaRow}>
          <Text style={styles.metaAnswer} numberOfLines={1}>
            {value.answer ? `答案：${value.answer}` : value.answerBool !== null ? `答案：${value.answerBool ? '正确' : '错误'}` : '答案：待补充'}
            {value.difficulty ? ` · ${difficultyLabel(value.difficulty)}` : ''}
          </Text>
          <View style={styles.confWrap}>
            <View style={styles.confTrack}>
              <View style={[styles.confFill, { width: `${Math.max(6, confidenceLabel)}%` as `${number}%`, backgroundColor: c.warn }]} />
            </View>
            <Text style={styles.confText}>{confidenceLabel}%</Text>
          </View>
        </View>
      ) : null}

      {open ? (
        <View style={styles.body}>
          <Text style={styles.label}>题型</Text>
          <View style={styles.typeRow}>
            {TYPES.map((tp) => (
              <Pressable
                key={tp}
                accessibilityRole="button"
                onPress={() => commit({ type: tp, options: tp === 'choice' ? (options.length ? options : ['', '']) : [] })}
                style={[styles.typeBtn, value.type === tp ? styles.typeBtnOn : null]}
              >
                <Text style={[styles.typeBtnText, value.type === tp ? styles.typeBtnTextOn : null]}>{typeLabels[tp]}</Text>
              </Pressable>
            ))}
          </View>

          <Text style={styles.label}>难度</Text>
          <View style={styles.typeRow}>
            {DIFFICULTIES.map((d) => (
              <Pressable
                key={d.value}
                accessibilityRole="button"
                onPress={() => setDifficulty((cur) => (cur === d.value ? 0 : d.value))}
                style={[styles.typeBtn, difficulty === d.value ? styles.typeBtnOn : null]}
              >
                <Text style={[styles.typeBtnText, difficulty === d.value ? styles.typeBtnTextOn : null]}>{d.label}</Text>
              </Pressable>
            ))}
          </View>

          <Text style={styles.label}>题干</Text>
          <TextInput
            style={styles.areaInput}
            value={stem}
            onChangeText={setStem}
            multiline
            placeholder="请输入题干"
            placeholderTextColor={c.textMuted}
          />

          {value.type === 'choice' ? (
            <>
              <Text style={styles.label}>选项</Text>
              <View style={styles.optList}>
                {(options.length ? options : ['', '']).map((opt, i) => (
                  <View key={`opt_${i}`} style={styles.optRow}>
                    <View style={styles.optLetter}>
                      <Text style={styles.optLetterText}>{String.fromCharCode(65 + i)}</Text>
                    </View>
                    <TextInput
                      style={styles.optInput}
                      value={opt}
                      onChangeText={(v) => setOption(i, v)}
                      placeholder={`选项 ${String.fromCharCode(65 + i)}`}
                      placeholderTextColor={c.textMuted}
                    />
                  </View>
                ))}
                <Pressable
                  accessibilityRole="button"
                  onPress={() => setOptions([...(options.length ? options : []), ''])}
                  style={styles.addOpt}
                >
                  <Text style={styles.addOptText}>+ 增加一个选项</Text>
                </Pressable>
              </View>
            </>
          ) : null}

          {value.type === 'tf' ? (
            <>
              <Text style={styles.label}>判断结果</Text>
              <View style={styles.tfRow}>
                {[
                  { label: '正确', bool: true },
                  { label: '错误', bool: false },
                ].map((item) => {
                  const active = value.answerBool === item.bool;
                  return (
                    <Pressable
                      key={item.label}
                      accessibilityRole="button"
                      onPress={() => {
                        setAnswer(item.label);
                        commit({ answerBool: item.bool, answer: item.label });
                      }}
                      style={[styles.tfBtn, active ? styles.tfBtnOn : null]}
                    >
                      <Text style={[styles.tfText, active ? styles.tfTextOn : null]}>{item.label}</Text>
                    </Pressable>
                  );
                })}
              </View>
            </>
          ) : (
            <>
              <Text style={styles.label}>答案</Text>
              <TextInput
                style={styles.input}
                value={answer}
                onChangeText={setAnswer}
                multiline={value.type === 'short'}
                placeholder={value.type === 'fill' ? '多个空用 ||| 分隔' : '请输入标准答案'}
                placeholderTextColor={c.textMuted}
              />
            </>
          )}

          <Text style={styles.label}>解析</Text>
          <TextInput
            style={styles.input}
            value={explain}
            onChangeText={setExplain}
            multiline
            placeholder="选填，帮助理解这道题"
            placeholderTextColor={c.textMuted}
          />

          {onSimilar ? (
            <Pressable
              accessibilityRole="button"
              onPress={onSimilar}
              style={({ pressed }) => [styles.similarBtn, pressed ? styles.pressed : null]}
            >
              <SparkIcon size={14} color={c.accent} />
              <Text style={styles.similarText}>添加AI生成类似题</Text>
            </Pressable>
          ) : null}

          <View style={styles.actionRow}>
            <Pressable accessibilityRole="button" onPress={() => setOpen(false)} style={styles.cancelBtn}>
              <Text style={styles.cancelText}>收起</Text>
            </Pressable>
            <Pressable accessibilityRole="button" onPress={saveAll} style={({ pressed }) => [styles.saveBtn, pressed ? styles.pressed : null]}>
              <Text style={styles.saveText}>保存本题</Text>
            </Pressable>
          </View>
        </View>
      ) : null}
    </View>
  );
}

function buildStyles(t: Theme) {
  const c = t.palette;
  const r = t.radius;
  const sp = t.spacing;
  return StyleSheet.create({
    card: {
      backgroundColor: t.cardBg,
      borderRadius: t.cardRadius,
      borderWidth: t.borderWidth,
      borderColor: c.border,
      padding: sp.lg,
      gap: sp.sm,
      ...t.shadow.card,
    },
    headRow: { flexDirection: 'row', alignItems: 'center', gap: sp.sm },
    orderBadge: {
      minWidth: 26,
      height: 26,
      paddingHorizontal: 6,
      borderRadius: r.sm,
      backgroundColor: c.surfaceAlt,
      alignItems: 'center',
      justifyContent: 'center',
    },
    orderText: { fontSize: 12.5, fontWeight: '800', color: c.textSub },
    typeChip: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 4,
      paddingHorizontal: sp.md,
      height: 26,
      borderRadius: r.pill,
      backgroundColor: c.primarySoft,
    },
    typeChipText: { fontSize: 12, fontWeight: '700', color: c.primaryDark },
    subjectChip: {
      paddingHorizontal: sp.md,
      height: 26,
      borderRadius: r.pill,
      backgroundColor: c.accentSoft,
      alignItems: 'center',
      justifyContent: 'center',
    },
    subjectChipText: { fontSize: 12, fontWeight: '700', color: c.accent },
    similarBtn: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 6,
      height: 42,
      borderRadius: r.md,
      borderWidth: 1.4,
      borderColor: c.accent,
      backgroundColor: c.accentSoft,
      marginTop: sp.sm,
    },
    similarText: { fontSize: 14, fontWeight: '700', color: c.accent },
    flex: { flex: 1 },
    reviewPill: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 3,
      paddingHorizontal: sp.sm,
      height: 24,
      borderRadius: r.pill,
    },
    reviewOn: { backgroundColor: c.successSoft },
    reviewOff: { backgroundColor: c.warnSoft },
    reviewText: { fontSize: 11.5, fontWeight: '600' },
    reviewTextOn: { color: c.success },
    reviewTextOff: { color: c.warn },
    favBtn: { paddingHorizontal: 4 },
    favStar: { fontSize: 19, lineHeight: 22 },
    delBtn: {
      width: 28,
      height: 28,
      borderRadius: r.sm,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: c.dangerSoft,
    },
    stem: { fontSize: 14.5, lineHeight: 22, color: c.text, fontWeight: '500' },
    metaRow: { flexDirection: 'row', alignItems: 'center', gap: sp.md, marginTop: 2 },
    metaAnswer: { flex: 1, fontSize: 12.5, color: c.textSub },
    confWrap: { flexDirection: 'row', alignItems: 'center', gap: 5 },
    confTrack: { width: 46, height: 4, borderRadius: 2, backgroundColor: c.track, overflow: 'hidden' },
    confFill: { height: 4, borderRadius: 2 },
    confText: { fontSize: 11, color: c.textMuted, minWidth: 28 },
    body: { marginTop: sp.xs, gap: sp.xs },
    label: { fontSize: 11.5, color: c.textMuted, fontWeight: '600', marginTop: sp.sm },
    typeRow: { flexDirection: 'row', gap: sp.sm },
    typeBtn: {
      flex: 1,
      height: 34,
      borderRadius: r.sm,
      borderWidth: t.borderWidth,
      borderColor: c.border,
      backgroundColor: c.surfaceAlt,
      alignItems: 'center',
      justifyContent: 'center',
    },
    typeBtnOn: { backgroundColor: c.primary, borderColor: c.primary },
    typeBtnText: { fontSize: 12.5, color: c.textSub, fontWeight: '600' },
    typeBtnTextOn: { color: c.onPrimary },
    areaInput: {
      minHeight: 76,
      paddingTop: sp.md,
      paddingBottom: sp.md,
      paddingHorizontal: sp.md,
      backgroundColor: c.surfaceAlt,
      borderRadius: r.md,
      borderWidth: t.borderWidth,
      borderColor: c.border,
      fontSize: 14,
      lineHeight: 21,
      color: c.text,
    },
    input: {
      minHeight: 42,
      paddingTop: sp.sm,
      paddingBottom: sp.sm,
      paddingHorizontal: sp.md,
      backgroundColor: c.surfaceAlt,
      borderRadius: r.md,
      borderWidth: t.borderWidth,
      borderColor: c.border,
      fontSize: 14,
      lineHeight: 21,
      color: c.text,
    },
    optList: { gap: sp.sm },
    optRow: { flexDirection: 'row', alignItems: 'center', gap: sp.sm },
    optLetter: {
      width: 26,
      height: 26,
      borderRadius: r.sm,
      backgroundColor: c.primarySoft,
      alignItems: 'center',
      justifyContent: 'center',
    },
    optLetterText: { fontSize: 12, fontWeight: '800', color: c.primaryDark },
    optInput: {
      flex: 1,
      height: 38,
      paddingHorizontal: sp.md,
      backgroundColor: c.surfaceAlt,
      borderRadius: r.sm,
      borderWidth: t.borderWidth,
      borderColor: c.border,
      fontSize: 13.5,
      color: c.text,
    },
    addOpt: { alignSelf: 'flex-start', paddingHorizontal: sp.xs, paddingVertical: 4 },
    addOptText: { fontSize: 12.5, color: c.primary, fontWeight: '600' },
    tfRow: { flexDirection: 'row', gap: sp.sm },
    tfBtn: {
      flex: 1,
      height: 38,
      borderRadius: r.sm,
      borderWidth: t.borderWidth,
      borderColor: c.border,
      backgroundColor: c.surfaceAlt,
      alignItems: 'center',
      justifyContent: 'center',
    },
    tfBtnOn: { backgroundColor: c.primarySoft, borderColor: c.primary },
    tfText: { fontSize: 13.5, fontWeight: '600', color: c.textSub },
    tfTextOn: { color: c.primaryDark },
    actionRow: { flexDirection: 'row', gap: sp.sm, marginTop: sp.md },
    cancelBtn: {
      height: 42,
      minWidth: 76,
      paddingHorizontal: sp.lg,
      borderRadius: r.md,
      borderWidth: t.borderWidth,
      borderColor: c.border,
      alignItems: 'center',
      justifyContent: 'center',
    },
    cancelText: { fontSize: 14, color: c.textSub, fontWeight: '600' },
    saveBtn: {
      flex: 1,
      height: 42,
      borderRadius: r.md,
      backgroundColor: c.primary,
      alignItems: 'center',
      justifyContent: 'center',
      ...t.shadow.raised,
    },
    saveText: { fontSize: 14.5, fontWeight: '700', color: c.onPrimary },
    pressed: { opacity: 0.9 },
  });
}
