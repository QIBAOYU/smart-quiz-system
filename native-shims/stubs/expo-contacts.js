/**
 * expo-contacts 的 web 降级 stub（升档：noop → fake-data）
 *
 * 行为参考 miaoda-expo-devkit@0.1.1-beta.97 (MIT) 的 expo-contacts-stub，
 * 已按 OneDay runtime 改写：去 i18n、提示与上报走我们的 runtime、枚举取自真包。
 *
 * 与妙搭的一处刻意分歧：它对通讯录返回 denied，我们返回 granted + 空通讯录。
 * denied 会把预览停在「请授权」引导页，用户看不到自己写的联系人列表；
 * granted + 空数据能让主界面渲染出空态，这才是预览要验证的东西。
 * 隐私上没有风险——我们本来就没有、也拿不到任何真实联系人，
 * 每次调用弹出的 dialog 会说明这是预览数据。
 *
 * 为什么留 stub 不透传：真包的 web 分支是空壳（既不实现也不抛错），
 * 透传等于所有接口静默返回 undefined，比 stub 更难排查。
 */

const { createStubModule } = require('../runtime/stub-factory');
const {
  GRANTED_PERMISSION,
  createFakeDataShim,
  createPermissionHook,
  fakeApi,
} = require('../runtime/fake-data');

const PKG = 'expo-contacts';

function tryRequireReal() {
  try {
    return require('expo-contacts');
  } catch (_) {
    return null;
  }
}

/** 空的联系人分页结果，形状对齐真机 ContactResponse。 */
const EMPTY_RESPONSE = { data: [], hasNextPage: false, hasPreviousPage: false, total: 0 };

const fakes = {
  isAvailableAsync: fakeApi(PKG, 'isAvailableAsync', true, { silent: true }),
  hasContactsAsync: fakeApi(PKG, 'hasContactsAsync', false, { silent: true }),

  requestPermissionsAsync: fakeApi(PKG, 'requestPermissionsAsync', GRANTED_PERMISSION),
  getPermissionsAsync: fakeApi(PKG, 'getPermissionsAsync', GRANTED_PERMISSION, { silent: true }),

  getContactsAsync: fakeApi(PKG, 'getContactsAsync', () => Object.assign({}, EMPTY_RESPONSE)),
  getPagedContactsAsync: fakeApi(PKG, 'getPagedContactsAsync', () => Object.assign({}, EMPTY_RESPONSE)),
  getContactByIdAsync: fakeApi(PKG, 'getContactByIdAsync', undefined),
  getGroupsAsync: fakeApi(PKG, 'getGroupsAsync', () => []),
  getContainersAsync: fakeApi(PKG, 'getContainersAsync', () => []),
  getDefaultContainerIdAsync: fakeApi(PKG, 'getDefaultContainerIdAsync', 'preview-container'),

  addContactAsync: fakeApi(PKG, 'addContactAsync', () => `preview-contact-${Date.now()}`),
  createGroupAsync: fakeApi(PKG, 'createGroupAsync', () => `preview-group-${Date.now()}`),

  // 系统级界面在预览里没有对应物，返回 undefined 并由 dialog 说明
  presentFormAsync: fakeApi(PKG, 'presentFormAsync', undefined),
  presentContactPickerAsync: fakeApi(PKG, 'presentContactPickerAsync', null),
};

const hooks = {
  usePermissions: createPermissionHook(PKG, 'usePermissions', GRANTED_PERMISSION),
};

const explicit = createFakeDataShim({ package: PKG, real: tryRequireReal(), fakes, hooks });

module.exports = createStubModule(PKG, explicit);
