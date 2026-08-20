import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { saveMyPreferences } from "./api";
import { reportClientError } from "./clientErrors";
import { idbDeletePrefix } from "./idbStore";
import {
  ACTIVE_STORAGE_ACCOUNT_KEY,
  STORAGE_NAMESPACE_EVENT,
  activeStorageAccount,
  clearAccountStoredState,
  setActiveStorageAccountCache,
  storedStateKeyForAccount,
} from "./storageNamespace";

export { STORAGE_NAMESPACE_EVENT, activeStorageAccount } from "./storageNamespace";

/* ── 跨设备同步的偏好 ───────────────────────────────────────────────────────
 * 这些键除了写 localStorage，还防抖推到 /api/me/preferences；登录时服务端那份先落地再渲染。
 * 任务 / 成片 / 提交记录 / 附件不在其中：它们要么服务端本来就有，要么太大。
 * ────────────────────────────────────────────────────────────────────────── */
export const SYNCED_PREFERENCE_KEYS: ReadonlySet<string> = new Set([
  "clothdesign:settings",
  "clothdesign:settingsLocked",
  "clothdesign:modeDrafts",
  "clothdesign:promptLibrary",
  "clothdesign:free:prompt",
  "clothdesign:free:ratio",
  "clothdesign:free:resolution",
  "clothdesign:free:quantity",
  "clothdesign:free:layout",
  "clothdesign:railCollapsed",
  "clothdesign:localFolder",
  "clothdesign:shortvideo:form",
  "clothdesign:shortvideo:platform",
  "clothdesign:shortvideo:module",
]);

const PREFERENCE_SYNC_DELAY_MS = 1500;
const pendingPreferencePatch = new Map<string, unknown>();
let preferenceSyncTimer: number | null = null;
let preferenceSyncAccount: string | null = null;

async function flushPreferenceSync() {
  if (preferenceSyncTimer !== null) {
    window.clearTimeout(preferenceSyncTimer);
    preferenceSyncTimer = null;
  }
  if (!pendingPreferencePatch.size || !preferenceSyncAccount) return;
  // 推送途中账号换了就别把 A 的偏好写到 B 头上。
  if (preferenceSyncAccount !== activeStorageAccount()) {
    pendingPreferencePatch.clear();
    return;
  }
  const patch = Object.fromEntries(pendingPreferencePatch);
  pendingPreferencePatch.clear();
  try {
    await saveMyPreferences(patch);
  } catch (error) {
    reportClientError({
      scope: "preferences",
      message: `偏好同步失败：${error instanceof Error ? error.message : String(error)}`,
      detail: { keys: Object.keys(patch) },
    });
  }
}

/** 偏好有改动：攒一会儿再一起推，连续打字不会一键一请求。 */
export function queuePreferenceSync(key: string, value: unknown) {
  const accountId = activeStorageAccount();
  if (!accountId || !SYNCED_PREFERENCE_KEYS.has(key)) return;
  preferenceSyncAccount = accountId;
  pendingPreferencePatch.set(key, value);
  if (preferenceSyncTimer !== null) window.clearTimeout(preferenceSyncTimer);
  preferenceSyncTimer = window.setTimeout(() => void flushPreferenceSync(), PREFERENCE_SYNC_DELAY_MS);
}

// 关页前把还没推出去的那一批推掉，不然刚改的设置只留在这台机器上。
if (typeof window !== "undefined") {
  window.addEventListener("pagehide", () => void flushPreferenceSync());
}

/**
 * 登录拿到服务端偏好后调用：把它们写进这个账号的 localStorage 命名空间（服务端为准），
 * 本机有、服务端还没有的键则反向补推上去（老用户第一次升级时把提示词库带上云）。
 * 要在 setStoredStateAccount 之前调，后者会广播让所有 hook 重读。
 */
