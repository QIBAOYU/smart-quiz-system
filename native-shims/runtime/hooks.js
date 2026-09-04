/**
 * React hook 形态的 stub
 *
 * 存在的理由是 stub 的分类法原本只有两类：首字母大写当组件（给占位卡）、
 * 小写当 API（给 async 函数）。hook 是没被考虑到的第三类，它以 use 开头、
 * 首字母小写，于是被判成 API，返回了一个 Promise。用户按 React 惯例写
 *
 *   const [permission, requestPermission] = useCameraPermissions();
 *   const db = useSQLiteContext();
 *
 * 前者对 Promise 做数组解构，直接 TypeError 整页崩；后者拿到 Promise 再调
 * db.execAsync 同样炸。这不是 expo 的问题，是我们把 hook 错当成异步 API。
 *
 * 这里补上第三类。两条与普通 stub API 不同的约束：
 *
 * 1. **同步返回**。hook 在渲染期执行，返回 Promise 必然破坏调用方的解构与取值。
 * 2. **不弹 dialog、上报去重**。hook 每次渲染都会执行，弹窗会在渲染期操作 DOM
 *    （React 反模式，StrictMode 下还会重复），上报则会随渲染次数无限放大，
 *    把高频榜的数据冲垮。因此只在每个 hook 首次执行时上报一次。
 */

import { reportApiInvoked } from './report';

export const GRANTED_PERMISSION = {
  status: 'granted',
  granted: true,
  canAskAgain: true,
  expires: 'never',
};

export function grantedPermission(extra) {
  return Object.assign({}, GRANTED_PERMISSION, extra || {});
}

const reportedHooks = new Set();

function reportHookOnce(packageName, hookName, viaFallback) {
  const key = `${packageName}::${hookName}::${viaFallback ? 'fallback' : 'explicit'}`;
  if (reportedHooks.has(key)) return;
  reportedHooks.add(key);
  reportApiInvoked({ package: packageName, apiName: hookName, viaFallback, paramOk: true });
}

export function looksLikeHook(name) {
  return /^use[A-Z]/.test(name);
}

/**
 * 权限 hook 的名字高度标准化：expo 各模块都由 expo-modules-core 的
 * createPermissionHook 生成，名字要么就叫 usePermissions，要么以 Permissions 结尾
 * （useCameraPermissions / useCalendarPermissions / useMediaLibraryPermissions）。
 * 认出这批就能给对返回形状，剩下的 hook 形态各异，只能给保守值。
 */
export function looksLikePermissionHook(name) {
  return /^use[A-Z]\w*Permissions$/.test(name) || name === 'usePermissions';
}

/**
 * 造权限 hook，返回 [permission, requestPermission, getPermission]，
 * 与 expo-modules-core createPermissionHook 的签名一致。
 *
 * 三个返回值在模块级固定，保证跨渲染引用不变；否则调用方把 requestPermission
 * 放进 useEffect 依赖会陷入无限循环。
 */
export function createPermissionHook(packageName, hookName, permission, options) {
  const value = permission || GRANTED_PERMISSION;
  const viaFallback = Boolean(options && options.viaFallback);
  const request = async () => value;
  const get = async () => value;

  return function permissionHook() {
    reportHookOnce(packageName, hookName, viaFallback);
    return [value, request, get];
  };
}

/**
 * 造通用 hook stub：同步返回一个保守值。
 *
 * 默认 undefined 而不是 {} 或 []：expo 的非权限 hook 绝大多数返回单值
 * （useFont / useImage / useVisibility / useSQLiteContext / useLastNotificationResponse），
 * 调用方普遍写 if (!x) return null 做保护，undefined 能安全走进这条保护分支。
 * 给一个假对象反而会骗过保护、把崩溃推迟到更深的地方。
 */
export function createStubHook(packageName, hookName, options) {
  const opts = options || {};
  const viaFallback = Boolean(opts.viaFallback);
  const result = opts.result;

  return function stubHook() {
    reportHookOnce(packageName, hookName, viaFallback);
    return typeof result === 'function' ? result() : result;
  };
}
