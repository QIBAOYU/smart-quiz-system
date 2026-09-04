/**
 * @shopify/react-native-skia 的 web 降级 stub
 *
 * Skia 画布依赖原生。
 * 显式导出覆盖高频入口，长尾交给文件内 Proxy fallback：漏名只会让体验略糙，
 * 不会整页崩溃。升档时替换本文件实现并把 manifest 的 grade 改成 equivalent 即可。
 */

const { createPlaceholderComponent } = require('../runtime/placeholder-card');
const { createStubModule } = require('../runtime/stub-factory');

const PKG = '@shopify/react-native-skia';

function placeholder(componentName) {
  return createPlaceholderComponent({ package: PKG, componentName });
}

const Canvas = placeholder('Canvas');
const Group = placeholder('Group');
const Circle = placeholder('Circle');
const Path = placeholder('Path');

module.exports = createStubModule(PKG, { Canvas, Group, Circle, Path });
