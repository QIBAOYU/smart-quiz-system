/**
 * expo-sqlite 的 web 降级 stub
 *
 * 本地数据库依赖原生。
 * 显式导出覆盖高频入口，长尾交给文件内 Proxy fallback：漏名只会让体验略糙，
 * 不会整页崩溃。升档时替换本文件实现并把 manifest 的 grade 改成 equivalent 即可。
 */

const { createPlaceholderComponent } = require('../runtime/placeholder-card');
const { createStubApi, createStubModule } = require('../runtime/stub-factory');
const { createStubHook } = require('../runtime/hooks');

const PKG = 'expo-sqlite';

function placeholder(componentName) {
  return createPlaceholderComponent({ package: PKG, componentName });
}

function api(apiName) {
  return createStubApi({ package: PKG, apiName });
}

const SQLiteProvider = placeholder('SQLiteProvider');
const openDatabaseAsync = api('openDatabaseAsync');
const openDatabaseSync = api('openDatabaseSync');
// hook 必须同步返回：写成 api() 会给出 Promise，调用方 const db = useSQLiteContext()
// 拿到的是 Promise，紧接着 db.execAsync(...) 直接崩。返回 undefined 让调用方的
// if (!db) 保护分支能生效。
const useSQLiteContext = createStubHook(PKG, 'useSQLiteContext');

module.exports = createStubModule(PKG, { SQLiteProvider, openDatabaseAsync, openDatabaseSync, useSQLiteContext });
