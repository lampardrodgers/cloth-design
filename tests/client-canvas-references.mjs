// 画布参考图的两条新路：
// 1) 选中画框直接 ⌘/Ctrl + V 粘贴图片 —— 不用先点「+ 参考图」再上传；
// 2) 图上标注过之后，可以把「原图 + 标注」拍平成一张参考图挂到画框上（成片提示词里会交代标注不是画面内容）。
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

/**
 * 造一个剪贴板 paste 事件，跟截图工具粘过来的一模一样：一个 image/png 文件。
 * target 传选择器时事件从那个元素发出（模拟「光标在输入框里直接粘贴」），默认从 body 发出。
 */
async function pasteImage(page, { color = "#c0392b", target = "", text = "" } = {}) {
  return page.evaluate(
    async ({ fill, selector, plainText }) => {
      const canvas = document.createElement("canvas");
      // 附件有最小边长限制（256px），造图别造太小
      canvas.width = 512;
      canvas.height = 512;
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = fill;
      ctx.fillRect(0, 0, 512, 512);
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
      const transfer = new DataTransfer();
      transfer.items.add(new File([blob], "pasted.png", { type: "image/png" }));
      if (plainText) transfer.setData("text/plain", plainText);
      const node = selector ? document.querySelector(selector) : document.body;
      // dispatchEvent 返回 false = 有人调了 preventDefault，也就是浏览器不会再往输入框里插内容
      return node.dispatchEvent(new ClipboardEvent("paste", { clipboardData: transfer, bubbles: true, cancelable: true }));
    },
    { fill: color, selector: target, plainText: text },
  );
}

