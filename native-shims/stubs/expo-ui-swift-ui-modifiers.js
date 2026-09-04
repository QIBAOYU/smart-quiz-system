/**
 * @expo/ui/swift-ui/modifiers 的 web 降级 stub
 *
 * 这个子路径是白屏事故的直接原因：src/swift-ui/modifiers/index.ts 第 28 行是**模块顶层**的
 * `const ExpoUI = requireNativeModule('ExpoUI');`。该 barrel 有 152 处 export，用户 import
 * 其中任意一个 modifier（font / padding / frame ...）都会求值这一行，web 下没有 ExpoUI
 * 原生模块 → 抛错 → 路由模块初始化失败 → 整页白屏。
 *
 * 为什么包根 @expo/ui 是 passthrough 却仍要单列本条：@expo/ui 是混合包——根（universal 层）
 * 自带 web 实现，平台专属子树（swift-ui/*）没有。resolver 的「包根退化」会把根的 passthrough
 * 结论继承给所有子路径，因此必须用精确子路径条目把结论显式覆盖回来。
 *
 * modifier 不是组件，是描述对象：真包的 createModifier 返回 { $type, ...params }，
 * 由组件的 modifiers prop 消费。所以这里不能用 createPlaceholderComponent，
 * 显式导出是「调用后返回同形描述对象」的函数。stub 不需要还原任何行为——
 * swift-ui 组件本身已经是占位卡，会忽略传入的 modifiers。
 *
 * 占位卡走 iOS 档文案：SwiftUI 层在 Android 测试包上同样不存在，用默认档的
 * 「装测试包可看真实效果」会给出做不到的承诺。
 */

const { PLACEHOLDER_HINTS } = require('../runtime/placeholder-card');
const { createStubModule } = require('../runtime/stub-factory');

const PKG = '@expo/ui/swift-ui/modifiers';
const HINT = PLACEHOLDER_HINTS.ios;

/**
 * 造一个形态兼容的 modifier 工厂。
 *
 * 对齐真包 createModifier(type, params) 的返回形态 { $type, ...params }：
 * 首参是普通对象时展开进去，否则只给 $type。modifier 在 render 期被调用，
 * 因此这里保持纯函数——不弹提示、不上报，避免每帧刷屏。
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

// 出问题项目实际用到的这几个显式覆盖，避免长尾兜底把它们变成会弹提示的 API 函数。
const font = modifier('font');
const padding = modifier('padding');
const frame = modifier('frame');
const foregroundStyle = modifier('foregroundStyle');
const buttonStyle = modifier('buttonStyle');
const controlSize = modifier('controlSize');
// scrollPosition 与 id 在真包里由 `export * from './scrollPosition'` 重导出，
// 且正是本次触发链的起点。
const scrollPosition = modifier('scrollPosition');
const id = modifier('id');

// 长尾兜底：barrel 导出数以百计且仍在演进，显式清单不可能追平上游。
// 这里把长尾整体交给同一个 modifier 工厂——不能用默认兜底，默认的 createStubApi
// 是「异步 + 每次调用弹提示」，而 modifier 在 render 期被调用，会把描述对象变成
// Promise 并且每帧刷屏。hint 仍要传：万一将来该子路径混入组件型导出，档位文案才不会掉回默认档。

module.exports = createStubModule(
  PKG,
  { font, padding, frame, foregroundStyle, buttonStyle, controlSize, scrollPosition, id, createModifier, createModifierWithEventListener },
  { hint: HINT, createFallbackApi: modifier }
);
