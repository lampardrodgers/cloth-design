/**
 * 画布内容存在浏览器本地（tldraw 的 IndexedDB），跟着这台机器的这个浏览器走——但按账号分库：
 * persistenceKey 里带账号 id，账号 B 登录看不到账号 A 的画布、图片、提示词和标注；退出时把这个账号的库删掉
 * （和 localStorage / IndexedDB 里其它账号数据「退出即清」一个口径）。
 *
 * 退出时删库要等画布卸载、tldraw 关掉连接，所以先把「待清账号」写进设备级的 `clothdesign:pending-canvas-purge`，
 * 删成功才划掉；退出后马上关页也不怕——下次启动、以及任何账号登录挂画布之前都会先把待清的补删掉。
 *
 * 升级前所有账号共用一座库（`clothdesign-free-canvas`）：升级后第一个登录的账号把它接过来（整库拷进自己的库、再删旧库），
 * 免得用户一刷新画布就空了。接管分两步并把「归属 + 进行到哪一步」写进设备级的 `clothdesign:legacy-canvas-migration`：
 * 先认领（写归属）再拷，拷完记 stage=delete，旧库确认删掉才算完、标记才清。中途关页 / 删不掉，下次只有归属账号能继续或删，
 * 别的账号一律不碰——不会出现「A 拷完没删掉、A 退出、B 登录把旧库当成自己的接过去」。
 *
 * 万一存坏了（迁移失败、写了一半断电），画布可能起不来 —— 留一个「清掉重来」的口子，
 * 放在单独的文件里，这样即使 tldraw 那个大包加载失败也能调用。
 */
import { reportClientError } from "./clientErrors";
import { readDurableState, registerDurableKey, writeDurableState } from "./durableState";
import { activeStorageAccount } from "./storageNamespace";

/** 升级前共用的 persistenceKey（现在只用来识别 / 接管旧库）。 */
export const LEGACY_CANVAS_PERSISTENCE_KEY = "clothdesign-free-canvas";
/** 旧库接管的归属和进度：`{ accountId, stage: "copy" | "delete" }`；没有 / null = 没人认领（或已经接完）。 */
export const LEGACY_CANVAS_MIGRATION_KEY = "clothdesign:legacy-canvas-migration";
/** 退出时还没删掉的画布库归属的账号 id 列表。 */
export const PENDING_CANVAS_PURGE_KEY = "clothdesign:pending-canvas-purge";
registerDurableKey(LEGACY_CANVAS_MIGRATION_KEY);
registerDurableKey(PENDING_CANVAS_PURGE_KEY);

// tldraw 的库名规则：STORE_PREFIX + persistenceKey；库里四张表都是 out-of-line key
const TLDRAW_STORE_PREFIX = "TLDRAW_DOCUMENT_v2";
const TLDRAW_DB_VERSION = 4;
const TLDRAW_TABLES = ["records", "schema", "session_state", "assets"] as const;
// 跨标签共享的控制面：迁移归属和每个账号各自的待清标记都放在独立 IndexedDB 里。
// IndexedDB 的 readwrite 事务会在同一个 origin 内串行，不能像 localStorage 数组那样互相覆盖。
const CONTROL_DB_NAME = "clothdesign-canvas-control";
const CONTROL_DB_VERSION = 1;
const CONTROL_STORE = "state";
const MIGRATION_CONTROL_KEY = "legacy-migration";
const PURGE_CONTROL_PREFIX = "purge:";
/** 等一座库删掉的上限：别的标签页还开着同一个账号的画布时会一直 blocked，不能让退出 / 登录卡死。 */
const DELETE_TIMEOUT_MS = 4000;

interface LegacyMigration {
  accountId: string;
  stage: "copy" | "delete";
}

/** 这个账号的画布 persistenceKey。 */
export function canvasPersistenceKey(accountId: string) {
  return `${LEGACY_CANVAS_PERSISTENCE_KEY}:${encodeURIComponent(accountId.trim())}`;
}

export function canvasDatabaseName(persistenceKey: string) {
  return TLDRAW_STORE_PREFIX + persistenceKey;
}

const legacyDatabaseName = canvasDatabaseName(LEGACY_CANVAS_PERSISTENCE_KEY);
const accountDatabaseName = (accountId: string) => canvasDatabaseName(canvasPersistenceKey(accountId));

