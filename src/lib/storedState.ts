import { useCallback, useEffect, useState, type Dispatch, type SetStateAction } from "react";
import { reportClientError } from "./clientErrors";

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
  const [value, setValue] = useState<T>(() => readStoredState(key, fallback));

  useEffect(() => {
    if (writeStoredState(key, value)) return;
    if (Array.isArray(value) && value.length > 1) {
      const kept = Math.floor(value.length / 2);
      reportClientError({
        scope: "storage",
        message: `localStorage 配额不足，${key} 从 ${value.length} 条裁到 ${kept} 条`,
        detail: { key, kept, dropped: value.length - kept },
      });
      setValue(value.slice(0, kept) as unknown as T);
      return;
    }
    reportClientError({ scope: "storage", message: `localStorage 写入失败：${key}`, detail: { key } });
  }, [key, value]);

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
