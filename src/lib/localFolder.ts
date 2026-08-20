/**
 * 「本地文件夹」：用浏览器的 File System Access API 把成片直接写进用户电脑上选定的目录。
 * 目录句柄存在 IndexedDB 里、按账号分键：账号 B 登录不会接着往账号 A 选的目录里自动写成片；
 * 退出登录时这个账号的句柄一起清掉（和其它本地数据「退出即清」一个口径），下次登录要重新选。
 * 权限可能要重新点一次确认。目前只有 Chrome / Edge 支持，Safari / Firefox 走普通下载。
 *
 * 升级前句柄是所有账号共用的一个键（`folder`）：升级后第一个登录的账号接管它（搬到自己的键下、删掉旧键），只接一次——
 * 「写新键 + 删旧键」在同一个读写事务里，中途关页也不会留下两份让别的账号再接一次。
 */
import { reportClientError } from "./clientErrors";

const DB_NAME = "clothdesign-local-folder";
const DB_VERSION = 2;
const STORE = "handles";
const CONTROL_STORE = "control";
/** 升级前共用的键。 */
const LEGACY_KEY = "folder";
/** 第一个升级后账号的永久归属 tombstone；迁移失败时也不能让下一个账号接手。 */
const LEGACY_OWNER_KEY = "legacy-owner";
const PURGE_PREFIX = "purge:";

function handleKey(accountId: string) {
  return `folder:${encodeURIComponent(accountId.trim())}`;
}

type PermissionState = "granted" | "denied" | "prompt";

interface DirectoryHandleWithPermission extends FileSystemDirectoryHandle {
  queryPermission?: (options: { mode: "read" | "readwrite" }) => Promise<PermissionState>;
  requestPermission?: (options: { mode: "read" | "readwrite" }) => Promise<PermissionState>;
}

declare global {
  interface Window {
    showDirectoryPicker?: (options?: { id?: string; mode?: "read" | "readwrite"; startIn?: string }) => Promise<FileSystemDirectoryHandle>;
  }
}

export function localFolderSupported() {
  return typeof window !== "undefined" && typeof window.showDirectoryPicker === "function" && window.isSecureContext;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE);
      if (!request.result.objectStoreNames.contains(CONTROL_STORE)) request.result.createObjectStore(CONTROL_STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("本地文件夹数据库打不开"));
    request.onblocked = () => reject(new Error("本地文件夹数据库被其它标签页占用"));
  });
}

function closeWithError(db: IDBDatabase, reject: (reason?: unknown) => void, error: unknown, fallback: string) {
  db.close();
  reject(error ?? new Error(fallback));
}

/** 用户主动选的新目录覆盖旧待清状态；这两个动作在同一个事务里。 */
async function idbSetHandle(key: string, value: unknown) {
  const db = await openDb();
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction([STORE, CONTROL_STORE], "readwrite");
    tx.objectStore(STORE).put(value, key);
    tx.objectStore(CONTROL_STORE).delete(PURGE_PREFIX + key);
    tx.oncomplete = () => {
      db.close();
      resolve();
    };
    tx.onerror = () => closeWithError(db, reject, tx.error, "保存本地文件夹句柄失败");
    tx.onabort = tx.onerror;
  });
}

/** 第一个调用者用控制 store 的单个 readwrite 事务永久认领 legacy；多标签也只会有一个 winner。 */
async function claimLegacyOwner(accountKey: string): Promise<string> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    let owner = "";
    const tx = db.transaction(CONTROL_STORE, "readwrite");
    const store = tx.objectStore(CONTROL_STORE);
    const request = store.get(LEGACY_OWNER_KEY);
    request.onsuccess = () => {
      owner = typeof request.result === "string" && request.result ? request.result : accountKey;
      if (!request.result) store.put(owner, LEGACY_OWNER_KEY);
    };
    request.onerror = () => closeWithError(db, reject, request.error, "读取旧文件夹归属失败");
    tx.oncomplete = () => {
      db.close();
      resolve(owner);
    };
    tx.onerror = () => closeWithError(db, reject, tx.error, "认领旧文件夹失败");
    tx.onabort = tx.onerror;
  });
}

/**
 * 只有永久 owner 才能看 / 搬 / 删除升级前共用的句柄。owner 先在独立事务落定，再做这次可失败的搬运；
 * 因此页面关闭或搬运事务 abort 后，另一个账号也接不走。
 */