/* ── 设备级标记 ─────────────────────────────────────────────────────────── */

function asMigration(value: unknown): LegacyMigration | null {
  if (!value || typeof value !== "object" || typeof (value as LegacyMigration).accountId !== "string" || !(value as LegacyMigration).accountId) return null;
  return (value as LegacyMigration).stage === "copy" || (value as LegacyMigration).stage === "delete" ? (value as LegacyMigration) : null;
}

function readMigrationMirror(): LegacyMigration | null {
  const value = readDurableState<LegacyMigration | null>(LEGACY_CANVAS_MIGRATION_KEY, null);
  return asMigration(value);
}

function writeMigrationMirror(value: LegacyMigration | null) {
  return writeDurableState(LEGACY_CANVAS_MIGRATION_KEY, value);
}

function readPendingPurgeMirror(): string[] {
  const value = readDurableState<unknown>(PENDING_CANVAS_PURGE_KEY, []);
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.length > 0) : [];
}

function purgeControlKey(accountId: string) {
  return PURGE_CONTROL_PREFIX + encodeURIComponent(accountId);
}

function openControlDatabase() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = window.indexedDB.open(CONTROL_DB_NAME, CONTROL_DB_VERSION);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(CONTROL_STORE)) request.result.createObjectStore(CONTROL_STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("画布控制库打不开"));
    request.onblocked = () => reject(new Error("画布控制库被其它标签页占用"));
  });
}

async function readControlValue<T>(key: string): Promise<T | undefined> {
  const db = await openControlDatabase();
  return new Promise((resolve, reject) => {
    let value: T | undefined;
    const tx = db.transaction(CONTROL_STORE, "readonly");
    const request = tx.objectStore(CONTROL_STORE).get(key);
    request.onsuccess = () => {
      value = request.result as T | undefined;
    };
    request.onerror = () => reject(request.error ?? new Error("读取画布控制状态失败"));
    tx.oncomplete = () => {
      db.close();
      resolve(value);
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error ?? new Error("读取画布控制状态失败"));
    };
    tx.onabort = tx.onerror;
  });
}

async function writeControlValue(key: string, value: unknown): Promise<void> {
  const db = await openControlDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(CONTROL_STORE, "readwrite");
    tx.objectStore(CONTROL_STORE).put(value, key);
    tx.oncomplete = () => {
      db.close();
      resolve();
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error ?? new Error("写入画布控制状态失败"));
    };
    tx.onabort = tx.onerror;
  });
}

async function deleteControlValue(key: string): Promise<void> {
  const db = await openControlDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(CONTROL_STORE, "readwrite");
    tx.objectStore(CONTROL_STORE).delete(key);
    tx.oncomplete = () => {
      db.close();
      resolve();
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error ?? new Error("删除画布控制状态失败"));
    };
    tx.onabort = tx.onerror;
  });
}

/** 用同一个 readwrite 事务认领旧库；不同标签页不可能同时从 null 认领成功。 */
async function claimLegacyMigration(accountId: string): Promise<LegacyMigration> {
  const fallback = readMigrationMirror();
  const db = await openControlDatabase();
  const migration = await new Promise<LegacyMigration>((resolve, reject) => {
    let result: LegacyMigration | null = null;
    const tx = db.transaction(CONTROL_STORE, "readwrite");
    const store = tx.objectStore(CONTROL_STORE);
    const request = store.get(MIGRATION_CONTROL_KEY);
    request.onsuccess = () => {
      result = asMigration(request.result) ?? fallback ?? { accountId, stage: "copy" };
      if (!asMigration(request.result)) store.put(result, MIGRATION_CONTROL_KEY);
    };
    request.onerror = () => reject(request.error ?? new Error("读取旧画布归属失败"));
    tx.oncomplete = () => {
      db.close();
      resolve(result!);
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error ?? new Error("认领旧画布失败"));
    };
    tx.onabort = tx.onerror;
  });
  writeMigrationMirror(migration);
  return migration;
}

async function readMigrationState(): Promise<LegacyMigration | null> {
  const stored = asMigration(await readControlValue<unknown>(MIGRATION_CONTROL_KEY));
  if (stored) {
    writeMigrationMirror(stored);
    return stored;
  }
  const fallback = readMigrationMirror();
  if (!fallback) return null;
  // 把上一版本只存在 durableState 里的 owner 原子地种进新控制库；已有并发 claim 时以控制库为准。
  return claimLegacyMigration(fallback.accountId);
}

