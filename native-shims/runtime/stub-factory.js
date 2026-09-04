/**
 * stub 的两段式骨架：显式关键导出 + 模块级 Proxy 兜底
 *
 * 每个 stub 文件人工写 3-12 个显式导出（承载占位卡、高频 API 行为与内联参数校验），
 * 剩下的长尾导出由 createStubModule 的 Proxy 兜住。这样漏写一个导出名只会让体验略糙，
 * 而不是整页崩溃。
 *
 * 兜底挂在哪一层是这套机制成败的关键：挂在 `export default` 上时，Babel 会把它编译到
 * exports.default，而具名导入编译成 exports 上的属性读取、wildcard 在 __esModule 为真时
 * 原样拿 exports 对象，两者都够不着 default——兜底只对 `import Pkg from 'x'` 这一种写法
 * 生效，而 Expo 生态几乎不这么写。所以 Proxy 必须就是模块导出对象本身，stub 入口也因此
 * 必须是 CJS（见 createStubModule 的说明），由 scripts/check-native-shims.js 静态扫描守住。
 *
 * fallback 按命名约定分流三类：首字母大写视为组件，返回占位卡；use 开头视为
 * React hook，返回同步值（权限类给标准三元组）；其余小写视为 API，返回会弹提示
 * 并上报的函数。经 fallback 命中的事件带 viaFallback 标记，用来回答
 * 「该给哪个包补显式导出」，而不是靠拍脑袋。命名约定只是没有类型信息时的启发式，
 * 真包 .d.ts 的比对交给 scripts/check-native-shim-dts.js 产出待办，人工确认后转显式导出。
 *
 * hook 必须单独成一类：它以 use 开头且首字母小写，若按 API 处理会返回 Promise，
 * 调用方一解构（const [a, b] = usePermissions()）就 TypeError 整页崩。
 *
 * 注意 Proxy 只用于 stub 文件内部兜底长尾。包级通用 Proxy 桩是另一回事：
 * 它无法呈现真实导出形态与逐包语义，本方案不采用。
 */

import { createPlaceholderComponent } from './placeholder-card';
import { showNativeShimDialog } from './dialog';
import { reportApiInvoked } from './report';
import {
  createPermissionHook,
  createStubHook,
  looksLikeHook,
  looksLikePermissionHook,
} from './hooks';

const ok = { ok: true };

/**
 * 造一个 stub API 函数：弹提示 + 上报 + 返回兜底值。
 *
 * options.validate 接收调用实参数组，返回 { ok } 或 { ok:false, message }，
 * 决定 dialog 走 ✅ 还是 ❌ 分支。
 * options.result 是返回值，可以是值或工厂函数；原生 API 多为异步，
 * 默认返回 resolved Promise，避免调用方 await 时挂死。
 */
export function createStubApi(options) {
  const pkg = options.package;
  const apiName = options.apiName;
  const validate = options.validate;
  const viaFallback = Boolean(options.viaFallback);
  const isAsync = options.async !== false;
  // 注册类 API（setXxxHandler、addXxxListener）通常在应用启动时就被调用，
  // 弹提示只会在用户还没做任何操作时糊一脸。这类接口只上报、不打扰。
  const silent = Boolean(options.silent);

  function stubApi(...args) {
    let validation = ok;
    try {
      validation = validate ? validate(args) || ok : ok;
    } catch (_) {
      validation = ok; // 校验器自身出错不能反过来打断业务
    }

    if (!silent) showNativeShimDialog({ package: pkg, apiName, args, validation });
    reportApiInvoked({
      package: pkg,
      apiName,
      viaFallback,
      paramOk: validation.ok !== false,
    });

    const value = typeof options.result === 'function' ? options.result(...args) : options.result;
    return isAsync ? Promise.resolve(value) : value;
  }

  Object.defineProperty(stubApi, 'name', { value: apiName });
  return stubApi;
}

function looksLikeComponent(exportName) {
  const first = exportName.charAt(0);
  return first >= 'A' && first <= 'Z';
}

