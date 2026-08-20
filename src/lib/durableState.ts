/**
 * 设备级「补偿数据」（推不出去的偏好暂存、删除墓碑）的读写。
 *
 * 这类数据的意义就是「断网 / 退出 / 关页时别丢」，所以存不进去不能装作存好了：
 *   - localStorage 为主：同步读写，不随账号命名空间一起清；
 *   - 写失败（配额满 / 隐私模式 / 被禁用）时退到内存（同一页面会话内退出再登录还在），
 *     并顺手写一份进 IndexedDB（配额大得多，刷新后能从它恢复），同时上报一次——调用方拿到 false，别再说「已暂存」；
 *   - 读：内存里有（上一次写失败留下的）以内存为准，否则读 localStorage；
 *   - 启动时 hydrateDurableState() 把 IndexedDB 里那份捞回内存（只有 localStorage 写失败过才会有），并再试一次写回 localStorage。
 */
import { reportClientError } from "./clientErrors";
import { idbDelete, idbGet, idbSet } from "./idbStore";

const IDB_PREFIX = "durable:";
const durableKeys = new Set<string>();
/** localStorage 写失败后留在内存里的最新值。 */
const memory = new Map<string, unknown>();
/** 这次页面会话里写过的键：补水时别用 IndexedDB 里的旧副本盖掉。 */
const touched = new Set<string>();
/** IndexedDB 里（可能）有副本的键：下次 localStorage 写成功就把副本删掉，免得陈旧副本再被捞回来。 */
const idbShadow = new Set<string>();
const reported = new Set<string>();
let hydration: Promise<void> | null = null;

interface DurableCopy {
  at: number;
  value: unknown;
}

/** 声明一个设备级键：启动补水只认声明过的。 */
export function registerDurableKey(key: string) {
  durableKeys.add(key);
}

export function readDurableState<T>(key: string, fallback: T): T {
  if (memory.has(key)) return memory.get(key) as T;
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

/** 写一次。返回 false 表示 localStorage 没写进去（值留在内存 / IndexedDB 里，刷新后未必还在）。 */
export function writeDurableState(key: string, value: unknown): boolean {
  touched.add(key);
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
    memory.delete(key);
    if (idbShadow.has(key)) {
      idbShadow.delete(key);
      void idbDelete(IDB_PREFIX + key).catch(() => undefined);
    }
    return true;
  } catch (error) {
    memory.set(key, value);
    idbShadow.add(key);
    void idbSet(IDB_PREFIX + key, { at: Date.now(), value } satisfies DurableCopy).catch(() => undefined);
    if (!reported.has(key)) {
      reported.add(key);
      reportClientError({
        scope: "storage",
        message: `localStorage 写入失败，${key} 先留在内存和 IndexedDB 里：${error instanceof Error ? error.message : String(error)}`,
        detail: { key },
      });
    }
    return false;
  }
}

/**
 * 启动时把 IndexedDB 里的副本捞回来（上次 localStorage 写失败时留下的）。
 * 要在读偏好暂存 / 墓碑之前 await 一次；多次调用只跑一遍。
 */
export function hydrateDurableState(): Promise<void> {
  if (hydration) return hydration;
  hydration = (async () => {
    await Promise.all(
      [...durableKeys].map(async (key) => {
        try {
          const copy = await idbGet<DurableCopy>(IDB_PREFIX + key);
          if (!copy || typeof copy !== "object" || !("value" in copy)) return;
          idbShadow.add(key);
          // 这次会话已经写过这个键：内存 / localStorage 里的更新，别被旧副本盖掉（下次写成功会顺手删掉副本）。
          if (touched.has(key)) return;
          memory.set(key, copy.value);
          // 再试一次写回 localStorage（可能已经腾出空间）；成功就不用留 IndexedDB 副本了。
          writeDurableState(key, copy.value);
        } catch {
          // IndexedDB 也不可用：只能靠 localStorage 那份
        }
      }),
    );
  })();
  return hydration;
}
