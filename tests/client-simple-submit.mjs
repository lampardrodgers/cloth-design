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
  await page.locator(".simple-submit button.btn-primary").click();

  /* ── 1. 提交后左边立刻清空，可以接着写 ──────────────────────────────────── */

  await page.waitForFunction(() => document.querySelector(".simple-card textarea")?.value === "", null, { timeout: 10000 });
  assert.equal(await page.locator(".attachment-card").count(), 0, "提交后附件也要清空");
  assert.equal(await promptBox.isDisabled(), false, "提交后描述框不该被锁住");
  assert((await page.locator(".simple-pending-chip").count()) >= 1, "要显示还有几张在生成");
  assert.match(await page.locator(".simple-submit .prompt-status").innerText(), /可以接着写下一张/);
  assert.match(await page.locator(".simple-pending-chip").innerText(), /1 张生成中/);

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

  /* ── 4. 提交当场失败要把刚才那份放回来 ──────────────────────────────────── */

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
