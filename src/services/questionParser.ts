/**
 * 本地确定性题目解析器
 *
 * 针对真实试卷资料的排版差异设计，覆盖四类已实测的提取文本：
 *  A. 编号题 + 逐行选项 + 【答案】/【解析】（Word 知识点总结）
 *  B. 编号题 + 单行内联选项 + 答案：X（Markdown 押题）
 *  C. 无编号、整题挤在一行且选项粘连（A. xx B. xx答案：B，单片机复习）
 *  D. PDF 提取：上下标被拆成碎片行（O(𝑛 / 2 / )），需先合并
 */
import type { ParsedQuestion, QuestionType } from '../types/quiz';

/* ---------------- 正则与常量 ---------------- */

const SECTION_PATTERNS: Array<{ re: RegExp; type: QuestionType }> = [
  { re: /判\s*断\s*(题|小?题)?/, type: 'tf' },
  { re: /(单项|单选|多项|多选|选择)\s*题?/, type: 'choice' },
  { re: /填\s*空\s*(题|小?题)?/, type: 'fill' },
  { re: /(简答|名词解释|论述|计算|证明|分析|应用|程序|编写|综合|问答)\s*(题|小?题)?/, type: 'short' },
];

/** 中文序号章节头：一、二、… 或 第一部分 */
const SECTION_HEAD = /^(?:[一二三四五六七八九十]{1,3}\s*[、.．，,]\s*)?(.{0,24})$/;

/** 题号：1. / 1、/ （1）/ 第 1 题 / (1). */
const QUESTION_START =
  /^(?:第\s*(\d{1,3})\s*[题小]?[题.、．:：]?\s*|[(（]\s*(\d{1,3})\s*[)）]\s*[.、．:：]\s*|(\d{1,3})\s*[.、．]\s*)/;

/** 一行里出现两个以上 "(1) (2)" 小题号时，说明它是题干内部的分项，不是新题起点 */
function hasSubItems(line: string): boolean {
  const m = line.match(/[(（]\s*\d{1,3}\s*[)）]/g);
  return !!m && m.length >= 2;
}

function startsQuestion(line: string): boolean {
  if (hasSubItems(line)) return false;
  return QUESTION_START.test(line);
}

const ANSWER_MARK = /【\s*答\s*案\s*】|正确答案\s*[：:]|参\s*考\s*答\s*案\s*[：:]|答\s*案\s*[：:]/;
const EXPLAIN_MARK = /【\s*解\s*析\s*】|【\s*分\s*析\s*】|解\s*析\s*[：:]|答\s*案\s*解\s*析\s*[：:]/;

const TRUE_WORDS = ['正确', '对', '√', '✓', 'T', 'true', 'TRUE', '是'];
const FALSE_WORDS = ['错误', '错', '×', '✗', 'F', 'false', 'FALSE', '否'];

/* ---------------- 文本归一化 ---------------- */

/** 数学字母/数字符号（U+1D400-U+1D7FF）折叠为基本拉丁字符 */
function foldMathSymbols(input: string): string {
  let out = '';
  for (const ch of input) {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp >= 0x1d7ce && cp <= 0x1d7ff) {
      out += String.fromCharCode(0x30 + ((cp - 0x1d7ce) % 10));
    } else if (cp >= 0x1d400 && cp <= 0x1d67f) {
      const inBlock = (cp - 0x1d400) % 52;
      out += String.fromCharCode((inBlock < 26 ? 0x41 : 0x61) + (inBlock % 26));
    } else if (cp >= 0x2070 && cp <= 0x209f) {
      const map: Record<number, string> = {
        0x2070: '0', 0x00b9: '1', 0x00b2: '2', 0x00b3: '3', 0x2074: '4', 0x2075: '5',
        0x2076: '6', 0x2077: '7', 0x2078: '8', 0x2079: '9', 0x207a: '+', 0x207b: '-',
        0x2080: '0', 0x2081: '1', 0x2082: '2', 0x2083: '3', 0x2084: '4', 0x2085: '5',
        0x2086: '6', 0x2087: '7', 0x2088: '8', 0x2089: '9',
      };
      out += map[cp] ?? (/[a-zA-Z]/.test(ch) ? ch : '');
    } else {
      out += ch;
    }
  }
  return out;
}

