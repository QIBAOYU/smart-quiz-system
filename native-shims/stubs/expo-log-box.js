/**
 * @expo/log-box 的 web no-op stub —— 屏蔽 Expo 自带的全屏错误浮层
 *
 * 为什么要屏蔽：预览画布里出现两套错误 UI 就是打架。Expo 的红屏会盖住整个 iframe，
 * 把我方的 RuntimeErrorToast 挡在下面，用户先看到的是一屏英文栈而不是可点的修复入口；
 * 错误消费路径也随之分叉——红屏是终点，我方 toast 才连着「让 Agent 修」。屏蔽掉之后，
 * 预览态的错误呈现与消费由我方通道独占。
 *
 * 顺带的收益：console.error 上少一层 Expo 的 patcher，我方 early capture
 * （沙箱注入的 meoo-preview-error-capture.js）拿到的是更靠近原始调用的参数。
 *
 * 只在 web 生效，由 manifest + metro resolver 承担平台门槛，本文件不做平台判断。
 * 原生打包路径完全不经过这里，真机上 LogBox 行为不变。
 *
 * 导出面照抄上游 no-op 实现的形状（setupLogBox / presentGlobalErrorOverlay /
 * dismissGlobalErrorOverlay / withoutANSIColorStyles + default 的 LogBox 对象），
 * 依据：~/Desktop/doc/miaoda-native-preview-20260811/evidence/devkit-src/dist-b98/stubs/no-op-logbox.js。
 *
 * 这里刻意不用 createStubModule：那套兜底会弹提示、渲染占位卡、打降级埋点，
 * 全部是给「用户显式用到的原生能力」准备的语义。LogBox 是工具链模块，用户从没主动引它，
 * 任何可见反应都是噪音。所以本文件自带一个静默 Proxy：未知导出一律给回一个什么都不做的
 * 函数（返回 null 而不是 undefined——万一被当组件渲染，返回 undefined 会抛
 * "Nothing was returned from render"）。
 */

function noop() {
  return null;
}

// 上游 LogBox 单例的方法面。给 no-op 而不是删掉：调用方普遍在启动路径上直接调，
// 少一个方法就是一次 "is not a function" 整页崩。
const LogBox = {
  install: noop,
  uninstall: noop,
  ignoreLogs: noop,
  ignoreAllLogs: noop,
  clearAllLogs: noop,
  addLog: noop,
  addException: noop,
};

const setupLogBox = noop;
const presentGlobalErrorOverlay = noop;
const dismissGlobalErrorOverlay = noop;

/** 纯字符串工具，与浮层无关，保持真实行为：剥掉 ANSI 颜色转义序列。 */
function withoutANSIColorStyles(value) {
  // eslint-disable-next-line no-control-regex
  return typeof value === 'string' ? value.replace(/\u001B\[[0-9;]*[A-Za-z]/g, '') : value;
}

const explicit = {
  LogBox,
  setupLogBox,
  presentGlobalErrorOverlay,
  dismissGlobalErrorOverlay,
  withoutANSIColorStyles,
};

const generated = Object.create(null);

// interop 键的语义与 runtime/stub-factory.js 的 createStubModule 一致，
// 区别只在长尾兜底是静默 no-op 而非占位卡/提示：
//   __esModule=true —— wildcard 与 default interop 原样放行本 Proxy，不走浅拷贝分支；
//   default         —— 上游默认导出就是 LogBox 单例；
//   then=undefined  —— 否则模块对象被当成 thenable，await import() 永不 settle；
//   Symbol 一律不接 —— 解构与类型转换不能被引到错误路径上。
module.exports = new Proxy(explicit, {
  get(target, prop, receiver) {
    if (prop === '__esModule') return true;
    if (prop === 'default') return LogBox;
    if (prop === 'then') return undefined;
    if (typeof prop === 'symbol') return undefined;
    if (prop in target) return Reflect.get(target, prop, receiver);
    if (prop === 'prototype' || prop === 'caller' || prop === 'arguments') return undefined;
    // 缓存：不缓存则每次属性访问都是新函数，若被当组件用会每帧卸载重挂。
    if (!generated[prop]) generated[prop] = noop;
    return generated[prop];
  },
  has() {
    return true;
  },
  ownKeys(target) {
    return Reflect.ownKeys(target);
  },
  getOwnPropertyDescriptor(target, prop) {
    const descriptor = Reflect.getOwnPropertyDescriptor(target, prop);
    if (descriptor) return descriptor;
    return { configurable: true, enumerable: false, value: undefined, writable: true };
  },
});