export function seedAccountPreferences(accountId: string, preferences: Record<string, unknown> | undefined) {
  const remote = preferences && typeof preferences === "object" ? preferences : {};
  for (const key of SYNCED_PREFERENCE_KEYS) {
    const storageKey = storedStateKeyForAccount(key, accountId);
    if (!storageKey) continue;
    // 本机刚改、还没推出去的以本机为准；loadAccount 在支付 / 重登时会再跑，别让旧的服务端值把它盖掉。
    if (pendingPreferencePatch.has(key) && preferenceSyncAccount === accountId) continue;
    if (key in remote) {
      writeStoredState(storageKey, remote[key]);
      continue;
    }
    try {
      const local = window.localStorage.getItem(storageKey);
      if (local !== null) pendingPreferencePatch.set(key, JSON.parse(local));
    } catch {
      // 读不出来就不补推
    }
  }
  if (pendingPreferencePatch.size) {
    preferenceSyncAccount = accountId;
    if (preferenceSyncTimer !== null) window.clearTimeout(preferenceSyncTimer);
    preferenceSyncTimer = window.setTimeout(() => void flushPreferenceSync(), PREFERENCE_SYNC_DELAY_MS);
  }
}

export function setStoredStateAccount(accountId: string | null) {
  setActiveStorageAccountCache(accountId);
  try {
    if (accountId) window.localStorage.setItem(ACTIVE_STORAGE_ACCOUNT_KEY, accountId);
    else window.localStorage.removeItem(ACTIVE_STORAGE_ACCOUNT_KEY);
  } catch {
    // The in-memory state still switches below when storage is unavailable.
  }
  if (!accountId) {
    // 退出 / 掉线：没推出去的偏好作废，别等下个账号登录时推错人。
    pendingPreferencePatch.clear();
    if (preferenceSyncTimer !== null) {
      window.clearTimeout(preferenceSyncTimer);
      preferenceSyncTimer = null;
    }
  }
  window.dispatchEvent(new CustomEvent(STORAGE_NAMESPACE_EVENT, { detail: { accountId } }));
}

export function clearStoredStateAccount(accountId: string | null | undefined) {
  try {
    clearAccountStoredState(window.localStorage, accountId);
  } catch {
    // Logout must continue even when localStorage is disabled.
  }
  const prefix = accountId ? storedStateKeyForAccount("clothdesign:", accountId) : null;
  if (prefix) void idbDeletePrefix(prefix).catch(() => undefined);
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
 * 写不进去（配额满）时：数组就砍掉后半截再试一次——这里的数组（任务 / 成片 / 提交记录）都是
 * 新在前排的，尾部是最旧的，扔掉损失最小；不是数组就只能放弃。两种情况都往服务端记一笔，
 * 别再像以前那样静默吞掉：静默失败表现出来是「刷新之后记录莫名其妙不动了」，从现象根本猜不到是配额问题。
 * 内容型的大数组（简易模式附件）不走这里，走 useIdbState——它们是旧在前排的，砍后半会把刚加的砍掉。
 */
export function useStoredState<T>(key: string, fallback: T) {
  const [storageKey, setStorageKey] = useState<string | null>(() => storedStateKeyForAccount(key, activeStorageAccount()));
  const [value, setValueState] = useState<T>(() => (storageKey ? readStoredState(storageKey, fallback) : fallback));
  // 只有调用方 setValue 过才算用户改动，才推同步；首次挂载 / 换账号重读那一轮不算。
  const dirtyRef = useRef(false);
  const setValue = useCallback<Dispatch<SetStateAction<T>>>((action) => {
    dirtyRef.current = true;
    setValueState(action);
  }, []);

  useEffect(() => {
    const switchAccount = () => {
      const nextKey = storedStateKeyForAccount(key, activeStorageAccount());
      dirtyRef.current = false;
      setStorageKey(nextKey);
      setValueState(nextKey ? readStoredState(nextKey, fallback) : fallback);
    };
    const handleStorage = (event: StorageEvent) => {
      if (event.key === ACTIVE_STORAGE_ACCOUNT_KEY) {
        setActiveStorageAccountCache(event.newValue);
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
    if (!storageKey) return;
    if (writeStoredState(storageKey, value)) {
      if (dirtyRef.current) queuePreferenceSync(key, value);
      return;
    }
    if (Array.isArray(value) && value.length > 1) {
      const kept = Math.floor(value.length / 2);
      reportClientError({
        scope: "storage",
        message: `localStorage 配额不足，${storageKey} 从 ${value.length} 条裁到 ${kept} 条`,
        detail: { key: storageKey, kept, dropped: value.length - kept },
      });
      setValueState(value.slice(0, kept) as unknown as T);
      return;
    }
    reportClientError({ scope: "storage", message: `localStorage 写入失败：${storageKey}`, detail: { key: storageKey } });
  }, [key, storageKey, value]);

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
