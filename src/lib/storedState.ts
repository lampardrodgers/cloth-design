import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { saveMyPreferences } from "./api";
import { reportClientError } from "./clientErrors";
import { flushDurableWrites, readDurableState, registerDurableKey, writeDurableState } from "./durableState";
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
/** 推送失败的重试间隔：第 1 次 3 秒、第 2 次 10 秒、第 3 次 30 秒，再失败就暂存到设备上等下次登录补推，并上报。 */
const PREFERENCE_RETRY_DELAYS_MS = [3000, 10000, 30000];
/** 退出前的最后一次推送（final）：等不了几十秒的退避，失败就原地再试两次，再不行才暂存。 */
const PREFERENCE_FINAL_RETRY_DELAYS_MS = [800, 1500];
/** 上报前等 IndexedDB 兜底写入落定的上限。 */
const DURABLE_WRITE_WAIT_MS = 2000;
const pendingPreferencePatch = new Map<string, unknown>();

/* ── 没推出去的偏好：按账号暂存在设备级的键里 ───────────────────────────────
 * 这份暂存是「先写后发」的日志：每批偏好在发请求之前就先落到这里，服务端确认了才划掉。
 * 于是退出等不到回包（6 秒超时）、请求一直挂着、关页时 keepalive 发没发到——不管哪种，改动都还在设备上，
 * 下次同一账号在这台设备登录时以它为准落地并补推。只留 24 小时——隔太久再把旧值推上去，反而可能盖掉别处的新改动。
 * 存不进 localStorage 时退到内存 + IndexedDB（见 durableState），并回报 false，不再假装「已暂存」。
 * ────────────────────────────────────────────────────────────────────────── */
export const UNSYNCED_PREFERENCES_KEY = "clothdesign:unsynced-preferences";
registerDurableKey(UNSYNCED_PREFERENCES_KEY);
const UNSYNCED_PREFERENCES_TTL_MS = 24 * 60 * 60 * 1000;

interface UnsyncedPreferences {
  at: number;
  patch: Record<string, unknown>;
}

function splitUnsyncedPreferences(now = Date.now()) {
  const stored = readDurableState<Record<string, UnsyncedPreferences>>(UNSYNCED_PREFERENCES_KEY, {});
  const live: Record<string, UnsyncedPreferences> = {};
  let expired = 0;
  for (const [accountId, entry] of Object.entries(stored && typeof stored === "object" ? stored : {})) {
    if (entry && typeof entry.patch === "object" && entry.patch && now - Number(entry.at || 0) < UNSYNCED_PREFERENCES_TTL_MS) live[accountId] = entry;
    else expired += 1;
  }
  return { live, expired };
}

function readUnsyncedPreferences(now = Date.now()): Record<string, UnsyncedPreferences> {
  return splitUnsyncedPreferences(now).live;
}

/**
 * 把过了 24 小时的暂存真的从存储里删掉（读的时候只是过滤，不写回；不删的话提示词 / 草稿 / 表单原文会一直留在设备上，
 * 直到下次恰好有别的写入）。启动补水后、退出时、以及每小时跑一次。返回删掉了几个账号的过期记录。
 */
export function pruneUnsyncedPreferences(now = Date.now()): number {
  const { live, expired } = splitUnsyncedPreferences(now);
  if (expired) writeDurableState(UNSYNCED_PREFERENCES_KEY, live);
  return expired;
}

/** 暂存一批没（还没）推出去的偏好。返回是否写进了 localStorage（false = 只留在内存 / IndexedDB 里）。 */
export function stashUnsyncedPreferences(accountId: string, patch: Record<string, unknown>): boolean {
  const keys = Object.keys(patch);
  if (!accountId || !keys.length) return true;
  const all = readUnsyncedPreferences();
  all[accountId] = { at: Date.now(), patch: { ...(all[accountId]?.patch ?? {}), ...patch } };
  return writeDurableState(UNSYNCED_PREFERENCES_KEY, all);
}

function sameValue(left: unknown, right: unknown) {
  try {
    return JSON.stringify(left) === JSON.stringify(right);
  } catch {
    return false;
  }
}

