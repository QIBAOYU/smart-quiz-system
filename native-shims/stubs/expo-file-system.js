/**
 * expo-file-system 的 web 降级 stub
 *
 * 沙箱文件系统依赖原生。
 * 显式导出覆盖高频入口，长尾交给文件内 Proxy fallback：漏名只会让体验略糙，
 * 不会整页崩溃。升档时替换本文件实现并把 manifest 的 grade 改成 equivalent 即可。
 *
 * 本文件要同时接住两套导出面，因为 resolver 按包根投影重定向，
 * `expo-file-system/legacy` 也会落到这里（metro.config.js lookupNativeShim）：
 *
 * 1. 新 API（真包主入口 build/index.d.ts）：Paths / File / Directory 类体系
 *    + FileMode / EncodingType / UploadType 枚举。
 * 2. legacy 面（build/legacy/FileSystem.d.ts）：getInfoAsync 那批函数
 *    + documentDirectory / cacheDirectory 常量。
 *
 * 为什么 File / Directory / Paths 必须显式写出来：它们首字母大写，掉进模块级
 * Proxy 兜底会被当成组件生成占位卡，而占位卡函数体里有 React.useEffect。
 * 用户按现行文档写 `new File(...)` 等于在渲染流程之外调 hook，React 19 下
 * 当场抛 "Invalid hook call" + "Cannot read properties of null (reading 'useEffect')"，
 * 整页崩——比"功能不可用"严重得多。给能 new、不抛、方法齐的假实现才是降级。
 *
 * legacy 那半刻意比真包宽容：真包主入口的 legacy 函数现在是「调用即 throw」的
 * deprecated 壳，我们维持返回 resolved Promise 不抛。对齐真包去抛会把今天能跑的
 * 存量项目直接弄崩，降级的目标是保住预览，不是复刻真包的报错。
 */

const { createStubApi, createStubModule } = require('../runtime/stub-factory');

const PKG = 'expo-file-system';

function api(apiName, options) {
  return createStubApi(Object.assign({ package: PKG, apiName }, options || {}));
}

/** 同步方法：createStubApi 默认返回 Promise，类方法上给 Promise 会让 `file.textSync().length` 直接崩。 */
function syncApi(apiName, result) {
  return api(apiName, { async: false, result });
}

// 假路径：形状像真机 URI，前缀 preview 让用户一眼看出是预览环境的产物。
// 真包 web 上这些常量本就是 null，给字面量是为了让 `documentDirectory + 'a.txt'`
// 这类拼接不产出 "nullundefined" 这种更难排查的垃圾串。
const FAKE_DOCUMENT_DIRECTORY = 'file:///preview/document/';
const FAKE_CACHE_DIRECTORY = 'file:///preview/cache/';
const FAKE_BUNDLE_DIRECTORY = 'file:///preview/bundle/';

/** 把构造参数（string | File | Directory 混合）拼成一个 uri，形状对齐真包构造器。 */
function joinUris(uris) {
  const parts = [];
  for (const item of uris) {
    if (item === null || item === undefined) continue;
    const piece = typeof item === 'string' ? item : item.uri;
    if (typeof piece !== 'string' || piece.length === 0) continue;
    parts.push(parts.length === 0 ? piece.replace(/\/+$/, '') : piece.replace(/^\/+|\/+$/g, ''));
  }
  if (parts.length === 0) return FAKE_DOCUMENT_DIRECTORY;
  return parts.join('/');
}

function baseName(uri) {
  const trimmed = String(uri || '').replace(/\/+$/, '');
  const idx = trimmed.lastIndexOf('/');
  return idx >= 0 ? trimmed.slice(idx + 1) : trimmed;
}

function dirName(uri) {
  const trimmed = String(uri || '').replace(/\/+$/, '');
  const idx = trimmed.lastIndexOf('/');
  return idx > 0 ? trimmed.slice(0, idx) : trimmed;
}

// ---------- 枚举（真包 File.types.d.ts / NetworkTasks.types.d.ts / legacy） ----------
// 手抄而非从真包复制：真包主入口靠 requireNativeModule 求值，web 上 require 即抛，
// 复制路线在这个包上不可行（其余 fake-data 包走的是复制路线）。
const EncodingType = { UTF8: 'utf8', Base64: 'base64' };
const FileMode = { ReadWrite: 'rw', ReadOnly: 'r', WriteOnly: 'w', Append: 'wa', Truncate: 'wt' };
const UploadType = { BINARY_CONTENT: 0, MULTIPART: 1 };
// 真包 build/FileSystemWatcher.types.d.ts:7 写死 = 100。它是 watch 的默认防抖毫秒数，
// 大写开头，不补会掉进兜底变成占位卡组件，调用方拿去做数值运算即 NaN。
const DEFAULT_DEBOUNCE_MS = 100;

