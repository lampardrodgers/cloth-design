/**
 * 「本地文件夹」：用浏览器的 File System Access API 把成片直接写进用户电脑上选定的目录。
 * 目录句柄存在 IndexedDB 里、按账号分键：账号 B 登录不会接着往账号 A 选的目录里自动写成片；
 * 退出登录时这个账号的句柄一起清掉（和其它本地数据「退出即清」一个口径），下次登录要重新选。
 * 权限可能要重新点一次确认。目前只有 Chrome / Edge 支持，Safari / Firefox 走普通下载。
 *
 * 升级前句柄是所有账号共用的一个键（`folder`）：升级后第一个登录的账号接管它（搬到自己的键下、删掉旧键），只接一次。
 */

const DB_NAME = "clothdesign-local-folder";
const STORE = "handles";
/** 升级前共用的键。 */
const LEGACY_KEY = "folder";

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
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function idbGet<T>(key: string): Promise<T | undefined> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const request = tx.objectStore(STORE).get(key);
    request.onsuccess = () => resolve(request.result as T | undefined);
    request.onerror = () => reject(request.error);
    tx.oncomplete = () => db.close();
  });
}

async function idbSet(key: string, value: unknown) {
  const db = await openDb();
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(value, key);
    tx.oncomplete = () => {
      db.close();
      resolve();
    };
    tx.onerror = () => reject(tx.error);
  });
}

async function idbDelete(key: string) {
  const db = await openDb();
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).delete(key);
    tx.oncomplete = () => {
      db.close();
      resolve();
    };
    tx.onerror = () => reject(tx.error);
  });
}

/** 弹系统目录选择框，选中的句柄记在这个账号名下；用户取消返回 null。 */
export async function pickLocalFolder(accountId: string): Promise<FileSystemDirectoryHandle | null> {
  if (!localFolderSupported() || !window.showDirectoryPicker || !accountId) return null;
  try {
    const handle = await window.showDirectoryPicker({ id: "clothdesign-output", mode: "readwrite" });
    await idbSet(handleKey(accountId), handle);
    return handle;
  } catch (error) {
    if ((error as DOMException)?.name === "AbortError") return null;
    throw error;
  }
}

/** 这个账号上次选的目录；没有的话，升级前共用的那个句柄（若还在）由它接管。 */
export async function loadSavedFolder(accountId: string): Promise<FileSystemDirectoryHandle | null> {
  if (!localFolderSupported() || !accountId) return null;
  try {
    const own = await idbGet<FileSystemDirectoryHandle>(handleKey(accountId));
    if (own) return own;
    const legacy = await idbGet<FileSystemDirectoryHandle>(LEGACY_KEY);
    if (!legacy) return null;
    await idbSet(handleKey(accountId), legacy);
    await idbDelete(LEGACY_KEY);
    return legacy;
  } catch {
    return null;
  }
}

/** 忘掉这个账号选的目录（用户点「不再存本地」、或退出登录时清理）。返回是否清成功。 */
export async function forgetLocalFolder(accountId: string | null | undefined): Promise<boolean> {
  if (!accountId) return true;
  try {
    await idbDelete(handleKey(accountId));
    return true;
  } catch {
    // IndexedDB 不可用时也没什么可清的
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
