/**
 * doc-export：题库导出服务
 *
 * 输入（JSON）：
 *  {
 *    bankName: string,
 *    format: "txt" | "doc" | "docx",
 *    withAnswer: boolean,          // 是否包含答案与解析
 *    questions: [{ type, stem, options, answer, explanation }]
 *  }
 * 输出：{ filename, mime, base64 }
 *
 * - txt  ：纯文本试卷
 * - doc  ：Word 可打开的 HTML 文档（保留标题、题型分组、加粗）
 * - docx ：用 jszip 组装真正的 Office Open XML 包
 * 只生成文件字节并 base64 返回，不落库、不存文件。
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const functionName = 'doc-export';
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? '';

interface ExportQuestion {
  type?: string;
  stem?: string;
  options?: string[];
  answer?: string;
  explanation?: string;
}

const TYPE_LABEL: Record<string, string> = {
  choice: '单选题',
  tf: '判断题',
  fill: '填空题',
  short: '简答题',
};

function jsonHeaders(): Record<string, string> {
  return { 'Content-Type': 'application/json' };
}

function badRequest(message: string): Response {
  return new Response(JSON.stringify({ error: message }), { status: 400, headers: jsonHeaders() });
}

function escapeXml(value: string): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
    // 去掉 XML 1.0 不允许的控制字符
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
}

function escapeHtml(value: string): string {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function sanitizeFilename(value: string): string {
  const clean = String(value ?? '')
    .replace(/[\\/:*?"<>|\r\n]/g, '')
    .trim()
    .slice(0, 40);
  return clean || '题库导出';
}

function answerText(q: ExportQuestion): string {
  return String(q.answer ?? '').trim();
}

/* ---------------- 纯文本 ---------------- */

function buildTxt(bankName: string, questions: ExportQuestion[], withAnswer: boolean): string {
  const lines: string[] = [];
  lines.push(bankName);
  lines.push(`共 ${questions.length} 题 · 导出于 ${new Date().toLocaleString('zh-CN')}`);
  lines.push('');
  questions.forEach((q, i) => {
    const label = TYPE_LABEL[q.type ?? 'short'] ?? '题目';
    lines.push(`${i + 1}. 【${label}】 ${String(q.stem ?? '').trim()}`);
    (q.options ?? []).forEach((o) => lines.push(`    ${String(o).trim()}`));
    if (withAnswer) {
      lines.push(`    答案：${answerText(q) || '（原资料未提供）'}`);
      if (q.explanation && String(q.explanation).trim()) lines.push(`    解析：${String(q.explanation).trim()}`);
    }
    lines.push('');
  });
  return lines.join('\n');
}

/* ---------------- Word 可打开的 HTML（.doc） ---------------- */

function buildDoc(bankName: string, questions: ExportQuestion[], withAnswer: boolean): string {
  const parts: string[] = [];
  parts.push('<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word" xmlns="http://www.w3.org/TR/REC-html40">');
  parts.push('<head><meta charset="utf-8"><title>' + escapeHtml(bankName) + '</title>');
  parts.push('<style>body{font-family:"Microsoft YaHei","SimSun",serif;font-size:12pt;line-height:1.8}')
  parts.push('h1{font-size:18pt;text-align:center} .meta{text-align:center;color:#666;font-size:10pt}')
  parts.push('.q{margin-top:14pt} .opt{margin-left:24pt} .ans{color:#1a7f37;font-weight:bold;margin-left:24pt}')
  parts.push('.exp{color:#555;margin-left:24pt}</style></head><body>');
  parts.push(`<h1>${escapeHtml(bankName)}</h1>`);
  parts.push(`<p class="meta">共 ${questions.length} 题 · ${withAnswer ? '含答案版' : '空白试卷版'}</p>`);
  questions.forEach((q, i) => {
    const label = TYPE_LABEL[q.type ?? 'short'] ?? '题目';
    parts.push(`<p class="q"><b>${i + 1}.【${label}】</b> ${escapeHtml(String(q.stem ?? '').trim())}</p>`);
    (q.options ?? []).forEach((o) => parts.push(`<p class="opt">${escapeHtml(String(o).trim())}</p>`));
    if (withAnswer) {
      parts.push(`<p class="ans">答案：${escapeHtml(answerText(q) || '（原资料未提供）')}</p>`);
      if (q.explanation && String(q.explanation).trim()) parts.push(`<p class="exp">解析：${escapeHtml(String(q.explanation).trim())}</p>`);
    }
  });
  parts.push('</body></html>');
  return parts.join('\n');
}

/* ---------------- 真正的 docx ---------------- */

function docxRun(text: string, bold: boolean, sizeHalfPt: number, color?: string): string {
  const props: string[] = [];
  if (bold) props.push('<w:b/>');
  if (color) props.push(`<w:color w:val="${color}"/>`);
  props.push(`<w:sz w:val="${sizeHalfPt}"/><w:sz-cs w:val="${sizeHalfPt}"/>`);
  const rPr = `<w:rPr>${props.join('')}</w:rPr>`;
  // 多行文本拆成 <w:br/>
  const body = escapeXml(text).replace(/\n/g, '<w:br/>');
  return `<w:r>${rPr}<w:t xml:space="preserve">${body}</w:t></w:r>`;
}

