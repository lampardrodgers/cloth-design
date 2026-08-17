// 画布白屏兜底：
// 1) 部署新版本后老页面手里的 chunk 文件名失效 —— 以前会整页白屏，现在自动刷一次，再失败就给一张说明卡片；
// 2) 画布莫名变空白 —— 自检会重挂编辑器，并把现场发回服务端；
// 3) 前端异常上报接口本身：不登录也能报，但只有 admin 能看。
//
// 这个用例跑生产构建（NODE_ENV=production + dist），因为按需加载的 chunk 只有生产构建才有。
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";

function waitForOutput(child, pattern) {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${pattern}\n${stdout}\n${stderr}`)), 20000);
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

// 生产构建里 CanvasBoard 才是独立文件，先确保 dist 是新的
execFileSync("npm", ["run", "build"], { cwd: process.cwd(), stdio: "ignore" });

const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "clothdesign-canvas-resilience-"));
const port = 19300 + Math.floor(Math.random() * 400);
const app = spawn(process.execPath, ["server/index.mjs"], {
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
    AUTH_SECRET: "canvas-resilience-secret-12345678901234567890",
    PUBLIC_APP_URL: `http://127.0.0.1:${port}`,
    NODE_ENV: "production",
    OPENAI_DEMO_MODE: "true",
    PAYMENT_DEMO_MODE: "true",
    ALLOW_PAYMENT_DEMO_API: "true",
    STORAGE_MAINTENANCE: "false",
  },
});

