/** 底部三 Tab：题库 / 统计 / 设置。图标用 react-native-svg 自绘，配色跟随用户所选主题 */
import React from 'react';
import { StyleSheet } from 'react-native';
import { Tabs } from 'expo-router';
import { ChartIcon, GearIcon, HomeIcon } from '../../components/icons';
import { useTheme } from '../../store/ThemeContext';

export default function TabsLayout() {
  const t = useTheme();
  const c = t.palette;

  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: c.primary,
        tabBarInactiveTintColor: c.textMuted,
        // 默认 JS tabBar 实现不接受自定义容器，只能靠 palette.tabBar 做纯色底
        tabBarStyle: {
          backgroundColor: c.tabBar,
          borderTopColor: c.border,
          borderTopWidth: StyleSheet.hairlineWidth,
          height: 62,
          paddingTop: 6,
          ...t.shadow.float,
        },
        tabBarItemStyle: { paddingVertical: 2 },
        tabBarLabelStyle: { fontSize: 11, fontWeight: '600' },
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: '题库',
          tabBarIcon: ({ focused }) => <HomeIcon size={22} color={focused ? c.primary : c.textMuted} />,
        }}
      />
      <Tabs.Screen
        name="stats"
        options={{
          title: '统计',
          tabBarIcon: ({ focused }) => <ChartIcon size={22} color={focused ? c.primary : c.textMuted} />,
        }}
      />
      <Tabs.Screen
        name="settings"
        options={{
          title: '设置',
          tabBarIcon: ({ focused }) => <GearIcon size={22} color={focused ? c.primary : c.textMuted} />,
        }}
      />
    </Tabs>
  );
}
