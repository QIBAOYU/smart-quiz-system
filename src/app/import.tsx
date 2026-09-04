/**
 * 导入解析流程页。
 *
 * - 本地解析先出结果，再询问是否 AI 辅助；取消后当前视图仍保留【AI辅助解析】按钮可二次触发
 * - 识别到「只有题干没有答案」时，额外询问是否让 AI 自动做题补全答案
 * - AI 进度顶格固定显示（AiTaskLayer），页面通过 useTaskInset 让位，正文可继续滚动
 * - 逐题确认答案开关 + 筛选（答案待确认 / 低置信 / 缺答案）
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import * as DocumentPicker from 'expo-document-picker';
import * as ImagePicker from 'expo-image-picker';
import { dialog } from '../components/dialog';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import type { Theme } from '../constants/theme';
import { useTheme } from '../store/ThemeContext';
import { QuestionEditor, type EditableQuestion } from '../components/QuestionEditor';
import { DocIcon, SparkIcon, UploadIcon } from '../components/icons';
import { Card, ProgressBar, Tag } from '../components/ui';
import { useTaskInset } from '../components/AiTaskLayer';
import { useApp } from '../store/AppContext';
import { useAiStatus } from '../services/aiConfig';
import {
  cancelAiSolve,
  ingestFile,
  ingestImages,
  markSaved,
  resetDraft,
  setQuestions,
  startAiParse,
  startAiSolve,
  useDraft,
} from '../store/importStore';
import { createBankWithQuestions } from '../services/quizStore';
import { classifyBank } from '../services/subjectService';
import type { ParsedQuestion } from '../types/quiz';

type Filter = 'all' | 'unreviewed' | 'low' | 'noanswer';

/** 相册/相机返回的图片资产，只取识图需要的字段 */
type PickedImage = {
  uri: string;
  width: number;
  height: number;
  fileName?: string | null;
  mimeType?: string | null;
};

/** 一次最多识几张图：每张都是一次独立的视觉模型调用，太多会排队很久 */
const MAX_IMAGES = 6;

/** 常见图片扩展名：「选择文件」入口放行了 */
const IMAGE_EXT = /\.(jpe?g|png|webp|bmp|heic|heif)$/i;

/**
 * 判断选中的是不是图片。
 * 「选择文件」的 type 里带通配符，用户完全可能从文件管理器里挑一张试卷照片进来；
 * 这种图片若走文本管道，JPEG/PNG 二进制会被 GBK 兜底解码成一堆乱码"题目"，
 * 所以必须在入口就分流到识图链路。
 */
