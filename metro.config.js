/**
 * @meoo-native-preview-runtime v3
 *
 * 平台托管 Metro 配置的版本标记（单一事实源）：
 * SkillInjectionService.backfillNativePreviewRuntime 解析本标记，决定导入项目
 * 沙箱里的 metro.config.js 是否需要升级覆盖。版本号只增不减；凡改动本文件的
 * 运行时行为（resolver/watcher/serializer 语义），必须同步把版本号 +1，
 * 否则已回填的存量项目永远收不到更新。
 * 版本史：v1 = 含 resolveNativeShim 但无本标记的历史版本；
 *         v2 = 新增 wasm 资产支持（expo-sqlite 官方 Web/WASM 透传）。
 *         v3 = 依赖守卫修复 Metro 虚拟模块 ID（\0shim:...）导致的目录回溯死循环，
 *              并对这类 ID 改走项目根 node_modules 的有界版本查找（校验能力不丢）。
 */
const path = require('path');
const fs = require('fs');
const { getDefaultConfig } = require('expo/metro-config');

/**
 * 修复 ENOSPC: System limit for number of file watchers reached.
 *
 * 沙箱里没有 watchman，Metro 只能退回 FallbackWatcher —— 它对每一个目录挂一个
 * inotify watch。node_modules 有近两万个文件、上万个目录，足以打爆
 * fs.inotify.max_user_watches，dev server 直接起不来。
 *
 * 官方给的口子全部堵死（逐一验证过）：
 *   1. @expo/cli 的 createFileMap-fork.js 硬编码 retainAllFiles: true；
 *   2. @expo/metro-file-map 的 build/index.js 把同一条正则同时交给索引和监听
 *      （ignorePatternForWatch: ignorePattern），配置层没有单独关掉监听的入口；
 *   3. resolver.blockList 是双向的，node_modules 一旦进去，索引同时被剪空，
 *      模块解析找不到依赖，打包必然失败。
 *
 * 因此这里在 Watcher 实例化之前，单独把 ignorePatternForWatch 合成一条包含
 * node_modules 的正则：只剪监听，不动索引。索引仍是全量，模块解析和打包完全
 * 不受影响，业务代码目录照常热重载。
 *
 * 代价：node_modules 内部的文件变化不再被监听，新装依赖需要重启 dev server
 * 才会被解析到。相比 dev server 起不来，这是可接受的取舍。
 *
 * 手法与 @expo/cli 自身的 replaceMetroFileMap() 一致，都是运行时替换模块导出。
 * 任何一步拿不到预期对象都降级为 no-op，不会影响启动。
 */
function installNodeModulesWatchIgnore() {
  const NODE_MODULES_PATTERN = '(^|[\\/\\\\])node_modules([\\/\\\\]|$)';

  const lookupPaths = [__dirname];
  try {
    lookupPaths.push(
      path.dirname(require.resolve('@expo/cli/package.json', { paths: [__dirname] }))
    );
  } catch (error) {
    // 解析不到 @expo/cli 时忽略，继续用项目根目录查找。
  }

  const watcherModule = require(
    require.resolve('@expo/metro-file-map/build/Watcher', { paths: lookupPaths })
  );

  const OriginalWatcher = watcherModule && watcherModule.Watcher;
  if (typeof OriginalWatcher !== 'function' || OriginalWatcher.__nodeModulesWatchIgnored) {
    return false;
  }

  class WatcherWithoutNodeModules extends OriginalWatcher {
    constructor(options) {
      const previous = options && options.ignorePatternForWatch;
      const merged =
        previous instanceof RegExp
          ? new RegExp(
              `(?:${previous.source})|(?:${NODE_MODULES_PATTERN})`,
              previous.flags.replace('g', '')
            )
          : new RegExp(NODE_MODULES_PATTERN);

      super({ ...options, ignorePatternForWatch: merged });
    }
  }
  WatcherWithoutNodeModules.__nodeModulesWatchIgnored = true;

  Object.defineProperty(watcherModule, 'Watcher', {
    value: WatcherWithoutNodeModules,
    writable: true,
    configurable: true,
    enumerable: true,
  });

  return true;
}

try {
  installNodeModulesWatchIgnore();
} catch (error) {
  // 裁剪失败不能影响启动：降级后行为与改动前完全一致。
  console.warn(
    '[metro.config] node_modules watch 裁剪未生效，dev server 仍会监听 node_modules：',
    error && error.message
  );
}

