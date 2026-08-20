import { readStoredState, writeStoredState } from "./storedState";

/**
 * 刚删掉的成片 id 的「墓碑」，两个用途：
 *   1) 关页 / 刷新时删除请求是 keepalive 发出去的，新页面的 /api/me 可能比它先到服务端，服务端那一瞬间还有这条记录，
 *      合并进列表就「复活」了——登录 / 拉文件管理时把墓碑里的 id 过滤掉；
 *   2) 删除请求失败（网络抖动、退出时没发出去）的先记成 pending：下次这个账号登录时再补发一次 DELETE，
 *      不会出现「界面上说删了，下次登录又回来了」。
 * 存在设备级的键里、按账号分组，不随退出登录清账号命名空间一起删。
 * 已确认删掉的只留 10 分钟（服务端早删完了）；pending 的留 24 小时等补删。每个账号最多 100 条。
 */
const DONE_TTL_MS = 10 * 60 * 1000;
const PENDING_TTL_MS = 24 * 60 * 60 * 1000;
const TOMBSTONE_LIMIT = 100;
export const TOMBSTONE_KEY = "clothdesign:deleted-results";

interface Tombstone {
  id: string;
  at: number;
  /** 服务端还没确认删掉（请求失败 / 没等到回包）。 */
  pending?: boolean;
}

function readAll(now = Date.now()): Record<string, Tombstone[]> {
  const stored = readStoredState<Record<string, Tombstone[]>>(TOMBSTONE_KEY, {});
  const live: Record<string, Tombstone[]> = {};
  for (const [accountId, items] of Object.entries(stored && typeof stored === "object" && !Array.isArray(stored) ? stored : {})) {
    if (!Array.isArray(items)) continue;
    const kept = items.filter((item) => item && typeof item.id === "string" && now - Number(item.at || 0) < (item.pending ? PENDING_TTL_MS : DONE_TTL_MS));
    if (kept.length) live[accountId] = kept;
  }
  return live;
}

function writeAccount(accountId: string, items: Tombstone[]) {
  const all = readAll();
  if (items.length) all[accountId] = items.slice(0, TOMBSTONE_LIMIT);
  else delete all[accountId];
  writeStoredState(TOMBSTONE_KEY, all);
}

function liveTombstones(accountId: string | null | undefined) {
  if (!accountId) return [] as Tombstone[];
  return readAll()[accountId] ?? [];
}

/**
 * 记下刚删的成片。pending=true 表示服务端还没确认（请求失败 / 没等回包），下次登录会补发 DELETE；
 * 确认删掉后再调一次 markDeletedResultsDone（或直接 pending=false）。
 */
export function rememberDeletedResults(accountId: string | null | undefined, ids: string[], options: { pending?: boolean } = {}) {
  if (!accountId || !ids.length) return;
  const now = Date.now();
  const kept = liveTombstones(accountId).filter((item) => !ids.includes(item.id));
  writeAccount(accountId, [...ids.map((id) => ({ id, at: now, ...(options.pending ? { pending: true } : {}) })), ...kept]);
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