/**
 * 这批键已经成功推到服务端了：暂存里同名同值的划掉，免得下次登录把旧的又推回去。
 * 只划同值的——请求在路上时用户又改过（退出 / 掉线时那份新值已经并进暂存）的要留着。
 */
function clearUnsyncedPreferences(accountId: string, patch: Record<string, unknown>) {
  const all = readUnsyncedPreferences();
  const entry = all[accountId];
  if (!entry) return;
  for (const [key, value] of Object.entries(patch)) {
    if (key in entry.patch && sameValue(entry.patch[key], value)) delete entry.patch[key];
  }
  if (!Object.keys(entry.patch).length) delete all[accountId];
  writeDurableState(UNSYNCED_PREFERENCES_KEY, all);
}

/**
 * 看一眼这个账号暂存的偏好（只读不删）：登录时拿它落地并排队补推，但日志要留到服务端确认同值成功（clearUnsyncedPreferences）才划掉——
 * 「读完就删、1.5 秒后才推」的那段时间里页面被杀掉，日志没了、服务端也没收到，下次登录就会被服务端的旧值盖掉。
 */
export function peekUnsyncedPreferences(accountId: string): Record<string, unknown> | null {
  const entry = readUnsyncedPreferences()[accountId];
  return entry ? { ...entry.patch } : null;
}

/** 上报用：这批没推出去的偏好到底落在哪了（localStorage / 只有 IndexedDB / 只剩内存）。 */
async function describeStash(stashedToLocalStorage: boolean) {
  if (stashedToLocalStorage) return "已暂存到本机等下次登录补推";
  // IndexedDB 正常几十毫秒就落定；万一它卡住，别让这条在路上的同步（以及后面排队的）跟着卡死。
  const landed = await Promise.race([flushDurableWrites(), sleep(DURABLE_WRITE_WAIT_MS).then(() => false)]);
  return landed ? "本机 localStorage 写不进去，已落到 IndexedDB 等下次登录补推" : "本机 localStorage 和 IndexedDB 都写不进去，只留在内存里（刷新后会丢）";
}

async function sleep(ms: number) {
  await new Promise((resolve) => window.setTimeout(resolve, ms));
}
let preferenceSyncTimer: number | null = null;
let preferenceSyncAccount: string | null = null;
let preferenceSyncInFlight: Promise<void> | null = null;
let preferenceSyncFailures = 0;

function schedulePreferenceSync(delay: number) {
  if (preferenceSyncTimer !== null) window.clearTimeout(preferenceSyncTimer);
  preferenceSyncTimer = window.setTimeout(() => void flushPreferenceSync(), delay);
}

/**
 * 把攒着的偏好推到服务端。返回这一批是否真的推出去了。
 * 以前是「清空队列 → 发请求」，请求一失败这批改动就没了；现在失败会把没被新改动覆盖的键放回队列按退避重试，
 * 退出登录前也会先 await 一次（final：原地再试两次），实在推不出去就暂存到设备上等下次登录补推——
 * 不再出现「改完设置 1 秒内点退出 = 这次修改彻底丢了」。
 */
