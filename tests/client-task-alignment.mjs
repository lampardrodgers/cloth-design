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

  await page.locator(".result-card").first().getByRole("button", { name: "WebDAV" }).click();
  await page.waitForFunction(() => document.querySelector(".result-card")?.textContent?.includes("webdav"));
  const storageAlignment = await page.evaluate(async () => {
    const localResults = JSON.parse(window.localStorage.getItem("clothdesign:results") || "[]");
    const me = await fetch("/api/me", { credentials: "include" }).then((response) => response.json());
    return {
      localStorageStatus: localResults[0]?.storageStatus,
      serverStorageStatus: me.generationResults?.[0]?.storageStatus,
    };
  });
  assert.equal(storageAlignment.localStorageStatus, "webdav");
  assert.equal(storageAlignment.serverStorageStatus, "webdav");

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
