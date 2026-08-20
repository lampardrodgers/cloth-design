import assert from "node:assert/strict";
import fs from "node:fs/promises";
import ts from "typescript";

/**
 * 前端这边的「别再无限往下铺」：
 *   1. 页码条只画当前页附近几个页号，1000 页也不会铺满一屏；
 *   2. 后台五个列表 + 文件管理 + 短视频任务都接到分页上，不再是 slice(0, 8) 砍掉了事；
 *   3. 任务 / 成片在 localStorage 里有留存上限，写不进去也不再静默吞掉。
 */

/* ── 页码窗口（纯函数） ───────────────────────────────────────────────────── */

let source = await fs.readFile("src/lib/paging.ts", "utf8");
source = source.replace(/^import .*?;$/gm, "");
const transpiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
});
const paging = await import(`data:text/javascript;base64,${Buffer.from(transpiled.outputText).toString("base64")}`);

assert.deepEqual(paging.pageWindow(1, 1), [1], "只有一页就只有一个页号");
assert.deepEqual(paging.pageWindow(1, 5), [1, 2, 3, 4, 5], "页数少的时候全画出来，不要多余的省略号");
// 0 是省略号占位；1000 页也只画到个位数个按钮。
assert.deepEqual(paging.pageWindow(1, 1000), [1, 2, 3, 0, 1000]);
assert.deepEqual(paging.pageWindow(500, 1000), [1, 0, 498, 499, 500, 501, 502, 0, 1000]);
assert.deepEqual(paging.pageWindow(1000, 1000), [1, 0, 998, 999, 1000]);
assert(paging.pageWindow(500, 1000).length <= 9, "页码按钮数量必须是常数级，不能跟着总页数涨");
// 越界/脏输入都得夹回去，不能画出 0 页或者负数页
assert.deepEqual(paging.pageWindow(0, 3), [1, 2, 3]);
assert.deepEqual(paging.pageWindow(99, 3), [1, 2, 3]);
assert.deepEqual(paging.pageWindow(Number.NaN, 0), [1]);
assert.equal(paging.emptyPageInfo(20).pageCount, 1, "空列表也算一页，别让页码条显示 0/0");

/* ── 后台：五个列表都走服务端分页 ─────────────────────────────────────────── */

const admin = await fs.readFile("src/components/AdminPanel.tsx", "utf8");

for (const [name, loader] of [
  ["usersList", "fetchAdminUsersPage"],
  ["ordersList", "fetchAdminOrdersPage"],
  ["eventsList", "fetchAdminPaymentEventsPage"],
  ["ledgerList", "fetchAdminLedgerPage"],
  ["resultsList", "fetchAdminGenerationResultsPage"],
]) {
  assert(admin.includes(`const ${name} = usePagedList<`), `${name} 要走 usePagedList`);
  assert(admin.includes(`load: ${loader},`), `${name} 要接到 ${loader}`);
  assert(admin.includes(`${name}.go({ page })`), `${name} 要有能翻页的 Pager`);
}

// 老写法：拉 80 条回来只渲染前 8/12 条，剩下的看不到。别再退回去。
assert(!/\.slice\(0,\s*(8|12)\)/.test(admin), "后台列表不许再用 slice 截断代替分页");
assert(!admin.includes("{users.map("), "用户表要渲染当前页，不是 props 里那一整份");
assert(admin.includes("{usersList.items.map("), "用户表渲染 usersList.items");

// 搜索 / 筛选：账号多了以后翻页找人不现实
assert(admin.includes('type="search"'), "用户列表要能搜");
assert(admin.includes('usersList.go({ q: userSearch.trim() })'), "搜索要打到服务端，不是只筛当前页");
assert(admin.includes('usersList.go({ filter: event.target.value })'), "要能按待开通/锁定等状态筛");
for (const option of ["pending", "locked", "unlimited", "own-key"]) {
  assert(admin.includes(`<option value="${option}">`), `筛选要有 ${option}`);
}

