import { useEffect, useState } from "react";

export function readStoredState<T>(key: string, fallback: T): T {
  try {
    const rawValue = window.localStorage.getItem(key);
    return rawValue ? (JSON.parse(rawValue) as T) : fallback;
  } catch {
    return fallback;
  }
}

/** 与 localStorage 同步的 state。写入失败（配额满）时静默降级为纯内存状态。 */
export function useStoredState<T>(key: string, fallback: T) {
  const [value, setValue] = useState<T>(() => readStoredState(key, fallback));

  useEffect(() => {
    try {
      window.localStorage.setItem(key, JSON.stringify(value));
    } catch {
      // Ignore quota errors; the app can continue with in-memory state.
    }
  }, [key, value]);

  return [value, setValue] as const;
}
