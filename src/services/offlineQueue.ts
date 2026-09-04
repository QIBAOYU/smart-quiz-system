/**
 * 作答记录补交队列 —— 纯内存。
 *
 * 为什么需要它：submitAnswer 走网络，断网 / RLS 拦截 / 网关抖动都会失败。
 * 改之前 submitAnswer 内部把错误全吞成日志、从不抛错，于是 session 页的
 * catch 永远不会触发：用户看到的判分反馈完全正常，云端却一条记录都没落，
 * 错题本、正确率、打卡全部失真，而且没有任何地方提示过。
 *
 * 现在 submitAnswer 返回 boolean，失败的答案先暂存在这个内存队列里，
 * 下一次写入成功时按原顺序顺带补交，首页常驻一条「N 题待同步」提示。
 *
 * 只存内存、不落盘：本项目未引入 AsyncStorage，平台也禁止用它做持久化。
 * 因此杀掉进程后未补交的队列会丢 —— 仍比「完全不留痕」好，
 * 因为本次会话内的后续作答能救回来，且用户能看见到底有没有同步成功。
 */
import { useSyncExternalStore } from 'react';
import { submitAnswer } from './quizStore';
import type { QuizMode } from '../types/quiz';

export interface PendingAttempt {
  questionId: string;
  bankId: string;
  correct: boolean;
  mode: QuizMode;
}

/** 队列上限：长时间离线刷题时丢弃最旧的，避免无限增长 */
const MAX_QUEUE = 500;

let queue: PendingAttempt[] = [];
let flushing = false;
const listeners = new Set<() => void>();

function emit(): void {
  listeners.forEach((fn) => fn());
}

export function subscribeAttempts(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** 快照必须是不可变的基本类型值，长度变化即代表状态变化 */
export function getPendingAttemptCount(): number {
  return queue.length;
}

/** 首页「N 题待同步」横幅用 */
export function usePendingAttemptCount(): number {
  return useSyncExternalStore(subscribeAttempts, getPendingAttemptCount, getPendingAttemptCount);
}

export function enqueueAttempt(item: PendingAttempt): void {
  if (queue.length >= MAX_QUEUE) queue.shift();
  queue.push(item);
  emit();
}

/** 退出登录 / 注销账号时必须清空，否则会把上一个账号的作答记到新账号头上 */
export function clearAttemptQueue(): void {
  if (queue.length === 0) return;
  queue = [];
  emit();
}

/**
 * 尝试补交。任一题仍失败就立即停下（保持原有顺序，下次再试），
 * 避免网络不通时把整条队列瞬间「跑空」却一条都没存上。
 * 返回本次成功补交的条数。
 */
export async function flushAttemptQueue(): Promise<number> {
  if (flushing || queue.length === 0) return 0;
  flushing = true;
  let done = 0;
  while (queue.length > 0) {
    const head = queue[0];
    try {
      const ok = await submitAnswer(head.questionId, head.bankId, head.correct, head.mode);
      if (!ok) break;
    } catch (error) {
      console.error('[offlineQueue] 补交失败:', error);
      break;
    }
    queue.shift();
    done += 1;
    emit();
  }
  flushing = false;
  return done;
}
