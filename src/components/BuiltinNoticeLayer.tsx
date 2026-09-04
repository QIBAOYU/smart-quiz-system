/**
 * 内置免费模型的全局提示浮层。
 *
 * 只承载两类跨页信息：① 智谱（模型一）被限流、已自动改用千问（模型二）；
 * ② 模型二今日额度已用完、当天停用。两者都来自 quotaService 的订阅式状态，
 * 因此挂在根布局，任何页面发起的 AI 请求都能看得到。
 *
 * 位置放在底部而不是顶部：顶部是 AiTaskLayer 的常驻任务条区域，会叠在一起。
 */
import { router } from 'expo-router';
import { useEffect, useRef } from 'react';
import { Animated, Easing, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { dismissNotice, useQuota } from '../services/quotaService';
import { useTheme } from '../store/ThemeContext';

export function BuiltinNoticeLayer() {
  const { notice } = useQuota();
  const t = useTheme();
  const c = t.palette;
  const insets = useSafeAreaInsets();
  const anim = useRef(new Animated.Value(0)).current;
  const noticeId = notice?.id ?? 0;

  useEffect(() => {
    if (!noticeId) {
      anim.setValue(0);
      return;
    }
    Animated.timing(anim, {
      toValue: 1,
      duration: 220,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: false,
    }).start();
  }, [noticeId, anim]);

  if (!notice) return null;

  const danger = notice.tone === 'danger';
  const accent = danger ? c.danger : c.warn;

  return (
    <Animated.View
      pointerEvents="box-none"
      style={[
        styles.wrap,
        {
          bottom: insets.bottom + 96,
          opacity: anim,
          transform: [
            {
              translateY: anim.interpolate({ inputRange: [0, 1], outputRange: [26, 0] }),
            },
          ],
        },
      ]}
    >
      <View
        style={[
          styles.card,
          {
            backgroundColor: c.surface,
            borderColor: accent,
            borderRadius: t.radius.md,
            borderLeftWidth: 4,
          },
        ]}
      >
        <Text style={[styles.title, { color: danger ? c.danger : c.text }]} numberOfLines={1}>
          {notice.title}
        </Text>
        <Text style={[styles.message, { color: c.textSub }]}>{notice.message}</Text>
        <View style={styles.actions}>
          {notice.actionLabel && notice.actionPath ? (
            <Pressable
              accessibilityRole="button"
              onPress={() => {
                const path = notice.actionPath as string;
                dismissNotice();
                router.push(path as never);
              }}
              style={({ pressed }) => [
                styles.button,
                { backgroundColor: pressed ? c.primaryDark : c.primary, borderRadius: t.radius.pill },
              ]}
            >
              <Text style={[styles.buttonText, { color: c.onPrimary }]}>{notice.actionLabel}</Text>
            </Pressable>
          ) : null}
          <Pressable
            accessibilityRole="button"
            onPress={() => dismissNotice()}
            hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
            style={({ pressed }) => [styles.button, styles.buttonGhost, pressed ? { backgroundColor: c.surfaceAlt } : null]}
          >
            <Text style={[styles.buttonText, { color: c.textSub }]}>知道了</Text>
          </Pressable>
        </View>
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    position: 'absolute',
    left: 16,
    right: 16,
    zIndex: 60,
  },
  card: {
    paddingVertical: 12,
    paddingHorizontal: 14,
    borderWidth: 1,
    gap: 6,
  },
  title: { fontSize: 14, fontWeight: '800' },
  message: { fontSize: 12.5, lineHeight: 19 },
  actions: { flexDirection: 'row', justifyContent: 'flex-end', gap: 8, marginTop: 2 },
  button: { paddingHorizontal: 14, paddingVertical: 7 },
  buttonGhost: { borderWidth: 1, borderColor: 'transparent' },
  buttonText: { fontSize: 12.5, fontWeight: '700' },
});