/**
 * Metro 自定义 resolver —— 编译期拦截非法原生依赖
 *
 * APK 模板只预装了有限的原生模块。如果 Agent 引入了不在白名单中的原生包，
 * Metro 编译虽然能通过（node_modules 存在），但 APK 运行时会 crash。
 *
 * 此 resolver 在 Metro 打包时拦截非法 import，直接抛出编译错误，
 * 让 Agent 在开发阶段就知道依赖不合法，而不是等到 APK 运行时才发现。
 */
const ALLOWED_DEPS = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'scripts', 'allowed-deps.json'), 'utf8')
);
const BLOCKED_DEPS = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'scripts', 'blocked-native-deps.json'), 'utf8')
);

// 从 import specifier 提取 npm 包名和 subpath。
// 白名单必须按包名判断，不能按完整 specifier 判断，否则会误伤：
//   expo/fetch                 -> packageName=expo, subpath=fetch
//   expo-file-system/legacy    -> packageName=expo-file-system, subpath=legacy
//   @expo/ui/jetpack-compose   -> packageName=@expo/ui, subpath=jetpack-compose
function parsePackageSpecifier(moduleName) {
  // @scope/package => @scope/package
  if (moduleName.startsWith('@')) {
    const parts = moduleName.split('/');
    const packageName = parts.length >= 2 ? `${parts[0]}/${parts[1]}` : moduleName;
    return {
      packageName,
      subpath: parts.length > 2 ? parts.slice(2).join('/') : '',
    };
  }
  // package/subpath => package
  const parts = moduleName.split('/');
  return {
    packageName: parts[0],
    subpath: parts.length > 1 ? parts.slice(1).join('/') : '',
  };
}

function getTopLevelPkgName(moduleName) {
  return parsePackageSpecifier(moduleName).packageName;
}

// Metro resolver 的 resolveRequest 会拦截所有模块解析，包括 node_modules 内部的间接引用。
// 我们需要区分「用户代码的 import」和「node_modules 内部的间接引用」。
// 判断依据：如果解析请求的 originModulePath 属于 src 源码目录，则为用户直接引入。
const PROJECT_SRC_ROOT = path.join(__dirname, 'src');

function isUserSourceFile(originModulePath) {
  if (!originModulePath) return false;
  // 项目业务源码在 src 下，但不包括 node_modules
  const relativeToSrc = path.relative(PROJECT_SRC_ROOT, originModulePath);
  return relativeToSrc &&
         !relativeToSrc.startsWith('..') &&
         !path.isAbsolute(relativeToSrc) &&
         !originModulePath.includes(path.join('node_modules'));
}

// 项目内别名。不要把 "@/..."、"~/..." 误判为 scoped npm 包。
// 如果 alias 没有配置，后续交给 Metro 报正常的 "module not found"，而不是依赖白名单错误。
function isProjectAlias(moduleName) {
  return moduleName.startsWith('@/') || moduleName.startsWith('~/');
}

// 项目内相对路径和 Node 内置模块
function isBuiltinOrLocal(moduleName) {
  if (!moduleName) return true;
  // 相对路径: ./ ../
  if (moduleName.startsWith('.') || moduleName.startsWith('/')) return true;
  // 项目别名
  if (isProjectAlias(moduleName)) return true;
  // Node 内置模块
  if (moduleName.startsWith('node:') || isNodeBuiltin(moduleName)) return true;
  return false;
}

// 常见 Node 内置模块
const NODE_BUILTINS = new Set([
  'assert', 'buffer', 'crypto', 'events', 'fs', 'http', 'https', 'os', 'path',
  'process', 'stream', 'url', 'util', 'zlib', 'assert/strict', 'stream/promises',
  'timers', 'timers/promises', 'tty', 'net', 'querystring', 'string_decoder',
]);

function isNodeBuiltin(name) {
  return NODE_BUILTINS.has(name) || NODE_BUILTINS.has(getTopLevelPkgName(name));
}

// 白名单中的包放行
function isAllowedPkg(pkgName) {
  return pkgName in ALLOWED_DEPS;
}

// 从 resolved 文件路径向上查找包的 package.json，读取 version 字段
/**
 * 从项目根 node_modules 直接读取包版本（有界查找，无目录回溯）。
 *
 * 用于 Metro 给出虚拟模块 ID（"\0shim:..."）的场景：这类 ID 不是磁盘路径，
 * 沿目录向上找 package.json 既找不到、又会死循环。但"查不到路径"不等于
 * "不该校验版本"——包就装在项目根 node_modules 下，直接按包名拼一次路径即可，
 * 版本校验能力因此不丢。只做一次 join + 读文件，不循环，无自旋风险。
 *
 * 刻意不用 require.resolve(pkgName)：monorepo / 多版本布局下它可能命中另一份副本，
 * 校验到错误的版本比不校验更糟。
 */
