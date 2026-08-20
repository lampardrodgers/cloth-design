/**
 * 画布内容存在浏览器本地（tldraw 的 IndexedDB），跟着这台机器的这个浏览器走——但按账号分库：
 * persistenceKey 里带账号 id，账号 B 登录看不到账号 A 的画布、图片、提示词和标注；退出时把这个账号的库删掉
 * （和 localStorage / IndexedDB 里其它账号数据「退出即清」一个口径）。
 *
 * 升级前所有账号共用一座库（`clothdesign-free-canvas`）：升级后第一个登录的账号把它接过来（整库拷进自己的库、再删旧库），
 * 免得用户一刷新画布就空了。只接一次——接完旧库就没了。
 *
 * 万一存坏了（迁移失败、写了一半断电），画布可能起不来 —— 留一个「清掉重来」的口子，
 * 放在单独的文件里，这样即使 tldraw 那个大包加载失败也能调用。
 */
import { reportClientError } from "./clientErrors";
import { activeStorageAccount } from "./storageNamespace";

/** 升级前共用的 persistenceKey（现在只用来识别 / 接管旧库）。 */
export const LEGACY_CANVAS_PERSISTENCE_KEY = "clothdesign-free-canvas";

// tldraw 的库名规则：STORE_PREFIX + persistenceKey；库里四张表都是 out-of-line key
const TLDRAW_STORE_PREFIX = "TLDRAW_DOCUMENT_v2";
const TLDRAW_DB_VERSION = 4;
const TLDRAW_TABLES = ["records", "schema", "session_state", "assets"] as const;
/** 退出时等画布库删掉的上限：别的标签页还开着同一个账号的画布时会一直 blocked，不能让退出卡死。 */
const DELETE_TIMEOUT_MS = 4000;

/** 这个账号的画布 persistenceKey。 */
export function canvasPersistenceKey(accountId: string) {
  return `${LEGACY_CANVAS_PERSISTENCE_KEY}:${encodeURIComponent(accountId.trim())}`;
}

export function canvasDatabaseName(persistenceKey: string) {
  return TLDRAW_STORE_PREFIX + persistenceKey;
}

/** 删一座库。成功 true；出错 / 超时（被别的标签页占着）false。 */
function deleteDatabase(name: string, timeoutMs = DELETE_TIMEOUT_MS) {
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      resolve(ok);
    };
    const timer = window.setTimeout(() => finish(false), timeoutMs);
    try {
      const request = window.indexedDB.deleteDatabase(name);
      request.onsuccess = () => finish(true);
      request.onerror = () => finish(false);
      // 别的标签页占着库时先 blocked，等它们关了才真的删；超时就算了
    } catch {
      finish(false);
    }
  });
}

async function databaseExists(name: string) {
  try {
    if (typeof window.indexedDB.databases === "function") {
      return (await window.indexedDB.databases()).some((db) => db.name === name);
    }
  } catch {
    // 下面退回 tldraw 自己维护的库名索引
  }
  try {
    const index: unknown = JSON.parse(window.localStorage.getItem("TLDRAW_DB_NAME_INDEX_v2") || "[]");
    return Array.isArray(index) && index.includes(name);
  } catch {
    return false;
  }
}

function openCanvasDatabase(name: string) {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = window.indexedDB.open(name, TLDRAW_DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      for (const table of TLDRAW_TABLES) {
        if (!db.objectStoreNames.contains(table)) db.createObjectStore(table);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("画布库打不开"));
    request.onblocked = () => reject(new Error("画布库被其它标签页占用"));
  });
}

