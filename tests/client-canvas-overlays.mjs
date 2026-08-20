// 画布上的浮层要真的浮在最上面：
// 1) 右上角的成片抽屉不能被 tldraw 的样式面板压掉（tldraw 自带一整层 z-index 300 的 UI）；
// 2) 顶栏的任务面板同理，开在画布上时要盖住画布，而不是被样式面板切掉半边；
// 3) 成片多了要分页 —— 本地最多留 200 张，一次全铺出来既要滚半天也要拉 200 个缩略图。
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";

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

/** 浮层是不是真的在这一点上「最上面」：从屏幕往下打一束光，第一个碰到的必须是它自己。 */
async function topmostAt(page, selector, dx, dy) {
  return page.evaluate(
    ({ target, offsetX, offsetY }) => {
      const node = document.querySelector(target);
      if (!node) return "";
      const box = node.getBoundingClientRect();
      const hit = document.elementFromPoint(box.left + offsetX, box.top + offsetY);
      if (!hit) return "";
      return hit.closest(target) ? target : `${hit.tagName.toLowerCase()}.${hit.className}`;
    },
    { target: selector, offsetX: dx, offsetY: dy },
  );
}

const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "clothdesign-canvas-overlays-"));
const port = 19700 + Math.floor(Math.random() * 400);
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
    AUTH_SECRET: "canvas-overlays-secret-12345678901234567890",
    PUBLIC_APP_URL: `http://127.0.0.1:${port}`,
    NODE_ENV: "test",
    OPENAI_DEMO_MODE: "true",
    PAYMENT_DEMO_MODE: "true",
    ALLOW_PAYMENT_DEMO_API: "true",
  },
});

let browser;
try {
  await waitForOutput(app, /ClothDesign AI running/);
  const baseUrl = `http://127.0.0.1:${port}/`;
  browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(baseUrl, { waitUntil: "networkidle" });

  await page.locator("input[autocomplete='name']").fill("Canvas Overlays");
  await page.locator("#auth-email").fill("canvas-overlays@example.test");
  await page.locator("input[autocomplete='new-password']").fill("clothdesign123");
  await page.getByRole("button", { name: "创建账号" }).click();
  await page.locator(".task-menu-button").waitFor({ state: "visible", timeout: 20000 });

  // 造 14 张成片：够翻两页，又不用真去跑 14 次生成。
  await page.evaluate((count) => {
    const dot =
      "data:image/svg+xml;utf8," +
      encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8" fill="#8aa"/></svg>');
    const results = Array.from({ length: count }, (_, index) => ({
      id: `seed-${index + 1}`,
      taskId: `seed-task-${index + 1}`,
      title: `seed-${index + 1}`,
      mode: "free",
      ratioLabel: "1:1",
      storageStatus: "stored",
      credits: 0,
      imageUrl: dot,
      createdAt: new Date(2026, 0, 1 + index).toISOString(),
    }));
    window.localStorage.setItem("clothdesign:results", JSON.stringify(results));
  }, 14);
  await page.reload({ waitUntil: "networkidle" });
  await page.locator(".task-menu-button").waitFor({ state: "visible", timeout: 20000 });

  await page.getByRole("button", { name: "画布", exact: true }).click();
  await page.locator(".tl-container").waitFor({ state: "visible", timeout: 60000 });
  await page.waitForTimeout(1200);

  /* ── 1. 成片抽屉分页 ────────────────────────────────────────────────────── */

  await page.getByRole("button", { name: /^成片 14$/ }).click();
  await page.locator(".canvas-library").waitFor({ state: "visible", timeout: 10000 });
  assert.equal(await page.locator(".canvas-library-item").count(), 9, "一页只放 9 张");
  assert.match(await page.locator(".canvas-library-pager").innerText(), /共 14 张/);
  assert.match(await page.locator(".canvas-library-pages").innerText(), /1 \/ 2/);
  await page.locator(".canvas-library-pages button[aria-label='下一页']").click();
  assert.equal(await page.locator(".canvas-library-item").count(), 5, "第二页放剩下的 5 张");
  assert.match(await page.locator(".canvas-library-pages").innerText(), /2 \/ 2/);
  assert.equal(
    await page.locator(".canvas-library-pages button[aria-label='下一页']").isDisabled(),
    true,
    "最后一页不能再往后翻",
  );
  await page.locator(".canvas-library-pages button[aria-label='上一页']").click();
  assert.match(await page.locator(".canvas-library-pages").innerText(), /1 \/ 2/);

  // 抽屉挂到别处去了，点一张放到画布这条路必须照旧（编辑器 context 得跟着 portal 走）。
  await page.locator(".canvas-library-item").first().click();
  await page.waitForFunction(() => document.querySelectorAll(".tl-canvas img").length > 0, null, { timeout: 10000 });

  /* ── 2. 样式面板不能压住成片抽屉 ────────────────────────────────────────── */

  // 关掉抽屉，先摆一个画框出来：选中形状时 tldraw 会在右上角弹样式面板，正好压在抽屉位置上。
  await page.locator(".canvas-library .icon-button").click();
  await page.mouse.click(700, 620);
  await page.keyboard.press("a");
  await page.locator(".tlui-style-panel").waitFor({ state: "visible", timeout: 10000 });

  await page.getByRole("button", { name: /^成片 14$/ }).click();
  await page.locator(".canvas-library").waitFor({ state: "visible", timeout: 10000 });
  assert.equal(await topmostAt(page, ".canvas-library", 12, 12), ".canvas-library", "成片抽屉要盖在样式面板上面");
  assert.equal(await topmostAt(page, ".canvas-library", 60, 90), ".canvas-library", "抽屉里的缩略图也得点得到");

  // 「?」说明面板同一层，同样不能被压住
  await page.locator(".canvas-share-panel button[aria-label='画布用法说明']").click();
  await page.locator(".canvas-guide-pinned").waitFor({ state: "visible", timeout: 10000 });
  assert.equal(await topmostAt(page, ".canvas-guide-pinned", 12, 12), ".canvas-guide-pinned", "说明面板要盖在样式面板上面");
  await page.locator(".canvas-guide-pinned .icon-button").click();

  /* ── 3. 顶栏的任务面板开在画布上时也要在最上面 ──────────────────────────── */

  await page.locator(".task-menu-button").click();
  await page.locator(".task-popover").waitFor({ state: "visible", timeout: 10000 });
  assert.equal(await topmostAt(page, ".task-popover", 20, 20), ".task-popover", "任务面板要盖在画布 UI 上面");
  const popoverBox = await page.locator(".task-popover").boundingBox();
  assert.ok(popoverBox && popoverBox.width > 300, "任务面板不该被挤没");

  console.log("client-canvas-overlays: ok");
} finally {
  if (browser) await browser.close();
  app.kill("SIGTERM");
  await new Promise((resolve) => app.once("exit", resolve));
  await fs.rm(tmpDir, { recursive: true, force: true });
}
