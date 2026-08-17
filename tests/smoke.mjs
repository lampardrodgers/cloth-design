import { chromium } from "playwright";
import fs from "node:fs/promises";
import sharp from "sharp";

const targetUrl = process.env.APP_URL ?? "http://127.0.0.1:8888/";
const desktopShot = "/tmp/clothdesign-desktop.png";
const generatedShot = "/tmp/clothdesign-generated.png";
const mobileShot = "/tmp/clothdesign-mobile.png";
const uploadRef = "/tmp/clothdesign-ref-a.png";
const workflowFabricUpload = "/tmp/clothdesign-workflow-fabric.png";
const workflowSketchUpload = "/tmp/clothdesign-workflow-sketch.png";
const workflowGarmentUpload = "/tmp/clothdesign-workflow-garment.png";
const workflowPostprocessA = "/tmp/clothdesign-workflow-post-a.png";
const workflowPostprocessB = "/tmp/clothdesign-workflow-post-b.png";
const imageWaitMs = 300000;
const workflowWaitMs = 300000;

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function textOf(locator) {
  return (await locator.textContent())?.trim() ?? "";
}

async function waitForResultThumbnailsOrTaskFailure(previous, expectedIncrease) {
  const handle = await page.waitForFunction(
    ({ previousCount, increase }) => {
      if (document.querySelectorAll(".result-thumb").length >= previousCount + increase) return { status: "success" };
      try {
        const latestTask = JSON.parse(window.localStorage.getItem("clothdesign:tasks") || "[]")?.[0];
        if (latestTask?.status === "failed") return { status: "failed", message: latestTask.message || "生成失败" };
      } catch {
        return false;
      }
      return false;
    },
    { previousCount: previous, increase: expectedIncrease },
    { timeout: imageWaitMs },
  );
  const outcome = await handle.jsonValue();
  if (outcome?.status === "failed") {
    throw new Error(`generation task failed: ${outcome.message}`);
  }
}

async function writeSvgPng(filePath, svg) {
  await sharp(Buffer.from(svg)).png().toFile(filePath);
}

async function workflowMetricValue(label) {
  return page.locator(".workflow-summary").evaluate((summary, targetLabel) => {
    const metric = [...summary.querySelectorAll(".metric")].find((item) => item.querySelector("span")?.textContent?.trim() === targetLabel);
    return metric?.querySelector("strong")?.textContent?.trim() ?? "";
  }, label);
}

async function readinessMetricValue(label) {
  return page.locator(".readiness-metrics").evaluate((summary, targetLabel) => {
    const metric = [...summary.querySelectorAll(".metric")].find((item) => item.querySelector("span")?.textContent?.trim() === targetLabel);
    return metric?.querySelector("strong")?.textContent?.trim() ?? "";
  }, label);
}

async function getWorkflowTaskCount() {
  return Number((await workflowMetricValue("任务")).replace(/\D/g, ""));
}

async function waitForWorkflowTaskIncrement(previous) {
  await page.waitForFunction(
    (expectedPrevious) => {
      const summary = document.querySelector(".workflow-summary");
      const metric = [...(summary?.querySelectorAll(".metric") || [])].find((item) => item.querySelector("span")?.textContent?.trim() === "任务");
      const value = Number(metric?.querySelector("strong")?.textContent?.replace(/\D/g, "") || 0);
      return value >= expectedPrevious + 1;
    },
    previous,
    { timeout: workflowWaitMs },
  );
}

async function clickWorkflowAndWait(buttonName, resultText) {
  const before = await getWorkflowTaskCount();
  await page.getByRole("button", { name: buttonName }).click();
  await waitForWorkflowTaskIncrement(before);
  await page.locator(".workflow-result-card").filter({ hasText: resultText }).first().waitFor({ state: "visible", timeout: workflowWaitMs });
}

