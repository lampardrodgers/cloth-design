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

async function clickAndWait(page, locator) {
  await locator.click();
  await page.waitForLoadState("networkidle").catch(() => undefined);
}

const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "clothdesign-task-alignment-"));
const port = 19200 + Math.floor(Math.random() * 500);
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
    AUTH_SECRET: "task-alignment-secret-12345678901234567890",
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
  const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
  await page.goto(baseUrl, { waitUntil: "networkidle" });

  await page.locator("input[autocomplete='name']").fill("Task Alignment Owner");
  await page.locator("#auth-email").fill("task-alignment@example.test");
  await page.locator("input[autocomplete='new-password']").fill("clothdesign123");
  await page.getByRole("button", { name: "创建账号" }).click();
  await page.getByText("ClothDesign AI").waitFor({ state: "visible", timeout: 10000 });

  await clickAndWait(page, page.locator(".rail button[title='账户']"));
  await page.locator(".package-card").filter({ hasText: "试用包" }).getByRole("button", { name: /支付宝/ }).click();
  await page.getByRole("heading", { name: "扫码支付" }).waitFor({ state: "visible", timeout: 10000 });
  await page.getByRole("button", { name: "模拟支付成功" }).click();
  await page.waitForFunction(() => {
    const metric = [...document.querySelectorAll(".metric")].find((item) => item.textContent?.includes("余额"));
    return Number(metric?.querySelector("strong")?.textContent?.replace(/\D/g, "") || 0) > 0;
  });

  await clickAndWait(page, page.locator(".rail button[title='生成']"));
  await page.locator("textarea").fill("生成一张可用于任务追踪验收的女装商品图。");
  await page.locator(".prompt-footer").getByRole("button", { name: "生成" }).click();
  await page.locator(".result-card").first().waitFor({ state: "visible", timeout: 120000 });

  const alignment = await page.evaluate(async () => {
    const localResults = JSON.parse(window.localStorage.getItem("clothdesign:results") || "[]");
    const me = await fetch("/api/me", { credentials: "include" }).then((response) => response.json());
    return {
      localTaskId: localResults[0]?.taskId,
      serverTaskId: me.generationResults?.[0]?.taskId,
      localResultId: localResults[0]?.id,
      serverResultId: me.generationResults?.[0]?.id,
    };
  });

  assert.equal(alignment.localTaskId, alignment.serverTaskId);
  assert.equal(alignment.localResultId, alignment.serverResultId);

  // 成片一出来两边都是「服务器暂存」；没配云盘时点「推到云盘」要明确报错，状态不动
  const storageAlignment = await page.evaluate(async () => {
    const localResults = JSON.parse(window.localStorage.getItem("clothdesign:results") || "[]");
    const me = await fetch("/api/me", { credentials: "include" }).then((response) => response.json());
    return {
      localStorageStatus: localResults[0]?.storageStatus,
      serverStorageStatus: me.generationResults?.[0]?.storageStatus,
      serverExpiresAt: me.generationResults?.[0]?.expiresAt,
    };
  });
  assert.equal(storageAlignment.localStorageStatus, "cloud-temp");
  assert.equal(storageAlignment.serverStorageStatus, "cloud-temp");
  assert(typeof storageAlignment.serverExpiresAt === "string", "服务端成片要带 3 天到期时间");
  await page.locator(".result-card").first().getByRole("button", { name: "WebDAV" }).click();
  await page.locator(".global-notice").waitFor({ state: "visible", timeout: 10000 });
  assert((await page.locator(".global-notice").textContent()).includes("还没有启用 WebDAV"), "没配云盘时要提示先去文件管理配置");
  await page.locator(".global-notice button").click();

  // 文件管理页：3 天说明、文件列表、WebDAV 表单（错地址要明确报错）、本地文件夹段
  await clickAndWait(page, page.locator(".rail button[title='存储']"));
  await page.locator(".storage-webdav").waitFor({ state: "visible", timeout: 10000 });
  assert((await page.getByText(/固定保留 3 天/).count()) > 0, "文件管理要写明服务器固定保留 3 天");
  await page.locator(".storage-table tbody tr").first().waitFor({ state: "visible", timeout: 10000 });
  assert((await page.locator(".storage-table tbody tr").count()) >= 1, "文件列表要列出刚生成的成片");
  assert((await page.locator(".storage-table tbody tr").first().textContent()).includes("剩 2 天"), "文件列表要显示服务器剩余时间");
  assert((await page.getByText("本地文件夹").count()) > 0, "要有本地文件夹一段");
  await page.locator(".storage-webdav-url input").fill("not a url");
  await page.locator(".storage-webdav input[autocomplete='off']").nth(1).fill("someone");
  await page.locator(".storage-webdav input[type='password']").fill("secret");
  await page.getByRole("button", { name: "测试连接" }).click();
  await page.locator(".storage-notice-error").waitFor({ state: "visible", timeout: 10000 });
  assert((await page.locator(".storage-notice-error").textContent()).includes("合法"), "WebDAV 地址不合法要有明确提示");
  await clickAndWait(page, page.locator(".rail button[title='生成']"));

  const generatedImageUrl = await page.evaluate(() => JSON.parse(window.localStorage.getItem("clothdesign:results") || "[]")[0]?.imageUrl);
  await page.locator(".result-card").first().getByRole("button", { name: "加入参考" }).click();
  await page.waitForFunction(
    (imageUrl) => [...document.querySelectorAll(".reference-card img")].some((item) => item.getAttribute("src") === imageUrl),
    generatedImageUrl,
  );
  await page.locator(".result-card").first().getByRole("button", { name: "删除" }).click();
  await page.waitForFunction(
    (imageUrl) => ![...document.querySelectorAll(".reference-card img")].some((item) => item.getAttribute("src") === imageUrl),
    generatedImageUrl,
  );
  const tasksAfterDelete = await page.evaluate(() => JSON.parse(window.localStorage.getItem("clothdesign:tasks") || "[]"));
  assert.equal(tasksAfterDelete.some((task) => task.id === alignment.serverTaskId), false);
} finally {
  if (browser) await browser.close();
  app.kill("SIGTERM");
  await new Promise((resolve) => setTimeout(resolve, 250));
  await fs.rm(tmpDir, { recursive: true, force: true });
}

console.log(JSON.stringify({ checks: "passed" }, null, 2));
