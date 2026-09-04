/**
 * 数据库初始化骨架（平台托管，业务代码不要绕开它拿句柄）
 *
 * 为什么存在这个文件——三条硬理由：
 *
 * 1. 迁移完成后才发布句柄。"opened 不等于 initialized"：openDatabaseAsync 返回后
 *    schema 可能还没建好，业务此时拿到句柄就查询，会得到 "no such table"。这个竞态
 *    在 Web 预览（wasm + Worker，IO 慢）下高概率出现，在真机上同样存在只是窗口更小。
 *    本骨架用 Promise 锁保证：句柄只在全部迁移执行完之后对外可见。
 *
 * 2. 全应用单句柄。同名数据库开多个句柄时共享同一底层实体，任何一处 close 都会让
 *    其余句柄操作报 "not a database"。模块级单例 + 并发去重（in-flight Promise 复用）
 *    从结构上排除多句柄。也因此禁用 SQLiteProvider/useSQLiteContext（Context 模式
 *    会另开句柄，与本单例冲突）。
 *
 * 3. 只用 async API。Web 预览环境没有 SharedArrayBuffer，sync 系（openDatabaseSync/
 *    execSync/getAllSync 等）会直接崩；Expo 官方也推荐 async 路径，async 等价物
 *    功能完全一致，禁用不损失任何能力。同理 withExclusiveTransactionAsync 在 Web
 *    实现中不受支持，事务一律用 withTransactionAsync。
 */
import * as SQLite from 'expo-sqlite';

export interface Migration {
  /** 递增整数版本号，从 1 开始；执行成功后写入 PRAGMA user_version */
  version: number;
  /** 该版本要执行的 DDL/DML 语句，整个版本在一个事务里原子执行 */
  statements: string[];
}

export const DB_NAME = 'app.db';

/**
 * 全部 schema 迁移都登记在这里（version 递增），业务代码不要在别处执行 DDL。
 * version 1 的 kv 表用于保存本机设备标识（见 services/deviceId.ts），
 * 云端题库按该标识隔离，因此它必须活过 App 重启，只在卸载/清除数据时丢失。
 */
export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    statements: ['CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL)'],
  },
];

let db: SQLite.SQLiteDatabase | null = null;
let initPromise: Promise<SQLite.SQLiteDatabase> | null = null;

async function runMigrations(handle: SQLite.SQLiteDatabase): Promise<void> {
  const row = await handle.getFirstAsync<{ user_version: number }>('PRAGMA user_version');
  const current = row?.user_version ?? 0;
  const pending = MIGRATIONS
    .filter((migration) => migration.version > current)
    .sort((a, b) => a.version - b.version);

  for (const migration of pending) {
    if (!Number.isSafeInteger(migration.version) || migration.version <= 0) {
      throw new Error(`[database] 非法迁移版本号: ${String(migration.version)}`);
    }
    await handle.withTransactionAsync(async () => {
      for (const statement of migration.statements) {
        await handle.execAsync(statement);
      }
      await handle.execAsync(`PRAGMA user_version = ${migration.version}`);
    });
  }
}

/**
 * 获取数据库句柄的唯一入口。可在任意处并发调用：
 * 已初始化直接返回；初始化进行中复用同一个 Promise；失败后允许重试。
 */
export async function initDatabase(): Promise<SQLite.SQLiteDatabase> {
  if (db) return db;
  if (initPromise) return initPromise;

  initPromise = (async () => {
    const next = await SQLite.openDatabaseAsync(DB_NAME);
    await runMigrations(next);
    db = next; // 最后发布：迁移没跑完之前，任何调用方都拿不到句柄
    return next;
  })();

  try {
    return await initPromise;
  } finally {
    if (!db) initPromise = null; // 初始化失败则重置，下一次调用可重试
  }
}