function isImageAsset(name: string, mime?: string | null): boolean {
  if (mime && /^image\//i.test(mime)) return true;
  return IMAGE_EXT.test(name || '');
}

const FILTERS: Array<{ key: Filter; label: string }> = [
  { key: 'all', label: '全部' },
  { key: 'unreviewed', label: '答案待确认' },
  { key: 'low', label: '低置信' },
  { key: 'noanswer', label: '缺答案' },
];

function matches(q: ParsedQuestion, filter: Filter): boolean {
  if (filter === 'all') return true;
  if (filter === 'unreviewed') return !q.reviewed;
  if (filter === 'low') return q.confidence < 0.6;
  return !q.answer && q.answerBool === null;
}

function nameFromFile(file: string): string {
  return file.replace(/\.[^.]+$/, '').replace(/[_\-.]/g, ' ').trim().slice(0, 40) || '未命名题库';
}

export default function ImportScreen() {
  const { theme: t } = { theme: useTheme() };
  const styles = useMemo(() => buildStyles(t), [t]);
  const insets = useSafeAreaInsets();
  const taskInset = useTaskInset();
  const draft = useDraft();
  const ai = useAiStatus();
  const { beginAiTask, updateAiTask, finishAiTask, refreshBanks, aiTask } = useApp();
  const [filter, setFilter] = useState<Filter>('all');
  const [bankName, setBankName] = useState('');
  const [saving, setSaving] = useState(false);

  const busy = draft.phase === 'extracting' || draft.phase === 'running';
  const hasFile = draft.fileName.length > 0;
  const aiRunning = aiTask?.status === 'running';

  const counts = useMemo(() => {
    const list = draft.questions;
    return {
      total: list.length,
      reviewed: list.filter((q) => q.reviewed).length,
      low: list.filter((q) => q.confidence < 0.6).length,
      noAnswer: list.filter((q) => !q.answer && q.answerBool === null).length,
    };
  }, [draft.questions]);

  const visible = useMemo(
    () => draft.questions.filter((q) => matches(q, filter)),
    [draft.questions, filter],
  );

  const taskApi = useMemo(
    () => ({
      begin: (label: string, total: number) => beginAiTask(label, total),
      update: (id: string, patch: { done?: number; total?: number; collected?: number }) => updateAiTask(id, patch),
      finish: (id: string, status: 'done' | 'failed' | 'cancelled', message?: string) => finishAiTask(id, status, message),
    }),
    [beginAiTask, updateAiTask, finishAiTask],
  );

  const runSolve = useCallback(() => {
    if (!ai.aiUsable) {
      dialog.alert('暂时无法使用 AI', '当前处于纯本地模式。请到「AI 与解析」里确认网络或配置供应商后再让 AI 自动作答。', [
        { text: '去配置', onPress: () => router.push('/ai-config') },
        { text: '稍后再说', style: 'cancel' },
      ]);
      return;
    }
    startAiSolve(taskApi).catch((error) => console.error('[import] solve failed:', error));
  }, [ai.aiUsable, taskApi]);

  const runParse = useCallback(() => {
    startAiParse(draft.text, taskApi).catch((error) => console.error('[import] ai failed:', error));
  }, [draft.text, taskApi]);

  /** 图片识题：压缩与视觉模型调用都在 ingestImages 里，这里只负责取图和反馈 */
  const runImages = useCallback(
    async (assets: PickedImage[]) => {
      const list = assets.slice(0, MAX_IMAGES);
      setBankName(list.length === 1 ? nameFromFile(list[0].fileName || '图片题库') : '图片题库');
      const r = await ingestImages(list, taskApi);
      if (!r.ok) {
        dialog.alert('识图失败', r.error || 'AI 未能从图片中识别出题目，请换一张更清晰的图片再试。');
      }
    },
    [taskApi],
  );

  const pick = useCallback(async () => {
    try {
      const result = await DocumentPicker.getDocumentAsync({
        type: ['application/pdf', 'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'text/plain', '*/*'],
        copyToCacheDirectory: true,
        multiple: false,
      });
      if (result.canceled || !result.assets || result.assets.length === 0) return;
      const asset = result.assets[0];
      // 文件入口选中的可能是图片：文本管道会把 JPEG/PNG 二进制解码成乱码"题目"，
      // 这里按 mime / 扩展名分流到识图链路，与拍照、相册入口走同一条路。
      if (isImageAsset(asset.name, asset.mimeType)) {
        console.log('[import] 文件入口选中图片，分流到识图:', asset.name, asset.mimeType ?? '');
        await runImages([{ uri: asset.uri, width: 0, height: 0, fileName: asset.name, mimeType: asset.mimeType }]);
        return;
      }
      const r = await ingestFile({ name: asset.name, uri: asset.uri, mimeType: asset.mimeType });
      setBankName(nameFromFile(asset.name));
      if (!r.ok) {
        dialog.alert('解析失败', r.error || '无法从该文件提取题目，请换一个文件试试。');
        return;
      }
      if (r.count === 0) {
        dialog.alert('未识别到题目', '文件文本已提取成功，但本地规则未能识别出题目的编号与选项结构。可以试试 AI 辅助解析。');
        return;
      }
    } catch (error) {
      console.error('[import] pick failed:', error);
      dialog.alert('操作失败', '选择文件时出现问题，请确认文件未被其他应用占用。');
    }
  }, [runImages]);

  const pickFromLibrary = useCallback(async () => {
    try {
      const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!perm.granted) {
        dialog.alert('需要相册权限', '请在系统设置里允许本应用访问相册/照片后再试。');
        return;
      }
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images'],
        allowsMultipleSelection: true,
        selectionLimit: MAX_IMAGES,
        orderedSelection: true,
        quality: 1,
      });
      if (result.canceled || !result.assets || result.assets.length === 0) return;
      console.log('[import] 相册选中', result.assets.length, '张图片，开始识图');
      await runImages(result.assets);
    } catch (error) {
      console.error('[import] pick image failed:', error);
      dialog.alert('操作失败', '选择图片时出现问题，请重试。');
    }
  }, [runImages]);

  const pickFromCamera = useCallback(async () => {
    try {
      const perm = await ImagePicker.requestCameraPermissionsAsync();
      if (!perm.granted) {
        dialog.alert('需要相机权限', '请在系统设置里允许本应用使用相机后再试。');
        return;
      }
      const result = await ImagePicker.launchCameraAsync({ mediaTypes: ['images'], quality: 1 });
      if (result.canceled || !result.assets || result.assets.length === 0) return;
      console.log('[import] 拍照完成，开始识图');
      await runImages(result.assets);
    } catch (error) {
      console.error('[import] camera failed:', error);
      dialog.alert('操作失败', '拍照时出现问题，请重试或改从相册选择。');
    }
  }, [runImages]);

  const pickImage = useCallback(() => {
    dialog.alert('图片识题', '把试卷、习题截图或拍照上传，AI 会直接读出题目与答案。一次最多 6 张，逐张识别。', [
      {
        text: '拍照',
        onPress: () => {
          pickFromCamera().catch((error) => console.error('[import] camera entry failed:', error));
        },
      },
      {
        text: '从相册选择',
        onPress: () => {
          pickFromLibrary().catch((error) => console.error('[import] library entry failed:', error));
        },
      },
      { text: '取消', style: 'cancel' },
    ]);
  }, [pickFromCamera, pickFromLibrary]);

  // 本地解析成功后询问：缺答案优先问「让 AI 自动作答」，否则问「AI 辅助解析」
  const [asked, setAsked] = useState(false);
  useEffect(() => {
    if (draft.phase === 'ready' && !asked && draft.questions.length > 0) {
      setAsked(true);
      // 图片识题的结果已经由视觉模型连题带答案一起给出，没有文本可供二次解析，不再追问
      if (draft.fromImage) return;
      const missing = draft.questions.filter((q) => !q.answer && q.answerBool === null).length;
      if (missing > 0) {
        dialog.alert(
          `识别到 ${missing} 题只有题干、没有答案`,
          `本地已识别 ${draft.questions.length} 题，其中 ${missing} 题缺答案。可以让 AI 按题型逐批作答并补上解析，结果会标为「AI 推断」，你仍可逐题确认或修改。`,
          [
            { text: '让 AI 自动作答', onPress: runSolve },
            { text: 'AI 辅助解析', onPress: runParse },
            { text: '自己逐题填写', style: 'cancel' },
          ],
        );
        return;
      }
      dialog.alert(
        'AI连接已就绪，是否辅助解析题库',
        `本地已识别 ${draft.questions.length} 题。AI 会逐段重新识别复杂排版并与本地结果去重合并；解析在后台进行，你可以继续校对，也可以随时收起进度条。`,
        [
          { text: 'AI辅助解析', onPress: runParse },
          { text: '先用本地结果', style: 'cancel' },
        ],
      );
    }
    if (draft.phase === 'empty') setAsked(false);
  }, [asked, draft.fromImage, draft.phase, draft.questions, runParse, runSolve]);

  const patchQuestion = useCallback(
    (key: string, p: Partial<ParsedQuestion>) => {
      setQuestions(draft.questions.map((q) => (q.key === key ? { ...q, ...p } : q)));
    },
    [draft.questions],
  );

  const removeQuestion = useCallback(
    (key: string) => {
      dialog.alert('删除这道题', '该题将从本次导入中移除，不影响原始文件。', [
        { text: '取消', style: 'cancel' },
        { text: '删除', style: 'destructive', onPress: () => setQuestions(draft.questions.filter((q) => q.key !== key)) },
      ]);
    },
    [draft.questions],
  );

  const markAllReviewed = useCallback(() => {
    const target = visible.map((q) => q.key);
    setQuestions(draft.questions.map((q) => (target.includes(q.key) ? { ...q, reviewed: !q.reviewed } : q)));
  }, [draft.questions, visible]);

  const doSave = useCallback(async (): Promise<string | null> => {
    if (draft.questions.length === 0) {
      dialog.alert('没有可保存的题目', '请先导入资料并识别出题目。');
      return null;
    }
    const name = (bankName.trim() || nameFromFile(draft.fileName)).slice(0, 40);
    setSaving(true);
    try {
      // 建库写题：null = 建库失败；inserted < expected = 部分题目未落库（云端计数已回读校正）
      const result = await createBankWithQuestions(
        name,
        draft.fileName || null,
        draft.aiQuestions.length > 0,
        draft.questions,
      );
      if (!result) {
        dialog.alert('保存失败', '题库没能创建成功，请检查网络后重试。');
        return null;
      }
      const id = result.bankId;
      if (result.inserted < result.expected) {
        dialog.alert(
          '部分题目未入库',
          `共 ${result.expected} 题，已入库 ${result.inserted} 题，有 ${result.expected - result.inserted} 题没能写入云端。可在本页重新导入补齐。`,
        );
      }
      markSaved(id);
      await refreshBanks();
      // 入库成功后自动跑一轮科目分类：任务挂在全局队列上，退出导入页进度条依然可见
      const taskId = beginAiTask('AI 识别科目（新题库）', Math.ceil(draft.questions.length / 15));
      classifyBank(id, (p) => updateAiTask(taskId, { done: p.done, total: p.total, collected: p.classified }), () => false)
        .then((n) => finishAiTask(taskId, 'done', n > 0 ? `已识别 ${n} 题科目` : 'AI 未返回科目'))
        .catch((error) => {
          console.error('[import] auto classify failed:', error);
          finishAiTask(taskId, 'failed', '科目识别失败，可在题库页重试');
        });
      return id;
    } catch (error) {
      console.error('[import] save failed:', error);
      dialog.alert('保存失败', '题库写入云端时出现问题，请检查网络后重试。');
      return null;
    } finally {
      setSaving(false);
    }
  }, [bankName, beginAiTask, draft.aiQuestions.length, draft.fileName, draft.questions, finishAiTask, refreshBanks, updateAiTask]);

  const onSave = useCallback(async () => {
    const id = await doSave();
    if (id) dialog.alert('已保存到云端', '题库已生成，可继续校对或直接进入刷题。');
  }, [doSave]);

  const onEnterQuiz = useCallback(async () => {
    let id = draft.savedBankId;
    if (!id) id = await doSave();
    if (!id) return;
    const name = bankName.trim() || nameFromFile(draft.fileName);
    router.replace({ pathname: '/quiz', params: { id, name } });
  }, [bankName, doSave, draft.fileName, draft.savedBankId]);

  const onReselect = useCallback(() => {
    if (draft.fromImage) {
      resetDraft();
      setBankName('');
      setAsked(false);
      pickImage();
      return;
    }
    const go = async () => {
      resetDraft();
      setBankName('');
      setAsked(false);
      await pick();
    };
    go().catch((error) => console.error('[import] reselect failed:', error));
  }, [draft.fromImage, pick, pickImage]);

  const header = (
    <View>
      <Card style={styles.fileCard}>
        <View style={styles.fileIcon}>
          <DocIcon size={22} color={t.palette.primary} />
        </View>
        <View style={styles.fileText}>
          <Text style={styles.fileName} numberOfLines={1}>
            {hasFile ? draft.fileName : '尚未选择文件'}
          </Text>
          <Text style={styles.fileMeta} numberOfLines={2}>
            {hasFile
              ? draft.fromImage
                ? draft.phase === 'extracting'
                  ? 'AI 正在识别图片中的题目…'
                  : `AI 识图 · 已识别 ${draft.questions.length} 题（含答案与解析）`
                : draft.stats
                  ? `提取 ${draft.stats.lines} 行 · 识别 ${draft.stats.blocks} 个题块 · ${draft.stats.answered} 题带答案`
                  : '正在提取文本…'
              : '支持 PDF / Word / 纯文本试卷，也可直接上传题目图片'}
          </Text>
        </View>
        <Pressable accessibilityRole="button" onPress={onReselect} style={({ pressed }) => [styles.reselect, pressed ? styles.pressed : null]}>
          <UploadIcon size={14} color={t.palette.onPrimary} />
          <Text style={styles.reselectText}>
            {hasFile ? (draft.fromImage ? '换图片' : '换文件') : '选择文件'}
          </Text>
        </Pressable>
      </Card>

      <Pressable
        accessibilityRole="button"
        onPress={pickImage}
        disabled={busy}
        style={({ pressed }) => [styles.imageCta, pressed ? styles.pressed : null, busy ? styles.disabled : null]}
      >
        <SparkIcon size={15} color={t.palette.accent} />
        <Text style={styles.imageCtaText}>拍照 / 相册识题 · 图片直接出题目和答案</Text>
      </Pressable>

      {busy ? (
        <View style={styles.busyRow}>
          <ActivityIndicator size="small" color={t.palette.primary} />
          <Text style={styles.busyText}>
            {draft.phase === 'extracting'
              ? draft.fromImage
                ? 'AI 正在识别图片中的题目，一张大约十几秒…'
                : '正在提取文档文本…'
              : 'AI 正在后台逐段解析，你可以继续校对当前题目'}
          </Text>
        </View>
      ) : null}

      {draft.message ? (
        <View style={styles.aiResultRow}>
          <SparkIcon size={14} color={t.palette.accent} />
          <Text style={styles.aiResultText}>{draft.message}</Text>
        </View>
      ) : null}

      {hasFile && draft.text.length > 0 ? (
        <View style={styles.toolRow}>
          {counts.noAnswer > 0 ? (
            <Pressable
              accessibilityRole="button"
              disabled={draft.solving}
              onPress={runSolve}
              style={({ pressed }) => [styles.solveBtn, pressed ? styles.pressed : null, draft.solving ? styles.disabled : null]}
            >
              <SparkIcon size={15} color={t.palette.onPrimary} />
              <Text style={styles.solveBtnText}>
                {draft.solving ? 'AI 正在作答…' : `让 AI 补全 ${counts.noAnswer} 题答案`}
              </Text>
            </Pressable>
          ) : null}
          {!aiRunning && draft.phase !== 'running' ? (
            <Pressable
              accessibilityRole="button"
              onPress={runParse}
              style={({ pressed }) => [styles.aiBtn, pressed ? styles.pressed : null]}
            >
              <SparkIcon size={15} color={t.palette.accent} />
              <Text style={styles.aiBtnText}>
                {draft.aiQuestions.length > 0 ? '再次 AI 辅助解析' : 'AI 辅助解析'}
              </Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}

      {draft.solving ? (
        <View style={styles.solveHint}>
          <ProgressBar ratio={0.15} />
          <Text style={styles.solveHintText}>AI 自动作答在后台进行，退回首页也不会中断。</Text>
        </View>
      ) : null}

      {draft.questions.length > 0 ? (
        <>
          <Text style={styles.nameLabel}>题库名称</Text>
          <TextInput
            style={styles.nameInput}
            value={bankName}
            onChangeText={setBankName}
            placeholder={nameFromFile(draft.fileName)}
            placeholderTextColor={t.palette.textMuted}
            maxLength={40}
          />

          <View style={styles.statRow}>
            <View style={styles.stat}>
              <Text style={styles.statValue}>{counts.total}</Text>
              <Text style={styles.statLabel}>题目</Text>
            </View>
            <View style={styles.stat}>
              <Text style={[styles.statValue, { color: t.palette.success }]}>{counts.reviewed}</Text>
              <Text style={styles.statLabel}>答案已确认</Text>
            </View>
            <View style={styles.stat}>
              <Text style={[styles.statValue, { color: t.palette.warn }]}>{counts.low}</Text>
              <Text style={styles.statLabel}>低置信</Text>
            </View>
            <View style={styles.stat}>
              <Text style={[styles.statValue, { color: t.palette.danger }]}>{counts.noAnswer}</Text>
              <Text style={styles.statLabel}>缺答案</Text>
            </View>
          </View>

          <View style={styles.filterRow}>
            {FILTERS.map((f) => (
              <Pressable
                key={f.key}
                accessibilityRole="button"
                onPress={() => setFilter(f.key)}
                style={[styles.filterChip, filter === f.key ? styles.filterChipOn : null]}
              >
                <Text style={[styles.filterText, filter === f.key ? styles.filterTextOn : null]}>{f.label}</Text>
              </Pressable>
            ))}
          </View>
          <View style={styles.reviewRow}>
            <Text style={styles.reviewRowLabel}>
              {filter === 'all' ? '当前显示全部题目' : `仅显示「${FILTERS.find((f) => f.key === filter)?.label ?? ''}」的题目`}
            </Text>
            <View style={styles.flex} />
            <Pressable accessibilityRole="button" onPress={markAllReviewed} hitSlop={8} style={styles.markAll}>
              <Text style={styles.markAllText}>批量切换答案确认</Text>
            </Pressable>
          </View>
        </>
      ) : null}
    </View>
  );

  const empty = !hasFile ? (
    <View style={styles.empty}>
      <Text style={styles.emptyTitle}>导入一份资料，自动生成题库</Text>
      <Text style={styles.emptyDesc}>
        支持试卷、复习提纲、知识点总结，也支持直接上传题目图片。文档先按题号、选项、答案标记做本地识别；图片交给 AI 视觉模型，连题带答案一次读出。
      </Text>
      <Pressable accessibilityRole="button" onPress={pick} style={({ pressed }) => [styles.bigCta, pressed ? styles.pressed : null]}>
        <UploadIcon size={18} color={t.palette.onPrimary} />
        <Text style={styles.bigCtaText}>选择文件</Text>
      </Pressable>
    </View>
  ) : (
    <View style={styles.empty}>
      <Text style={styles.emptyTitle}>
        {draft.phase === 'extracting'
          ? draft.fromImage
            ? 'AI 正在识图…'
            : '正在提取文本…'
          : '未识别到题目'}
      </Text>
      <Text style={styles.emptyDesc}>
        {draft.phase === 'extracting'
          ? draft.fromImage
            ? '一张图大约需要十几秒，识别完成后会自动列出题目。'
            : '大文件可能需要十几秒，请稍候。'
          : draft.fromImage
            ? '这张图片里可能没有清晰完整的题目。可以点上方【换图片】重拍，或换一张更清晰的截图。'
            : '这份资料的排版可能不带标准题号。可以点上方【换文件】换一份，或让 AI 逐段辅助解析。'}
      </Text>
    </View>
  );

  return (
    <View style={[styles.root, { paddingTop: insets.top + taskInset + t.spacing.md }]}>
      <View style={styles.nav}>
        <Pressable
          accessibilityRole="button"
          onPress={() => (router.canGoBack() ? router.back() : router.replace('/'))}
          hitSlop={12}
          style={styles.back}
        >
          <Text style={styles.backText}>‹ 返回</Text>
        </Pressable>
        <Text style={styles.navTitle}>导入题库</Text>
        <View style={styles.navRight}>
          <Tag label={ai.label} tone={ai.aiUsable ? 'ai' : 'neutral'} />
        </View>
      </View>

      <FlatList
        data={visible}
        keyExtractor={(item) => item.key}
        ListHeaderComponent={header}
        keyboardShouldPersistTaps="handled"
        ItemSeparatorComponent={() => <View style={{ height: t.spacing.sm }} />}
        contentContainerStyle={styles.list}
        ListEmptyComponent={empty}
        ListFooterComponent={
          draft.solving ? (
            <Pressable accessibilityRole="button" onPress={cancelAiSolve} style={styles.cancelSolve}>
              <Text style={styles.cancelSolveText}>取消 AI 自动作答</Text>
            </Pressable>
          ) : (
            <View style={{ height: 140 }} />
          )
        }
        renderItem={({ item, index }) => (
          <QuestionEditor
            value={item as unknown as EditableQuestion}
            order={draft.questions.indexOf(item) + 1 || index + 1}
            onSave={(p) => patchQuestion(item.key, p)}
            onDelete={() => removeQuestion(item.key)}
            onToggleReview={() => patchQuestion(item.key, { reviewed: !item.reviewed })}
          />
        )}
      />

      {draft.questions.length > 0 ? (
        <View style={[styles.bottomBar, { paddingBottom: insets.bottom + t.spacing.sm }]}>
          <View style={styles.bottomHead}>
            <Text style={styles.bottomMeta}>
              {counts.total} 题 · 答案已确认 {counts.reviewed}
            </Text>
            <Tag
              label={counts.reviewed === counts.total ? '全部已确认' : `${counts.total - counts.reviewed} 题待确认`}
              tone={counts.reviewed === counts.total ? 'success' : 'warn'}
            />
          </View>
          <View style={styles.bottomActions}>
            <Pressable
              accessibilityRole="button"
              onPress={onEnterQuiz}
              disabled={saving}
              style={({ pressed }) => [styles.quizBtn, pressed ? styles.quizBtnPressed : null]}
            >
              <Text style={styles.quizText}>进入刷题</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              onPress={onSave}
              disabled={saving}
              style={({ pressed }) => [styles.saveBtn, pressed ? styles.pressed : null, saving ? styles.disabled : null]}
            >
              {saving ? <ActivityIndicator color={t.palette.onPrimary} /> : <Text style={styles.saveText}>保存题库</Text>}
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
    root: { flex: 1, backgroundColor: c.bg },
    nav: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: sp.lg, marginBottom: sp.sm },
    back: { width: 64 },
    backText: { fontSize: 15, color: c.primary, fontWeight: '600' },
    navTitle: { flex: 1, textAlign: 'center', fontSize: 16, fontWeight: '700', color: c.text },
    navRight: { width: 64, alignItems: 'flex-end' },
    list: { paddingHorizontal: sp.lg, paddingBottom: sp.xxl },
    fileCard: { flexDirection: 'row', alignItems: 'center', gap: sp.md },
    fileIcon: {
      width: 38,
      height: 38,
      borderRadius: r.md,
      backgroundColor: c.primarySoft,
      alignItems: 'center',
      justifyContent: 'center',
    },
    fileText: { flex: 1 },
    fileName: { fontSize: 14, fontWeight: '700', color: c.text },
    fileMeta: { fontSize: 11.5, color: c.textMuted, marginTop: 2 },
    reselect: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 4,
      backgroundColor: c.primary,
      borderRadius: r.pill,
      paddingHorizontal: sp.md,
      height: 32,
    },
    reselectText: { color: c.onPrimary, fontSize: 12, fontWeight: '700' },
    imageCta: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 6,
      marginTop: sp.sm,
      height: 42,
      borderRadius: r.md,
      borderWidth: 1.5,
      borderStyle: 'dashed',
      borderColor: c.accent,
      backgroundColor: c.accentSoft,
    },
    imageCtaText: { fontSize: 12.5, fontWeight: '700', color: c.accent },
    busyRow: { flexDirection: 'row', alignItems: 'center', gap: sp.sm, marginTop: sp.md, paddingHorizontal: sp.xs },
    busyText: { fontSize: 12.5, color: c.textSub, flex: 1 },
    aiResultRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: sp.sm,
      marginTop: sp.md,
      backgroundColor: c.accentSoft,
      borderRadius: r.md,
      padding: sp.md,
    },
    aiResultText: { flex: 1, fontSize: 12.5, color: c.accent },
    toolRow: { flexDirection: 'row', gap: sp.sm, marginTop: sp.md },
    solveBtn: {
      flex: 1,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 6,
      height: 44,
      borderRadius: r.md,
      backgroundColor: c.primary,
      ...t.shadow.raised,
    },
    solveBtnText: { fontSize: 13, fontWeight: '700', color: c.onPrimary },
    aiBtn: {
      flex: 1,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 6,
      height: 44,
      borderRadius: r.md,
      borderWidth: 1.5,
      borderStyle: 'dashed',
      borderColor: c.accent,
      backgroundColor: c.accentSoft,
    },
    aiBtnText: { fontSize: 13, fontWeight: '700', color: c.accent },
    solveHint: { marginTop: sp.sm, gap: 6 },
    solveHintText: { fontSize: 11.5, color: c.textMuted },
    cancelSolve: { alignItems: 'center', paddingVertical: sp.md },
    cancelSolveText: { fontSize: 12.5, color: c.danger, fontWeight: '600' },
    nameLabel: { fontSize: 12, color: c.textMuted, fontWeight: '600', marginTop: sp.lg, marginBottom: sp.xs },
    nameInput: {
      backgroundColor: c.surface,
      borderRadius: r.md,
      borderWidth: t.borderWidth,
      borderColor: c.border,
      paddingHorizontal: sp.md,
      height: 44,
      fontSize: 14.5,
      color: c.text,
    },
    statRow: {
      flexDirection: 'row',
      marginTop: sp.md,
      backgroundColor: c.surfaceAlt,
      borderRadius: r.md,
      borderWidth: t.borderWidth,
      borderColor: c.border,
      paddingVertical: sp.sm,
    },
    stat: { flex: 1, alignItems: 'center' },
    statValue: { fontSize: 16, fontWeight: '800', color: c.text },
    statLabel: { fontSize: 10.5, color: c.textMuted, marginTop: 1 },
    filterRow: { flexDirection: 'row', alignItems: 'center', gap: sp.sm, marginTop: sp.lg },
    reviewRow: { flexDirection: 'row', alignItems: 'center', marginTop: sp.sm },
    reviewRowLabel: { fontSize: 11.5, color: c.textMuted },
    flex: { flex: 1 },
    markAll: { paddingHorizontal: sp.sm, paddingVertical: 3 },
    markAllText: { fontSize: 12, color: c.primary, fontWeight: '600' },
    filterChip: {
      paddingHorizontal: sp.md,
      paddingVertical: 5,
      borderRadius: r.pill,
      borderWidth: t.borderWidth,
      borderColor: c.border,
      backgroundColor: c.surface,
    },
    filterChipOn: { backgroundColor: c.primary, borderColor: c.primary },
    filterText: { fontSize: 12, color: c.textSub, fontWeight: '600' },
    filterTextOn: { color: c.onPrimary },
    empty: { paddingTop: sp.xxl * 1.5, alignItems: 'center', paddingHorizontal: sp.xl },
    emptyTitle: { fontSize: 17, fontWeight: '800', color: c.text, marginBottom: sp.sm },
    emptyDesc: { fontSize: 13, lineHeight: 21, color: c.textSub, textAlign: 'center' },
    bigCta: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: sp.sm,
      height: 50,
      borderRadius: r.lg,
      backgroundColor: c.primary,
      marginTop: sp.xl,
      paddingHorizontal: sp.xxl,
      ...t.shadow.float,
    },
    bigCtaText: { color: c.onPrimary, fontSize: 15.5, fontWeight: '700' },
    bottomBar: {
      position: 'absolute',
      left: 0,
      right: 0,
      bottom: 0,
      backgroundColor: c.surface,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderColor: c.border,
      paddingHorizontal: sp.lg,
      paddingTop: sp.sm,
      gap: sp.sm,
      ...t.shadow.float,
    },
    bottomHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
    bottomMeta: { fontSize: 12, color: c.textSub },
    bottomActions: { flexDirection: 'row', gap: sp.sm },
    saveBtn: {
      flex: 1.2,
      height: 44,
      borderRadius: r.md,
      backgroundColor: c.primary,
      alignItems: 'center',
      justifyContent: 'center',
    },
    saveText: { color: c.onPrimary, fontSize: 14.5, fontWeight: '700' },
    quizBtn: {
      flex: 1,
      height: 44,
      borderRadius: r.md,
      borderWidth: t.borderWidth,
      borderColor: c.primary,
      backgroundColor: c.primarySoft,
      alignItems: 'center',
      justifyContent: 'center',
    },
    quizBtnPressed: { opacity: 0.85 },
    quizText: { color: c.primaryDark, fontSize: 14.5, fontWeight: '700' },
    disabled: { opacity: 0.6 },
    pressed: { opacity: 0.9 },
  });
}
