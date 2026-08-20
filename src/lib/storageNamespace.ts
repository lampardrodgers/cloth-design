export const ACTIVE_STORAGE_ACCOUNT_KEY = "clothdesign:active-account";

type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem" | "key" | "length">;

function normalizedAccountId(accountId: string | null | undefined) {
  return typeof accountId === "string" ? accountId.trim() : "";
}

export function storedStateKeyForAccount(key: string, accountId: string | null | undefined) {
  const normalized = normalizedAccountId(accountId);
  if (!normalized) return null;
  const suffix = key.startsWith("clothdesign:") ? key.slice("clothdesign:".length) : key;
  return `clothdesign:${encodeURIComponent(normalized)}:${suffix}`;
}

export function clearAccountStoredState(storage: StorageLike, accountId: string | null | undefined) {
  const normalized = normalizedAccountId(accountId);
  if (!normalized) return;
  const prefix = `clothdesign:${encodeURIComponent(normalized)}:`;
  const keys: string[] = [];
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (key?.startsWith(prefix)) keys.push(key);
  }
  keys.forEach((key) => storage.removeItem(key));
}


/** 账号切换时广播，所有 useStoredState / useIdbState 跟着换命名空间重读。 */
export const STORAGE_NAMESPACE_EVENT = "clothdesign:storage-namespace";

let currentStorageAccount: string | null | undefined;

/** 当前本地状态归哪个账号（登录前 / 退出后为 null）。 */
export function activeStorageAccount() {
  if (currentStorageAccount !== undefined) return currentStorageAccount;
  try {
    currentStorageAccount = window.localStorage.getItem(ACTIVE_STORAGE_ACCOUNT_KEY);
  } catch {
    currentStorageAccount = null;
  }
  return currentStorageAccount;
}

/** 只改内存里的缓存（另一个标签页改了 localStorage 时同步用）。 */
export function setActiveStorageAccountCache(accountId: string | null) {
  currentStorageAccount = accountId;
}