const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "clothdesign-canvas-references-"));
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
    AUTH_SECRET: "canvas-references-secret-12345678901234567890",
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

  await page.locator("input[autocomplete='name']").fill("Canvas References");
  await page.locator("#auth-email").fill("canvas-references@example.test");
  await page.locator("input[autocomplete='new-password']").fill("clothdesign123");
  await page.getByRole("button", { name: "创建账号" }).click();
  await page.getByText("ImageDesign AI").first().waitFor({ state: "visible", timeout: 15000 });

  await page.getByRole("button", { name: "画布", exact: true }).click();
  await page.locator(".tl-container").waitFor({ state: "visible", timeout: 60000 });
  await page.waitForTimeout(1200);

  /* ── 1. 选中画框，粘贴即参考图 ──────────────────────────────────────────── */

  await page.mouse.click(760, 620); // 点一下画布，让快捷键落到编辑器上
  await page.keyboard.press("a"); // AI 画框
  await page.locator(".canvas-frame-panel").waitFor({ state: "visible", timeout: 10000 });

  await pasteImage(page);
  await page.locator(".canvas-ref-card img").first().waitFor({ state: "visible", timeout: 10000 });
  assert.equal(await page.locator(".canvas-ref-card").count(), 1, "粘贴进来的图应该直接成为画框的引用图");
  assert.match(await page.locator(".canvas-frame-meta").innerText(), /1 张引用图/);

  // 光标停在画框描述框里粘贴，同样收成参考图（描述本身不受影响）
  const framePrompt = page.locator(".canvas-frame-panel textarea").first();
  await framePrompt.click();
  await framePrompt.type("换成雪地背景");
  await pasteImage(page, { color: "#0b7285", target: ".canvas-frame-panel textarea" });
  await page.waitForFunction(() => document.querySelectorAll(".canvas-ref-card").length === 2, null, { timeout: 10000 });
  assert.equal(await framePrompt.inputValue(), "换成雪地背景", "粘贴图片不该动到画框描述");

  /* ── 2. 标注过的图可以带标注一起当参考图 ────────────────────────────────── */

  await page.keyboard.press("Escape"); // 放开画框
  await page.keyboard.press("Shift+1"); // 缩放到全部内容，保证图在视口里
  await page.waitForTimeout(400);

  const imageBox = await page.locator(".tl-canvas img").first().boundingBox();
  assert.ok(imageBox, "画布上应该能找到刚粘进来的图");

  await page.keyboard.press("c"); // 标注工具
  await page.mouse.move(imageBox.x + imageBox.width * 0.25, imageBox.y + imageBox.height * 0.3);
  await page.mouse.down();
  await page.mouse.move(imageBox.x + imageBox.width * 0.75, imageBox.y + imageBox.height * 0.7, { steps: 8 });
  await page.mouse.up();
  await page.keyboard.type("袖口改短一点");
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);

  await page.keyboard.press("a"); // 再放一个画框
  await page.locator(".canvas-frame-panel").waitFor({ state: "visible", timeout: 10000 });
  await page.locator(".canvas-ref-add").click();
  const annotatedPick = page.locator(".canvas-picker-annotated").first();
  await annotatedPick.waitFor({ state: "visible", timeout: 10000 });
  assert.match(await annotatedPick.getAttribute("title"), /标注/);

  await annotatedPick.click();
  await page.locator(".canvas-ref-annotated").first().waitFor({ state: "visible", timeout: 15000 });
  // 标注图是「要改的那张原图」，默认按入画走
  assert.equal(await page.locator(".canvas-ref-card.canvas-ref-merge").count(), 1, "拍平的标注图应该默认按入画使用");

  /* ── 3. 画布上的图能直接送进简易模式的参考图 ────────────────────────────── */

  await page.keyboard.press("Escape");
  await page.keyboard.press("Shift+1");
  await page.waitForTimeout(400);
  // 逐张点画布上的图（点左上角：中间压着标注箭头，直接 click() 会被它截走），
  // 找到还带着实时标注的那张 —— 它应该同时给出「加到简易参考」和「带标注加到简易」。
  const sendButton = page.locator(".tlui-button.canvas-send-simple", { hasText: "加到简易参考" }).first();
  const annotatedButton = page.locator(".tlui-button.canvas-send-simple", { hasText: "带标注加到简易" });
  let annotatedOffered = false;
  for (const image of await page.locator(".tl-canvas img").all()) {
    const spot = await image.boundingBox();
    if (!spot) continue;
    await page.mouse.click(spot.x + spot.width * 0.12, spot.y + spot.height * 0.1);
    await sendButton.waitFor({ state: "visible", timeout: 10000 });
    if (await annotatedButton.count()) {
      annotatedOffered = true;
      break;
    }
  }
  assert.ok(annotatedOffered, "标注过的图要能连标注一起送进简易参考");
  await sendButton.click();
  await page.locator(".free-canvas-notice").waitFor({ state: "visible", timeout: 10000 });
  assert.match(await page.locator(".free-canvas-notice").innerText(), /已加到简易模式的参考图/);

  await page.getByRole("button", { name: "简易", exact: true }).click();
  await page.locator(".attachment-card").first().waitFor({ state: "visible", timeout: 10000 });
  assert.equal(await page.locator(".attachment-card").count(), 1, "画布上的图应该出现在简易模式的参考图里");
  await page.locator(".attachment-remove").first().click();

  /* ── 4. 创作台的参考素材也能粘贴 ────────────────────────────────────────── */

  await page.locator(".rail-nav button[aria-label='开始创作']").click();
  await page.locator(".reference-card").first().waitFor({ state: "visible", timeout: 10000 });
  const filledBefore = await page.locator(".reference-preview img").count();
  await pasteImage(page, { color: "#1f6feb" });
  await page.waitForTimeout(500);
  assert.equal(
    await page.locator(".reference-preview img").count(),
    filledBefore + 1,
    "粘贴的图应该填进第一个空的参考素材位",
  );

  /* ── 5. 光标停在描述框里，直接粘贴也要收 ────────────────────────────────── */

  // 创作台：焦点在提示词框里
  const studioPrompt = page.locator(".prompt-dock textarea").first();
  await studioPrompt.click();
  await studioPrompt.type("米白色羊毛大衣");
  const studioText = await studioPrompt.inputValue();
  const filledInBox = await page.locator(".reference-preview img").count();
  await pasteImage(page, { color: "#2f9e44", target: ".prompt-dock textarea" });
  await page.waitForTimeout(500);
  assert.equal(
    await page.locator(".reference-preview img").count(),
    filledInBox + 1,
    "光标在提示词框里粘贴，图也要进参考素材",
  );
  assert.equal(await studioPrompt.inputValue(), studioText, "粘贴图片不该动到已经写好的描述");

  // 简易模式：焦点在画面描述框里
  await page.locator(".rail-nav button[aria-label='自由创作']").click();
  await page.getByRole("button", { name: "简易", exact: true }).click();
  const simplePrompt = page.locator(".simple-card textarea").first();
  await simplePrompt.waitFor({ state: "visible", timeout: 10000 });
  await simplePrompt.click();
  await simplePrompt.type("挂在木质衣架上");
  const imageOnlyCancelled = await pasteImage(page, { color: "#e8590c", target: ".simple-card textarea" });
  await page.locator(".attachment-card").first().waitFor({ state: "visible", timeout: 10000 });
  assert.equal(imageOnlyCancelled, false, "纯图片剪贴板要拦下默认粘贴，别在描述框里留下东西");
  assert.equal(await page.locator(".attachment-card").count(), 1, "光标在画面描述里粘贴，图要进附件条");
  assert.equal(await simplePrompt.inputValue(), "挂在木质衣架上", "粘贴图片不该动到已经写好的描述");

  // 图文都有的剪贴板（从网页 / Excel 复制）：图收下，但不拦默认行为，文字该进输入框还是进输入框。
  // 合成事件不会真的触发浏览器插字，所以这里看 preventDefault 有没有被调用（dispatchEvent 的返回值）。
  const mixedNotCancelled = await pasteImage(page, {
    color: "#5f3dc4",
    target: ".simple-card textarea",
    text: "补一句：晨光侧打",
  });
  await page.waitForTimeout(800);
  assert.equal(await page.locator(".attachment-card").count(), 2, "图文混合的剪贴板，图也要收");
  assert.equal(mixedNotCancelled, true, "图文混合时不该拦默认粘贴，否则文字被吞掉");

  console.log(JSON.stringify({ canvasReferences: "passed" }, null, 2));
} finally {
  await browser?.close();
  app.kill("SIGTERM");
  await fs.rm(tmpDir, { recursive: true, force: true });
}