function getPkgVersionFromProjectRoot(pkgName) {
  try {
    const pkgJsonPath = path.join(__dirname, 'node_modules', pkgName, 'package.json');
    const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'));
    // 校验 name 一致，避免路径巧合读到无关包
    return pkgJson.name === pkgName ? pkgJson.version || null : null;
  } catch (_) {
    return null;
  }
}

function getInstalledPkgVersion(resolvedFilePath, pkgName) {
  if (!resolvedFilePath) return null;
  // Metro 的 resolution.filePath 不保证是真实文件路径：Expo Web 解析
  // react-native-web 的 BackHandler 等导出时会给出 "\0shim:react-native-web/..."
  // 这类虚拟模块 ID。它们没有可读的 package.json，更致命的是相对 ID 的
  // path.parse(dir).root 是空串，回溯到 "." 之后 path.dirname(".") 恒为 "."，
  // 下面的 while 永远到不了 root —— Metro 主线程原地自旋，Web 预览白屏。
  // 虚拟/相对 ID 不做目录回溯，改走下面的有界兜底查找。
  if (!path.isAbsolute(resolvedFilePath)) {
    return getPkgVersionFromProjectRoot(pkgName);
  }
  // 从 resolved 路径向上查找包含 package.json 的目录
  let dir = path.dirname(resolvedFilePath);
  const root = path.parse(dir).root;
  while (dir !== root) {
    const pkgJsonPath = path.join(dir, 'package.json');
    try {
      const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'));
      if (pkgJson.name === pkgName) {
        return pkgJson.version || null;
      }
    } catch (_) {
      // package.json 不存在或无法解析，继续向上
    }
    // 遇到 node_modules 根目录边界，向上跳一级继续
    // 独立的进度保护：父目录不再变化就停。上面的 isAbsolute 已挡掉已知的虚拟 ID，
    // 这一层兜住未来任何非标准路径形态，确保循环一定收敛（绝不再自旋）。
    const parentDir = path.dirname(dir);
    if (parentDir === dir) break;
    dir = parentDir;
  }
  return null;
}

// 简易 semver satisfies：检查 installed 是否满足 allowedRange
// 支持 ~1.2.3、^1.2.3、精确版本 1.2.3
function versionSatisfies(installed, allowedRange) {
  if (!installed || !allowedRange) return false;
  // 去掉前缀 ^ ~ >= > <= <
  const cleanRange = allowedRange.replace(/^[\^~>=<]+/, '');
  const prefix = allowedRange.match(/^[\^~>=<]+/)?.[0] || '';

  const instParts = installed.split('.').map(Number);
  const rangeParts = cleanRange.split('.').map(Number);

  if (prefix === '~') {
    // ~1.2.3 => >=1.2.3 <1.3.0
    return instParts[0] === rangeParts[0] &&
           instParts[1] === rangeParts[1] &&
           instParts[2] >= rangeParts[2];
  }
  if (prefix === '^') {
    // ^1.2.3 => >=1.2.3 <2.0.0
    return instParts[0] === rangeParts[0] &&
           (instParts[1] > rangeParts[1] ||
            (instParts[1] === rangeParts[1] && instParts[2] >= rangeParts[2]));
  }
  // 精确版本
  return installed === cleanRange;
}

// ============================================================
// 原生能力 web 降级：native-shims 重定向
//
// 目标是「一个 native-only 组件不应导致整页不可预览」。native-shims/manifest.json
// 是分档的单一事实源，沙箱扫描器读同一份文件推导静态分档，这里读同一份文件做
// 运行时重定向，两者天然一致，不存在双清单漂移。
//
// 仅在 platform === 'web' 生效，原生打包路径零影响。
// ============================================================
const NATIVE_SHIMS_DIR = path.join(__dirname, 'native-shims');
const NATIVE_SHIMS_MANIFEST = path.join(NATIVE_SHIMS_DIR, 'manifest.json');

// manifest 缺失是合法状态：存量项目的模板同步有防覆盖保护，不会补齐新增目录之外的
// 配置，此时整条降级链路降级为「不介入」，保持改动前行为。
function loadNativeShimManifest() {
  try {
    const raw = JSON.parse(fs.readFileSync(NATIVE_SHIMS_MANIFEST, 'utf8'));
    const entries = {};
    for (const key of Object.keys(raw)) {
      if (key.startsWith('__')) continue; // 元数据键
      entries[key] = raw[key];
    }
    return entries;
  } catch (_) {
    return {};
  }
}

const NATIVE_SHIM_ENTRIES = loadNativeShimManifest();

