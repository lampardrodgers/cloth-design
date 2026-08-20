import { readDurableState, registerDurableKey, writeDurableState } from "./durableState";

/**
 * 刚删掉的成片 id 的「墓碑」，两个用途：
 *   1) 关页 / 刷新时删除请求是 keepalive 发出去的，新页面的 /api/me 可能比它先到服务端，服务端那一瞬间还有这条记录，
 *      合并进列表就「复活」了——登录 / 拉文件管理时把墓碑里的 id 过滤掉；
 *   2) 删除请求失败（网络抖动、退出时没发出去）的先记成 pending：下次这个账号登录时再补发一次 DELETE，
 *      不会出现「界面上说删了，下次登录又回来了」。
 * 存在设备级的键里、按账号分组，不随退出登录清账号命名空间一起删；localStorage 写不进去时退到内存 + IndexedDB（见 durableState），
 * 不会出现「墓碑没存上、关页时没删成、下次登录又复活」。
 * 已确认删掉的只留 10 分钟（服务端早删完了）；pending 的留 24 小时等补删。每个账号最多 100 条。
 */
const DONE_TTL_MS = 10 * 60 * 1000;
const PENDING_TTL_MS = 24 * 60 * 60 * 1000;
const TOMBSTONE_LIMIT = 100;
export const TOMBSTONE_KEY = "clothdesign:deleted-results";
registerDurableKey(TOMBSTONE_KEY);

interface Tombstone {
  id: string;
  at: number;
  /** 服务端还没确认删掉（请求失败 / 没等到回包）。 */
  pending?: boolean;
}

function splitAll(now = Date.now()) {
  const stored = readDurableState<Record<string, Tombstone[]>>(TOMBSTONE_KEY, {});
  const live: Record<string, Tombstone[]> = {};
  let expired = 0;
  for (const [accountId, items] of Object.entries(stored && typeof stored === "object" && !Array.isArray(stored) ? stored : {})) {
    if (!Array.isArray(items)) {
      expired += 1;
      continue;
    }
    const kept = items.filter((item) => item && typeof item.id === "string" && now - Number(item.at || 0) < (item.pending ? PENDING_TTL_MS : DONE_TTL_MS));
    expired += items.length - kept.length;
    if (kept.length) live[accountId] = kept;
  }
  return { live, expired };
}

function readAll(now = Date.now()): Record<string, Tombstone[]> {
  return splitAll(now).live;
}

/** 把过期的墓碑真的从存储里删掉（读时只过滤不写回）。启动补水后、退出时、每小时跑一次。返回删掉的条数。 */
export function pruneDeletedResults(now = Date.now()): number {
  const { live, expired } = splitAll(now);
  if (expired) writeDurableState(TOMBSTONE_KEY, live);
  return expired;
}

/** 返回是否写进了 localStorage（false = 只留在内存 / IndexedDB 里，已上报）。 */
function writeAccount(accountId: string, items: Tombstone[]): boolean {
  const all = readAll();
  if (items.length) all[accountId] = items.slice(0, TOMBSTONE_LIMIT);
  else delete all[accountId];
  return writeDurableState(TOMBSTONE_KEY, all);
}

function liveTombstones(accountId: string | null | undefined) {
  if (!accountId) return [] as Tombstone[];
  return readAll()[accountId] ?? [];
}

/**
 * 记下刚删的成片。pending=true 表示服务端还没确认（请求失败 / 没等回包），下次登录会补发 DELETE；
 * 确认删掉后再调一次 markDeletedResultsDone（或直接 pending=false）。
 */
export function rememberDeletedResults(accountId: string | null | undefined, ids: string[], options: { pending?: boolean } = {}): boolean {
  if (!accountId || !ids.length) return true;
  const now = Date.now();
  const kept = liveTombstones(accountId).filter((item) => !ids.includes(item.id));
  return writeAccount(accountId, [...ids.map((id) => ({ id, at: now, ...(options.pending ? { pending: true } : {}) })), ...kept]);
}

/** 服务端已确认删掉（或本来就没有）：不用再补发了，只当普通墓碑再留一会儿。 */
export function markDeletedResultsDone(accountId: string | null | undefined, ids: string[]) {
  if (!accountId || !ids.length) return;
  const now = Date.now();
  writeAccount(
    accountId,
    liveTombstones(accountId).map((item) => (ids.includes(item.id) && item.pending ? { id: item.id, at: now } : item)),
  );
}

/** 用户当场看到「删除失败」、成片又回到列表里了：墓碑撤掉，别下次登录偷偷再删一次。 */
export function forgetDeletedResults(accountId: string | null | undefined, ids: string[]) {
  if (!accountId || !ids.length) return;
  writeAccount(accountId, liveTombstones(accountId).filter((item) => !ids.includes(item.id)));
}

/** 登录 / 拉列表时要过滤掉的 id（pending 的和刚确认的都算）。 */
export function recentlyDeletedResultIds(accountId: string | null | undefined) {
  return new Set(liveTombstones(accountId).map((item) => item.id));
}

/** 还没得到服务端确认的删除：登录后逐个补发 DELETE。 */
export function pendingDeletedResultIds(accountId: string | null | undefined) {
  return liveTombstones(accountId)
    .filter((item) => item.pending)
    .map((item) => item.id);
}
