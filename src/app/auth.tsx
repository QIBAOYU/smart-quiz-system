/**
 * 登录 / 注册页：账号 + 密码。
 * 账号会被换成虚拟邮箱交给平台认证，界面全程只讲「账号」，不出现邮箱字样。
 */
import React, { useEffect, useState } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Card, PrimaryButton } from '../components/ui';
import { useTheme } from '../store/ThemeContext';
import { accountError, normalizeAccount, passwordError, useAuth } from '../store/AuthContext';

type Mode = 'login' | 'register';

function Field({
  value,
  onChangeText,
  placeholder,
  secure,
  onEnter,
  color,
  border,
  sub,
}: {
  value: string;
  onChangeText: (v: string) => void;
  placeholder: string;
  secure?: boolean;
  onEnter: () => void;
  color: string;
  border: string;
  sub: string;
}) {
  const t = useTheme();
  const [focused, setFocused] = useState(false);
  return (
    <View
      style={[
        styles.field,
        {
          backgroundColor: t.chipBg,
          borderColor: focused ? color : border,
          borderWidth: focused ? 1.6 : t.borderWidth,
          borderRadius: t.tone === 'sketch' ? t.radius.md : t.radius.sm,
        },
      ]}
    >
      <TextInput
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={sub}
        secureTextEntry={secure}
        autoCapitalize="none"
        autoCorrect={false}
        spellCheck={false}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onSubmitEditing={onEnter}
        returnKeyType="done"
        style={[styles.input, { color }]}
      />
    </View>
  );
}

