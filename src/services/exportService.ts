/**
 * 题库导出 / 分享
 *
 * 走 doc-export 云函数生成 txt / doc / docx 文件（docx 为真 OOXML 二进制），
 * App 侧解码 Base64 → 写入缓存目录 → 调用系统分享面板（可同时用于「分享」需求）。
 */
import { File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { supabaseUrl } from '../supabase/client';
import { authHeaders } from './ownerId';
import type { Question } from '../types/quiz';

export type ExportFormat = 'txt' | 'doc' | 'docx';

export const FORMAT_LABELS: Record<ExportFormat, string> = {
  docx: 'Word 文档 (.docx)',
  doc: 'Word 97-2003 (.doc)',
  txt: '纯文本 (.txt)',
};

const MIME: Record<ExportFormat, string> = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  doc: 'application/msword',
  txt: 'text/plain',
};

const B64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** 纯 JS Base64 解码（RN 无 atob） */
function decodeBase64(input: string): Uint8Array {
  const clean = input.replace(/[^A-Za-z0-9+/]/g, '');
  const byteLength = Math.floor((clean.length * 3) / 4);
  const bytes = new Uint8Array(byteLength);
  let buffer = 0;
  let bits = 0;
  let index = 0;
  for (let i = 0; i < clean.length; i += 1) {
    const value = B64_CHARS.indexOf(clean[i]);
    if (value < 0) continue;
    buffer = (buffer << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes[index] = (buffer >> bits) & 0xff;
      index += 1;
    }
  }
  return index === bytes.length ? bytes : bytes.slice(0, index);
}

function sanitizeName(name: string): string {
  return (name || '题库').replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 40);
}

export interface ExportResult {
  ok: boolean;
  message: string;
  uri?: string;
}

/** 生成文件并写入缓存，返回本地 uri（不落云端） */
export async function buildExportFile(
  bankName: string,
  format: ExportFormat,
  questions: Question[],
  withAnswer: boolean,
): Promise<ExportResult> {
  if (questions.length === 0) return { ok: false, message: '题库里还没有题目' };
  try {
    const url = `${supabaseUrl}/functions/v1/doc-export`;
    const response = await fetch(url, {
      method: 'POST',
      // 云函数已收紧为「仅登录态可调用」，必须带当前会话的 access_token
      headers: { 'Content-Type': 'application/json', ...(await authHeaders()) },
      body: JSON.stringify({
        bankName,
        format,
        withAnswer,
        questions: questions.slice(0, 3000).map((q) => ({
          type: q.type,
          stem: q.stem,
          options: q.options ?? [],
          answer: q.answerBool === null ? q.answer : q.answer || (q.answerBool ? '正确' : '错误'),
          explanation: q.explanation ?? '',
        })),
      }),
    });
    const text = await response.text();
    if (!response.ok) {
      let msg = `导出失败（${response.status}）`;
      try {
        const parsed = JSON.parse(text) as { error?: string };
        if (parsed.error) msg = parsed.error;
      } catch (error) {
        console.error('[export] 解析错误响应失败:', error);
      }
      return { ok: false, message: msg };
    }
    let payload: { filename?: string; mime?: string; base64?: string };
    try {
      payload = JSON.parse(text);
    } catch (error) {
      console.error('[export] 响应不是 JSON:', error);
      return { ok: false, message: '导出服务返回异常，请稍后重试' };
    }
    if (!payload.base64) return { ok: false, message: '导出内容为空，请确认题库有题目' };

    const bytes = decodeBase64(payload.base64);
    const name = payload.filename || `${sanitizeName(bankName)}.${format}`;
    const file = new File(Paths.cache, name);
    if (file.exists) file.delete();
    file.create();
    file.write(bytes);
    return { ok: true, message: '文件已生成', uri: file.uri };
  } catch (error) {
    console.error('[export] 导出异常:', error);
    return { ok: false, message: '网络异常，导出未完成，请检查网络后重试' };
  }
}

/** 通过系统分享面板把文件分享出去（微信 / 钉钉 / 邮件 / 网盘等） */
export async function shareFile(uri: string, format: ExportFormat, bankName: string): Promise<ExportResult> {
  try {
    const available = await Sharing.isAvailableAsync();
    if (!available) return { ok: false, message: '这台设备暂不支持系统分享，可先导出文件到手机后再发送' };
    await Sharing.shareAsync(uri, {
      mimeType: MIME[format],
      dialogTitle: `分享题库：${bankName}`,
      UTI: format === 'txt' ? 'public.plain-text' : 'com.microsoft.word.doc',
    });
    return { ok: true, message: '已打开分享面板' };
  } catch (error) {
    console.error('[export] 分享异常:', error);
    return { ok: false, message: '分享未完成，请重试' };
  }
}

/** 导出 + 分享一步到位 */
export async function exportAndShare(
  bankName: string,
  format: ExportFormat,
  questions: Question[],
  withAnswer: boolean,
): Promise<ExportResult> {
  const built = await buildExportFile(bankName, format, questions, withAnswer);
  if (!built.ok || !built.uri) return built;
  const shared = await shareFile(built.uri, format, bankName);
  if (!shared.ok) return { ok: true, message: `文件已生成：${bankName}（${format}）`, uri: built.uri };
  return shared;
}
