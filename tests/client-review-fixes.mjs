// 一轮 review 里挑出来的前台问题的回归：
// 1) 画布浮层组件身份稳定（放到画布不再把 Overlay 卸载重挂）；刷新后遗留的「正在生成…」画框要收口；
// 2) 简易 / 画布切换不卸载画布；简易模式附件走 IndexedDB；
// 3) 会话失效统一回登录页；视图进地址栏；删除成片有 5 秒撤销；功能中心保活；
// 4) 后台不再用 window.prompt；短视频删除要确认、跑着的能取消；批量存本地有进度和停止。
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
assert(app.includes('keepalive: true }).catch'), "页面关掉前没到点的删除要 keepalive 发出去");
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
  await page.getByText("ImageDesign AI").first().waitFor({ state: "visible", timeout: 15000 });
  assert.equal(new URL(page.url()).pathname, "/storage", "重新登录后停在掉线前的地址");

  console.log(JSON.stringify({ checks: "passed", deleteCalls }, null, 2));
} finally {
  await browser?.close();
  appProcess.kill("SIGTERM");
  await fs.rm(tmpDir, { recursive: true, force: true });
}
