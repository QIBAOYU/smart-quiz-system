/**
 * 修改密码：原密码验证 + 设置新密码。
 *
 * 界面全程只讲「账号」，不出现邮箱；提交时先拿原密码做一次登录校验，
 * 通过后才会写新密码，失败只提示中文原因、绝不展示原始报错。
 */
import React, { useState } from 'react';
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
import { dialog } from '../components/dialog';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import { Card, PrimaryButton } from '../components/ui';
import { useTheme } from '../store/ThemeContext';
import { passwordError, useAuth } from '../store/AuthContext';

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

export default function ChangePasswordScreen() {
  const insets = useSafeAreaInsets();
  const t = useTheme();
  const c = t.palette;
  const { username, changePassword } = useAuth();

  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [reveal, setReveal] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (busy) return;
    const invalid =
      (!current ? '请输入原密码' : null) ??
      passwordError(next) ??
      (next !== confirm ? '两次输入的新密码不一致' : null);
    if (invalid) {
      setError(invalid);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await changePassword(current, next);
      if (result) {
        setError(result);
        return;
      }
      setCurrent('');
      setNext('');
      setConfirm('');
      dialog.alert('密码已修改', '新密码已生效，当前设备无需重新登录。其他设备下次同步时会要求用新密码重新登录。', [
        { text: '知道了', onPress: () => router.back() },
      ]);
    } catch (err) {
      console.error('[change-password] 提交失败:', err);
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
      <View style={[styles.header, { paddingTop: insets.top + 8, borderBottomColor: c.border }]}>
        <Pressable
          accessibilityRole="button"
          onPress={() => router.back()}
          style={({ pressed }) => [styles.back, { opacity: pressed ? 0.6 : 1 }]}
        >
          <Text style={[styles.backText, { color: c.textSub }]}>‹ 返回</Text>
        </Pressable>
        <Text style={[styles.headerTitle, { color: c.text }]}>修改密码</Text>
        <View style={styles.headerGap} />
      </View>

      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
        contentContainerStyle={[styles.scroll, { paddingHorizontal: 18 }]}
      >
        <Card style={{ marginTop: 18, gap: 12 }}>
          <Text style={[styles.lead, { color: c.textSub }]}>
            账号「{username ?? '当前账号'}」的密码。为防止误改，需要先验证原密码。
          </Text>

          <View style={styles.labelRow}>
            <Text style={[styles.label, { color: c.textSub }]}>原密码</Text>
            <Pressable accessibilityRole="button" onPress={() => setReveal((v) => !v)}>
              <Text style={[styles.link, { color: c.primary }]}>{reveal ? '隐藏' : '显示'}</Text>
            </Pressable>
          </View>
          <Field
            value={current}
            onChangeText={setCurrent}
            placeholder="输入当前使用的密码"
            secure={!reveal}
            onEnter={submit}
            color={c.text}
            border={c.border}
            sub={c.textMuted}
          />

          <View style={[styles.labelRow, { marginTop: 6 }]}>
            <Text style={[styles.label, { color: c.textSub }]}>新密码</Text>
            <Text style={[styles.labelHint, { color: c.textMuted }]}>至少 6 位</Text>
          </View>
          <Field
            value={next}
            onChangeText={setNext}
            placeholder="设置一个新密码"
            secure={!reveal}
            onEnter={submit}
            color={c.text}
            border={c.border}
            sub={c.textMuted}
          />

          <View style={[styles.labelRow, { marginTop: 6 }]}>
            <Text style={[styles.label, { color: c.textSub }]}>确认新密码</Text>
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

          {error ? (
            <View style={[styles.errorBox, { backgroundColor: c.dangerSoft, borderRadius: t.radius.sm }]}>
              <Text style={[styles.errorText, { color: c.danger }]}>{error}</Text>
            </View>
          ) : null}

          <PrimaryButton label={busy ? '提交中…' : '确认修改'} onPress={submit} loading={busy} style={{ marginTop: 4 }} />
        </Card>

        <Text style={[styles.footnote, { color: c.textMuted }]}>
          密码只在提交时用于校验与更新，不会保存在本机或写入任何题库数据。
          {'\n'}当前版本仍不支持自助找回密码，改完请记下新密码。
        </Text>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14, paddingBottom: 10, borderBottomWidth: StyleSheet.hairlineWidth },
  back: { minWidth: 56 },
  backText: { fontSize: 15, fontWeight: '600' },
  headerTitle: { flex: 1, textAlign: 'center', fontSize: 16.5, fontWeight: '700' },
  headerGap: { width: 56 },
  scroll: { paddingBottom: 48 },
  lead: { fontSize: 12.5, lineHeight: 19 },
  labelRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  label: { fontSize: 12.5, fontWeight: '600' },
  labelHint: { fontSize: 11.5 },
  link: { fontSize: 12.5, fontWeight: '600' },
  field: { paddingHorizontal: 12 },
  input: { height: 46, fontSize: 15.5 },
  errorBox: { paddingHorizontal: 12, paddingVertical: 10 },
  errorText: { fontSize: 13, lineHeight: 19 },
  footnote: { fontSize: 12, lineHeight: 19, marginTop: 18 },
});
