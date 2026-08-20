/**
 * 放不进 localStorage 的大块本地状态（简易模式的附件 data URL）走 IndexedDB。
 *
 * localStorage 只有 5MB 上下，几张 PNG 附件就能撑爆；以前撑爆时会「悄悄砍掉后半」，
 * 用户刚加的第 6~10 张直接消失。IndexedDB 的配额按站点算（几百 MB 起），
 * 而且写失败会明确报错，这里把错误交回调用方显示，不再静默。
 */
import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { reportClientError } from "./clientErrors";
import { ACTIVE_STORAGE_ACCOUNT_KEY, STORAGE_NAMESPACE_EVENT, activeStorageAccount, storedStateKeyForAccount } from "./storageNamespace";

const DB_NAME = "clothdesign-state";
const STORE_NAME = "kv";

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    try {
      const request = window.indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME);
      };
      request.onsuccess = () => {
        const db = request.result;
        // 别的标签页升级库结构时主动让路，下次再开。
        db.onversionchange = () => {
          db.close();
          dbPromise = null;
        };
        resolve(db);
      };
      request.onerror = () => reject(request.error ?? new Error("IndexedDB 打不开"));
      request.onblocked = () => reject(new Error("IndexedDB 被其它标签页占用"));
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
  dbPromise.catch(() => {
    dbPromise = null;
  });
  return dbPromise;
}

function requestToPromise<T>(request: IDBRequest<T>) {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB 操作失败"));
  });
}

function transactionDone(transaction: IDBTransaction) {
  return new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error("IndexedDB 写入失败"));
    transaction.onabort = () => reject(transaction.error ?? new Error("IndexedDB 写入被中止"));
  });
}

export async function idbGet<T>(key: string): Promise<T | undefined> {
  const db = await openDb();
  const transaction = db.transaction(STORE_NAME, "readonly");
  return requestToPromise<T | undefined>(transaction.objectStore(STORE_NAME).get(key));
}

export async function idbSet(key: string, value: unknown) {
  const db = await openDb();
  const transaction = db.transaction(STORE_NAME, "readwrite");
  transaction.objectStore(STORE_NAME).put(value, key);
  await transactionDone(transaction);
}

export async function idbDelete(key: string) {
  const db = await openDb();
  const transaction = db.transaction(STORE_NAME, "readwrite");
  transaction.objectStore(STORE_NAME).delete(key);
  await transactionDone(transaction);
}

/** 退出登录时清掉这个账号在 IndexedDB 里的所有键（和 localStorage 的清理口径一致）。 */
export async function idbDeletePrefix(prefix: string) {
  const db = await openDb();
  const transaction = db.transaction(STORE_NAME, "readwrite");
  const store = transaction.objectStore(STORE_NAME);
  const keys = (await requestToPromise(store.getAllKeys())).filter((key) => typeof key === "string" && key.startsWith(prefix));
  keys.forEach((key) => store.delete(key));
  await transactionDone(transaction);
}

export interface IdbStateMeta {
  /** 这个账号的数据已经从 IndexedDB 读回来了（读回来之前界面先用 fallback）。 */
  ready: boolean;
  /** 最近一次写失败的原因；成功后清空。 */
  error: string;
}

/**
 * 和 useStoredState 同一套账号命名空间，但存 IndexedDB。
 * 读是异步的：读回来之前先给 fallback；如果用户在读完之前已经改过，以用户改的为准，别被旧数据覆盖。
 */
export function useIdbState<T>(key: string, fallback: T) {
  const [storageKey, setStorageKey] = useState<string | null>(() => storedStateKeyForAccount(key, activeStorageAccount()));
  const [value, setValueState] = useState<T>(fallback);
  const [meta, setMeta] = useState<IdbStateMeta>({ ready: false, error: "" });
  const loadedKeyRef = useRef<string | null>(null);
  const dirtyRef = useRef(false);
  const fallbackRef = useRef(fallback);
  const valueRef = useRef(value);
  valueRef.current = value;

  useEffect(() => {
    const switchAccount = () => setStorageKey(storedStateKeyForAccount(key, activeStorageAccount()));
    const handleStorage = (event: StorageEvent) => {
      if (event.key === ACTIVE_STORAGE_ACCOUNT_KEY) switchAccount();
    };
    window.addEventListener(STORAGE_NAMESPACE_EVENT, switchAccount);
    window.addEventListener("storage", handleStorage);
    return () => {
      window.removeEventListener(STORAGE_NAMESPACE_EVENT, switchAccount);
      window.removeEventListener("storage", handleStorage);
    };
  }, [key]);

  // 换了账号（或首次挂载）：把这个账号存的读回来。
  useEffect(() => {
    loadedKeyRef.current = null;
    dirtyRef.current = false;
    setValueState(fallbackRef.current);
    setMeta({ ready: !storageKey, error: "" });
    if (!storageKey) return;
    let cancelled = false;
    idbGet<T>(storageKey)
      .then((stored) => {
        if (cancelled) return;
        loadedKeyRef.current = storageKey;
        if (!dirtyRef.current && stored !== undefined) setValueState(stored);
        // 读完之前用户已经改过：以用户改的为准，并且把它写下去（写入 effect 不会因为读完而重跑）。
        else if (dirtyRef.current) void idbSet(storageKey, valueRef.current).catch(() => undefined);
        setMeta({ ready: true, error: "" });
      })
      .catch((error) => {
        if (cancelled) return;
        loadedKeyRef.current = storageKey;
        setMeta({ ready: true, error: "" });
        reportClientError({ scope: "storage", message: `IndexedDB 读取失败：${storageKey}`, detail: { error: String(error) } });
      });
    return () => {
      cancelled = true;
    };
  }, [storageKey]);

  const setValue = useCallback<Dispatch<SetStateAction<T>>>((action) => {
    dirtyRef.current = true;
    setValueState(action);
  }, []);

  // 用户改过才写；读回来那次 setValueState 不会把 dirty 置 true，自然不会回写。
  useEffect(() => {
    if (!storageKey || !dirtyRef.current) return;
    // 还没读完就写会盖掉旧数据，等读完（loadedKeyRef 对上）再写。
    if (loadedKeyRef.current !== storageKey) return;
    let cancelled = false;
    idbSet(storageKey, value)
      .then(() => {
        if (!cancelled) setMeta((current) => (current.error ? { ...current, error: "" } : current));
      })
      .catch((error) => {
        if (cancelled) return;
        const message = error instanceof Error ? error.message : String(error);
        reportClientError({ scope: "storage", message: `IndexedDB 写入失败：${storageKey}`, detail: { error: message } });
        setMeta((current) => ({ ...current, error: `本地保存失败（${message}），刷新后这些内容可能不在` }));
      });
    return () => {
      cancelled = true;
    };
  }, [storageKey, value]);

  return [value, setValue, meta] as const;
}