async function setMigrationStateForOwner(accountId: string, next: LegacyMigration | null): Promise<boolean> {
  const fallback = readMigrationMirror();
  const db = await openControlDatabase();
  const changed = await new Promise<boolean>((resolve, reject) => {
    let allowed = false;
    const tx = db.transaction(CONTROL_STORE, "readwrite");
    const store = tx.objectStore(CONTROL_STORE);
    const request = store.get(MIGRATION_CONTROL_KEY);
    request.onsuccess = () => {
      const current = asMigration(request.result) ?? fallback;
      if (current?.accountId !== accountId) return;
      allowed = true;
      if (next) store.put(next, MIGRATION_CONTROL_KEY);
      else store.delete(MIGRATION_CONTROL_KEY);
    };
    request.onerror = () => reject(request.error ?? new Error("读取旧画布归属失败"));
    tx.oncomplete = () => {
      db.close();
      resolve(allowed);
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error ?? new Error("更新旧画布归属失败"));
    };
    tx.onabort = tx.onerror;
  });
  if (changed) writeMigrationMirror(next);
  return changed;
}

/** 退出前持久化「这个账号的画布库待删」；IndexedDB 的账号独立键是权威记录，localStorage 仅保留兼容镜像。 */
export async function markCanvasPurgePending(accountId: string | null | undefined): Promise<boolean> {
  if (!accountId) return true;
  // 先写同步的 localStorage 镜像再等 IndexedDB：退出流程对这一步有超时（IndexedDB 卡住不能让退出一直等），
  // 超时时至少镜像已经落盘，下次启动照样补删。
  const list = readPendingPurgeMirror();
  const mirrorSaved = list.includes(accountId) || writeDurableState(PENDING_CANVAS_PURGE_KEY, [...list, accountId]);
  let controlSaved = false;
  try {
    await writeControlValue(purgeControlKey(accountId), true);
    controlSaved = true;
  } catch (error) {
    reportClientError({ scope: "canvas", message: `记录画布待清状态失败：${error instanceof Error ? error.message : String(error)}`, detail: { accountId } });
  }
  return controlSaved || mirrorSaved;
}

async function unmarkCanvasPurgePending(accountId: string): Promise<boolean> {
  try {
    await deleteControlValue(purgeControlKey(accountId));
  } catch {
    // 权威键没删掉就保留镜像，让下次还能重试，不能在 UI 上假装已经清完。
    return false;
  }
  const list = readPendingPurgeMirror();
  if (list.includes(accountId)) writeDurableState(PENDING_CANVAS_PURGE_KEY, list.filter((item) => item !== accountId));
  return true;
}

/** 测试 / 诊断用：还没删掉的画布库归属账号；顺便把旧 localStorage 队列迁进账号独立键。 */
export async function pendingCanvasPurges(): Promise<string[]> {
  const result = new Set(readPendingPurgeMirror());
  try {
    const db = await openControlDatabase();
    const keys = await new Promise<IDBValidKey[]>((resolve, reject) => {
      let value: IDBValidKey[] = [];
      const tx = db.transaction(CONTROL_STORE, "readonly");
      const request = tx.objectStore(CONTROL_STORE).getAllKeys();
      request.onsuccess = () => {
        value = request.result;
      };
      request.onerror = () => reject(request.error ?? new Error("读取画布待清列表失败"));
      tx.oncomplete = () => {
        db.close();
        resolve(value);
      };
      tx.onerror = () => {
        db.close();
        reject(tx.error ?? new Error("读取画布待清列表失败"));
      };
      tx.onabort = tx.onerror;
    });
    for (const key of keys) {
      if (typeof key !== "string" || !key.startsWith(PURGE_CONTROL_PREFIX)) continue;
      try {
        result.add(decodeURIComponent(key.slice(PURGE_CONTROL_PREFIX.length)));
      } catch {
        // 坏键不参与删除
      }
    }
    // 上一版本的整数组镜像逐个迁入权威控制库；各账号独立 key，不会再跨标签丢更新。
    await Promise.all([...result].map((accountId) => writeControlValue(purgeControlKey(accountId), true)));
  } catch (error) {
    reportClientError({ scope: "canvas", message: `读取画布待清状态失败：${error instanceof Error ? error.message : String(error)}` });
  }
  return [...result];
}

