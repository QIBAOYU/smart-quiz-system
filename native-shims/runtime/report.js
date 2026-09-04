/**
 * 原生能力降级上报器
 *
 * 沙箱预览运行在父页 iframe 内，这里只负责把 stub 的触发行为通过 postMessage
 * 送到父页，由父页统一走既有埋点体系。只承担数据流，不承担 UI 指令：
 * 消息丢失只影响观测，不影响预览正确性，因此全部失败都静默吞掉。
 *
 * ── targetOrigin 为什么不能是 '*' ──
 * 用户生成的应用是不可信代码，沙箱预览页可以被任意第三方页面嵌进 iframe。
 * targetOrigin 传 '*' 意味着「谁嵌我，谁就收得到我上报的包名/导出名」，
 * 等于把我方原生能力降级面无差别广播出去。这里改成：只发给通过白名单校验的父页
 * origin，学不到合法 origin 就一条都不发（fail closed）。
 *
 * 零数据损失的依据：本通道的消费端只有我方前端（meoo-web 的 useNativeShimReporter），
 * 它本来就只接收沙箱预览域的消息；被 fail closed 排除掉的那些分支（父页是第三方站点）
 * 今天也没有任何消费方，收益本来就是零。APK 侧的崩溃打点走独立的 HTTP 通道
 * （/api/agent/crash-report + X-Crash-Key），不经过 postMessage，不受本改动影响。
 *
 * ── 父页 origin 从哪来 ──
 * iframe 内拿不到父页地址（跨域读 parent.location 直接抛），唯一可靠来源是父页
 * 主动发进来的消息的 event.origin。父页在预览就绪后必然会握手（错误捕获 READY 事件
 * 与 iframe-bridge 的请求），监听这些消息即可拿到父页真实 origin。
 *
 * 本文件与沙箱镜像的 static/meoo-preview-error-capture.js 是同一套发送侧实现，
 * 白名单与判定逻辑必须保持一致；改一处必须同步改另一处。
 */

const NAMESPACE = 'meoo:native-shim';

/**
 * 父页 origin 白名单。与 meoo-web 的 previewReferrerCheck 同一份域名集合，
 * 后缀匹配按「等于该域或它的子域」判断，不能用裸 endsWith：
 * 'evil-aliyun-inc.com'.endsWith('aliyun-inc.com') 为真，会把仿冒域放进来。
 */
const ALLOWED_PARENT_HOST_SUFFIXES = [
  'aliyun-inc.com',
  'alibaba-inc.com',
  'aliyun.com',
  'ainvestment.cn',
  'meoo.host',
  'meoo.com',
];

/** 本地开发时父页跑在 localhost，端口不固定，因此按 host 放行而不是按完整 origin。 */
const ALLOWED_PARENT_LOCAL_HOSTS = ['localhost', '127.0.0.1'];

/** 学到 origin 之前先攒着，学到后一次性补发。上限防止长期学不到时无限增长。 */
const PENDING_LIMIT = 50;
const PARENT_READY_EVENT = 'MEOO_ERROR_CAPTURE_READY';

let parentOrigin = null;
const pending = [];

export function isAllowedParentOrigin(origin) {
  // 'null' 是 sandbox iframe / file:// 等不透明来源序列化后的字面量，必须拒掉
  if (!origin || origin === 'null' || typeof origin !== 'string') return false;
  try {
    const url = new URL(origin);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return false;
    const host = url.hostname;
    if (ALLOWED_PARENT_LOCAL_HOSTS.indexOf(host) !== -1) return true;
    return ALLOWED_PARENT_HOST_SUFFIXES.some(
      suffix => host === suffix || host.endsWith('.' + suffix)
    );
  } catch (_) {
    return false;
  }
}

/**
 * 认哪些消息算父页握手。
 *
 * 两种形态：错误捕获脚本的 READY 事件（{ event: 'MEOO_ERROR_CAPTURE_READY' }），
 * 以及 iframe-bridge 的请求（{ source: 'main', method: 'error:capture:start' | ... }）。
 * 后者不限定具体 method：握手只用来「取 event.origin」，安全边界由白名单校验承担，
 * 限定 method 只会让我们在父页换了首个请求时白白学不到 origin。
 */
function isParentHandshake(data) {
  if (!data || typeof data !== 'object') return false;
  if (data.event === PARENT_READY_EVENT) return true;
  return data.source === 'main' && typeof data.method === 'string';
}

function send(message) {
  try {
    window.parent.postMessage(message, parentOrigin);
  } catch (_) {
    // 上报失败不得影响预览
  }
}

function flushPending() {
  while (pending.length > 0) {
    send(pending.shift());
  }
}

function rememberParentOrigin(origin) {
  if (parentOrigin || !isAllowedParentOrigin(origin)) return;
  parentOrigin = origin;
  flushPending();
}

function post(type, payload) {
  try {
    if (typeof window === 'undefined' || !window.parent || window.parent === window) return;
    const message = {
      type: NAMESPACE + ':' + type,
      payload: Object.assign({ at: Date.now() }, payload),
    };
    if (!parentOrigin) {
      // 还没学到父页 origin：先攒着，等握手到达后补发；攒满则丢最旧的一条。
      pending.push(message);
      if (pending.length > PENDING_LIMIT) pending.shift();
      return;
    }
    send(message);
  } catch (_) {
    // 上报失败不得影响预览
  }
}

if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  window.addEventListener(
    'message',
    event => {
      if (!event || event.source !== window.parent) return;
      if (!isParentHandshake(event.data)) return;
      rememberParentOrigin(event.origin);
    },
    true
  );
}

export function reportComponentRendered(info) {
  post('component-rendered', {
    package: info.package,
    componentName: info.componentName,
    viaFallback: Boolean(info.viaFallback),
  });
}

export function reportApiInvoked(info) {
  post('api-invoked', {
    package: info.package,
    apiName: info.apiName,
    viaFallback: Boolean(info.viaFallback),
    paramOk: info.paramOk !== false,
  });
}