// ---------- 网络任务：createUploadTask / createDownloadTask 必须有东西可返回 ----------
class UploadTask {
  constructor(url) {
    this.url = url;
  }
}
UploadTask.prototype.uploadAsync = api('UploadTask.uploadAsync', {
  result: () => ({ status: 0, headers: {}, body: '' }),
});
UploadTask.prototype.cancel = syncApi('UploadTask.cancel', undefined);

class DownloadTask {
  constructor(url) {
    this.url = url;
  }
}
DownloadTask.prototype.downloadAsync = api('DownloadTask.downloadAsync', { result: () => new File(FAKE_CACHE_DIRECTORY) });
DownloadTask.prototype.pause = syncApi('DownloadTask.pause', undefined);
DownloadTask.prototype.resume = syncApi('DownloadTask.resume', undefined);
DownloadTask.prototype.cancel = syncApi('DownloadTask.cancel', undefined);

/** 订阅句柄：watch 的返回值，调用方 subscription.remove() 时不能炸。 */
function stubSubscription() {
  return { remove() {} };
}

// ---------- File ----------
class File {
  constructor(...uris) {
    this.uri = joinUris(uris);
    // 真包里 exists / size 是属性而非方法，写成方法会让 `if (file.exists)` 恒为真。
    this.exists = false;
    this.size = 0;
    this.md5 = null;
    this.type = null;
    this.modificationTime = null;
    this.creationTime = null;
    this.lastModified = null;
  }

  get name() {
    return baseName(this.uri);
  }

  get extension() {
    const name = this.name;
    const idx = name.lastIndexOf('.');
    return idx > 0 ? name.slice(idx) : '';
  }

  get parentDirectory() {
    return new Directory(dirName(this.uri));
  }
}

File.prototype.text = api('File.text', { result: '' });
File.prototype.textSync = syncApi('File.textSync', '');
File.prototype.base64 = api('File.base64', { result: '' });
File.prototype.base64Sync = syncApi('File.base64Sync', '');
File.prototype.bytes = api('File.bytes', { result: () => new Uint8Array(0) });
File.prototype.bytesSync = syncApi('File.bytesSync', () => new Uint8Array(0));
File.prototype.json = api('File.json', { result: null });
File.prototype.arrayBuffer = api('File.arrayBuffer', { result: () => new ArrayBuffer(0) });
File.prototype.write = syncApi('File.write', undefined);
File.prototype.create = syncApi('File.create', undefined);
File.prototype.delete = syncApi('File.delete', undefined);
File.prototype.info = syncApi('File.info', () => ({ exists: false, uri: FAKE_DOCUMENT_DIRECTORY }));
File.prototype.open = syncApi('File.open', () => ({ close() {}, readBytes: () => new Uint8Array(0), writeBytes() {}, offset: 0, size: 0 }));
File.prototype.copy = api('File.copy', { result: undefined });
File.prototype.copySync = syncApi('File.copySync', undefined);
File.prototype.move = api('File.move', { result: undefined });
File.prototype.moveSync = syncApi('File.moveSync', undefined);
File.prototype.rename = syncApi('File.rename', undefined);
File.prototype.upload = api('File.upload', { result: () => ({ status: 0, headers: {}, body: '' }) });
File.prototype.createUploadTask = syncApi('File.createUploadTask', url => new UploadTask(url));
File.prototype.watch = syncApi('File.watch', () => stubSubscription());
File.prototype.slice = syncApi('File.slice', () => new File(FAKE_CACHE_DIRECTORY));
File.prototype.stream = syncApi('File.stream', null);
File.prototype.readableStream = syncApi('File.readableStream', null);
File.prototype.writableStream = syncApi('File.writableStream', null);
File.prototype.formData = api('File.formData', { result: null });

File.downloadFileAsync = api('File.downloadFileAsync', { result: () => new File(FAKE_CACHE_DIRECTORY) });
File.pickFileAsync = api('File.pickFileAsync', { result: () => ({ canceled: true, result: [] }) });
File.createDownloadTask = syncApi('File.createDownloadTask', url => new DownloadTask(url));

// ---------- Directory ----------
class Directory {
  constructor(...uris) {
    // 真包的目录 uri 一律以 / 结尾，这里补齐：少一个斜杠会让
    // `Paths.document.uri + 'a.txt'` 静默拼出 ".../documenta.txt" 这类垃圾路径。
    const joined = joinUris(uris);
    this.uri = joined.endsWith('/') ? joined : `${joined}/`;
    this.exists = false;
    this.size = 0;
  }

  get name() {
    return baseName(this.uri);
  }

  get parentDirectory() {
    return new Directory(dirName(this.uri));
  }
}