/* ── IndexedDB 基本操作 ─────────────────────────────────────────────────── */

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

type DatabasePresence = "exists" | "missing" | "unknown";

/** 不依赖 tldraw 的易丢 localStorage 索引；缺 databases() 时用一次会 abort 的 open 权威探测。 */
async function databasePresence(name: string): Promise<DatabasePresence> {
  try {
    if (typeof window.indexedDB.databases === "function") {
      return (await window.indexedDB.databases()).some((db) => db.name === name) ? "exists" : "missing";
    }
  } catch {
    // 下面做权威 open 探测；不再信任可能丢写的 TLDRAW_DB_NAME_INDEX_v2
  }
  return new Promise((resolve) => {
    let created = false;
    let settled = false;
    const finish = (value: DatabasePresence) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      resolve(value);
    };
    const timer = window.setTimeout(() => finish("unknown"), DELETE_TIMEOUT_MS);
    try {
      const request = window.indexedDB.open(name);
      request.onupgradeneeded = () => {
        created = true;
        request.transaction?.abort();
      };
      request.onsuccess = () => {
        request.result.close();
        finish("exists");
      };
      request.onerror = () => finish(created ? "missing" : "unknown");
      request.onblocked = () => finish("unknown");
    } catch {
      finish("unknown");
    }
  });
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

/** 四张表一个事务写进去：要么全到、要么一条没有，不会留半截。 */
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

async function copyLegacyInto(targetName: string) {
  const legacy = await openCanvasDatabase(legacyDatabaseName);
  let target: IDBDatabase | null = null;
  try {
    const tables: Record<string, Array<[IDBValidKey, unknown]>> = {};
    for (const table of TLDRAW_TABLES) tables[table] = await readTable(legacy, table);
    target = await openCanvasDatabase(targetName);
    await writeTables(target, tables);
  } finally {
    target?.close();
    legacy.close();
  }
}

/* ── 对外 ──────────────────────────────────────────────────────────────── */

/**
 * 升级前共用的那座画布库，由升级后第一个登录的账号接管：先写下归属（stage=copy），整库拷进这个账号的库，记 stage=delete，
 * 旧库确认删掉才清标记。已经被别的账号认领的旧库一律不碰；归属账号再登录会接着没做完的那步做。
 * 要在画布挂载之前 await。返回这次有没有动旧库（拷 / 删）。
 */