let browser;
try {
  await waitForOutput(app, /ClothDesign AI running/);
  const baseUrl = `http://127.0.0.1:${port}/`;
  browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });

  let blockCanvasChunk = true;
  await page.route(/CanvasBoard-.*\.(js|css)$/, (route) =>
    blockCanvasChunk ? route.fulfill({ status: 404, body: "not found" }) : route.continue(),
  );

  // 字体请求卡住的情形：tldraw 默认会等字体加载完才渲染，卡住就一直空白
  let stallFonts = false;
  await page.route(/\.woff2?(\?|$)/, async (route) => {
    if (!stallFonts) return route.continue();
    await new Promise(() => undefined);
  });

  await page.goto(baseUrl, { waitUntil: "networkidle" });
  await page.locator("input[autocomplete='name']").fill("Canvas Resilience");
  await page.locator("#auth-email").fill("canvas-resilience@example.test");
  await page.locator("input[autocomplete='new-password']").fill("clothdesign123");
  await page.getByRole("button", { name: "创建账号" }).click();
  await page.getByText("ClothDesign AI").waitFor({ state: "visible", timeout: 15000 });

  // ── 1. chunk 拿不到时不能整页白屏 ────────────────────────────────────────
  await page.getByRole("button", { name: "画布", exact: true }).click();
  await page.locator(".crash-card").waitFor({ state: "visible", timeout: 30000 });

  const afterChunkFailure = await page.evaluate(() => ({
    rootChildren: document.getElementById("root")?.childElementCount ?? 0,
    shell: !!document.querySelector(".app-shell"),
    topbar: !!document.querySelector(".topbar"),
    card: document.querySelector(".crash-card")?.textContent ?? "",
  }));
  assert.ok(afterChunkFailure.rootChildren > 0, "整棵界面不该被卸载");
  assert.ok(afterChunkFailure.shell && afterChunkFailure.topbar, "顶栏和外壳还得在");
  assert.match(afterChunkFailure.card, /画布没能打开/);
  assert.match(afterChunkFailure.card, /刷新页面/);
  assert.match(afterChunkFailure.card, /改用简易模式/);

  // 失败前先自动刷过一次（sessionStorage 里留了记号），第二次才显示卡片
  const reloadFlag = await page.evaluate(() => window.sessionStorage.getItem("clothdesign:chunk-reloaded:canvas"));
  assert.equal(reloadFlag, "1", "应该自动刷新过一次");

  // 上报也得送到服务端
  const chunkErrors = await page.evaluate(async () => (await fetch("/api/admin/client-errors").then((r) => r.json())).errors);
  assert.ok(
    chunkErrors.some((item) => item.scope === "chunk" && /加载 canvas 失败/.test(item.message)),
    `chunk 加载失败应该上报：${JSON.stringify(chunkErrors.map((item) => item.scope))}`,
  );

  // ── 2. 画布空白时自检会把编辑器重挂起来 ──────────────────────────────────
  blockCanvasChunk = false;
  await page.reload({ waitUntil: "networkidle" });
  await page.locator(".tl-container").waitFor({ state: "visible", timeout: 40000 });
  await page.locator(".tlui-toolbar").first().waitFor({ state: "visible", timeout: 20000 });
  // 等自检至少量到一次「正常」，否则它会以为画布还没起来
  await page.waitForTimeout(6000);

  // 模拟「画布还在 DOM 里但一片空白」：把容器藏起来，自检应该重挂一个新的出来
  await page.evaluate(() => {
    const container = document.querySelector(".tl-container");
    if (container instanceof HTMLElement) container.style.display = "none";
  });
  assert.equal(await page.locator(".tl-container").first().isVisible(), false, "先确认画布确实看不见了");

  await page.locator(".tl-container:visible").waitFor({ state: "visible", timeout: 40000 });
  await page.locator(".tlui-toolbar").first().waitFor({ state: "visible", timeout: 20000 });

  const blankErrors = await page.evaluate(async () => (await fetch("/api/admin/client-errors").then((r) => r.json())).errors);
  const blank = blankErrors.find((item) => item.scope === "canvas-blank");
  assert.ok(blank, `画布空白应该上报：${JSON.stringify(blankErrors.map((item) => item.scope))}`);
  assert.match(blank.message, /画布空白/);
  assert.equal(blank.detail.containerH, 0, "上报里要带上当时的现场尺寸");

  // 重挂也救不回来时（这里把外壳压成 0 高，重挂多少次都没用）：给出提示而不是继续傻转
  await page.addStyleTag({ content: ".canvas-shell .tl-container { display: none !important; }" });
  await page.locator(".canvas-blank-notice").waitFor({ state: "attached", timeout: 90000 }).catch(async (error) => {
    const diag = await page.evaluate(async () => ({
      shellH: document.querySelector(".canvas-shell")?.getBoundingClientRect().height,
      containerH: document.querySelector(".tl-container")?.getBoundingClientRect().height,
      scopes: (await fetch("/api/admin/client-errors").then((r) => r.json())).errors.map((item) => item.scope),
    }));
    throw new Error(`${error.message}\n诊断：${JSON.stringify(diag)}`);
  });
  const giveUpErrors = await page.evaluate(async () => (await fetch("/api/admin/client-errors").then((r) => r.json())).errors);
  assert.ok(
    giveUpErrors.some((item) => item.scope === "canvas-blank-giveup"),
    `反复空白应该单独上报一次：${JSON.stringify(giveUpErrors.map((item) => item.scope))}`,
  );

  // ── 3. 上报接口：谁都能报，只有 admin 能看 ───────────────────────────────
  const anonymous = await fetch(`${baseUrl}api/client-errors`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ scope: "window", message: "匿名也能报", url: "/" }),
  });
  assert.equal(anonymous.status, 204);

  const emptyMessage = await fetch(`${baseUrl}api/client-errors`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ scope: "window", message: "  " }),
  });
  assert.equal(emptyMessage.status, 400);

  const unauthenticated = await fetch(`${baseUrl}api/admin/client-errors`);
  assert.ok([401, 403].includes(unauthenticated.status), `没登录不该看到上报列表，实际 ${unauthenticated.status}`);

  const admin = await page.evaluate(async () => (await fetch("/api/admin/client-errors").then((r) => r.json())).errors);
  assert.ok(admin.some((item) => item.message === "匿名也能报"), "匿名上报也要记下来");

  // ── 4. 字体拉不动时，画布照样得画出来 ────────────────────────────────────
  //
  // 线上白屏的真正原因：画布上有带文字的图形时，tldraw 默认要等这些字体全部加载完
  // 才渲染编辑器（maxFontsToLoadBeforeRender: Infinity），字体请求一卡住就永远空白。
  await page.reload({ waitUntil: "networkidle" });
  await page.locator(".tl-container").waitFor({ state: "visible", timeout: 40000 });
  await page.locator(".tlui-toolbar").first().waitFor({ state: "visible", timeout: 20000 });

  await page.locator(".tl-canvas").click({ position: { x: 600, y: 400 } });
  await page.keyboard.press("t");
  await page.mouse.click(600, 400);
  await page.keyboard.type("袖子改短一点");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(1500);
  assert.ok((await page.locator(".tl-shape").count()) > 0, "画布上要先有一个带文字的图形");

  stallFonts = true;
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.locator(".canvas-shell").waitFor({ state: "visible", timeout: 30000 });
  await page.locator(".tlui-toolbar").first().waitFor({ state: "visible", timeout: 25000 });
  const withStalledFonts = await page.evaluate(() => ({
    container: !!document.querySelector(".tl-container"),
    toolbar: !!document.querySelector(".tlui-toolbar"),
    loading: !!document.querySelector(".tl-loading"),
  }));
  assert.deepEqual(
    withStalledFonts,
    { container: true, toolbar: true, loading: false },
    "字体拉不动时不能卡在加载态：画布和工具栏都要正常出现",
  );

  console.log("canvas resilience tests passed");
} finally {
  await browser?.close();
  app.kill();
  await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
}
