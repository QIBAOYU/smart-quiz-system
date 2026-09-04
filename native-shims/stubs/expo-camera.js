/**
 * expo-camera 的 web 降级 stub（升档：组件透传 + 录制能力补齐）
 *
 * 行为参考 miaoda-expo-devkit@0.1.1-beta.97 (MIT) 的 expo-camera-record-stub，
 * 已按 OneDay runtime 改写：剥离 nativewind 依赖、上报改走 runtime/report、
 * 能力缺失时降级为 dialog 提示而不是抛异常打断业务。
 *
 * 认知修正：expo-camera 自带 web 实现，CameraView 在浏览器里会渲染真实的
 * <video> 预览。此前把 CameraView 换成占位卡属于过度 stub —— 效果比不介入更差，
 * 也与 05 票「camera 只 stub 录制类 API、组件透传」的既定结论相悖。
 *
 * 因此本次升档的实质是「收回过度 stub + 补齐 web 唯一缺口」：
 *   1. 整包透传真实 expo-camera（依赖 09 票的 native-shims 放行，否则 resolver 自环）
 *   2. 只覆写 CameraView，用子类补 recordAsync / stopRecording
 *   3. 真包不可用 / 非类组件 / 浏览器不支持录制时逐级降级，最差回到原 noop 档
 */

const { createPlaceholderComponent } = require('../runtime/placeholder-card');
const { createStubApi, createStubModule } = require('../runtime/stub-factory');
const { reportApiInvoked } = require('../runtime/report');

const PKG = 'expo-camera';

function api(apiName) {
  return createStubApi({ package: PKG, apiName });
}

// 录制容器格式按浏览器支持度依次降级。妙搭只认 mp4/avc1 并在不支持时抛错，
// 这里放宽到 webm：Firefox 等不支持 mp4 录制的浏览器仍能拿到可播放的 blob。
const MIME_CANDIDATES = [
  'video/mp4;codecs=avc1',
  'video/mp4',
  'video/webm;codecs=vp9',
  'video/webm;codecs=vp8',
  'video/webm',
];

function pickMimeType() {
  if (typeof MediaRecorder === 'undefined') return null;
  for (const mime of MIME_CANDIDATES) {
    try {
      if (MediaRecorder.isTypeSupported(mime)) return mime;
    } catch (_) {
      // isTypeSupported 在个别实现上会抛，视作不支持继续试下一个
    }
  }
  return null;
}

/**
 * 真包不可用时的兜底：回到升档前的 noop 档。
 *
 * 导出名对齐 expo-camera 56 的真实运行时面。注意 requestCameraPermissionsAsync /
 * getCameraPermissionsAsync 在该版本并非顶层导出（只挂在 Camera 对象上），
 * 旧 stub 把它们提到顶层会让「预览里能调通、真机上是 undefined」，
 * 属于制造假信心，这次一并纠正。
 */
function buildNoopShim() {
  return createStubModule(PKG, {
    CameraView: createPlaceholderComponent({ package: PKG, componentName: 'CameraView' }),
    useCameraPermissions: api('useCameraPermissions'),
    useMicrophonePermissions: api('useMicrophonePermissions'),
    scanFromURLAsync: api('scanFromURLAsync'),
    Camera: {
      getCameraPermissionsAsync: api('Camera.getCameraPermissionsAsync'),
      requestCameraPermissionsAsync: api('Camera.requestCameraPermissionsAsync'),
      getMicrophonePermissionsAsync: api('Camera.getMicrophonePermissionsAsync'),
      requestMicrophonePermissionsAsync: api('Camera.requestMicrophonePermissionsAsync'),
      scanFromURLAsync: api('Camera.scanFromURLAsync'),
    },
  });
}

/**
 * 给真实 CameraView 套一层子类，补上 web 端缺失的录制 API。
 *
 * expo-camera 的 web 实现把 MediaStream 挂在内部 <video> 的 srcObject 上，
 * 但没有实现 recordAsync。这里在 render 外面包一个 display:contents 的容器，
 * 拿到 DOM 后就能捞到那个 <video>，直接复用它已经开着的流做 MediaRecorder 录制，
 * 不额外申请一路摄像头，避免与预览抢设备。
 */
