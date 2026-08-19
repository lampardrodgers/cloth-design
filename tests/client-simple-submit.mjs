// 简易模式提交之后：
// 1) 左边立刻清空，可以接着写下一张（不再被「正在生成」锁住）；
// 2) 这次提交的描述、参考图、参数存进「提交详情」，成片和任务面板里都查得到；
// 3) 提交当场失败且用户还没开始写下一张时，把刚才那份放回输入框。
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

const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "clothdesign-simple-submit-"));
const port = 19500 + Math.floor(Math.random() * 180);
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
    AUTH_SECRET: "simple-submit-secret-12345678901234567890",
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

  await page.locator("input[autocomplete='name']").fill("Simple Submit");
  await page.locator("#auth-email").fill("simple-submit@example.test");
  await page.locator("input[autocomplete='new-password']").fill("clothdesign123");
  await page.getByRole("button", { name: "创建账号" }).click();
  await page.getByText("ImageDesign AI").first().waitFor({ state: "visible", timeout: 15000 });

  // 先充点积分，否则生成按钮是灰的
  await page.locator(".rail-nav button[aria-label='账户与积分']").click();
  await page.locator(".package-card").filter({ hasText: "试用包" }).getByRole("button", { name: /支付宝/ }).click();
  await page.getByRole("heading", { name: "扫码支付" }).waitFor({ state: "visible", timeout: 10000 });
  await page.getByRole("button", { name: "模拟支付成功" }).click();
  await page.waitForFunction(() => {
    const metric = [...document.querySelectorAll(".metric")].find((item) => item.textContent?.includes("余额"));
    return Number(metric?.querySelector("strong")?.textContent?.replace(/\D/g, "") || 0) > 0;
  });

  await page.locator(".rail-nav button[aria-label='自由创作']").click();
  await page.getByRole("button", { name: "简易", exact: true }).click();
  const promptBox = page.locator(".simple-card textarea").first();
  await promptBox.waitFor({ state: "visible", timeout: 10000 });

  // 带一张参考图提交
  await promptBox.click();
  await promptBox.type("一件米白色羊毛大衣挂在木质衣架上");
  await page.evaluate(async () => {
    const canvas = document.createElement("canvas");
    canvas.width = 512;
    canvas.height = 512;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#8d6e63";
    ctx.fillRect(0, 0, 512, 512);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
    const transfer = new DataTransfer();
    transfer.items.add(new File([blob], "coat.png", { type: "image/png" }));
    document.body.dispatchEvent(new ClipboardEvent("paste", { clipboardData: transfer, bubbles: true, cancelable: true }));
  });
  await page.locator(".attachment-card").first().waitFor({ state: "visible", timeout: 10000 });
  const delayGeneration = async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 1800));
    await route.continue();
  };
  await page.route("**/api/generate", delayGeneration);
  await page.locator(".simple-submit button.btn-primary").click();

  /* ── 1. 提交后左边立刻清空，可以接着写 ──────────────────────────────────── */

  await page.waitForFunction(() => document.querySelector(".simple-card textarea")?.value === "", null, { timeout: 10000 });
  assert.equal(await page.locator(".attachment-card").count(), 0, "提交后附件也要清空");
  assert.equal(await promptBox.isDisabled(), false, "提交后描述框不该被锁住");
  assert((await page.locator(".simple-pending-chip").count()) >= 1, "要显示还有几张在生成");
  assert.match(await page.locator(".simple-submit .prompt-status").innerText(), /可以接着写下一张/);
  assert.match(await page.locator(".simple-pending-chip").innerText(), /1 张生成中/);
  await page.locator(".simple-stage-pending").waitFor({ state: "visible", timeout: 10000 });
  assert.equal(await page.locator(".simple-stage-image").count(), 0, "生成开始后右侧不该继续保留旧图");
  assert.equal(await page.locator(".simple-result-card-pending").count(), 1, "底部成片区要立即出现生成中的占位卡");

  /* ── 2. 任务面板里能查到这次提交的参考图和参数 ──────────────────────────── */

  await page.locator(".task-menu-button").click();
  await page.locator(".task-submission").first().waitFor({ state: "visible", timeout: 10000 });
  const taskSubmission = await page.locator(".task-submission").first().innerText();
  assert.match(taskSubmission, /1 张参考图/);
  assert.match(taskSubmission, /1 张/);
  assert.equal(await page.locator(".task-submission-refs img").count(), 1, "任务里要能看到参考图缩略图");
  await page.locator(".task-popover .icon-button").click();

  /* ── 3. 成片到手后，「提交详情」里有描述 / 参考图 / 参数 ─────────────────── */

  await page.locator(".simple-stage-image img").first().waitFor({ state: "visible", timeout: 180000 });
  await page.unroute("**/api/generate", delayGeneration);
  await page.getByRole("button", { name: "提交详情" }).click();
  const detail = page.locator(".stage-prompt");
  await detail.waitFor({ state: "visible", timeout: 10000 });
  const detailText = await detail.innerText();
  assert.match(detailText, /米白色羊毛大衣挂在木质衣架上/, "提交详情要留着当时写的描述");
  assert.match(detailText, /参考图 1 张/);
  assert.match(detailText, /比例/);
  assert.match(detailText, /输出像素/);
  assert.equal(await detail.locator(".submission-ref img").count(), 1, "提交详情要显示参考图缩略图");

  // 「用这段重做」把描述放回输入框
  await detail.getByRole("button", { name: "用这段重做" }).click();
  assert.match(await promptBox.inputValue(), /米白色羊毛大衣挂在木质衣架上/);

  /* ── 4. 清空预览、自动切新图、人工改选后不抢画面 ────────────────────────── */

  await page.getByRole("button", { name: "清空预览" }).click();
  await page.locator(".simple-stage-empty").waitFor({ state: "visible", timeout: 10000 });
  assert.equal(await page.locator(".simple-stage-image").count(), 0, "清空预览只收起右侧展示，不该继续露出旧图");
  assert((await page.locator(".simple-result-card:not(.simple-result-card-pending)").count()) >= 1, "清空预览不能删除历史成片");

  // 清空状态不能只活在当前组件里：切去别的模块再回来仍应保持空白。
  await page.locator(".rail-nav button[aria-label='账户与积分']").click();
  await page.locator(".account-layout").waitFor({ state: "visible", timeout: 10000 });
  await page.locator(".rail-nav button[aria-label='自由创作']").click();
  await page.getByRole("button", { name: "简易", exact: true }).click();
  await page.locator(".simple-stage-empty").waitFor({ state: "visible", timeout: 10000 });
  assert.equal(await page.locator(".simple-stage-image").count(), 0, "跨模块返回后不能擅自恢复上一次图片");

  // 生成中先点历史图，再点回底部生成卡：应重新显示该任务，并在完成后自动切到新图。
  await page.route("**/api/generate", delayGeneration);
  await promptBox.fill("第二张自动展示的新图");
  await page.locator(".simple-submit button.btn-primary").click();
  await page.locator(".simple-stage-pending").waitFor({ state: "visible", timeout: 10000 });
  assert.equal(await page.locator(".simple-stage-image").count(), 0, "新任务开始后要用生成状态替换之前的预览");
  await page.locator(".simple-result-card:not(.simple-result-card-pending)").first().locator(".simple-result-thumb").click();
  await page.locator(".simple-stage-image").waitFor({ state: "visible", timeout: 10000 });
  const pendingThumb = page.locator(".simple-result-card-pending .simple-result-thumb-pending").first();
  await pendingThumb.click();
  await page.locator(".simple-stage-pending").waitFor({ state: "visible", timeout: 10000 });
  assert.equal(await pendingThumb.getAttribute("aria-pressed"), "true", "重新点击生成卡后要恢复为当前预览目标");
  await page.locator(".simple-stage-image img").waitFor({ state: "visible", timeout: 180000 });
  assert.equal(await page.locator(".simple-completion-notice").count(), 0, "重新选回生成卡后，完成时应自动展示而不是只弹提醒");
  assert.equal(
    await page.locator(".simple-result-card:not(.simple-result-card-pending)").first().locator(".simple-result-thumb").getAttribute("aria-pressed"),
    "true",
    "没有人工改选时，最新成片要自动成为右侧当前图",
  );
  await page.unroute("**/api/generate", delayGeneration);

  // 生成途中点了历史图：完成后保留手动选择，只弹出提示。
  await page.route("**/api/generate", delayGeneration);
  await promptBox.fill("第三张完成后只提醒的新图");
  await page.locator(".simple-submit button.btn-primary").click();
  await page.locator(".simple-stage-pending").waitFor({ state: "visible", timeout: 10000 });
  const historicalCards = page.locator(".simple-result-card:not(.simple-result-card-pending)");
  await historicalCards.last().locator(".simple-result-thumb").click();
  const manuallySelectedTitle = await page.locator(".simple-stage-meta strong").innerText();
  await page.locator(".simple-completion-notice").waitFor({ state: "visible", timeout: 180000 });
  assert.match(await page.locator(".simple-completion-notice").innerText(), /新图像已完成生成/);
  assert.equal(await page.locator(".simple-stage-meta strong").innerText(), manuallySelectedTitle, "新图完成时不能覆盖用户手动点开的历史图");
  await page.getByRole("button", { name: "查看新图" }).click();
  assert.equal(
    await page.locator(".simple-result-card:not(.simple-result-card-pending)").first().locator(".simple-result-thumb").getAttribute("aria-pressed"),
    "true",
    "用户点查看新图后才切到最新成片",
  );
  await page.unroute("**/api/generate", delayGeneration);

  /* ── 5. 提交当场失败要把刚才那份放回来 ──────────────────────────────────── */

  await page.route("**/api/generate", (route) =>
    route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ message: "图像引擎暂时不可用" }) }),
  );
  await promptBox.click();
  await promptBox.fill("会失败的一次提交");
  await page.locator(".simple-submit button.btn-primary").click();
  await page.waitForFunction(
    () => document.querySelector(".simple-card textarea")?.value === "会失败的一次提交",
    null,
    { timeout: 15000 },
  );
  assert.match(await page.locator(".simple-submit .prompt-status").innerText(), /失败/, "失败原因要显示在状态位上");
  await page.unroute("**/api/generate");

  console.log(JSON.stringify({ simpleSubmit: "passed" }, null, 2));
} finally {
  await browser?.close();
  app.kill("SIGTERM");
  await fs.rm(tmpDir, { recursive: true, force: true });
}
