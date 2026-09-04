/**
 * 假数据档（fake-data）的公共件
 *
 * 适用范围：真包在 web 上确实没有可用实现（web 分支要么抛错、要么只返回未授权
 * 空响应）的那批能力。noop 档只弹提示、返回 undefined，用户代码往往在第一步
 * 权限判断就被挡住，后面的界面根本渲染不出来，预览等于什么都看不到。
 * 假数据档的目标是让调用链走通到界面层：权限给「已授权」，列表给空集合，
 * 创建类给一个假 id，形状与真机一致，用户能看到自己写的空态与交互。
 *
 * 权限一律返回 granted 是刻意选择，与妙搭的做法不同（它对 contacts、
 * notifications 返回 denied）。理由：denied 会把预览停在「请授权」引导页，
 * 用户看不到真正想验证的界面；而「已授权 + 空数据」能让主界面渲染出来。
 * 由此带来的与真机的差异，由每次调用弹出的 dialog 负责说明，不会让用户误判。
 *
 * 注意假数据只是让流程走通，不承诺语义等价：写进去的读不出来，
 * 创建的 id 不对应任何真实对象。manifest 的 grade 标 fake-data 就是在说这件事。
 */

import { createStubApi } from './stub-factory';
import { GRANTED_PERMISSION, looksLikeHook } from './hooks';

// 权限常量与 hook 工厂统一放 runtime/hooks.js：兜底分流也要用它们，
// 放在这里会让 stub-factory 反向依赖 fake-data 形成循环。
export { GRANTED_PERMISSION, createPermissionHook, createStubHook } from './hooks';

export function grantedPermission(extra) {
  return Object.assign({}, GRANTED_PERMISSION, extra || {});
}

/** 订阅类 API 的返回值：有 remove 就够了，调用方清理时不会炸。 */
export function createStubSubscription() {
  return { remove() {} };
}


/**
 * 以真包为底座造假数据模块。
 *
 * 枚举、常量这些非函数导出直接取真包的真值——它们在 web 上本来就是对的，
 * 自己抄一份迟早跟真包漂移（EntityTypes、MediaType、AndroidImportance 这类
 * 用户代码会直接引用）。函数导出则一律换成我们的 stub，因为真包的 web 分支
 * 调用时会抛错；随后再用 fakes 覆盖其中需要返回假数据的那些。
 *
 * 读真包属性时逐个 try：部分包用 getter 暴露导出，取值本身就可能抛。
 */
export function createFakeDataShim(options) {
  const PKG = options.package;
  const real = options.real;
  const fakes = options.fakes || {};
  const hooks = options.hooks || {};
  const silentApis = options.silentApis || [];
  const out = {};

  if (real) {
    for (const key of Object.keys(real)) {
      let value;
      try {
        value = real[key];
      } catch (_) {
        continue; // getter 抛错的导出直接跳过，交给后面的 fakes 或 Proxy 兜底
      }
      if (typeof value === 'function') {
        // hook 不能变成 async stub，否则调用方解构就崩；留给 hooks 覆盖
        if (looksLikeHook(key)) continue;
        out[key] = createStubApi({
          package: PKG,
          apiName: key,
          silent: silentApis.indexOf(key) !== -1,
        });
      } else {
        out[key] = value;
      }
    }
  }

  Object.keys(hooks).forEach(name => {
    out[name] = hooks[name];
  });
  Object.keys(fakes).forEach(name => {
    out[name] = fakes[name];
  });
  return out;
}

/** 造一个返回固定假数据的 API。 */
export function fakeApi(packageName, apiName, result, extra) {
  return createStubApi(
    Object.assign({ package: packageName, apiName, result }, extra || {})
  );
}