async function fetchWorkflowDashboard() {
  const response = await page.request.get(new URL("/api/workflows/dashboard", targetUrl).toString());
  assert(response.ok(), "workflow dashboard request failed");
  return response.json();
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const consoleIssues = [];

page.on("console", (message) => {
  if (["error", "warning"].includes(message.type())) {
    const text = message.text();
    if (text.includes("status of 401") || text.includes("status of 422")) return;
    consoleIssues.push(`${message.type()}: ${text}`);
  }
});

await page.goto(targetUrl, { waitUntil: "networkidle" });
const apiConfigResponse = await page.request.get(new URL("/api/config", targetUrl).toString());
assert(apiConfigResponse.ok(), "API config request failed");
const apiConfig = await apiConfigResponse.json();
const providerLabel = apiConfig.providerHealth?.label ?? (apiConfig.mode === "live" ? "图像引擎就绪" : "演示模式");

async function ensureAuthenticated() {
  if ((await page.getByText("账号登录").count()) === 0) return;
  await page.locator("input[autocomplete='name']").fill("Smoke Owner");
  await page.locator("#auth-email").fill("owner@example.test");
  await page.locator("input[autocomplete='new-password']").fill("clothdesign123");
  await page.getByRole("button", { name: "创建账号" }).click();
  await page.waitForTimeout(800);
  if ((await page.getByText("账号登录").count()) > 0) {
    await page.getByRole("button", { name: "登录" }).click();
    await page.locator("#auth-email").fill("owner@example.test");
    await page.locator("input[autocomplete='current-password']").fill("clothdesign123");
    await page.getByRole("button", { name: "登录" }).last().click();
  }
  await page.getByText("ClothDesign AI").waitFor({ state: "visible", timeout: 10000 });
}

await ensureAuthenticated();

assert((await page.title()) === "ClothDesign AI", "page title mismatch");
assert(await page.getByText("ClothDesign AI").isVisible(), "app shell did not render");
await page.getByText(providerLabel).waitFor({ state: "visible", timeout: 10000 });
assert(await page.getByRole("heading", { name: "参考图" }).isVisible(), "reference panel missing");
assert(await page.getByRole("heading", { name: "提示词" }).isVisible(), "prompt panel missing");
assert((await page.getByText("系统提示词").count()) === 0, "system prompt should not be visible in customer UI");

await page.screenshot({ path: desktopShot, fullPage: false });

await page.locator(".rail button[title='账户']").click();
const beforeCredit = Number((await textOf(page.locator(".metric").filter({ hasText: "余额" }).locator("strong"))).replace(/\D/g, ""));
await page.locator(".package-card").filter({ hasText: "试用包" }).getByRole("button", { name: /支付宝/ }).click();
await page.getByRole("heading", { name: "扫码支付" }).waitFor({ state: "visible", timeout: 10000 });
assert((await page.locator(".payment-order-card img").count()) > 0, "payment QR code missing");
const demoCompleteButton = page.getByRole("button", { name: "模拟支付成功" });
if ((await demoCompleteButton.count()) > 0) {
  await demoCompleteButton.click();
  await page.waitForFunction(
    (previous) => {
      const metric = [...document.querySelectorAll(".metric")].find((item) => item.textContent?.includes("余额"));
      const value = Number(metric?.querySelector("strong")?.textContent?.replace(/\D/g, "") || 0);
      return value > previous;
    },
    beforeCredit,
  );
  const afterCredit = Number((await textOf(page.locator(".metric").filter({ hasText: "余额" }).locator("strong"))).replace(/\D/g, ""));
  assert(afterCredit > beforeCredit, "recharge did not increase credits");
} else {
  assert(beforeCredit > 0, "demo payment completion unavailable and account has no credits for live smoke");
}
assert((await page.getByRole("heading", { name: "用户管理" }).count()) === 0, "customer account page should not expose user management");

await page.locator(".rail button[title='生成']").click();

await writeSvgPng(
  uploadRef,
  `
    <svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
      <rect width="512" height="512" fill="#79936f"/>
      <path d="M0 96 C96 40 160 152 256 96 S416 40 512 96" fill="none" stroke="#eef0dc" stroke-width="18" opacity="0.9"/>
      <path d="M0 224 C96 168 160 280 256 224 S416 168 512 224" fill="none" stroke="#385844" stroke-width="16" opacity="0.65"/>
      <path d="M0 352 C96 296 160 408 256 352 S416 296 512 352" fill="none" stroke="#d6a35c" stroke-width="14" opacity="0.8"/>
      <g opacity="0.28" stroke="#f7efe0" stroke-width="4">
        <path d="M64 0 V512"/>
        <path d="M160 0 V512"/>
        <path d="M256 0 V512"/>
        <path d="M352 0 V512"/>
        <path d="M448 0 V512"/>
      </g>
    </svg>
  `,
);
await writeSvgPng(
  workflowFabricUpload,
  `
    <svg xmlns="http://www.w3.org/2000/svg" width="768" height="768" viewBox="0 0 768 768">
      <rect width="768" height="768" fill="#f7f1e4"/>
      <rect width="768" height="768" fill="#8aa37a" opacity="0.82"/>
      <g fill="#f8d7bd" opacity="0.9">
        <circle cx="124" cy="126" r="22"/><circle cx="274" cy="126" r="22"/><circle cx="424" cy="126" r="22"/><circle cx="574" cy="126" r="22"/>
        <circle cx="198" cy="246" r="22"/><circle cx="348" cy="246" r="22"/><circle cx="498" cy="246" r="22"/><circle cx="648" cy="246" r="22"/>
        <circle cx="124" cy="366" r="22"/><circle cx="274" cy="366" r="22"/><circle cx="424" cy="366" r="22"/><circle cx="574" cy="366" r="22"/>
        <circle cx="198" cy="486" r="22"/><circle cx="348" cy="486" r="22"/><circle cx="498" cy="486" r="22"/><circle cx="648" cy="486" r="22"/>
        <circle cx="124" cy="606" r="22"/><circle cx="274" cy="606" r="22"/><circle cx="424" cy="606" r="22"/><circle cx="574" cy="606" r="22"/>
      </g>
      <g stroke="#425a48" stroke-width="6" opacity="0.36">
        <path d="M0 96 H768"/><path d="M0 192 H768"/><path d="M0 288 H768"/><path d="M0 384 H768"/><path d="M0 480 H768"/><path d="M0 576 H768"/><path d="M0 672 H768"/>
        <path d="M96 0 V768"/><path d="M192 0 V768"/><path d="M288 0 V768"/><path d="M384 0 V768"/><path d="M480 0 V768"/><path d="M576 0 V768"/><path d="M672 0 V768"/>
      </g>
    </svg>
  `,
);
await writeSvgPng(
  workflowSketchUpload,
  `
    <svg xmlns="http://www.w3.org/2000/svg" width="768" height="768" viewBox="0 0 768 768">
      <rect width="768" height="768" fill="#fbfaf4"/>
      <path d="M290 150 H478 L542 666 Q384 712 226 666 L290 150 Z" fill="none" stroke="#22251f" stroke-width="16" stroke-linejoin="round"/>
      <path d="M290 150 L214 272 M478 150 L554 272 M340 150 Q384 220 428 150" fill="none" stroke="#22251f" stroke-width="14" stroke-linecap="round"/>
      <path d="M268 486 Q384 522 500 486" fill="none" stroke="#79936f" stroke-width="12" stroke-linecap="round"/>
    </svg>
  `,
);
await writeSvgPng(
  workflowGarmentUpload,
  `
    <svg xmlns="http://www.w3.org/2000/svg" width="768" height="1024" viewBox="0 0 768 1024">
      <rect width="768" height="1024" fill="#e9e4da"/>
      <rect x="342" y="110" width="84" height="760" rx="42" fill="#c3b7a2"/>
      <path d="M262 192 H506 L592 848 H176 L262 192 Z" fill="#4f5d55"/>
      <path d="M262 192 L174 356 L238 402 M506 192 L594 356 L530 402" fill="none" stroke="#4f5d55" stroke-width="54" stroke-linecap="round"/>
      <path d="M384 204 V834" stroke="#f3e7ce" stroke-width="12"/>
      <path d="M320 192 Q384 272 448 192" fill="none" stroke="#f3e7ce" stroke-width="16"/>
    </svg>
  `,
);
await writeSvgPng(
  workflowPostprocessA,
  `
    <svg xmlns="http://www.w3.org/2000/svg" width="768" height="1024" viewBox="0 0 768 1024">
      <rect width="768" height="1024" fill="#cfc8bd"/>
      <circle cx="384" cy="184" r="54" fill="#bd8d72"/>
      <path d="M278 292 H490 L570 834 Q384 900 198 834 L278 292 Z" fill="#8aa37a"/>
      <path d="M278 292 L198 410 M490 292 L570 410" stroke="#8aa37a" stroke-width="54" stroke-linecap="round"/>
    </svg>
  `,
);
await writeSvgPng(
  workflowPostprocessB,
  `
    <svg xmlns="http://www.w3.org/2000/svg" width="768" height="1024" viewBox="0 0 768 1024">
      <rect width="768" height="1024" fill="#bbb9af"/>
      <circle cx="384" cy="172" r="50" fill="#9e6f59"/>
      <path d="M242 280 H526 L616 842 Q384 914 152 842 L242 280 Z" fill="#efe6d0"/>
      <path d="M242 280 L162 430 M526 280 L606 430" stroke="#efe6d0" stroke-width="58" stroke-linecap="round"/>
      <path d="M310 314 H458" stroke="#6e6759" stroke-width="14"/>
    </svg>
  `,
);
await page.locator(".reference-preview input[type='file']").first().setInputFiles(uploadRef);
assert(await page.locator(".reference-preview img").first().isVisible(), "reference upload preview missing");

assert(await page.locator(".mode-pill.active").filter({ hasText: "文生图" }).isVisible(), "default text-to-image mode missing");
await page.locator(".field input[type='number']").first().fill("2");
await page.locator("textarea").fill("生成一张春季女装风衣广告图，干净棚拍，面料细节真实。");
const thumbnailsBeforeGenerate = await page.locator(".result-thumb").count();
await page.locator(".prompt-footer").getByRole("button", { name: "生成" }).click();
await waitForResultThumbnailsOrTaskFailure(thumbnailsBeforeGenerate, 2);

assert((await page.locator(".result-card").count()) === 1, "gallery should show one primary result card");
assert((await page.locator(".result-thumb").count()) >= thumbnailsBeforeGenerate + 2, "generation did not create two result thumbnails");
await page.getByRole("button", { name: /任务/ }).click();
assert((await page.locator(".task-success").count()) > 0, "successful task status missing");
assert((await page.locator(".task-preview img").count()) > 0, "task thumbnails missing");
await page.keyboard.press("Escape").catch(() => {});
await page.getByRole("button", { name: /任务/ }).click();

await page.locator(".result-card").first().getByRole("button", { name: "继续" }).click();
assert((await page.locator(".reference-card").count()) >= 4, "continue action did not add output as reference");

await page.locator(".result-card").first().getByRole("button", { name: "WebDAV" }).click();
await page.waitForFunction(() => document.querySelector(".result-card")?.textContent?.includes("webdav"));
assert((await textOf(page.locator(".result-card").first())).includes("webdav"), "WebDAV sync state not shown");
await page.screenshot({ path: generatedShot, fullPage: false });

await page.locator(".field select").first().selectOption("fourK");
const disabledRatios = await page.locator(".ratio-option:disabled").count();
assert(disabledRatios > 0, "4K ratio constraints did not disable unsupported ratios");

await page.goto(new URL("/admin", targetUrl).toString(), { waitUntil: "networkidle" });
assert((await page.locator("input[value='gpt-image-2']").count()) > 0, "admin model mapping missing gpt-image-2");
assert((await page.getByText("Better Auth").count()) > 0, "account system recommendation missing");
assert((await page.getByRole("heading", { name: "支付配置" }).count()) > 0, "admin payment config missing");
assert((await page.getByRole("heading", { name: "支付订单" }).count()) > 0, "admin payment orders missing");
assert((await page.getByRole("heading", { name: "支付事件" }).count()) > 0, "admin payment events missing");
const adminInputs = page.locator(".route-table .admin-input");
assert((await adminInputs.count()) > 0, "admin model inputs missing");
await adminInputs.nth(2).fill("gpt-image-2-commercial-test");
await page.reload({ waitUntil: "networkidle" });
assert((await page.locator("input[value='gpt-image-2-commercial-test']").count()) > 0, "admin model config did not persist");
assert(await page.getByRole("heading", { name: "系统提示词模板" }).isVisible(), "admin prompt templates missing");

assert((await page.getByText("WebDAV").count()) > 0, "storage WebDAV panel missing");
assert((await page.getByText("存储策略").count()) > 0, "storage lifecycle settings missing");

await page.goto(targetUrl, { waitUntil: "networkidle" });
await page.locator(".rail button[title='功能']").click();
assert(await page.getByRole("heading", { name: "AI功能中心" }).isVisible(), "advanced feature center missing");
assert(await page.getByText("原版生成工作台已保留").isVisible(), "original studio preservation notice missing");
assert(await page.getByRole("heading", { name: "生产验收" }).isVisible(), "production readiness summary missing");
const readinessLabel = apiConfig.mode === "live" ? providerLabel : "当前会话仅演示";
await page.getByText(readinessLabel).waitFor({ state: "visible", timeout: 10000 });
if (apiConfig.providerHealth?.blocking) {
  assert((await readinessMetricValue("阻断项")).replace(/\D/g, "") === "1", "provider quota/error should be shown as the base image blocker");
} else {
  assert((await readinessMetricValue("阻断项")).replace(/\D/g, "") === "0", "optional video/training services should not block base workflow readiness");
  assert((await page.locator(".readiness-blockers").count()) === 0, "optional external services should not be shown as blockers");
}
await page.locator(".workflow-summary[data-loaded='true']").waitFor({ state: "visible", timeout: 10000 });

const workflowTaskCountBefore = await getWorkflowTaskCount();
await page.getByLabel("款式描述").fill("廓形偏A字，颜色保留暖白和鼠尾草绿，适合度假系列。");
await page.getByLabel("服装品类").fill("skirt");
await page.getByLabel("面料图片").setInputFiles(workflowFabricUpload);
await page.getByLabel("设计草图").setInputFiles(workflowSketchUpload);
assert(await page.getByText("clothdesign-workflow-fabric.png").isVisible(), "fabric upload name missing");
assert(await page.getByText("clothdesign-workflow-sketch.png").isVisible(), "sketch upload name missing");
await page.getByLabel("面料图案").selectOption("stripe");
await page.getByLabel("领口").selectOption("v-neck");
await page.getByLabel("衣长").focus();
await page.keyboard.press("ArrowRight");
await page.getByLabel("袖长").focus();
await page.keyboard.press("ArrowLeft");
await page.getByLabel("款式变体数量").fill("3");
await page.getByRole("button", { name: "生成面料款式方案" }).evaluate((button) => {
  button.click();
  button.click();
});
await waitForWorkflowTaskIncrement(workflowTaskCountBefore);
await page.locator(".workflow-result-card").filter({ hasText: "款式变体" }).first().waitFor({ state: "visible", timeout: 30000 });
const workflowTaskCount = await getWorkflowTaskCount();
assert(workflowTaskCount === workflowTaskCountBefore + 1, `double click should create one workflow task, got ${workflowTaskCount - workflowTaskCountBefore}`);
assert((await page.locator(".workflow-result-card").filter({ hasText: "款式变体" }).count()) >= 3, "fabric style variants missing");
const fabricEvidenceLabel = apiConfig.mode === "live" ? /真实文生图|真实 image edit/ : "演示占位";
assert(
  await page.locator(".workflow-result-card").filter({ hasText: "款式变体" }).first().locator(".generation-evidence", { hasText: fabricEvidenceLabel }).isVisible(),
  "fabric result evidence missing",
);
assert(
  await page.locator(".workflow-result-card").filter({ hasText: "款式变体" }).first().locator(".evidence-badge", { hasText: fabricEvidenceLabel }).isVisible(),
  "fabric result evidence badge missing",
);
assert(await page.locator(".workflow-steps").getByText("面料解析", { exact: true }).isVisible(), "fabric analysis step missing");
const fabricDashboard = await fetchWorkflowDashboard();
const latestFabricJob = fabricDashboard.jobs.find((job) => job.type === "fabric-to-style");
assert(latestFabricJob.options.variants === 3, "fabric variant count control did not reach workflow payload");
assert(
  JSON.stringify(latestFabricJob.options.editControls) === JSON.stringify({ hemLength: "maxi", sleeveLength: "sleeveless", neckline: "v-neck", pattern: "stripe" }),
  "fabric edit controls did not reach workflow payload",
);
assert(latestFabricJob.prompt.includes("条纹") && latestFabricJob.prompt.includes("V领"), "fabric prompt should include selected pattern and neckline controls");
assert(latestFabricJob.prompt.includes("廓形偏A字") && latestFabricJob.prompt.includes("度假系列"), "fabric text description did not reach workflow payload");
assert(latestFabricJob.options.garmentCategory === "skirt", "fabric garment category did not reach workflow payload");
assert(
  JSON.stringify(latestFabricJob.options.inputSummary?.assetNames) === JSON.stringify(["clothdesign-workflow-fabric.png", "clothdesign-workflow-sketch.png"]),
  "fabric uploaded assets did not reach workflow payload",
);

await page.getByRole("button", { name: "虚拟模特" }).click();
await page.getByLabel("来源类型").selectOption("mannequin");
await page.getByLabel("虚拟模特来源图").setInputFiles(workflowGarmentUpload);
await page.getByLabel("服装说明").fill("男装夹克人台图，保留硬挺肩线和拉链细节。");
await page.getByLabel("虚拟模特", { exact: true }).selectOption("plus-global-01");
await page.getByLabel("展示场景").selectOption("city");
await page.getByLabel("模特姿势").selectOption("turnaround");
await clickWorkflowAndWait("生成上身展示", "虚拟模特上身图");
assert(await page.getByText("真实 MP4 视频 · 可选增强").isVisible(), "video generation should be labelled as optional enhancement");
assert((await page.locator(".model-library article").filter({ hasText: "儿童模特" }).count()) === 1, "commercial child model card missing");
assert((await page.locator(".model-library article").filter({ hasText: "大码模特" }).count()) === 1, "commercial plus-size model card missing");
assert((await page.getByLabel("虚拟模特", { exact: true }).locator("option[value='child-east-asian-01']").count()) === 1, "commercial child model option missing");
assert((await page.getByLabel("虚拟模特", { exact: true }).locator("option[value='plus-global-01']").count()) === 1, "commercial plus-size model option missing");
const virtualDashboard = await fetchWorkflowDashboard();
const latestVirtualJob = virtualDashboard.jobs.find((job) => job.type === "virtual-model-showcase");
assert(latestVirtualJob?.status === "success", "latest virtual model job should succeed");
assert(latestVirtualJob.options.modelId === "plus-global-01", "virtual model selection did not reach workflow payload");
assert(latestVirtualJob.options.sceneId === "city", "scene selection did not reach workflow payload");
assert(latestVirtualJob.options.poseId === "turnaround", "pose selection did not reach workflow payload");
assert(latestVirtualJob.options.sourceType === "mannequin", "virtual source type did not reach workflow payload");
assert(latestVirtualJob.prompt.includes("大码模特") && latestVirtualJob.prompt.includes("城市街景") && latestVirtualJob.prompt.includes("转身"), "virtual prompt should include selected model, scene and pose");
assert(latestVirtualJob.prompt.includes("人台图") && latestVirtualJob.prompt.includes("硬挺肩线"), "virtual source description did not reach workflow payload");
assert(latestVirtualJob.assets.some((asset) => asset.kind === "mannequin" && asset.name === "clothdesign-workflow-garment.png"), "virtual uploaded source image missing");
assert(
  latestVirtualJob.results.some((result) => result.versionType === "try_on_image" && result.metadata?.liveGenerated === true && result.metadata?.qualityGate?.status === "passed"),
  "virtual try-on image should be live generated and pass quality gate",
);

await page.getByRole("button", { name: "后期处理" }).click();
await page.getByLabel("批量图片").setInputFiles([workflowPostprocessA, workflowPostprocessB]);
await page.locator(".postprocess-list label").filter({ hasText: "手部修复" }).locator("input").setChecked(false);
await page.locator(".postprocess-list label").filter({ hasText: "对象擦除" }).locator("input").setChecked(true);
await page.locator(".scene-list label").filter({ hasText: "城市" }).locator("input").setChecked(true);
await page.getByLabel("目标颜色").selectOption("sage");
await page.getByLabel("输出比例").selectOption("3:4");
await clickWorkflowAndWait("开始批量后期", "批量后期");
assert(await page.locator(".postprocess-list").getByText("智能抠图", { exact: true }).isVisible(), "cutout postprocess action missing");
assert(await page.locator(".postprocess-list").getByText("手部修复", { exact: true }).isVisible(), "repair postprocess action missing");
const postprocessDashboard = await fetchWorkflowDashboard();
const latestPostprocessJob = postprocessDashboard.jobs.find((job) => job.type === "postprocess-suite");
assert(latestPostprocessJob?.status === "success", "latest postprocess job should succeed");
assert(
  JSON.stringify(latestPostprocessJob.options.actions) === JSON.stringify(["cutout", "enhance", "erase", "recolor", "resize"]),
  "postprocess action controls did not reach workflow payload",
);
assert(latestPostprocessJob.options.targetColor === "sage", "postprocess target color did not reach workflow payload");
assert(latestPostprocessJob.options.targetRatio === "3:4", "postprocess target ratio did not reach workflow payload");
assert(
  JSON.stringify(latestPostprocessJob.options.targetScenes) === JSON.stringify(["studio", "city"]),
  "postprocess target scenes did not reach workflow payload",
);
assert(latestPostprocessJob.results.length === 4, "postprocess should create one result per uploaded image and scene");
assert(
  JSON.stringify(latestPostprocessJob.results.map((result) => result.metadata?.targetScene)) === JSON.stringify(["studio", "city", "studio", "city"]),
  "postprocess scene metadata mismatch",
);
assert(
  latestPostprocessJob.results.every((result) => result.metadata?.generationMode === "image_edit"),
  "postprocess should use image edit with real generated inputs",
);
assert(
  latestPostprocessJob.results.every((result) =>
    result.metadata?.assetInputNames?.some((name) => ["clothdesign-workflow-post-a.png", "clothdesign-workflow-post-b.png"].includes(name)),
  ),
  "postprocess should use uploaded batch images as inputs",
);
assert(
  latestPostprocessJob.results.every((result) => result.metadata?.qualityGate?.status === "passed" && result.metadata?.qualityGate?.checks?.includes("transparent_alpha")),
  "postprocess cutout results should pass quality gate with transparent alpha",
);
assert(
  latestPostprocessJob.results.every((result) => Number(result.metadata?.imageInspection?.alpha?.transparentPixels || 0) > 0),
  "postprocess cutout results should contain transparent pixels",
);

await page.getByRole("button", { name: "趋势品牌" }).click();
assert(await page.getByText("真实专属模型 · 可选增强").isVisible(), "brand training should be labelled as optional enhancement");

assert(consoleIssues.length === 0, `console issues found:\n${consoleIssues.join("\n")}`);

await page.setViewportSize({ width: 390, height: 844 });
await page.goto(targetUrl, { waitUntil: "networkidle" });
await page.screenshot({ path: mobileShot, fullPage: false });
const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
assert(overflow <= 2, `mobile viewport has horizontal overflow: ${overflow}`);

await browser.close();

console.log(JSON.stringify({ targetUrl, desktopShot, generatedShot, mobileShot, checks: "passed" }, null, 2));
