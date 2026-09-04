/**
 * 桌面 Web 的拍照对话框（功能性 UI，不是提示）
 *
 * 交互形态参考 miaoda-expo-devkit@0.1.1-beta.97 (MIT) 的 image-picker stub，
 * 已按 OneDay 设计基调改写：白底浅色面板、主色 #0A64FF、固定中文文案（不引入
 * i18n 体系），并补了 ESC 取消与摄像头就绪前禁用快门两处交互缺口。
 *
 * 为什么要有预览而不是直接抓帧：无预览抓帧拿到的常常是摄像头刚启动的黑帧或
 * 曝光未收敛的画面，用户既不知道拍到了什么，也没有重拍的机会。给一个预览 +
 * 快门，交互成本没高多少，但产出可控。
 *
 * 这里只负责「拿到一张图」，不关心调用方要什么形状的返回值，转换交给调用方。
 */

const OVERLAY_ID = 'meoo-native-shim-camera';

function isDomAvailable() {
  return typeof document !== 'undefined' && Boolean(document.body);
}

function styleOf(node, styles) {
  Object.keys(styles).forEach(key => {
    node.style[key] = styles[key];
  });
}

function button(text, variant) {
  const el = document.createElement('button');
  el.textContent = text;
  const base = {
    borderRadius: '10px',
    padding: '10px 18px',
    fontSize: '14px',
    cursor: 'pointer',
    fontFamily: 'inherit',
  };
  const skins = {
    primary: { border: 'none', color: '#FFFFFF', background: '#0A64FF', fontWeight: '600' },
    secondary: { border: '1px solid #D1D1D6', color: '#1D1D1F', background: '#FFFFFF' },
  };
  styleOf(el, Object.assign({}, base, skins[variant] || skins.secondary));
  return el;
}

/**
 * 打开拍照对话框。
 * resolve 形状：{ canceled: true } 或 { canceled: false, dataUrl, mimeType }
 * 永不 reject —— 取消、拒绝授权、无设备都归一到 canceled，调用方只需处理一种失败。
 */
export function openCameraCaptureDialog(options) {
  const facingMode = options && options.facingMode === 'front' ? 'user' : 'environment';

  if (!isDomAvailable()) return Promise.resolve({ canceled: true });

  return new Promise(resolve => {
    const existing = document.getElementById(OVERLAY_ID);
    if (existing && existing.parentNode) existing.parentNode.removeChild(existing);

    const overlay = document.createElement('div');
    overlay.id = OVERLAY_ID;
    styleOf(overlay, {
      position: 'fixed',
      inset: '0',
      zIndex: '2147483000',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      background: 'rgba(0,0,0,0.45)',
      fontFamily: '-apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif',
    });

    const panel = document.createElement('div');
    styleOf(panel, {
      width: 'min(520px, calc(100vw - 40px))',
      background: '#FFFFFF',
      borderRadius: '14px',
      padding: '20px',
      boxShadow: '0 12px 40px rgba(0,0,0,0.18)',
      boxSizing: 'border-box',
    });

    const badge = document.createElement('div');
    badge.textContent = '预览模式';
    styleOf(badge, {
      display: 'inline-block',
      fontSize: '11px',
      color: '#0A64FF',
      background: '#EAF2FF',
      borderRadius: '4px',
      padding: '2px 6px',
      marginBottom: '10px',
    });

    const title = document.createElement('div');
    title.textContent = '拍照';
    styleOf(title, { fontSize: '16px', fontWeight: '600', color: '#1D1D1F', marginBottom: '6px' });

    const desc = document.createElement('div');
    desc.textContent = '预览用电脑摄像头代替手机相机，拍到的照片会按真机相同的数据结构返回。';
    styleOf(desc, { fontSize: '13px', color: '#48484A', lineHeight: '1.6', marginBottom: '12px' });

    const video = document.createElement('video');
    video.autoplay = true;
    video.playsInline = true;
    video.muted = true;
    styleOf(video, {
      width: '100%',
      borderRadius: '10px',
      background: '#000000',
      display: 'block',
      marginBottom: '12px',
    });

    const error = document.createElement('div');
    styleOf(error, {
      display: 'none',
      fontSize: '13px',
      color: '#C2261C',
      lineHeight: '1.6',
      marginBottom: '12px',
    });

    const row = document.createElement('div');
    styleOf(row, { display: 'flex', gap: '8px', justifyContent: 'flex-end' });

    const cancelBtn = button('取消', 'secondary');
    const localBtn = button('从本地选择', 'secondary');
    const shootBtn = button('拍照', 'primary');
    // 摄像头就绪前不给按，避免抓到黑帧
    shootBtn.disabled = true;
    shootBtn.style.opacity = '0.5';

    row.appendChild(cancelBtn);
    row.appendChild(localBtn);
    row.appendChild(shootBtn);

    panel.appendChild(badge);
    panel.appendChild(title);
    panel.appendChild(desc);
    panel.appendChild(video);
    panel.appendChild(error);
    panel.appendChild(row);
    overlay.appendChild(panel);
    document.body.appendChild(overlay);

    let stream = null;
    let settled = false;

    function cleanup() {
      if (stream) {
        stream.getTracks().forEach(track => {
          try {
            track.stop();
          } catch (_) {
            // 轨道可能已被浏览器回收
          }
        });
        stream = null;
      }
      if (typeof document.removeEventListener === 'function') {
        document.removeEventListener('keydown', onKeyDown);
      }
      if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
    }

    function settle(result) {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    }

    function onKeyDown(event) {
      if (event && event.key === 'Escape') settle({ canceled: true });
    }
    if (typeof document.addEventListener === 'function') {
      document.addEventListener('keydown', onKeyDown);
    }

    function showError(message) {
      error.textContent = message;
      error.style.display = 'block';
      video.style.display = 'none';
    }

    navigator.mediaDevices
      .getUserMedia({ video: { facingMode }, audio: false })
      .then(s => {
        if (settled) {
          s.getTracks().forEach(t => t.stop());
          return;
        }
        stream = s;
        video.srcObject = s;
        shootBtn.disabled = false;
        shootBtn.style.opacity = '1';
      })
      .catch(err => {
        showError(
          '打不开摄像头：' +
            ((err && err.message) || '未知原因') +
            '。可以改用「从本地选择」，或发布后在真机上使用。'
        );
      });

    shootBtn.addEventListener('click', () => {
      const width = video.videoWidth || 640;
      const height = video.videoHeight || 480;
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      if (!ctx) return settle({ canceled: true });
      ctx.drawImage(video, 0, 0, width, height);
      settle({ canceled: false, dataUrl: canvas.toDataURL('image/jpeg', 0.92), mimeType: 'image/jpeg' });
    });

    localBtn.addEventListener('click', () => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = 'image/*';
      input.addEventListener('change', () => {
        const file = input.files && input.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = e => {
          const dataUrl = e && e.target && e.target.result;
          if (!dataUrl) return settle({ canceled: true });
          settle({ canceled: false, dataUrl, mimeType: file.type || 'image/jpeg' });
        };
        reader.onerror = () => settle({ canceled: true });
        reader.readAsDataURL(file);
      });
      input.click();
    });

    cancelBtn.addEventListener('click', () => settle({ canceled: true }));
    overlay.addEventListener('click', event => {
      if (event && event.target === overlay) settle({ canceled: true });
    });
  });
}
