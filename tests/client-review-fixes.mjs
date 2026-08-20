// 一轮 review 里挑出来的前台问题的回归：
// 1) 画布浮层组件身份稳定（放到画布不再把 Overlay 卸载重挂）；刷新后遗留的「正在生成…」画框要收口；
// 2) 简易 / 画布切换不卸载画布；简易模式附件走 IndexedDB；
// 3) 会话失效统一回登录页；视图进地址栏；删除成片有 5 秒撤销；功能中心保活；
// 4) 后台不再用 window.prompt；短视频删除要确认、跑着的能取消；批量存本地有进度和停止。
// 5) 第二轮补漏：后台模板真的进出图链路、规则定时刷新；刷新页面时软删除本地也要同步；
//    改密 / 建工作流任务也走统一的会话失效；偏好同步失败会重试、退出前先推；过期成片不能再加入参考 / 放到画布；
//    画布里老的服务器地址资产补转；「全部推云盘」也有 N/M 进度和停止。
// 6) 第三轮补漏：缺失的成片路径明确 404（不再掉进 SPA 回退变成 index.html + 200）、画布只认 image/*；
//    创作台 / 画布成片库也挡过期成片；退出时偏好推不出去暂存到本机、下次登录补推；退出时删不掉的留 pending 墓碑、下次登录补删；
//    整批推云盘按当前错误判断是否整批失败；短视频回传断流不留 .part。
// 7) 第四轮补漏：偏好暂存改成「先写后发」（退出等过超时 / 请求一直挂着 / 关页都不丢）；偏好暂存和删除墓碑写不进 localStorage 时
//    退到内存 + IndexedDB、刷新后补水，不再假装「已暂存」；画布拉不到成片就报错让用户重试，不再把服务器地址写进画布；
//    创作台过期成片的放大 / 下载 / 缩略胶片也收掉。
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";

/* ── 静态检查：改动点都要在源码里 ───────────────────────────────────────── */
const canvas = await fs.readFile("src/components/CanvasBoard.tsx", "utf8");
assert(canvas.includes("InFrontOfTheCanvas: CanvasOverlayHost"), "InFrontOfTheCanvas 必须是固定组件");
assert(!canvas.includes("InFrontOfTheCanvas: () =>"), "不能再每次 pendingImages 变了就造新组件");
assert(canvas.includes("const CanvasOverlayPropsContext = createContext<CanvasOverlayProps | null>(null);"), "pendingImages 走 context");
assert(canvas.includes('shape.props.status === "running"') && canvas.includes("刷新时断开了跟踪"), "onMount 要把遗留的 running 画框收口成 failed");
assert(canvas.includes("async function canvasAssetSource(url: string)") && canvas.includes('url.startsWith("/generated-images/")'), "受管成片放进画布要转成 data URL，服务器清理后不裂图");
assert(canvas.includes("shell.offsetParent === null"), "画布 display:none 保活时看门狗不能把它当白屏重挂");

const freeStudio = await fs.readFile("src/components/FreeStudio.tsx", "utf8");
assert(freeStudio.includes('useIdbState<FreeAttachment[]>("clothdesign:free:attachments", [])'), "附件不进 localStorage");
assert(!freeStudio.includes('useStoredState<FreeAttachment[]>("clothdesign:free:attachments"'), "附件不能再走 localStorage");
assert(freeStudio.includes('hidden={layout !== "canvas"}') && freeStudio.includes("canvasOpened"), "画布打开过就保活，切到简易只是隐藏");
assert(freeStudio.includes("abandoned"), "用户放弃等待不算失败，不把描述放回输入框");

const idb = await fs.readFile("src/lib/idbStore.ts", "utf8");
assert(idb.includes("export function useIdbState") && idb.includes("indexedDB.open"), "要有 IndexedDB 版的本地状态");
assert(idb.includes("本地保存失败"), "写失败要提示，不再静默");

const api = await fs.readFile("src/lib/api.ts", "utf8");
assert(api.includes('export const UNAUTHORIZED_EVENT = "clothdesign:unauthorized"'), "401/403 要广播统一事件");
assert(api.includes("function sessionLost(response: Response") && api.includes("pendingApproval === true || /锁定/"), "403 只有账号不可用才算会话失效");
assert(api.includes("signal?: AbortSignal") && api.includes("signal,\n  });"), "出图请求要能中断");
assert(api.includes("export async function cancelShortVideoTask") && api.includes("export async function changeMyPassword"), "取消短视频 / 自助改密的接口");

const app = await fs.readFile("src/App.tsx", "utf8");
assert(app.includes("const viewPaths: Record<ViewKey, string>") && app.includes("function viewFromPath("), "视图 ↔ 路径映射");
assert(app.includes("const requestedView = viewFromPath(path);") && !app.includes('useState<ViewKey>("free")'), "视图由路径决定，不再是纯 state");
assert(app.includes("window.history.pushState({}, \"\", nextPath);\n    setPath(nextPath);\n  }, []);"), "切视图就是 pushState");
assert(app.includes("window.addEventListener(UNAUTHORIZED_EVENT, handleUnauthorized)"), "App 要监听会话失效事件");
assert(app.includes("登录已失效"), "回登录页时要说明原因");
assert(app.includes("const handleDeleteResult = (id: string) => {") && app.includes("}, 5000);") && app.includes("handleUndoDeletes"), "删除成片是 5 秒软删除 + 撤销");
assert(app.includes("void sendPendingDeletes(accountId, ids, { keepalive: true, attempts: 1 });"), "页面关掉前没到点的删除要 keepalive 发出去（卸载中只发一次，失败的下次登录补）");
assert(app.includes('className="view-keepalive" hidden={view !== "workflows"}'), "功能中心保活不卸载");
assert(app.includes("handleAbandonTask") && app.includes("new AbortController()"), "运行中的任务能放弃等待");
assert(app.includes("saveAllProgress={saveAllProgress}") && app.includes("onCancelSaveAll={handleCancelSaveAll}"), "全部存到本地有进度和停止");

const simple = await fs.readFile("src/components/SimpleComposer.tsx", "utf8");
assert(simple.includes('selected.storageStatus === "expired"') && simple.includes('className="expired-plate"'), "简易模式过期成片显示清理提示，不是裂图");
assert(simple.includes("simple-result-thumb-expired"), "缩略图也要标已清理");

const shortVideo = await fs.readFile("src/components/ShortVideoStudio.tsx", "utf8");
assert(shortVideo.includes("window.confirm(") && shortVideo.includes("删除这条任务和它的成片"), "短视频删除要确认");
assert(shortVideo.includes("cancelShortVideoTask(task.id)") && shortVideo.includes("取消任务"), "跑着的短视频任务要能取消");

