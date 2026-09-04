/**
 * expo-intent-launcher 的 web 降级 stub
 *
 * Android Intent 无 web 对应物。
 * 显式导出覆盖高频入口，长尾交给文件内 Proxy fallback：漏名只会让体验略糙，
 * 不会整页崩溃。升档时替换本文件实现并把 manifest 的 grade 改成 equivalent 即可。
 *
 * 本包当下只导出 API，占位卡用不上；hint 仍要配：长尾兜底一旦命中首字母大写的导出名
 * 就会生成占位卡，那时文案必须是 Android 档而不是默认档。
 */

const { createStubApi, createStubModule } = require('../runtime/stub-factory');
const { PLACEHOLDER_HINTS } = require('../runtime/placeholder-card');

const PKG = 'expo-intent-launcher';

function api(apiName) {
  return createStubApi({ package: PKG, apiName });
}

const startActivityAsync = api('startActivityAsync');

module.exports = createStubModule(PKG, { startActivityAsync }, { hint: PLACEHOLDER_HINTS.android });