export function normalizeText(raw: string): string {
  let text = (raw || '').replace(/\r\n?/g, '\n').replace(/^\uFEFF/, '');
  text = text.replace(/[\u{1d400}-\u{1d7ff}]/gu, (m) => foldMathSymbols(m));
  text = text
    .replace(/²/g, '2').replace(/³/g, '3').replace(/ⁿ/g, 'n')
    .replace(/⁰/g, '0').replace(/¹/g, '1').replace(/⁴/g, '4').replace(/⁵/g, '5')
    .replace(/⁶/g, '6').replace(/⁷/g, '7').replace(/⁸/g, '8').replace(/⁹/g, '9');
  text = text
    .replace(/\u3000/g, ' ')          // 全角空格
    .replace(/\u00a0/g, ' ')
    .replace(/^#{1,6}\s*/gm, '')      // markdown 标题
    .replace(/\*\*/g, '')             // markdown 加粗
    .replace(/`/g, '')                // 行内代码
    .replace(/\*/g, '')
    .replace(/_/g, '____');           // 单个下划线补成填空线
  const keep: string[] = [];
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    if (/^[-–—:\s|]+$/.test(t)) continue;               // 表格分隔线 / 页码线
    if (/^[-–—]\s*\d{1,4}\s*[-–—]$/.test(t)) continue;   // - 1 -
    if (/^\|+$/.test(t)) continue;
    keep.push(t.replace(/\s{2,}/g, ' '));
  }
  return keep.join('\n');
}

const CJK = /[\u4e00-\u9fff\u3000-\u303f（）()【】，。、；：？！]/;

function isStructural(line: string): boolean {
  if (startsQuestion(line)) return true;
  if (isSectionHeader(line)) return true;
  if (ANSWER_MARK.test(line)) return true;
  if (EXPLAIN_MARK.test(line)) return true;
  if (countOptionMarkers(line) >= 2) return true;
  return false;
}

/** 把 PDF 拆碎的上下标行、折行的题干并回上一行 */
function mergeFragments(lines: string[]): string[] {
  const merged: string[] = [];
  for (const line of lines) {
    if (merged.length === 0 || isStructural(line)) {
      merged.push(line);
      continue;
    }
    const prev = merged[merged.length - 1];
    const tail = prev.slice(-1);
    const head = line.slice(0, 1);
    const tight = line.length <= 3 || /[)\]｝】，。、；：]/.test(head) || !CJK.test(tail);
    merged[merged.length - 1] = tight ? prev + line : `${prev} ${line}`;
  }
  return merged;
}

/* ---------------- 结构识别 ---------------- */

function countOptionMarkers(line: string): number {
  const found = new Set<string>();
  const re = /[A-H]\s*[.、．]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line)) !== null) {
    found.add(m[0][0]);
  }
  return found.size;
}

function isSectionHeader(line: string): boolean {
  if (line.length > 40) return false;
  if (ANSWER_MARK.test(line) || EXPLAIN_MARK.test(line)) return false;
  if (countOptionMarkers(line) >= 2) return false;
  const m = SECTION_HEAD.exec(line);
  if (!m) return false;
  const body = m[1] ?? '';
  if (!body) return false;
  return SECTION_PATTERNS.some((p) => p.re.test(body));
}

function sectionTypeOf(line: string): QuestionType | null {
  const m = SECTION_HEAD.exec(line);
  const body = m ? m[1] : line;
  for (const p of SECTION_PATTERNS) {
    if (p.re.test(body)) return p.type;
  }
  return null;
}

/** 自成一体的题目行：整行含选项串或"题干+答案"（无编号排版） */
function isSelfContained(line: string): boolean {
  if (isSectionHeader(line)) return false;
  if (countOptionMarkers(line) >= 2) return true;
  const am = ANSWER_MARK.exec(line);
  if (!am || am.index === undefined) return false;
  const before = line.slice(0, am.index).trim();
  return before.length >= 8;
}

/** 按题块切分：优先编号切分，无编号时按"自足行"切分 */
function splitBlocks(lines: string[]): string[][] {
  const numberedCount = lines.filter((l) => startsQuestion(l)).length;
  const selfCount = lines.filter((l) => isSelfContained(l)).length;
  const useNumbered = numberedCount >= Math.max(2, selfCount * 0.5);
  const blocks: string[][] = [];
  let current: string[] | null = null;
  let sectionSeen = false;

  const push = () => {
    if (current && current.length > 0) blocks.push(current);
    current = null;
  };

  for (const line of lines) {
    if (isSectionHeader(line)) {
      push();
      sectionSeen = true;
      current = [line];
      continue;
    }
    const starts = useNumbered
      ? startsQuestion(line)
      : isSelfContained(line) || (sectionSeen && startsQuestion(line));
    if (starts) {
      push();
      current = [line];
      continue;
    }
    if (current) current.push(line);
  }
  push();
  return blocks;
}

/* ---------------- 选项与答案切分 ---------------- */

interface OptionHit { letter: string; start: number; markEnd: number }

/** 顺序贪心匹配 A→B→C…，兼容选项粘连（M3B. 8051）与 "C . 32" 带空格写法 */
function findOptionRuns(text: string): OptionHit[] {
  const hits: OptionHit[] = [];
  let cursor = 0;
  for (let i = 0; i < 8; i += 1) {
    const letter = String.fromCharCode(65 + i);
    let found: RegExpExecArray | null = null;
    const re = new RegExp(`${letter}\\s*[.、．]\\s*`, 'g');
    re.lastIndex = cursor;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      found = m;
      break;
    }
    if (!found) break;
    if (found.index > 0 && /[A-Za-z]$/.test(text.slice(0, found.index)) && i > 0) {
      // 允许粘连（如 SDAB. 中 B 前是字母 A），因此不跳过，仅记录
    }
    hits.push({ letter, start: found.index, markEnd: found.index + found[0].length });
    cursor = found.index + found[0].length + 1;
    if (cursor > text.length) break;
  }
  if (hits.length >= 2) return hits;
  return [];
}

function cleanField(value: string): string {
  return value
    .replace(/\s*\n\s*/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\s+([)）\]】，。、；：?!？])/g, '$1')
    .replace(/([([])\s+/g, '$1')
    .trim();
}

function normalizeChoiceAnswer(value: string): string {
  const letters = (value.toUpperCase().match(/[A-H]/g) ?? []).filter(
    (v, idx, arr) => arr.indexOf(v) === idx,
  );
  return letters.sort().join('');
}

function normalizeTfAnswer(value: string): boolean | null {
  const v = value.trim();
  if (!v) return null;
  for (const w of TRUE_WORDS) if (v.startsWith(w)) return true;
  for (const w of FALSE_WORDS) if (v.startsWith(w)) return false;
  return null;
}

/** 判断答案文本更像"选项字母"还是"判断值"还是"正文" */
function classifyAnswer(value: string, hasOptions: boolean): { text: string; bool: boolean | null } {
  const trimmed = cleanField(value);
  if (hasOptions) {
    const letters = normalizeChoiceAnswer(trimmed.slice(0, 12));
    if (letters) return { text: letters, bool: null };
  }
  const head = trimmed.slice(0, 3);
  const tf = normalizeTfAnswer(head);
  if (tf !== null && trimmed.length <= 6) return { text: tf ? '正确' : '错误', bool: tf };
  return { text: trimmed, bool: null };
}

/* ---------------- 主解析 ---------------- */

function parseBlock(block: string[], fallbackType: QuestionType | null): ParsedQuestion | null {
  let sectionType: QuestionType | null = null;
  const bodyLines: string[] = [];
  for (const line of block) {
    if (sectionType === null && isSectionHeader(line)) {
      sectionType = sectionTypeOf(line);
      continue;
    }
    bodyLines.push(line);
  }
  if (!sectionType) sectionType = fallbackType;

  let raw = bodyLines.join('\n');
  const startMatch = QUESTION_START.exec(raw);
  if (startMatch) raw = raw.slice(startMatch[0].length);

  // 1) 先切解析
  let explanation = '';
  const expIdx = raw.search(EXPLAIN_MARK);
  if (expIdx >= 0) {
    explanation = cleanField(raw.slice(expIdx).replace(EXPLAIN_MARK, ''));
    raw = raw.slice(0, expIdx);
  }

  // 2) 再切答案
  let answerRaw = '';
  const ansIdx = raw.search(ANSWER_MARK);
  if (ansIdx >= 0) {
    answerRaw = raw.slice(ansIdx).replace(ANSWER_MARK, '');
    raw = raw.slice(0, ansIdx);
  }

  // 3) 切选项
  const head = cleanField(raw);
  const hits = findOptionRuns(head);
  let stem = head;
  let options: string[] = [];
  if (hits.length >= 2) {
    stem = cleanField(head.slice(0, hits[0].start));
    for (let i = 0; i < hits.length; i += 1) {
      const contentEnd = i + 1 < hits.length ? hits[i + 1].start : head.length;
      const content = cleanField(head.slice(hits[i].markEnd, contentEnd)).replace(/\s+/g, ' ');
      if (content) options.push(`${hits[i].letter}. ${content}`);
    }
  }

  stem = cleanField(stem).replace(/\s*\n\s*/g, '\n');
  if (!stem || stem.length < 4) return null;

  const hasAnswer = answerRaw.trim().length > 0;
  const answered = classifyAnswer(answerRaw, options.length >= 2);

  let type: QuestionType = sectionType ?? 'short';
  if (options.length >= 2) {
    if (type !== 'choice') type = 'choice';
  } else if (answered.bool !== null) {
    type = 'tf';
    answered.text = answered.bool ? '正确' : '错误';
  } else if (type === 'choice') {
    type = sectionType === 'tf' ? 'tf' : 'short';
  }
  if (type === 'fill' && !/_{2,}|（\s*）|\(\s*\)/.test(stem) && hasAnswer && stem.length > 40) {
    type = 'short';
  }

  // 证据门槛：既无答案、又无选项、也没有提问线索的散文段落不算题目
  // （知识点总结类资料里大量"××：是指……"的解释性文字会走到这里）
  if (type === 'short' && !hasAnswer && options.length < 2) {
    const numbered = QUESTION_START.test(block[0] ?? '');
    const cue =
      /[?？]|（\s*）|\(\s*\)|_{2,}|简述|什么是|请|试|计算|证明|分析|列举|说明|名词解释|设计|比较|写出|推导/.test(
        stem,
      );
    if (!numbered && !cue) return null;
  }

  let confidence = 0.5;
  if (hasAnswer) confidence += 0.25;
  if (type === 'choice' ? options.length >= 2 : true) confidence += 0.08;
  if (sectionType) confidence += 0.07;
  if (type === 'choice' && options.length < 2) confidence -= 0.2;
  if (type === 'choice' && hasAnswer && !answered.text) confidence -= 0.2;
  if (!hasAnswer) confidence -= 0.18;
  if (stem.length < 8) confidence -= 0.25;
  if (stem.length > 400) confidence -= 0.05;
  if (type === 'short' && !hasAnswer) confidence -= 0.05;
  confidence = Math.max(0.05, Math.min(0.98, confidence));

  const isTf = type === 'tf';
  return {
    key: `p_${Math.random().toString(36).slice(2, 10)}`,
    type,
    stem,
    options: type === 'choice' ? options : [],
    answer: isTf ? (answered.bool === null ? answered.text : answered.bool ? '正确' : '错误') : answered.text,
    answerBool: isTf ? answered.bool : null,
    explanation,
    confidence: Math.round(confidence * 100) / 100,
    reviewed: false,
    source: 'local',
  };
}

export interface LocalParseResult {
  questions: ParsedQuestion[];
  stats: { lines: number; blocks: number; answered: number; lowConfidence: number };
}

export function parseQuestionsLocally(rawText: string): LocalParseResult {
  const normalized = normalizeText(rawText);
  const lines = normalized.split('\n').filter((l) => l.trim().length > 0);
  const merged = mergeFragments(lines);
  const blocks = splitBlocks(merged);

  const questions: ParsedQuestion[] = [];
  let currentSection: QuestionType | null = null;
  for (const block of blocks) {
    const head = block[0] ?? '';
    if (isSectionHeader(head)) {
      const t = sectionTypeOf(head);
      if (t) currentSection = t;
    }
    const q = parseBlock(block, currentSection);
    if (q) questions.push(q);
  }

  // 去重（同一份资料里常见重复题）
  const seen = new Set<string>();
  const unique = questions.filter((q) => {
    const sig = `${q.type}|${q.stem.replace(/\s/g, '').slice(0, 40)}`;
    if (seen.has(sig)) return false;
    seen.add(sig);
    return true;
  });

  unique.forEach((q, i) => {
    q.key = `p_${i + 1}_${Math.random().toString(36).slice(2, 8)}`;
  });

  return {
    questions: unique,
    stats: {
      lines: lines.length,
      blocks: blocks.length,
      answered: unique.filter((q) => q.answer.length > 0).length,
      lowConfidence: unique.filter((q) => q.confidence < 0.6).length,
    },
  };
}