async function idbTakeHandle(accountKey: string, ownsLegacy: boolean): Promise<FileSystemDirectoryHandle | null> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    const store = tx.objectStore(STORE);
    let result: FileSystemDirectoryHandle | null = null;
    const ownRequest = store.get(accountKey);
    ownRequest.onsuccess = () => {
      const own = ownRequest.result as FileSystemDirectoryHandle | undefined;
      if (!ownsLegacy) {
        result = own ?? null;
        return;
      }
      const legacyRequest = store.get(LEGACY_KEY);
      legacyRequest.onsuccess = () => {
        const legacy = legacyRequest.result as FileSystemDirectoryHandle | undefined;
        if (own) {
          result = own;
          if (legacy) store.delete(LEGACY_KEY);
          return;
        }
        if (!legacy) return;
        result = legacy;
        store.put(legacy, accountKey);
        store.delete(LEGACY_KEY);
      };
      legacyRequest.onerror = () => closeWithError(db, reject, legacyRequest.error, "读取旧文件夹句柄失败");
    };
    ownRequest.onerror = () => closeWithError(db, reject, ownRequest.error, "读取账号文件夹句柄失败");
    tx.oncomplete = () => {
      db.close();
      resolve(result);
    };
    tx.onerror = () => closeWithError(db, reject, tx.error, "读取文件夹句柄的事务失败");
    tx.onabort = () => closeWithError(db, reject, tx.error, "读取文件夹句柄的事务被中止");
  });
}

async function markFolderPurgePending(accountKey: string) {
  const db = await openDb();
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction(CONTROL_STORE, "readwrite");
    tx.objectStore(CONTROL_STORE).put(true, PURGE_PREFIX + accountKey);
    tx.oncomplete = () => {
      db.close();
      resolve();
    };
    tx.onerror = () => closeWithError(db, reject, tx.error, "记录文件夹待清状态失败");
    tx.onabort = tx.onerror;
  });
}

/** 账号键、归属账号可能残留的 legacy、以及 pending marker 同一个事务收口。 */
async function cleanupAccountHandle(accountKey: string) {
  const db = await openDb();
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction([STORE, CONTROL_STORE], "readwrite");
    const handles = tx.objectStore(STORE);
    const control = tx.objectStore(CONTROL_STORE);
    handles.delete(accountKey);
    const ownerRequest = control.get(LEGACY_OWNER_KEY);
    ownerRequest.onsuccess = () => {
      if (ownerRequest.result === accountKey) handles.delete(LEGACY_KEY);
      control.delete(PURGE_PREFIX + accountKey);
    };
    ownerRequest.onerror = () => closeWithError(db, reject, ownerRequest.error, "读取旧文件夹归属失败");
    tx.oncomplete = () => {
      db.close();
      resolve();
    };
    tx.onerror = () => closeWithError(db, reject, tx.error, "清理文件夹句柄失败");
    tx.onabort = tx.onerror;
  });
}

async function pendingFolderKeys(): Promise<string[]> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    let keys: IDBValidKey[] = [];
    const tx = db.transaction(CONTROL_STORE, "readonly");
    const request = tx.objectStore(CONTROL_STORE).getAllKeys();
    request.onsuccess = () => {
      keys = request.result;
    };
    request.onerror = () => closeWithError(db, reject, request.error, "读取文件夹待清状态失败");
    tx.oncomplete = () => {
      db.close();
      resolve(keys.filter((key): key is string => typeof key === "string" && key.startsWith(PURGE_PREFIX)).map((key) => key.slice(PURGE_PREFIX.length)));
    };
    tx.onerror = () => closeWithError(db, reject, tx.error, "读取文件夹待清状态失败");
    tx.onabort = tx.onerror;
  });
}

let pendingFolderPurgeRun: Promise<boolean> | null = null;

/** 启动 / 登录前补删上次退出或“断开”失败的账号句柄。 */
export function purgePendingLocalFolders(): Promise<boolean> {
  if (pendingFolderPurgeRun) return pendingFolderPurgeRun;
  pendingFolderPurgeRun = (async () => {
    try {
      const attempted = new Set<string>();
      let allDone = true;
      while (true) {
        const pending = (await pendingFolderKeys()).filter((key) => !attempted.has(key));
        if (!pending.length) break;
        pending.forEach((key) => attempted.add(key));
        const results = await Promise.all(
          pending.map(async (key) => {
            try {
              await cleanupAccountHandle(key);
              return true;
            } catch (error) {
              reportClientError({ scope: "storage", message: `补清本地文件夹句柄失败：${error instanceof Error ? error.message : String(error)}`, detail: { accountKey: key } });
              return false;
            }
          }),
        );
        if (results.some((result) => !result)) allDone = false;
      }
      return allDone;
    } catch (error) {
      // 清理是登录前的补偿动作：IndexedDB 整体不可用时保留原状态并上报，但不能连正常登录也一起拦住。
      reportClientError({ scope: "storage", message: `读取待清文件夹状态失败，稍后重试：${error instanceof Error ? error.message : String(error)}` });
      return false;
    }
  })().finally(() => {
    pendingFolderPurgeRun = null;
  });
  return pendingFolderPurgeRun;
}