const storagePanel = await fs.readFile("src/components/StoragePanel.tsx", "utf8");
assert(storagePanel.includes("export interface BatchProgress") && storagePanel.includes('className="storage-batch-progress"'), "批量进度条");
const taskRail = await fs.readFile("src/components/TaskRail.tsx", "utf8");
assert(taskRail.includes("放弃等待") && taskRail.includes("onAbandon"), "任务面板的放弃等待");

const styles = await fs.readFile("src/styles.css", "utf8");
assert(styles.includes(".free-body-canvas[hidden]") && styles.includes(".view-keepalive[hidden]"), "保活容器的 hidden 要能压过自己的 display");

/* ── 第二轮补漏的静态检查 ─────────────────────────────────────────────────── */
assert((api.match(/notifyIfSessionLost\(response, data/g) || []).length >= 3, "parseJson、改密、建工作流任务三处都要通知会话失效");
assert(api.includes("keepalive: options.keepalive === true"), "关页前的偏好推送要 keepalive");
assert(api.includes("export async function fetchAppSettings()"), "要有轻量的规则 / 模板刷新接口");
const storedState = await fs.readFile("src/lib/storedState.ts", "utf8");
assert(storedState.includes("export async function flushPreferenceSync(") && storedState.includes("PREFERENCE_RETRY_DELAYS_MS"), "偏好同步失败要放回队列按退避重试");
assert(storedState.includes("if (!pendingPreferencePatch.has(key)) pendingPreferencePatch.set(key, value);"), "重试时期间用户又改过的键以新值为准");
assert(app.includes("flushPreferenceSync({ final: true }).catch(() => undefined), commitPendingDeletesNow()"), "退出前先把没推的偏好推掉（final：原地重试、再不行暂存）、撤销期内的删除提交掉");
assert(app.includes("Promise.race([Promise.all([flushPreferenceSync") && app.includes("SIGN_OUT_SYNC_TIMEOUT_MS"), "服务器僵住也不能让退出卡死");
assert(app.includes("const flushPendingDeletes = () => {") && app.includes('storedStateKeyForAccount("clothdesign:results", accountId)'), "关页 / 刷新时软删除要同步改 localStorage，不能只发请求");
assert(app.includes("const tombstones = recentlyDeletedResultIds(data.account.id);") && app.includes("rememberDeletedResults(accountId, ids, { pending: true });"), "keepalive 的 DELETE 可能比新页面的 /api/me 晚到：刚删的 id 要有墓碑，合并时过滤掉");
assert(app.includes("archiveAllProgress={archiveAllProgress}") && app.includes("onCancelArchiveAll={handleCancelArchiveAll}"), "全部推云盘也有进度和停止");
assert(app.includes("const { result } = await archiveGenerationResult(item.id);") && !app.includes("archiveAllGenerationResults("), "全部推云盘改成客户端逐张推，才有得进度可报、有得停");
assert(simple.includes("EXPIRED_ACTION_HINT") && (simple.match(/disabled=\{(selected|result)\.storageStatus === "expired"\}/g) || []).length >= 4, "过期成片的加入参考 / 放到画布要禁用");
assert(canvas.includes("async function migrateManagedAssets(editor: Editor)") && canvas.includes("void migrateManagedAssets(editor)"), "打开画布时把老的服务器地址资产补转成 data URL");
assert(canvas.includes("这张成片已在服务器上清理，没法再放到画布。"), "文件已清理就报错，不往画布放注定裂掉的图");
const shortVideoServer = await fs.readFile("server/shortvideo.mjs", "utf8");
assert(shortVideoServer.includes("AND status IN ('queued', 'running')\" : \"\"") && (shortVideoServer.match(/\{ onlyActive: true \}/g) || []).length >= 4, "轮询写回只认还在跑的行，取消不会被引擎回包改回去");

/* ── 第三轮补漏的静态检查 ─────────────────────────────────────────────────── */
const serverIndex = await fs.readFile("server/index.mjs", "utf8");
assert(serverIndex.includes("const missingManagedAsset = ") && serverIndex.includes("app.use(generatedImages.publicPath, missingManagedAsset);") && serverIndex.includes("app.use(generatedVideos.publicPath, missingManagedAsset);"), "缺失的成片 / 视频路径要明确 404，不能掉进 SPA 回退");
assert(serverIndex.indexOf("missingManagedAsset") < serverIndex.indexOf("app.get(/.*/, (_req, res) => {"), "404 兜底得排在 SPA 回退前面");
assert(canvas.includes('response.headers.get("content-type")') && canvas.includes("throw goneError()"), "画布拉成片只认 image/*：回了 HTML 也当文件没了，不能把网页存进资产");
assert(canvas.includes("const liveResults = useMemo(() => results.filter((item) => item.storageStatus !== \"expired\"), [results]);") && canvas.includes("results: liveResults"), "画布成片库 / 画框引用选择器不列过期成片");
const gallery = await fs.readFile("src/components/OutputGallery.tsx", "utf8");
assert(gallery.includes("EXPIRED_REFERENCE_HINT") && gallery.includes('disabled={!selected || selected.storageStatus === "expired"}') && gallery.includes('disabled={result.storageStatus === "expired"}'), "创作台的加入参考（舞台 + 网格）也要挡过期成片");
assert(app.includes("fatal = /WebDAV|未启用|未配置|401|403|认证/.test(message);"), "整批推云盘：按这一张的错误判断是否整批失败，不是第一条");
assert(storedState.includes("export async function flushPreferenceSync(options: { keepalive?: boolean; final?: boolean } = {}): Promise<boolean>"), "flushPreferenceSync 要有 final 模式并回报是否推成");
assert(storedState.includes("export function stashUnsyncedPreferences(") && storedState.includes("export function takeUnsyncedPreferences(") && storedState.includes("const unsynced = takeUnsyncedPreferences(accountId);"), "推不出去的偏好暂存到设备上，下次登录补推");
assert(storedState.includes("if (pendingPreferencePatch.get(key) === value) {") && storedState.includes("if (pendingPreferencePatch.size) schedulePreferenceSync(PREFERENCE_SYNC_DELAY_MS);"), "三次重试都失败只放弃这一批的键，请求期间新改的照常排队");
assert(storedState.includes("if (pendingPreferencePatch.size && preferenceSyncAccount) stashUnsyncedPreferences("), "掉线时没推出去的也暂存，不是直接作废");
const deletedResults = await fs.readFile("src/lib/deletedResults.ts", "utf8");
assert(deletedResults.includes("export function pendingDeletedResultIds(") && deletedResults.includes("export function markDeletedResultsDone(") && deletedResults.includes("PENDING_TTL_MS"), "没确认删掉的要记成 pending 墓碑");
assert(app.includes("const replayPendingDeletes = async (accountId: string) => {") && app.includes("void replayPendingDeletes(data.account.id);"), "登录后补发上次没删成的删除");
assert(api.includes("export async function deleteGenerationResultQuietly(") && api.includes("response.status === 404 || response.status === 410"), "关页 / 退出前的删除要有不抛错的版本，404 算删成");
const shortVideoEngine = await fs.readFile("server/shortvideo-engine.mjs", "utf8");
assert(shortVideoEngine.includes("await fs.rm(temp, { force: true }).catch(() => undefined);"), "回传断流要把 .part 删掉");
assert((shortVideoServer.match(/await fs\.rm\(directory, \{ recursive: true, force: true \}\)\.catch\(\(\) => undefined\);/g) || []).length >= 3, "成片拉到一半失败 / 取消要把任务目录清掉");

/* ── 第四轮补漏的静态检查 ─────────────────────────────────────────────────── */
const durable = await fs.readFile("src/lib/durableState.ts", "utf8");
assert(durable.includes("export function writeDurableState(key: string, value: unknown): boolean") && durable.includes("memory.set(key, value);") && durable.includes("idbSet(IDB_PREFIX + key"), "设备级补偿数据写不进 localStorage 时退到内存 + IndexedDB，并回报 false");
assert(durable.includes("export function hydrateDurableState(): Promise<void>") && durable.includes("if (touched.has(key)) return;"), "启动时从 IndexedDB 补水，但别用旧副本盖掉这次会话写过的");
assert(storedState.includes("registerDurableKey(UNSYNCED_PREFERENCES_KEY);") && storedState.includes("return writeDurableState(UNSYNCED_PREFERENCES_KEY, all);"), "偏好暂存走 durableState");
assert(storedState.indexOf("  stashUnsyncedPreferences(account, patch);\n  // 推送途中账号换了") < storedState.indexOf("preferenceSyncInFlight = (async () => {"), "先写后发：发请求之前这批先进暂存，服务端确认了再划掉");
assert(storedState.includes("function clearUnsyncedPreferences(accountId: string, patch: Record<string, unknown>)") && storedState.includes("sameValue(entry.patch[key], value)"), "确认后只划掉同值的键，请求路上又改过的新值要留着");
assert(storedState.includes("if (preferenceSyncInFlight && pendingPreferencePatch.size && preferenceSyncAccount) {"), "关页时上一批还挂在路上，排着的这批先同步落进暂存");
assert(storedState.includes("export function stashUnsyncedPreferences(accountId: string, patch: Record<string, unknown>): boolean") && storedState.includes("const stashed = stashUnsyncedPreferences("), "暂存要回报有没有写进去，上报时说实话");
assert(deletedResults.includes("registerDurableKey(TOMBSTONE_KEY);") && deletedResults.includes("return writeDurableState(TOMBSTONE_KEY, all);"), "删除墓碑也走 durableState");
assert(app.includes("await Promise.all([fetchMe(), hydrateDurableState()])"), "登录 / 启动先把 IndexedDB 里的补偿数据捞回来再落偏好、过滤墓碑");
assert(canvas.includes("throw new Error(FETCH_RETRY_MESSAGE);") && !canvas.includes("先按地址放进画布"), "画布拉不到成片（网络）就报错让用户重试，不再把服务器地址写进画布");
assert(gallery.includes("EXPIRED_FILE_HINT") && (gallery.match(/disabled=\{!selected \|\| selected\.storageStatus === "expired"\}/g) || []).length >= 2, "创作台的放大也要挡过期成片");
assert(gallery.includes('selected && selected.storageStatus !== "expired" ? (') && gallery.includes('zoomOpen && selected && selected.storageStatus !== "expired"'), "过期成片不给下载链接、不开放大");
assert((gallery.match(/<span className="result-thumb-expired">已清理<\/span>/g) || []).length >= 2, "舞台缩略胶片和右栏列表的过期缩略图都标已清理，不拉裂图");
assert(gallery.includes('aria-label="下载" disabled title={EXPIRED_FILE_HINT}'), "网格列表的下载也收掉");
assert(taskRail.includes('preview.storageStatus !== "expired"'), "任务面板的预览图过期就不拉");
assert(styles.includes(".stage-filmstrip .result-thumb-expired"), "胶片里的已清理标记要有尺寸适配");

/* ── 真浏览器：地址栏视图 / 软删除撤销 / 会话失效 / 功能中心保活 ─────────── */
function waitForOutput(child, pattern) {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${pattern}\n${stdout}\n${stderr}`)), 30000);
    const onData = (chunk) => {
      stdout += String(chunk);
      if (pattern.test(stdout)) {
        clearTimeout(timer);
        child.stdout.off("data", onData);
        resolve();
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`App exited before startup: ${code}\n${stdout}\n${stderr}`));
    });
  });
}

const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "clothdesign-review-fixes-"));
const port = 19900 + Math.floor(Math.random() * 90);
const appProcess = spawn(process.execPath, ["server/index.mjs"], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    HOST: "127.0.0.1",
    PORT: String(port),
    DATABASE_URL: `file:${path.join(tmpDir, "app.db")}`,
    IMAGE_ASSET_DIR: path.join(tmpDir, "generated-images"),
    IMAGE_ASSET_PUBLIC_PATH: "/generated-images",
    VIDEO_ASSET_DIR: path.join(tmpDir, "generated-videos"),
    VIDEO_ASSET_PUBLIC_PATH: "/generated-videos",
    AUTH_SECRET: "review-fixes-secret-12345678901234567890",
    PUBLIC_APP_URL: `http://127.0.0.1:${port}`,
    NODE_ENV: "test",
    OPENAI_DEMO_MODE: "true",
    PAYMENT_DEMO_MODE: "true",
    ALLOW_PAYMENT_DEMO_API: "true",
  },
});