export default function AuthScreen() {
  const insets = useSafeAreaInsets();
  const t = useTheme();
  const c = t.palette;
  const { userId, ready, signIn, signUp } = useAuth();

  const [mode, setMode] = useState<Mode>('login');
  const [account, setAccount] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [reveal, setReveal] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (ready && userId) router.replace('/');
  }, [ready, userId]);

  const switchMode = (next: Mode) => {
    setMode(next);
    setError(null);
  };

  const submit = async () => {
    if (busy) return;
    const invalid =
      accountError(normalizeAccount(account)) ??
      passwordError(password) ??
      (mode === 'register' && password !== confirm ? '两次输入的密码不一致' : null);
    if (invalid) {
      setError(invalid);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result =
        mode === 'login'
          ? await signIn(account, password)
          : await signUp(account, password);
      if (result) {
        setError(result);
        return;
      }
      router.replace('/');
    } catch (err) {
      console.error('[auth] 提交失败:', err);
      setError('操作未完成，请稍后重试');
    } finally {
      setBusy(false);
    }
  };

  return (
    <KeyboardAvoidingView
      style={{ flex: 1, backgroundColor: c.bg }}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
        contentContainerStyle={[styles.scroll, { paddingTop: insets.top + 46, paddingHorizontal: 22 }]}
      >
        <View style={[styles.logo, { backgroundColor: c.primary, ...t.shadow.raised }]}>
          <Text style={[styles.logoText, { color: c.onPrimary }]}>刷</Text>
        </View>
        <Text style={[styles.title, { color: c.text }]}>智能刷题系统</Text>
        <Text style={[styles.subtitle, { color: c.textSub }]}>
          把手里的 Word / PDF 试卷，变成能刷题、能判分、能盯错题的练习本
        </Text>

        <View style={[styles.tabs, { backgroundColor: c.track, borderRadius: t.radius.pill }]}>
          {(['login', 'register'] as Mode[]).map((m) => {
            const active = mode === m;
            return (
              <Pressable
                key={m}
                accessibilityRole="button"
                onPress={() => switchMode(m)}
                style={[
                  styles.tab,
                  {
                    backgroundColor: active ? c.surface : 'transparent',
                    borderRadius: t.radius.pill,
                    borderWidth: active ? t.borderWidth : 0,
                    borderColor: c.border,
                  },
                ]}
              >
                <Text style={[styles.tabText, { color: active ? c.text : c.textMuted }]}>
                  {m === 'login' ? '登录' : '注册'}
                </Text>
              </Pressable>
            );
          })}
        </View>

        <Card style={{ marginTop: 18, gap: 12 }}>
          <View style={styles.labelRow}>
            <Text style={[styles.label, { color: c.textSub }]}>账号</Text>
            <Text style={[styles.labelHint, { color: c.textMuted }]}>3-20 位字母或数字</Text>
          </View>
          <Field
            value={account}
            onChangeText={setAccount}
            placeholder="给自己起一个登录账号"
            onEnter={submit}
            color={c.text}
            border={c.border}
            sub={c.textMuted}
          />

          <View style={[styles.labelRow, { marginTop: 6 }]}>
            <Text style={[styles.label, { color: c.textSub }]}>密码</Text>
            <Pressable accessibilityRole="button" onPress={() => setReveal((v) => !v)}>
              <Text style={[styles.labelHint, { color: c.primary }]}>{reveal ? '隐藏' : '显示'}</Text>
            </Pressable>
          </View>
          <Field
            value={password}
            onChangeText={setPassword}
            placeholder="至少 6 位"
            secure={!reveal}
            onEnter={submit}
            color={c.text}
            border={c.border}
            sub={c.textMuted}
          />

          {mode === 'register' ? (
            <>
              <View style={[styles.labelRow, { marginTop: 6 }]}>
                <Text style={[styles.label, { color: c.textSub }]}>确认密码</Text>
              </View>
              <Field
                value={confirm}
                onChangeText={setConfirm}
                placeholder="再输入一次"
                secure={!reveal}
                onEnter={submit}
                color={c.text}
                border={c.border}
                sub={c.textMuted}
              />
            </>
          ) : null}

          {error ? (
            <View style={[styles.errorBox, { backgroundColor: c.dangerSoft, borderRadius: t.radius.sm }]}>
              <Text style={[styles.errorText, { color: c.danger }]}>{error}</Text>
            </View>
          ) : null}

          <PrimaryButton
            label={mode === 'login' ? '登录' : '注册并进入'}
            onPress={submit}
            loading={busy}
            style={{ marginTop: 4 }}
          />
        </Card>

        <Text style={[styles.footnote, { color: c.textMuted }]}>
          题库、做题记录、错题本与练习进度都挂在这个账号下，换设备登录即可继续。
          {'\n'}当前版本不支持自助找回密码；登录后可以在设置页修改密码。
        </Text>
        <View style={[styles.credit, { backgroundColor: c.border }]} />
        <Text style={[styles.creditText, { color: c.textMuted }]}>本软件由雨不一制作</Text>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  scroll: { paddingBottom: 48 },
  logo: {
    width: 62,
    height: 62,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    alignSelf: 'center',
    marginBottom: 14,
  },
  logoText: { fontSize: 27, fontWeight: '800' },
  title: { fontSize: 23, fontWeight: '800', textAlign: 'center' },
  subtitle: { fontSize: 13, lineHeight: 20, textAlign: 'center', marginTop: 8 },
  tabs: { flexDirection: 'row', padding: 4, marginTop: 24 },
  tab: { flex: 1, height: 38, alignItems: 'center', justifyContent: 'center' },
  tabText: { fontSize: 14.5, fontWeight: '700' },
  labelRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  label: { fontSize: 12.5, fontWeight: '600' },
  labelHint: { fontSize: 11.5 },
  field: { paddingHorizontal: 12 },
  input: { height: 46, fontSize: 15.5 },
  errorBox: { paddingHorizontal: 12, paddingVertical: 10 },
  errorText: { fontSize: 13, lineHeight: 19 },
  footnote: { fontSize: 12, lineHeight: 19, marginTop: 20, textAlign: 'center' },
  credit: { height: StyleSheet.hairlineWidth, width: '55%', marginTop: 26, alignSelf: 'center' },
  creditText: { fontSize: 12, letterSpacing: 1.2, fontWeight: '600', textAlign: 'center', marginTop: 12 },
});
