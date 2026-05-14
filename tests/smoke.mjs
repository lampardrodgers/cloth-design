import { chromium } from "playwright";
import fs from "node:fs/promises";

const targetUrl = process.env.APP_URL ?? "http://127.0.0.1:8888/";
const desktopShot = "/tmp/clothdesign-desktop.png";
const generatedShot = "/tmp/clothdesign-generated.png";
const mobileShot = "/tmp/clothdesign-mobile.png";
const uploadRef = "/tmp/clothdesign-ref-a.png";

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function textOf(locator) {
  return (await locator.textContent())?.trim() ?? "";
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const consoleIssues = [];

page.on("console", (message) => {
  if (["error", "warning"].includes(message.type())) {
    consoleIssues.push(`${message.type()}: ${message.text()}`);
  }
});

await page.goto(targetUrl, { waitUntil: "networkidle" });

assert((await page.title()) === "ClothDesign AI", "page title mismatch");
assert(await page.getByText("ClothDesign AI").isVisible(), "app shell did not render");
assert(await page.getByText("演示模式").isVisible(), "API mode indicator missing");
assert(await page.getByRole("heading", { name: "参考图" }).isVisible(), "reference panel missing");
assert(await page.getByRole("heading", { name: "提示词" }).isVisible(), "prompt panel missing");
assert((await page.getByText("系统提示词").count()) === 0, "system prompt should not be visible in customer UI");

await page.screenshot({ path: desktopShot, fullPage: false });

await fs.writeFile(
  uploadRef,
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=",
    "base64",
  ),
);
await page.locator(".reference-preview input[type='file']").first().setInputFiles(uploadRef);
assert(await page.locator(".reference-preview img").first().isVisible(), "reference upload preview missing");

assert(await page.locator(".mode-pill.active").filter({ hasText: "文生图" }).isVisible(), "default text-to-image mode missing");
await page.locator("textarea").fill("生成一张春季女装风衣广告图，干净棚拍，面料细节真实。");
await page.locator(".prompt-footer").getByRole("button", { name: "生成" }).click();
await page.locator(".result-card").first().waitFor({ state: "visible", timeout: 120000 });

assert((await page.locator(".result-card").count()) === 1, "gallery should show one primary result card");
assert((await page.locator(".result-thumb").count()) === 2, "generation did not create two result thumbnails");
await page.getByRole("button", { name: /任务/ }).click();
assert((await page.locator(".task-success").count()) > 0, "successful task status missing");
assert((await page.locator(".task-preview img").count()) > 0, "task thumbnails missing");
await page.keyboard.press("Escape").catch(() => {});
await page.getByRole("button", { name: /任务/ }).click();

await page.locator(".result-card").first().getByRole("button", { name: "继续" }).click();
assert((await page.locator(".reference-card").count()) >= 4, "continue action did not add output as reference");

await page.locator(".result-card").first().getByRole("button", { name: "WebDAV" }).click();
assert((await textOf(page.locator(".result-card").first())).includes("webdav"), "WebDAV sync state not shown");
await page.screenshot({ path: generatedShot, fullPage: false });

await page.locator(".field select").first().selectOption("fourK");
const disabledRatios = await page.locator(".ratio-option:disabled").count();
assert(disabledRatios > 0, "4K ratio constraints did not disable unsupported ratios");

await page.locator(".rail button[title='账户']").click();
const beforeCredit = Number((await textOf(page.locator(".metric").filter({ hasText: "余额" }).locator("strong"))).replace(/\D/g, ""));
await page.locator(".package-card").filter({ hasText: "试用包" }).getByRole("button").click();
const afterCredit = Number((await textOf(page.locator(".metric").filter({ hasText: "余额" }).locator("strong"))).replace(/\D/g, ""));
assert(afterCredit > beforeCredit, "recharge did not increase credits");
assert((await page.getByRole("heading", { name: "用户管理" }).count()) === 0, "customer account page should not expose user management");

await page.goto(new URL("/admin", targetUrl).toString(), { waitUntil: "networkidle" });
assert((await page.locator("input[value='gpt-image-2']").count()) > 0, "admin model mapping missing gpt-image-2");
assert((await page.getByText("Supabase Auth").count()) > 0, "account system recommendation missing");
const adminInputs = page.locator(".route-table .admin-input");
assert((await adminInputs.count()) > 0, "admin model inputs missing");
await adminInputs.nth(2).fill("gpt-image-2-commercial-test");
await page.reload({ waitUntil: "networkidle" });
assert((await page.locator("input[value='gpt-image-2-commercial-test']").count()) > 0, "admin model config did not persist");
assert(await page.getByRole("heading", { name: "系统提示词模板" }).isVisible(), "admin prompt templates missing");

assert((await page.getByText("WebDAV").count()) > 0, "storage WebDAV panel missing");
assert((await page.getByText("存储策略").count()) > 0, "storage lifecycle settings missing");

assert(consoleIssues.length === 0, `console issues found:\n${consoleIssues.join("\n")}`);

await page.setViewportSize({ width: 390, height: 844 });
await page.goto(targetUrl, { waitUntil: "networkidle" });
await page.screenshot({ path: mobileShot, fullPage: false });
const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
assert(overflow <= 2, `mobile viewport has horizontal overflow: ${overflow}`);

await browser.close();

console.log(JSON.stringify({ targetUrl, desktopShot, generatedShot, mobileShot, checks: "passed" }, null, 2));
