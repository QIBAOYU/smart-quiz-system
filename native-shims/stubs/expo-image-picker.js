/**
 * expo-image-picker 的 web 降级 stub（升档：整包透传 + 桌面拍照增强）
 *
 * 行为参考 miaoda-expo-devkit@0.1.1-beta.97 (MIT) 的 expo-image-picker-stub，
 * 已按 OneDay runtime 改写：对话框换成我们的设计基调与固定中文、上报走
 * runtime/report、平台判断收进 runtime/platform。
 *
 * 认知修正（与 T08 的差异）：expo-image-picker 自带完整 web 实现，走
 * <input type="file"> 并按 cameraType 设置 capture 属性。因此
 *   · 相册选择在 web 上就是文件选择器，语义成立，应当透传而不是 stub；
 *   · 权限 API 在 web 上有真实返回，透传比伪造更接近真机；
 *   · 移动浏览器上 capture 属性会直接唤起系统相机，体验已接近真机，也该透传。
 * T08 把这些一并 noop 掉属于过度 stub，本次收回。
 *
 * 真正的缺口只有一处：桌面浏览器没有系统相机入口，capture 属性退化成普通文件
 * 选择框，用户点「拍照」却弹出选文件，预期错位。这里用摄像头对话框补上。
 */

const { createStubApi, createStubModule } = require('../runtime/stub-factory');
const { openCameraCaptureDialog } = require('../runtime/camera-dialog');
const { isDesktopWeb } = require('../runtime/platform');
const { reportApiInvoked } = require('../runtime/report');

const PKG = 'expo-image-picker';

function api(apiName) {
  return createStubApi({ package: PKG, apiName });
}

/** 与原生一致的取消返回值形状，调用方的 result.canceled 判断可以直接复用。 */
const CANCELED_RESULT = { canceled: true, assets: null };

function report(apiName) {
  reportApiInvoked({ package: PKG, apiName, viaFallback: false, paramOk: true });
}

/** 把 dataURL 拼成与原生同形状的 ImagePickerResult，尺寸由图片实际解码结果决定。 */
function toPickerResult(dataUrl, mimeType, includeBase64) {
  const base64 = dataUrl.split(',')[1] || '';
  const asset = {
    uri: dataUrl,
    type: 'image',
    fileName: `photo_${Date.now()}.jpg`,
    mimeType: mimeType || 'image/jpeg',
    // base64 每 4 字符编 3 字节，用长度反推字节数即可，不必真去解码
    fileSize: Math.round((base64.length * 3) / 4),
  };
  if (includeBase64) asset.base64 = base64;

  return new Promise(resolve => {
    if (typeof Image === 'undefined') {
      resolve({ canceled: false, assets: [Object.assign({ width: 0, height: 0 }, asset)] });
      return;
    }
    const img = new Image();
    const done = (width, height) =>
      resolve({ canceled: false, assets: [Object.assign({ width, height }, asset)] });
    img.onload = () => done(img.naturalWidth || img.width || 0, img.naturalHeight || img.height || 0);
    // 尺寸拿不到也要把图给出去，宽高为 0 至少不阻断业务
    img.onerror = () => done(0, 0);
    img.src = dataUrl;
  });
}

function loadReal() {
  try {
    // 依赖 09 票：native-shims 内的请求不再被重定向，这里拿到的是真包
    return require('expo-image-picker');
  } catch (_) {
    return null;
  }
}

const real = loadReal();

/**
 * 桌面 Web 走自研拍照对话框，其余环境交回真包。
 *
 * 移动浏览器不拦：真包的 capture 属性会唤起系统相机，比我们模拟的更接近真机。
 * 真包缺失时才退回 noop 档的提示行为。
 */
const cameraNoop = api('launchCameraAsync');

async function launchCameraAsync(options) {
  const opts = options || {};

  if (!isDesktopWeb()) {
    if (!real || typeof real.launchCameraAsync !== 'function') return cameraNoop(opts);
    report('launchCameraAsync');
    return real.launchCameraAsync(opts);
  }

  report('launchCameraAsync');
  const shot = await openCameraCaptureDialog({ facingMode: opts.cameraType });
  if (shot.canceled || !shot.dataUrl) return CANCELED_RESULT;
  return toPickerResult(shot.dataUrl, shot.mimeType, opts.base64 === true);
}

/** 真包可用就透传，不可用才回落 noop 档。 */
function passthrough(apiName) {
  if (real && typeof real[apiName] === 'function') {
    const fn = real[apiName];
    return function passthroughApi(...args) {
      report(apiName);
      return fn.apply(real, args);
    };
  }
  return api(apiName);
}

const launchImageLibraryAsync = passthrough('launchImageLibraryAsync');
const getPendingResultAsync = passthrough('getPendingResultAsync');
const getCameraPermissionsAsync = passthrough('getCameraPermissionsAsync');
const requestCameraPermissionsAsync = passthrough('requestCameraPermissionsAsync');
const getMediaLibraryPermissionsAsync = passthrough('getMediaLibraryPermissionsAsync');
const requestMediaLibraryPermissionsAsync = passthrough('requestMediaLibraryPermissionsAsync');

// 权限 hook 与枚举是值不是函数：真包在时由下面的 Object.assign 整体带出，
// 真包缺失时交给 Proxy 兜底。此前这里写成 `real ? real.X : undefined`，
// 真包缺失时等于往显式面塞了一堆 undefined，反而把兜底挡在门外。
module.exports = createStubModule(
  PKG,
  Object.assign({}, real || {}, {
    launchCameraAsync,
    launchImageLibraryAsync,
    getPendingResultAsync,
    getCameraPermissionsAsync,
    requestCameraPermissionsAsync,
    getMediaLibraryPermissionsAsync,
    requestMediaLibraryPermissionsAsync,
  })
);
