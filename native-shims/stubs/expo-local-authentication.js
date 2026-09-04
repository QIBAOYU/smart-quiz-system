/**
 * expo-local-authentication 的 web 降级 stub
 *
 * 生物识别依赖原生。
 * 显式导出覆盖高频入口，长尾交给文件内 Proxy fallback：漏名只会让体验略糙，
 * 不会整页崩溃。升档时替换本文件实现并把 manifest 的 grade 改成 equivalent 即可。
 */

const { createStubApi, createStubModule } = require('../runtime/stub-factory');

const PKG = 'expo-local-authentication';

function api(apiName) {
  return createStubApi({ package: PKG, apiName });
}

const hasHardwareAsync = api('hasHardwareAsync');
const isEnrolledAsync = api('isEnrolledAsync');
const authenticateAsync = api('authenticateAsync');
const supportedAuthenticationTypesAsync = api('supportedAuthenticationTypesAsync');

module.exports = createStubModule(PKG, { hasHardwareAsync, isEnrolledAsync, authenticateAsync, supportedAuthenticationTypesAsync });