/**
 * 把「模块导出对象本身」换成 Proxy，让长尾兜底对三种导入写法一视同仁。
 *
 * 用法（stub 入口文件必须是 CJS，见下）：
 *   module.exports = createStubModule(PKG, { getBrightnessAsync, setBrightnessAsync });
 *
 * 为什么必须是 CJS：只要文件里出现 import/export，Babel 就会接管导出重写、
 * 注入 __esModule 并把 default 单独放到 exports.default 上，Proxy 又会被挤回
 * default 那一层，具名导入与 wildcard 再次绕过它。CJS 写法下 require() 拿到的
 * 就是 Proxy 本体，属性访问全部流经 get trap。runtime/ 下的支撑文件不承担导出
 * 边界，继续用 ESM 即可。
 *
 * interop 键是显式设计的，不是顺手兜住：
 *   __esModule=true  —— 让 wildcard 与 default 的 interop 原样放行本 Proxy，
 *                       否则 importAll 会走浅拷贝分支，长尾在拷贝那一刻就丢光；
 *   default          —— 默认自引用，三种写法收敛到同一个对象；包的真实主入口是
 *                       组件时（react-native-webview 这类）由 options.defaultExport
 *                       显式给出，否则 `import WebView from 'x'` 会拿到一个不可
 *                       渲染的 Proxy；
 *   then=undefined   —— 不挡住的话模块对象会被当成 thenable，
 *                       `await import('expo-x')` 永远不会 settle；
 *   Symbol 一律不接  —— Symbol.iterator / toPrimitive 上给出函数，会把调用方的
 *                       解构与类型转换引到错误路径上去。
 *
 * 枚举面只有显式导出：长尾本来就没有全集，"可按名访问、不可枚举"才是诚实的表达，
 * 也避免 {...NS} 把一堆假导出物化出来。
 *
 * options.hint 是包级的占位卡文案，透传给 fallback 生成的占位卡。没有它的话，
 * 平台专用包（@expo/ui/swift-ui 这类）只有人工写出的那几个显式组件拿得到平台档文案，
 * wildcard 命中的长尾组件仍然显示默认档——同一个包里两种承诺，且错的那个恰好出现在
 * 我们没预料到的导出上。文案属于包级事实，就该在包级配一次。
 */
export function createStubModule(packageName, explicitExports, options) {
  const opts = options || {};
  // 值为 undefined 的显式导出要剔除。`real ? real.useCameraPermissions : undefined`
  // 这类写法会把 undefined 写进显式面，反而把长尾兜底挡在门外——正是本次要根治的
  // 失效形态，这里从构造上让它无法发生。
  const explicit = {};
  const source = explicitExports || {};
  for (const key of Object.keys(source)) {
    if (source[key] !== undefined) explicit[key] = source[key];
  }

  const hasExplicitDefault = opts.defaultExport !== undefined;
  const placeholderHint = opts.hint;
  const generated = Object.create(null);

  return new Proxy(explicit, {
    get(target, prop, receiver) {
      // interop 键的处理顺序敏感，必须在显式面之前
      if (prop === '__esModule') return true;
      if (prop === 'default') return hasExplicitDefault ? opts.defaultExport : receiver;
      if (prop === 'then') return undefined;
      if (typeof prop === 'symbol') return undefined;

      if (prop in target) return Reflect.get(target, prop, receiver);
      if (prop === 'prototype' || prop === 'caller' || prop === 'arguments') return undefined;

      // 长尾按命名约定分流。缓存对组件与 hook 是正确性要求而不是优化：
      // 不缓存则每次属性访问都是新函数，React 按引用比对 type，整棵子树每帧卸载重挂。
      if (!generated[prop]) {
        if (looksLikeComponent(prop)) {
          generated[prop] = createPlaceholderComponent({
            package: packageName,
            componentName: prop,
            viaFallback: true,
            hint: placeholderHint,
          });
        } else if (looksLikePermissionHook(prop)) {
          generated[prop] = createPermissionHook(packageName, prop, null, { viaFallback: true });
        } else if (looksLikeHook(prop)) {
          generated[prop] = createStubHook(packageName, prop, { viaFallback: true });
        } else if (typeof opts.createFallbackApi === 'function') {
          // 普通 API 这一档允许被单个 stub 接管。
          //
          // 动机：modifiers 这类「整模块导出同一形态」的包，默认的 createStubApi 是
          // 「异步 + 每次调用弹提示」的，而 modifier 在 render 期被调用 —— 结果是把描述
          // 对象变成 Promise，并且每帧刷屏。@expo/ui/swift-ui/modifiers 有 152 处 export、
          // 显式面只覆盖 8 个，95% 落进长尾，默认行为在这里是错的。
          //
          // 刻意排在组件 / hook / 权限 hook 三档**之后**：那三档的形态契约（占位卡可渲染、
          // hook 可解构）是全仓通用的，被接管会直接破坏 stub 形态门禁。只有既不像组件也
          // 不像 hook 的普通导出才交给 stub 自己处理。未传该选项的 stub 行为完全不变。
          generated[prop] = opts.createFallbackApi(prop);
        } else {
          generated[prop] = createStubApi({ package: packageName, apiName: prop, viaFallback: true });
        }
      }
      return generated[prop];
    },
    has() {
      // 长尾导出一律视为存在，否则 import 的存在性检查会先一步失败
      return true;
    },
    ownKeys(target) {
      return Reflect.ownKeys(target);
    },
    getOwnPropertyDescriptor(target, prop) {
      const descriptor = Reflect.getOwnPropertyDescriptor(target, prop);
      if (descriptor) return descriptor;
      // 未声明的键：可配置但不可枚举，保证 {...NS} 与 Object.keys 只看到显式面
      return { configurable: true, enumerable: false, value: undefined, writable: true };
    },
  });
}
