/**
 * 主题化弹窗：替代 RN 原生 Alert.alert。
 *
 * 原生 Alert 的两个硬伤（实机暴露）：
 * 1. 外观由系统渲染，白底 + 超大右对齐按钮，完全不跟随 App 配色；按钮一多，
 *    「取消」会被挤出屏幕外，用户找不到退出入口。
 * 2. Android 上按系统返回键只是把原生 Dialog 隐藏，弹窗窗口仍留在视图层级里
 *    拦截触摸，表现为「页面卡住、点什么都没反应」。
 *
 * 这里用 RN Modal 自绘：返回键走 onRequestClose 明确关闭，遮罩点击也能关，
 * 按钮纵向排列且取消常驻，配色全部取自当前主题。
 *
 * 需要用户输入时走 prompt（原生 Alert 的输入框在 Android 上弹不出键盘）：
 * Modal 里的 TextInput 用 autoFocus 常常拿不到焦点，因此改成动画结束后
 * 用 ref 主动 focus，并把卡片在输入态锚到屏幕上方，避免被软键盘盖住。
 *
 * 调用方式与 Alert.alert 一致，替换成本为零：
 *   dialog.alert('标题', '说明', [{ text: '取消', style: 'cancel' }, { text: '好', onPress }])
 *   dialog.prompt({ title: '重命名', defaultValue: 'x', onSubmit: (v) => ... })
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { Theme } from '../constants/theme';
import { useTheme } from '../store/ThemeContext';

export interface DialogButton {
  text: string;
  style?: 'default' | 'cancel' | 'destructive';
  /** true = 输入弹框里的提交按钮，软键盘「完成」等价于点它 */
  primary?: boolean;
  /** 输入弹框会把用户填的内容回传，普通弹框固定收到空串 */
  onPress?: (value: string) => void;
}

interface InputSpec {
  placeholder: string;
  defaultValue: string;
  maxLength: number;
  emptyHint: string;
}

interface Spec {
  title?: string;
  message?: string;
  buttons: DialogButton[];
  input?: InputSpec;
}

export interface PromptOptions {
  title: string;
  message?: string;
  placeholder?: string;
  defaultValue?: string;
  maxLength?: number;
  submitText?: string;
  cancelText?: string;
  /** 内容为空时的提示文案，默认通用一句 */
  emptyHint?: string;
  onSubmit: (value: string) => void;
}

let pushSpec: ((s: Spec) => void) | null = null;

function show(spec: Spec): void {
  if (!pushSpec) {
    // 宿主未挂载（理论上不会发生）时只记日志，绝不退回原生弹窗：
    // 原生弹窗正是当初要替换掉的东西，退回等于把老问题带回来
    console.error('[dialog] DialogHost 未挂载，弹窗已丢弃');
    return;
  }
  pushSpec(spec);
}

export const dialog = {
  alert(title?: string, message?: string, buttons?: DialogButton[]): void {
    show({ title, message, buttons: buttons && buttons.length > 0 ? buttons : [{ text: '知道了' }] });
  },

  prompt(options: PromptOptions): void {
    const submitText = options.submitText ?? '确定';
    show({
      title: options.title,
      message: options.message,
      input: {
        placeholder: options.placeholder ?? '',
        defaultValue: options.defaultValue ?? '',
        maxLength: options.maxLength ?? 40,
        emptyHint: options.emptyHint ?? '内容不能为空，请先输入。',
      },
      buttons: [
        {
          text: submitText,
          primary: true,
          onPress: (value) => {
            options.onSubmit(value);
          },
        },
        { text: options.cancelText ?? '取消', style: 'cancel' },
      ],
    });
  },
};

