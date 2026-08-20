import { useCallback, useEffect, useState, type Dispatch, type SetStateAction } from "react";
import { reportClientError } from "./clientErrors";
import { ACTIVE_STORAGE_ACCOUNT_KEY, clearAccountStoredState, storedStateKeyForAccount } from "./storageNamespace";

const STORAGE_NAMESPACE_EVENT = "clothdesign:storage-namespace";
let currentStorageAccount: string | null | undefined;

function activeStorageAccount() {
  if (currentStorageAccount !== undefined) return currentStorageAccount;
  try {
    currentStorageAccount = window.localStorage.getItem(ACTIVE_STORAGE_ACCOUNT_KEY);
  } catch {
    currentStorageAccount = null;
  }
  return currentStorageAccount;
}

export function setStoredStateAccount(accountId: string | null) {
  currentStorageAccount = accountId;
  try {
    if (accountId) window.localStorage.setItem(ACTIVE_STORAGE_ACCOUNT_KEY, accountId);
    else window.localStorage.removeItem(ACTIVE_STORAGE_ACCOUNT_KEY);
  } catch {
    // The in-memory state still switches below when storage is unavailable.
  }
  window.dispatchEvent(new CustomEvent(STORAGE_NAMESPACE_EVENT, { detail: { accountId } }));
}

export function clearStoredStateAccount(accountId: string | null | undefined) {
  try {
    clearAccountStoredState(window.localStorage, accountId);
  } catch {
    // Logout must continue even when localStorage is disabled.
  }
}

export function readStoredState<T>(key: string, fallback: T): T {
  try {
    const rawValue = window.localStorage.getItem(key);
    return rawValue ? (JSON.parse(rawValue) as T) : fallback;
  } catch {
    return fallback;
  }
}

/** 写一次。配额满、隐私模式、被禁用都返回 false，调用方自己决定怎么办。 */
export function writeStoredState(key: string, value: unknown): boolean {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

/**
 * 与 localStorage 同步的 state。
 *
 * 写不进去（配额满）时：数组就砍掉后半截再试一次——尾部是最旧的，扔掉损失最小；
 * 不是数组就只能放弃。两种情况都往服务端记一笔，别再像以前那样静默吞掉：
 * 静默失败表现出来是「刷新之后记录莫名其妙不动了」，从现象根本猜不到是配额问题。
 */
export function useStoredState<T>(key: string, fallback: T) {
  const [storageKey, setStorageKey] = useState<string | null>(() => storedStateKeyForAccount(key, activeStorageAccount()));
  const [value, setValue] = useState<T>(() => (storageKey ? readStoredState(storageKey, fallback) : fallback));

  useEffect(() => {
    const switchAccount = () => {
      const nextKey = storedStateKeyForAccount(key, activeStorageAccount());
      setStorageKey(nextKey);
      setValue(nextKey ? readStoredState(nextKey, fallback) : fallback);
    };
    const handleStorage = (event: StorageEvent) => {
      if (event.key === ACTIVE_STORAGE_ACCOUNT_KEY) {
        currentStorageAccount = event.newValue;
        switchAccount();
      }
    };
    window.addEventListener(STORAGE_NAMESPACE_EVENT, switchAccount);
    window.addEventListener("storage", handleStorage);
    return () => {
      window.removeEventListener(STORAGE_NAMESPACE_EVENT, switchAccount);
      window.removeEventListener("storage", handleStorage);
    };
  }, [key]);

  useEffect(() => {
    if (!storageKey || writeStoredState(storageKey, value)) return;
    if (Array.isArray(value) && value.length > 1) {
      const kept = Math.floor(value.length / 2);
      reportClientError({
        scope: "storage",
        message: `localStorage 配额不足，${storageKey} 从 ${value.length} 条裁到 ${kept} 条`,
        detail: { key: storageKey, kept, dropped: value.length - kept },
      });
      setValue(value.slice(0, kept) as unknown as T);
      return;
    }
    reportClientError({ scope: "storage", message: `localStorage 写入失败：${storageKey}`, detail: { key: storageKey } });
  }, [storageKey, value]);

  return [value, setValue] as const;
}

/**
 * 和 useStoredState 一样，但只留最新的 limit 条（列表按新在前排）。
 *
 * 任务和成片都往 localStorage 里堆，而配额只有 5MB 上下：不封顶的话出图上千之后
 * 写入就开始失败。真正的历史在服务端，本地这份只是「最近用过的」，没必要留全。
 */
export function useCappedStoredState<T>(key: string, fallback: T[], limit: number) {
  const [value, setValue] = useStoredState<T[]>(key, fallback.length > limit ? fallback.slice(0, limit) : fallback);

  const setCapped = useCallback<Dispatch<SetStateAction<T[]>>>(
    (action) => {
      setValue((current) => {
        const next = typeof action === "function" ? (action as (prev: T[]) => T[])(current) : action;
        return next.length > limit ? next.slice(0, limit) : next;
      });
    },
    [setValue, limit],
  );

  return [value, setCapped] as const;
}
