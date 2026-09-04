/**
 * 主题上下文：配色 + UI 风格（极简纸感 / 新拟物 / 手绘插画 / 夜航深色）
 *
 * 主题属于「设备偏好」，存在 SecureStore（不进云数据库），换设备不影响别人。
 * SecureStore 在 Web 预览下不可用，这里做了内存兜底。
 */
import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import * as SecureStore from 'expo-secure-store';
import { buildTheme, DEFAULT_THEME_ID, PALETTES, type Theme, type ThemeId } from '../constants/theme';

const STORAGE_KEY = 'quiz_theme_id';

let memoryTheme: ThemeId | null = null;

async function readThemeId(): Promise<ThemeId> {
  if (memoryTheme) return memoryTheme;
  try {
    const raw = await SecureStore.getItemAsync(STORAGE_KEY);
    // 老版本可能存了已下线的风格（如 'glass'），这里只认当前 PALETTES 白名单
    const id = (raw ?? DEFAULT_THEME_ID) as ThemeId;
    return PALETTES[id] ? id : DEFAULT_THEME_ID;
  } catch (error) {
    console.error('[theme] 读取主题失败，使用默认主题:', error);
    return DEFAULT_THEME_ID;
  }
}

async function writeThemeId(id: ThemeId): Promise<void> {
  memoryTheme = id;
  try {
    await SecureStore.setItemAsync(STORAGE_KEY, id);
  } catch (error) {
    console.error('[theme] 主题已在本机生效，但持久化失败:', error);
  }
}

interface ThemeContextValue {
  theme: Theme;
  themeId: ThemeId;
  setThemeId: (id: ThemeId) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [themeId, setThemeIdState] = useState<ThemeId>(DEFAULT_THEME_ID);

  useEffect(() => {
    let alive = true;
    readThemeId()
      .then((id) => {
        if (alive) setThemeIdState(id);
      })
      .catch((error) => console.error('[theme] init failed:', error));
    return () => {
      alive = false;
    };
  }, []);

  const setThemeId = useCallback((id: ThemeId) => {
    setThemeIdState(id);
    writeThemeId(id).catch((error) => console.error('[theme] persist failed:', error));
  }, []);

  const value = useMemo<ThemeContextValue>(() => ({ theme: buildTheme(themeId), themeId, setThemeId }), [themeId, setThemeId]);

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): Theme {
  const ctx = useContext(ThemeContext);
  if (!ctx) return buildTheme(DEFAULT_THEME_ID);
  return ctx.theme;
}

export function useThemeState(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) {
    const theme = buildTheme(DEFAULT_THEME_ID);
    return { theme, themeId: DEFAULT_THEME_ID, setThemeId: () => undefined };
  }
  return ctx;
}
