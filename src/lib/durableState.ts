/**
 * 设备级「补偿数据」（推不出去的偏好暂存、删除墓碑）的读写。
 *
 * 这类数据的意义就是「断网 / 退出 / 关页时别丢」，所以存不进去不能装作存好了：
 *   - localStorage 为主：同步读写，不随账号命名空间一起清。落盘的是带时间戳的信封 `{ $durable: 1, at, value }`；
 *   - 写失败（配额满 / 隐私模式 / 被禁用）时退到内存（同一页面会话内退出再登录还在），
 *     并写一份 `{ at, value }` 进 IndexedDB（配额大得多，刷新后能从它恢复）；IndexedDB 也写不进去会上报，
 *     flushDurableWrites() 能等到结果——退出前 / 上报时能如实说「到底落没落盘」；
 *   - 读：内存里有（上一次写失败留下的）以内存为准，否则读 localStorage；
 *   - 启动时 hydrateDurableState() 把 IndexedDB 里的副本和本地那份按时间戳比：副本更新才采用（写回 localStorage），
 *     本地更新或一样新就把副本删掉——不会让残留的旧副本盖掉新值（比如把用户后来决定保留的成片当 pending 墓碑补删掉）。
 *     副本只有在 IndexedDB 确认删掉之后才算没了；删失败就留着 shadow，下次写成功再删一次。
 */
import { reportClientError } from "./clientErrors";
import { idbDelete, idbGet, idbSet } from "./idbStore";

const IDB_PREFIX = "durable:";
const ENVELOPE_MARK = 1;

interface DurableRecord {
  at: number;
  value: unknown;
}

interface DurableEnvelope extends DurableRecord {
  $durable: number;
}

const durableKeys = new Set<string>();
/** localStorage 写失败后留在内存里的最新值（带时间戳）。 */
const memory = new Map<string, DurableRecord>();
/** 这次页面会话里写过的键：补水比新旧时要连内存里的一起比。 */
const touched = new Set<string>();
/** IndexedDB 里（可能）还有副本的键：下次 localStorage 写成功就去删，确认删掉了才从这里拿掉。 */
const idbShadow = new Set<string>();
/** 每个键上 IndexedDB 操作的序号：删副本的回调只在「之后没再写过新副本」时才清 shadow。 */
const idbGeneration = new Map<string, number>();
/** 还没落定的 IndexedDB 写 / 删，flushDurableWrites 等它们。 */
const idbPending = new Map<string, Promise<boolean>>();
const reportedLocal = new Set<string>();
const reportedIdb = new Set<string>();
let hydration: Promise<void> | null = null;

/** 声明一个设备级键：启动补水只认声明过的。 */
export function registerDurableKey(key: string) {
  durableKeys.add(key);
}

function isEnvelope(parsed: unknown): parsed is DurableEnvelope {
  return Boolean(parsed) && typeof parsed === "object" && (parsed as DurableEnvelope).$durable === ENVELOPE_MARK && "value" in (parsed as DurableEnvelope);
}

/** localStorage 里这个键现在的记录；老版本落的是裸值（没有信封），按 at=0 处理。 */
function readLocalRecord(key: string): DurableRecord | null {
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (isEnvelope(parsed)) return { at: Number(parsed.at) || 0, value: parsed.value };
    return { at: 0, value: parsed };
  } catch {
    return null;
  }
}

function currentRecord(key: string): DurableRecord | null {
  return memory.get(key) ?? readLocalRecord(key);
}

export function readDurableState<T>(key: string, fallback: T): T {
  const record = currentRecord(key);
  return record ? (record.value as T) : fallback;
}

function nextGeneration(key: string) {
  const generation = (idbGeneration.get(key) ?? 0) + 1;
  idbGeneration.set(key, generation);
  return generation;
}

function trackIdb(key: string, work: Promise<boolean>) {
  const tracked = work.catch(() => false);
  idbPending.set(key, tracked);
  void tracked.finally(() => {
    if (idbPending.get(key) === tracked) idbPending.delete(key);
  });
  return tracked;
}

