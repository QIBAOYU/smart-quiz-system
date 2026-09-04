import { Component, ReactNode } from 'react';
import { View, Text, StyleSheet } from 'react-native';

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
}

export class SafeView extends Component<Props, { hasError: boolean }> {
  state = { hasError: false };
  static getDerivedStateFromError() {
    return { hasError: true };
  }
  render() {
    if (this.state.hasError) {
      return this.props.fallback ?? (
        <View style={styles.fallback}>
          <Text style={styles.icon}>📱</Text>
          <Text style={styles.title}>该功能需要手机硬件支持</Text>
          <Text style={styles.desc}>网页端无法展示，请扫码用手机预览完整体验</Text>
        </View>
      );
    }
    return this.props.children;
  }
}

const styles = StyleSheet.create({
  fallback: { padding: 24, alignItems: 'center', justifyContent: 'center', backgroundColor: '#fffbeb', borderRadius: 12, borderWidth: 1, borderColor: '#fde68a', gap: 6 },
  icon: { fontSize: 28 },
  title: { fontSize: 14, fontWeight: '600', color: '#92400e', textAlign: 'center' },
  desc: { fontSize: 12, color: '#b45309', textAlign: 'center', lineHeight: 18 },
});
