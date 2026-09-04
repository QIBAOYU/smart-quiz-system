/**
 * expo-media-library 的 web 降级 stub（升档：noop → fake-data）
 *
 * 行为参考 miaoda-expo-devkit@0.1.1-beta.97 (MIT) 的 expo-media-library-stub，
 * 已按 OneDay runtime 改写：去 i18n、提示与上报走我们的 runtime、枚举取自真包。
 *
 * 为什么留 stub 不透传：真包的 ExpoMediaLibrary.web.js 只实现了权限接口，
 * 且固定返回 UNDETERMINED；getAssetsAsync 之类核心接口在 web 上根本不存在。
 *
 * 升档收益：相册界面通常先查权限再拉资产，noop 档下第一步就返回 undefined，
 * 界面直接空白。给 granted + 空资产页，用户能看到自己写的「暂无照片」空态。
 */

const { createStubModule } = require('../runtime/stub-factory');
const {
  createFakeDataShim,
  createPermissionHook,
  createStubSubscription,
  fakeApi,
  grantedPermission,
} = require('../runtime/fake-data');

const PKG = 'expo-media-library';

function tryRequireReal() {
  try {
    return require('expo-media-library');
  } catch (_) {
    return null;
  }
}

// accessPrivileges 是 iOS 的「全部/部分照片」语义，给 all 让判断分支走完整路径
const GRANTED = grantedPermission({ accessPrivileges: 'all' });

/** 空的资产分页结果，形状对齐真机 PagedInfo<Asset>。 */
const EMPTY_PAGE = { assets: [], endCursor: '0', hasNextPage: false, totalCount: 0 };

const fakes = {
  isAvailableAsync: fakeApi(PKG, 'isAvailableAsync', true, { silent: true }),

  requestPermissionsAsync: fakeApi(PKG, 'requestPermissionsAsync', GRANTED),
  getPermissionsAsync: fakeApi(PKG, 'getPermissionsAsync', GRANTED, { silent: true }),
  presentPermissionsPickerAsync: fakeApi(PKG, 'presentPermissionsPickerAsync', undefined),

  getAssetsAsync: fakeApi(PKG, 'getAssetsAsync', () => Object.assign({}, EMPTY_PAGE)),
  getAlbumsAsync: fakeApi(PKG, 'getAlbumsAsync', () => []),
  getAlbumAsync: fakeApi(PKG, 'getAlbumAsync', null),
  getMomentsAsync: fakeApi(PKG, 'getMomentsAsync', () => []),
  getAssetInfoAsync: fakeApi(PKG, 'getAssetInfoAsync', null),

  // 保存类不真的落盘，返回形状正确的假资产，让调用方后续读 uri/id 不至于炸
  createAssetAsync: fakeApi(PKG, 'createAssetAsync', uri => ({
    id: `preview-asset-${Date.now()}`,
    uri: typeof uri === 'string' ? uri : '',
    filename: 'preview.jpg',
    mediaType: 'photo',
    width: 0,
    height: 0,
    creationTime: Date.now(),
    modificationTime: Date.now(),
    duration: 0,
  })),
  saveToLibraryAsync: fakeApi(PKG, 'saveToLibraryAsync', undefined),

  // 订阅类只上报不弹窗：它们通常在页面挂载时就注册，弹提示纯打扰
  addListener: fakeApi(PKG, 'addListener', () => createStubSubscription(), { silent: true, async: false }),
  removeAllListeners: fakeApi(PKG, 'removeAllListeners', undefined, { silent: true, async: false }),
  removeSubscription: fakeApi(PKG, 'removeSubscription', undefined, { silent: true, async: false }),
};

const hooks = {
  usePermissions: createPermissionHook(PKG, 'usePermissions', GRANTED),
};

const explicit = createFakeDataShim({ package: PKG, real: tryRequireReal(), fakes, hooks });

module.exports = createStubModule(PKG, explicit);