function readTable(db: IDBDatabase, table: string) {
  return new Promise<Array<[IDBValidKey, unknown]>>((resolve, reject) => {
    if (!db.objectStoreNames.contains(table)) {
      resolve([]);
      return;
    }
    const store = db.transaction(table, "readonly").objectStore(table);
    const keysRequest = store.getAllKeys();
    const valuesRequest = store.getAll();
    let keys: IDBValidKey[] | null = null;
    let values: unknown[] | null = null;
    const done = () => {
      if (keys && values) resolve(keys.map((key, index) => [key, values![index]]));
    };
    keysRequest.onsuccess = () => {
      keys = keysRequest.result;
      done();
    };
    valuesRequest.onsuccess = () => {
      values = valuesRequest.result;
      done();
    };
    keysRequest.onerror = () => reject(keysRequest.error);
    valuesRequest.onerror = () => reject(valuesRequest.error);
  });
}

function writeTables(db: IDBDatabase, tables: Record<string, Array<[IDBValidKey, unknown]>>) {
  return new Promise<void>((resolve, reject) => {
    const names = Object.keys(tables).filter((table) => db.objectStoreNames.contains(table));
    if (!names.length) {
      resolve();
      return;
    }
    const transaction = db.transaction(names, "readwrite");
    for (const table of names) {
      const store = transaction.objectStore(table);
      for (const [key, value] of tables[table]) store.put(value, key);
    }
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error("画布库写入失败"));
    transaction.onabort = () => reject(transaction.error ?? new Error("画布库写入被中止"));
  });
}

/**
 * 升级前共用的那座画布库，由升级后第一个登录的账号接管：整库拷进这个账号的库，再把旧库删掉。
 * 这个账号已经有自己的库、或者旧库不存在，就什么也不做。要在画布挂载之前 await。
 */
export async function adoptLegacyCanvasStore(accountId: string | null | undefined): Promise<boolean> {
  if (!accountId || typeof window === "undefined" || !window.indexedDB) return false;
  const legacyName = canvasDatabaseName(LEGACY_CANVAS_PERSISTENCE_KEY);
  const targetName = canvasDatabaseName(canvasPersistenceKey(accountId));
  try {
    if (!(await databaseExists(legacyName)) || (await databaseExists(targetName))) return false;
    const legacy = await openCanvasDatabase(legacyName);
    let target: IDBDatabase | null = null;
    try {
      const tables: Record<string, Array<[IDBValidKey, unknown]>> = {};
      for (const table of TLDRAW_TABLES) tables[table] = await readTable(legacy, table);
      target = await openCanvasDatabase(targetName);
      await writeTables(target, tables);
    } catch (error) {
      // 拷到一半失败：把半截的新库删掉，旧库留着，下次登录再接一次
      target?.close();
      legacy.close();
      await deleteDatabase(targetName);
      throw error;
    }
    target.close();
    legacy.close();
    await deleteDatabase(legacyName);
    return true;
  } catch (error) {
    reportClientError({
      scope: "canvas",
      message: `接管升级前的画布内容失败：${error instanceof Error ? error.message : String(error)}`,
      detail: { accountId },
    });
    return false;
  }
}

/**
 * 删掉这个账号的画布库（退出登录时调；要等画布组件卸载、tldraw 关掉连接之后）。
 * 返回是否真的删掉了——被别的标签页占着超时、或出错都是 false，调用方上报。
 */
export function purgeCanvasStore(accountId: string | null | undefined): Promise<boolean> {
  if (!accountId || typeof window === "undefined" || !window.indexedDB) return Promise.resolve(true);
  return deleteDatabase(canvasDatabaseName(canvasPersistenceKey(accountId)));
}

/**
 * 清空本机保存的画布内容（当前账号的库；升级前共用的旧库若还在也一起清）。
 * 清完要重新加载页面，编辑器才会重新建库。
 */
export async function resetCanvasStore(accountId: string | null | undefined = activeStorageAccount()) {
  const names = [canvasDatabaseName(LEGACY_CANVAS_PERSISTENCE_KEY)];
  if (accountId) names.unshift(canvasDatabaseName(canvasPersistenceKey(accountId)));
  // 别的标签页占着库时会 blocked，等它也没意义（有超时），直接返回让用户刷新
  await Promise.all(names.map((name) => deleteDatabase(name)));
}
