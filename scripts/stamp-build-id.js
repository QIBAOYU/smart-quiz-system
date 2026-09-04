#!/usr/bin/env node
/**
 * 构建标识符（meooBuildId）
 *
 * 目的：让 web 预览和 APK 能被识别是不是同一份源码。两端读同一份 app.json，
 * 所以只要在出包前把指纹写进 expo.extra.meooBuildId，它会自动同时进 web bundle
 * 与 APK，不需要两条链路各算一次。
 *
 * 只用 node 内置模块（fs / path / crypto）：本脚本要在沙箱里跑，那里没有额外依赖。
 *
 * 两个模式：
 *   --write  算完写进 app.json 的 expo.extra.meooBuildId（幂等：值相同就不写文件）
 *   --print  只算不写，把 32 位 md5 打到 stdout
 *
 * 指纹输入集（刻意枚举，不做全目录扫描）：
 *   · src/**              （排除 *.log、*.tsbuildinfo 这类构建噪音）
 *   · assets/**
 *   · metro.config.js
 *   · package.json 的 dependencies 字段（只认依赖，devDeps/scripts 变动不影响产物）
 *   · app.json（必须剔除 expo.extra.meooBuildId 本身，否则自我引用，指纹算不收敛）
 *
 * 为什么排除 native-shims/**：metro.config.js 的 resolveNativeShim 第一行就是
 * `if (platform !== 'web') return null`，整个 native-shims 目录只影响 web 打包，
 * 原生打包路径根本不经过它。把它纳进指纹会导致「改了一个 stub → 指纹变 →
 * 判定 APK 落后于源码」，而这个 APK 本来就不该受它影响——是纯粹的假阴性来源。
 *
 * 算法（定死，改动会让新旧 buildId 不可比）：
 *   md5( 排序后的 "相对路径\0该文件内容的 md5" 逐行拼接，行间用 \n )
 *   · 相对路径一律用 POSIX 分隔符
 *   · 排序按路径的 UTF-8 字节序（不是 JS 默认的 UTF-16 码元序）
 *   · 普通文件取原始字节的 md5；package.json#dependencies 与 app.json 两条是
 *     派生条目，取「规范化 JSON（键升序、无空白）」的 md5，这样纯格式调整
 *     （缩进、键顺序）不会改指纹，语义变化才会
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PROJECT_DIR = path.resolve(__dirname, '..');
const APP_JSON_PATH = path.join(PROJECT_DIR, 'app.json');
const BUILD_ID_KEY = 'meooBuildId';

/** 递归扫描的根目录 */
const SCAN_ROOTS = ['src', 'assets'];
/** 逐个纳入的单文件 */
const SINGLE_FILES = ['metro.config.js'];
/** 扫描时整目录跳过：native-shims 见文件头说明，其余是构建产物/依赖 */
const EXCLUDED_DIRS = new Set(['native-shims', 'node_modules', 'dist', '.expo', '.git']);
/** 扫描时按扩展名跳过的构建噪音 */
const EXCLUDED_EXTENSIONS = new Set(['.log', '.tsbuildinfo']);

function md5(buffer) {
  return crypto.createHash('md5').update(buffer).digest('hex');
}

