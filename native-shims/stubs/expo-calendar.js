/**
 * expo-calendar 的 web 降级 stub（升档：noop → fake-data）
 *
 * 行为参考 miaoda-expo-devkit@0.1.1-beta.97 (MIT) 的 expo-calendar-stub，
 * 已按 OneDay runtime 改写：去 i18n 固定中文、提示走 runtime/dialog、
 * 上报走 runtime/report、枚举改为从真包取而不是自己抄一份。
 *
 * 为什么这个包该留 stub 而不是像 camera 那样透传：真包的 ExpoCalendar.web.js
 * 除 getCalendars/listEvents 返回空数组外，其余 API 一律
 * `throw new Error('Calendar API is not available on web')`，透传等于让用户
 * 代码在预览里直接崩。
 *
 * 升档到 fake-data 的收益：noop 档下 requestCalendarPermissionsAsync 返回
 * undefined，用户代码 if (status !== 'granted') return 之后界面就没了；
 * 给出 granted + 一个预览日历 + 空事件列表，日程界面才能渲染出空态。
 */

const { createStubModule } = require('../runtime/stub-factory');
const {
  GRANTED_PERMISSION,
  createFakeDataShim,
  createPermissionHook,
  fakeApi,
} = require('../runtime/fake-data');

const PKG = 'expo-calendar';

function tryRequireReal() {
  try {
    // 依赖 09 票：native-shims 内的请求不再被重定向，这里拿到的是真包。
    // 只为取枚举（EntityTypes / Availability / CalendarType 等用户会直接引用的值），
    // 函数一律由 createFakeDataShim 换成 stub。
    return require('expo-calendar');
  } catch (_) {
    return null;
  }
}

/** 预览用的假日历，形状对齐真机 Calendar，让列表界面有东西可渲染。 */
const PREVIEW_CALENDAR = {
  id: 'preview-calendar',
  title: '预览日历',
  color: '#0A64FF',
  entityType: 'event',
  source: { id: 'preview-source', type: 'local', name: '本机' },
  type: 'local',
  isPrimary: true,
  allowsModifications: true,
  allowedAvailabilities: [],
  allowedReminders: [],
  allowedAttendeeTypes: [],
  accessLevel: 'owner',
  ownerAccount: null,
  timeZone: undefined,
};

const fakes = {
  isAvailableAsync: fakeApi(PKG, 'isAvailableAsync', true, { silent: true }),

  requestCalendarPermissionsAsync: fakeApi(PKG, 'requestCalendarPermissionsAsync', GRANTED_PERMISSION),
  getCalendarPermissionsAsync: fakeApi(PKG, 'getCalendarPermissionsAsync', GRANTED_PERMISSION, { silent: true }),
  requestRemindersPermissionsAsync: fakeApi(PKG, 'requestRemindersPermissionsAsync', GRANTED_PERMISSION),
  getRemindersPermissionsAsync: fakeApi(PKG, 'getRemindersPermissionsAsync', GRANTED_PERMISSION, { silent: true }),
  requestPermissionsAsync: fakeApi(PKG, 'requestPermissionsAsync', GRANTED_PERMISSION),

  getCalendarsAsync: fakeApi(PKG, 'getCalendarsAsync', () => [Object.assign({}, PREVIEW_CALENDAR)]),
  getDefaultCalendarAsync: fakeApi(PKG, 'getDefaultCalendarAsync', () => Object.assign({}, PREVIEW_CALENDAR)),
  getSourcesAsync: fakeApi(PKG, 'getSourcesAsync', () => []),

  getEventsAsync: fakeApi(PKG, 'getEventsAsync', () => []),
  getRemindersAsync: fakeApi(PKG, 'getRemindersAsync', () => []),
  getAttendeesForEventAsync: fakeApi(PKG, 'getAttendeesForEventAsync', () => []),

  // 创建类返回假 id：形状对（字符串 id），但不对应任何真实对象，
  // 用户拿它去查会查不到——这是 fake-data 档的既定边界，dialog 里已说明。
  createCalendarAsync: fakeApi(PKG, 'createCalendarAsync', 'preview-calendar'),
  createEventAsync: fakeApi(PKG, 'createEventAsync', () => `preview-event-${Date.now()}`),
  createReminderAsync: fakeApi(PKG, 'createReminderAsync', () => `preview-reminder-${Date.now()}`),
};

const hooks = {
  useCalendarPermissions: createPermissionHook(PKG, 'useCalendarPermissions', GRANTED_PERMISSION),
  useRemindersPermissions: createPermissionHook(PKG, 'useRemindersPermissions', GRANTED_PERMISSION),
};

const explicit = createFakeDataShim({ package: PKG, real: tryRequireReal(), fakes, hooks });

module.exports = createStubModule(PKG, explicit);