export function DialogHost() {
  const t = useTheme();
  const c = t.palette;
  const styles = useMemo(() => buildStyles(t), [t]);
  const insets = useSafeAreaInsets();
  const [spec, setSpec] = useState<Spec | null>(null);
  const [value, setValue] = useState('');
  const [inputError, setInputError] = useState('');
  const inputRef = useRef<TextInput>(null);

  useEffect(() => {
    pushSpec = setSpec;
    return () => {
      pushSpec = null;
    };
  }, []);

  // 每次弹出都重置输入内容，并在 Modal 淡入动画结束后主动抢焦点
  useEffect(() => {
    if (!spec?.input) return undefined;
    setValue(spec.input.defaultValue);
    setInputError('');
    const timer = setTimeout(() => inputRef.current?.focus(), 280);
    return () => clearTimeout(timer);
  }, [spec]);

  const dismiss = useCallback(() => {
    setSpec(null);
  }, []);

  const tap = useCallback(
    (btn: DialogButton) => {
      const current = spec;
      const text = value.trim();
      // 输入弹框里空内容不许提交：关窗等于「什么都没发生」，用户会以为按钮坏了
      if (current?.input && btn.style !== 'cancel' && !text) {
        setInputError(current.input.emptyHint);
        return;
      }
      setSpec(null);
      if (current && btn.onPress) {
        // 先关窗再执行回调，避免回调里再弹一个窗时被上一次状态覆盖
        setTimeout(() => btn.onPress?.(text), 30);
      }
    },
    [spec, value],
  );

  const buttons = spec?.buttons ?? [];
  const confirms = buttons.filter((b) => b.style !== 'cancel');
  const cancels = buttons.filter((b) => b.style === 'cancel');
  const inputSpec = spec?.input;
  const submitBtn = confirms.find((b) => b.primary) ?? confirms[0];

  const card = (
    <View style={styles.card}>
      {spec?.title ? <Text style={styles.title}>{spec.title}</Text> : null}
      {spec?.message ? (
        <ScrollView style={styles.msgScroll} bounces={false} keyboardShouldPersistTaps="handled">
          <Text style={styles.message}>{spec.message}</Text>
        </ScrollView>
      ) : null}

      {inputSpec ? (
        <View style={styles.inputWrap}>
          <TextInput
            ref={inputRef}
            style={[styles.input, { color: c.text, borderColor: inputError ? c.danger : c.border }]}
            value={value}
            onChangeText={(v) => {
              setValue(v);
              if (inputError) setInputError('');
            }}
            placeholder={inputSpec.placeholder}
            placeholderTextColor={c.textMuted}
            maxLength={inputSpec.maxLength}
            autoCorrect={false}
            returnKeyType="done"
            keyboardAppearance={c.dark ? 'dark' : 'light'}
            onSubmitEditing={() => {
              if (submitBtn) tap(submitBtn);
            }}
          />
          {inputError ? <Text style={styles.inputError}>{inputError}</Text> : null}
        </View>
      ) : null}

      <View style={styles.btnGroup}>
        {confirms.map((b, i) => {
          const destructive = b.style === 'destructive';
          return (
            <Pressable
              key={`c_${i}_${b.text}`}
              accessibilityRole="button"
              onPress={() => tap(b)}
              style={({ pressed }) => [
                styles.btn,
                i > 0 ? styles.btnDivided : null,
                pressed ? styles.btnPressed : null,
              ]}
            >
              <Text style={[styles.btnText, destructive ? styles.btnTextDanger : null]}>{b.text}</Text>
            </Pressable>
          );
        })}
        {cancels.map((b, i) => (
          <Pressable
            key={`x_${i}_${b.text}`}
            accessibilityRole="button"
            onPress={() => tap(b)}
            style={({ pressed }) => [styles.btn, styles.btnDivided, styles.btnCancelBox, pressed ? styles.btnPressed : null]}
          >
            <Text style={[styles.btnText, styles.btnTextCancel]}>{b.text}</Text>
          </Pressable>
        ))}
      </View>
    </View>
  );

  return (
    <Modal
      visible={spec !== null}
      transparent
      animationType="fade"
      statusBarTranslucent
      onRequestClose={dismiss}
    >
      <Pressable
        accessibilityRole="button"
        onPress={dismiss}
        style={[
          styles.backdrop,
          {
            paddingTop: insets.top + (inputSpec ? 36 : 0),
            // 输入态把卡片锚到上方，软键盘弹出时才不会压住输入框
            justifyContent: inputSpec ? 'flex-start' : 'center',
          },
        ]}
      >
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          style={styles.keyboardBox}
        >
          <Pressable onPress={(e) => e.stopPropagation()} style={styles.cardWrap}>
            <View style={styles.cardSolid}>{card}</View>
          </Pressable>
        </KeyboardAvoidingView>
      </Pressable>
    </Modal>
  );
}

function buildStyles(t: Theme) {
  const c = t.palette;
  const r = t.radius;
  const sp = t.spacing;
  const solid = {
    backgroundColor: c.surface,
    borderRadius: t.cardRadius,
    borderWidth: t.borderWidth,
    borderColor: c.border,
    paddingTop: sp.xl,
    paddingHorizontal: sp.lg,
    paddingBottom: sp.sm,
    width: '86%' as const,
    maxWidth: 380,
    overflow: 'hidden' as const,
    ...t.shadow.float,
  };
  return StyleSheet.create({
    backdrop: {
      flex: 1,
      backgroundColor: c.dark ? 'rgba(0,0,0,0.62)' : 'rgba(15,20,25,0.42)',
      alignItems: 'center',
      justifyContent: 'center',
      paddingHorizontal: sp.xl,
    },
    keyboardBox: { width: '100%', alignItems: 'center' },
    cardWrap: { width: '100%', alignItems: 'center' },
    cardSolid: solid,
    card: { width: '100%' },
    title: {
      fontSize: 17,
      fontWeight: '800',
      color: c.text,
      lineHeight: 24,
      paddingHorizontal: sp.xs,
      marginBottom: sp.xs,
    },
    msgScroll: { maxHeight: 260 },
    message: {
      fontSize: 14,
      lineHeight: 22,
      color: c.textSub,
      paddingHorizontal: sp.xs,
      marginBottom: sp.md,
    },
    inputWrap: { marginBottom: sp.md, paddingHorizontal: sp.xs },
    input: {
      height: 46,
      borderWidth: 1,
      borderRadius: r.md,
      paddingHorizontal: sp.md,
      fontSize: 15.5,
      backgroundColor: c.surfaceAlt,
    },
    inputError: { fontSize: 11.5, color: c.danger, marginTop: 4 },
    btnGroup: { marginTop: sp.xs },
    btn: {
      height: 48,
      alignItems: 'center',
      justifyContent: 'center',
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: c.border,
    },
    btnDivided: { marginTop: 0 },
    btnCancelBox: { marginTop: sp.sm, borderTopWidth: 0, backgroundColor: c.surfaceAlt, borderRadius: r.md },
    btnPressed: { opacity: 0.72 },
    btnText: { fontSize: 15.5, fontWeight: '700', color: c.primary },
    btnTextDanger: { color: c.danger },
    btnTextCancel: { color: c.textSub, fontWeight: '600' },
  });
}
