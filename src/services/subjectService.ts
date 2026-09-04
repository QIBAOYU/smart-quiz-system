/**
 * 科目分类编排：取题库内未分类题目 → AI 批量分类 → 逐题回写。
 * 导入成功后的自动分类与题库详情页的手动按钮共用这一条链路。
 */
import { getOwnerId } from './ownerId';
import { classifySubjects } from './aiService';
import { listQuestions, updateQuestion } from './quizStore';

export interface ClassifyProgress {
  done: number;
  total: number;
  classified: number;
}

/** 返回成功写入科目的题数；AI 完全不可用时抛 RelayUnavailableError */
export async function classifyBank(
  bankId: string,
  onProgress: (p: ClassifyProgress) => void,
  shouldAbort: () => boolean,
): Promise<number> {
  const userId = await getOwnerId();
  if (!userId) return 0;
  const all = await listQuestions(bankId);
  const targets = all.filter((q) => !q.subject);
  if (targets.length === 0) return 0;
  const map = await classifySubjects(
    targets,
    (p) => onProgress({ done: p.done, total: p.total, classified: p.classified }),
    shouldAbort,
  );
  let n = 0;
  for (const [index, subject] of map.entries()) {
    if (shouldAbort()) break;
    const target = targets[index];
    if (!target) continue;
    const ok = await updateQuestion(target.id, { subject });
    if (ok) n += 1;
  }
  return n;
}
