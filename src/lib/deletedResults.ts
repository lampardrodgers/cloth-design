import { readStoredState, writeStoredState } from "./storedState";
import { storedStateKeyForAccount } from "./storageNamespace";

/**
 * 刚删掉的成片 id 的「墓碑」：关页 / 刷新时删除请求是 keepalive 发出去的，新页面的 /api/me 可能比它先到服务端，
 * 服务端那一瞬间还有这条记录，合并进列表就「复活」了。登录 / 拉文件管理时把墓碑里的 id 过滤掉，
 * 墓碑只留 10 分钟（服务端早删完了），最多 100 条。
 */
const TOMBSTONE_TTL_MS = 10 * 60 * 1000;
const TOMBSTONE_LIMIT = 100;
const TOMBSTONE_KEY = "clothdesign:deleted-results";

interface Tombstone {
  id: string;
  at: number;
}

function tombstoneKey(accountId: string | null | undefined) {
  return storedStateKeyForAccount(TOMBSTONE_KEY, accountId);
}

function liveTombstones(accountId: string | null | undefined, now = Date.now()) {
  const key = tombstoneKey(accountId);
  if (!key) return [] as Tombstone[];
  return readStoredState<Tombstone[]>(key, []).filter((item) => item && typeof item.id === "string" && now - Number(item.at || 0) < TOMBSTONE_TTL_MS);
}

export function rememberDeletedResults(accountId: string | null | undefined, ids: string[]) {
  const key = tombstoneKey(accountId);
  if (!key || !ids.length) return;
  const now = Date.now();
  const kept = liveTombstones(accountId, now).filter((item) => !ids.includes(item.id));
  writeStoredState(key, [...ids.map((id) => ({ id, at: now })), ...kept].slice(0, TOMBSTONE_LIMIT));
}

export function recentlyDeletedResultIds(accountId: string | null | undefined) {
  return new Set(liveTombstones(accountId).map((item) => item.id));
}