function buildRecordableCameraView(React, OriginalCameraView) {
  const recordStub = api('recordAsync');

  return class WebRecordableCameraView extends OriginalCameraView {
    constructor(...args) {
      super(...args);
      this._recorder = null;
      this._maxDurationTimer = null;
      this._audioTracks = [];
      this._containerEl = null;
    }

    render() {
      return React.createElement(
        'div',
        {
          ref: el => {
            this._containerEl = el;
          },
          // display:contents 让这层包裹不参与布局，父级的 flex/尺寸计算不受影响
          style: { display: 'contents' },
        },
        super.render()
      );
    }

    _findVideoElement() {
      return this._containerEl ? this._containerEl.querySelector('video') : null;
    }

    _clearTimer() {
      if (this._maxDurationTimer) {
        clearTimeout(this._maxDurationTimer);
        this._maxDurationTimer = null;
      }
    }

    _stopAudioTracks() {
      this._audioTracks.forEach(track => {
        try {
          track.stop();
        } catch (_) {
          // 轨道可能已被浏览器回收
        }
      });
      this._audioTracks = [];
    }

    async recordAsync(options) {
      const videoEl = this._findVideoElement();
      const stream = videoEl && videoEl.srcObject;
      const mimeType = pickMimeType();

      // 任一前置条件不满足就退回 noop 档：弹提示 + 上报，返回 undefined。
      // 抛异常会把调用方的业务流打断，预览里不值得为一个降级能力付这个代价。
      if (!stream || !mimeType) {
        return recordStub(options);
      }

      if (this._recorder && this._recorder.state !== 'inactive') {
        this._recorder.stop();
      }

      let recordStream = stream;
      this._audioTracks = [];
      if (options && options.mute === true) {
        recordStream = new MediaStream(stream.getVideoTracks());
      } else {
        // 预览流通常只有视频轨，录音要单独申请；拿不到就静音录，不阻断
        try {
          const audioStream = await navigator.mediaDevices.getUserMedia({ audio: true });
          this._audioTracks = audioStream.getAudioTracks();
          recordStream = new MediaStream([...stream.getVideoTracks(), ...this._audioTracks]);
        } catch (_) {
          recordStream = stream;
        }
      }

      let recorder;
      try {
        recorder = new MediaRecorder(recordStream, { mimeType });
      } catch (_) {
        this._stopAudioTracks();
        return recordStub(options);
      }

      this._recorder = recorder;
      reportApiInvoked({ package: PKG, apiName: 'recordAsync', viaFallback: false, paramOk: true });

      const chunks = [];
      recorder.ondataavailable = event => {
        if (event.data && event.data.size > 0) chunks.push(event.data);
      };

      const finished = new Promise(resolve => {
        const settle = () => {
          if (this._recorder === recorder) {
            this._clearTimer();
            this._recorder = null;
          }
          this._stopAudioTracks();
        };
        recorder.onstop = () => {
          settle();
          const blob = new Blob(chunks, { type: mimeType });
          resolve({ uri: URL.createObjectURL(blob) });
        };
        // 录制中途出错同样按「拿到什么算什么」收尾，返回值形状保持稳定
        recorder.onerror = () => {
          settle();
          const blob = new Blob(chunks, { type: mimeType });
          resolve({ uri: URL.createObjectURL(blob) });
        };
      });

      recorder.start();

      if (options && options.maxDuration) {
        this._maxDurationTimer = setTimeout(() => {
          this.stopRecording();
        }, options.maxDuration * 1000);
      }

      return finished;
    }

    stopRecording() {
      if (this._recorder && this._recorder.state !== 'inactive') {
        this._recorder.stop();
      }
    }
  };
}

function buildShim() {
  let real;
  let React;
  try {
    // 依赖 09 票：native-shims 内的请求不再被重定向，这里拿到的是真包
    real = require('expo-camera');
    React = require('react');
  } catch (_) {
    return buildNoopShim();
  }

  const OriginalCameraView = real && real.CameraView;
  const isClassComponent =
    typeof OriginalCameraView === 'function' &&
    OriginalCameraView.prototype &&
    typeof OriginalCameraView.prototype.render === 'function';

  // 不是类组件就无法安全子类化。此时整包透传，录制能力缺失但预览仍是真的，
  // 依旧优于占位卡；真包本身若无 CameraView 才回落 noop 档。
  if (!isClassComponent) {
    return OriginalCameraView ? real : buildNoopShim();
  }

  return Object.assign({}, real, {
    CameraView: buildRecordableCameraView(React, OriginalCameraView),
  });
}

const shim = buildShim();

// 整个模块导出就是 buildShim() 的产物：透传档下它是真包（导出面即真包的全集），
// noop 档下它是 createStubModule 的 Proxy（显式面对齐 expo-camera 56 的真实运行时面，
// 长尾由 Proxy 兜底）。此前这里手写了 6 个再导出，反而把透传档的导出面裁成了 6 个名字。
module.exports = shim;
