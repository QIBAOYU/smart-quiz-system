/**
 * expo-screen-capture 的 web 降级 stub
 *
 * 截屏管控依赖原生。
 * 显式导出覆盖高频入口，长尾交给文件内 Proxy fallback：漏名只会让体验略糙，
 * 不会整页崩溃。升档时替换本文件实现并把 manifest 的 grade 改成 equivalent 即可。
 */

const { createStubApi, createStubModule } = require('../runtime/stub-factory');
const { createStubHook } = require('../runtime/hooks');

const PKG = 'expo-screen-capture';

function api(apiName) {
  return createStubApi({ package: PKG, apiName });
}

const preventScreenCaptureAsync = api('preventScreenCaptureAsync');
const allowScreenCaptureAsync = api('allowScreenCaptureAsync');
// hook 在渲染期执行：写成 api() 不仅返回 Promise，还会在 render 阶段弹 dialog
// 操作 DOM（React 反模式，StrictMode 下重复触发）。改为同步 no-op。
const usePreventScreenCapture = createStubHook(PKG, 'usePreventScreenCapture');

module.exports = createStubModule(PKG, { preventScreenCaptureAsync, allowScreenCaptureAsync, usePreventScreenCapture });
