/**
 * 模拟考试：整卷限时、不即时判分、交卷后统一出成绩。
 *
 * 为什么不复用答题页：答题页的一切反馈（选项变绿变红、参考答案、连对两次出错题本）
 * 都建立在「立刻判分」上，模考要的恰恰是这些都不给。把两套逻辑塞进一个组件，
 * 结果只会是满屏 `if (exam)` 分支，两边都难维护。
 *
 * 交卷时才判分并写入云端，因此模考成绩与日常练习走同一套统计口径，
 * 未作答的题不写记录 —— 否则正确率会被「空白卷」拉成 0%。
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { dialog } from '../components/dialog';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import { typeLabels } from '../constants/theme';
import { ProgressBar, Tag } from '../components/ui';
import { QuestionNav, type NavState } from '../components/QuestionNav';
import { useTheme } from '../store/ThemeContext';
import { useApp } from '../store/AppContext';
import { addRecord, clearSession, getSession } from '../store/sessionStore';
import { submitAnswer } from '../services/quizStore';
import { upsertReview } from '../services/reviewStore';
import { enqueueAttempt, flushAttemptQueue, getPendingAttemptCount } from '../services/offlineQueue';
import { judgeShortAnswer } from '../services/aiService';
import { answerLetters, expectedDisplay, gradeAnswer, isMultiAnswer, letterOf, optionBody, scoreOf } from '../services/quizEngine';

function clock(total: number): string {
  const s = Math.max(0, Math.floor(total));
  const m = Math.floor(s / 60);
  return `${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

export default function ExamScreen() {
  const insets = useSafeAreaInsets();
  const t = useTheme();
  const c = t.palette;
  const { settings } = useApp();
  const session = useMemo(() => getSession(), []);
  const questions = session?.questions ?? [];

  const [index, setIndex] = useState(0);
  /** questionId -> 作答原文（选择题为字母串，判断为 T/F，填空简答为文本） */
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [grading, setGrading] = useState(false);
  const [judgeNote, setJudgeNote] = useState('');
  const [left, setLeft] = useState(() => Math.max(0, questions.length * (settings.examSecondsPerQuestion || 0)));

  const question = questions[index];
  const multi = useMemo(() => (question ? isMultiAnswer(question) : false), [question]);
  const timed = left > 0;
  const answeredCount = useMemo(
    () => questions.filter((q) => String(drafts[q.id] ?? '').trim().length > 0).length,
    [drafts, questions],
  );
  const correctLetters = useMemo(() => (question ? answerLetters(question) : []), [question]);

  /** 交卷只能发生一次：倒计时归零与手动交卷可能几乎同时触发 */
  const submitted = useRef(false);

  useEffect(() => {
    if (!timed || grading) return;
    const timer = setInterval(() => {
      setLeft((prev) => {
        if (prev <= 1) {
          clearInterval(timer);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
    return () => clearInterval(timer);
  }, [grading, timed]);

  const gradeAll = useCallback(async () => {
    if (submitted.current || grading) return;
    submitted.current = true;
    setGrading(true);
    const pendingShort = questions.filter((q) => q.type === 'short' && String(drafts[q.id] ?? '').trim()).length;
    let done = 0;
    try {
      for (const q of questions) {
        const given = String(drafts[q.id] ?? '').trim();
        done += 1;
        setJudgeNote(pendingShort > 0 ? `正在批改 ${done}/${questions.length}（简答题需 AI 判分）` : `正在写入成绩 ${done}/${questions.length}`);
        if (!given) continue;
        let ok = false;
        let manual = false;
        let note = '';
        let score = 0;
        if (q.type === 'short') {
          try {
            const judged = await judgeShortAnswer({ stem: q.stem, reference: expectedDisplay(q), given });
            ok = judged.correct;
            manual = true;
            note = judged.reason;
            score = ok ? 1 : 0;
          } catch (error) {
            console.error('[exam] 简答判分失败:', error);
            ok = false;
            manual = true;
            note = 'AI 判分不可用，本题按未得分计入，请对照参考答案自查';
            score = 0;
          }
        } else {
          const g = gradeAnswer(q, q.type === 'tf' ? (given === 'T' ? '正确' : '错误') : given);
          ok = g === 'correct';
          manual = g === 'manual';
          if (manual) note = '本题由 AI 判定对错，建议对照参考答案自查';
          score = scoreOf(q, given, g);
          if (score === 0.5) note = '多选题漏选且没有错选，本题得 0.5 分';
        }
        addRecord({ questionId: q.id, correct: ok, manual, reason: note, given, score });
        try {
          const saved = await submitAnswer(q.id, q.bankId, ok, 'exam');
          if (saved) {
            if (getPendingAttemptCount() > 0) void flushAttemptQueue();
            void upsertReview(q.id, q.bankId, ok);
          } else {
            enqueueAttempt({ questionId: q.id, bankId: q.bankId, correct: ok, mode: 'exam' });
          }
        } catch (error) {
          console.error('[exam] 写入作答失败:', error);
          enqueueAttempt({ questionId: q.id, bankId: q.bankId, correct: ok, mode: 'exam' });
        }
      }
      router.replace('/result');
    } catch (error) {
      console.error('[exam] 交卷失败:', error);
      submitted.current = false;
      dialog.alert('交卷未完成', '批改或写入成绩时出错，请检查网络后重新交卷。');
    } finally {
      setGrading(false);
      setJudgeNote('');
    }
  }, [drafts, grading, questions]);

  const askSubmit = useCallback(() => {
    if (grading) return;
    const blank = questions.length - answeredCount;
    dialog.alert(
      '确认交卷？',
      blank > 0 ? `还有 ${blank} 题未作答，未作答的题不计入成绩。交卷后立即出分，且不能返回修改。` : '全部题目已作答。交卷后立即出分，且不能返回修改。',
      [
        { text: '再检查一下', style: 'cancel' },
        { text: '交卷出分', onPress: () => { void gradeAll(); } },
      ],
    );
  }, [answeredCount, gradeAll, grading, questions.length]);

  useEffect(() => {
    if (!timed || left > 0 || grading || submitted.current) return;
    submitted.current = true;
    dialog.alert('时间到', '本次模考已到时，系统正在自动交卷。', [
      {
        text: '看看成绩',
        onPress: () => {
          submitted.current = false;
          void gradeAll();
        },
      },
    ]);
    // 只在倒计时归零这一次触发
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [left]);

  const askQuit = useCallback(() => {
    if (grading) return;
    dialog.alert('退出模考？', '模拟考试不提供断点保存，退出后本次作答全部作废，成绩也不会写入云端。', [
      { text: '继续考试', style: 'cancel' },
      {
        text: '放弃本次模考',
        style: 'destructive',
        onPress: () => {
          clearSession();
          router.replace('/');
        },
      },
    ]);
  }, [grading]);

  const setDraft = useCallback((qid: string, value: string) => {
    setDrafts((prev) => ({ ...prev, [qid]: value }));
  }, []);

  const go = useCallback(
    (target: number) => {
      if (target < 0 || target >= questions.length || target === index) return;
      setIndex(target);
    },
    [index, questions.length],
  );

  if (!session || !question) {
    return (
      <View style={[styles.center, { backgroundColor: c.bg, paddingTop: insets.top }]}>
        <Text style={[styles.emptyText, { color: c.textSub }]}>模考会话已失效，请重新选择题库开始。</Text>
        <Pressable
          accessibilityRole="button"
          onPress={() => {
            clearSession();
            router.replace('/');
          }}
          style={[styles.emptyBtn, { backgroundColor: c.primary, borderRadius: t.radius.md }]}
        >
          <Text style={[styles.emptyBtnText, { color: c.onPrimary }]}>返回首页</Text>
        </Pressable>
      </View>
    );
  }

  const navStates: NavState[] = questions.map((q) => (String(drafts[q.id] ?? '').trim() ? 'seen' : 'todo'));
  const urgent = timed && left <= 60;

  return (
    <View style={[styles.root, { backgroundColor: c.bg, paddingTop: insets.top + t.spacing.md }]}>
      <View style={styles.head}>
        <Pressable accessibilityRole="button" onPress={askQuit} hitSlop={12} disabled={grading}>
          <Text style={[styles.quit, { color: c.textSub }]}>退出</Text>
        </Pressable>
        <View style={styles.headCenter}>
          <Text style={[styles.bankName, { color: c.textSub }]} numberOfLines={1}>
            {session.bankName}
          </Text>
          <Text style={[styles.counter, { color: c.text }]}>
            {index + 1} / {questions.length}
          </Text>
        </View>
        <View style={[styles.clock, { backgroundColor: urgent ? c.dangerSoft : c.surfaceAlt, borderRadius: t.radius.md }]}>
          <Text style={[styles.clockText, { color: urgent ? c.danger : c.text }]}>{timed ? clock(left) : '不限时'}</Text>
        </View>
      </View>

      <View style={styles.trackWrap}>
        <ProgressBar ratio={questions.length ? answeredCount / questions.length : 0} color={c.accent} height={5} />
        <View style={styles.trackMeta}>
          <Text style={[styles.trackMetaText, { color: c.textMuted }]}>已作答 {answeredCount}</Text>
          <Text style={[styles.trackMetaText, { color: c.textMuted }]}>未作答 {questions.length - answeredCount}</Text>
        </View>
      </View>

      <QuestionNav total={questions.length} current={index} states={navStates} browseMode onJump={go} />

      <ScrollView contentInsetAdjustmentBehavior="automatic" keyboardShouldPersistTaps="handled" contentContainerStyle={styles.scroll}>
        <View style={[styles.qCard, { backgroundColor: t.cardBg, borderRadius: t.cardRadius, borderWidth: 1, borderColor: c.border }]}>
          <View style={styles.tagRow}>
            <Tag label={typeLabels[question.type] ?? question.type} tone="neutral" />
            {multi ? <Tag label="多选" tone="warn" /> : null}
            {question.difficulty ? <Tag label={question.difficulty === 1 ? '简单' : question.difficulty === 2 ? '中等' : '困难'} tone="ai" /> : null}
            <View style={{ flex: 1 }} />
            <Text style={[styles.tagMeta, { color: c.textMuted }]}>模考中不显示答案</Text>
          </View>
          <Text style={[styles.stem, { color: c.text }]}>{question.stem}</Text>
          {multi ? (
            <Text style={{ fontSize: 11.5, color: c.warn, lineHeight: 17, marginTop: 4, marginBottom: 12 }}>
              多选题：全部选对得 1 分，漏选且没有错选得 0.5 分，错选不得分。
            </Text>
          ) : null}
        </View>

        {question.type === 'choice' ? (
          <View style={styles.optList}>
            {question.options.map((opt, i) => {
              const letter = letterOf(opt, i);
              const on = (drafts[question.id] ?? '').includes(letter);
              return (
                <Pressable
                  key={`${question.id}_${letter}`}
                  accessibilityRole="button"
                  disabled={grading}
                  onPress={() => {
                    if (multi) {
                      const cur = (drafts[question.id] ?? '').split('');
                      const next = cur.includes(letter) ? cur.filter((l) => l !== letter) : [...cur, letter];
                      setDraft(question.id, next.sort().join(''));
                    } else {
                      setDraft(question.id, letter);
                    }
                  }}
                  style={({ pressed }) => [
                    styles.opt,
                    {
                      backgroundColor: on ? c.primarySoft : t.cardBg,
                      borderColor: on ? c.primary : c.border,
                      borderRadius: t.radius.md,
                      opacity: pressed ? 0.94 : 1,
                    },
                  ]}
                >
                  <View style={[styles.optLetter, { backgroundColor: on ? c.primary : c.track }]}>
                    <Text style={[styles.optLetterText, { color: on ? c.onPrimary : c.textSub }]}>{letter}</Text>
                  </View>
                  <Text style={[styles.optText, { color: c.text }]}>{optionBody(opt) || opt}</Text>
                </Pressable>
              );
            })}
          </View>
        ) : null}

        {question.type === 'tf' ? (
          <View style={styles.tfRow}>
            {[
              { label: '正确', value: 'T' },
              { label: '错误', value: 'F' },
            ].map((item) => {
              const on = (drafts[question.id] ?? '') === item.value;
              return (
                <Pressable
                  key={item.value}
                  accessibilityRole="button"
                  disabled={grading}
                  onPress={() => setDraft(question.id, item.value)}
                  style={({ pressed }) => [
                    styles.tfBtn,
                    {
                      borderColor: on ? c.primary : c.border,
                      backgroundColor: on ? c.primary : t.cardBg,
                      borderRadius: t.radius.md,
                      opacity: pressed ? 0.94 : 1,
                    },
                  ]}
                >
                  <Text style={[styles.tfText, { color: on ? c.onPrimary : c.text }]}>{item.label}</Text>
                </Pressable>
              );
            })}
          </View>
        ) : null}

        {(question.type === 'fill' || question.type === 'short') ? (
          <View style={styles.fillBox}>
            <Text style={[styles.fillHint, { color: c.textMuted }]}>
              {question.type === 'fill' ? '填写答案，多个空用 / 分隔' : '写下要点即可，交卷后由 AI 统一判分'}
            </Text>
            <TextInput
              style={[styles.input, { backgroundColor: t.cardBg, borderColor: c.border, borderRadius: t.radius.md, color: c.text }]}
              multiline
              value={drafts[question.id] ?? ''}
              onChangeText={(v) => setDraft(question.id, v)}
              editable={!grading}
              placeholder="在此输入你的答案"
              placeholderTextColor={c.textMuted}
            />
          </View>
        ) : null}

        {grading ? (
          <View style={[styles.gradingBox, { backgroundColor: t.cardBg, borderColor: c.border, borderRadius: t.radius.md }]}>
            <Text style={[styles.gradingText, { color: c.text }]}>{judgeNote || '正在批改…'}</Text>
            <Text style={[styles.gradingSub, { color: c.textMuted }]}>请稍候，不要退出本页。</Text>
          </View>
        ) : null}
      </ScrollView>

      <View
        style={[styles.bottom, { backgroundColor: c.tabBar, borderColor: c.border, paddingBottom: insets.bottom + t.spacing.md }]}
      >
        <Pressable
          accessibilityRole="button"
          onPress={() => go(index - 1)}
          disabled={index === 0 || grading}
          style={({ pressed }) => [styles.ghost, { borderColor: c.border, borderRadius: t.radius.md, opacity: index === 0 ? 0.4 : pressed ? 0.9 : 1 }]}
        >
          <Text style={[styles.ghostText, { color: c.textSub }]}>上一题</Text>
        </Pressable>

        {index + 1 < questions.length ? (
          <Pressable
            accessibilityRole="button"
            onPress={() => go(index + 1)}
            disabled={grading}
            style={({ pressed }) => [styles.primary, { backgroundColor: c.primary, borderRadius: t.radius.md, opacity: pressed ? 0.9 : 1 }]}
          >
            <Text style={[styles.primaryText, { color: c.onPrimary }]}>下一题</Text>
          </Pressable>
        ) : (
          <Pressable
            accessibilityRole="button"
            onPress={askSubmit}
            disabled={grading}
            style={({ pressed }) => [styles.primary, { backgroundColor: c.primary, borderRadius: t.radius.md, opacity: grading || pressed ? 0.8 : 1 }]}
          >
            <Text style={[styles.primaryText, { color: c.onPrimary }]}>{grading ? '批改中…' : '交卷出分'}</Text>
          </Pressable>
        )}

        <Pressable
          accessibilityRole="button"
          onPress={askSubmit}
          disabled={grading}
          style={({ pressed }) => [styles.ghost, { borderColor: c.border, borderRadius: t.radius.md, opacity: pressed ? 0.9 : 1 }]}
        >
          <Text style={[styles.ghostText, { color: c.textSub }]}>交卷</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  head: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16 },
  quit: { fontSize: 14, fontWeight: '600', width: 40 },
  headCenter: { flex: 1 },
  bankName: { fontSize: 13, fontWeight: '600' },
  counter: { fontSize: 17, fontWeight: '800', marginTop: 1 },
  clock: { paddingHorizontal: 10, height: 34, alignItems: 'center', justifyContent: 'center' },
  clockText: { fontSize: 15, fontWeight: '800', fontVariant: ['tabular-nums'] },
  trackWrap: { paddingHorizontal: 16, marginTop: 10 },
  trackMeta: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 6 },
  trackMetaText: { fontSize: 11 },
  scroll: { paddingHorizontal: 16, paddingBottom: 30 },
  qCard: { padding: 16, marginTop: 6 },
  tagRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 8, flexWrap: 'wrap' },
  tagMeta: { fontSize: 11 },
  stem: { fontSize: 16.5, lineHeight: 26, fontWeight: '500' },
  optList: { marginTop: 12, gap: 8 },
  opt: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 12, borderWidth: 1.5 },
  optLetter: { width: 28, height: 28, borderRadius: 14, alignItems: 'center', justifyContent: 'center' },
  optLetterText: { fontSize: 13, fontWeight: '800' },
  optText: { flex: 1, fontSize: 15, lineHeight: 22 },
  tfRow: { flexDirection: 'row', gap: 12, marginTop: 12 },
  tfBtn: { flex: 1, height: 52, borderWidth: 1.5, alignItems: 'center', justifyContent: 'center' },
  tfText: { fontSize: 16, fontWeight: '700' },
  fillBox: { marginTop: 12 },
  fillHint: { fontSize: 12, marginBottom: 8 },
  input: { borderWidth: 1, padding: 12, minHeight: 92, textAlignVertical: 'top', fontSize: 15, lineHeight: 23 },
  gradingBox: { marginTop: 14, borderWidth: 1, padding: 16, alignItems: 'center', gap: 4 },
  gradingText: { fontSize: 14, fontWeight: '700' },
  gradingSub: { fontSize: 12 },
  bottom: { flexDirection: 'row', alignItems: 'center', gap: 8, borderTopWidth: StyleSheet.hairlineWidth, paddingHorizontal: 16, paddingTop: 12 },
  primary: { flex: 2, height: 48, alignItems: 'center', justifyContent: 'center' },
  primaryText: { fontSize: 15.5, fontWeight: '700' },
  ghost: { flex: 1, height: 48, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  ghostText: { fontSize: 14, fontWeight: '600' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 16, padding: 24 },
  emptyText: { fontSize: 14, textAlign: 'center' },
  emptyBtn: { paddingHorizontal: 24, height: 42, alignItems: 'center', justifyContent: 'center' },
  emptyBtnText: { fontSize: 14, fontWeight: '700' },
});