/** 测试 / 诊断用。 */
export function pendingLocalFolderPurges() {
  return pendingFolderKeys();
}

/** 弹系统目录选择框，选中的句柄记在这个账号名下；用户取消返回 null。 */
export async function pickLocalFolder(accountId: string): Promise<FileSystemDirectoryHandle | null> {
  if (!localFolderSupported() || !window.showDirectoryPicker || !accountId) return null;
  try {
    const handle = await window.showDirectoryPicker({ id: "clothdesign-output", mode: "readwrite" });
    await idbSetHandle(handleKey(accountId), handle);
    return handle;
  } catch (error) {
    if ((error as DOMException)?.name === "AbortError") return null;
    throw error;
  }
}

/** 这个账号上次选的目录；没有的话，升级前共用的那个句柄（若还在）由它原子地接管。 */
export async function loadSavedFolder(accountId: string): Promise<FileSystemDirectoryHandle | null> {
  if (!localFolderSupported() || !accountId) return null;
  try {
    await purgePendingLocalFolders();
    const accountKey = handleKey(accountId);
    const owner = await claimLegacyOwner(accountKey);
    return await idbTakeHandle(accountKey, owner === accountKey);
  } catch (error) {
    reportClientError({ scope: "storage", message: `读取本地文件夹句柄失败：${error instanceof Error ? error.message : String(error)}`, detail: { accountId } });
    return null;
  }
}

/** 先把待清状态单独落盘，再删句柄；删失败 / 关页时启动后会重试。 */
export async function forgetLocalFolder(accountId: string | null | undefined): Promise<boolean> {
  if (!accountId) return true;
  const accountKey = handleKey(accountId);
  let marked = false;
  try {
    await markFolderPurgePending(accountKey);
    marked = true;
  } catch (error) {
    reportClientError({ scope: "storage", message: `记录文件夹待清状态失败：${error instanceof Error ? error.message : String(error)}`, detail: { accountId } });
  }
  try {
    await cleanupAccountHandle(accountKey);
    return true;
  } catch (error) {
    reportClientError({
      scope: "storage",
      message: `清理本地文件夹句柄失败（${marked ? "已记下，下次启动会重试" : "待清状态也没能落盘"}）：${error instanceof Error ? error.message : String(error)}`,
      detail: { accountId, marked },
    });
    return false;
  }
}

/** 查（或申请）读写权限。浏览器重启后句柄还在，但权限一般会退回 prompt，要用户点一下。 */
export async function folderPermission(handle: FileSystemDirectoryHandle, request = false): Promise<PermissionState> {
  const target = handle as DirectoryHandleWithPermission;
  const options = { mode: "readwrite" as const };
  try {
    const current = (await target.queryPermission?.(options)) ?? "granted";
    if (current === "granted" || !request) return current;
    return (await target.requestPermission?.(options)) ?? current;
  } catch {
    return "denied";
  }
}

function dayFolderName(iso?: string) {
  const date = iso ? new Date(iso) : new Date();
  const safe = Number.isNaN(date.getTime()) ? new Date() : date;
  const month = String(safe.getMonth() + 1).padStart(2, "0");
  const day = String(safe.getDate()).padStart(2, "0");
  return `${safe.getFullYear()}-${month}-${day}`;
}

export interface SaveToFolderInput {
  url: string;
  fileName: string;
  /** 用来分日期子目录；不传就按今天。 */
  createdAt?: string;
}

/**
 * 把一张图写进 <文件夹>/<YYYY-MM-DD>/<文件名>。返回写入的相对路径。
 * 同名文件直接覆盖（文件名里带结果 id，正常不会撞）。
 */
export async function saveImageToFolder(handle: FileSystemDirectoryHandle, input: SaveToFolderInput) {
  const permission = await folderPermission(handle, true);
  if (permission !== "granted") throw new Error("没有拿到文件夹的写入权限，请重新选择文件夹。");
  const response = await fetch(input.url, { credentials: "include" });
  if (!response.ok) throw new Error(`读取图片失败 (${response.status})，可能已经过期清理。`);
  const blob = await response.blob();
  const dayName = dayFolderName(input.createdAt);
  const dayDir = await handle.getDirectoryHandle(dayName, { create: true });
  const fileHandle = await dayDir.getFileHandle(input.fileName, { create: true });
  const writable = await fileHandle.createWritable();
  try {
    await writable.write(blob);
  } finally {
    await writable.close();
  }
  return `${dayName}/${input.fileName}`;
}
