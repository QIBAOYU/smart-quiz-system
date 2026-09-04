/**
 * expo-background-task 的 web 降级 stub
 *
 * 后台任务无 web 对应物。
 * 显式导出覆盖高频入口，长尾交给文件内 Proxy fallback：漏名只会让体验略糙，
 * 不会整页崩溃。升档时替换本文件实现并把 manifest 的 grade 改成 equivalent 即可。
 */

const { createStubApi, createStubModule } = require('../runtime/stub-factory');

const PKG = 'expo-background-task';

function api(apiName) {
  return createStubApi({ package: PKG, apiName });
}

const registerTaskAsync = api('registerTaskAsync');
const unregisterTaskAsync = api('unregisterTaskAsync');
const getStatusAsync = api('getStatusAsync');

module.exports = createStubModule(PKG, { registerTaskAsync, unregisterTaskAsync, getStatusAsync });