export async function adoptLegacyCanvasStore(accountId: string | null | undefined): Promise<boolean> {
  if (!accountId || typeof window === "undefined" || !window.indexedDB) return false;
  try {
    const presence = await databasePresence(legacyDatabaseName);
    const existing = await readMigrationState();
    if (presence === "missing") {
      // 只有权威确认旧库不存在才清 owner；探测不确定时宁可保留，也不能把真实旧库让给下一个账号。
      if (existing) await setMigrationStateForOwner(existing.accountId, null);
      return false;
    }
    if (presence === "unknown") return false;
    const migration = existing ?? (await claimLegacyMigration(accountId));
    // 别人认领过（拷完没删掉 / 拷到一半关页）：只有归属账号能继续或删，别的账号碰都别碰
    if (migration.accountId !== accountId) return false;
    if (migration.stage === "copy") {
      // 重试也是整库再拷一遍（put 同键覆盖）：上次拷到一半关页留下的半截库会被补全
      await copyLegacyInto(accountDatabaseName(accountId));
      // stage=delete 必须先在权威控制库落定，才能删唯一旧库；写不成就保留旧库下次重试。
      if (!(await setMigrationStateForOwner(accountId, { accountId, stage: "delete" }))) return false;
    }
    if (!(await deleteDatabase(legacyDatabaseName))) {
      // 删不掉（被别的标签页占着）：标记留在 stage=delete，这个账号下次登录 / 退出再删；别的账号不会来接
      reportClientError({
        scope: "canvas",
        message: "升级前的画布库已接管但还没删掉（可能被别的标签页占着），下次登录 / 退出再删",
        detail: { accountId },
      });
      return true;
    }
    await setMigrationStateForOwner(accountId, null);
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

const reportedPurgeFailures = new Set<string>();

/**
 * 删掉这个账号的画布库（退出登录时调；要等画布组件卸载、tldraw 关掉连接之后）。
 * 旧库若是这个账号认领的（不管拷没拷完），一起删——退出就是清空，也不能留给别的账号接。
 * 删成功才把它从待清列表里划掉；删不掉（被别的标签页占着 / 出错）上报并留在列表里，下次启动 / 登录再删。
 */
export async function purgeCanvasStore(accountId: string | null | undefined): Promise<boolean> {
  if (!accountId) return true;
  if (typeof window === "undefined" || !window.indexedDB) return true;
  let migration: LegacyMigration | null = null;
  try {
    migration = await readMigrationState();
  } catch (error) {
    reportClientError({ scope: "canvas", message: `读取旧画布归属失败，暂不删除：${error instanceof Error ? error.message : String(error)}`, detail: { accountId } });
    return false;
  }
  const ownsLegacy = migration?.accountId === accountId;
  const [ownDeleted, legacyDeleted] = await Promise.all([
    deleteDatabase(accountDatabaseName(accountId)),
    ownsLegacy ? deleteDatabase(legacyDatabaseName) : Promise.resolve(true),
  ]);
  if (ownsLegacy && legacyDeleted) await setMigrationStateForOwner(accountId, null);
  if (ownDeleted && legacyDeleted) {
    const unmarked = await unmarkCanvasPurgePending(accountId);
    if (unmarked) {
      reportedPurgeFailures.delete(accountId);
      return true;
    }
  }
  if (!reportedPurgeFailures.has(accountId)) {
    reportedPurgeFailures.add(accountId);
    reportClientError({
      scope: "canvas",
      message: "退出时没能删掉这个账号的画布库（可能别的标签页还开着画布）；它只对这个账号可见，已记下来，下次启动 / 登录再删",
      detail: { accountId, ownDeleted, legacyDeleted },
    });
  }
  return false;
}

let pendingPurgeRun: Promise<boolean> | null = null;

/**
 * 把上次退出时没删成的画布库补删掉：启动时、退出切到登录页时、以及任何账号登录挂画布之前都跑一次。
 * 同时只跑一趟，并发调用共用同一个结果。返回待清的是不是都删掉了。
 */
export function purgePendingCanvasStores(): Promise<boolean> {
  if (pendingPurgeRun) return pendingPurgeRun;
  pendingPurgeRun = (async () => {
    const attempted = new Set<string>();
    let allDone = true;
    while (true) {
      const pending = (await pendingCanvasPurges()).filter((accountId) => !attempted.has(accountId));
      if (!pending.length) break;
      pending.forEach((accountId) => attempted.add(accountId));
      const results = await Promise.all(pending.map((accountId) => purgeCanvasStore(accountId)));
      if (results.some((result) => !result)) allDone = false;
    }
    return allDone;
  })().finally(() => {
    pendingPurgeRun = null;
  });
  return pendingPurgeRun;
}

/**
 * 清空本机保存的画布内容（当前账号的库；升级前共用的旧库若还在也一起清）。
 * 清完要重新加载页面，编辑器才会重新建库。
 */
export async function resetCanvasStore(accountId: string | null | undefined = activeStorageAccount()) {
  const names: string[] = [];
  if (accountId) names.push(accountDatabaseName(accountId));
  let migration: LegacyMigration | null = null;
  let migrationKnown = true;
  try {
    migration = await readMigrationState();
  } catch (error) {
    migrationKnown = false;
    reportClientError({ scope: "canvas", message: `读取旧画布归属失败，只清当前账号画布：${error instanceof Error ? error.message : String(error)}`, detail: { accountId } });
  }
  const mayDeleteLegacy = migrationKnown && (!migration || Boolean(accountId && migration.accountId === accountId));
  if (mayDeleteLegacy) names.push(legacyDatabaseName);
  if (!names.length) return;
  // 别的标签页占着库时会 blocked，等它也没意义（有超时），直接返回让用户刷新
  const results = await Promise.all(names.map((name) => deleteDatabase(name)));
  const legacyIndex = names.indexOf(legacyDatabaseName);
  if (legacyIndex >= 0 && results[legacyIndex] && migration && accountId) await setMigrationStateForOwner(accountId, null);
}
