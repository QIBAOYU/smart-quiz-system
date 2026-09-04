/**
 * 题库详情：查看/修正已入库题目，逐题切换答案确认状态，并从这里发起练习。
 *
 * 本页面还提供：
 * - 导出题库（docx / doc / txt）
 * - 分享题库（生成文件后调用系统分享面板）
 * - 缺答案时让 AI 自动作答补全
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { dialog } from '../components/dialog';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useLocalSearchParams, router } from 'expo-router';
import { typeLabels } from '../constants/theme';
import { QuestionEditor, type EditableQuestion } from '../components/QuestionEditor';
import { Card, LoadingBlock, ProgressBar, Tag } from '../components/ui';
import { ShareIcon, SparkIcon } from '../components/icons';
import { useTaskInset } from '../components/AiTaskLayer';
import { useTheme } from '../store/ThemeContext';
import { useApp } from '../store/AppContext';
import {
  createBankWithQuestions,
  deleteQuestion,
  getBank,
  insertQuestionsAfter,
  listQuestions,
  listQuestionsFromOtherBanks,
  renameBank,
  updateQuestion,
} from '../services/quizStore';
import { buildExportFile, exportAndShare, FORMAT_LABELS, shareFile, type ExportFormat } from '../services/exportService';
import { findSimilarQuestions, generateSimilarQuestions, solveMissingAnswers } from '../services/aiService';
import { classifyBank } from '../services/subjectService';
import { createMockPaper, explainBank, needsExplanation, PAPER_SIZES } from '../services/aiPlusService';
import { toggleFavorite, loadFavoriteIds, useFavorites } from '../services/favoriteStore';
import { useAiStatus } from '../services/aiConfig';
import { QuotaHint } from '../components/QuotaHint';
import { ForgettingCurveCard } from '../components/ForgettingCurveCard';
import type { Bank, ParsedQuestion, Question } from '../types/quiz';

type Filter = 'all' | 'unreviewed' | 'low' | 'noanswer' | 'fav';

const FILTERS: Array<{ key: Filter; label: string }> = [
  { key: 'all', label: '全部' },
  { key: 'unreviewed', label: '答案待确认' },
  { key: 'low', label: '低置信' },
  { key: 'noanswer', label: '缺答案' },
  { key: 'fav', label: '收藏' },
];

function matches(q: Question, filter: Filter): boolean {
  if (filter === 'all') return true;
  if (filter === 'unreviewed') return !q.reviewed;
  if (filter === 'low') return q.confidence < 0.6;
  if (filter === 'fav') return false;
  return !q.answer && q.answerBool === null;
}

/** 把已入库题目转成解析草稿形状，用于跨题库复制 */
function toParsed(q: Question): ParsedQuestion {
  return {
    key: `copy_${q.id}`,
    type: q.type,
    stem: q.stem,
    options: q.options,
    answer: q.answer,
    answerBool: q.answerBool,
    explanation: q.explanation,
    confidence: q.confidence,
    reviewed: q.reviewed,
    source: 'ai',
    subject: q.subject,
  };
}