/** 规范化 JSON：对象键升序、无多余空白，让纯格式调整不影响指纹。 */
function canonicalize(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map(k => `${JSON.stringify(k)}:${canonicalize(value[k])}`).join(',')}}`;
}

function readJsonSafe(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_) {
    return null;
  }
}

/** 收集一个根目录下的全部文件，返回相对项目根的 POSIX 路径。 */
function collectFiles(rootRelative) {
  const absRoot = path.join(PROJECT_DIR, rootRelative);
  const out = [];
  let stat;
  try {
    stat = fs.statSync(absRoot);
  } catch (_) {
    return out; // 目录不存在（例如项目还没建 assets/）：跳过，不报错
  }
  if (!stat.isDirectory()) return out;

  const stack = [rootRelative];
  while (stack.length > 0) {
    const currentRel = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(path.join(PROJECT_DIR, currentRel), { withFileTypes: true });
    } catch (_) {
      continue;
    }
    for (const entry of entries) {
      const childRel = `${currentRel}/${entry.name}`;
      if (entry.isDirectory()) {
        if (EXCLUDED_DIRS.has(entry.name)) continue;
        stack.push(childRel);
      } else if (entry.isFile()) {
        if (EXCLUDED_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue;
        out.push(childRel);
      }
    }
  }
  return out;
}

/**
 * 取 app.json 中参与指纹的部分：整份内容剔除 expo.extra.meooBuildId。
 *
 * 剔除后若 extra 变成空对象，要一并删掉——否则「首次写入前（无 extra）」与
 * 「写入后（extra 只剩空壳）」会算出两个不同的指纹，--write 永远收敛不了。
 */
function appJsonFingerprintSource() {
  const appJson = readJsonSafe(APP_JSON_PATH);
  if (appJson === null) return null;
  const clone = JSON.parse(JSON.stringify(appJson));
  const extra = clone && clone.expo && clone.expo.extra;
  if (extra && typeof extra === 'object') {
    delete extra[BUILD_ID_KEY];
    if (Object.keys(extra).length === 0) delete clone.expo.extra;
  }
  return clone;
}

function computeBuildId() {
  /** @type {Array<{ relPath: string, contentHash: string }>} */
  const entries = [];

  for (const root of SCAN_ROOTS) {
    for (const relPath of collectFiles(root)) {
      try {
        entries.push({ relPath, contentHash: md5(fs.readFileSync(path.join(PROJECT_DIR, relPath))) });
      } catch (_) {
        // 读不到的文件（软链断裂、权限）直接跳过：指纹是"尽力而为的同源判据"，
        // 不该因为一个读不了的文件把出包流程搞挂
      }
    }
  }

  for (const relPath of SINGLE_FILES) {
    try {
      entries.push({ relPath, contentHash: md5(fs.readFileSync(path.join(PROJECT_DIR, relPath))) });
    } catch (_) {
      // 文件不存在就不参与指纹
    }
  }

  // package.json 只取 dependencies：devDependencies / scripts 的变动不进产物
  const pkg = readJsonSafe(path.join(PROJECT_DIR, 'package.json'));
  if (pkg && pkg.dependencies) {
    entries.push({ relPath: 'package.json#dependencies', contentHash: md5(canonicalize(pkg.dependencies)) });
  }

  const appJsonSource = appJsonFingerprintSource();
  if (appJsonSource !== null) {
    entries.push({ relPath: 'app.json', contentHash: md5(canonicalize(appJsonSource)) });
  }

  // 按路径的 UTF-8 字节序排序：JS 默认的字符串比较是 UTF-16 码元序，
  // 中文/emoji 文件名下两者结果不同，写死字节序才能跨环境稳定复现。
  entries.sort((a, b) => Buffer.compare(Buffer.from(a.relPath, 'utf8'), Buffer.from(b.relPath, 'utf8')));

  const manifest = entries.map(e => `${e.relPath}\0${e.contentHash}`).join('\n');
  return md5(Buffer.from(manifest, 'utf8'));
}

/** 把 buildId 写进 app.json；值没变则不落盘（幂等）。返回是否真的写了。 */
function writeBuildId(buildId) {
  const raw = fs.readFileSync(APP_JSON_PATH, 'utf8');
  const appJson = JSON.parse(raw);
  if (!appJson.expo || typeof appJson.expo !== 'object') appJson.expo = {};
  if (!appJson.expo.extra || typeof appJson.expo.extra !== 'object') appJson.expo.extra = {};
  if (appJson.expo.extra[BUILD_ID_KEY] === buildId) return false;

  appJson.expo.extra[BUILD_ID_KEY] = buildId;
  // 缩进沿用模板 app.json 的 2 空格，避免每次出包都把整份文件重排一遍
  fs.writeFileSync(APP_JSON_PATH, `${JSON.stringify(appJson, null, 2)}\n`, 'utf8');
  return true;
}

function main() {
  const args = process.argv.slice(2);
  const wantWrite = args.includes('--write');
  const wantPrint = args.includes('--print');

  if (wantWrite && wantPrint) {
    console.error('[stamp-build-id] --write 与 --print 互斥，一次只能选一个');
    process.exit(1);
  }
  if (!wantWrite && !wantPrint) {
    console.error('[stamp-build-id] 用法：node scripts/stamp-build-id.js --write | --print');
    process.exit(1);
  }

  // --print 是排查用的诊断入口，不在任何构建链上，所以不吞异常。
  // 但有一种"不异常却不可比"的情况要显式提示：app.json 存在却解析不了时，
  // readJsonSafe 会静默跳过该条目，算出的指纹不含 app.json，与 app.json 正常时
  // 算出的值不可直接比较。这类降级必须让操作者看见，否则会拿着一个不可比的
  // md5 去下"版本不一致"的结论。提示走 stderr，不污染 stdout 的取值管道。
  if (wantPrint) {
    if (fs.existsSync(APP_JSON_PATH) && readJsonSafe(APP_JSON_PATH) === null) {
      console.error('[stamp-build-id] 警告：app.json 解析失败，本次指纹不含 app.json，与正常情况下的值不可比');
    }
    process.stdout.write(`${computeBuildId()}\n`);
    return;
  }

  // --write 挂在 package.json 的 export:android && 链最前面，任何异常都会阻断出包。
  // 但 buildId 只是观测能力、不是产物的一部分，没有理由为它牺牲一次出包
  // （出包是整条链上最贵的一步，失败一次用户要重跑好几分钟）。
  //
  // 因此这里一律 fail open：失败只 warn、退出码保持 0，把真正的问题留给紧随其后的
  // expo export 去报——app.json 坏掉时它自己也读不了，且它的报错比这里的 JSON
  // 解析堆栈更准确。
  //
  // fail open 不会让版本判定失真：写入失败时 app.json 保留旧 buildId，现场
  // `--print` 算出的新指纹与旧值不等，会被判成「APK 落后于预览」——结论是保守的，
  // 绝不会误判成「一致」。若 app.json 已损坏，ApkBuilderService.readAppMeta 那侧的
  // JSON.parse 同样会 catch 掉并返回 null，两端一起降级为「未知」。
  try {
    const buildId = computeBuildId();
    const changed = writeBuildId(buildId);
    console.log(`[stamp-build-id] meooBuildId=${buildId}${changed ? '' : '（未变化，跳过写入）'}`);
  } catch (err) {
    console.warn(`[stamp-build-id] 写入失败，跳过本次标记（不阻断出包）：${err && err.message}`);
  }
}

main();
