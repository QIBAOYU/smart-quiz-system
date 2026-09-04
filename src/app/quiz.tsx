/**
 * 模式选择页：顺序 / 随机 / 背题 / 错题重练。
 * 每个模式各自显示已保存的断点进度，可继续或清除，互不覆盖。
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { dialog } from '../components/dialog';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useLocalSearchParams, router } from 'expo-router';
import { modeDescriptions, modeLabels } from '../constants/theme';
import { CheckIcon, ChevronIcon, ShareIcon } from '../components/icons';
import { Card, LoadingBlock, ProgressBar, SectionTitle, Tag } from '../components/ui';
import { useTaskInset } from '../components/AiTaskLayer';
import { useTheme } from '../store/ThemeContext';
import { useApp } from '../store/AppContext';
import { listQuestions, listQuestionsByIds, listWrongEntries } from '../services/quizStore';
import { listDueQuestions } from '../services/reviewStore';
import { listFavoriteQuestions } from '../services/favoriteStore';
import { answeredCount, clearProgress, listProgress, progressDone, saveProgress, seenCount } from '../services/progressStore';
import { buildSession } from '../services/quizEngine';
import { exportAndShare, FORMAT_LABELS, type ExportFormat } from '../services/exportService';
import { startSession } from '../store/sessionStore';
import type { AnswerRecord, Question, QuizMode, SavedProgress } from '../types/quiz';

const MODES: QuizMode[] = ['seq', 'random', 'memorize', 'wrong', 'exam', 'favorite', 'review'];
const LIMITS = [0, 10, 20, 50];

/** 各模式的空池提示：说清为什么没题、去哪儿补 */
function poolEmptyTip(m: QuizMode): { title: string; message: string } {
  if (m === 'wrong') return { title: '暂无待消灭错题', message: '错题本里的题目都已连对两次，先去练习模式刷几题。' };
  if (m === 'favorite') return { title: '这个题库还没有收藏', message: '在题库详情页点开某道题，点题干右侧的星标即可收藏。' };
  if (m === 'review')
    return {
      title: '这个题库今天没有到期的题目',
      message: '复习计划从日常作答里自动长出：答过的题会按记忆曲线安排到期时间，到期后就会出现在这里。',
    };
  return { title: '题库还没有题目', message: '题库数据为空，请重新导入资料。' };
}

/** 难度筛选：0 = 不限，1/2/3 与 quiz_questions.difficulty 同口径（未标注的题只在「不限」里出现） */
const DIFF_FILTERS: Array<{ value: number; label: string }> = [
  { value: 0, label: '不限难度' },
  { value: 1, label: '简单' },
  { value: 2, label: '中等' },
  { value: 3, label: '困难' },
];

function timeAgo(iso: string): string {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return '';
  const diff = Date.now() - then;
  const min = Math.floor(diff / 60000);
  if (min < 1) return '刚刚';
  if (min < 60) return `${min} 分钟前`;
  const hour = Math.floor(min / 60);
  if (hour < 24) return `${hour} 小时前`;
  return `${Math.floor(hour / 24)} 天前`;
}

