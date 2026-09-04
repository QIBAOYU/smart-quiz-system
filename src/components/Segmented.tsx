/**
 * 分段切换（TAB 栏）：错题本、首页题库列表、统计页分题库表现共用同一套视觉。
 * 胶囊底槽走 track，选中项浮起 surface，与主题四套风格一致。
 */
import React, { useMemo } from 'react';
import { Pressable, StyleSheet, Text, View, type ViewStyle } from 'react-native';
import type { Theme } from '../constants/theme';
import { useTheme } from '../store/ThemeContext';

export interface SegmentedOption<T extends string> {
  value: T;
  label: string;
}

interface Props<T extends string> {
  options: Array<SegmentedOption<T>>;
  value: T;
  onChange: (value: T) => void;
  /** true = 占满父容器宽度并等分；false = 按内容自适应宽度 */
  stretch?: boolean;
  style?: ViewStyle;
}

export function Segmented<T extends string>({ options, value, onChange, stretch = false, style }: Props<T>) {
  const t = useTheme();
  const styles = useMemo(() => buildStyles(t), [t]);

  return (
    <View style={[styles.wrap, stretch ? styles.wrapStretch : null, style]}>
      {options.map((o) => {
        const active = o.value === value;
        return (
          <Pressable
            key={o.value}
            accessibilityRole="button"
            onPress={() => onChange(o.value)}
            style={[styles.item, stretch ? styles.itemStretch : null, active ? styles.itemActive : null]}
          >
            <Text style={[styles.text, active ? styles.textActive : null]} numberOfLines={1}>
              {o.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

function buildStyles(t: Theme) {
  const c = t.palette;
  const r = t.radius;
  const sp = t.spacing;
  return StyleSheet.create({
    wrap: {
      flexDirection: 'row',
      alignSelf: 'flex-start',
      padding: 3,
      borderRadius: r.pill,
      backgroundColor: c.track,
    },
    wrapStretch: { alignSelf: 'stretch' },
    item: { paddingHorizontal: sp.lg, paddingVertical: 6, borderRadius: r.pill },
    itemStretch: { flex: 1, alignItems: 'center' },
    itemActive: { backgroundColor: c.surface, ...t.shadow.raised },
    text: { fontSize: 12.5, fontWeight: '700', color: c.textMuted },
    textActive: { color: c.primaryDark },
  });
}