export async function flushPreferenceSync(options: { keepalive?: boolean; final?: boolean } = {}): Promise<boolean> {
  if (preferenceSyncTimer !== null) {
    window.clearTimeout(preferenceSyncTimer);
    preferenceSyncTimer = null;
  }
  if (preferenceSyncInFlight) {
    // 上一批还在路上：等它落地再推剩下的，别让两批乱序互相覆盖。
    await preferenceSyncInFlight;
    if (!pendingPreferencePatch.size) return true;
  }
  if (!pendingPreferencePatch.size || !preferenceSyncAccount) return true;
  const account = preferenceSyncAccount;
  const patch = Object.fromEntries(pendingPreferencePatch);
  pendingPreferencePatch.clear();
  // 先写后发：这批还没得到服务端确认之前先落在设备上。请求一直挂着、退出等过了超时、关页时 keepalive 有没有送到——
  // 这些情形都等不到失败回包，没有这一步改动就凭空没了；服务端确认了再划掉。
  stashUnsyncedPreferences(account, patch);
  // 推送途中账号换了就别把 A 的偏好写到 B 头上：A 的留在暂存里，A 下次登录再补。
  if (account !== activeStorageAccount()) return false;
  let synced = false;
  preferenceSyncInFlight = (async () => {
    const attempts = options.final ? PREFERENCE_FINAL_RETRY_DELAYS_MS.length + 1 : 1;
    let lastError: unknown;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        await saveMyPreferences(patch, { keepalive: options.keepalive });
        synced = true;
        break;
      } catch (error) {
        lastError = error;
        const delay = PREFERENCE_FINAL_RETRY_DELAYS_MS[attempt];
        if (attempt < attempts - 1 && delay !== undefined) await sleep(delay);
      }
    }
    if (synced) {
      preferenceSyncFailures = 0;
      clearUnsyncedPreferences(account, patch);
      return;
    }
    const message = lastError instanceof Error ? lastError.message : String(lastError);
    if (account !== activeStorageAccount()) {
      // 等回包的这段时间里已经退出 / 掉线：这批已经在暂存里（先写后发），下次登录补推。
      return;
    }
    // 失败的键放回队列（期间用户又改过的键以新值为准），暂存也跟上队列里最新的值——
    // 请求路上改出的新值也得在设备上，这时页面被杀掉才不会让下次打开用路上那份旧值盖掉它。
    for (const [key, value] of Object.entries(patch)) {
      if (!pendingPreferencePatch.has(key)) pendingPreferencePatch.set(key, value);
    }
    preferenceSyncAccount = account;
    const stashed = stashUnsyncedPreferences(account, Object.fromEntries(pendingPreferencePatch));
    if (options.final) {
      // 退出前的最后一搏也没成：没推出去的已经全在暂存里，退出照常进行。上报时把「到底落在哪」说清楚。
      pendingPreferencePatch.clear();
      preferenceSyncFailures = 0;
      const where = await describeStash(stashed);
      reportClientError({
        scope: "preferences",
        message: `退出前偏好同步失败，${where}：${message}`,
        detail: { keys: Object.keys(patch), stashed },
      });
      return;
    }
    preferenceSyncFailures += 1;
    const delay = PREFERENCE_RETRY_DELAYS_MS[preferenceSyncFailures - 1];
    if (delay !== undefined) {
      schedulePreferenceSync(delay);
      return;
    }
    // 三次都没推出去：这批先放弃（暂存，下次登录补推）；请求期间新改的键不受牵连，照常排队再推。
    preferenceSyncFailures = 0;
    const dropped: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(patch)) {
      if (pendingPreferencePatch.get(key) === value) {
        pendingPreferencePatch.delete(key);
        dropped[key] = value;
      }
    }
    if (pendingPreferencePatch.size) schedulePreferenceSync(PREFERENCE_SYNC_DELAY_MS);
    const where = await describeStash(stashed);
    reportClientError({
      scope: "preferences",
      message: `偏好同步失败（已重试 ${PREFERENCE_RETRY_DELAYS_MS.length} 次，${where}）：${message}`,
      detail: { keys: Object.keys(dropped), stashed },
    });
  })().finally(() => {
    preferenceSyncInFlight = null;
  });
  await preferenceSyncInFlight;
  return synced;
}

/** 偏好有改动：攒一会儿再一起推，连续打字不会一键一请求。 */
export function queuePreferenceSync(key: string, value: unknown) {
  const accountId = activeStorageAccount();
  if (!accountId || !SYNCED_PREFERENCE_KEYS.has(key)) return;
  preferenceSyncAccount = accountId;
  pendingPreferencePatch.set(key, value);
  schedulePreferenceSync(PREFERENCE_SYNC_DELAY_MS);
}

/** 还有没推出去的偏好吗（测试 / 退出前的判断用）。 */
export function hasPendingPreferenceSync() {
  return pendingPreferencePatch.size > 0 || preferenceSyncInFlight !== null;
}

