/**
 * 原生组件占位卡
 *
 * 1:1 替换 native-only 组件的导出。核心契约是「保住布局」而不是「模拟行为」：
 * 透传 style 与 children 以继承父容器给定的位置和大小，自身不带来额外语义。
 * 组件没有显式尺寸时（intrinsic size 场景）用 minHeight 兜底，避免整块塌陷。
 */

import React from 'react';
import { Text, View } from 'react-native';
import { reportComponentRendered } from './report';

const CARD_STYLE = {
  minHeight: 64,
  borderWidth: 1,
  borderStyle: 'dashed',
  borderColor: '#C7C7CC',
  borderRadius: 8,
  backgroundColor: '#F7F7F9',
  alignItems: 'center',
  justifyContent: 'center',
  paddingHorizontal: 12,
  paddingVertical: 10,
};

const TITLE_STYLE = { fontSize: 13, color: '#3A3A3C', textAlign: 'center' };
const HINT_STYLE = { fontSize: 11, color: '#8E8E93', textAlign: 'center', marginTop: 2 };

/**
 * 占位卡第二行的三档文案。
 *
 * 文案沉在 runtime 而不是各 stub 里硬写，是为了「改口径只改一处」：措辞由产品口径决定，
 * 而落点分散在十几个 stub 上，硬写必然漂移。stub 只引用常量、不写字面量。
 *
 * 为什么默认档是「装测试包可看真实效果」而不是「发布为正式 App 后可正常使用」：
 * 模板 APK 是固定壳 + 注入 JS bundle（不做 per-project 原生编译），壳里已实证编入
 * expo.modules.ui / RNCWebView / lottie / rnsvg 等白名单原生模块，因此白名单内的能力
 * 在**测试包**上当下就能看到真实效果，不必等正式发布。把门槛说成「发布正式 App」
 * 是自贬，也会把用户推去走一趟没有必要的发布流程。
 *
 * 平台档只用于「该组件本身就是单平台原生视图」的包（SwiftUI / Jetpack Compose 这类）：
 * 这类组件在另一端的测试包上同样不存在，不点名平台会给出做不到的承诺。
 * 措辞刻意不写「暂未开放」——双端通道均已开放，缺的是平台对应关系而不是排期。
 */
export const PLACEHOLDER_HINTS = {
  default: '装测试包可看真实效果',
  ios: 'iOS 专用组件，装 iOS 测试包可看真实效果',
  android: 'Android 专用组件，装 Android 测试包可看真实效果',
};

export function createPlaceholderComponent(options) {
  const packageName = options.package;
  const componentName = options.componentName;
  const viaFallback = Boolean(options.viaFallback);
  // hint 只接受最终文案字符串（由 PLACEHOLDER_HINTS 提供），不接受档位枚举：
  // 多一层枚举映射就多一处可以写错、且写错时静默降级为默认档的地方。
  const hint = typeof options.hint === 'string' && options.hint ? options.hint : PLACEHOLDER_HINTS.default;

  function NativePlaceholder(props) {
    const { style, children } = props || {};

    React.useEffect(() => {
      reportComponentRendered({ package: packageName, componentName, viaFallback });
    }, []);

    return React.createElement(
      View,
      { style: [CARD_STYLE, style] },
      React.createElement(Text, { style: TITLE_STYLE }, componentName + ' 需要真机预览'),
      React.createElement(Text, { style: HINT_STYLE }, hint),
      children
    );
  }

  NativePlaceholder.displayName = 'NativePlaceholder(' + componentName + ')';
  return NativePlaceholder;
}