// 后缀键预先摊平，避免每次解析都遍历整张表。只有 match: 'suffix' 的条目参与，
// 当前仅用于工具链模块（错误浮层控件与它所在的包不同名，包根键够不着）。
const NATIVE_SHIM_SUFFIX_ENTRIES = Object.keys(NATIVE_SHIM_ENTRIES)
  .filter(key => NATIVE_SHIM_ENTRIES[key] && NATIVE_SHIM_ENTRIES[key].match === 'suffix')
  .map(key => ({ suffix: key, entry: NATIVE_SHIM_ENTRIES[key] }));

// 精确子路径优先于包根：@expo/ui/swift-ui 命中 shimmed，而 @expo/ui 根包保持 passthrough。
// 这与扫描器的两级判断顺序必须完全一致，否则静态分档与运行时行为会分叉。
//
// 后缀匹配是第三级、也是最后一级，只对 scope: 'toolchain' 的条目开放：
// 它按 specifier 尾巴命中，粒度最粗，排在最后才不会把前两级的精确判断吃掉。
// 扫描器不需要镜像这一级——它分类的是**用户源码里的 import**，而工具链模块
// （Expo 自己的错误浮层）从不出现在用户源码里；真出现了也该按 passthrough 处理，
// 正是扫描器查不到条目时的默认结果。两边结论仍然一致。
function lookupNativeShim(moduleName) {
  if (NATIVE_SHIM_ENTRIES[moduleName]) return NATIVE_SHIM_ENTRIES[moduleName];
  const { packageName } = parsePackageSpecifier(moduleName);
  if (packageName !== moduleName && NATIVE_SHIM_ENTRIES[packageName]) {
    return NATIVE_SHIM_ENTRIES[packageName];
  }
  for (const candidate of NATIVE_SHIM_SUFFIX_ENTRIES) {
    if (moduleName.endsWith(candidate.suffix)) return candidate.entry;
  }
  return null;
}

// stub 自身对原包的引用必须放行，否则会自环。
//
// 升档到 equivalent 的 stub 往往需要「桌面 Web 走自研实现、其余平台透传原包」的
// 分叉，实现方式就是在 stub 内部 require 原包再导出。但 resolveNativeShim 对所有
// 请求一视同仁，stub 里的 require('expo-camera') 会被再次重定向回 stub 自己，
// 形成无限自环，dev server 直接卡死。
//
// 这里按请求来源切一刀：只要发起请求的文件位于 native-shims/ 内，就不再重定向，
// 交回 Metro 正常解析拿到真包。用户源码的 import 不受影响，因为它们永远不在
// native-shims/ 目录下。
function isFromNativeShim(originModulePath) {
  if (!originModulePath) return false;
  const normalized = path.resolve(originModulePath);
  const shimsDirWithSep = NATIVE_SHIMS_DIR.endsWith(path.sep)
    ? NATIVE_SHIMS_DIR
    : NATIVE_SHIMS_DIR + path.sep;
  return normalized.startsWith(shimsDirWithSep);
}

function resolveNativeShim(moduleName, platform, originModulePath) {
  if (platform !== 'web') return null;
  if (isFromNativeShim(originModulePath)) return null;
  const entry = lookupNativeShim(moduleName);
  if (!entry || entry.tier !== 'shimmed' || !entry.replacement) return null;
  const filePath = path.resolve(NATIVE_SHIMS_DIR, entry.replacement);
  if (!fs.existsSync(filePath)) return null;
  return { type: 'sourceFile', filePath };
}

