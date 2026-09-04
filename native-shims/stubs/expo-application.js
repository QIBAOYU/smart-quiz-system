/**
 * expo-application 的 web 降级 stub
 *
 * 应用元信息依赖原生宿主。
 * 显式导出覆盖高频入口，长尾交给文件内 Proxy fallback：漏名只会让体验略糙，
 * 不会整页崩溃。升档时替换本文件实现并把 manifest 的 grade 改成 equivalent 即可。
 *
 * 这里的四个应用元信息是**常量**不是函数（真包 build/Application.d.ts:10/20/28/35，
 * 类型 `string | null`）。之前写成 createStubApi 会让 <Text>{Application.nativeApplicationVersion}</Text>
 * 渲染出一个函数、`applicationName.toUpperCase()` 直接崩。值统一给 null：真包 web 实现
 * （ExpoApplication.web.js）的全部 getter 就是返回 null，与真机 web 行为一致。
 *
 * getAndroidId 是**同步**函数（d.ts:53 `getAndroidId(): string`）。真包没有
 * getAndroidIdAsync 这个名字，之前的显式导出是幻影：用户按真 API 写
 * `const id = Application.getAndroidId()` 会掉进长尾兜底拿到 Promise，`id.slice()` 崩。
 */

const { createStubApi, createStubModule } = require('../runtime/stub-factory');

const PKG = 'expo-application';

function api(apiName) {
  return createStubApi({ package: PKG, apiName });
}

const getInstallationTimeAsync = api('getInstallationTimeAsync');
// 同步 API：async: false，否则返回 Promise，调用方按真 API 当字符串用就崩。
const getAndroidId = createStubApi({ package: PKG, apiName: 'getAndroidId', async: false, result: null });

// 真包是数字枚举（build/Application.types.d.ts:4-11）。不补的话它首字母大写、
// 掉进 Proxy 兜底会被当成组件生成占位卡，用户取 ApplicationReleaseType.APP_STORE
// 得 undefined——不崩，但静默走错分支，比崩更难排查。
const ApplicationReleaseType = {
  UNKNOWN: 0,
  SIMULATOR: 1,
  ENTERPRISE: 2,
  DEVELOPMENT: 3,
  AD_HOC: 4,
  APP_STORE: 5,
};

const applicationName = null;
const nativeApplicationVersion = null;
const nativeBuildVersion = null;
const applicationId = null;

module.exports = createStubModule(PKG, {
  getInstallationTimeAsync,
  getAndroidId,
  ApplicationReleaseType,
  applicationName,
  nativeApplicationVersion,
  nativeBuildVersion,
  applicationId,
});
