/**
 * expo-secure-store 的 web 降级 stub（passthrough → shimmed/fake-data）
 *
 * 为什么不能 passthrough：真包在 web 上**调用即崩**，不是"体验略差"。
 * build/ExpoSecureStore.web.js 整个文件就是 `export default {};`，而
 * build/SecureStore.js:87 直接调 `ExpoSecureStore.getValueWithKeyAsync(...)`，
 * web 上必然 TypeError。官方文档的 platforms 也只有 android/ios/tvos。
 * SecureStore 存 token 是 Expo + supabase 鉴权的常见搭配，放着不管等于预览里
 * 登录链路必崩（import 不炸，第一次调用就炸）。
 *
 * 降级实现：进程内存 Map。形状与真包一致（异步四件套 + 同步 getItem/setItem），
 * 让"存了再取"的链路能走通到界面层。刻意不落 localStorage：secure-store 的语义
 * 是加密存储，用明文 localStorage 假装持久化会诱导用户在预览里存真凭据。
 * 内存实现刷新即失效，与 grade: fake-data 的承诺一致——只让流程走通，不承诺语义等价。
 */

const { createStubApi, createStubModule } = require('../runtime/stub-factory');

const PKG = 'expo-secure-store';

/** 预览会话内的假保险箱，刷新即清空。 */
const store = new Map();

function api(apiName, options) {
  return createStubApi(Object.assign({ package: PKG, apiName }, options || {}));
}

// 读取类静默：取值往往在启动路径上（恢复登录态），弹全屏 dialog 会糊用户一脸。
// 写入/删除保留提示，让用户知道这份数据不会真的落到加密存储里。
const getItemAsync = api('getItemAsync', {
  silent: true,
  result: (key) => (store.has(key) ? store.get(key) : null),
});
const setItemAsync = api('setItemAsync', {
  result: (key, value) => {
    store.set(key, value === undefined || value === null ? null : String(value));
    return undefined;
  },
});
const deleteItemAsync = api('deleteItemAsync', {
  result: (key) => {
    store.delete(key);
    return undefined;
  },
});
const isAvailableAsync = api('isAvailableAsync', { silent: true, result: true });

// 同步面（真包 d.ts:133/144）：async: false，否则 `const t = SecureStore.getItem(k)`
// 拿到 Promise，紧接着的字符串操作直接崩。
const getItem = api('getItem', {
  silent: true,
  async: false,
  result: (key) => (store.has(key) ? store.get(key) : null),
});
const setItem = api('setItem', {
  async: false,
  result: (key, value) => {
    store.set(key, value === undefined || value === null ? null : String(value));
    return undefined;
  },
});
const canUseBiometricAuthentication = api('canUseBiometricAuthentication', {
  silent: true,
  async: false,
  result: false,
});

// KeychainAccessibilityConstant 的真值取自真包 iOS 侧枚举
// （ios/SecureStoreAccessible.swift，SecureStoreModule.swift 用 rawValue 暴露成常量）。
// 用户代码常写 `{ keychainAccessible: SecureStore.WHEN_UNLOCKED }`，取到 undefined
// 会掉进长尾兜底变成函数，选项对象里塞个函数比塞数字更难排查。
const AFTER_FIRST_UNLOCK = 0;
const AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY = 1;
const ALWAYS = 2;
const WHEN_PASSCODE_SET_THIS_DEVICE_ONLY = 3;
const ALWAYS_THIS_DEVICE_ONLY = 4;
const WHEN_UNLOCKED = 5;
const WHEN_UNLOCKED_THIS_DEVICE_ONLY = 6;

module.exports = createStubModule(PKG, {
  getItemAsync,
  setItemAsync,
  deleteItemAsync,
  isAvailableAsync,
  getItem,
  setItem,
  canUseBiometricAuthentication,
  AFTER_FIRST_UNLOCK,
  AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
  ALWAYS,
  WHEN_PASSCODE_SET_THIS_DEVICE_ONLY,
  ALWAYS_THIS_DEVICE_ONLY,
  WHEN_UNLOCKED,
  WHEN_UNLOCKED_THIS_DEVICE_ONLY,
});