export default function QuizSetupScreen() {
  const { id, name } = useLocalSearchParams<{ id: string; name: string }>();
  const insets = useSafeAreaInsets();
  const t = useTheme();
  const c = t.palette;
  const taskInset = useTaskInset();
  const { settings } = useApp();

  const [questions, setQuestions] = useState<Question[]>([]);
  const [wrongPool, setWrongPool] = useState<Question[]>([]);
  const [favPool, setFavPool] = useState<Question[]>([]);
  const [duePool, setDuePool] = useState<Question[]>([]);
  const [progress, setProgress] = useState<SavedProgress[]>([]);
  const [loading, setLoading] = useState(true);
  const [mode, setMode] = useState<QuizMode>(settings.defaultMode === 'wrong' ? 'seq' : settings.defaultMode);
  const [limit, setLimit] = useState(0);
  const [difficulty, setDifficulty] = useState(0);
  const [sharing, setSharing] = useState(false);

  const reloadProgress = useCallback(async () => {
    try {
      setProgress(await listProgress(id));
    } catch (error) {
      console.error('[quiz] 读取进度失败:', error);
    }
  }, [id]);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const [all, wrong, favs, dues] = await Promise.all([
          listQuestions(id),
          listWrongEntries(id),
          listFavoriteQuestions(500),
          listDueQuestions(300),
        ]);
        if (!alive) return;
        setQuestions(all);
        setWrongPool(wrong.filter((w) => !w.resolved && w.question).map((w) => w.question as Question));
        // 收藏池与复习池都是跨题库取回来的，本页只练属于本题库的那部分
        setFavPool(favs.filter((q) => q.bankId === id));
        setDuePool(dues.filter((q) => q.bankId === id));
      } catch (error) {
        console.error('[quiz] load failed:', error);
      } finally {
        if (alive) setLoading(false);
      }
      reloadProgress().catch((error) => console.error('[quiz] progress reload failed:', error));
    })();
    return () => {
      alive = false;
    };
  }, [id, reloadProgress]);

  const reviewedCount = useMemo(() => questions.filter((q) => q.reviewed).length, [questions]);
  const byDifficulty = useCallback(
    (list: Question[]) => (difficulty === 0 ? list : list.filter((q) => q.difficulty === difficulty)),
    [difficulty],
  );
  const scopedQuestions = useMemo(() => byDifficulty(questions), [byDifficulty, questions]);
  const scopedWrong = useMemo(() => byDifficulty(wrongPool), [byDifficulty, wrongPool]);
  const scopedFav = useMemo(() => byDifficulty(favPool), [byDifficulty, favPool]);
  const scopedDue = useMemo(() => byDifficulty(duePool), [byDifficulty, duePool]);
  /** 题池按模式切换：错题 / 收藏 / 到期复习各取自己的池，其余模式走本题库全量 */
  const poolFor = useCallback(
    (m: QuizMode) =>
      m === 'wrong' ? scopedWrong : m === 'favorite' ? scopedFav : m === 'review' ? scopedDue : scopedQuestions,
    [scopedDue, scopedFav, scopedQuestions, scopedWrong],
  );
  const pool = poolFor(mode);
  const diffLabel = DIFF_FILTERS.find((d) => d.value === difficulty)?.label ?? '不限难度';
  const planCount = limit > 0 ? Math.min(limit, pool.length) : pool.length;
  const examMinutes = Math.max(1, Math.round((planCount * (settings.examSecondsPerQuestion || 0)) / 60));

  const onStart = useCallback(() => {
    if (pool.length === 0) {
      const tip = poolEmptyTip(mode);
      dialog.alert(tip.title, tip.message);
      return;
    }
    const list = buildSession(pool, mode, limit);
    const existing = progress.find((p) => p.mode === mode);
    const existingDone = existing ? answeredCount(existing) + seenCount(existing) : 0;
    if (existing && existingDone > 0) {
      const verb = mode === 'memorize' ? '已浏览' : '已作答';
      dialog.alert('该模式已有进度', `「${modeLabels[mode]}」${verb} ${existingDone}/${existing.total} 题。`, [
        {
          text: '重新开始',
          style: 'destructive',
          onPress: () => {
            clearProgress(id, mode)
              .then(() => {
                setProgress((prev) => prev.filter((p) => p.mode !== mode));
                startSession({ bankId: id, bankName: name || '题库', mode, questions: list });
                router.push(mode === 'exam' ? '/exam' : '/session');
              })
              .catch((error) => console.error('[quiz] 清除进度失败:', error));
          },
        },
        { text: '取消', style: 'cancel' },
      ]);
      return;
    }
    startSession({ bankId: id, bankName: name || '题库', mode, questions: list });
    router.push(mode === 'exam' ? '/exam' : '/session');
  }, [id, limit, mode, name, pool, progress]);

  /** 继续某个模式的断点 */
  const onResume = useCallback(
    async (p: SavedProgress) => {
      try {
        const rows = await listQuestionsByIds(p.questionIds);
        const map = new Map(rows.map((q) => [q.id, q]));
        const ordered = p.questionIds.map((qid) => map.get(qid)).filter(Boolean) as Question[];
        if (ordered.length === 0) {
          dialog.alert('无法继续', '这批题目已被删除，进度会自动清除。');
          await clearProgress(p.bankId, p.mode);
          reloadProgress().catch((error) => console.error('[quiz] reload failed:', error));
          return;
        }
        // 背题模式存的是「已浏览」标记，不能当成作答记录，否则已作答数会虚高
        const records: AnswerRecord[] = ordered
          .filter((q) => p.answers[q.id] && !p.answers[q.id].seen)
          .map((q) => ({
            questionId: q.id,
            correct: p.answers[q.id].correct,
            manual: p.answers[q.id].manual,
            reason: p.answers[q.id].reason,
            given: p.answers[q.id].given,
            score: p.answers[q.id].score ?? (p.answers[q.id].correct ? 1 : 0),
          }));
        const seenIds = ordered.filter((q) => p.answers[q.id]?.seen).map((q) => q.id);
        const startIndex = Math.min(Math.max(0, p.cursor), ordered.length - 1);
        startSession({
          bankId: p.bankId,
          bankName: p.bankName || name || '题库',
          mode: p.mode,
          questions: ordered,
          records,
          seenIds,
          startIndex,
        });
        // 续练时把本次会话先落到进度，避免中途杀进程丢最后一步
        await saveProgress({ ...p, questionIds: ordered.map((q) => q.id), total: ordered.length });
        router.push('/session');
      } catch (error) {
        console.error('[quiz] resume failed:', error);
        dialog.alert('无法继续', '读取题目时出错，请检查网络后重试。');
      }
    },
    [name, reloadProgress],
  );

  const onDropProgress = useCallback(
    (p: SavedProgress) => {
      dialog.alert('清除该模式进度', `「${modeLabels[p.mode]}」的作答进度会被删除，题目本身与错题本不受影响。`, [
        { text: '取消', style: 'cancel' },
        {
          text: '确定清除',
          style: 'destructive',
          onPress: () => {
            clearProgress(p.bankId, p.mode)
              .then((ok) => {
                if (!ok) dialog.alert('未能清除', '请稍后重试。');
                reloadProgress().catch((error) => console.error('[quiz] reload failed:', error));
              })
              .catch((error) => console.error('[quiz] 清除进度失败:', error));
          },
        },
      ]);
    },
    [reloadProgress],
  );

  /** 分享当前模式题池的全部题目（错题重练只发错题），不按答案确认状态过滤，含答案与解析 */
  const askShare = useCallback(() => {
    if (pool.length === 0) {
      dialog.alert(
        mode === 'wrong' ? '暂无错题可分享' : '题库还没有题目',
        mode === 'wrong' ? '这个题库的错题都已消灭，先去练习几轮再分享。' : '请先导入资料，再分享题库。',
      );
      return;
    }
    const buttons: { text: string; onPress?: () => void; style?: 'cancel' | 'destructive' }[] = (
      ['docx', 'doc', 'txt'] as ExportFormat[]
    ).map((f) => ({
      text: FORMAT_LABELS[f],
      onPress: () => {
        setSharing(true);
        exportAndShare(name || '题库', f, pool, true)
          .then((r) => {
            if (!r.ok) dialog.alert('分享未完成', r.message);
          })
          .catch((error) => console.error('[quiz] share failed:', error))
          .finally(() => setSharing(false));
      },
    }));
    dialog.alert(
      '分享题库',
      `将分享「${modeLabels[mode]}」的全部 ${pool.length} 题，含答案与解析。选择一种格式：`,
      [...buttons, { text: '取消', style: 'cancel' }],
    );
  }, [mode, name, pool]);

  if (loading) {
    return (
      <View style={[styles.root, { backgroundColor: c.bg, paddingTop: insets.top + taskInset }]}>
        <LoadingBlock label="正在载入题库题目…" />
      </View>
    );
  }

  return (
    <View style={[styles.root, { paddingTop: insets.top + taskInset }]}>
      <View style={styles.nav}>
        <Pressable
          accessibilityRole="button"
          onPress={() => (router.canGoBack() ? router.back() : router.replace('/'))}
          hitSlop={12}
          style={styles.back}
        >
          <Text style={[styles.backText, { color: c.primary }]}>‹ 返回</Text>
        </Pressable>
        <Text style={[styles.navTitle, { color: c.text }]} numberOfLines={1}>
          {name || '开始刷题'}
        </Text>
        <View style={styles.navSpace} />
      </View>

      <FlatList
        data={MODES}
        keyExtractor={(m) => m}
        contentContainerStyle={styles.scroll}
        showsVerticalScrollIndicator={false}
        ListHeaderComponent={
          <View>
            {/* 概览 */}
            <Card style={{ flexDirection: 'row', alignItems: 'center', gap: 14 }}>
              <View>
                <Text style={[styles.summaryValue, { color: c.primary }]}>{questions.length}</Text>
                <Text style={[styles.summaryLabel, { color: c.textMuted }]}>道题目</Text>
              </View>
              <View style={{ flex: 1, gap: 6 }}>
                <Text style={[styles.summaryMeta, { color: c.textSub }]}>
                  答案已确认 {reviewedCount} · 答案待确认 {questions.length - reviewedCount}
                </Text>
                <ProgressBar ratio={questions.length ? reviewedCount / questions.length : 0} color={c.success} height={5} />
                {reviewedCount < questions.length ? (
                  <Pressable accessibilityRole="button" onPress={() => router.push({ pathname: '/bank', params: { id } })} hitSlop={8}>
                    <Text style={[styles.reviewLink, { color: c.primary }]}>去逐题确认答案 ›</Text>
                  </Pressable>
                ) : (
                  <Text style={[styles.reviewDone, { color: c.success }]}>题目已全部确认，可放心练习</Text>
                )}
              </View>
            </Card>

            {/* 断点进度：按模式分别保存 */}
            {progress.length > 0 ? (
              <>
                <SectionTitle title="未完成的练习" hint="每个模式各存一份" />
                {progress.map((p) => {
                  const done = progressDone(p);
                  return (
                    <Card key={`${p.mode}_${p.updatedAt}`} style={{ marginBottom: 8 }}>
                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                        <Text style={[styles.progressMode, { color: c.text }]}>{modeLabels[p.mode] ?? p.mode}</Text>
                        <Tag label={`${done}/${p.total}`} tone={done >= p.total ? 'success' : 'primary'} />
                        <View style={{ flex: 1 }} />
                        <Text style={[styles.progressTime, { color: c.textMuted }]}>{timeAgo(p.updatedAt)}</Text>
                      </View>
                      <ProgressBar ratio={p.total ? done / p.total : 0} color={c.accent} height={5} />
                      <View style={{ flexDirection: 'row', gap: 8, marginTop: 12 }}>
                        <Pressable
                          accessibilityRole="button"
                          onPress={() => {
                            onResume(p).catch((error) => console.error('[quiz] resume failed:', error));
                          }}
                          style={({ pressed }) => [
                            styles.resumeBtn,
                            { backgroundColor: c.primary, borderRadius: t.radius.md, opacity: pressed ? 0.9 : 1 },
                          ]}
                        >
                          <Text style={[styles.resumeText, { color: c.onPrimary }]}>继续（第 {Math.min(p.cursor + 1, p.total)} 题）</Text>
                        </Pressable>
                        <Pressable
                          accessibilityRole="button"
                          onPress={() => onDropProgress(p)}
                          style={({ pressed }) => [
                            styles.dropBtn,
                            { borderColor: c.border, borderRadius: t.radius.md, opacity: pressed ? 0.8 : 1 },
                          ]}
                        >
                          <Text style={[styles.dropText, { color: c.textMuted }]}>清除</Text>
                        </Pressable>
                      </View>
                    </Card>
                  );
                })}
              </>
            ) : null}

            <SectionTitle title="选择练习模式" />
          </View>
        }
        renderItem={({ item: m }) => {
          const active = mode === m;
          const count = poolFor(m).length;
          return (
            <Pressable
              accessibilityRole="button"
              onPress={() => setMode(m)}
              style={({ pressed }) => [
                styles.modeCard,
                {
                  backgroundColor: active ? c.primarySoft : t.cardBg,
                  borderColor: active ? c.primary : c.border,
                  borderRadius: t.cardRadius,
                  opacity: pressed ? 0.94 : 1,
                  ...(active ? t.shadow.card : {}),
                },
              ]}
            >
              <View style={styles.modeHead}>
                <Text style={[styles.modeTitle, { color: active ? c.primaryDark : c.text }]}>{modeLabels[m]}</Text>
                <Tag label={`${count} 题`} tone={count === 0 ? 'neutral' : 'primary'} />
                <View style={styles.flex} />
                {active ? <CheckIcon size={16} color={c.primary} /> : <ChevronIcon size={15} color={c.textMuted} />}
              </View>
              <Text style={[styles.modeDesc, { color: c.textSub }]}>{modeDescriptions[m]}</Text>
            </Pressable>
          );
        }}
        ListFooterComponent={
          <View>
            <SectionTitle title="题目难度" hint={difficulty > 0 ? `已筛出 ${pool.length} 题` : undefined} />
            <View style={styles.limitRow}>
              {DIFF_FILTERS.map((d) => (
                <Pressable
                  key={d.value}
                  accessibilityRole="button"
                  onPress={() => setDifficulty(d.value)}
                  style={[
                    styles.limitChip,
                    {
                      backgroundColor: difficulty === d.value ? c.primary : t.cardBg,
                      borderColor: difficulty === d.value ? c.primary : c.border,
                      borderRadius: t.radius.md,
                    },
                  ]}
                >
                  <Text style={[styles.limitText, { color: difficulty === d.value ? c.onPrimary : c.textSub }]}>{d.label}</Text>
                </Pressable>
              ))}
            </View>
            {difficulty > 0 && pool.length === 0 ? (
              <Text style={[styles.hint, { color: c.warn }]}>
                这个池子里没有标为「{diffLabel}」的题目。可在题库详情页展开题目来标注难度。
              </Text>
            ) : null}

            <SectionTitle title="本次题量" />
            <View style={styles.limitRow}>
              {LIMITS.map((l) => (
                <Pressable
                  key={l}
                  accessibilityRole="button"
                  onPress={() => setLimit(l)}
                  style={[
                    styles.limitChip,
                    {
                      backgroundColor: limit === l ? c.primary : t.cardBg,
                      borderColor: limit === l ? c.primary : c.border,
                      borderRadius: t.radius.md,
                    },
                  ]}
                >
                  <Text style={[styles.limitText, { color: limit === l ? c.onPrimary : c.textSub }]}>{l === 0 ? '全部' : `${l} 题`}</Text>
                </Pressable>
              ))}
            </View>
            {limit > pool.length && pool.length > 0 ? (
              <Text style={[styles.hint, { color: c.warn }]}>该池只有 {pool.length} 题，将全部练完。</Text>
            ) : null}

            {mode === 'exam' ? (
              <Text style={[styles.hint, { color: c.textSub }]}>
                {settings.examSecondsPerQuestion > 0
                  ? `整卷限时约 ${examMinutes} 分钟（${planCount} 题 × 每题 ${settings.examSecondsPerQuestion} 秒），可在设置页调整。考试中不显示对错，交卷后统一出分。`
                  : '当前未设每题限时，本次模考不限时长。考试中不显示对错，交卷后统一出分。'}
              </Text>
            ) : null}

            {/* 分享：走当前模式题池的全部题目，不受上方题量限制 */}
            <View style={{ marginTop: 20 }}>
              <Pressable
                accessibilityRole="button"
                onPress={askShare}
                disabled={sharing}
                style={({ pressed }) => [
                  styles.shareBtn,
                  {
                    backgroundColor: t.cardBg,
                    borderColor: c.border,
                    borderRadius: t.cardRadius,
                    opacity: sharing ? 0.6 : pressed ? 0.92 : 1,
                  },
                ]}
              >
                <ShareIcon size={15} color={c.text} />
                <Text style={[styles.shareText, { color: c.text }]}>
                  {sharing ? '正在生成文件…' : `分享「${modeLabels[mode]}」题库（${pool.length} 题）`}
                </Text>
              </Pressable>
              <Text style={[styles.shareHint, { color: c.textMuted }]}>
                分享该模式题池里的全部题目，含答案与解析，不受上方题量限制；生成 Word 或纯文本后走系统分享。
              </Text>
            </View>
          </View>
        }
      />

      <View style={[styles.bottom, { backgroundColor: c.tabBar, borderColor: c.border, paddingBottom: insets.bottom + 12 }]}>
        <Text style={[styles.bottomMeta, { color: c.textSub }]}>
          {modeLabels[mode]} · {planCount} 题
        </Text>
        <Pressable
          accessibilityRole="button"
          onPress={onStart}
          style={({ pressed }) => [styles.start, { backgroundColor: c.primary, borderRadius: t.radius.md, opacity: pressed ? 0.9 : 1, ...t.shadow.card }]}
        >
          <Text style={[styles.startText, { color: c.onPrimary }]}>开始练习</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  nav: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, marginBottom: 6, minHeight: 40 },
  back: { width: 64 },
  backText: { fontSize: 15, fontWeight: '600' },
  navTitle: { flex: 1, textAlign: 'center', fontSize: 16, fontWeight: '700' },
  navSpace: { width: 64 },
  scroll: { paddingHorizontal: 16, paddingBottom: 30 },
  summaryValue: { fontSize: 28, fontWeight: '800' },
  summaryLabel: { fontSize: 12, marginTop: 2 },
  summaryMeta: { fontSize: 12 },
  reviewLink: { fontSize: 12, fontWeight: '600', marginTop: 2 },
  reviewDone: { fontSize: 12, marginTop: 2, fontWeight: '600' },
  progressMode: { fontSize: 14.5, fontWeight: '700' },
  progressTime: { fontSize: 11 },
  resumeBtn: { flex: 2, height: 42, alignItems: 'center', justifyContent: 'center' },
  resumeText: { fontSize: 13.5, fontWeight: '700' },
  shareBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    height: 50,
    borderWidth: 1,
  },
  shareText: { fontSize: 14.5, fontWeight: '700' },
  shareHint: { fontSize: 11.5, lineHeight: 18, marginTop: 8, textAlign: 'center' },
  dropBtn: { flex: 1, height: 42, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  dropText: { fontSize: 13, fontWeight: '600' },
  modeCard: { padding: 16, marginBottom: 8, borderWidth: 1.4 },
  modeHead: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  modeTitle: { fontSize: 15.5, fontWeight: '700' },
  modeDesc: { fontSize: 12.5, lineHeight: 19, marginTop: 5 },
  flex: { flex: 1 },
  limitRow: { flexDirection: 'row', gap: 8 },
  limitChip: { flex: 1, height: 40, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  limitText: { fontSize: 13, fontWeight: '600' },
  hint: { fontSize: 12, marginTop: 8 },
  bottom: { borderTopWidth: StyleSheet.hairlineWidth, paddingHorizontal: 16, paddingTop: 12, gap: 8 },
  bottomMeta: { fontSize: 12.5 },
  start: { height: 50, alignItems: 'center', justifyContent: 'center' },
  startText: { fontSize: 16, fontWeight: '700' },
});
