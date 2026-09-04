/**
 * 设计令牌：多套配色 + 多种 UI 风格（极简纸感 / 新拟物 / 手绘插画 / 夜航深色）
 *
 * 页面不要直接 import colors，用 useTheme() 取当前主题；
 * 这里保留 colors / radius / spacing / shadow 的默认导出，仅为兼容与兜底。
 */
import type { ViewStyle } from 'react-native';

export type ThemeId = 'paper' | 'neo' | 'sketch' | 'night';
export type SurfaceTone = 'flat' | 'neumorphic' | 'sketch';

export interface Palette {
  id: ThemeId;
  name: string;
  desc: string;
  tone: SurfaceTone;
  /** 是否深色底 */
  dark: boolean;
  bg: string;
  /** 页面顶部渐层用的高亮底色 */
  bgTop: string;
  surface: string;
  surfaceAlt: string;
  /** 半透明底色（遮罩、浮层用） */
  surfaceTrans: string;
  border: string;
  text: string;
  textSub: string;
  textMuted: string;
  primary: string;
  primaryDark: string;
  primarySoft: string;
  onPrimary: string;
  accent: string;
  accentSoft: string;
  success: string;
  successSoft: string;
  danger: string;
  dangerSoft: string;
  warn: string;
  warnSoft: string;
  /** 进度条底槽 */
  track: string;
  tabBar: string;
  shadowColor: string;
}

export const PALETTES: Record<ThemeId, Palette> = {
  paper: {
    id: 'paper',
    name: '极简纸感',
    desc: '低饱和墨色 + 一点松绿，留白多、层次靠阴影',
    tone: 'flat',
    dark: false,
    bg: '#F5F4F0',
    bgTop: '#EDEBE4',
    surface: '#FFFFFF',
    surfaceAlt: '#FAF9F6',
    surfaceTrans: 'rgba(255,255,255,0.92)',
    border: '#E3E0D8',
    text: '#1D211F',
    textSub: '#5F6763',
    textMuted: '#9AA19D',
    primary: '#2F6F5E',
    primaryDark: '#245649',
    primarySoft: '#E4EFEA',
    onPrimary: '#FFFFFF',
    accent: '#B8663A',
    accentSoft: '#F6EAE2',
    success: '#2F7D4F',
    successSoft: '#E6F2EA',
    danger: '#B4402F',
    dangerSoft: '#F8E9E6',
    warn: '#9A6B12',
    warnSoft: '#F7EFDF',
    track: '#E7E4DC',
    tabBar: '#FFFFFF',
    shadowColor: '#2B2F2D',
  },
  neo: {
    id: 'neo',
    name: '新拟物',
    desc: '同色底 + 双向柔光，控件像压在纸上',
    tone: 'neumorphic',
    dark: false,
    bg: '#E7E9F0',
    bgTop: '#E1E4EC',
    surface: '#E9EBF2',
    surfaceAlt: '#EDEFF5',
    surfaceTrans: 'rgba(233,235,242,0.95)',
    border: '#F5F6FA',
    text: '#2C3040',
    textSub: '#666C80',
    textMuted: '#949BAE',
    primary: '#5666C8',
    primaryDark: '#41509F',
    primarySoft: '#DDE1F5',
    onPrimary: '#FFFFFF',
    accent: '#7C6AC4',
    accentSoft: '#E6E1F6',
    success: '#3E8A68',
    successSoft: '#DCEFE6',
    danger: '#B4484F',
    dangerSoft: '#F4E0E2',
    warn: '#9A7524',
    warnSoft: '#F2E8D5',
    track: '#D8DBE6',
    tabBar: '#E7E9F0',
    shadowColor: '#A6ABC0',
  },
  sketch: {
    id: 'sketch',
    name: '手绘插画',
    desc: '米黄纸底 + 墨线描边 + 暖橘点缀，像手绘笔记本',
    tone: 'sketch',
    dark: false,
    bg: '#FBF5E9',
    bgTop: '#F5EBD8',
    surface: '#FFFCF4',
    surfaceAlt: '#FDF6E8',
    surfaceTrans: 'rgba(255,252,244,0.95)',
    border: '#2C2A25',
    text: '#26241F',
    textSub: '#6A6357',
    textMuted: '#9A9284',
    primary: '#D2542A',
    primaryDark: '#A63F1C',
    primarySoft: '#FAE5DA',
    onPrimary: '#FFFFFF',
    accent: '#2E6F5E',
    accentSoft: '#E2F0EA',
    success: '#2E7D4F',
    successSoft: '#E4F2E8',
    danger: '#B23A2E',
    dangerSoft: '#F8E7E3',
    warn: '#9A6B12',
    warnSoft: '#F7EEDC',
    track: '#EFE3CC',
    tabBar: '#FFFCF4',
    shadowColor: '#8C7A55',
  },
  night: {
    id: 'night',
    name: '夜航深色',
    desc: '深蓝灰底 + 青绿高光，夜间刷题不刺眼',
    tone: 'flat',
    dark: true,
    bg: '#12151B',
    bgTop: '#0E1116',
    surface: '#1B1F27',
    surfaceAlt: '#222732',
    surfaceTrans: 'rgba(27,31,39,0.94)',
    border: '#2C323D',
    text: '#EDF0F5',
    textSub: '#A3ACBB',
    textMuted: '#6D7686',
    primary: '#4FB286',
    primaryDark: '#3A8E6A',
    primarySoft: '#1E3A31',
    onPrimary: '#08130E',
    accent: '#6FA8DC',
    accentSoft: '#1E2C3B',
    success: '#4FB286',
    successSoft: '#1C332B',
    danger: '#E06A6A',
    dangerSoft: '#3A2426',
    warn: '#D9A441',
    warnSoft: '#3A3120',
    track: '#2A3038',
    tabBar: '#171B22',
    shadowColor: '#000000',
  },
};