// 关页前把还没推出去的那一批推掉（keepalive：页面卸载后请求也能发完），不然刚改的设置只留在这台机器上。
// 上一批还挂在路上时这批轮不到发：先同步落进暂存，下次打开补推——卸载之后就没有「稍后」了。
if (typeof window !== "undefined") {
  window.addEventListener("pagehide", () => {
    if (preferenceSyncInFlight && pendingPreferencePatch.size && preferenceSyncAccount) {
      stashUnsyncedPreferences(preferenceSyncAccount, Object.fromEntries(pendingPreferencePatch));
    }
    void flushPreferenceSync({ keepalive: true });
  });
}

/**
 * 登录拿到服务端偏好后调用：把它们写进这个账号的 localStorage 命名空间（服务端为准），
 * 本机有、服务端还没有的键则反向补推上去（老用户第一次升级时把提示词库带上云）。
 * 要在 setStoredStateAccount 之前调，后者会广播让所有 hook 重读。
 */
export function seedAccountPreferences(accountId: string, preferences: Record<string, unknown> | undefined) {
  const remote = preferences && typeof preferences === "object" ? preferences : {};
  // 上次退出 / 掉线时没推出去的改动：以它为准落地并补推（服务端那份是更早的）。日志本身留到推成功才划掉。
  const unsynced = peekUnsyncedPreferences(accountId);
  for (const key of SYNCED_PREFERENCE_KEYS) {
    const storageKey = storedStateKeyForAccount(key, accountId);
    if (!storageKey) continue;
    // 本机刚改、还没推出去的以本机为准；loadAccount 在支付 / 重登时会再跑，别让旧的服务端值把它盖掉。
    if (pendingPreferencePatch.has(key) && preferenceSyncAccount === accountId) continue;
    if (unsynced && key in unsynced) {
      writeStoredState(storageKey, unsynced[key]);
      pendingPreferencePatch.set(key, unsynced[key]);
      continue;
    }
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
    schedulePreferenceSync(PREFERENCE_SYNC_DELAY_MS);
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
    // 退出 / 掉线：没推出去的偏好按原账号暂存到设备上，下次这个账号登录再补推——既不丢，也不会等下个账号登录时推错人。
    // （主动退出的那条路在调这里之前会先 await flushPreferenceSync({ final: true })；正在路上的那批已经先写后发地在暂存里，
    //   这里兜住的是掉线、以及退出等过了超时之后还排在队列里的那批。）
    if (pendingPreferencePatch.size && preferenceSyncAccount) stashUnsyncedPreferences(preferenceSyncAccount, Object.fromEntries(pendingPreferencePatch));
    pendingPreferencePatch.clear();
    preferenceSyncFailures = 0;
    if (preferenceSyncTimer !== null) {
      window.clearTimeout(preferenceSyncTimer);
      preferenceSyncTimer = null;
    }
  }
  window.dispatchEvent(new CustomEvent(STORAGE_NAMESPACE_EVENT, { detail: { accountId } }));
}

/**
 * 退出登录：清掉这个账号在 localStorage 和 IndexedDB（简易模式附件等）里的全部键。
 * IndexedDB 那一半要 await 到事务完成——退出后马上关页也得删完；删失败上报（不吞），返回 false。
 */
export async function clearStoredStateAccount(accountId: string | null | undefined): Promise<boolean> {
  let ok = true;
  try {
    clearAccountStoredState(window.localStorage, accountId);
  } catch (error) {
    // Logout must continue even when localStorage is disabled.
    ok = false;
    reportClientError({ scope: "storage", message: `退出时清理 localStorage 失败：${error instanceof Error ? error.message : String(error)}`, detail: { accountId } });
  }
  const prefix = accountId ? storedStateKeyForAccount("clothdesign:", accountId) : null;
  if (prefix) {
    try {
      await idbDeletePrefix(prefix);
    } catch (error) {
      ok = false;
      reportClientError({
        scope: "storage",
        message: `退出时清理 IndexedDB 里的账号数据失败（附件等可能还留在这台设备上）：${error instanceof Error ? error.message : String(error)}`,
        detail: { accountId },
      });
    }
  }
  return ok;
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