export default function BankDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const insets = useSafeAreaInsets();
  const taskInset = useTaskInset();
  const t = useTheme();
  const c = t.palette;
  const { refreshBanks, beginAiTask, updateAiTask, finishAiTask, aiTask } = useApp();
  const ai = useAiStatus();

  const [bank, setBank] = useState<Bank | null>(null);
  const [questions, setQuestions] = useState<Question[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<Filter>('all');
  const [working, setWorking] = useState<'none' | 'export' | 'solve' | 'classify' | 'similar' | 'explain' | 'paper'>(
    'none',
  );
  /** 收藏 id 集合由 favoriteStore 维护，切收藏不写题表，因此不进 questions state */
  const { ids: favIds } = useFavorites();

  const fetchAll = useCallback(async () => {
    setLoading(true);
    try {
      const [b, list] = await Promise.all([getBank(id), listQuestions(id)]);
      setBank(b);
      setQuestions(list);
      // 星标状态独立于题目，从收藏表单独取；直接深链进本页时首页可能还没挂载过
      await loadFavoriteIds();
    } catch (error) {
      console.error('[bank] load failed:', error);
      dialog.alert('加载失败', '题库内容暂时读不出来，请稍后重试。');
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    fetchAll().catch((error) => console.error('[bank] initial fetch failed:', error));
  }, [fetchAll]);

  const counts = useMemo(
    () => ({
      total: questions.length,
      reviewed: questions.filter((q) => q.reviewed).length,
      low: questions.filter((q) => q.confidence < 0.6).length,
      noAnswer: questions.filter((q) => !q.answer && q.answerBool === null).length,
      noSubject: questions.filter((q) => !q.subject).length,
      noExplanation: questions.filter(needsExplanation).length,
      fav: questions.filter((q) => favIds.has(q.id)).length,
    }),
    [favIds, questions],
  );

  const visible = useMemo(
    () => (filter === 'fav' ? questions.filter((q) => favIds.has(q.id)) : questions.filter((q) => matches(q, filter))),
    [favIds, filter, questions],
  );

  const patch = useCallback(
    async (qid: string, p: Partial<Question>) => {
      setQuestions((prev) => prev.map((q) => (q.id === qid ? { ...q, ...p } : q)));
      try {
        const ok = await updateQuestion(qid, p);
        if (!ok) {
          dialog.alert('保存失败', '这道题的修改未能写入云端。');
          await fetchAll();
          return;
        }
        if (p.reviewed !== undefined) await refreshBanks();
      } catch (error) {
        console.error('[bank] updateQuestion failed:', error);
        dialog.alert('保存失败', '这道题的修改未能写入云端。');
      }
    },
    [fetchAll, refreshBanks],
  );

  const remove = useCallback(
    (qid: string) => {
      dialog.alert('删除这道题', '删除后无法恢复，确定继续吗？', [
        { text: '取消', style: 'cancel' },
        {
          text: '删除',
          style: 'destructive',
          onPress: async () => {
            try {
              const ok = await deleteQuestion(qid, id);
              if (!ok) {
                dialog.alert('删除失败', '请稍后重试。');
                return;
              }
              await fetchAll();
              await refreshBanks();
            } catch (error) {
              console.error('[bank] deleteQuestion failed:', error);
              dialog.alert('删除失败', '请稍后重试。');
            }
          },
        },
      ]);
    },
    [fetchAll, id, refreshBanks],
  );

  const onRename = useCallback(() => {
    dialog.prompt({
      title: '重命名题库',
      message: '输入新的题库名称，保存后立即同步到云端。',
      placeholder: '例如：中考数学模拟卷',
      defaultValue: bank?.name ?? '',
      maxLength: 30,
      emptyHint: '题库名称不能为空。',
      submitText: '保存',
      onSubmit: async (next) => {
        if (next === bank?.name) return;
        try {
          const ok = await renameBank(id, next);
          if (!ok) {
            dialog.alert('重命名失败', '新名称没能写入云端，请稍后重试。');
            return;
          }
          // 先本地改名再整库刷新：只等 fetchAll 会让标题慢半拍
          setBank((prev) => (prev ? { ...prev, name: next } : prev));
          await fetchAll();
          await refreshBanks();
        } catch (error) {
          console.error('[bank] rename failed:', error);
          dialog.alert('重命名失败', '新名称没能写入云端，请稍后重试。');
        }
      },
    });
  }, [bank?.name, fetchAll, id, refreshBanks]);

  /** 导出：选格式 → 生成文件 */
  const runExport = useCallback(
    async (format: ExportFormat) => {
      setWorking('export');
      try {
        const r = await buildExportFile(bank?.name ?? '题库', format, questions, true);
        if (!r.ok || !r.uri) {
          dialog.alert('导出失败', r.message);
          return;
        }
        dialog.alert('文件已生成', `${r.message}，可直接发送到微信、邮件或存到手机文件。`, [
          { text: '知道了' },
          {
            text: '立即分享',
            onPress: () => {
              shareFile(r.uri as string, format, bank?.name ?? '题库')
                .then((s) => {
                  if (!s.ok) dialog.alert('分享未完成', s.message);
                })
                .catch((error) => console.error('[bank] share failed:', error));
            },
          },
        ]);
      } catch (error) {
        console.error('[bank] export failed:', error);
        dialog.alert('导出失败', '生成文件时出现问题，请检查网络后重试。');
      } finally {
        setWorking('none');
      }
    },
    [bank?.name, questions],
  );

  const askFormat = useCallback(
    (mode: 'export' | 'share') => {
      if (questions.length === 0) {
        dialog.alert('暂无内容', '这个题库还没有题目。');
        return;
      }
      const buttons: { text: string; onPress?: () => void; style?: 'cancel' | 'destructive' }[] = (
        ['docx', 'doc', 'txt'] as ExportFormat[]
      ).map((f) => ({
        text: FORMAT_LABELS[f],
        onPress: () => {
          if (mode === 'export') {
            runExport(f).catch((error) => console.error('[bank] export failed:', error));
          } else {
            setWorking('export');
            exportAndShare(bank?.name ?? '题库', f, questions, true)
              .then((r) => {
                if (!r.ok) dialog.alert('分享未完成', r.message);
              })
              .catch((error) => console.error('[bank] share failed:', error))
              .finally(() => setWorking('none'));
          }
        },
      }));
      dialog.alert(
        mode === 'export' ? '导出题库' : '分享题库',
        `题库共 ${questions.length} 题，含答案与解析。选择一种格式：`,
        [...buttons, { text: '取消', style: 'cancel' }],
      );
    },
    [bank?.name, questions, runExport],
  );

  /** AI 自动作答补全缺失答案 */
  const runSolve = useCallback(async () => {
    if (!ai.aiUsable) {
      dialog.alert('暂时无法使用 AI', ai.online ? '请先在「设置 → AI 供应商」完成配置。' : '当前没有网络，联网后可让 AI 自动作答。');
      return;
    }
    const missing = questions.filter((q) => !q.answer && q.answerBool === null);
    if (missing.length === 0) {
      dialog.alert('无需补全', '这个题库的答案已经齐全。');
      return;
    }
    setWorking('solve');
    const taskId = beginAiTask('AI 自动作答（补全答案）', Math.ceil(missing.length / 12));
    let cancelled = false;
    try {
      const map = await solveMissingAnswers(
        questions,
        (p) => updateAiTask(taskId, { done: p.done, total: p.total, collected: p.solved }),
        () => cancelled,
      );
      if (map.size === 0) {
        finishAiTask(taskId, 'failed', 'AI 未能给出答案');
        dialog.alert('补全未完成', 'AI 没有返回可用答案，请稍后重试或手动填写。');
        return;
      }
      let updated = 0;
      for (const [qIndex, item] of map.entries()) {
        const target = questions[qIndex];
        if (!target) continue;
        const answer = target.type === 'tf' && item.answerBool !== null ? (item.answerBool ? '正确' : '错误') : item.answer;
        if (!answer && item.answerBool === null) continue;
        const ok = await updateQuestion(target.id, {
          answer,
          answerBool: target.type === 'tf' ? item.answerBool : null,
          explanation: item.explanation || target.explanation,
          confidence: item.confidence,
        });
        if (ok) updated += 1;
      }
      finishAiTask(taskId, 'done', `已补全 ${updated} 题答案`);
      await fetchAll();
      dialog.alert(
        'AI 已作答',
        `共补全 ${updated} 题答案，置信度已同步更新。AI 推断的答案建议抽查几题再开始刷题。`,
      );
    } catch (error) {
      console.error('[bank] solve failed:', error);
      finishAiTask(taskId, 'failed', '补全失败');
      dialog.alert('补全未完成', 'AI 请求中断，请稍后重试。');
    } finally {
      cancelled = true;
      setWorking('none');
    }
  }, [ai.aiUsable, ai.online, beginAiTask, fetchAll, finishAiTask, questions, updateAiTask]);

  /** AI 科目分类：只处理本题库里没有科目的题 */
  const runClassify = useCallback(async () => {
    if (!ai.aiUsable) {
      dialog.alert('暂时无法使用 AI', ai.online ? '请先在「设置 → AI 供应商」完成配置。' : '当前没有网络，联网后可让 AI 识别科目。');
      return;
    }
    const targets = questions.filter((q) => !q.subject);
    if (targets.length === 0) {
      dialog.alert('无需分类', '这个题库的题目都已有科目。');
      return;
    }
    setWorking('classify');
    const taskId = beginAiTask('AI 识别科目', Math.ceil(targets.length / 15));
    let cancelled = false;
    try {
      const n = await classifyBank(
        id,
        (p) => updateAiTask(taskId, { done: p.done, total: p.total, collected: p.classified }),
        () => cancelled,
      );
      finishAiTask(taskId, 'done', n > 0 ? `已识别 ${n} 题科目` : 'AI 未返回有效科目');
      await fetchAll();
    } catch (error) {
      console.error('[bank] classify failed:', error);
      finishAiTask(taskId, 'failed', '科目识别失败');
      dialog.alert('科目识别未完成', 'AI 请求中断，请稍后重试。');
    } finally {
      cancelled = true;
      setWorking('none');
    }
  }, [ai.aiUsable, ai.online, beginAiTask, fetchAll, finishAiTask, id, questions, updateAiTask]);

  /**
   * AI 批量补解析：只处理「有答案、缺解析」的题，与补答案互斥，
   * 且只写 explanation，不改答案与「答案待确认」状态 —— 补解析不该让一道题突然变成已核对。
   */
  const runExplain = useCallback(async () => {
    if (!ai.aiUsable) {
      dialog.alert('暂时无法使用 AI', ai.online ? '请先在「设置 → AI 供应商」完成配置。' : '当前没有网络，联网后可让 AI 补写解析。');
      return;
    }
    const targets = questions.filter(needsExplanation);
    if (targets.length === 0) {
      dialog.alert('无需补写', '这个题库里有答案的题目都已经带了说明。');
      return;
    }
    setWorking('explain');
    const taskId = beginAiTask('AI 补写解析', Math.ceil(targets.length / 8));
    let cancelled = false;
    try {
      const r = await explainBank(
        id,
        (p) => updateAiTask(taskId, { done: p.done, total: p.total, collected: p.collected }),
        () => cancelled,
      );
      if (r.written === 0) {
        finishAiTask(taskId, 'failed', 'AI 未能给出解析');
        dialog.alert('补写未完成', 'AI 没有返回可用解析，请稍后重试或手动填写。');
        return;
      }
      finishAiTask(taskId, 'done', `已补写 ${r.written} 题解析`);
      await fetchAll();
      dialog.alert(
        '解析已补写',
        r.doubts.length > 0
          ? `共补写 ${r.written} 题解析。其中 ${r.doubts.length} 题 AI 对原答案提出了疑点，建议点开这些题核对一下。`
          : `共补写 ${r.written} 题解析，答案未做任何改动。`,
      );
    } catch (error) {
      console.error('[bank] explain failed:', error);
      finishAiTask(taskId, 'failed', '补写解析失败');
      dialog.alert('补写未完成', 'AI 请求中断，请稍后重试。');
    } finally {
      cancelled = true;
      setWorking('none');
    }
  }, [ai.aiUsable, ai.online, beginAiTask, fetchAll, finishAiTask, id, questions, updateAiTask]);

  /** AI 出模拟卷：按本题库的题型与科目分布命题，单独存成一个新的 AI 题库 */
  const runPaper = useCallback(
    async (count: number) => {
      if (!ai.aiUsable) {
        dialog.alert('暂时无法使用 AI', ai.online ? '请先在「设置 → AI 供应商」完成配置。' : '当前没有网络，联网后可让 AI 出卷。');
        return;
      }
      if (questions.length === 0) {
        dialog.alert('暂无题目', '这个题库还没有题目，无法命题。');
        return;
      }
      setWorking('paper');
      const taskId = beginAiTask(`AI 出模拟卷（${count} 题）`, Math.ceil(count / 5));
      let cancelled = false;
      try {
        const result = await createMockPaper(
          id,
          bank?.name ?? '题库',
          count,
          (p) => updateAiTask(taskId, { done: p.done, total: p.total, collected: p.collected }),
          () => cancelled,
        );
        if (!result) throw new Error('题库写入失败');
        finishAiTask(taskId, 'done', `模拟卷 ${result.inserted} 题`);
        await refreshBanks();
        dialog.alert(
          '模拟卷已生成',
          result.inserted < result.expected
            ? `《${result.name}》共命题 ${result.expected} 题，实际写入 ${result.inserted} 题，还有 ${result.expected - result.inserted} 题没能存到云端，可重新出卷补齐。`
            : `《${result.name}》共 ${result.inserted} 题，已作为一个新题库保存。AI 命的答案标记为「答案待确认」，建议抽查。`,
          [
            { text: '知道了' },
            {
              text: '去刷题',
              onPress: () => router.push({ pathname: '/quiz', params: { id: result.bankId, name: result.name } }),
            },
          ],
        );
      } catch (error) {
        console.error('[bank] paper failed:', error);
        finishAiTask(taskId, 'failed', '出卷失败');
        dialog.alert('出卷未完成', 'AI 请求中断，请稍后重试。');
      } finally {
        cancelled = true;
        setWorking('none');
      }
    },
    [ai.aiUsable, ai.online, bank?.name, beginAiTask, createMockPaper, finishAiTask, id, questions.length, refreshBanks, updateAiTask],
  );

  const askPaper = useCallback(() => {
    if (working !== 'none') return;
    const buttons: { text: string; onPress?: () => void; style?: 'cancel' | 'destructive' }[] = PAPER_SIZES.map((n) => ({
      text: `${n} 题`,
      onPress: () => {
        runPaper(n).catch((error) => console.error('[bank] paper failed:', error));
      },
    }));
    dialog.alert(
      'AI 出模拟卷',
      '按本题库的题型与科目分布命题，生成一个独立的新题库（含答案与解析）。选择题量：',
      [...buttons, { text: '取消', style: 'cancel' }],
    );
  }, [runPaper, working]);

  /** 整库批量出类似题：跳到选题页（自动挑 5/10/20 题、手动勾选、或全部） */
  const openSimilarBatch = useCallback(() => {
    if (working !== 'none') return;
    if (questions.length === 0) {
      dialog.alert('暂无题目', '这个题库还没有题目，无法批量出题。');
      return;
    }
    router.push({ pathname: '/similar-batch', params: { id, name: bank?.name ?? '' } });
  }, [bank?.name, id, questions.length, working]);

  /**
   * AI 类似题三种落点：
   * append = 生成 1 题插到母题后面；bank = 生成 5 题新建类似题库；find = 从其他题库找现成相似题插到母题后面。
   * 落点用 numeric 排序号取「母题与下一题」的中点，一条 insert 完成定位，不重排整库。
   */
  const runSimilar = useCallback(
    async (q: Question, mode: 'append' | 'bank' | 'find') => {
      if (!ai.aiUsable) {
        dialog.alert('暂时无法使用 AI', ai.online ? '请先在「设置 → AI 供应商」完成配置。' : '当前没有网络，联网后可使用 AI 类似题。');
        return;
      }
      setWorking('similar');
      const label = mode === 'find' ? 'AI 查找相似题' : mode === 'append' ? 'AI 生成类似题（1 题）' : 'AI 生成类似题库（5 题）';
      const taskId = beginAiTask(label, 1);
      try {
        if (mode === 'find') {
          const pool = await listQuestionsFromOtherBanks(id, 200);
          if (pool.length === 0) {
            finishAiTask(taskId, 'cancelled', '其他题库暂无题目');
            dialog.alert('没有可用来源', '你的其他题库里还没有题目，可改用「AI 生成类似题」。');
            return;
          }
          const hits = await findSimilarQuestions(q, pool);
          if (hits.length === 0) {
            finishAiTask(taskId, 'cancelled', '未发现相似题');
            dialog.alert('没找到相似题', '其他题库里没有和这道题考同一知识点的题目，可改用「AI 生成类似题」。');
            return;
          }
          const picked = hits.map((i) => pool[i]).filter(Boolean).map(toParsed);
          const n = await insertQuestionsAfter(id, q.orderIndex, picked);
          if (n === 0) throw new Error('写入云端失败');
          finishAiTask(taskId, 'done', `已加入 ${n} 道相似题`);
          await fetchAll();
          await refreshBanks();
          dialog.alert('相似题已加入', `从其他题库找到 ${n} 道相似题，已插在这道母题后面。`);
          return;
        }
        const count = mode === 'append' ? 1 : 5;
        const list = await generateSimilarQuestions(q, count);
        updateAiTask(taskId, { done: 1, collected: list.length });
        if (list.length === 0) throw new Error('AI 未返回可用题目');
        if (mode === 'append') {
          const n = await insertQuestionsAfter(id, q.orderIndex, list);
          if (n === 0) throw new Error('写入云端失败');
          finishAiTask(taskId, 'done', `已生成 ${n} 题`);
          await fetchAll();
          await refreshBanks();
          dialog.alert('已生成类似题', `已把 ${n} 道类似题插在这道题后面。AI 生成的答案标记为「答案待确认」，建议抽查。`);
          return;
        }
        const newName = `${bank?.name ?? '题库'} · 类似题`.slice(0, 40);
        // 建库返回结果对象：null = 建库失败；inserted < expected = 部分题目未写入（云端计数已回读校正）
        const result = await createBankWithQuestions(newName, null, true, list);
        if (!result) throw new Error('题库写入失败');
        const newId = result.bankId;
        finishAiTask(taskId, 'done', `新题库 ${result.inserted} 题`);
        await refreshBanks();
        if (result.inserted < result.expected) {
          dialog.alert(
            '部分题目未入库',
            `《${newName}》共生成 ${result.expected} 题，实际写入 ${result.inserted} 题，还有 ${result.expected - result.inserted} 题没能存到云端，可重新生成补齐。`,
            [
              { text: '知道了' },
              { text: '去刷题', onPress: () => router.push({ pathname: '/quiz', params: { id: newId, name: newName } }) },
            ],
          );
          return;
        }
        dialog.alert('类似题题库已生成', `《${newName}》共 ${result.inserted} 题，AI 生成的答案标记为「答案待确认」。`, [
          { text: '知道了' },
          { text: '去刷题', onPress: () => router.push({ pathname: '/quiz', params: { id: newId, name: newName } }) },
        ]);
      } catch (error) {
        console.error('[bank] similar failed:', error);
        finishAiTask(taskId, 'failed', '类似题生成失败');
        dialog.alert('未完成', 'AI 请求中断，请稍后重试。');
      } finally {
        setWorking('none');
      }
    },
    [ai.aiUsable, ai.online, bank?.name, beginAiTask, fetchAll, finishAiTask, id, refreshBanks, updateAiTask],
  );

  const askSimilar = useCallback(
    (q: Question) => {
      if (working !== 'none') return;
      const brief = q.stem.replace(/\s+/g, ' ').slice(0, 28);
      dialog.alert('添加AI生成类似题', `以「${brief}…」为母题，选择一种方式：`, [
        {
          text: '生成 1 题 · 插在这题后面',
          onPress: () => {
            runSimilar(q, 'append').catch((e) => console.error('[bank] similar append failed:', e));
          },
        },
        {
          text: '生成 5 题 · 新建类似题库',
          onPress: () => {
            runSimilar(q, 'bank').catch((e) => console.error('[bank] similar bank failed:', e));
          },
        },
        {
          text: '从其他题库找相似题',
          onPress: () => {
            runSimilar(q, 'find').catch((e) => console.error('[bank] similar find failed:', e));
          },
        },
        { text: '取消', style: 'cancel' },
      ]);
    },
    [runSimilar, working],
  );

  const header = (
    <View>
      <Card style={{ marginBottom: 10 }}>
        <View style={styles.headRow}>
          <Text style={[styles.name, { color: c.text }]} numberOfLines={2}>
            {bank?.name ?? '题库'}
          </Text>
          <Pressable accessibilityRole="button" onPress={onRename} hitSlop={10}>
            <Text style={[styles.rename, { color: c.primary }]}>改名</Text>
          </Pressable>
        </View>
        <Text style={[styles.source, { color: c.textMuted }]}>
          {bank?.sourceFile ? `来源文件：${bank.sourceFile}` : '手动创建'}
        </Text>
        <View style={styles.tagRow}>
          {bank?.isAiBank ? <Tag label="含 AI 解析" tone="ai" /> : <Tag label="本地解析" tone="primary" />}
          <Tag label={`${counts.total} 题`} tone="neutral" />
          {counts.total - counts.reviewed > 0 ? (
            <Tag label={`${counts.total - counts.reviewed} 题答案待确认`} tone="warn" />
          ) : (
            counts.total > 0 && <Tag label="答案已全部确认" tone="success" />
          )}
        </View>
        <View style={styles.progressWrap}>
          <ProgressBar ratio={counts.total ? counts.reviewed / counts.total : 0} color={c.success} height={5} />
        </View>
        <Pressable
          accessibilityRole="button"
          onPress={() => router.push({ pathname: '/quiz', params: { id, name: bank?.name ?? '' } })}
          style={({ pressed }) => [
            styles.startBtn,
            { backgroundColor: c.primary, borderRadius: t.radius.md, opacity: pressed ? 0.9 : 1, ...t.shadow.card },
          ]}
        >
          <Text style={[styles.startText, { color: c.onPrimary }]}>开始刷题</Text>
        </Pressable>
      </Card>

      <QuotaHint />

      {/* 导出 / 分享 / AI 补答案 */}
      <View style={styles.toolRow}>
        <Pressable
          accessibilityRole="button"
          onPress={() => askFormat('export')}
          disabled={working !== 'none'}
          style={({ pressed }) => [
            styles.toolBtn,
            { backgroundColor: t.cardBg, borderColor: c.border, borderRadius: t.radius.md, opacity: pressed || working !== 'none' ? 0.8 : 1, ...t.shadow.card },
          ]}
        >
          <Text style={[styles.toolText, { color: c.text }]}>导出题库</Text>
          <Text style={[styles.toolSub, { color: c.textMuted }]}>docx · doc · txt</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          onPress={() => askFormat('share')}
          disabled={working !== 'none'}
          style={({ pressed }) => [
            styles.toolBtn,
            { backgroundColor: t.cardBg, borderColor: c.border, borderRadius: t.radius.md, opacity: pressed || working !== 'none' ? 0.8 : 1, ...t.shadow.card },
          ]}
        >
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
            <ShareIcon size={13} color={c.text} />
            <Text style={[styles.toolText, { color: c.text }]}>分享题库</Text>
          </View>
          <Text style={[styles.toolSub, { color: c.textMuted }]}>{working === 'export' ? '处理中…' : '发送文件给他人'}</Text>
        </Pressable>
      </View>

      {counts.noAnswer > 0 ? (
        <Pressable
          accessibilityRole="button"
          onPress={() => {
            runSolve().catch((error) => console.error('[bank] solve failed:', error));
          }}
          disabled={working !== 'none'}
          style={({ pressed }) => [
            styles.solveBtn,
            {
              borderColor: c.accent,
              backgroundColor: c.accentSoft,
              borderRadius: t.radius.md,
              opacity: pressed || working !== 'none' ? 0.85 : 1,
            },
          ]}
        >
          <SparkIcon size={15} color={c.accent} />
          <Text style={[styles.solveText, { color: c.accent }]}>
            {working === 'solve' ? 'AI 正在作答…' : `有 ${counts.noAnswer} 题缺答案 · 让 AI 自动作答`}
          </Text>
        </Pressable>
      ) : null}

      {counts.noSubject > 0 ? (
        <Pressable
          accessibilityRole="button"
          onPress={() => {
            runClassify().catch((error) => console.error('[bank] classify failed:', error));
          }}
          disabled={working !== 'none'}
          style={({ pressed }) => [
            styles.solveBtn,
            {
              borderColor: c.accent,
              backgroundColor: c.accentSoft,
              borderRadius: t.radius.md,
              opacity: pressed || working !== 'none' ? 0.85 : 1,
            },
          ]}
        >
          <SparkIcon size={15} color={c.accent} />
          <Text style={[styles.solveText, { color: c.accent }]}>
            {working === 'classify' ? 'AI 正在识别科目…' : `有 ${counts.noSubject} 题未识别科目 · AI 自动分类`}
          </Text>
        </Pressable>
      ) : null}

      {counts.noExplanation > 0 ? (
        <Pressable
          accessibilityRole="button"
          onPress={() => {
            runExplain().catch((error) => console.error('[bank] explain failed:', error));
          }}
          disabled={working !== 'none'}
          style={({ pressed }) => [
            styles.solveBtn,
            {
              borderColor: c.accent,
              backgroundColor: c.accentSoft,
              borderRadius: t.radius.md,
              opacity: pressed || working !== 'none' ? 0.85 : 1,
            },
          ]}
        >
          <SparkIcon size={15} color={c.accent} />
          <Text style={[styles.solveText, { color: c.accent }]}>
            {working === 'explain' ? 'AI 正在补写解析…' : `有 ${counts.noExplanation} 题缺解析 · AI 批量补写`}
          </Text>
        </Pressable>
      ) : null}

      {counts.total > 0 ? (
        <Pressable
          accessibilityRole="button"
          onPress={openSimilarBatch}
          style={({ pressed }) => [
            styles.solveBtn,
            {
              borderColor: c.accent,
              backgroundColor: c.accentSoft,
              borderRadius: t.radius.md,
              opacity: pressed ? 0.85 : 1,
            },
          ]}
        >
          <SparkIcon size={15} color={c.accent} />
          <Text style={[styles.solveText, { color: c.accent }]}>
            AI 批量出类似题 · 整库选题一次生成
          </Text>
        </Pressable>
      ) : null}

      {counts.total > 0 ? (
        <Pressable
          accessibilityRole="button"
          onPress={askPaper}
          disabled={working !== 'none'}
          style={({ pressed }) => [
            styles.solveBtn,
            {
              borderColor: c.accent,
              backgroundColor: c.accentSoft,
              borderRadius: t.radius.md,
              opacity: pressed || working !== 'none' ? 0.85 : 1,
            },
          ]}
        >
          <SparkIcon size={15} color={c.accent} />
          <Text style={[styles.solveText, { color: c.accent }]}>
            {working === 'paper' ? 'AI 正在命题…' : 'AI 出模拟卷 · 按本题库分布命题'}
          </Text>
        </Pressable>
      ) : null}

      <ForgettingCurveCard bankId={id} style={{ marginTop: 12 }} />

      <View style={styles.filterRow}>
        {FILTERS.map((f) => {
          const n =
            f.key === 'all'
              ? counts.total
              : f.key === 'unreviewed'
                ? counts.total - counts.reviewed
                : f.key === 'low'
                  ? counts.low
                  : f.key === 'fav'
                    ? counts.fav
                    : counts.noAnswer;
          return (
            <Pressable
              key={f.key}
              accessibilityRole="button"
              onPress={() => setFilter(f.key)}
              style={[
                styles.chip,
                {
                  backgroundColor: filter === f.key ? c.primary : t.cardBg,
                  borderColor: filter === f.key ? c.primary : c.border,
                  borderRadius: t.radius.pill,
                },
              ]}
            >
              <Text style={[styles.chipText, { color: filter === f.key ? c.onPrimary : c.textSub }]}>
                {f.label} {n}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );

  return (
    <View style={[styles.root, { paddingTop: insets.top + taskInset + 10 }]}>
      <View style={styles.nav}>
        <Pressable
          accessibilityRole="button"
          onPress={() => (router.canGoBack() ? router.back() : router.replace('/'))}
          hitSlop={12}
          style={styles.back}
        >
          <Text style={[styles.backText, { color: c.primary }]}>‹ 返回</Text>
        </Pressable>
        <Text style={[styles.navTitle, { color: c.text }]}>题库详情</Text>
        <Pressable accessibilityRole="button" onPress={() => fetchAll().catch((e) => console.error('[bank] refresh failed:', e))} hitSlop={10} style={styles.navRight}>
          <Text style={[styles.refresh, { color: c.primary }]}>刷新</Text>
        </Pressable>
      </View>

      {loading ? (
        <LoadingBlock label="正在载入题目…" />
      ) : (
        <FlatList
          data={visible}
          keyExtractor={(item) => item.id}
          ListHeaderComponent={header}
          ItemSeparatorComponent={() => <View style={{ height: 8 }} />}
          contentContainerStyle={styles.list}
          keyboardShouldPersistTaps="handled"
          ListEmptyComponent={
            <View style={styles.empty}>
              <Text style={[styles.emptyText, { color: c.textSub }]}>
                {questions.length === 0 ? '这个题库还没有题目。' : `当前筛选条件下没有题目（${typeLabels[visible[0]?.type ?? 'short']}）。`}
              </Text>
            </View>
          }
          renderItem={({ item, index }) => (
            <QuestionEditor
              value={item as unknown as EditableQuestion}
              order={item.orderIndex + 1 || index + 1}
              onSave={(p) => {
                patch(item.id, p as Partial<Question>).catch((e) => console.error('[bank] save failed:', e));
              }}
              onDelete={() => remove(item.id)}
              onToggleReview={() => {
                patch(item.id, { reviewed: !item.reviewed }).catch((e) => console.error('[bank] toggle review failed:', e));
              }}
              onSimilar={() => askSimilar(item)}
              favorite={favIds.has(item.id)}
              onToggleFavorite={() => {
                toggleFavorite(item)
                  .then((ok) => {
                    if (ok === null) dialog.alert('收藏未同步', '这条收藏改动没能写入云端，请检查网络后重试。');
                  })
                  .catch((e) => console.error('[bank] toggleFavorite failed:', e));
              }}
            />
          )}
        />
      )}
      {aiTask && aiTask.status === 'running' && working === 'solve' ? null : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  nav: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, marginBottom: 8 },
  back: { width: 64 },
  backText: { fontSize: 15, fontWeight: '600' },
  navTitle: { flex: 1, textAlign: 'center', fontSize: 16, fontWeight: '700' },
  navRight: { width: 64, alignItems: 'flex-end' },
  refresh: { fontSize: 13, fontWeight: '600' },
  list: { paddingHorizontal: 16, paddingBottom: 30 },
  headRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 12 },
  name: { flex: 1, fontSize: 17.5, fontWeight: '800', lineHeight: 24 },
  rename: { fontSize: 13, fontWeight: '600', paddingTop: 2 },
  source: { fontSize: 12, marginTop: 4 },
  tagRow: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', marginTop: 12, gap: 4 },
  progressWrap: { marginTop: 12 },
  startBtn: { height: 46, alignItems: 'center', justifyContent: 'center', marginTop: 14 },
  startText: { fontSize: 15, fontWeight: '700' },
  toolRow: { flexDirection: 'row', gap: 10 },
  toolBtn: { flex: 1, borderWidth: 1, paddingVertical: 11, paddingHorizontal: 12, gap: 3 },
  toolText: { fontSize: 13.5, fontWeight: '700' },
  toolSub: { fontSize: 11 },
  solveBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, height: 44, borderWidth: 1.4, marginTop: 10 },
  solveText: { fontSize: 13, fontWeight: '700' },
  filterRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 16, marginBottom: 12 },
  chip: { paddingHorizontal: 12, paddingVertical: 5, borderWidth: 1 },
  chipText: { fontSize: 12, fontWeight: '600' },
  empty: { paddingVertical: 30, alignItems: 'center' },
  emptyText: { fontSize: 13.5 },
});