export const THEME_ORDER: ThemeId[] = ['paper', 'neo', 'sketch', 'night'];

export const radius = { xs: 6, sm: 8, md: 12, lg: 16, xl: 22, pill: 999 };

/** 间距刻意做节奏感：8 / 12 / 16 / 22 / 30 */
export const spacing = { xs: 4, sm: 8, md: 12, lg: 16, xl: 22, xxl: 30 };

export interface ShadowSet {
  card: ViewStyle;
  raised: ViewStyle;
  float: ViewStyle;
  /** 新拟物的内凹效果 */
  inset: ViewStyle;
}

function buildShadow(p: Palette): ShadowSet {
  if (p.tone === 'neumorphic') {
    return {
      card: {
        shadowColor: '#B7BCCB',
        shadowOpacity: 0.85,
        shadowRadius: 14,
        shadowOffset: { width: 7, height: 7 },
        elevation: 3,
      },
      raised: {
        shadowColor: '#B7BCCB',
        shadowOpacity: 0.95,
        shadowRadius: 20,
        shadowOffset: { width: 10, height: 10 },
        elevation: 6,
      },
      float: {
        shadowColor: '#A9AEC0',
        shadowOpacity: 1,
        shadowRadius: 24,
        shadowOffset: { width: 12, height: 12 },
        elevation: 9,
      },
      inset: {
        shadowColor: '#C3C8D6',
        shadowOpacity: 0.7,
        shadowRadius: 6,
        shadowOffset: { width: 3, height: 3 },
        elevation: 1,
      },
    };
  }
  if (p.tone === 'sketch') {
    // 手绘风：硬边偏移投影，不做柔光
    return {
      card: {
        shadowColor: p.shadowColor,
        shadowOpacity: 0.5,
        shadowRadius: 0,
        shadowOffset: { width: 3, height: 3 },
        elevation: 0,
      },
      raised: {
        shadowColor: p.shadowColor,
        shadowOpacity: 0.55,
        shadowRadius: 0,
        shadowOffset: { width: 5, height: 5 },
        elevation: 0,
      },
      float: {
        shadowColor: p.shadowColor,
        shadowOpacity: 0.6,
        shadowRadius: 0,
        shadowOffset: { width: 6, height: 6 },
        elevation: 0,
      },
      inset: {
        shadowColor: p.shadowColor,
        shadowOpacity: 0.35,
        shadowRadius: 0,
        shadowOffset: { width: 2, height: 2 },
        elevation: 0,
      },
    };
  }
  const strength = p.dark ? 0.55 : 0.07;
  return {
    card: {
      shadowColor: p.shadowColor,
      shadowOpacity: strength,
      shadowRadius: 14,
      shadowOffset: { width: 0, height: 5 },
      elevation: 2,
    },
    raised: {
      shadowColor: p.shadowColor,
      shadowOpacity: strength + 0.06,
      shadowRadius: 22,
      shadowOffset: { width: 0, height: 10 },
      elevation: 5,
    },
    float: {
      shadowColor: p.shadowColor,
      shadowOpacity: 0.2,
      shadowRadius: 26,
      shadowOffset: { width: 0, height: 10 },
      elevation: 8,
    },
    inset: {
      shadowColor: p.shadowColor,
      shadowOpacity: 0.05,
      shadowRadius: 6,
      shadowOffset: { width: 0, height: 2 },
      elevation: 1,
    },
  };
}

