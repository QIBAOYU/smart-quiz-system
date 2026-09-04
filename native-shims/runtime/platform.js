/**
 * stub 共用的运行环境判断
 *
 * 抽出来是因为「桌面 Web / 移动 Web」这条分叉在多个升档包里重复出现：
 * 移动浏览器往往能借系统能力（如 input capture 直接唤起相机）拿到接近真机的
 * 体验，此时透传真包比我们自己模拟更好；桌面浏览器缺这类系统入口，才需要
 * 我们补自研实现。判断逻辑散落在各 stub 里迟早会漂移，统一放这里。
 *
 * UA 粗判精度有限（可被伪造、平板归类模糊），但这里的判断只影响「走哪条降级
 * 路径」，两条路径都是可用的，判错的代价是体验差异而不是功能失效，够用。
 */

export function isWebRuntime() {
  return typeof window !== 'undefined' && typeof document !== 'undefined';
}

export function isMobileWeb() {
  if (typeof navigator === 'undefined') return false;
  return /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent || '');
}

/** 桌面浏览器且具备摄像头采集能力，才走自研的相机实现。 */
export function isDesktopWeb() {
  if (!isWebRuntime() || typeof navigator === 'undefined') return false;
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return false;
  return !isMobileWeb();
}