function writeIdbCopy(key: string, record: DurableRecord) {
  nextGeneration(key);
  idbShadow.add(key);
  return trackIdb(
    key,
    idbSet(IDB_PREFIX + key, record satisfies DurableRecord)
      .then(() => true)
      .catch((error: unknown) => {
        if (!reportedIdb.has(key)) {
          reportedIdb.add(key);
          reportClientError({
            scope: "storage",
            message: `IndexedDB 也写不进去，${key} 只留在内存里（刷新后会丢）：${error instanceof Error ? error.message : String(error)}`,
            detail: { key },
          });
        }
        return false;
      }),
  );
}

function deleteIdbCopy(key: string) {
  const generation = nextGeneration(key);
  return trackIdb(
    key,
    idbDelete(IDB_PREFIX + key)
      .then(() => {
        // 删的时候又写过新副本就别清：shadow 留着，下次写成功再删。
        if (idbGeneration.get(key) === generation) idbShadow.delete(key);
        return true;
      })
      .catch(() => false),
  );
}

/**
 * 写一次。返回 false 表示 localStorage 没写进去（值留在内存里，并已发起 IndexedDB 写入；
 * 想知道 IndexedDB 有没有写成，await flushDurableWrites()）。
 */
export function writeDurableState(key: string, value: unknown): boolean {
  touched.add(key);
  const record: DurableRecord = { at: Date.now(), value };
  try {
    const envelope: DurableEnvelope = { $durable: ENVELOPE_MARK, at: record.at, value };
    window.localStorage.setItem(key, JSON.stringify(envelope));
    memory.delete(key);
    if (idbShadow.has(key)) void deleteIdbCopy(key);
    return true;
  } catch (error) {
    memory.set(key, record);
    void writeIdbCopy(key, record);
    if (!reportedLocal.has(key)) {
      reportedLocal.add(key);
      reportClientError({
        scope: "storage",
        message: `localStorage 写入失败，${key} 先留在内存里并写 IndexedDB：${error instanceof Error ? error.message : String(error)}`,
        detail: { key },
      });
    }
    return false;
  }
}

/** 等还没落定的 IndexedDB 写 / 删都结束；返回是否全部成功（退出前 / 上报前用）。 */
export async function flushDurableWrites(): Promise<boolean> {
  let ok = true;
  // 等的过程中可能又有新的排进来，循环到没有为止。
  while (idbPending.size) {
    const batch = [...idbPending.values()];
    const results = await Promise.all(batch);
    if (results.some((result) => !result)) ok = false;
  }
  return ok;
}

/**
 * 启动时把 IndexedDB 里的副本捞回来（上次 localStorage 写失败时留下的），按时间戳和本地那份比，新的赢。
 * 要在读偏好暂存 / 墓碑之前 await 一次；多次调用只跑一遍。
 */
export function hydrateDurableState(): Promise<void> {
  if (hydration) return hydration;
  hydration = (async () => {
    await Promise.all(
      [...durableKeys].map(async (key) => {
        try {
          const copy = await idbGet<DurableRecord>(IDB_PREFIX + key);
          if (!copy || typeof copy !== "object" || !("value" in copy)) return;
          idbShadow.add(key);
          const copyAt = Number(copy.at) || 0;
          const current = currentRecord(key);
          if (current && current.at >= copyAt) {
            // 本地这份更新（或一样新）：副本是陈旧的，删掉，别以后再被捞回来。
            void deleteIdbCopy(key);
            return;
          }
          memory.set(key, { at: copyAt, value: copy.value });
          // 再试一次写回 localStorage（可能已经腾出空间）；成功就顺手把副本删了。
          writeDurableState(key, copy.value);
        } catch {
          // IndexedDB 也不可用：只能靠 localStorage 那份
        }
      }),
    );
  })();
  return hydration;
}

// 尽早补水，缩小「补水前就有人写」的窗口；App 登录时还会再 await 一次（同一个 promise）。
if (typeof window !== "undefined") {
  window.setTimeout(() => void hydrateDurableState(), 0);
}
