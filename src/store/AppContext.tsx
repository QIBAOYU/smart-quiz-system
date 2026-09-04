/**
 * 全局状态：题库列表 + 后台 AI 解析任务。
 *
 * AI 任务放在 Context 里而不是页面 state，这样用户切 tab、退出导入页之后
 * 任务仍在跑，顶格进度条与首页胶囊都能持续读到真实进度。
 */
import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { AppSettings, Bank } from '../types/quiz';
import { listBanks, loadSettings } from '../services/quizStore';
import { useAuth } from './AuthContext';

export interface AiTask {
  id: string;
  label: string;
  done: number;
  total: number;
  collected: number;
  status: 'running' | 'done' | 'failed' | 'cancelled';
  message?: string;
  startedAt: number;
}

interface AppContextValue {
  banks: Bank[];
  banksLoading: boolean;
  /** true = 题库清单最近一次拉取失败（与「确实没有题库」不同），首页据此显示重试条 */
  banksError: boolean;
  refreshBanks: () => Promise<void>;
  settings: AppSettings;
  updateSettings: (next: AppSettings) => void;
  aiTask: AiTask | null;
  beginAiTask: (label: string, total: number) => string;
  updateAiTask: (id: string, patch: Partial<AiTask>) => void;
  finishAiTask: (id: string, status: AiTask['status'], message?: string) => void;
  clearAiTask: () => void;
  /** 用户手动收起任务条后，用胶囊重新展开 */
  taskBarVisible: boolean;
  setTaskBarVisible: (v: boolean) => void;
}

const DEFAULT_SETTINGS: AppSettings = {
  defaultMode: 'seq',
  allowTypeConvert: true,
  hapticOnWrong: true,
  dailyGoal: 20,
  examSecondsPerQuestion: 60,
};

const AppContext = createContext<AppContextValue | null>(null);

export function AppProvider({ children }: { children: React.ReactNode }) {
  const [banks, setBanks] = useState<Bank[]>([]);
  const [banksLoading, setBanksLoading] = useState(true);
  const [banksError, setBanksError] = useState(false);
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [aiTask, setAiTask] = useState<AiTask | null>(null);
  const [taskBarVisible, setTaskBarVisible] = useState(true);
  const { userId } = useAuth();

  const refreshBanks = useCallback(async () => {
    setBanksLoading(true);
    try {
      const list = await listBanks();
      // null = 请求失败：保留上一次的题库数据，只把错误态亮出来。
      // 若当成空数组，偶发一次网络抖动就会让首页显示「导入第一份资料」，
      // 用户以为数据丢了，甚至重新导入造成整库重复。
      if (list === null) {
        setBanksError(true);
      } else {
        setBanks(list);
        setBanksError(false);
      }
    } catch (error) {
      console.error('[AppContext] refreshBanks failed:', error);
      setBanksError(true);
    } finally {
      setBanksLoading(false);
    }
  }, []);

  // 账号变化（登录 / 退出 / 换号）都要重新拉取，且先清空上一个账号的数据
  useEffect(() => {
    let alive = true;
    if (!userId) {
      setBanks([]);
      setSettings(DEFAULT_SETTINGS);
      setBanksError(false);
      setBanksLoading(false);
      return undefined;
    }
    setBanksLoading(true);
    (async () => {
      try {
        const [loaded, list] = await Promise.all([loadSettings(), listBanks()]);
        if (!alive) return;
        setSettings(loaded);
        if (list === null) {
          setBanksError(true);
        } else {
          setBanks(list);
          setBanksError(false);
        }
      } catch (error) {
        console.error('[AppContext] bootstrap failed:', error);
        if (alive) setBanksError(true);
      } finally {
        if (alive) setBanksLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [userId]);

  const beginAiTask = useCallback((label: string, total: number) => {
    const id = `t_${Date.now()}`;
    setAiTask({ id, label, done: 0, total, collected: 0, status: 'running', startedAt: Date.now() });
    setTaskBarVisible(true);
    return id;
  }, []);

  const updateAiTask = useCallback((id: string, patch: Partial<AiTask>) => {
    setAiTask((prev) => (prev && prev.id === id ? { ...prev, ...patch } : prev));
  }, []);

  const finishAiTask = useCallback((id: string, status: AiTask['status'], message?: string) => {
    setAiTask((prev) => (prev && prev.id === id ? { ...prev, status, message } : prev));
  }, []);

  const clearAiTask = useCallback(() => setAiTask(null), []);

  const updateSettings = useCallback((next: AppSettings) => setSettings(next), []);

  const value = useMemo<AppContextValue>(
    () => ({
      banks,
      banksLoading,
      banksError,
      refreshBanks,
      settings,
      updateSettings,
      aiTask,
      beginAiTask,
      updateAiTask,
      finishAiTask,
      clearAiTask,
      taskBarVisible,
      setTaskBarVisible,
    }),
    [
      banks,
      banksLoading,
      banksError,
      refreshBanks,
      settings,
      updateSettings,
      aiTask,
      beginAiTask,
      updateAiTask,
      finishAiTask,
      clearAiTask,
      taskBarVisible,
    ],
  );

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useApp(): AppContextValue {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error('useApp 必须在 AppProvider 内使用');
  return ctx;
}