let browser;
try {
  await waitForOutput(appProcess, /ClothDesign AI running/);
  const baseUrl = `http://127.0.0.1:${port}`;
  browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  await page.goto(`${baseUrl}/`, { waitUntil: "networkidle" });

  await page.locator("input[autocomplete='name']").fill("Review Fixes");
  await page.locator("#auth-email").fill("review-fixes@example.test");
  await page.locator("input[autocomplete='new-password']").fill("clothdesign123");
  await page.getByRole("button", { name: "创建账号" }).click();
  await page.getByText("ImageDesign AI").first().waitFor({ state: "visible", timeout: 15000 });

  /* 视图进地址栏：点导航改路径，刷新停在原处，后退有效，直接敲路径也认 */
  await page.locator(".rail-nav button[aria-label='账户与积分']").click();
  await page.waitForFunction(() => window.location.pathname === "/account");
  await page.locator(".account-layout").waitFor({ state: "visible" });
  await page.reload({ waitUntil: "networkidle" });
  await page.locator(".account-layout").waitFor({ state: "visible", timeout: 15000 });
  assert.equal(new URL(page.url()).pathname, "/account", "刷新后还在账户页");
  await page.locator(".rail-nav button[aria-label='文件管理']").click();
  await page.waitForFunction(() => window.location.pathname === "/storage");
  await page.goBack();
  await page.waitForFunction(() => window.location.pathname === "/account");
  await page.locator(".account-layout").waitFor({ state: "visible" });
  await page.goto(`${baseUrl}/studio`, { waitUntil: "networkidle" });
  await page.locator(".studio-workspace").waitFor({ state: "visible", timeout: 15000 });

  /* 账户页有自助改密入口 */
  await page.locator(".rail-nav button[aria-label='账户与积分']").click();
  await page.locator(".password-form").waitFor({ state: "visible" });

  /* 功能中心保活：进去一次，切走之后 DOM 还在（hidden），回来状态不丢 */
  await page.locator(".rail-nav button[aria-label='更多工具']").click();
  await page.locator(".view-keepalive .workflow-center").waitFor({ state: "visible", timeout: 15000 });
  await page.locator(".rail-nav button[aria-label='账户与积分']").click();
  await page.locator(".account-layout").waitFor({ state: "visible" });
  assert.equal(await page.locator(".view-keepalive[hidden] .workflow-center").count(), 1, "切走后功能中心要保活在 DOM 里");
  assert.equal(await page.locator(".view-keepalive .workflow-center").isVisible(), false, "但不该显示出来");

  /* 充值后在简易模式出一张图，删除要有撤销 */
  await page.locator(".package-card").filter({ hasText: "试用包" }).getByRole("button", { name: /支付宝/ }).click();
  await page.getByRole("heading", { name: "扫码支付" }).waitFor({ state: "visible", timeout: 10000 });
  await page.getByRole("button", { name: "模拟支付成功" }).click();
  await page.waitForFunction(() => {
    const metric = [...document.querySelectorAll(".metric")].find((item) => item.textContent?.includes("余额"));
    return Number(metric?.querySelector("strong")?.textContent?.replace(/\D/g, "") || 0) > 0;
  });
  await page.locator(".rail-nav button[aria-label='自由创作']").click();
  await page.waitForFunction(() => window.location.pathname === "/free");
  await page.getByRole("button", { name: "简易", exact: true }).click();
  const promptBox = page.locator(".simple-card textarea").first();
  await promptBox.waitFor({ state: "visible", timeout: 10000 });
  await promptBox.fill("一件米白色羊毛大衣");
  await page.locator(".simple-submit button.btn-primary").click();
  await page.locator(".simple-result-card:not(.simple-result-card-pending) img").first().waitFor({ state: "visible", timeout: 20000 });
  assert.equal(await page.locator(".simple-result-card:not(.simple-result-card-pending)").count(), 1);

  let deleteCalls = 0;
  await page.route("**/api/generation-results/*", async (route) => {
    if (route.request().method() === "DELETE") deleteCalls += 1;
    await route.continue();
  });
  await page.locator(".simple-result-card .simple-result-actions button", { hasText: "删除" }).first().click();
  await page.locator(".undo-notice").waitFor({ state: "visible" });
  assert.equal(await page.locator(".simple-result-card:not(.simple-result-card-pending)").count(), 0, "点删除后立刻从列表消失");
  await page.locator(".undo-notice .undo-button").click();
  await page.locator(".undo-notice").waitFor({ state: "hidden" });
  assert.equal(await page.locator(".simple-result-card:not(.simple-result-card-pending)").count(), 1, "撤销后成片回来了");
  assert.equal(deleteCalls, 0, "撤销之内不能真的调删除接口");
  await page.locator(".simple-result-card .simple-result-actions button", { hasText: "删除" }).first().click();
  await page.locator(".undo-notice").waitFor({ state: "visible" });
  await page.waitForFunction(() => !document.querySelector(".undo-notice"), null, { timeout: 8000 });
  await page.waitForFunction(() => document.querySelectorAll(".simple-result-card:not(.simple-result-card-pending)").length === 0);
  await page.waitForTimeout(300);
  assert.equal(deleteCalls, 1, "5 秒到点才真的删");

  /* 会话失效：cookie 没了之后随便一个请求都该统一回登录页，而不是各自弹 401 */
  await context.clearCookies();
  await page.locator(".rail-nav button[aria-label='文件管理']").click();
  await page.locator("#auth-email").waitFor({ state: "visible", timeout: 10000 });
  assert.match(await page.locator(".auth-error").innerText(), /登录已失效/);
  // 登录回来：本地命名空间里的东西还在（描述框刚才清空了，但布局偏好「简易」仍在）
  await page.locator(".auth-tab", { hasText: "登录" }).click();
  await page.locator("#auth-email").fill("review-fixes@example.test");
  await page.locator("input[autocomplete='current-password']").fill("clothdesign123");
  await page.locator(".auth-shell button[type='submit'], form button[type='submit']").first().click();
  // 「ImageDesign AI」登录页上也有，得等真正登录后的导航栏出现才算回来了
  await page.locator(".rail-nav").waitFor({ state: "visible", timeout: 15000 });
  assert.equal(new URL(page.url()).pathname, "/storage", "重新登录后停在掉线前的地址");

  /* 规则 / 模板刷新接口：登录态下能拉到 */
  // 在页面里发请求（带着页面的登录 cookie）
  const fetchJson = (url) => page.evaluate(async (target) => {
    const response = await fetch(target, { credentials: "include" });
    return { status: response.status, json: await response.json().catch(() => null) };
  }, url);
  const settingsResponse = await fetchJson("/api/app-settings");
  assert.equal(settingsResponse.status, 200);
  assert.equal(typeof settingsResponse.json.creditPolicy.perReference, "number");

  /* 后台模板要真的进出图链路：把 /api/me 和 /api/app-settings 下发的模板改掉，出图请求里得带着它 */
  const FREE_HINT = "测试模板标记-FREE-7f3a";
  const TEXT_HINT = "测试模板标记-TEXT-9c1d";
  const injectPrompts = async (route) => {
    const response = await route.fetch();
    const json = await response.json();
    await route.fulfill({ response, json: { ...json, systemPrompts: { ...(json.systemPrompts || {}), free: FREE_HINT, text: TEXT_HINT } } });
  };
  await page.route("**/api/me", injectPrompts);
  await page.route("**/api/app-settings", injectPrompts);
  const generateBodies = [];
  await page.route("**/api/generate", async (route) => {
    generateBodies.push(route.request().postData() || "");
    await route.continue();
  });
  await page.reload({ waitUntil: "networkidle" });
  await page.getByText("ImageDesign AI").first().waitFor({ state: "visible", timeout: 15000 });
  await page.locator(".rail-nav button[aria-label='自由创作']").click();
  await page.getByRole("button", { name: "简易", exact: true }).click();
  const promptBox2 = page.locator(".simple-card textarea").first();
  await promptBox2.waitFor({ state: "visible", timeout: 10000 });
  await promptBox2.fill("一件藏青色西装");
  await page.locator(".simple-submit button.btn-primary").click();
  await page.locator(".simple-result-card:not(.simple-result-card-pending) img").first().waitFor({ state: "visible", timeout: 20000 });
  assert.equal(generateBodies.length, 1, "自由创作发了一次出图请求");
  assert(generateBodies[0].includes(`模式提示: ${FREE_HINT}`), "自由创作的出图提示词要带后台给 free 配的模式提示");
  // 创作台（StudioWorkspace 拿的是静态目录里的模式，以前后台模板到不了这里）
  await page.goto(`${baseUrl}/studio`, { waitUntil: "networkidle" });
  await page.locator(".studio-workspace").waitFor({ state: "visible", timeout: 15000 });
  const studioPrompt = page.locator(".studio-workspace textarea[aria-label='画面描述']").first();
  await studioPrompt.fill("米色针织开衫，白底商业图");
  const studioGenerate = page.waitForResponse((response) => response.url().includes("/api/generate"), { timeout: 20000 });
  await page.locator(".studio-workspace button.prompt-generate").click();
  await studioGenerate;
  assert.equal(generateBodies.length, 2, "创作台发了一次出图请求");
  assert(generateBodies[1].includes(`模式提示: ${TEXT_HINT}`), "创作台出图提示词要用后台配的模板，不是静态目录里那份");
  assert(!generateBodies[1].includes("只输出图片生成提示词。聚焦服装主体"), "静态默认模板不该再出现在请求里");
  await page.unroute("**/api/me", injectPrompts);
  await page.unroute("**/api/app-settings", injectPrompts);

  /* 刷新页面时软删除要一起落到本地：不然 keepalive 把服务器记录删了，本地旧记录又把它捞回来 */
  await page.locator(".rail-nav button[aria-label='自由创作']").click();
  await page.getByRole("button", { name: "简易", exact: true }).click();
  await page.locator(".simple-result-card:not(.simple-result-card-pending)").first().waitFor({ state: "visible", timeout: 10000 });
  const beforeReloadCount = await page.locator(".simple-result-card:not(.simple-result-card-pending)").count();
  assert(beforeReloadCount >= 1, "这时应该至少有一张成片");
  const meBefore = (await fetchJson("/api/me")).json;
  await page.locator(".simple-result-card .simple-result-actions button", { hasText: "删除" }).first().click();
  await page.locator(".undo-notice").waitFor({ state: "visible" });
  await page.reload({ waitUntil: "networkidle" }); // 还在 5 秒撤销期内就刷新
  await page.getByText("ImageDesign AI").first().waitFor({ state: "visible", timeout: 15000 });
  await page.getByRole("button", { name: "简易", exact: true }).click();
  await page.waitForTimeout(500);
  assert.equal(await page.locator(".undo-notice").count(), 0, "刷新回来不该还挂着撤销条");
  const meAfter = (await fetchJson("/api/me")).json;
  const afterReloadCount = await page.locator(".simple-result-card:not(.simple-result-card-pending)").count();
  assert.equal(meAfter.generationResults.length, meBefore.generationResults.length - 1, "服务器上也真的删掉了");
  assert.equal(afterReloadCount, beforeReloadCount - 1, "刷新回来已删除的成片不能复活（本地 + 服务器都要删掉）");

  /* 偏好同步失败要重试：第一次 PUT 给 500，随后应该带着同样的键再推一次 */
  const preferencePuts = [];
  await page.route("**/api/me/preferences", async (route) => {
    const body = route.request().postDataJSON();
    preferencePuts.push(body);
    if (preferencePuts.length === 1) {
      await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "模拟服务端抖动" }) });
      return;
    }
    await route.continue();
  });
  await page.locator(".rail button[aria-label='收起侧边栏']").click(); // clothdesign:railCollapsed 是同步键
  await page.waitForFunction(() => document.querySelector(".rail.collapsed") !== null);
  const deadline = Date.now() + 9000;
  while (preferencePuts.length < 2 && Date.now() < deadline) await page.waitForTimeout(200);
  assert(preferencePuts.length >= 2, `第一次失败后应该重试（实际 PUT ${preferencePuts.length} 次）`);
  assert("clothdesign:railCollapsed" in (preferencePuts[1].preferences || {}), "重试那次要带上没推成功的键");
  assert.equal(preferencePuts[1].preferences["clothdesign:railCollapsed"], true);

  await page.unroute("**/api/me/preferences");

  /* 缺失的成片 / 视频路径要 404，不能掉进 SPA 回退变成 index.html + 200（画布会把 HTML 当图片存进去） */
  const missingImage = await page.evaluate(async () => {
    const response = await fetch("/generated-images/not-there-" + Date.now() + ".png", { credentials: "include" });
    return { status: response.status, contentType: response.headers.get("content-type") || "" };
  });
  assert.equal(missingImage.status, 404, "缺失的成片路径要 404");
  assert(!/text\/html/.test(missingImage.contentType), "缺失的成片不能回 HTML");
  const missingVideo = await page.evaluate(async () => (await fetch("/generated-videos/not-there.mp4", { credentials: "include" })).status);
  assert.equal(missingVideo, 404, "缺失的视频路径要 404");
  const realImage = await page.evaluate(async () => {
    const img = document.querySelector(".simple-result-card:not(.simple-result-card-pending) img");
    if (!img) return null;
    const response = await fetch(img.getAttribute("src"), { credentials: "include" });
    return { status: response.status, contentType: response.headers.get("content-type") || "" };
  });
  if (realImage) assert(realImage.status === 200 && /^image\//.test(realImage.contentType), `真成片照常 image/*（${JSON.stringify(realImage)}）`);

  /* 退出时偏好推不出去：不能丢——暂存到本机，下次这个账号登录时补推 */
  const accountId = await page.evaluate(() => localStorage.getItem("clothdesign:active-account"));
  assert(accountId, "登录态下要有 active-account");
  const signOutPuts = [];
  await page.route("**/api/me/preferences", async (route) => {
    signOutPuts.push(route.request().postDataJSON());
    await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "模拟退出时服务端挂了" }) });
  });
  await page.locator(".rail button[aria-label='展开侧边栏']").click(); // railCollapsed: true → false
  await page.waitForFunction(() => document.querySelector(".rail:not(.collapsed)") !== null);
  await page.locator(".signout-button").click();
  await page.locator("#auth-email").waitFor({ state: "visible", timeout: 20000 });
  assert(signOutPuts.length >= 2, `退出前推不出去要原地再试（实际 PUT ${signOutPuts.length} 次）`);
  const stash = await page.evaluate(() => JSON.parse(localStorage.getItem("clothdesign:unsynced-preferences") || "{}"));
  assert(stash[accountId] && stash[accountId].patch && stash[accountId].patch["clothdesign:railCollapsed"] === false, `没推出去的偏好要暂存在本机（${JSON.stringify(stash)}）`);
  assert.equal(await page.evaluate((id) => localStorage.getItem(`clothdesign:${encodeURIComponent(id)}:railCollapsed`), accountId), null, "退出仍然会清掉这个账号的本地命名空间");
  await page.unroute("**/api/me/preferences");

  const replayPuts = [];
  await page.route("**/api/me/preferences", async (route) => {
    replayPuts.push(route.request().postDataJSON());
    await route.continue();
  });
  await page.locator(".auth-tab", { hasText: "登录" }).click();
  await page.locator("#auth-email").fill("review-fixes@example.test");
  await page.locator("input[autocomplete='current-password']").fill("clothdesign123");
  await page.locator(".auth-shell button[type='submit'], form button[type='submit']").first().click();
  await page.locator(".rail-nav").waitFor({ state: "visible", timeout: 15000 });
  const replayDeadline = Date.now() + 9000;
  while (!replayPuts.some((body) => body?.preferences && "clothdesign:railCollapsed" in body.preferences) && Date.now() < replayDeadline) await page.waitForTimeout(200);
  const replayed = replayPuts.find((body) => body?.preferences && "clothdesign:railCollapsed" in body.preferences);
  assert(replayed, `重新登录后要把暂存的偏好补推上去（实际 PUT：${JSON.stringify(replayPuts)}）`);
  assert.equal(replayed.preferences["clothdesign:railCollapsed"], false, "补推的是退出前没推出去的那个值");
  await page.waitForFunction(() => {
    const rail = document.querySelector(".rail");
    return rail && !rail.classList.contains("collapsed");
  }, null, { timeout: 5000 });
  await page.waitForFunction(
    (id) => !(JSON.parse(localStorage.getItem("clothdesign:unsynced-preferences") || "{}")[id]),
    accountId,
    { timeout: 9000 },
  );
  await page.unroute("**/api/me/preferences");

  /* 退出时偏好请求一直不回包（服务器僵住）：6 秒超时后照样退出，但改动不能凭空没了——先写后发，暂存里得有 */
  const heldPuts = [];
  await page.route("**/api/me/preferences", async (route) => {
    heldPuts.push(route); // 扣住不回包
  });
  await page.locator(".rail button[aria-label='收起侧边栏']").click(); // railCollapsed: false → true
  await page.waitForFunction(() => document.querySelector(".rail.collapsed") !== null);
  const heldDeadline = Date.now() + 8000;
  while (!heldPuts.length && Date.now() < heldDeadline) await page.waitForTimeout(100);
  assert(heldPuts.length >= 1, "防抖到点应该发了一次 PUT（被扣住）");
  const signOutStartedAt = Date.now();
  await page.locator(".signout-button").click();
  await page.locator("#auth-email").waitFor({ state: "visible", timeout: 20000 });
  assert(Date.now() - signOutStartedAt < 15000, "服务器僵住也不能让退出卡死");
  const hungStash = await page.evaluate(() => JSON.parse(localStorage.getItem("clothdesign:unsynced-preferences") || "{}"));
  assert(hungStash[accountId]?.patch?.["clothdesign:railCollapsed"] === true, `请求一直挂着、退出超时之后，改动要在暂存里（${JSON.stringify(hungStash)}）`);
  await page.unroute("**/api/me/preferences");
  for (const route of heldPuts) await route.abort().catch(() => undefined); // 请求最终失败：账号已经退了，暂存照旧
  await page.waitForTimeout(300);
  const hungStashAfterFail = await page.evaluate(() => JSON.parse(localStorage.getItem("clothdesign:unsynced-preferences") || "{}"));
  assert(hungStashAfterFail[accountId]?.patch?.["clothdesign:railCollapsed"] === true, "挂着的请求最终失败也不能把暂存弄没");

  const hungReplayPuts = [];
  await page.route("**/api/me/preferences", async (route) => {
    hungReplayPuts.push(route.request().postDataJSON());
    await route.continue();
  });
  await page.locator(".auth-tab", { hasText: "登录" }).click();
  await page.locator("#auth-email").fill("review-fixes@example.test");
  await page.locator("input[autocomplete='current-password']").fill("clothdesign123");
  await page.locator(".auth-shell button[type='submit'], form button[type='submit']").first().click();
  await page.locator(".rail-nav").waitFor({ state: "visible", timeout: 15000 });
  const hungReplayDeadline = Date.now() + 9000;
  while (!hungReplayPuts.some((body) => body?.preferences?.["clothdesign:railCollapsed"] === true) && Date.now() < hungReplayDeadline) await page.waitForTimeout(200);
  assert(hungReplayPuts.some((body) => body?.preferences?.["clothdesign:railCollapsed"] === true), `重新登录后要把挂着没推出去的那份补推上去（${JSON.stringify(hungReplayPuts)}）`);
  await page.waitForFunction(
    (id) => !(JSON.parse(localStorage.getItem("clothdesign:unsynced-preferences") || "{}")[id]),
    accountId,
    { timeout: 9000 },
  );
  await page.unroute("**/api/me/preferences");

  /* 本机 localStorage 写不进去（配额满 / 隐私模式）：暂存不能假装成功——退到内存 + IndexedDB，刷新后从 IndexedDB 补水再补推 */
  await page.evaluate(() => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function patchedSetItem(key, value) {
      if (key === "clothdesign:unsynced-preferences" || key === "clothdesign:deleted-results") {
        throw new DOMException("模拟 localStorage 配额满", "QuotaExceededError");
      }
      return original.call(this, key, value);
    };
  });
  const readIdbCopy = () =>
    page.evaluate(
      () =>
        new Promise((resolve) => {
          const request = indexedDB.open("clothdesign-state", 1);
          request.onupgradeneeded = () => {
            const db = request.result;
            if (!db.objectStoreNames.contains("kv")) db.createObjectStore("kv");
          };
          request.onsuccess = () => {
            const db = request.result;
            const tx = db.transaction("kv", "readonly");
            const get = tx.objectStore("kv").get("durable:clothdesign:unsynced-preferences");
            get.onsuccess = () => {
              db.close();
              resolve(get.result ?? null);
            };
            get.onerror = () => {
              db.close();
              resolve(null);
            };
          };
          request.onerror = () => resolve(null);
        }),
    );
  const quotaPuts = [];
  await page.route("**/api/me/preferences", async (route) => {
    quotaPuts.push(route.request().postDataJSON());
    await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "模拟服务端挂了" }) });
  });
  await page.locator(".rail button[aria-label='展开侧边栏']").click(); // railCollapsed: true → false
  await page.waitForFunction(() => document.querySelector(".rail:not(.collapsed)") !== null);
  await page.locator(".signout-button").click();
  await page.locator("#auth-email").waitFor({ state: "visible", timeout: 20000 });
  assert(quotaPuts.length >= 1, "退出前推过 PUT");
  const quotaStash = await page.evaluate(() => JSON.parse(localStorage.getItem("clothdesign:unsynced-preferences") || "{}"));
  assert(quotaStash[accountId]?.patch?.["clothdesign:railCollapsed"] !== false, "localStorage 写不进去时它里面当然没有（模拟要生效）");
  const idbCopyDeadline = Date.now() + 5000;
  let idbCopy = null;
  while (Date.now() < idbCopyDeadline) {
    idbCopy = await readIdbCopy();
    if (idbCopy?.value?.[accountId]?.patch?.["clothdesign:railCollapsed"] === false) break;
    await page.waitForTimeout(200);
  }
  assert(idbCopy?.value?.[accountId]?.patch?.["clothdesign:railCollapsed"] === false, `localStorage 写不进去时要落一份到 IndexedDB（${JSON.stringify(idbCopy)}）`);
  await page.unroute("**/api/me/preferences");

  const quotaReplayPuts = [];
  await page.route("**/api/me/preferences", async (route) => {
    quotaReplayPuts.push(route.request().postDataJSON());
    await route.continue();
  });
  await page.reload({ waitUntil: "networkidle" }); // 刷新：setItem 的模拟没了，内存也没了，只剩 IndexedDB 那份
  await page.locator("#auth-email").waitFor({ state: "visible", timeout: 15000 });
  await page.locator(".auth-tab", { hasText: "登录" }).click();
  await page.locator("#auth-email").fill("review-fixes@example.test");
  await page.locator("input[autocomplete='current-password']").fill("clothdesign123");
  await page.locator(".auth-shell button[type='submit'], form button[type='submit']").first().click();
  await page.locator(".rail-nav").waitFor({ state: "visible", timeout: 15000 });
  const quotaReplayDeadline = Date.now() + 9000;
  while (!quotaReplayPuts.some((body) => body?.preferences?.["clothdesign:railCollapsed"] === false) && Date.now() < quotaReplayDeadline) await page.waitForTimeout(200);
  assert(quotaReplayPuts.some((body) => body?.preferences?.["clothdesign:railCollapsed"] === false), `刷新 + 登录后要从 IndexedDB 补水并补推（${JSON.stringify(quotaReplayPuts)}）`);
  await page.waitForFunction(() => document.querySelector(".rail:not(.collapsed)") !== null, null, { timeout: 5000 });
  const idbGoneDeadline = Date.now() + 6000;
  while (Date.now() < idbGoneDeadline) {
    idbCopy = await readIdbCopy();
    if (!idbCopy) break;
    await page.waitForTimeout(200);
  }
  assert.equal(idbCopy, null, "localStorage 又能写了，IndexedDB 里的副本要删掉，免得旧值以后再被捞回来");
  await page.unroute("**/api/me/preferences");

  /* 退出时删除请求失败：成片不能下次登录又回来——留 pending 墓碑，重新登录后补删 */
  await page.locator(".rail-nav button[aria-label='自由创作']").click();
  await page.waitForFunction(() => window.location.pathname === "/free");
  await page.getByRole("button", { name: "简易", exact: true }).click();
  if ((await page.locator(".simple-result-card:not(.simple-result-card-pending)").count()) === 0) {
    const box = page.locator(".simple-card textarea").first();
    await box.waitFor({ state: "visible", timeout: 10000 });
    await box.fill("一条藏青色半身裙");
    await page.locator(".simple-submit button.btn-primary").click();
    await page.locator(".simple-result-card:not(.simple-result-card-pending) img").first().waitFor({ state: "visible", timeout: 20000 });
  }
  const meBeforeFailedDelete = (await fetchJson("/api/me")).json;
  const cardsBeforeFailedDelete = await page.locator(".simple-result-card:not(.simple-result-card-pending)").count();
  let failedDeleteCalls = 0;
  await page.route("**/api/generation-results/*", async (route) => {
    if (route.request().method() !== "DELETE") return route.continue();
    failedDeleteCalls += 1;
    await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "模拟删除时服务端挂了" }) });
  });
  await page.locator(".simple-result-card .simple-result-actions button", { hasText: "删除" }).first().click();
  await page.locator(".undo-notice").waitFor({ state: "visible" });
  await page.locator(".signout-button").click(); // 撤销期内就退出：删除要立刻提交，失败了也不能丢
  await page.locator("#auth-email").waitFor({ state: "visible", timeout: 20000 });
  assert(failedDeleteCalls >= 2, `退出前删除失败要原地再试一次（实际 DELETE ${failedDeleteCalls} 次）`);
  const tombstones = await page.evaluate(() => JSON.parse(localStorage.getItem("clothdesign:deleted-results") || "{}"));
  const pendingTombstones = (tombstones[accountId] || []).filter((item) => item.pending);
  assert.equal(pendingTombstones.length, 1, `没删成的要留 pending 墓碑（${JSON.stringify(tombstones)}）`);
  await page.unroute("**/api/generation-results/*");

  let replayDeleteCalls = 0;
  await page.route("**/api/generation-results/*", async (route) => {
    if (route.request().method() === "DELETE") replayDeleteCalls += 1;
    await route.continue();
  });
  await page.locator(".auth-tab", { hasText: "登录" }).click();
  await page.locator("#auth-email").fill("review-fixes@example.test");
  await page.locator("input[autocomplete='current-password']").fill("clothdesign123");
  await page.locator(".auth-shell button[type='submit'], form button[type='submit']").first().click();
  await page.locator(".rail-nav").waitFor({ state: "visible", timeout: 15000 });
  const deleteReplayDeadline = Date.now() + 9000;
  while (replayDeleteCalls < 1 && Date.now() < deleteReplayDeadline) await page.waitForTimeout(200);
  assert(replayDeleteCalls >= 1, "重新登录后要补发没删成的删除");
  await page.waitForFunction(
    (id) => !(JSON.parse(localStorage.getItem("clothdesign:deleted-results") || "{}")[id] || []).some((item) => item.pending),
    accountId,
    { timeout: 9000 },
  );
  const meAfterReplay = (await fetchJson("/api/me")).json;
  assert.equal(meAfterReplay.generationResults.length, meBeforeFailedDelete.generationResults.length - 1, "补删之后服务器上真的没了");
  assert(!meAfterReplay.generationResults.some((item) => item.id === pendingTombstones[0].id), "补删的就是退出前没删成的那张");
  await page.getByRole("button", { name: "简易", exact: true }).click();
  await page.waitForFunction((expected) => document.querySelectorAll(".simple-result-card:not(.simple-result-card-pending)").length === expected, cardsBeforeFailedDelete - 1, { timeout: 10000 });
  await page.unroute("**/api/generation-results/*");

  /* 创作台：过期成片的放大 / 下载 / 缩略胶片也得收掉，不只是「加入参考」 */
  const expireAll = async (route) => {
    const response = await route.fetch();
    const json = await response.json();
    await route.fulfill({ response, json: { ...json, generationResults: (json.generationResults || []).map((item) => ({ ...item, storageStatus: "expired" })) } });
  };
  await page.route("**/api/me", expireAll);
  await page.goto(`${baseUrl}/studio`, { waitUntil: "networkidle" });
  await page.locator(".studio-workspace").waitFor({ state: "visible", timeout: 15000 });
  await page.locator(".stage-plate-expired").first().waitFor({ state: "visible", timeout: 10000 });
  assert.equal(await page.locator(".stage-tool", { hasText: "放大" }).isDisabled(), true, "过期成片不能放大");
  assert.equal(await page.locator("a.stage-tool", { hasText: "下载" }).count(), 0, "过期成片没有下载链接");
  assert.equal(await page.locator("span.stage-tool.disabled", { hasText: "下载" }).count(), 1, "下载位置是禁用态");
  assert(await page.locator(".stage-filmstrip .result-thumb-expired").count() >= 1, "缩略胶片里过期的标已清理，不拉裂图");
  assert.equal(await page.locator(".stage-filmstrip .result-thumb img").count(), 0, "缩略胶片里不该再有过期图的 <img>");
  assert.equal(await page.locator(".recent-results a.text-button[aria-label='下载']").count(), 0, "右栏列表里过期成片也没有下载链接");
  assert(await page.locator(".recent-results button[aria-label='下载'][disabled]").count() >= 1, "右栏的下载是禁用态");
  await page.unroute("**/api/me", expireAll);

  /* 画布：成片拉不下来（网络故障）就报错让用户重试，不把服务器地址写进画布 */
  const netFailPath = `/generated-images/net-fail-${Date.now()}.png`;
  let netFailFetches = 0; // 只数画布拉字节的 fetch（抽屉缩略图的 <img> 不算）
  await page.route(`**${netFailPath}`, async (route) => {
    if (route.request().resourceType() === "fetch") netFailFetches += 1;
    await route.abort("failed");
  });
  await page.evaluate((imageUrl) => {
    const accountId = window.localStorage.getItem("clothdesign:active-account");
    const key = `clothdesign:${encodeURIComponent(accountId)}:results`;
    const existing = JSON.parse(window.localStorage.getItem(key) || "[]");
    existing.unshift({
      id: "net-fail-1",
      taskId: "net-fail-task-1",
      title: "net-fail-seed",
      mode: "free",
      ratioLabel: "1:1",
      storageStatus: "local-cache",
      credits: 0,
      imageUrl,
      createdAt: new Date().toISOString(),
    });
    window.localStorage.setItem(key, JSON.stringify(existing));
  }, netFailPath);
  await page.goto(`${baseUrl}/free`, { waitUntil: "networkidle" });
  await page.getByText("ImageDesign AI").first().waitFor({ state: "visible", timeout: 15000 });
  await page.getByRole("button", { name: "画布", exact: true }).click();
  await page.locator(".tl-container").waitFor({ state: "visible", timeout: 60000 });
  await page.waitForTimeout(1200);
  await page.getByRole("button", { name: /^成片 \d+$/ }).click();
  await page.locator(".canvas-library").waitFor({ state: "visible", timeout: 10000 });
  await page.locator(".canvas-library-item", { hasText: "net-fail-seed" }).first().click();
  await page.locator(".free-canvas-notice").waitFor({ state: "visible", timeout: 15000 });
  assert.match(await page.locator(".free-canvas-notice").innerText(), /暂时拉取失败/, "拉不到就明说，让用户稍后重试");
  assert.equal(netFailFetches, 2, `网络抖动先重试一次、再不行就报错（实际拉了 ${netFailFetches} 次）`);
  assert.equal(await page.locator(".tl-canvas img").count(), 0, "拉不到的成片不能按服务器地址放进画布");
  await page.unroute(`**${netFailPath}`);

  console.log(JSON.stringify({ checks: "passed", deleteCalls, generateRequests: generateBodies.length, preferencePuts: preferencePuts.length, signOutPuts: signOutPuts.length, replayDeleteCalls, netFailFetches }, null, 2));
} finally {
  await browser?.close();
  appProcess.kill("SIGTERM");
  await fs.rm(tmpDir, { recursive: true, force: true });
}
