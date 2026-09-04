/**
 * @expo/ui/swift-ui 的 web 降级 stub
 *
 * SwiftUI 层是 iOS 专用的原生视图，web 端求值即抛 requireNativeViewManager。
 * 显式导出覆盖常用组件，其余长尾导出由文件内 Proxy fallback 兜住：漏名只会让
 * 体验略糙（占位卡命名仍带导出名），不会整页崩溃。
 *
 * 占位卡走 iOS 档文案：这批组件在 Android 测试包上同样不存在，用默认档的
 * 「装测试包可看真实效果」会给出做不到的承诺。
 */

const { createPlaceholderComponent, PLACEHOLDER_HINTS } = require('../runtime/placeholder-card');
const { createStubModule } = require('../runtime/stub-factory');

const PKG = '@expo/ui/swift-ui';
const HINT = PLACEHOLDER_HINTS.ios;

function placeholder(componentName) {
  return createPlaceholderComponent({ package: PKG, componentName, hint: HINT });
}

const Host = placeholder('Host');
const VStack = placeholder('VStack');
const HStack = placeholder('HStack');
const Button = placeholder('Button');
const Text = placeholder('Text');

// 长尾兜底：@expo/ui 的组件集合仍在演进，显式清单不可能追平上游。
// hint 必须一并传给 createStubModule，否则长尾组件会掉回默认档文案。

module.exports = createStubModule(PKG, { Host, VStack, HStack, Button, Text }, { hint: HINT });
