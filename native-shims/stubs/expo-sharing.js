/**
 * expo-sharing 的 web 降级 stub
 *
 * 系统分享面板依赖原生。
 * 显式导出覆盖高频入口，长尾交给文件内 Proxy fallback：漏名只会让体验略糙，
 * 不会整页崩溃。升档时替换本文件实现并把 manifest 的 grade 改成 equivalent 即可。
 */

const { createStubApi, createStubModule } = require('../runtime/stub-factory');

const PKG = 'expo-sharing';

function api(apiName) {
  return createStubApi({ package: PKG, apiName });
}

const isAvailableAsync = api('isAvailableAsync');
const shareAsync = api('shareAsync');

module.exports = createStubModule(PKG, { isAvailableAsync, shareAsync });
