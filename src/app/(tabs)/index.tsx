/**
 * 首页：题库列表 + 断点续练 + 解析模式胶囊
 *
 * 右上角胶囊实时反映「本地 + AI / 纯本地」，点击进入 AI 供应商配置页。
 */
import React, { useCallback, useMemo, useState } from 'react';
import { FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native';
import { dialog } from '../../components/dialog';
import { useFocusEffect } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { modeLabels } from '../../constants/theme';
import { BankCard } from '../../components/BankCard';
import { EmptyGuide } from '../../components/EmptyGuide';
import { BookIcon, ChartIcon, ChevronIcon, SparkIcon, UploadIcon } from '../../components/icons';
import { Card, ProgressBar, SectionTitle, Tag } from '../../components/ui';
import { QuotaHint } from '../../components/QuotaHint';
import { Segmented } from '../../components/Segmented';
import { useApp } from '../../store/AppContext';
import { useTheme } from '../../store/ThemeContext';
import { useTaskInset } from '../../components/AiTaskLayer';
import { listAllProgress, progressDone } from '../../services/progressStore';
import { listQuestionsBySubject } from '../../services/quizStore';
import { flushAttemptQueue, getPendingAttemptCount, usePendingAttemptCount } from '../../services/offlineQueue';
import { loadStats } from '../../services/statsService';
import { loadFavoriteIds, listFavoriteQuestions, useFavorites } from '../../services/favoriteStore';
import { listDueQuestions, loadReviewSummary } from '../../services/reviewStore';
import { buildSession } from '../../services/quizEngine';
import { startSession } from '../../store/sessionStore';
import { useAiStatus } from '../../services/aiConfig';
import type { Bank, SavedProgress, SubjectStat } from '../../types/quiz';

/** 「我的题库」列表在两个 TAB 下的行数据：题库行 or 科目行 */
type HomeRow = Bank | SubjectStat;

function isBankRow(row: HomeRow): row is Bank {
  return typeof (row as Bank).id === 'string';
}

function Greeting({ total, questions, color, subColor }: { total: number; questions: number; color: string; subColor: string }) {
  const hour = new Date().getHours();
  const word = hour < 6 ? '凌晨好' : hour < 11 ? '早上好' : hour < 14 ? '中午好' : hour < 18 ? '下午好' : '晚上好';
  return (
    <View style={{ flex: 1 }}>
      <Text style={[styles.hello, { color }]}>{word}，今天也来刷几题</Text>
      <Text style={[styles.sub, { color: subColor }]}>
        {total > 0 ? `${total} 个题库 · ${questions} 道题目已就绪` : '导入第一份资料，开启你的刷题计划'}
      </Text>
    </View>
  );
}

export default function HomeScreen() {
  const { banks, banksLoading, banksError, refreshBanks, settings } = useApp();
  const insets = useSafeAreaInsets();
  const taskInset = useTaskInset();
  const t = useTheme();
  const c = t.palette;
  const ai = useAiStatus();
  const [progress, setProgress] = useState<SavedProgress[]>([]);
  const [rates, setRates] = useState<Record<string, { count: number; accuracy: number }>>({});
  /** 断网 / 云端异常期间没能写入的作答条数（内存队列） */
  const pending = usePendingAttemptCount();
  const [syncing, setSyncing] = useState(false);
  /** 今日作答数与连续打卡天数：来自 statsService，口径与统计页一致 */
  const [today, setToday] = useState({ count: 0, streak: 0 });
  const [dueCount, setDueCount] = useState(0);
  const [starting, setStarting] = useState<'none' | 'review' | 'favorite' | 'subject'>('none');
  /** 我的题库列表的两个维度：按题库看，或按 AI 识别出的科目看 */
  const [listTab, setListTab] = useState<'bank' | 'subject'>('bank');
  const [subjects, setSubjects] = useState<SubjectStat[]>([]);
  const { count: favCount } = useFavorites();

  /** 分题库正确率：statsService 返回的 accuracy 已是 0-100 百分数，这里只做兜底钳制 */
  const loadRates = useCallback(async () => {
    try {
      const s = await loadStats();
      const map: Record<string, { count: number; accuracy: number }> = {};
      (s?.byBank ?? []).forEach((b) => {
        map[b.id] = { count: b.count, accuracy: Math.max(0, Math.min(100, Math.round(b.accuracy))) };
      });
      setRates(map);
      setSubjects(s?.bySubject ?? []);
      setToday({ count: s?.todayCount ?? 0, streak: s?.streakDays ?? 0 });
      setDueCount((await loadReviewSummary()).due);
    } catch (error) {
      console.error('[home] 读取分题库正确率失败:', error);
    }
  }, []);

  /** 手动补交：网络恢复后用户可以立刻把攒下的作答推上去，不用等下一次答题顺带触发 */
  const retrySync = useCallback(async () => {
    if (syncing) return;
    setSyncing(true);
    try {
      const done = await flushAttemptQueue();
      const left = getPendingAttemptCount();
      if (left === 0) {
        dialog.alert(
          '已全部同步',
          done > 0 ? `${done} 题作答记录已补交到云端，统计与错题本已刷新。` : '记录本来就已同步，无需补交。',
        );
        if (done > 0) loadRates().catch((error) => console.error('[home] rates reload failed:', error));
      } else {
        dialog.alert('仍未同步完成', `还有 ${left} 题没能写入云端，请检查网络后再试一次。`);
      }
    } catch (error) {
      console.error('[home] flush failed:', error);
      dialog.alert('同步失败', '网络或云端暂时不可用，稍后会自动再试。');
    } finally {
      setSyncing(false);
    }
  }, [loadRates, syncing]);

  const loadProgress = useCallback(async () => {
    try {
      const list = await listAllProgress();
      setProgress(list.filter((p) => progressDone(p) > 0 && progressDone(p) < p.total).slice(0, 6));
    } catch (error) {
      console.error('[home] 读取断点进度失败:', error);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      loadProgress().catch((error) => console.error('[home] focus reload failed:', error));
      loadRates().catch((error) => console.error('[home] rates reload failed:', error));
      loadFavoriteIds().catch((error) => console.error('[home] 读取收藏失败:', error));
      // 回到首页就说明可能换了网络，静默补交一次，成功与否由横幅条数反映
      if (getPendingAttemptCount() > 0) {
        flushAttemptQueue().catch((error) => console.error('[home] auto flush failed:', error));
      }
    }, [loadProgress, loadRates]),
  );

  const rows = useMemo<HomeRow[]>(() => (listTab === 'bank' ? banks : subjects), [banks, listTab, subjects]);

  const totals = useMemo(
    () => ({
      questions: banks.reduce((sum, b) => sum + b.questionCount, 0),
      pending: banks.reduce((sum, b) => sum + Math.max(0, b.questionCount - b.reviewedCount), 0),
    }),
    [banks],
  );

  const openImport = useCallback(() => router.push('/import'), []);
  const openBank = useCallback((bank: Bank) => router.push({ pathname: '/bank', params: { id: bank.id } }), []);

  /**
   * 全局复习 / 收藏入口：跨题库取题，直接开一轮。
   * bankId 取首题归属 —— quiz_progress 的键必须是合法 uuid，不能用假字符串。
   */
  const startPool = useCallback(
    async (kind: 'review' | 'favorite') => {
      if (starting !== 'none') return;
      setStarting(kind);
      try {
        const list = kind === 'review' ? await listDueQuestions(100) : await listFavoriteQuestions(100);
        if (list.length === 0) {
          dialog.alert(
            kind === 'review' ? '今天没有到期的题目' : '还没有收藏题目',
            kind === 'review'
              ? '复习计划从日常作答里自动生长：答过的题会按记忆曲线安排到期时间。先去刷几题，之后这里就会有内容。'
              : '在题库详情页点开某道题，点题干右侧的星标即可收藏。',
          );
          return;
        }
        startSession({
          bankId: list[0].bankId,
          bankName: kind === 'review' ? '到期复习' : '收藏专练',
          mode: kind,
          questions: buildSession(list, kind, 50),
        });
        router.push('/session');
      } catch (error) {
        console.error('[home] 开始练习失败:', error);
        dialog.alert('没能开始', '读取题目时出错，请检查网络后重试。');
      } finally {
        setStarting('none');
      }
    },
    [starting],
  );

  /**
   * 只刷某一科：科目可能横跨多个题库，取题后 bankId 用首题归属，
   * 因为 quiz_progress 的断点键必须是合法 uuid。
   */
  const startSubject = useCallback(
    async (subject: string) => {
      if (starting !== 'none') return;
      setStarting('subject');
      try {
        const list = await listQuestionsBySubject(subject, 100);
        if (list.length === 0) {
          dialog.alert('该科目暂无题目', '可能是题目还没识别完科目，去题库详情页点「AI 自动分类」试试。');
          return;
        }
        startSession({
          bankId: list[0].bankId,
          bankName: `${subject} · 专练`,
          mode: 'random',
          questions: buildSession(list, 'random', 50),
        });
        router.push('/session');
      } catch (error) {
        console.error('[home] 科目练习开始失败:', error);
        dialog.alert('没能开始', '读取题目时出错，请检查网络后重试。');
      } finally {
        setStarting('none');
      }
    },
    [starting],
  );

  const removeBank = useCallback(
    async (bank: Bank) => {
      try {
        const { deleteBank } = await import('../../services/quizStore');
        const ok = await deleteBank(bank.id);
        if (!ok) {
          Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch((e) =>
            console.error('[home] haptic failed:', e),
          );
          return;
        }
        await refreshBanks();
        await loadProgress();
      } catch (error) {
        console.error('[home] deleteBank failed:', error);
      }
    },
    [loadProgress, refreshBanks],
  );

  const onRefresh = useCallback(() => {
    refreshBanks().catch((error) => console.error('[home] refresh failed:', error));
    loadProgress().catch((error) => console.error('[home] progress refresh failed:', error));
    loadRates().catch((error) => console.error('[home] rates refresh failed:', error));
  }, [loadProgress, loadRates, refreshBanks]);

  const header = (
    <View style={{ paddingTop: insets.top + taskInset + 10 }}>
      <View style={styles.headRow}>
        <Greeting total={banks.length} questions={totals.questions} color={c.text} subColor={c.textSub} />
        <View style={{ alignItems: 'flex-end', gap: 8 }}>
          {/* 解析模式胶囊：点击进入 AI 供应商配置 */}
          <Pressable
            accessibilityRole="button"
            onPress={() => router.push('/ai-config')}
            style={({ pressed }) => [
              styles.pill,
              {
                backgroundColor: ai.aiUsable ? c.primarySoft : c.warnSoft,
                borderColor: ai.aiUsable ? c.primary : c.warn,
                opacity: pressed ? 0.9 : 1,
                ...t.shadow.inset,
              },
            ]}
          >
            <View style={[styles.pillDot, { backgroundColor: ai.aiUsable ? c.success : c.warn }]} />
            <Text style={[styles.pillText, { color: ai.aiUsable ? c.primaryDark : c.warn }]}>{ai.label}</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            onPress={openImport}
            style={({ pressed }) => [
              styles.importBtn,
              { backgroundColor: c.primary, opacity: pressed ? 0.9 : 1, ...t.shadow.card },
            ]}
          >
            <UploadIcon size={15} color={c.onPrimary} />
            <Text style={[styles.importText, { color: c.onPrimary }]}>导入</Text>
          </Pressable>
        </View>
      </View>

      <Text style={[styles.pillHint, { color: c.textMuted }]}>{ai.sub}</Text>

      {/* 全局搜索入口：做成假输入条，点进去才是真搜索页 */}
      <Pressable
        accessibilityRole="button"
        onPress={() => router.push('/search')}
        style={({ pressed }) => ({
          flexDirection: 'row',
          alignItems: 'center',
          gap: 8,
          height: 42,
          paddingHorizontal: 14,
          marginTop: 12,
          backgroundColor: t.cardBg,
          borderWidth: 1,
          borderColor: c.border,
          borderRadius: t.radius.pill,
          opacity: pressed ? 0.95 : 1,
        })}
      >
        <Text style={{ fontSize: 16, color: c.textMuted, marginTop: -2 }}>⌕</Text>
        <Text style={{ fontSize: 13.5, color: c.textMuted }}>搜索全部题库的题干、答案与解析</Text>
      </Pressable>

      {/* 题库清单拉取失败：明确告诉用户「下面可能是旧数据」，而不是悄悄显示空态 */}
      {banksError ? (
        <View style={[styles.banner, { backgroundColor: c.dangerSoft, borderColor: c.danger }]}>
          <Text style={[styles.bannerText, { color: c.danger }]}>
            没能从云端读到最新题库{banks.length > 0 ? '，下面显示的可能是上次的结果' : ''}。
          </Text>
          <Pressable
            accessibilityRole="button"
            onPress={() => refreshBanks().catch((error) => console.error('[home] retry banks failed:', error))}
            disabled={banksLoading}
            style={({ pressed }) => [styles.bannerBtn, { borderColor: c.danger, opacity: banksLoading || pressed ? 0.6 : 1 }]}
          >
            <Text style={[styles.bannerBtnText, { color: c.danger }]}>{banksLoading ? '重试中' : '重试'}</Text>
          </Pressable>
        </View>
      ) : null}

      {/* 未同步的作答记录：不写清楚的话，用户会以为统计和错题本已经包含刚才做的题 */}
      {pending > 0 ? (
        <View style={[styles.banner, { backgroundColor: c.warnSoft, borderColor: c.warn }]}>
          <Text style={[styles.bannerText, { color: c.warn }]}>
            {pending} 题作答还没同步到云端，统计与错题本暂时不含这些。
          </Text>
          <Pressable
            accessibilityRole="button"
            onPress={() => retrySync().catch((error) => console.error('[home] retry sync failed:', error))}
            disabled={syncing}
            style={({ pressed }) => [styles.bannerBtn, { borderColor: c.warn, opacity: syncing || pressed ? 0.6 : 1 }]}
          >
            <Text style={[styles.bannerBtnText, { color: c.warn }]}>{syncing ? '同步中' : '立即重试'}</Text>
          </Pressable>
        </View>
      ) : null}

      {/* 今日打卡：把「今天刷了多少」放在最显眼处，达标后转为连续天数 */}
      <Card style={{ marginBottom: 8, gap: 8 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <Text style={{ fontSize: 14.5, fontWeight: '700', color: c.text }}>今日刷题</Text>
          {settings.dailyGoal > 0 && today.count >= settings.dailyGoal ? <Tag label="已打卡" tone="success" /> : null}
          <View style={{ flex: 1 }} />
          <Text style={{ fontSize: 15, fontWeight: '800', color: settings.dailyGoal > 0 && today.count >= settings.dailyGoal ? c.success : c.primary }}>
            {today.count}
            {settings.dailyGoal > 0 ? ` / ${settings.dailyGoal}` : ''} 题
          </Text>
        </View>
        {settings.dailyGoal > 0 ? (
          <ProgressBar
            ratio={Math.min(1, today.count / settings.dailyGoal)}
            color={today.count >= settings.dailyGoal ? c.success : c.primary}
            height={6}
          />
        ) : null}
        <Text style={{ fontSize: 11.5, color: c.textMuted, lineHeight: 18 }}>
          {settings.dailyGoal > 0
            ? today.count >= settings.dailyGoal
              ? `目标已完成${today.streak > 1 ? `，已连续打卡 ${today.streak} 天` : ''}。想再多刷几题也随时欢迎。`
              : `再答 ${Math.max(0, settings.dailyGoal - today.count)} 题完成今日目标${today.streak > 1 ? `，已连续打卡 ${today.streak} 天` : ''}。`
            : today.streak > 0
              ? `今天已答 ${today.count} 题，连续打卡 ${today.streak} 天。可在设置页设定每日目标。`
              : '尚未设定每日目标，可在设置页开启打卡提醒。'}
        </Text>
      </Card>

      <QuotaHint />

      {progress.length > 0 ? (
        <>
          <SectionTitle title="未完成的练习" hint="按模式分别保存" style={{ marginTop: 20 }} />
          {progress.map((p) => {
            const done = progressDone(p);
            const ratio = p.total ? done / p.total : 0;
            return (
              <Card
                key={`${p.bankId}_${p.mode}`}
                style={{ marginBottom: 8 }}
                onPress={() => router.push({ pathname: '/quiz', params: { id: p.bankId, name: p.bankName } })}
              >
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                  <Text style={[styles.progressName, { color: c.text }]} numberOfLines={1}>
                    {p.bankName}
                  </Text>
                  <Tag label={modeLabels[p.mode] ?? p.mode} tone="primary" />
                  <View style={{ flex: 1 }} />
                  <Text style={[styles.progressCount, { color: c.textMuted }]}>
                    {done}/{p.total}
                  </Text>
                  <ChevronIcon size={14} color={c.textMuted} />
                </View>
                <View style={[styles.progressTrack, { backgroundColor: c.track }]}>
                  <View style={[styles.progressFill, { width: `${Math.round(ratio * 100)}%`, backgroundColor: c.accent }]} />
                </View>
              </Card>
            );
          })}
        </>
      ) : null}

      {banks.length > 0 && (
        <>
          <View style={styles.quickRow}>
            <Pressable
              accessibilityRole="button"
              onPress={() => router.push('/wrong')}
              style={({ pressed }) => [
                styles.quick,
                { backgroundColor: t.cardBg, borderColor: c.border, borderRadius: t.cardRadius, opacity: pressed ? 0.94 : 1, ...t.shadow.card },
              ]}
            >
              <View style={[styles.quickIcon, { backgroundColor: c.dangerSoft }]}>
                <BookIcon size={17} color={c.danger} />
              </View>
              <View style={styles.quickText}>
                <Text style={[styles.quickTitle, { color: c.text }]}>错题本</Text>
                <Text style={[styles.quickDesc, { color: c.textMuted }]}>{totals.pending > 0 ? '含答案待确认题目' : '待消灭的错题'}</Text>
              </View>
              <ChevronIcon size={15} color={c.textMuted} />
            </Pressable>
            <Pressable
              accessibilityRole="button"
              onPress={() => router.push('/stats')}
              style={({ pressed }) => [
                styles.quick,
                { backgroundColor: t.cardBg, borderColor: c.border, borderRadius: t.cardRadius, opacity: pressed ? 0.94 : 1, ...t.shadow.card },
              ]}
            >
              <View style={[styles.quickIcon, { backgroundColor: c.primarySoft }]}>
                <ChartIcon size={17} color={c.primary} />
              </View>
              <View style={styles.quickText}>
                <Text style={[styles.quickTitle, { color: c.text }]}>学习统计</Text>
                <Text style={[styles.quickDesc, { color: c.textMuted }]}>正确率与趋势</Text>
              </View>
              <ChevronIcon size={15} color={c.textMuted} />
            </Pressable>
          </View>

          <View style={styles.quickRow}>
            <Pressable
              accessibilityRole="button"
              onPress={() => {
                startPool('review').catch((error) => console.error('[home] 复习开始失败:', error));
              }}
              disabled={starting !== 'none'}
              style={({ pressed }) => [
                styles.quick,
                {
                  backgroundColor: t.cardBg,
                  borderColor: c.border,
                  borderRadius: t.cardRadius,
                  opacity: starting !== 'none' ? 0.7 : pressed ? 0.94 : 1,
                  ...t.shadow.card,
                },
              ]}
            >
              <View style={[styles.quickIcon, { backgroundColor: c.successSoft }]}>
                <Text style={{ fontSize: 15, color: c.success, fontWeight: '800' }}>复</Text>
              </View>
              <View style={styles.quickText}>
                <Text style={[styles.quickTitle, { color: c.text }]}>
                  {starting === 'review' ? '正在取题…' : '到期复习'}
                </Text>
                <Text style={[styles.quickDesc, { color: c.textMuted }]}>
                  {dueCount > 0 ? `${dueCount} 题按记忆曲线到期` : '按间隔重复安排，越生疏越先出现'}
                </Text>
              </View>
              <ChevronIcon size={15} color={c.textMuted} />
            </Pressable>
            <Pressable
              accessibilityRole="button"
              onPress={() => {
                startPool('favorite').catch((error) => console.error('[home] 收藏练习失败:', error));
              }}
              disabled={starting !== 'none'}
              style={({ pressed }) => [
                styles.quick,
                {
                  backgroundColor: t.cardBg,
                  borderColor: c.border,
                  borderRadius: t.cardRadius,
                  opacity: starting !== 'none' ? 0.7 : pressed ? 0.94 : 1,
                  ...t.shadow.card,
                },
              ]}
            >
              <View style={[styles.quickIcon, { backgroundColor: c.warnSoft }]}>
                <Text style={{ fontSize: 15, color: c.warn, fontWeight: '800' }}>★</Text>
              </View>
              <View style={styles.quickText}>
                <Text style={[styles.quickTitle, { color: c.text }]}>
                  {starting === 'favorite' ? '正在取题…' : '收藏专练'}
                </Text>
                <Text style={[styles.quickDesc, { color: c.textMuted }]}>
                  {favCount > 0 ? `已收藏 ${favCount} 题，考前过重点` : '点开题目右侧星标即可收藏重点题'}
                </Text>
              </View>
              <ChevronIcon size={15} color={c.textMuted} />
            </Pressable>
          </View>

          <SectionTitle
            title="我的题库"
            hint={totals.pending > 0 ? `${totals.pending} 题答案待确认` : undefined}
            style={{ marginTop: 24, marginBottom: 12 }}
          />
          <Segmented
            options={[
              { value: 'bank', label: '题库' },
              { value: 'subject', label: '科目' },
            ]}
            value={listTab}
            onChange={(v) => setListTab(v as 'bank' | 'subject')}
            stretch
            style={{ marginBottom: 12 }}
          />
        </>
      )}
    </View>
  );

  return (
    <View style={styles.screen}>
      <FlatList
      style={{ flex: 1, backgroundColor: c.bg }}
      data={rows}
      keyExtractor={(item) => (isBankRow(item) ? item.id : item.subject)}
      ListHeaderComponent={header}
      ListEmptyComponent={
        listTab === 'subject' ? (
          <Text style={{ fontSize: 12.5, color: c.textMuted, lineHeight: 19 }}>
            还没有识别出科目。导入题库后会自动进行 AI 科目识别，也可以在题库详情页手动点「AI 自动分类」。
          </Text>
        ) : banksLoading || banksError ? null : (
          <EmptyGuide onImport={openImport} />
        )
      }
      renderItem={({ item }) => {
        if (!isBankRow(item)) {
          const sub = item;
          const total = sub.total ?? 0;
          const mastered = Math.min(sub.masteredQuestions ?? 0, total);
          const rate = total > 0 ? Math.max(0, Math.min(100, Math.round((mastered / total) * 100))) : 0;
          const barColor = rate >= 80 ? c.success : rate >= 60 ? c.primary : c.warn;
          return (
            <Card style={{ marginBottom: 8 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <Text style={{ flex: 1, fontSize: 14.5, fontWeight: '700', color: c.text }} numberOfLines={1}>
                  {sub.subject}
                </Text>
                <Text style={{ fontSize: 15, fontWeight: '800', color: barColor }}>{total > 0 ? `${rate}%` : '—'}</Text>
              </View>
              <View style={[styles.progressTrack, { backgroundColor: c.track }]}>
                <View style={[styles.progressFill, { width: `${Math.max(rate, 2)}%`, backgroundColor: barColor }]} />
              </View>
              <Text style={{ fontSize: 11.5, color: c.textMuted, marginTop: 8, lineHeight: 18 }}>
                {total > 0
                  ? `掌握 ${mastered}/${total} 题 · ${sub.attempts > 0 ? `作答 ${sub.attempts} 次，正确率 ${sub.accuracy}%` : '还没有作答记录'}`
                  : '该科目暂无题目'}
              </Text>
              <View style={{ flexDirection: 'row', gap: 8, marginTop: 10 }}>
                <Pressable
                  accessibilityRole="button"
                  onPress={() => {
                    startSubject(sub.subject).catch((error) => console.error('[home] 科目练习失败:', error));
                  }}
                  disabled={starting !== 'none'}
                  style={({ pressed }) => [
                    styles.bannerBtn,
                    { borderColor: c.primary, backgroundColor: c.primarySoft, opacity: starting !== 'none' || pressed ? 0.7 : 1 },
                  ]}
                >
                  <Text style={[styles.bannerBtnText, { color: c.primaryDark }]}>
                    {starting === 'subject' ? '取题中…' : '只刷这科'}
                  </Text>
                </Pressable>
                <Pressable
                  accessibilityRole="button"
                  onPress={() => router.push({ pathname: '/wrong', params: { subject: sub.subject, name: sub.subject } })}
                  style={({ pressed }) => [styles.bannerBtn, { borderColor: c.border, opacity: pressed ? 0.7 : 1 }]}
                >
                  <Text style={[styles.bannerBtnText, { color: c.textSub }]}>错题</Text>
                </Pressable>
              </View>
            </Card>
          );
        }
        const bank = item;
        return (
          <BankCard
            bank={{ ...bank, attempts: rates[bank.id]?.count ?? 0, accuracy: rates[bank.id]?.accuracy }}
            onOpen={() => openBank(bank)}
            onDelete={() => removeBank(bank)}
          />
        );
      }}
      ItemSeparatorComponent={() => <View style={{ height: 8 }} />}
      contentContainerStyle={styles.listContent}
      refreshControl={<RefreshControl refreshing={banksLoading} onRefresh={onRefresh} tintColor={c.primary} colors={[c.primary]} />}
      ListFooterComponent={
        listTab === 'bank' && banks.length > 0 ? (
          <Pressable
            accessibilityRole="button"
            onPress={openImport}
            style={({ pressed }) => [
              styles.addMore,
              { borderColor: c.border, borderRadius: t.radius.md, opacity: pressed ? 0.9 : 1 },
            ]}
          >
            <SparkIcon size={15} color={c.accent} />
            <Text style={[styles.addMoreText, { color: c.textSub }]}>再导入一份资料</Text>
          </Pressable>
        ) : (
          <View style={{ height: 20 }} />
        )
      }
    />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  listContent: { paddingHorizontal: 16, paddingBottom: 30, flexGrow: 1 },
  headRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 12 },
  hello: { fontSize: 21, fontWeight: '800', letterSpacing: 0.2 },
  sub: { fontSize: 13, marginTop: 4, lineHeight: 19 },
  pill: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 10, height: 28, borderRadius: 999, borderWidth: 1 },
  pillDot: { width: 7, height: 7, borderRadius: 4 },
  pillText: { fontSize: 12, fontWeight: '700' },
  pillHint: { fontSize: 11.5, marginTop: 8, lineHeight: 17 },
  banner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginTop: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 12,
    borderWidth: 1,
  },
  bannerText: { flex: 1, fontSize: 12, lineHeight: 18 },
  bannerBtn: { paddingHorizontal: 12, height: 30, borderWidth: 1, borderRadius: 8, alignItems: 'center', justifyContent: 'center' },
  bannerBtnText: { fontSize: 12, fontWeight: '700' },
  importBtn: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 13, height: 34, borderRadius: 999 },
  importText: { fontSize: 13.5, fontWeight: '700' },
  progressName: { flexShrink: 1, fontSize: 14, fontWeight: '700' },
  progressCount: { fontSize: 12, fontWeight: '600' },
  progressTrack: { height: 5, borderRadius: 999, marginTop: 10, overflow: 'hidden' },
  progressFill: { height: '100%', borderRadius: 999 },
  quickRow: { flexDirection: 'row', gap: 12, marginTop: 20 },
  quick: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 10, padding: 14, borderWidth: 1 },
  quickIcon: { width: 34, height: 34, borderRadius: 11, alignItems: 'center', justifyContent: 'center' },
  quickText: { flex: 1 },
  quickTitle: { fontSize: 13.5, fontWeight: '700' },
  quickDesc: { fontSize: 11, marginTop: 1 },
  addMore: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    height: 46,
    borderWidth: 1.5,
    borderStyle: 'dashed',
    marginTop: 12,
  },
  addMoreText: { fontSize: 13.5, fontWeight: '600' },
});
