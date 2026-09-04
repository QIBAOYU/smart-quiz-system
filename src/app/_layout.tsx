import '../embeddedAssetResolver';
import { reportJsError } from '../jsErrorReporter';
import { router, Stack, usePathname } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { View, Text, StyleSheet, Platform, ActivityIndicator } from 'react-native';
import { useEffect } from 'react';
import { AppProvider } from '../store/AppContext';
import { AuthProvider, useAuth } from '../store/AuthContext';
import { ThemeProvider, useTheme } from '../store/ThemeContext';
import { AiTaskLayer } from '../components/AiTaskLayer';
import { BuiltinNoticeLayer } from '../components/BuiltinNoticeLayer';
import { DialogHost } from '../components/dialog';
import { loadAiConfig } from '../services/aiConfig';
import { refreshQuota } from '../services/quotaService';

type WebRuntimeGlobal = typeof globalThis & {
  __ONEDAY_WEB_NATIVE_ERROR_SUPPRESSOR_INSTALLED__?: boolean;
};

const WEB_NATIVE_MODULE_ERROR_PATTERNS = [
  /Native module.*cannot be null/i,
  /Native module.*not available/i,
  /turboModuleProxy/i,
  /TurboModuleRegistry/i,
  /requireNativeModule/i,
];

function formatConsoleArgs(args: unknown[]): string {
  return args
    .map((arg) => {
      if (arg instanceof Error) return `${arg.name}: ${arg.message}`;
      if (typeof arg === 'string') return arg;
      try {
        return JSON.stringify(arg);
      } catch {
        return String(arg);
      }
    })
    .join(' ');
}

function isWebNativeModuleError(args: unknown[]): boolean {
  const message = formatConsoleArgs(args);
  return WEB_NATIVE_MODULE_ERROR_PATTERNS.some((pattern) => pattern.test(message));
}

function installWebNativeErrorSuppressor(): void {
  const runtimeGlobal = globalThis as WebRuntimeGlobal;
  if (runtimeGlobal.__ONEDAY_WEB_NATIVE_ERROR_SUPPRESSOR_INSTALLED__) return;
  runtimeGlobal.__ONEDAY_WEB_NATIVE_ERROR_SUPPRESSOR_INSTALLED__ = true;

  const originalConsoleError = console.error.bind(console);
  console.error = (...args: unknown[]) => {
    if (isWebNativeModuleError(args)) {
      reportJsError('web-suppressed-console.error', args, false);
      console.warn('[web-native-module-unavailable]', ...args);
      return;
    }
    originalConsoleError(...args);
  };
}

// Web 端只降噪“原生模块不可用”这类模板环境问题。
// 普通 React/runtime 错误继续保留 RedBox，避免隐藏真实 bug。
if (Platform.OS === 'web') {
  installWebNativeErrorSuppressor();
}

export function ErrorBoundary({ error }: { error: Error }) {
  const isWeb = Platform.OS === 'web';

  return (
    <View style={styles.fallback}>
      <Text style={styles.emoji}>{isWeb ? '📱' : '🔧'}</Text>
      <Text style={styles.title}>
        {isWeb ? '该功能需要手机硬件支持' : '应用遇到错误'}
      </Text>
      <Text style={styles.msg}>
        {isWeb
          ? '网页端无法展示此功能，请扫码用手机预览完整体验'
          : '出现错误，让AI自动修复'}
      </Text>
      {error?.message && !isWeb && (
        <Text style={styles.errorDetail}>{error.message}</Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  fallback: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#fffbeb',
    padding: 32,
    borderWidth: 1,
    borderColor: '#fde68a',
  },
  emoji: { fontSize: 48, marginBottom: 16 },
  title: {
    fontSize: 18,
    fontWeight: '600',
    color: '#92400e',
    marginBottom: 8,
    textAlign: 'center'
  },
  msg: {
    fontSize: 15,
    color: '#b45309',
    textAlign: 'center',
    lineHeight: 22
  },
  errorDetail: {
    marginTop: 16,
    fontSize: 12,
    color: '#9ca3af',
    textAlign: 'center',
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  },
  gate: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 14,
  },
  gateLogo: {
    width: 58,
    height: 58,
    borderRadius: 17,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 6,
  },
  gateMark: { fontSize: 25, fontWeight: '800' },
  gateText: { fontSize: 13 },
});

function ThemedShell() {
  const theme = useTheme();
  const { ready, userId } = useAuth();
  const pathname = usePathname();

  useEffect(() => {
    // 启动即读取本机 AI 供应商配置，首页胶囊才能立刻显示真实模式
    loadAiConfig().catch((error) => console.error('[layout] AI 配置载入失败:', error));
    // 模型二（千问）每人每天 2 次，额度在服务端计数；启动时拉一次供配置页展示
    void refreshQuota();
  }, []);

  // 登录门禁：会话恢复完成后，未登录只能停在 /auth，已登录不再停留在 /auth。
  // 判定用 ready 三态，恢复期间不跳转，避免「跳走→回来」的往复。
  useEffect(() => {
    if (!ready) return;
    if (!userId && pathname !== '/auth') router.replace('/auth');
    if (userId && pathname === '/auth') router.replace('/');
  }, [ready, userId, pathname]);

  const p = theme.palette;

  return (
    <View style={{ flex: 1, backgroundColor: p.bg }}>
      <StatusBar style={p.dark ? 'light' : 'dark'} />
      <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: p.bg } }} />
      {/* 任务条挂在根布局：导入页、刷题页、统计页都能持续看到后台 AI 进度 */}
      <AiTaskLayer />
      {/* 全局唯一弹窗宿主：所有提示走它，返回键与遮罩都能正常关闭 */}
      <DialogHost />
      {/* 内置免费模型的额度提示：模型一被限流 / 模型二今日停用 */}
      <BuiltinNoticeLayer />
      {/* 会话恢复期间盖一层，避免先闪一下空的题库列表 */}
      {!ready ? (
        <View style={[styles.gate, { backgroundColor: p.bg }]}>
          <View style={[styles.gateLogo, { backgroundColor: p.primary }]}>
            <Text style={[styles.gateMark, { color: p.onPrimary }]}>刷</Text>
          </View>
          <ActivityIndicator color={p.primary} />
          <Text style={[styles.gateText, { color: p.textMuted }]}>正在恢复登录状态…</Text>
        </View>
      ) : null}
    </View>
  );
}

export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <ThemeProvider>
        <AuthProvider>
          <AppProvider>
            <ThemedShell />
          </AppProvider>
        </AuthProvider>
      </ThemeProvider>
    </SafeAreaProvider>
  );
}