function dependencyGuardResolver(context, moduleName, platform, resolverOptions) {
  // 放行：相对路径、Node 内置模块
  if (isBuiltinOrLocal(moduleName)) {
    return context.resolveRequest(context, moduleName, platform, resolverOptions);
  }

  // web 降级重定向先于依赖白名单校验：被 stub 接管的包不需要再走版本校验，
  // 且 stub 自身位于 native-shims/（非 src/），其内部 import 不会被下面的守卫拦截。
  const originPath = context.originModulePath || context.file;
  const shimResolution = resolveNativeShim(moduleName, platform, originPath);
  if (shimResolution) return shimResolution;

  const { packageName: pkgName } = parsePackageSpecifier(moduleName);
  const fromUserSource = originPath && isUserSourceFile(originPath);

  // 放行：node_modules 内部的间接引用（只拦截用户源码的直接 import）
  if (!fromUserSource) {
    return context.resolveRequest(context, moduleName, platform, resolverOptions);
  }

  // --- 以下只对用户源码的 import 做校验 ---

  // 黑名单包（未预装的原生包）→ 拦截并提示替代方案
  if (pkgName in BLOCKED_DEPS) {
    throw new Error(
      `❌ 禁止引入 "${pkgName}"：${BLOCKED_DEPS[pkgName]}，沙箱未预装，APK 运行时会 crash。\n` +
      `  → 黑名单见 scripts/blocked-native-deps.json`
    );
  }

  // 不在白名单也不在黑名单 → 纯 JS 包，放行
  if (!isAllowedPkg(pkgName)) {
    return context.resolveRequest(context, moduleName, platform, resolverOptions);
  }

  // 白名单包及其公开 subpath → 解析后校验版本。
  // 注意：这里必须先允许 subpath 进入 Metro 正常解析，避免误伤 expo/fetch、
  // expo-file-system/legacy、expo-router/entry 等白名单包自带入口。
  const resolution = context.resolveRequest(context, moduleName, platform, resolverOptions);
  const resolvedPath = resolution?.type === 'sourceFile' ? resolution.filePath : null;
  const installedVersion = getInstalledPkgVersion(resolvedPath, pkgName);
  const allowedVersion = ALLOWED_DEPS[pkgName];

  if (installedVersion && !versionSatisfies(installedVersion, allowedVersion)) {
    throw new Error(
      `❌ "${moduleName}" 版本不匹配：基础包 "${pkgName}" 已安装 ${installedVersion}，APK 预装版本要求 ${allowedVersion}。\n` +
      `  → 请将 package.json 中 ${pkgName} 的版本改为 "${allowedVersion}"。`
    );
  }

  return resolution;
}

const config = getDefaultConfig(__dirname);
const defaultGetModulesRunBeforeMainModule =
  config.serializer.getModulesRunBeforeMainModule;

config.serializer.getModulesRunBeforeMainModule = (entryFilePath) => {
  const defaultModules = defaultGetModulesRunBeforeMainModule
    ? defaultGetModulesRunBeforeMainModule(entryFilePath)
    : [];

  return [
    ...defaultModules,
    path.resolve(__dirname, 'src/jsErrorReporter.ts'),
  ];
};

config.resolver.resolveRequest = dependencyGuardResolver;

// expo-sqlite web 透传（官方 Web/WASM 实现）依赖：其 worker 需要把 wa-sqlite.wasm
// 当资产加载，而 Metro 默认 assetExts 不含 wasm，缺了它 web 打包直接失败。
// 幂等并入，不覆盖默认表。
config.resolver.assetExts = Array.from(new Set([...(config.resolver.assetExts || []), 'wasm']));

// 索引侧裁剪：下列目录不参与 JS 打包，从 Metro 索引中排除可以减小 haste map 体积。
// 注意这只是瘦身，不是 ENOSPC 的解药 —— blockList 是双向的，真正把 node_modules
// 从监听里摘掉的是文件顶部的 installNodeModulesWatchIgnore()。两者分工不同，别合并。
const extraExcludes = [
  /[/\\](?:\.git|\.expo|\.turbo|\.next|coverage)(?:$|[/\\].*)/,
  /[/\\]android[/\\](?:\.gradle|\.cxx|build)(?:$|[/\\].*)/,
  /[/\\]android[/\\]app[/\\]build(?:$|[/\\].*)/,
  /[/\\]ios[/\\](?:Pods|build|DerivedData)(?:$|[/\\].*)/,
  /[/\\]node_modules[/\\].*[/\\](?:prebuilds|dSYMs|spm-deps|__tests__|__fixtures__|docs|documentation|example|examples|website)(?:$|[/\\].*)/,
  /[/\\]node_modules[/\\].*[/\\][^/\\]+\.xcframework(?:$|[/\\].*)/,
  /[/\\]node_modules[/\\].*[/\\]android[/\\](?:\.gradle|\.cxx|build)(?:$|[/\\].*)/,
  /[/\\]node_modules[/\\].*[/\\]android[/\\]app[/\\]build(?:$|[/\\].*)/,
  /[/\\]node_modules[/\\].*[/\\]ReactAndroid[/\\]build(?:$|[/\\].*)/,
  /[/\\]node_modules[/\\].*[/\\]ios[/\\](?:Pods|build|DerivedData)(?:$|[/\\].*)/,
];
if (Array.isArray(config.resolver.blockList)) {
  config.resolver.blockList = config.resolver.blockList.concat(extraExcludes);
} else if (config.resolver.blockList) {
  config.resolver.blockList = [config.resolver.blockList].concat(extraExcludes);
} else {
  config.resolver.blockList = extraExcludes;
}

module.exports = config;
