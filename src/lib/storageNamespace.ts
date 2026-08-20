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

