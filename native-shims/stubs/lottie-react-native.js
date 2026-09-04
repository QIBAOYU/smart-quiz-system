/**
 * lottie-react-native 的 web 降级 stub
 *
 * 动画播放器依赖原生。
 * 显式导出覆盖高频入口，长尾交给文件内 Proxy fallback：漏名只会让体验略糙，
 * 不会整页崩溃。升档时替换本文件实现并把 manifest 的 grade 改成 equivalent 即可。
 */

const { createPlaceholderComponent } = require('../runtime/placeholder-card');
const { createStubModule } = require('../runtime/stub-factory');

const PKG = 'lottie-react-native';

function placeholder(componentName) {
  return createPlaceholderComponent({ package: PKG, componentName });
}

const LottieView = placeholder('LottieView');

// 该包的主入口就是这个组件，default 必须显式给出：模块级 Proxy 的 default 默认自引用，
// 直接给回去的话 `import LottieView from 'lottie-react-native'` 会拿到一个不可渲染的 Proxy。
module.exports = createStubModule(PKG, { LottieView }, { defaultExport: LottieView });