Directory.prototype.list = syncApi('Directory.list', () => []);
Directory.prototype.listAsRecords = syncApi('Directory.listAsRecords', () => []);
Directory.prototype.create = syncApi('Directory.create', undefined);
Directory.prototype.delete = syncApi('Directory.delete', undefined);
Directory.prototype.info = syncApi('Directory.info', () => ({ exists: false, uri: FAKE_DOCUMENT_DIRECTORY }));
Directory.prototype.createFile = syncApi('Directory.createFile', (name) => new File(FAKE_DOCUMENT_DIRECTORY, name || 'file'));
Directory.prototype.createDirectory = syncApi('Directory.createDirectory', (name) => new Directory(FAKE_DOCUMENT_DIRECTORY, name || 'dir'));
Directory.prototype.copy = api('Directory.copy', { result: undefined });
Directory.prototype.copySync = syncApi('Directory.copySync', undefined);
Directory.prototype.move = api('Directory.move', { result: undefined });
Directory.prototype.moveSync = syncApi('Directory.moveSync', undefined);
Directory.prototype.rename = syncApi('Directory.rename', undefined);
Directory.prototype.watch = syncApi('Directory.watch', () => stubSubscription());

Directory.pickDirectoryAsync = api('Directory.pickDirectoryAsync', { result: () => new Directory(FAKE_DOCUMENT_DIRECTORY) });

// ---------- Paths ----------
// 真包里是 static getter，取值不该弹提示（`Paths.document` 只是取路径，不是调用能力），
// 所以这里直接返回假 Directory，不走 createStubApi。
class Paths {
  static get cache() {
    return new Directory(FAKE_CACHE_DIRECTORY);
  }

  static get document() {
    return new Directory(FAKE_DOCUMENT_DIRECTORY);
  }

  static get bundle() {
    return new Directory(FAKE_BUNDLE_DIRECTORY);
  }

  static get appleSharedContainers() {
    return {};
  }

  static get totalDiskSpace() {
    return 0;
  }

  static get availableDiskSpace() {
    return 0;
  }
}

// PathUtilities 那批是纯字符串运算，真包在 web 上也不碰原生，照实算比弹提示有用。
Paths.join = (...paths) => joinUris(paths);
Paths.dirname = (p) => dirName(typeof p === 'string' ? p : p && p.uri);
Paths.basename = (p, ext) => {
  const name = baseName(typeof p === 'string' ? p : p && p.uri);
  return ext && name.endsWith(ext) ? name.slice(0, -ext.length) : name;
};
Paths.extname = (p) => {
  const name = baseName(typeof p === 'string' ? p : p && p.uri);
  const idx = name.lastIndexOf('.');
  return idx > 0 ? name.slice(idx) : '';
};
Paths.isAbsolute = (p) => {
  const uri = typeof p === 'string' ? p : p && p.uri;
  return typeof uri === 'string' && (uri.startsWith('/') || uri.includes('://'));
};
Paths.normalize = (p) => String((typeof p === 'string' ? p : p && p.uri) || '').replace(/\/{2,}(?!\/)/g, '/');
Paths.relative = (from, to) => String((typeof to === 'string' ? to : to && to.uri) || '');
Paths.parse = (p) => {
  const uri = String((typeof p === 'string' ? p : p && p.uri) || '');
  return { dir: dirName(uri), base: baseName(uri), ext: Paths.extname(uri), name: Paths.basename(uri, Paths.extname(uri)), root: '' };
};
Paths.info = syncApi('Paths.info', () => ({ exists: false, isDirectory: false }));

// ---------- legacy 面（expo-file-system/legacy 投影到本文件） ----------
const getInfoAsync = api('getInfoAsync', { result: () => ({ exists: false, isDirectory: false, uri: FAKE_DOCUMENT_DIRECTORY }) });
const readAsStringAsync = api('readAsStringAsync', { result: '' });
const writeAsStringAsync = api('writeAsStringAsync');
const deleteAsync = api('deleteAsync');
const makeDirectoryAsync = api('makeDirectoryAsync');
const downloadAsync = api('downloadAsync', { result: () => ({ status: 0, uri: FAKE_CACHE_DIRECTORY, headers: {} }) });

module.exports = createStubModule(PKG, {
  // 新 API
  File,
  Directory,
  Paths,
  UploadTask,
  DownloadTask,
  EncodingType,
  FileMode,
  UploadType,
  DEFAULT_DEBOUNCE_MS,
  // legacy 面
  documentDirectory: FAKE_DOCUMENT_DIRECTORY,
  cacheDirectory: FAKE_CACHE_DIRECTORY,
  getInfoAsync,
  readAsStringAsync,
  writeAsStringAsync,
  deleteAsync,
  makeDirectoryAsync,
  downloadAsync,
});
