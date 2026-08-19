import { useCallback, useEffect, useState } from "react";
import type { AdminListQuery, PageInfo, PagedList } from "./api";

export const DEFAULT_PAGE_SIZE = 20;

export function emptyPageInfo(pageSize = DEFAULT_PAGE_SIZE): PageInfo {
  return { total: 0, page: 1, pageSize, pageCount: 1 };
}

/**
 * 页码条上画哪几个页号：当前页左右各留 span 个，首尾永远露出来，
 * 断开的位置放一个 0 当省略号。这样 1000 页也只画七八个按钮，
 * 不会像早期那样把所有页号一次性铺出来。
 */
export function pageWindow(page: number, pageCount: number, span = 2): number[] {
  const total = Math.max(1, Math.floor(pageCount) || 1);
  const current = Math.min(Math.max(Math.floor(page) || 1, 1), total);
  const wanted = new Set<number>([1, total]);
  for (let index = current - span; index <= current + span; index += 1) {
    if (index >= 1 && index <= total) wanted.add(index);
  }
  const result: number[] = [];
  let previous = 0;
  for (const value of [...wanted].sort((a, b) => a - b)) {
    // 只隔了一页就把那一页画出来——省略号比页号本身还占地方。
    if (previous && value - previous === 2) result.push(previous + 1);
    else if (previous && value - previous > 2) result.push(0);
    result.push(value);
    previous = value;
  }
  return result;
}

function isFirstPage(query: AdminListQuery) {
  return (query.page ?? 1) === 1 && !query.q && (query.filter ?? "all") === "all";
}

export interface PagedListOptions<T> {
  /** 翻页 / 搜索时去服务端取一页。 */
  load: (query: AdminListQuery) => Promise<PagedList<T>>;
  /** 首屏那一页：从 /api/admin/overview 一起带回来的，省一次请求。 */
  seedItems: T[];
  seedInfo?: PageInfo;
  /** 停在第一页时改了数据（比如改用户资料），要把改动写回 overview 那份。 */
  onSeedPatch?: (items: T[]) => void;
}

export interface PagedListView<T> extends PageInfo {
  items: T[];
  loading: boolean;
  error: string;
  query: AdminListQuery;
  /** 翻页 / 改搜索词。只传 q 或 filter 会自动回到第一页。 */
  go: (patch: Partial<AdminListQuery>) => void;
  /** 重新拉当前这一页（删除、改状态之后用）。 */
  refresh: () => void;
  /** 就地改当前这一页的某几条，不重新请求。 */
  patchItems: (mapper: (items: T[]) => T[]) => void;
}

/**
 * 后台列表的分页状态。
 *
 * 关键约定：停在「第一页 + 没搜索」时直接用 overview 带回来的那一页，不额外发请求，
 * 别处（改用户、删成片）刷新 overview 之后这里能跟着更新；一旦翻页或搜过，
 * 就以自己拉回来的那一页为准，不再被 overview 覆盖。
 */
export function usePagedList<T>({ load, seedItems, seedInfo, onSeedPatch }: PagedListOptions<T>): PagedListView<T> {
  const [query, setQuery] = useState<AdminListQuery>({ page: 1, q: "", filter: "all" });
  const [fetched, setFetched] = useState<PagedList<T> | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const atStart = isFirstPage(query);

  // 回到第一页就把自己拉的那份丢掉，重新跟着 overview 走。
  useEffect(() => {
    if (atStart && fetched) setFetched(null);
  }, [atStart, fetched]);

  const run = useCallback(
    (next: AdminListQuery) => {
      setLoading(true);
      setError("");
      load(next)
        .then((result) => setFetched(result))
        .catch((cause) => setError(cause instanceof Error ? cause.message : "读取失败"))
        .finally(() => setLoading(false));
    },
    [load],
  );

  const go = useCallback(
    (patch: Partial<AdminListQuery>) => {
      // 改搜索词/筛选默认回第一页；显式传了 page 就以 page 为准。
      const next: AdminListQuery = { ...query, page: 1, ...patch };
      setQuery(next);
      if (isFirstPage(next)) setFetched(null);
      else run(next);
    },
    [query, run],
  );

  const refresh = useCallback(() => {
    if (!isFirstPage(query)) run(query);
  }, [query, run]);

  const patchItems = useCallback(
    (mapper: (items: T[]) => T[]) => {
      if (fetched) setFetched({ ...fetched, items: mapper(fetched.items) });
      else onSeedPatch?.(mapper(seedItems));
    },
    [fetched, onSeedPatch, seedItems],
  );

  const info = fetched ?? {
    items: seedItems,
    ...(seedInfo ?? { ...emptyPageInfo(), total: seedItems.length, pageCount: 1 }),
  };

  return { ...info, loading, error, query, go, refresh, patchItems };
}
