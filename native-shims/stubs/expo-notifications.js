/**
 * expo-notifications 的 web 降级 stub（升档：noop → fake-data）
 *
 * 行为参考 miaoda-expo-devkit@0.1.1-beta.97 (MIT) 的 expo-notifications-stub，
 * 已按 OneDay runtime 改写：去 i18n、提示与上报走我们的 runtime、枚举取自真包，
 * 并把注册类接口改为静默（见下）。
 *
 * 为什么留 stub 不透传：真包只有 badge、push token 注册三个 web 分支，
 * 调度类核心 API（scheduleNotificationAsync 等）在 web 上没有实现。
 *
 * 与妙搭的一处刻意分歧：它返回 denied，我们返回 granted。denied 会让应用
 * 停在「请开启通知」引导页，看不到后面的界面；granted 能让调用链走完，
 * 代价是用户可能预期真的弹出通知——这一点由 dialog 明确告知。
 *
 * 注册类接口（setNotificationHandler、addXxxListener）一律静默：
 * 它们几乎都在 App 启动时执行，弹提示会在用户什么都还没操作时糊一脸。
 * 静默不等于不记录，上报照常，高频榜数据不受影响。
 */

const { createStubModule } = require('../runtime/stub-factory');
const {
  GRANTED_PERMISSION,
  createFakeDataShim,
  createStubSubscription,
  fakeApi,
} = require('../runtime/fake-data');
const { createStubHook } = require('../runtime/hooks');

const PKG = 'expo-notifications';

function tryRequireReal() {
  try {
    return require('expo-notifications');
  } catch (_) {
    return null;
  }
}

const SILENT_APIS = [
  'setNotificationHandler',
  'addNotificationReceivedListener',
  'addNotificationResponseReceivedListener',
  'addNotificationsDroppedListener',
  'addPushTokenListener',
  'addNotificationResponseClearedListener',
  'removeNotificationSubscription',
];

function subscription() {
  return createStubSubscription();
}

const fakes = {
  requestPermissionsAsync: fakeApi(PKG, 'requestPermissionsAsync', GRANTED_PERMISSION),
  getPermissionsAsync: fakeApi(PKG, 'getPermissionsAsync', GRANTED_PERMISSION, { silent: true }),
  allowsNotificationsAsync: fakeApi(PKG, 'allowsNotificationsAsync', true, { silent: true }),

  // 调度类返回假 id：形状对，但预览里不会真的弹出通知，dialog 负责说明
  scheduleNotificationAsync: fakeApi(PKG, 'scheduleNotificationAsync', () => `preview-notification-${Date.now()}`),
  presentNotificationAsync: fakeApi(PKG, 'presentNotificationAsync', () => `preview-notification-${Date.now()}`),
  getAllScheduledNotificationsAsync: fakeApi(PKG, 'getAllScheduledNotificationsAsync', () => []),
  cancelScheduledNotificationAsync: fakeApi(PKG, 'cancelScheduledNotificationAsync', undefined),
  cancelAllScheduledNotificationsAsync: fakeApi(PKG, 'cancelAllScheduledNotificationsAsync', undefined),
  dismissNotificationAsync: fakeApi(PKG, 'dismissNotificationAsync', undefined),
  dismissAllNotificationsAsync: fakeApi(PKG, 'dismissAllNotificationsAsync', undefined),
  getPresentedNotificationsAsync: fakeApi(PKG, 'getPresentedNotificationsAsync', () => []),

  getBadgeCountAsync: fakeApi(PKG, 'getBadgeCountAsync', 0, { silent: true }),
  setBadgeCountAsync: fakeApi(PKG, 'setBadgeCountAsync', true, { silent: true }),

  // token 形状对齐真机，便于调用方把它塞进自己的注册请求里跑通链路
  getExpoPushTokenAsync: fakeApi(PKG, 'getExpoPushTokenAsync', {
    type: 'expo',
    data: 'ExponentPushToken[preview-only]',
  }),
  getDevicePushTokenAsync: fakeApi(PKG, 'getDevicePushTokenAsync', { type: 'web', data: {} }),

  getLastNotificationResponseAsync: fakeApi(PKG, 'getLastNotificationResponseAsync', null, { silent: true }),
  setNotificationChannelAsync: fakeApi(PKG, 'setNotificationChannelAsync', null, { silent: true }),
  getNotificationChannelsAsync: fakeApi(PKG, 'getNotificationChannelsAsync', () => [], { silent: true }),

  setNotificationHandler: fakeApi(PKG, 'setNotificationHandler', undefined, { silent: true, async: false }),
  addNotificationReceivedListener: fakeApi(PKG, 'addNotificationReceivedListener', subscription, { silent: true, async: false }),
  addNotificationResponseReceivedListener: fakeApi(PKG, 'addNotificationResponseReceivedListener', subscription, { silent: true, async: false }),
  addNotificationsDroppedListener: fakeApi(PKG, 'addNotificationsDroppedListener', subscription, { silent: true, async: false }),
  addPushTokenListener: fakeApi(PKG, 'addPushTokenListener', subscription, { silent: true, async: false }),
  removeNotificationSubscription: fakeApi(PKG, 'removeNotificationSubscription', undefined, { silent: true, async: false }),
};

// 真包导出的 hook，必须同步返回，否则调用方按 React 惯例取值就崩
const hooks = {
  useLastNotificationResponse: createStubHook(PKG, 'useLastNotificationResponse', { result: null }),
};

const explicit = createFakeDataShim({
  package: PKG,
  real: tryRequireReal(),
  fakes,
  hooks,
  silentApis: SILENT_APIS,
});

module.exports = createStubModule(PKG, explicit);