export interface Theme {
  palette: Palette;
  colors: Palette;
  radius: typeof radius;
  spacing: typeof spacing;
  shadow: ShadowSet;
  tone: SurfaceTone;
  /** 卡片描边宽度：手绘风用 1.6 实线，其余用 hairline */
  borderWidth: number;
  /** 卡片圆角：新拟物更圆，手绘略方 */
  cardRadius: number;
  cardBg: string;
  chipBg: string;
}

export function buildTheme(id: ThemeId): Theme {
  const palette = PALETTES[id] ?? PALETTES.paper;
  const shadow = buildShadow(palette);
  return {
    palette,
    colors: palette,
    radius,
    spacing,
    shadow,
    tone: palette.tone,
    borderWidth: palette.tone === 'sketch' ? 1.6 : 1,
    cardRadius: palette.tone === 'neumorphic' ? radius.xl : palette.tone === 'sketch' ? radius.md : radius.lg,
    cardBg: palette.surface,
    chipBg: palette.tone === 'neumorphic' ? palette.surface : palette.surfaceAlt,
  };
}

export const DEFAULT_THEME_ID: ThemeId = 'paper';

/* ---- 兼容导出：未接入主题的模块仍可引用（默认主题） ---- */
export const colors = PALETTES.paper;
export const shadow = buildShadow(PALETTES.paper);

export const typeLabels: Record<string, string> = {
  choice: '单选题',
  tf: '判断题',
  fill: '填空题',
  short: '简答题',
};

export const typeShortLabels: Record<string, string> = {
  choice: '单选',
  tf: '判断',
  fill: '填空',
  short: '简答',
};

export const modeLabels: Record<string, string> = {
  seq: '顺序练习',
  random: '随机练习',
  memorize: '背题模式',
  wrong: '错题重练',
  exam: '模拟考试',
  review: '到期复习',
  favorite: '收藏专练',
};

export const modeDescriptions: Record<string, string> = {
  seq: '按题库原始顺序逐题作答，适合系统过一遍知识点',
  random: '打乱题目顺序，检验真实掌握程度',
  memorize: '直接显示答案与解析，适合考前快速记忆',
  wrong: '只练错题本里尚未掌握的题目，直到连对两次',
  exam: '不即时判分、整卷限时，交卷后统一出成绩',
  review: '只练按记忆曲线到期的题目，越生疏的越先出现',
  favorite: '只练你手动收藏的题目，适合考前过重点',
};
