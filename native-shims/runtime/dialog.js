/**
 * 原生能力提示 dialog
 *
 * 用原生 DOM 挂 body 而不是走 React 树：stub 被调用的场景里 React 树本身可能已经
 * 处于异常状态，走 React 渲染会让提示一起失效。
 *
 * 交互契约（对齐已验证的行业实现）：每次调用都弹、DOM 单例替换（同一时刻只留最后
 * 一个）、不做节流去重。高频循环调用时表现为提示不断被替换而不是无限堆叠，页面不卡死。
 *
 * 话术分流是这里的核心：参数写错是真实代码缺陷，要引导用户找 Agent 修；
 * 原生能力在预览中不可用不是缺陷，只作告知。两者混为一谈会把用户推去修不该修的东西。
 */

const CONTAINER_ID = 'meoo-native-shim-dialog';

function isDomAvailable() {
  return typeof document !== 'undefined' && Boolean(document.body);
}

function formatArgs(args) {
  if (!args || args.length === 0) return '（无参数）';
  try {
    return args
      .map(arg => {
        if (typeof arg === 'function') return '[Function]';
        if (arg instanceof Error) return String(arg);
        return JSON.stringify(arg, null, 2);
      })
      .join('\n');
  } catch (_) {
    return '（参数无法序列化）';
  }
}

function styleOf(node, styles) {
  Object.keys(styles).forEach(key => {
    node.style[key] = styles[key];
  });
}

function removeExisting() {
  const existing = document.getElementById(CONTAINER_ID);
  if (existing && existing.parentNode) existing.parentNode.removeChild(existing);
}

export function showNativeShimDialog(options) {
  if (!isDomAvailable()) return;

  const pkg = options.package;
  const apiName = options.apiName;
  const args = options.args;
  const validation = options.validation || { ok: true };

  removeExisting();

  const overlay = document.createElement('div');
  overlay.id = CONTAINER_ID;
  styleOf(overlay, {
    position: 'fixed',
    inset: '0',
    zIndex: '2147483000',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: 'rgba(0,0,0,0.35)',
    fontFamily: '-apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif',
  });

  const panel = document.createElement('div');
  styleOf(panel, {
    width: 'min(420px, calc(100vw - 40px))',
    maxHeight: 'calc(100vh - 80px)',
    overflowY: 'auto',
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
  title.textContent = apiName ? `${apiName} 需要真机能力` : '该功能需要真机能力';
  styleOf(title, { fontSize: '16px', fontWeight: '600', color: '#1D1D1F', marginBottom: '6px' });

  const desc = document.createElement('div');
  desc.textContent = '此功能在预览中不可用，发布为正式 App 后可正常使用。';
  styleOf(desc, { fontSize: '13px', color: '#48484A', lineHeight: '1.6', marginBottom: '12px' });

  const argsLabel = document.createElement('div');
  argsLabel.textContent = `调用参数 · ${pkg}`;
  styleOf(argsLabel, { fontSize: '12px', color: '#8E8E93', marginBottom: '4px' });

  const argsBox = document.createElement('pre');
  argsBox.textContent = formatArgs(args);
  styleOf(argsBox, {
    fontSize: '12px',
    color: '#1D1D1F',
    background: '#F5F5F7',
    borderRadius: '8px',
    padding: '10px',
    margin: '0 0 12px',
    maxHeight: '160px',
    overflow: 'auto',
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-all',
  });

  const conclusion = document.createElement('div');
  if (validation.ok) {
    conclusion.textContent = '✅ 参数合规，发布后这段调用可以正常工作。';
    styleOf(conclusion, { fontSize: '13px', color: '#1B7F3B', lineHeight: '1.6' });
  } else {
    conclusion.textContent = `❌ 参数有问题：${validation.message}。这是代码缺陷，把这句话发给 Agent 让它修复。`;
    styleOf(conclusion, { fontSize: '13px', color: '#C2261C', lineHeight: '1.6' });
  }

  const close = document.createElement('button');
  close.textContent = '知道了';
  styleOf(close, {
    marginTop: '16px',
    width: '100%',
    border: 'none',
    borderRadius: '10px',
    padding: '10px',
    fontSize: '14px',
    color: '#FFFFFF',
    background: '#0A64FF',
    cursor: 'pointer',
  });
  close.onclick = removeExisting;
  overlay.onclick = event => {
    if (event.target === overlay) removeExisting();
  };

  panel.appendChild(badge);
  panel.appendChild(title);
  panel.appendChild(desc);
  panel.appendChild(argsLabel);
  panel.appendChild(argsBox);
  panel.appendChild(conclusion);
  panel.appendChild(close);
  overlay.appendChild(panel);
  document.body.appendChild(overlay);
}
