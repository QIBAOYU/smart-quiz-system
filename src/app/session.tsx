/**
 * 答题页：四种模式共用一套交互。
 *
 * 两条硬规则：
 * 1. 退出 / 交卷都会询问「是否保存进度」，进度按「题库 + 模式」分别保存，互不覆盖。
 * 2. 简答题必须先作答 → 判出对错 → 才出现「看参考答案」按钮。
 */
import React, { useCallback, useMemo, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { dialog } from '../components/dialog';
import * as Haptics from 'expo-haptics';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import { modeLabels, typeLabels } from '../constants/theme';
import { CheckIcon, CloseIcon } from '../components/icons';
import { ProgressBar, Tag } from '../components/ui';
import { QuestionNav, type NavState } from '../components/QuestionNav';
import { useTheme } from '../store/ThemeContext';
import { useApp } from '../store/AppContext';
import { addRecord, clearSession, getSession } from '../store/sessionStore';
import { submitAnswer } from '../services/quizStore';
import { upsertReview } from '../services/reviewStore';
import { enqueueAttempt, flushAttemptQueue, getPendingAttemptCount } from '../services/offlineQueue';
import { saveProgress } from '../services/progressStore';
import { judgeShortAnswer } from '../services/aiService';
import { answerLetters, diffPicks, expectedDisplay, gradeAnswer, isMultiAnswer, letterOf, optionBody, scoreOf } from '../services/quizEngine';
import type { AnswerRecord, ProgressAnswer } from '../types/quiz';

export default function SessionScreen() {
  const insets = useSafeAreaInsets();
  const t = useTheme();
  const c = t.palette;
  const { settings } = useApp();
  const session = useMemo(() => getSession(), []);

  const [index, setIndex] = useState(session?.startIndex ?? 0);
  const [picked, setPicked] = useState<string[]>([]);
  const [text, setText] = useState('');
  const [correct, setCorrect] = useState<boolean | null>(null);
  const [reason, setReason] = useState('');
  const [judging, setJudging] = useState(false);
  const [graded, setGraded] = useState(false);
  const [showReference, setShowReference] = useState(false);
  const [saving, setSaving] = useState(false);
  /** 背题模式没有作答记录，用浏览过的题号下标驱动答题卡；恢复进度时把已浏览的题一并带回 */
  const [visited, setVisited] = useState<number[]>(() => {
    if (!session) return [0];
    const start = session.startIndex;
    const seen = new Set(session.seenIds);
    const indices = session.questions.map((q, i) => (seen.has(q.id) ? i : -1)).filter((i) => i >= 0);
    if (!indices.includes(start)) indices.push(start);
    return indices.sort((a, b) => a - b);
  });

  const questions = session?.questions ?? [];
  const question = questions[index];
  const memorize = session?.mode === 'memorize';
  const multi = useMemo(() => (question ? isMultiAnswer(question) : false), [question]);
  const isLast = index + 1 === questions.length;

  const buildProgress = useCallback(
    (cursor: number, records: AnswerRecord[]) => {
      if (!session) return null;
      const answers: Record<string, ProgressAnswer> = {};
      records.forEach((r) => {
        answers[r.questionId] = { correct: r.correct, manual: r.manual, reason: r.reason, given: r.given, score: r.score ?? (r.correct ? 1 : 0) };
      });
      // 背题模式没有对错，只记「已浏览」，供答题卡恢复颜色
      if (session.mode === 'memorize') {
        visited.forEach((i) => {
          const q = questions[i];
          if (q && !answers[q.id]) answers[q.id] = { correct: false, manual: false, seen: true };
        });
      }
      return {
        bankId: session.bankId,
        bankName: session.bankName,
        mode: session.mode,
        questionIds: questions.map((q) => q.id),
        answers,
        cursor,
        total: questions.length,
        updatedAt: new Date().toISOString(),
      };
    },
    [questions, session, visited],
  );

  const persistProgress = useCallback(
    async (cursor: number) => {
      if (!session) return false;
      const payload = buildProgress(cursor, session.records);
      if (!payload) return false;
      return saveProgress(payload);
    },
    [buildProgress, session],
  );

  const resetQuestionState = useCallback(
    (revealedAnswer = false) => {
      setPicked([]);
      setText('');
      setCorrect(null);
      setReason('');
      setGraded(false);
      setShowReference(revealedAnswer);
    },
    [],
  );

  /** 跳到指定题号：已作答过的题直接回显当时的对错与参考答案 */
  const goTo = useCallback(
    (target: number) => {
      if (!session) return;
      if (target < 0 || target >= questions.length || target === index) return;
      setIndex(target);
      setVisited((prev) => (prev.includes(target) ? prev : [...prev, target]));
      if (memorize) {
        resetQuestionState(true);
        return;
      }
      const rec = session.records.find((r) => r.questionId === questions[target].id);
      if (rec) {
        const targetQ = questions[target];
        const isTextAnswer = targetQ.type === 'fill' || targetQ.type === 'short';
        // 回显当时的作答：选择题还原选中项，填空/简答还原输入内容
        setPicked(isTextAnswer ? [] : (rec.given ?? '').split(''));
        setText(isTextAnswer ? rec.given ?? '' : '');
        setReason(rec.reason ?? (rec.manual ? '本题由 AI 判定对错，建议对照参考答案自查' : ''));
        setCorrect(rec.correct);
        setGraded(true);
        setShowReference(true);
      } else {
        resetQuestionState(false);
      }
    },
    [index, memorize, questions, resetQuestionState, session],
  );

  const goNext = useCallback(() => {
    if (isLast) {
      router.replace('/result');
      return;
    }
    goTo(index + 1);
  }, [goTo, index, isLast]);

  const goPrev = useCallback(() => {
    goTo(index - 1);
  }, [goTo, index]);

  const commit = useCallback(
    async (isCorrect: boolean, manual: boolean, note = '', givenText = '', score?: number) => {
      if (!session || !question) return;
      addRecord({
        questionId: question.id,
        correct: isCorrect,
        manual,
        reason: note,
        given: givenText,
        score: score ?? (isCorrect ? 1 : 0),
      });
      // 复习计划从每一次作答里自动生长：答对升一档、答错降回第一档，用户无需手动「加入复习」
      void upsertReview(question.id, question.bankId, isCorrect);
      setSaving(true);
      const stash = () =>
        enqueueAttempt({ questionId: question.id, bankId: question.bankId, correct: isCorrect, mode: session.mode });
      try {
        // 按题目真实归属记录 bank：跨题库会话（如按科目刷错题）也能计入正确的题库统计
        const ok = await submitAnswer(question.id, question.bankId, isCorrect, session.mode);
        if (ok) {
          // 这次写通了，顺带把之前攒下的失败记录按原顺序补交
          if (getPendingAttemptCount() > 0) void flushAttemptQueue();
        } else {
          stash();
          notifySyncFailed();
        }
      } catch (error) {
        console.error('[session] submitAnswer failed:', error);
        stash();
        notifySyncFailed();
      } finally {
        setSaving(false);
      }
      if (!isCorrect && settings.hapticOnWrong) {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch((e) =>
          console.error('[session] haptic failed:', e),
        );
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [question, session, settings.hapticOnWrong],
  );

  /**
   * 同步失败只在本次会话里提示一次：断网时每题都弹框会把人逼疯，
   * 但完全不说又会让用户以为记录已经存好了。
   */
  const syncNoticeShown = useRef(false);
  const notifySyncFailed = useCallback(() => {
    if (syncNoticeShown.current) return;
    syncNoticeShown.current = true;
    dialog.alert('作答记录暂未同步', '这条作答没能写入云端，已先留在本机，稍后会自动重试；也可以回首页手动重试。');
  }, []);

  const onSubmit = useCallback(async () => {
    if (!question || judging) return;
    const given = question.type === 'choice' || question.type === 'tf' ? picked.join('') : text;
    if (!String(given).trim()) {
      dialog.alert('还没有作答', '请先选择或填写答案，再提交判题。');
      return;
    }
    if (question.type === 'short') {
      // 简答题：先判对错，判完才允许看参考答案
      setJudging(true);
      try {
        const judged = await judgeShortAnswer({
          stem: question.stem,
          reference: expectedDisplay(question),
          given: String(given),
        });
        setCorrect(judged.correct);
        setReason(judged.reason);
        setGraded(true);
        setShowReference(false);
        commit(judged.correct, true, judged.reason, String(given)).catch((e) =>
          console.error('[session] short commit failed:', e),
        );
      } catch (error) {
        console.error('[session] 简答判分异常:', error);
        dialog.alert('判分未完成', 'AI 判分暂时不可用，请稍后重试或先跳过本题。');
      } finally {
        setJudging(false);
      }
      return;
    }
    const g = gradeAnswer(question, given);
    const ok = g === 'correct';
    const score = scoreOf(question, given, g);
    let note = g === 'manual' ? '本题由 AI 判定对错，建议对照参考答案自查' : '';
    // 多选漏选：判分依旧算「没答对」，但要讲清差在哪、这半分会不会计进本轮得分
    if (score === 0.5) {
      note = `漏选 ${diffPicks(question, given).miss.join('、')}，没有错选 · 本题得 0.5 分`;
    }
    setCorrect(ok);
    setReason(note);
    setGraded(true);
    setShowReference(true);
    commit(ok, g === 'manual', note, String(given), score).catch((e) =>
      console.error('[session] commit failed:', e),
    );
  }, [commit, judging, picked, question, text]);

  /** 退出：三选项，保存进度按模式分类 */
  const onQuit = useCallback(() => {
    const answered = session?.records.length ?? 0;
    const isMemorize = session?.mode === 'memorize';
    // 背题模式没有作答记录，用浏览过的题数判断有没有东西可存
    const browsed = isMemorize ? visited.length : 0;
    const nothingToSave = answered === 0 && browsed <= 1;
    const modeName = modeLabels[session?.mode ?? 'seq'] ?? '练习';
    dialog.alert(
      '结束本次练习',
      nothingToSave
        ? '还没有作答任何题目，直接退出即可。'
        : isMemorize
          ? `本次已浏览 ${browsed} 题。是否保存「${modeName}」进度？重新进入后答题卡会保留已浏览标记。`
          : `本次已作答 ${answered} 题。是否保存「${modeName}」进度？重新进入后答题卡会保留每题的对错颜色。`,
      [
        { text: '继续练习', style: 'cancel' },
        {
          text: '不保存退出',
          style: 'destructive',
          onPress: () => {
            clearSession();
            router.replace('/');
          },
        },
        {
          text: '保存进度并退出',
          onPress: () => {
            if (nothingToSave) {
              clearSession();
              router.replace('/');
              return;
            }
            persistProgress(index)
              .then((ok) => {
                clearSession();
                if (!ok) dialog.alert('进度未能保存', '网络或权限异常，进度仍留在本机本次会话中。');
                router.replace('/');
              })
              .catch((error) => {
                console.error('[session] 保存进度失败:', error);
                dialog.alert('进度未能保存', '请检查网络后重试。');
              });
          },
        },
      ],
    );
  }, [index, persistProgress, session, visited.length]);

  /** 交卷前兜底：还有没同步出去的作答时明确告知，而不是让用户以为一切已存好 */
  const finishOrWarn = useCallback(() => {
    const pending = getPendingAttemptCount();
    if (pending > 0) {
      dialog.alert(
        '有作答记录未同步',
        `${pending} 题还没写入云端。返回首页后会自动重试，也可以在首页点「立即重试」手动补交。`,
        [{ text: '知道了', onPress: () => router.replace('/result') }],
      );
      return;
    }
    router.replace('/result');
  }, []);

  const onFinish = useCallback(() => {
    const answered = session?.records.length ?? 0;
    if (answered >= questions.length && answered > 0) {
      finishOrWarn();
      return;
    }
    dialog.alert('现在交卷？', `还有 ${Math.max(0, questions.length - answered)} 题未作答。`, [
      { text: '继续作答', style: 'cancel' },
      {
        text: '保存进度并退出',
        onPress: () => {
          persistProgress(index)
            .then((ok) => {
              clearSession();
              if (!ok) dialog.alert('进度未能保存', '请检查网络后重试。');
              router.replace('/');
            })
            .catch((error) => console.error('[session] 交卷保存失败:', error));
        },
      },
      { text: '直接交卷', onPress: () => finishOrWarn() },
    ]);
  }, [finishOrWarn, index, persistProgress, questions.length, session]);

  if (!session || !question) {
    return (
      <View style={[styles.empty, { backgroundColor: c.bg }]}>
        <Text style={[styles.emptyText, { color: c.textSub }]}>练习会话已失效，请重新选择题库开始。</Text>
        <Pressable
          accessibilityRole="button"
          onPress={() => {
            clearSession();
            router.replace('/');
          }}
          style={[styles.emptyBtn, { backgroundColor: c.primary }]}
        >
          <Text style={[styles.emptyBtnText, { color: c.onPrimary }]}>返回首页</Text>
        </Pressable>
      </View>
    );
  }

  const answered = session.records.length;
  const ratio = (index + (graded ? 1 : 0)) / questions.length;
  const correctLetters = answerLetters(question);
  const referenceShown = memorize || (graded && showReference);
  // session.records 是模块级单例里的可变数组，引用不变，因此每次渲染直接求值，不能用 useMemo 缓存
  const navStates: NavState[] = questions.map((q, i) => {
    if (memorize) return visited.includes(i) ? 'seen' : 'todo';
    const rec = session.records.find((r) => r.questionId === q.id);
    if (!rec) return 'todo';
    return rec.correct ? 'correct' : rec.manual ? 'manual' : 'wrong';
  });

  return (
    <View style={[styles.root, { paddingTop: insets.top + t.spacing.md }]}>
      <View style={styles.head}>
        <Pressable accessibilityRole="button" onPress={onQuit} hitSlop={12}>
          <CloseIcon size={18} color={c.textSub} />
        </Pressable>
        <View style={styles.headCenter}>
          <Text style={[styles.bankName, { color: c.textSub }]} numberOfLines={1}>
            {session.bankName}
          </Text>
          <Text style={[styles.counter, { color: c.text }]}>
            {index + 1} / {questions.length}
          </Text>
        </View>
        <Tag label={memorize ? '背题中' : '答题中'} tone={memorize ? 'ai' : 'primary'} />
      </View>

      <View style={styles.trackWrap}>
        <ProgressBar ratio={ratio} color={correct === false ? c.danger : c.primary} height={5} />
        <View style={styles.trackMeta}>
          <Text style={[styles.trackMetaText, { color: c.textMuted }]}>已作答 {answered}</Text>
          <Text style={[styles.trackMetaText, { color: c.textMuted }]}>本次正确 {session.records.filter((r) => r.correct).length}</Text>
        </View>
      </View>

      <QuestionNav total={questions.length} current={index} states={navStates} browseMode={memorize} onJump={goTo} />

      <ScrollView contentInsetAdjustmentBehavior="automatic" keyboardShouldPersistTaps="handled" contentContainerStyle={styles.scroll}>
        <View
          style={[
            styles.qCard,
            {
              backgroundColor: t.cardBg,
              borderRadius: t.cardRadius,
              borderColor: t.tone === 'sketch' ? c.border : c.border,
              borderWidth: t.tone === 'sketch' ? 1.6 : 1,
              ...t.shadow.card,
            },
          ]}
        >
          <View style={styles.tagRow}>
            <Tag label={typeLabels[question.type] ?? question.type} tone="neutral" />
            {multi ? <Tag label="多选" tone="warn" /> : null}
            {!question.reviewed ? <Tag label="答案待确认" tone="warn" /> : null}
            {question.confidence < 0.6 ? <Tag label="低置信" tone="danger" /> : null}
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
              const on = picked.includes(letter);
              const isRight = correctLetters.includes(letter);
              const state = graded ? (isRight ? 'right' : on ? 'wrong' : 'idle') : on ? 'picked' : 'idle';
              const border =
                state === 'picked' ? c.primary : state === 'right' ? c.success : state === 'wrong' ? c.danger : c.border;
              const bg =
                state === 'picked' ? c.primarySoft : state === 'right' ? c.successSoft : state === 'wrong' ? c.dangerSoft : t.cardBg;
              return (
                <Pressable
                  key={`${question.id}_${letter}`}
                  accessibilityRole="button"
                  disabled={graded && !memorize}
                  onPress={() => {
                    if (graded && !memorize) return;
                    if (multi) setPicked((prev) => (prev.includes(letter) ? prev.filter((l) => l !== letter) : [...prev, letter]));
                    else setPicked([letter]);
                  }}
                  style={({ pressed }) => [
                    styles.opt,
                    {
                      backgroundColor: bg,
                      borderColor: border,
                      borderRadius: t.radius.md,
                      opacity: pressed ? 0.92 : 1,
                    },
                  ]}
                >
                  <View
                    style={[
                      styles.optLetter,
                      {
                        backgroundColor: state === 'idle' ? c.track : state === 'picked' ? c.primary : state === 'right' ? c.success : state === 'wrong' ? c.danger : c.track,
                      },
                    ]}
                  >
                    <Text style={[styles.optLetterText, { color: state === 'idle' ? c.textSub : c.onPrimary }]}>{letter}</Text>
                  </View>
                  <Text style={[styles.optText, { color: c.text }]}>{optionBody(opt) || opt}</Text>
                </Pressable>
              );
            })}
          </View>
        ) : null}

        {question.type === 'tf' ? (
          <View style={styles.tfRow}>
            {[true, false].map((b) => {
              const label = b ? '正确' : '错误';
              const value = b ? 'T' : 'F';
              const on = picked.includes(value);
              const rightLabel = gradeAnswer(question, '正确') === 'correct' ? '正确' : gradeAnswer(question, '错误') === 'correct' ? '错误' : '';
              const isRight = rightLabel === label;
              const filled = graded && (isRight || on);
              return (
                <Pressable
                  key={label}
                  accessibilityRole="button"
                  disabled={graded && !memorize}
                  onPress={() => {
                    if (graded && !memorize) return;
                    setPicked([value]);
                  }}
                  style={({ pressed }) => [
                    styles.tfBtn,
                    {
                      borderColor: graded && isRight ? c.success : on ? c.primary : c.border,
                      backgroundColor: graded && isRight ? c.successSoft : on ? c.primary : t.cardBg,
                      borderRadius: t.radius.md,
                      opacity: pressed ? 0.92 : 1,
                    },
                  ]}
                >
                  <Text style={[styles.tfText, { color: filled ? (graded && isRight && !on ? c.success : c.onPrimary) : c.text }]}>{label}</Text>
                </Pressable>
              );
            })}
          </View>
        ) : null}

        {(question.type === 'fill' || question.type === 'short') && !graded ? (
          <View style={styles.fillBox}>
            <Text style={[styles.fillHint, { color: c.textMuted }]}>
              {question.type === 'fill' ? '填写答案，多个空用 / 分隔' : '先写下你的答案，提交后由 AI 判分，再对照参考答案'}
            </Text>
            <TextInput
              style={[
                styles.input,
                {
                  backgroundColor: t.cardBg,
                  borderColor: c.border,
                  borderRadius: t.radius.md,
                  color: c.text,
                },
              ]}
              multiline
              value={text}
              onChangeText={setText}
              placeholder="在此输入你的答案"
              placeholderTextColor={c.textMuted}
            />
          </View>
        ) : null}

        {graded ? (
          <View
            style={[
              styles.feedback,
              {
                backgroundColor: correct ? c.successSoft : correct === false ? c.dangerSoft : t.cardBg,
                borderColor: correct ? c.success : correct === false ? c.danger : c.border,
                borderRadius: t.cardRadius,
              },
            ]}
          >
            <View style={styles.fbHead}>
              {correct ? <CheckIcon size={16} color={c.success} /> : correct === false ? <CloseIcon size={16} color={c.danger} /> : null}
              <Text style={[styles.fbTitle, { color: c.text }]}>
                {memorize ? '参考答案' : correct ? '回答正确' : correct === false ? '回答错误' : '本题已作答'}
              </Text>
              {question.type === 'short' && !memorize ? <Tag label={reason.includes('离线') ? '离线判定' : 'AI 判分'} tone="ai" /> : null}
            </View>
            {reason ? <Text style={[styles.fbReason, { color: c.textSub }]}>{reason}</Text> : null}

            {referenceShown ? (
              <>
                <Text style={[styles.fbLabel, { color: c.textMuted }]}>参考答案</Text>
                <Text style={[styles.fbAnswer, { color: c.text }]}>{expectedDisplay(question)}</Text>
                {question.explanation ? <Text style={[styles.fbExp, { color: c.textSub }]}>{question.explanation}</Text> : null}
              </>
            ) : (
              <Pressable
                accessibilityRole="button"
                onPress={() => setShowReference(true)}
                style={({ pressed }) => [
                  styles.refBtn,
                  {
                    borderColor: c.primary,
                    borderRadius: t.radius.md,
                    opacity: pressed ? 0.9 : 1,
                  },
                ]}
              >
                <Text style={[styles.refBtnText, { color: c.primary }]}>查看参考答案</Text>
              </Pressable>
            )}
          </View>
        ) : null}

        {judging ? (
          <View style={[styles.judging, { backgroundColor: t.cardBg, borderRadius: t.radius.md, borderColor: c.border }]}>
            <Text style={[styles.judgingText, { color: c.textSub }]}>AI 正在批改你的答案…</Text>
          </View>
        ) : null}
      </ScrollView>

      <View style={[styles.bottom, { backgroundColor: c.tabBar, borderColor: c.border, paddingBottom: insets.bottom + t.spacing.md }]}>
        <Pressable
          accessibilityRole="button"
          onPress={goPrev}
          disabled={index === 0}
          style={({ pressed }) => [styles.ghost, { borderColor: c.border, borderRadius: t.radius.md, opacity: index === 0 ? 0.4 : pressed ? 0.9 : 1 }]}
        >
          <Text style={[styles.ghostText, { color: c.textSub }]}>上一题</Text>
        </Pressable>

        {memorize ? (
          <Pressable
            accessibilityRole="button"
            onPress={goNext}
            style={({ pressed }) => [styles.primary, { backgroundColor: c.primary, borderRadius: t.radius.md, opacity: pressed ? 0.9 : 1 }]}
          >
            <Text style={[styles.primaryText, { color: c.onPrimary }]}>{isLast ? '完成背题' : '下一题'}</Text>
          </Pressable>
        ) : graded ? (
          <Pressable
            accessibilityRole="button"
            onPress={goNext}
            style={({ pressed }) => [styles.primary, { backgroundColor: c.primary, borderRadius: t.radius.md, opacity: pressed ? 0.9 : 1 }]}
          >
            <Text style={[styles.primaryText, { color: c.onPrimary }]}>{isLast ? '查看结果' : '下一题'}</Text>
          </Pressable>
        ) : (
          <Pressable
            accessibilityRole="button"
            onPress={() => {
              onSubmit().catch((error) => console.error('[session] 提交失败:', error));
            }}
            style={({ pressed }) => [
              styles.primary,
              { backgroundColor: c.primary, borderRadius: t.radius.md, opacity: judging || saving ? 0.6 : pressed ? 0.9 : 1 },
            ]}
          >
            <Text style={[styles.primaryText, { color: c.onPrimary }]}>{judging ? '批改中…' : '提交答案'}</Text>
          </Pressable>
        )}

        <Pressable accessibilityRole="button" onPress={onFinish} style={({ pressed }) => [styles.ghost, { borderColor: c.border, borderRadius: t.radius.md, opacity: pressed ? 0.9 : 1 }]}>
          <Text style={[styles.ghostText, { color: c.textSub }]}>交卷</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  head: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16 },
  headCenter: { flex: 1 },
  bankName: { fontSize: 13, fontWeight: '600' },
  counter: { fontSize: 17, fontWeight: '800', marginTop: 1 },
  trackWrap: { paddingHorizontal: 16, marginTop: 10 },
  trackMeta: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 6 },
  trackMetaText: { fontSize: 11 },
  scroll: { paddingHorizontal: 16, paddingBottom: 30 },
  qCard: {
    padding: 16,
    marginTop: 6,
  },
  tagRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 8 },
  stem: { fontSize: 16.5, lineHeight: 26, fontWeight: '500' },
  optList: { marginTop: 12, gap: 8 },
  opt: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    padding: 12,
    borderWidth: 1.5,
  },
  optLetter: { width: 28, height: 28, borderRadius: 14, alignItems: 'center', justifyContent: 'center' },
  optLetterText: { fontSize: 13, fontWeight: '800' },
  optText: { flex: 1, fontSize: 15, lineHeight: 22 },
  tfRow: { flexDirection: 'row', gap: 12, marginTop: 12 },
  tfBtn: { flex: 1, height: 52, borderWidth: 1.5, alignItems: 'center', justifyContent: 'center' },
  tfText: { fontSize: 16, fontWeight: '700' },
  fillBox: { marginTop: 12 },
  fillHint: { fontSize: 12, marginBottom: 8 },
  input: { borderWidth: 1, padding: 12, minHeight: 92, textAlignVertical: 'top', fontSize: 15, lineHeight: 23 },
  feedback: { marginTop: 12, padding: 16, borderWidth: 1 },
  fbHead: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  fbTitle: { fontSize: 14, fontWeight: '800' },
  fbReason: { fontSize: 12.5, lineHeight: 19, marginTop: 6 },
  fbLabel: { fontSize: 11, marginTop: 10, fontWeight: '600' },
  fbAnswer: { fontSize: 16, fontWeight: '700', marginTop: 2, lineHeight: 24 },
  fbExp: { fontSize: 13.5, lineHeight: 21, marginTop: 8 },
  refBtn: { marginTop: 12, height: 44, borderWidth: 1.4, alignItems: 'center', justifyContent: 'center' },
  refBtnText: { fontSize: 14.5, fontWeight: '700' },
  judging: { marginTop: 12, borderWidth: 1, padding: 16, alignItems: 'center' },
  judgingText: { fontSize: 13 },
  bottom: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 16,
    paddingTop: 12,
  },
  primary: { flex: 2, height: 48, alignItems: 'center', justifyContent: 'center' },
  primaryText: { fontSize: 15.5, fontWeight: '700' },
  ghost: { flex: 1, height: 48, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  ghostText: { fontSize: 14, fontWeight: '600' },
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 16, padding: 24 },
  emptyText: { fontSize: 14, textAlign: 'center' },
  emptyBtn: { paddingHorizontal: 24, height: 42, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  emptyBtnText: { fontSize: 14, fontWeight: '700', color: '#fff' },
});