function docxPara(runs: string[], align?: string, spaceBefore = 0): string {
  const pPr: string[] = [];
  if (spaceBefore) pPr.push(`<w:spacing w:before="${spaceBefore}" w:after="60" w:line="360" w:lineRule="auto"/>`);
  else pPr.push('<w:spacing w:after="60" w:line="360" w:lineRule="auto"/>');
  if (align) pPr.push(`<w:jc w:val="${align}"/>`);
  return `<w:p><w:pPr>${pPr.join('')}</w:pPr>${runs.join('')}</w:p>`;
}

function buildDocxXml(bankName: string, questions: ExportQuestion[], withAnswer: boolean): string {
  const paras: string[] = [];
  paras.push(docxPara([docxRun(bankName, true, 36)], 'center', 0));
  paras.push(docxPara([docxRun(`共 ${questions.length} 题 · ${withAnswer ? '含答案版' : '空白试卷版'}`, false, 18, '808080')], 'center'));

  questions.forEach((q, i) => {
    const label = TYPE_LABEL[q.type ?? 'short'] ?? '题目';
    paras.push(
      docxPara(
        [docxRun(`${i + 1}.【${label}】 `, true, 22), docxRun(String(q.stem ?? '').trim(), false, 22)],
        undefined,
        160,
      ),
    );
    (q.options ?? []).forEach((o) => paras.push(docxPara([docxRun(`    ${String(o).trim()}`, false, 22)])));
    if (withAnswer) {
      paras.push(docxPara([docxRun(`答案：${answerText(q) || '（原资料未提供）'}`, true, 22, '1A7F37')]));
      if (q.explanation && String(q.explanation).trim()) {
        paras.push(docxPara([docxRun(`解析：${String(q.explanation).trim()}`, false, 20, '555555')]));
      }
    }
  });

  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
    `<w:body>${paras.join('')}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/>` +
    '<w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr></w:body></w:document>'
  );
}

/** jszip 实例的最小结构声明（避免引入 npm 类型依赖） */
interface DocxZip {
  file(name: string, content: string): void;
  generateAsync(options: { type: 'uint8array'; mimeType: string }): Promise<Uint8Array>;
}

async function buildDocx(bankName: string, questions: ExportQuestion[], withAnswer: boolean): Promise<Uint8Array> {
  const jszipMod = await import('https://esm.sh/jszip@3.10.1');
  const JSZip = ((jszipMod as unknown as { default?: unknown }).default ?? jszipMod) as new () => DocxZip;
  const zip = new JSZip();

  zip.file(
    '[Content_Types].xml',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
      '</Types>',
  );
  zip.file(
    '_rels/.rels',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
      '</Relationships>',
  );
  zip.file('word/document.xml', buildDocxXml(bankName, questions, withAnswer));

  return zip.generateAsync({ type: 'uint8array', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const STEP = 0x8000;
  for (let i = 0; i < bytes.length; i += STEP) {
    binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + STEP)) as unknown as number[]);
  }
  return btoa(binary);
}

/**
 * 登录态校验：拿请求里的 access_token 去 Auth 服务换真实用户。
 * 匿名密钥（anon key）不是合法的用户 token，换不到身份 → 401。
 */
async function requireUserId(req: Request): Promise<string | null> {
  const header = req.headers.get('Authorization') ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!token || !SUPABASE_URL || !SUPABASE_ANON_KEY) return null;
  try {
    const probe = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
    const { data, error } = await probe.auth.getUser(token);
    if (error || !data.user) return null;
    return data.user.id;
  } catch (_) {
    return null;
  }
}

function unauthorized(): Response {
  return new Response(JSON.stringify({ error: '请先登录后再使用此功能' }), { status: 401, headers: jsonHeaders() });
}

/* ---------------- 入口 ---------------- */

Deno.serve(async (req) => {
  const reqId = crypto.randomUUID().slice(0, 8);
  try {
    const userId = await requireUserId(req);
    if (!userId) return unauthorized();
    console.info(`[${functionName}] auth ok ${reqId} user=${userId.slice(0, 8)}`);
    const body = await req.json();
    const format = String(body.format ?? 'txt').toLowerCase();
    const bankName = String(body.bankName ?? '题库导出');
    const withAnswer = body.withAnswer !== false;
    const questions = Array.isArray(body.questions) ? (body.questions as ExportQuestion[]).slice(0, 3000) : [];
    if (questions.length === 0) return badRequest('没有可导出的题目');

    const base = sanitizeFilename(bankName);
    let filename: string;
    let mime: string;
    let base64: string;

    if (format === 'docx') {
      const bytes = await buildDocx(bankName, questions, withAnswer);
      filename = `${base}.docx`;
      mime = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
      base64 = bytesToBase64(bytes);
    } else if (format === 'doc') {
      filename = `${base}.doc`;
      mime = 'application/msword';
      base64 = bytesToBase64(new TextEncoder().encode(buildDoc(bankName, questions, withAnswer)));
    } else {
      filename = `${base}.txt`;
      mime = 'text/plain';
      base64 = bytesToBase64(new TextEncoder().encode(buildTxt(bankName, questions, withAnswer)));
    }

    console.info(`[${functionName}] ok ${reqId} format=${format} questions=${questions.length} bytes=${base64.length}`);
    return new Response(JSON.stringify({ filename, mime, base64 }), { headers: jsonHeaders() });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[${functionName}] failed ${reqId}: ${message}`);
    return new Response(JSON.stringify({ error: message }), { status: 500, headers: jsonHeaders() });
  }
});
