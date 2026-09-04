/**
 * @expo/ui/jetpack-compose 的 web 降级 stub
 *
 * Compose 层是 Android 专用的原生视图，web 端求值即抛原生模块缺失异常。
 * 与 swift-ui 同构：显式导出覆盖常用组件，长尾交给文件内 Proxy fallback。
 *
 * 占位卡走 Android 档文案：这批组件在 iOS 测试包上同样不存在。
 */

const { createPlaceholderComponent, PLACEHOLDER_HINTS } = require('../runtime/placeholder-card');
const { createStubModule } = require('../runtime/stub-factory');

const PKG = '@expo/ui/jetpack-compose';
const HINT = PLACEHOLDER_HINTS.android;

function placeholder(componentName) {
  return createPlaceholderComponent({ package: PKG, componentName, hint: HINT });
}

const Host = placeholder('Host');
const Column = placeholder('Column');
const Row = placeholder('Row');
const Button = placeholder('Button');
const Text = placeholder('Text');

// 长尾兜底：@expo/ui 的组件集合仍在演进，显式清单不可能追平上游。
// hint 必须一并传给 createStubModule，否则长尾组件会掉回默认档文案。

module.exports = createStubModule(PKG, { Host, Column, Row, Button, Text }, { hint: HINT });
