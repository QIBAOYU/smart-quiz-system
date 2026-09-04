/**
 * @expo/ui/jetpack-compose/modifiers 的 web 降级 stub
 *
 * 与 swift-ui/modifiers 同构，但加它的理由是**对称防御**而不是现存故障：
 * 截至 @expo/ui 56.0.x，本子树 0 处 requireNativeModule / requireNativeView，
 * 入口只引 react-native 与本目录的 animation / createModifier，今天在 web 上是安全的。
 * 但 swift-ui 侧已经证明「上游给 modifiers barrel 加一行顶层 requireNativeModule」
 * 就足以让整页白屏，且这条链路要走一遍完整排查才能定位。成本是一个几十行的 stub，
 * 收益是不用再走一遍。
 *
 * modifier 不是组件，是描述对象：真包的 createModifier 返回 { $type, ...params }，
 * 由组件的 modifiers prop 消费。所以这里不能用 createPlaceholderComponent。
 *
 * 占位卡走 Android 档文案：Compose 层在 iOS 测试包上同样不存在。
 */

const { PLACEHOLDER_HINTS } = require('../runtime/placeholder-card');
const { createStubModule } = require('../runtime/stub-factory');

const PKG = '@expo/ui/jetpack-compose/modifiers';
const HINT = PLACEHOLDER_HINTS.android;

/**
 * 造一个形态兼容的 modifier 工厂（与 swift-ui/modifiers stub 同一套语义）。
 * modifier 在 render 期被调用，保持纯函数——不弹提示、不上报。
 */
function modifier(modifierName) {
  function stubModifier(...args) {
    const first = args[0];
    const params = first && typeof first === 'object' && !Array.isArray(first) ? first : undefined;
    return params ? { $type: modifierName, ...params } : { $type: modifierName };
  }
  Object.defineProperty(stubModifier, 'name', { value: modifierName });
  return stubModifier;
}

// 显式覆盖 Compose 侧的高频布局 modifier，其余交给长尾兜底。
const padding = modifier('padding');
const fillMaxSize = modifier('fillMaxSize');
const fillMaxWidth = modifier('fillMaxWidth');
const size = modifier('size');
const background = modifier('background');
const weight = modifier('weight');
const clip = modifier('clip');
const align = modifier('align');

/**
 * 真包给三方包用的公开工厂：首参**就是** $type，不能走上面的 modifier(name)——
 * 那条会把 $type 写成字面量 'createModifier'，拿到的描述对象类型是错的。
 * 带事件监听的变体在 web 下没有原生侧可回调，事件参数原样丢弃即可。
 */
function createModifier(type, params) {
  return params && typeof params === 'object' && !Array.isArray(params)
    ? { $type: type, ...params }
    : { $type: type };
}

function createModifierWithEventListener(type, params) {
  return createModifier(type, params);
}

// 长尾兜底：Compose modifier 集合仍在演进，显式清单不可能追平上游。
// 这里把长尾整体交给同一个 modifier 工厂——不能用默认兜底，默认的 createStubApi
// 是「异步 + 每次调用弹提示」，而 modifier 在 render 期被调用，会把描述对象变成
// Promise 并且每帧刷屏。hint 仍要传：万一将来该子路径混入组件型导出，档位文案才不会掉回默认档。

module.exports = createStubModule(
  PKG,
  { padding, fillMaxSize, fillMaxWidth, size, background, weight, clip, align, createModifier, createModifierWithEventListener },
  { hint: HINT, createFallbackApi: modifier }
);