// 审计图墙排 3 列 × 5 行，全部懒加载
assert(admin.includes('loading="lazy"'), "生成审计的缩略图要懒加载");
assert(
  /\.billing-admin-list\.generation-history-list\s*\{[^}]*grid-template-columns:\s*repeat\(3,/.test(
    await fs.readFile("src/styles.css", "utf8"),
  ),
  "生成审计一行放 3 个，别让右边三分之二空着",
);

// 积分流水平时不看：收起来，压在「计费」分区最后
const ledgerAt = admin.indexOf('<Section title="积分流水"');
assert(ledgerAt > 0, "积分流水版块还在");
assert(admin.includes('<Section title="积分流水" collapsible defaultOpen={false}'), "积分流水默认收起，点开才显示");
for (const before of ["积分规则", "充值套餐", "支付配置", "支付订单", "支付事件"]) {
  assert(admin.indexOf(`<Section title="${before}"`) < ledgerAt, `积分流水要排在「${before}」后面`);
}
const billingAt = admin.indexOf('{tab === "billing" ? (');
const afterBillingAt = admin.indexOf('{tab === "storage" ? (');
assert(billingAt > 0 && billingAt < ledgerAt && ledgerAt < afterBillingAt, "积分流水归「计费」分区，且是这一分区的最后一块");

const ui = await fs.readFile("src/components/ui.tsx", "utf8");
assert(ui.includes("collapsible = false") && ui.includes('aria-expanded={open}'), "Section 要支持折叠且对读屏可见");
assert(admin.includes("usersList.patchItems("), "改用户资料要就地改当前页，别整页重拉");

const app = await fs.readFile("src/App.tsx", "utf8");
assert(app.includes("pagination={adminOverview?.pagination}"), "overview 的分页游标要传给后台面板");

/* ── 文件管理：成片列表分页 ───────────────────────────────────────────────── */

const storage = await fs.readFile("src/components/StoragePanel.tsx", "utf8");
assert(storage.includes("pagination?: PageInfo;"), "文件管理要接分页信息");
assert(storage.includes("<Pager"), "文件管理要有页码条");
assert(
  storage.includes("const pendingArchiveCount = activeCount;"),
  "「全部推到云盘」的数字是账号全量口径，不能按当前这一页算",
);
assert(app.includes("fetchAllStorageResults"), "「全部存到本地」要把所有页翻一遍，不能只存当前页");
assert(app.includes("storagePageRef"), "刷新/归档之后要留在当前这一页");

/* ── 短视频任务列表 ───────────────────────────────────────────────────────── */

const shortVideo = await fs.readFile("src/components/ShortVideoStudio.tsx", "utf8");
assert(shortVideo.includes("const loadTasks = useCallback"), "短视频任务要能按页拉");
assert(shortVideo.includes("taskPageRef"), "轮询要刷当前停留的那一页");
assert(shortVideo.includes("await loadTasks(1)"), "新任务在第一页，提交完要跳回去");
assert(
  shortVideo.includes("setActiveCount(data.activeCount ?? "),
  "在跑的任务数按账号算（服务端给），翻到第二页不能把并发上限判错",
);

/* ── 本地留存：localStorage 有上限，写失败不再静默 ────────────────────────── */

const stored = await fs.readFile("src/lib/storedState.ts", "utf8");
assert(stored.includes("export function useCappedStoredState"), "要有带上限的本地状态");
assert(stored.includes("next.slice(0, limit)"), "超出上限丢最旧的那批");
assert(stored.includes("reportClientError("), "写不进去要上报，别再 catch 之后什么都不做");
assert(!/catch\s*\{\s*\n\s*\/\/ Ignore quota errors/.test(stored), "配额错误不许再静默吞掉");

assert(
  app.includes('useCappedStoredState<GenerationTask>("clothdesign:tasks", initialTasks, LOCAL_HISTORY_LIMIT)'),
  "任务列表要封顶",
);
assert(
  app.includes('useCappedStoredState<GeneratedResult>("clothdesign:results", [], LOCAL_HISTORY_LIMIT)'),
  "本地成片列表要封顶",
);
assert(/const LOCAL_HISTORY_LIMIT = \d+;/.test(app), "留存上限要是个写明的常量");

/* ── 任务栏：不再一次画上百条 ─────────────────────────────────────────────── */

const rail = await fs.readFile("src/components/TaskRail.tsx", "utf8");
assert(rail.includes("const TASK_PAGE_SIZE"), "任务栏要分批渲染");
assert(rail.includes("tasks.slice(0, visible)"), "先画一批，点「显示更多」再加");
assert(rail.includes("显示更多"), "要有继续加载的入口");
assert(!rail.includes("results.find((result) => result.taskId === task.id)"), "预览图要走索引，别每条任务都 find 一遍");
assert(rail.includes("previewByTask.get(task.id)"), "预览图按 taskId 建索引");

/* ── 样式 ─────────────────────────────────────────────────────────────────── */

const styles = await fs.readFile("src/styles.css", "utf8");
for (const selector of [".pager", ".pager-page", ".pager-page.current", ".pager-gap", ".admin-search", ".task-more", ".section-toggle", ".section-collapsible.collapsed .section-chevron"]) {
  assert(styles.includes(selector), `styles.css should define ${selector}`);
}

console.log(JSON.stringify({ checks: "passed" }, null, 2));
