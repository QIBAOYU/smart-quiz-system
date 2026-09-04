/**
 * 全局搜索：跨全部题库按关键词找题。
 *
 * 结果不跳回题库页，而是就地展开看答案与解析 —— 用户搜题往往是
 * 「我记得有道题说过 X」，想知道的是那题的答案，而不是先找到所属题库再翻几十题。
 */
import React, { useCallback, useMemo, useState } from 'react';
import { FlatList, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import { typeLabels } from '../constants/theme';
import { Tag } from '../components/ui';
import { useTaskInset } from '../components/AiTaskLayer';
import { useTheme } from '../store/ThemeContext';
import { useApp } from '../store/AppContext';
import { searchQuestions } from '../services/quizStore';
import { difficultyLabel } from '../components/QuestionEditor';
import { expectedDisplay } from '../services/quizEngine';
import type { Question } from '../types/quiz';

/** 至少两个字符才发请求：单字搜索几乎等于全表匹配，既慢又没意义 */
const MIN_KEYWORD = 2;

function highlight(text: string, keyword: string): { value: string; hit: boolean }[] {
  const kw = keyword.trim();
  if (!kw) return [{ value: text, hit: false }];
  const out: { value: string; hit: boolean }[] = [];
  const lowerText = text.toLowerCase();
  const lowerKw = kw.toLowerCase();
  let from = 0;
  while (from < text.length) {
    const at = lowerText.indexOf(lowerKw, from);
    if (at < 0) {
      out.push({ value: text.slice(from), hit: false });
      break;
    }
    if (at > from) out.push({ value: text.slice(from, at), hit: false });
    out.push({ value: text.slice(at, at + kw.length), hit: true });
    from = at + kw.length;
  }
  return out.filter((p) => p.value.length > 0);
}

function ResultCard({ question, bankName, keyword }: { question: Question; bankName: string; keyword: string }) {
  const t = useTheme();
  const c = t.palette;
  const [open, setOpen] = useState(false);

  return (
    <View
      style={[
        styles.card,
        {
          backgroundColor: t.cardBg,
          borderColor: c.border,
          borderRadius: t.cardRadius,
          borderWidth: 1,
        },
      ]}
    >
      <Pressable accessibilityRole="button" onPress={() => setOpen((v) => !v)} style={styles.cardHead}>
        <View style={{ flex: 1 }}>
          <Text style={[styles.stem, { color: c.text }]} numberOfLines={open ? 0 : 3}>
            {highlight(question.stem, keyword).map((part, i) => (
              <Text key={`h_${i}`} style={part.hit ? { backgroundColor: c.warnSoft, color: c.text } : undefined}>
                {part.value}
              </Text>
            ))}
          </Text>
          <View style={styles.metaRow}>
            <Tag label={typeLabels[question.type] ?? question.type} tone="neutral" />
            {question.subject ? <Tag label={question.subject} tone="ai" /> : null}
            {question.difficulty ? <Tag label={difficultyLabel(question.difficulty)} tone="warn" /> : null}
            <Text style={[styles.bank, { color: c.textMuted }]} numberOfLines={1}>
              {bankName}
            </Text>
          </View>
        </View>
        <Text style={[styles.chev, { color: c.textMuted }]}>{open ? '收起' : '答案'}</Text>
      </Pressable>

      {open ? (
        <View style={[styles.body, { borderTopColor: c.border }]}>
          <Text style={[styles.label, { color: c.textMuted }]}>参考答案</Text>
          <Text style={[styles.answer, { color: c.text }]}>{expectedDisplay(question)}</Text>
          {question.explanation ? (
            <>
              <Text style={[styles.label, { color: c.textMuted }]}>解析</Text>
              <Text style={[styles.explain, { color: c.textSub }]}>{question.explanation}</Text>
            </>
          ) : (
            <Text style={[styles.explain, { color: c.textMuted }]}>这道题还没有解析。</Text>
          )}
          <Pressable
            accessibilityRole="button"
            onPress={() => router.push({ pathname: '/bank', params: { id: question.bankId, name: bankName } })}
            hitSlop={8}
          >
            <Text style={[styles.link, { color: c.primary }]}>去该题库练习 ›</Text>
          </Pressable>
        </View>
      ) : null}
    </View>
  );
}

export default function SearchScreen() {
  const insets = useSafeAreaInsets();
  const t = useTheme();
  const c = t.palette;
  const taskInset = useTaskInset();
  const { banks } = useApp();

  const [keyword, setKeyword] = useState('');
  const [results, setResults] = useState<Question[]>([]);
  const [searched, setSearched] = useState(false);
  const [busy, setBusy] = useState(false);

  const bankNames = useMemo(() => new Map(banks.map((b) => [b.id, b.name])), [banks]);

  const run = useCallback(async (raw: string) => {
    const kw = raw.trim();
    if (kw.length < MIN_KEYWORD) {
      setResults([]);
      setSearched(false);
      return;
    }
    setBusy(true);
    try {
      setResults(await searchQuestions(kw));
      setSearched(true);
    } catch (error) {
      console.error('[search] 搜索失败:', error);
      setResults([]);
      setSearched(true);
    } finally {
      setBusy(false);
    }
  }, []);

  return (
    <View style={[styles.root, { backgroundColor: c.bg, paddingTop: insets.top + taskInset }]}>
      <View style={styles.nav}>
        <Pressable
          accessibilityRole="button"
          onPress={() => (router.canGoBack() ? router.back() : router.replace('/'))}
          hitSlop={12}
          style={styles.back}
        >
          <Text style={[styles.backText, { color: c.primary }]}>‹ 返回</Text>
        </Pressable>
        <Text style={[styles.navTitle, { color: c.text }]}>搜索题目</Text>
        <View style={styles.navSpace} />
      </View>

      <View style={styles.searchBar}>
        <TextInput
          style={[styles.input, { backgroundColor: t.cardBg, borderColor: c.border, borderRadius: t.radius.md, color: c.text }]}
          value={keyword}
          onChangeText={(v) => {
            setKeyword(v);
            if (!v.trim()) {
              setResults([]);
              setSearched(false);
            }
          }}
          placeholder="输入关键词，搜题干 / 答案 / 解析"
          placeholderTextColor={c.textMuted}
          autoCorrect={false}
          returnKeyType="search"
          onSubmitEditing={() => {
            run(keyword).catch((error) => console.error('[search] run failed:', error));
          }}
        />
        <Pressable
          accessibilityRole="button"
          onPress={() => {
            run(keyword).catch((error) => console.error('[search] run failed:', error));
          }}
          disabled={busy}
          style={({ pressed }) => [
            styles.goBtn,
            { backgroundColor: c.primary, borderRadius: t.radius.md, opacity: busy || pressed ? 0.85 : 1 },
          ]}
        >
          <Text style={[styles.goText, { color: c.onPrimary }]}>{busy ? '搜索中' : '搜索'}</Text>
        </Pressable>
      </View>

      <FlatList
        data={results}
        keyExtractor={(q) => q.id}
        contentContainerStyle={styles.scroll}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        ListHeaderComponent={
          searched && results.length > 0 ? (
            <Text style={[styles.resultMeta, { color: c.textSub }]}>共 {results.length} 道题{results.length >= 100 ? '（仅显示前 100 条，可换更具体的关键词）' : ''}</Text>
          ) : null
        }
        ListEmptyComponent={
          busy ? null : (
            <View style={styles.emptyWrap}>
              <Text style={[styles.emptyTitle, { color: c.text }]}>
                {searched ? '没有匹配的题目' : '试试搜关键词'}
              </Text>
              <Text style={[styles.emptyText, { color: c.textSub }]}>
                {searched
                  ? '换个说法再试，比如只搜题里出现过的一个词。搜索范围是你全部题库的题干、答案与解析。'
                  : `至少输入 ${MIN_KEYWORD} 个字。可以搜题干里的概念，也可以搜答案里的关键词。`}
              </Text>
            </View>
          )
        }
        renderItem={({ item }) => (
          <ResultCard question={item} bankName={bankNames.get(item.bankId) ?? '未知题库'} keyword={keyword} />
        )}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  nav: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, marginBottom: 8, minHeight: 40 },
  back: { width: 64 },
  backText: { fontSize: 15, fontWeight: '600' },
  navTitle: { flex: 1, textAlign: 'center', fontSize: 17, fontWeight: '800' },
  navSpace: { width: 64 },
  searchBar: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 16, marginBottom: 6 },
  input: { flex: 1, height: 44, borderWidth: 1, paddingHorizontal: 12, fontSize: 15 },
  goBtn: { width: 64, height: 44, alignItems: 'center', justifyContent: 'center' },
  goText: { fontSize: 14.5, fontWeight: '700' },
  scroll: { paddingHorizontal: 16, paddingBottom: 30, gap: 10 },
  resultMeta: { fontSize: 12.5, marginBottom: 2 },
  card: { padding: 14 },
  cardHead: { flexDirection: 'row', alignItems: 'flex-start', gap: 10 },
  stem: { fontSize: 15, lineHeight: 23 },
  metaRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 8, flexWrap: 'wrap' },
  bank: { fontSize: 11.5, flexShrink: 1 },
  chev: { fontSize: 12.5, fontWeight: '600', marginTop: 2 },
  body: { marginTop: 12, paddingTop: 10, borderTopWidth: StyleSheet.hairlineWidth },
  label: { fontSize: 11, fontWeight: '600', marginBottom: 2 },
  answer: { fontSize: 15.5, fontWeight: '700', lineHeight: 23 },
  explain: { fontSize: 13.5, lineHeight: 21, marginTop: 4 },
  link: { fontSize: 13, fontWeight: '700', marginTop: 12 },
  emptyWrap: { paddingTop: 48, paddingHorizontal: 24, alignItems: 'center', gap: 8 },
  emptyTitle: { fontSize: 16, fontWeight: '800' },
  emptyText: { fontSize: 13, lineHeight: 21, textAlign: 'center' },
});
