import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { deflateSync } from "node:zlib";

const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "clothdesign-workflows-"));
const workflowAssetDir = path.join(tmpDir, "generated-images");
const workflowVideoDir = path.join(tmpDir, "generated-videos");
process.env.DATABASE_URL = `file:${path.join(tmpDir, "test.db")}`;
process.env.IMAGE_ASSET_DIR = workflowAssetDir;
process.env.IMAGE_ASSET_PUBLIC_PATH = "/generated-images";
process.env.VIDEO_ASSET_DIR = workflowVideoDir;
process.env.VIDEO_ASSET_PUBLIC_PATH = "/generated-videos";
process.env.PAYMENT_DEMO_MODE = "true";
process.env.OPENAI_API_KEY = "sk-test-workflow-provider-key-0000000000";
process.env.OPENAI_BASE_URL = "https://www.packyapi.com";
process.env.OPENAI_IMAGE_MODEL = "gpt-image-2";
process.env.OPENAI_DEMO_MODE = "false";

const { migrateBusinessDatabase, nowIso, sqlite } = await import("../server/db.mjs");
const {
  WORKFLOW_DEFINITIONS,
  createWorkflowJob,
  getWorkflowDashboard,
  getWorkflowJob,
  listCommercialModels,
  listWorkflowAssets,
  markWorkflowJobFailed,
	materializeLiveImages,
	migrateWorkflowDatabase,
	workflowImageProviderStatus,
} = await import("../server/workflows.mjs");
const { classifyImageProviderHealth, latestImageProviderEvent } = await import("../server/provider-health.mjs");
const { createMotionPreviewMp4 } = await import("../server/video-provider.mjs");

migrateBusinessDatabase();
migrateWorkflowDatabase();

const userId = "u-workflow";
sqlite
  .prepare(
    `INSERT INTO user_profile
      (user_id, display_name, role, plan, credits, monthly_used, status, created_at, updated_at)
     VALUES (?, '工作流测试用户', 'owner', '测试版', 5000, 0, 'active', ?, ?)`,
  )
  .run(userId, nowIso(), nowIso());

assert.equal(WORKFLOW_DEFINITIONS.length, 4);
assert.deepEqual(
  WORKFLOW_DEFINITIONS.map((workflow) => workflow.id),
  ["fabric-to-style", "virtual-model-showcase", "postprocess-suite", "trend-brand-lab"],
);
assert(WORKFLOW_DEFINITIONS.find((workflow) => workflow.id === "fabric-to-style").inputTypes.includes("sketch"));
assert(WORKFLOW_DEFINITIONS.find((workflow) => workflow.id === "virtual-model-showcase").outputTypes.includes("motionStoryboard"));
assert(WORKFLOW_DEFINITIONS.find((workflow) => workflow.id === "postprocess-suite").capabilities.includes("batch"));
assert(WORKFLOW_DEFINITIONS.find((workflow) => workflow.id === "trend-brand-lab").capabilities.includes("brandTraining"));
const fabricVisionCapability = WORKFLOW_DEFINITIONS.find((workflow) => workflow.id === "fabric-to-style").capabilityStatus.find((capability) => capability.id === "vision.analyze");
assert.equal(fabricVisionCapability.status, "live");
assert(fabricVisionCapability.note.includes("面料图片"));
assert(fabricVisionCapability.note.includes("颜色"));
assert(fabricVisionCapability.note.includes("图案"));
assert(fabricVisionCapability.note.includes("纹理"));
const fabricStyleCapability = WORKFLOW_DEFINITIONS.find((workflow) => workflow.id === "fabric-to-style").capabilityStatus.find((capability) => capability.id === "style.recommend");
assert.equal(fabricStyleCapability.status, "live");
assert(fabricStyleCapability.note.includes("面料解析"));
assert(fabricStyleCapability.note.includes("推荐版型"));
assert.equal(
  WORKFLOW_DEFINITIONS.find((workflow) => workflow.id === "fabric-to-style").capabilityStatus.find((capability) => capability.id === "image.edit").status,
  "live",
);
const virtualModelCapability = WORKFLOW_DEFINITIONS.find((workflow) => workflow.id === "virtual-model-showcase").capabilityStatus.find((capability) => capability.id === "model.select");
assert.equal(virtualModelCapability.status, "live");
assert(virtualModelCapability.note.includes("人种"));
assert(virtualModelCapability.note.includes("儿童"));
assert(virtualModelCapability.note.includes("大码"));
assert.equal(
  WORKFLOW_DEFINITIONS.find((workflow) => workflow.id === "virtual-model-showcase").capabilityStatus.find((capability) => capability.id === "video.storyboard").status,
  "preview",
);
assert.equal(
  WORKFLOW_DEFINITIONS.find((workflow) => workflow.id === "virtual-model-showcase").capabilityStatus.find((capability) => capability.id === "video.previewMp4").status,
  "live",
);
assert.equal(
  WORKFLOW_DEFINITIONS.find((workflow) => workflow.id === "virtual-model-showcase").capabilityStatus.find((capability) => capability.id === "video.mp4").status,
  "requires_service",
);
assert.equal(
  WORKFLOW_DEFINITIONS.find((workflow) => workflow.id === "postprocess-suite").capabilityStatus.find((capability) => capability.id === "image.segment.precise").status,
  "requires_service",
);
const baseCutoutCapability = WORKFLOW_DEFINITIONS.find((workflow) => workflow.id === "postprocess-suite").capabilityStatus.find((capability) => capability.id === "image.segment");
assert.equal(baseCutoutCapability.status, "live");
assert(baseCutoutCapability.note.includes("透明 alpha"));
assert(baseCutoutCapability.note.includes("本地"));
for (const [capabilityId, expectedText] of [
  ["image.enhance", "补光"],
  ["image.inpaint", "手部"],
  ["image.recolor", "重色"],
  ["image.resize", "比例"],
]) {
  const capability = WORKFLOW_DEFINITIONS.find((workflow) => workflow.id === "postprocess-suite").capabilityStatus.find((item) => item.id === capabilityId);
  assert.equal(capability.status, "live");
  assert(capability.note.includes(expectedText));
}
assert.equal(
  WORKFLOW_DEFINITIONS.find((workflow) => workflow.id === "trend-brand-lab").capabilityStatus.find((capability) => capability.id === "brandTraining").status,
  "preview",
);
assert.deepEqual(workflowImageProviderStatus(), {
  mode: "live",
  providerReady: true,
  baseUrl: "https://www.packyapi.com/v1",
  model: "gpt-image-2",
});
assert.equal(
  classifyImageProviderHealth({
    mode: "live",
    providerReady: true,
    latest: {
      status: "failed",
      message: '{"error":{"type":"usage_limit_reached","resets_at":1782721841}}',
      updatedAt: "2026-06-28T09:56:00.000Z",
    },
  }).status,
  "usage_limited",
);

/* ── 接口健康度只看图像接口自己的失败 ─────────────────────────────────────── */
// 服务重启收口、积分扣费失败这类「我们自己的锅」也会写成 failed，
// 但不能让它把顶栏报成「图像接口不可用」——线上真误报过一次。
{
  const insertTask = sqlite.prepare(
    `INSERT INTO generation_task (id, user_id, mode, prompt, status, credits, message, failure_source, created_at, updated_at)
     VALUES (?, ?, 'free', '健康度测试', ?, 0, ?, ?, ?, ?)`,
  );
  insertTask.run("task-health-ok", userId, "success", "图像引擎已返回结果。", null, "2026-08-18T02:00:00.000Z", "2026-08-18T02:00:00.000Z");
  insertTask.run(
    "task-health-restart",
    userId,
    "failed",
    "服务重启时这条任务被中断，没有出图。",
    "system",
    "2026-08-18T01:00:00.000Z",
    "2026-08-18T03:00:00.000Z",
  );
  const afterRestart = latestImageProviderEvent();
  assert.equal(afterRestart.status, "success", "系统原因的失败不该被当成最近一次图像接口事件");
  assert.equal(
    classifyImageProviderHealth({ mode: "live", providerReady: true, latest: afterRestart }).blocking,
    false,
    "重启收口不该把图像接口报成不可用",
  );

  // 真正的接口失败仍然要报出来
  insertTask.run(
    "task-health-provider",
    userId,
    "failed",
    "图像引擎请求超时。",
    "provider",
    "2026-08-18T04:00:00.000Z",
    "2026-08-18T04:00:00.000Z",
  );
  const afterProviderFailure = latestImageProviderEvent();
  assert.equal(afterProviderFailure.status, "failed");
  assert.equal(
    classifyImageProviderHealth({ mode: "live", providerReady: true, latest: afterProviderFailure }).status,
    "timeout",
  );
  // 老库升级：failure_source 是后加的列，已经落库的重启收口记录要补上标记，
  // 否则升上去之后顶栏会一直挂着「图像接口异常」。
  sqlite.exec("ALTER TABLE generation_task DROP COLUMN failure_source");
  sqlite
    .prepare(
      `INSERT INTO generation_task (id, user_id, mode, prompt, status, credits, message, created_at, updated_at)
       VALUES ('task-health-legacy', ?, 'free', '升级前的记录', 'failed', 0, ?, ?, ?)`,
    )
    .run(userId, "服务重启时这条任务被中断，没有出图。", "2026-08-18T05:00:00.000Z", "2026-08-18T05:00:00.000Z");
  migrateBusinessDatabase();
  assert.equal(
    sqlite.prepare("SELECT failure_source FROM generation_task WHERE id = 'task-health-legacy'").get().failure_source,
    "system",
    "升级时要把历史的重启收口记录补成 system",
  );
  // 补上标记后，这条 05:00 的系统失败不再算最近事件，最近的仍是 04:00 那次真正的接口超时
  const afterBackfill = latestImageProviderEvent();
  assert.equal(afterBackfill.message, "图像引擎请求超时。");
  assert.equal(
    classifyImageProviderHealth({ mode: "live", providerReady: true, latest: afterBackfill }).status,
    "timeout",
    "补标记之后接口状态应该回到真实的那一次结果",
  );

  // 账号自备 Key 的失败不能污染全站服务器线路健康度；具体失败仍由该账号的任务展示。
  insertTask.run(
    "task-health-user-key",
    userId,
    "failed",
    "图像引擎请求失败 (502)：账号自备线路异常",
    "provider",
    "2026-08-18T06:00:00.000Z",
    "2026-08-18T06:00:00.000Z",
  );
  sqlite.prepare("UPDATE generation_task SET key_source = 'user' WHERE id = 'task-health-user-key'").run();
  const afterUserKeyFailure = latestImageProviderEvent();
  assert.equal(
    afterUserKeyFailure.message,
    "图像引擎请求超时。",
    "自备 Key 的账号失败不能覆盖服务器线路最近状态",
  );

  sqlite.prepare("DELETE FROM generation_task WHERE id LIKE 'task-health-%'").run();
}

const savedKey = process.env.OPENAI_API_KEY;
delete process.env.OPENAI_API_KEY;
assert.deepEqual(workflowImageProviderStatus(), {
  mode: "demo",
  providerReady: false,
  baseUrl: "https://www.packyapi.com/v1",
  model: "gpt-image-2",
});
process.env.OPENAI_API_KEY = savedKey;

const onePixelPng =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";
const onePixelBytes = Buffer.from(onePixelPng.split(",")[1], "base64");

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const typeBuffer = Buffer.from(type);
  const chunk = Buffer.alloc(12 + data.length);
  chunk.writeUInt32BE(data.length, 0);
  typeBuffer.copy(chunk, 4);
  data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 8 + data.length);
  return chunk;
}

function rgbPngBytes(width, height, pixelAt) {
  const signature = Buffer.from("89504e470d0a1a0a", "hex");
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const rows = [];
  for (let y = 0; y < height; y += 1) {
    const row = [0];
    for (let x = 0; x < width; x += 1) row.push(...pixelAt(x, y));
    rows.push(Buffer.from(row));
  }
  return Buffer.concat([signature, pngChunk("IHDR", ihdr), pngChunk("IDAT", deflateSync(Buffer.concat(rows))), pngChunk("IEND", Buffer.alloc(0))]);
}

function rgbaPngBytes(width, height, pixelAt) {
  const signature = Buffer.from("89504e470d0a1a0a", "hex");
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const rows = [];
  for (let y = 0; y < height; y += 1) {
    const row = [0];
    for (let x = 0; x < width; x += 1) row.push(...pixelAt(x, y));
    rows.push(Buffer.from(row));
  }
  return Buffer.concat([signature, pngChunk("IHDR", ihdr), pngChunk("IDAT", deflateSync(Buffer.concat(rows))), pngChunk("IEND", Buffer.alloc(0))]);
}

const checkerboardCutoutBytes = rgbPngBytes(512, 512, (x, y) => {
  if (x >= 128 && x < 384 && y >= 128 && y < 384) return [30, 120, 74];
  return (x + y) % 2 === 0 ? [242, 242, 242] : [225, 225, 225];
});

const validResultBytes = rgbPngBytes(512, 512, (x, y) => [
  (32 + x + y) % 256,
  (96 + x * 2) % 256,
  (144 + y * 3) % 256,
]);
const validAssetPng = `data:image/png;base64,${validResultBytes.toString("base64")}`;

const sparseSubjectBytes = rgbPngBytes(512, 512, (x, y) => {
  if (x >= 246 && x < 266 && y >= 246 && y < 266) return [28, 118, 72];
  return [246, 246, 246];
});

const segmentationCutoutBytes = rgbaPngBytes(512, 512, (x, y) => {
  if (x >= 128 && x < 384 && y >= 128 && y < 384) return [30, 120, 74, 255];
  return [246, 246, 246, 0];
});
const whiteBackgroundProductBytes = rgbPngBytes(512, 512, (x, y) => {
  if (x >= 128 && x < 384 && y >= 128 && y < 384) return [30, 120, 74];
  return [246, 246, 246];
});
const leakyAlphaCutoutBytes = rgbaPngBytes(512, 512, (x, y) => {
  if (x >= 206 && x < 306 && y >= 206 && y < 306) return [246, 246, 246, 0];
  return [246, 246, 246, 255];
});

function pngDownloadResponse(buffer = validResultBytes) {
  return new Response(buffer, {
    status: 200,
    headers: { "content-type": "image/png" },
  });
}

assert.throws(
  () =>
    createWorkflowJob({
      userId,
      type: "unknown-workflow",
      title: "未知工作流",
      prompt: "bad",
      assets: [],
      options: {},
    }),
  /未知工作流类型/,
);
assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM workflow_job").get().count, 0);

const fabricJob = createWorkflowJob({
  userId,
  type: "fabric-to-style",
  title: "苔绿色提花面料到连衣裙款式",
  prompt: "苔绿色丝感提花，想做成适合春夏通勤的连衣裙，也保留草图里的方领。",
  assets: [
    {
      kind: "fabric",
      name: "moss-jacquard.png",
      mimeType: "image/png",
      sourceUrl: validAssetPng,
      note: "moss green jacquard floral silk",
    },
    {
      kind: "sketch",
      name: "square-neck-sketch.png",
      mimeType: "image/png",
      sourceUrl: validAssetPng,
      note: "square neckline midi dress sketch",
    },
  ],
  options: {
    garmentCategory: "dress",
    variants: 4,
    editControls: {
      hemLength: "midi",
      sleeveLength: "short",
      neckline: "square",
      pattern: "stripe",
      hemLengthPercent: 82,
      sleeveLengthPercent: 35,
      necklineDepthPercent: 46,
    },
  },
});
assert.equal(fabricJob.status, "running");
assert.equal(fabricJob.message, "工作流已创建");
assert.equal(fabricJob.steps.length, 4);
assert.equal(fabricJob.results.length, 4);
assert(fabricJob.assets[0].metadata.colors.includes("moss green"));
assert.deepEqual(fabricJob.steps[0].metadata.multimodalInput.inputModes, ["面料图片", "设计草图", "文字描述"]);
assert.deepEqual(fabricJob.steps[0].metadata.multimodalInput.assetKinds, ["fabric", "sketch"]);
assert.deepEqual(fabricJob.results[0].metadata.multimodalInput.assetNames, ["moss-jacquard.png", "square-neck-sketch.png"]);
assert.equal(fabricJob.steps[1].metadata.styleRecommendation.recommendedCategory, "dress");
assert.equal(fabricJob.steps[1].metadata.styleRecommendation.silhouette, "soft A-line dress");
assert(fabricJob.steps[1].metadata.styleRecommendation.rationale.includes("jacquard floral"));
assert(fabricJob.results.every((result) => result.versionType === "style_variant"));
assert.equal(fabricJob.results[0].metadata.styleRecommendation.silhouette, "soft A-line dress");
assert.deepEqual(
  fabricJob.results.map((result) => result.metadata.variation?.focus),
  ["主推版型", "换色方案", "印花比例", "细节裂变"],
);
assert.deepEqual(fabricJob.steps[2].metadata.precisionEdit, {
  pattern: "stripe",
  patternLabel: "条纹",
  hemLengthPercent: 82,
  sleeveLengthPercent: 35,
  necklineDepthPercent: 46,
  summary: "面料图案条纹 · 衣长82% · 袖长35% · 领口开度46%",
});
assert.equal(fabricJob.results[0].metadata.precisionEdit.summary, "面料图案条纹 · 衣长82% · 袖长35% · 领口开度46%");

const clampedFabricJob = createWorkflowJob({
  userId,
  type: "fabric-to-style",
  title: "异常数量款式",
  prompt: "用户输入了 0 个变体，但系统应稳定生成最少一个结果。",
  assets: [{ kind: "fabric", name: "solid-green.png", mimeType: "image/png", sourceUrl: validAssetPng, note: "green silk" }],
  options: { variants: 0 },
});
assert.equal(clampedFabricJob.results.length, 1);

const expandedFabricJob = createWorkflowJob({
  userId,
  type: "fabric-to-style",
  title: "八款款式裂变",
  prompt: "基于同一面料生成 8 个不同方向的款式裂变。",
  assets: [{ kind: "fabric", name: "expanded-moss-jacquard.png", mimeType: "image/png", sourceUrl: validAssetPng, note: "moss green jacquard floral silk" }],
  options: { variants: 8 },
});
assert.equal(expandedFabricJob.results.length, 8);
assert.equal(new Set(expandedFabricJob.results.map((result) => result.metadata.variation?.focus)).size, 8);
assert.deepEqual(expandedFabricJob.results.map((result) => result.metadata.variation?.focus), [
  "主推版型",
  "换色方案",
  "印花比例",
  "细节裂变",
  "领型变化",
  "袖型变化",
  "长度层次",
  "商业搭配",
]);

const modelLibrary = listCommercialModels();
assert(modelLibrary.length >= 18);
assert(modelLibrary.some((model) => model.ageGroup === "child"));
assert(modelLibrary.some((model) => model.bodyType === "plus"));
assert(modelLibrary.some((model) => model.ethnicity === "black"));
assert(modelLibrary.some((model) => model.ethnicity === "south-asian"));
assert(modelLibrary.some((model) => model.ethnicity === "latinx"));
assert(modelLibrary.some((model) => model.ethnicity === "middle-eastern"));
assert(modelLibrary.some((model) => model.ageGroup === "senior"));
assert(modelLibrary.some((model) => model.gender === "male"));
assert(modelLibrary.some((model) => model.gender === "female"));
assert(modelLibrary.every((model) => model.commercialUse === true));
assert(modelLibrary.some((model) => model.id === "child-black-01"));
assert(modelLibrary.some((model) => model.id === "plus-south-asian-01"));
assert(modelLibrary.some((model) => model.id === "senior-east-asian-male-01"));

const tryOnJob = createWorkflowJob({
  userId,
  type: "virtual-model-showcase",
  title: "童装裙上身效果",
  prompt: "把平铺童装裙穿到儿童虚拟模特身上，森林场景，生成图片和走动短视频。",
  assets: [
    {
      kind: "garment",
      name: "kids-dress-flatlay.png",
      mimeType: "image/png",
      sourceUrl: validAssetPng,
      note: "kids dress flat lay",
    },
  ],
  options: {
    modelId: "child-east-asian-01",
    sceneId: "forest",
    poseId: "walking",
    makeVideo: true,
  },
});
assert.equal(tryOnJob.results.some((result) => result.versionType === "try_on_image"), true);
assert.equal(tryOnJob.results.some((result) => result.versionType === "motion_storyboard"), true);
assert.equal(tryOnJob.results.find((result) => result.versionType === "motion_storyboard").metadata.status, "storyboard_only");
const tryOnImageResult = tryOnJob.results.find((result) => result.versionType === "try_on_image");
assert.equal(tryOnImageResult.metadata.virtualModelSelection.modelId, "child-east-asian-01");
assert.equal(tryOnImageResult.metadata.virtualModelSelection.modelName, "儿童模特");
assert.equal(tryOnImageResult.metadata.virtualModelSelection.ethnicity, "east-asian");
assert.equal(tryOnImageResult.metadata.virtualModelSelection.ageGroup, "child");
assert.equal(tryOnImageResult.metadata.virtualModelSelection.bodyType, "standard");
assert.equal(tryOnImageResult.metadata.virtualModelSelection.gender, "female");
assert.equal(tryOnImageResult.metadata.virtualModelSelection.ethnicityLabel, "东亚");
assert.equal(tryOnImageResult.metadata.virtualModelSelection.ageGroupLabel, "儿童");
assert.equal(tryOnImageResult.metadata.virtualModelSelection.bodyTypeLabel, "标准");
assert.equal(tryOnImageResult.metadata.virtualModelSelection.genderLabel, "女");
assert.equal(tryOnImageResult.metadata.virtualModelSelection.commercialUse, true);
assert.equal(tryOnImageResult.metadata.virtualModelSelection.sceneId, "forest");
assert.equal(tryOnImageResult.metadata.virtualModelSelection.sceneLabel, "森林");
assert.equal(tryOnImageResult.metadata.virtualModelSelection.poseId, "walking");
assert.equal(tryOnImageResult.metadata.virtualModelSelection.poseLabel, "行走");
assert.deepEqual(tryOnImageResult.metadata.tryOnSource, {
  sourceType: "garment",
  sourceLabel: "平铺图",
  inputName: "kids-dress-flatlay.png",
  assetKind: "garment",
});
assert.deepEqual(tryOnJob.steps[0].metadata.tryOnSource, tryOnImageResult.metadata.tryOnSource);

const diverseTryOnJob = createWorkflowJob({
  userId,
  type: "virtual-model-showcase",
  title: "多元虚拟模特上身效果",
  prompt: "把设计草图穿到黑人成年女模特身上，草地场景站立展示。",
  assets: [
    {
      kind: "designSketch",
      name: "adult-dress-design-sketch.png",
      mimeType: "image/png",
      sourceUrl: validAssetPng,
      note: "adult dress design sketch",
    },
  ],
  options: {
    modelId: "black-adult-01",
    sceneId: "grassland",
    poseId: "standing",
    sourceType: "designSketch",
    makeVideo: false,
  },
});
const diverseTryOnImage = diverseTryOnJob.results.find((result) => result.versionType === "try_on_image");
assert.equal(diverseTryOnImage.metadata.virtualModelSelection.modelId, "black-adult-01");
assert.equal(diverseTryOnImage.metadata.virtualModelSelection.modelName, "黑人成年女模特");
assert.equal(diverseTryOnImage.metadata.virtualModelSelection.ethnicity, "black");
assert.equal(diverseTryOnImage.metadata.virtualModelSelection.gender, "female");
assert.equal(diverseTryOnImage.metadata.virtualModelSelection.sceneId, "grassland");
assert.equal(diverseTryOnImage.metadata.virtualModelSelection.sceneLabel, "草地");
assert.equal(diverseTryOnImage.metadata.virtualModelSelection.poseLabel, "站立");
assert.equal(diverseTryOnImage.metadata.tryOnSource.sourceType, "designSketch");
assert.equal(diverseTryOnImage.metadata.tryOnSource.sourceLabel, "设计图");
assert.equal(diverseTryOnImage.metadata.tryOnSource.inputName, "adult-dress-design-sketch.png");

const postprocessJob = createWorkflowJob({
  userId,
  type: "postprocess-suite",
  title: "批量主图后期",
  prompt: "两张商品图批量抠图、补光、手部修复、重色和调整比例。",
  assets: [
    { kind: "result", name: "look-1.png", mimeType: "image/png", sourceUrl: validAssetPng },
    { kind: "result", name: "look-2.png", mimeType: "image/png", sourceUrl: validAssetPng },
  ],
  options: {
    actions: ["cutout", "enhance", "repair", "erase", "recolor", "resize"],
    targetColor: "ivory",
    targetRatio: "4:5",
    postprocessTuning: {
      eraseTarget: "衣服旁边的多余衣架",
      lightStrength: 72,
      beautyLevel: 38,
      repairFocus: "hands",
    },
  },
});
assert.equal(postprocessJob.results.length, 2);
assert(postprocessJob.results.every((result) => result.metadata.actions.includes("cutout")));
assert.equal(postprocessJob.results[0].metadata.batchOperation.targetColor, "ivory");
assert.equal(postprocessJob.results[0].metadata.batchOperation.targetColorLabel, "象牙白");
assert.equal(postprocessJob.results[0].metadata.postprocessTuning.summary, "擦除衣服旁边的多余衣架 · 补光72% · 美体38% · 修复重点手部");
assert.equal(postprocessJob.results[0].metadata.postprocessTuning.repairFocusLabel, "手部");
assert(postprocessJob.steps.some((step) => step.capability === "image.segment"));

const multiScenePostprocessJob = createWorkflowJob({
  userId,
  type: "postprocess-suite",
  title: "批量多场景后期",
  prompt: "两张商品图批量抠图，并分别生成棚拍和城市场景版本。",
  assets: [
    { kind: "result", name: "scene-look-1.png", mimeType: "image/png", sourceUrl: validAssetPng },
    { kind: "result", name: "scene-look-2.png", mimeType: "image/png", sourceUrl: validAssetPng },
  ],
  options: {
    actions: ["cutout", "resize"],
    targetScenes: ["studio", "city"],
    targetRatio: "1:1",
  },
});
assert.equal(multiScenePostprocessJob.results.length, 4);
assert.deepEqual(
  multiScenePostprocessJob.results.map((result) => result.metadata.targetScene),
  ["studio", "city", "studio", "city"],
);
assert.deepEqual(multiScenePostprocessJob.results.map((result) => result.metadata.batchOperation.batchIndex), [1, 2, 3, 4]);
assert.deepEqual(multiScenePostprocessJob.results.map((result) => result.metadata.batchOperation.inputName), [
  "scene-look-1.png",
  "scene-look-1.png",
  "scene-look-2.png",
  "scene-look-2.png",
]);
assert.deepEqual(multiScenePostprocessJob.results.map((result) => result.metadata.batchOperation.sceneLabel), ["棚拍场景", "城市街景", "棚拍场景", "城市街景"]);
assert.equal(multiScenePostprocessJob.results[3].metadata.batchOperation.batchTotal, 4);
assert.deepEqual(multiScenePostprocessJob.results[3].metadata.batchOperation.actionLabels, ["智能抠图", "调整图片比例"]);
assert(multiScenePostprocessJob.steps.find((step) => step.capability === "batch").message.includes("4 张图片"));

const sanitizedPostprocessJob = createWorkflowJob({
  userId,
  type: "postprocess-suite",
  title: "未知后期动作",
  prompt: "混入未知动作时应只保留安全支持的后期能力。",
  assets: [{ kind: "result", name: "look-3.png", mimeType: "image/png", sourceUrl: validAssetPng }],
  options: { actions: ["cutout", "explode", "repair"] },
});
assert.deepEqual(sanitizedPostprocessJob.results[0].metadata.actions, ["cutout", "repair"]);
assert(!sanitizedPostprocessJob.steps.some((step) => step.title === "explode" || step.capability === "image.edit"));

const defaultPostprocessJob = createWorkflowJob({
  userId,
  type: "postprocess-suite",
  title: "默认完整后期",
  prompt: "一键批量后期应覆盖抠图、增强、修复、擦除、重色和比例调整。",
  assets: [{ kind: "result", name: "default-postprocess.png", mimeType: "image/png", sourceUrl: validAssetPng }],
  options: {},
});
assert(defaultPostprocessJob.results[0].metadata.actions.includes("erase"));
assert(defaultPostprocessJob.steps.some((step) => step.capability === "image.inpaint" && step.title === "对象擦除"));

const noVideoJob = createWorkflowJob({
  userId,
  type: "virtual-model-showcase",
  title: "只要上身图",
  prompt: "只生成静态上身图，不需要短视频。",
  assets: [{ kind: "garment", name: "dress.png", mimeType: "image/png", sourceUrl: validAssetPng }],
  options: { modelId: "not-real", makeVideo: false },
});
assert.equal(noVideoJob.results.some((result) => result.versionType === "motion_video"), false);
assert.equal(noVideoJob.results[0].metadata.model.id, "adult-east-asian-01");

const trendJob = createWorkflowJob({
  userId,
  type: "trend-brand-lab",
  title: "春夏测款和品牌 DNA",
  prompt: "分析春夏女装趋势，生成 3 个测款版本，并使用品牌历史图训练专属风格。",
  assets: [
    { kind: "brand", name: "brand-look-1.png", mimeType: "image/png", sourceUrl: validAssetPng },
    { kind: "brand", name: "brand-look-2.png", mimeType: "image/png", sourceUrl: validAssetPng },
  ],
  options: {
    trendKeywords: ["butter yellow", "utility skirt", "lightweight linen"],
    marketVariants: 3,
    trainBrandProfile: true,
  },
});
assert.equal(trendJob.results.filter((result) => result.versionType === "market_test_variant").length, 3);
assert.equal(trendJob.results.some((result) => result.versionType === "brand_profile"), true);
assert(trendJob.brandProfile.dna.palette.includes("butter yellow"));
assert(trendJob.brandProfile.dna.texture.includes("linen slub"));
assert(trendJob.brandProfile.dna.promptPrefix.includes("butter yellow"));

const originalFetch = globalThis.fetch;
const liveFetchCalls = [];
globalThis.fetch = async (url, init = {}) => {
  liveFetchCalls.push({ url: String(url), init });
  if (String(url).startsWith("https://example.test/result-")) {
    return pngDownloadResponse();
  }
  return new Response(JSON.stringify({ data: [{ url: `https://example.test/result-${liveFetchCalls.length}.png` }] }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
};
const liveFabricJob = await materializeLiveImages(fabricJob);
const liveFabricApiCalls = liveFetchCalls.filter((call) => call.init?.method === "POST");
assert.equal(liveFabricJob.status, "success");
assert.equal(liveFabricJob.progress, 100);
assert(liveFabricJob.results.every((result) => result.metadata.liveGenerated === true));
assert(liveFabricJob.results.every((result) => result.metadata.generationMode === "image_edit"));
assert(liveFabricJob.results.every((result) => /^\/generated-images\/[a-f0-9-]+\.png$/.test(result.imageUrl)));
assert(liveFabricJob.results.every((result) => result.metadata.imageInspection?.sourceType === "url"));
assert(liveFabricJob.results.every((result) => result.metadata.imageInspection?.bytes === validResultBytes.length));
assert(liveFabricJob.results.every((result) => result.metadata.imageInspection?.storage === "local_file"));
for (const result of liveFabricJob.results) {
  assert.equal(await fs.readFile(path.join(workflowAssetDir, result.metadata.imageInspection.fileName), "base64"), validResultBytes.toString("base64"));
}
assert(liveFabricJob.results.every((result) => result.metadata.qualityGate?.status === "passed"));
assert(liveFabricJob.results.every((result) => result.metadata.qualityGate?.checks.includes("image_persisted")));
assert(liveFabricJob.results.every((result) => result.metadata.qualityGate?.checks.includes("asset_grounding")));
assert(liveFabricJob.results.every((result) => Array.isArray(result.metadata.qualityGate?.issues)));
assert(liveFabricJob.results.every((result) => result.metadata.qualityGate?.issues.length === 0));
assert(liveFabricJob.results.every((result) => result.metadata.qualityGate?.nextActions.includes("可进入人工审片或继续细节编辑。")));
assert(liveFabricApiCalls.every((call) => call.url.endsWith("/images/edits")));
assert(liveFabricApiCalls.every((call) => call.init.body instanceof FormData));
for (const call of liveFabricApiCalls) {
  assert.equal(call.init.body.getAll("image").length, 2);
  assert.equal(call.init.body.get("model"), "gpt-image-2");
  assert.equal(call.init.body.get("response_format"), "url");
  assert(String(call.init.body.get("prompt")).includes("推荐版型：soft A-line dress"));
  assert(String(call.init.body.get("prompt")).includes("变体方向："));
  assert(String(call.init.body.get("prompt")).includes("精细调整：面料图案条纹 · 衣长82% · 袖长35% · 领口开度46%"));
}

const tinyOutputJob = createWorkflowJob({
  userId,
  type: "fabric-to-style",
  title: "坏图尺寸质量门",
  prompt: "上游如果返回 1x1 坏图，质量门必须拦截。",
  assets: [{ kind: "fabric", name: "tiny-output-source.png", mimeType: "image/png", sourceUrl: validAssetPng, note: "green silk" }],
  options: { variants: 1 },
});
liveFetchCalls.length = 0;
globalThis.fetch = async (url, init = {}) => {
  liveFetchCalls.push({ url: String(url), init });
  if (String(url) === "https://example.test/tiny-output.png") {
    return pngDownloadResponse(onePixelBytes);
  }
  return new Response(JSON.stringify({ data: [{ url: "https://example.test/tiny-output.png" }] }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
};
const tinyMaterializedJob = await materializeLiveImages(tinyOutputJob);
assert.equal(tinyMaterializedJob.results[0].metadata.qualityGate?.status, "rework");
assert(tinyMaterializedJob.results[0].metadata.qualityGate?.warnings.includes("image_too_small"));
assert(tinyMaterializedJob.results[0].metadata.qualityGate?.issues.includes("生成图片尺寸过小，疑似上游坏图或占位图。"));
assert(tinyMaterializedJob.message.includes("需返工"));

const sparseSubjectJob = createWorkflowJob({
  userId,
  type: "fabric-to-style",
  title: "主体覆盖率质量门",
  prompt: "上游如果只返回很小主体和大面积空白，质量门必须拦截。",
  assets: [{ kind: "fabric", name: "sparse-subject-source.png", mimeType: "image/png", sourceUrl: validAssetPng, note: "green silk" }],
  options: { variants: 1 },
});
liveFetchCalls.length = 0;
globalThis.fetch = async (url, init = {}) => {
  liveFetchCalls.push({ url: String(url), init });
  if (String(url) === "https://example.test/sparse-subject.png") {
    return pngDownloadResponse(sparseSubjectBytes);
  }
  return new Response(JSON.stringify({ data: [{ url: "https://example.test/sparse-subject.png" }] }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
};
const sparseSubjectMaterializedJob = await materializeLiveImages(sparseSubjectJob);
assert.equal(sparseSubjectMaterializedJob.results[0].metadata.qualityGate?.status, "rework");
assert(sparseSubjectMaterializedJob.results[0].metadata.qualityGate?.warnings.includes("subject_too_sparse"));
assert(sparseSubjectMaterializedJob.results[0].metadata.qualityGate?.issues.includes("生成图片主体占比过低，疑似空白图或主体未生成。"));

globalThis.fetch = async (url, init = {}) => {
  liveFetchCalls.push({ url: String(url), init });
  if (String(url).startsWith("https://example.test/result-")) {
    return pngDownloadResponse();
  }
  return new Response(JSON.stringify({ data: [{ url: `https://example.test/result-${liveFetchCalls.length}.png` }] }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
};
liveFetchCalls.length = 0;
const liveVirtualJob = await materializeLiveImages(tryOnJob);
assert.equal(liveFetchCalls.filter((call) => call.init?.method === "POST").length, 1);
assert.equal(liveVirtualJob.results.find((result) => result.versionType === "try_on_image").metadata.model.id, "child-east-asian-01");
assert.equal(liveVirtualJob.results.find((result) => result.versionType === "try_on_image").metadata.imageModel, "gpt-image-2");
const liveVirtualPrompt = String(liveFetchCalls.find((call) => call.init?.method === "POST").init.body.get("prompt"));
assert(liveVirtualPrompt.includes("虚拟模特：儿童模特"));
assert(liveVirtualPrompt.includes("人种 东亚"));
assert(liveVirtualPrompt.includes("年龄 儿童"));
assert(liveVirtualPrompt.includes("体型 标准"));
assert(liveVirtualPrompt.includes("性别 女"));
assert(liveVirtualPrompt.includes("场景：森林"));
assert(liveVirtualPrompt.includes("姿势：行走"));
assert(liveVirtualPrompt.includes("试穿来源：平铺图 kids-dress-flatlay.png"));
const liveVideoResult = liveVirtualJob.results.find((result) => result.mediaType === "video");
assert.match(liveVideoResult.imageUrl, /^\/generated-videos\/[a-f0-9-]+\.mp4$/);
assert.equal(liveVideoResult.metadata.motionPreviewGenerated, true);
assert.equal(liveVideoResult.metadata.requiresVideoModelForMp4, false);
assert.equal(liveVideoResult.metadata.requiresAiVideoModelForMotion, true);
assert.equal(liveVideoResult.metadata.videoInspection?.mode, "local_motion_preview");
assert(liveVideoResult.metadata.videoInspection?.bytes > 1000);
const liveVideoBytes = await fs.readFile(path.join(workflowVideoDir, liveVideoResult.metadata.videoInspection.fileName));
assert.equal(liveVideoBytes.subarray(4, 8).toString("utf8"), "ftyp");

const externalVideoSeed = await createMotionPreviewMp4({
  sourceImageUrl: liveVirtualJob.results.find((result) => result.versionType === "try_on_image").imageUrl,
  durationSeconds: 1,
  size: "320x320",
});
const externalVideoBytes = await fs.readFile(path.join(workflowVideoDir, externalVideoSeed.videoInspection.fileName));
const externalVideoJob = createWorkflowJob({
  userId,
  type: "virtual-model-showcase",
  title: "真实视频服务展示",
  prompt: "配置视频服务时生成真实行走转身 MP4。",
  assets: [{ kind: "garment", name: "video-service-dress.png", mimeType: "image/png", sourceUrl: validAssetPng }],
  options: { modelId: "child-east-asian-01", sceneId: "forest", poseId: "walking", makeVideo: true },
});
process.env.AI_VIDEO_API_URL = "https://video.example.test/generate";
process.env.AI_VIDEO_API_KEY = "video-test-key";
const videoServiceCalls = [];
globalThis.fetch = async (url, init = {}) => {
  videoServiceCalls.push({ url: String(url), init });
  if (String(url).startsWith("https://example.test/result-")) {
    return pngDownloadResponse();
  }
  if (String(url) === "https://video.example.test/generate") {
    assert.equal(init?.method, "POST");
    assert.equal(init?.headers?.Authorization, "Bearer video-test-key");
    assert(init.body instanceof FormData);
    assert.equal(init.body.get("pose"), "walking");
    assert.equal(init.body.get("scene"), "森林");
    assert.equal(init.body.get("model"), "儿童模特");
    const sourceImages = init.body.getAll("image");
    assert.equal(sourceImages.length, 1);
    assert.equal(sourceImages[0].type, "image/png");
    assert(sourceImages[0].size > 0);
    return new Response(JSON.stringify({ b64_video: externalVideoBytes.toString("base64") }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }
  return new Response(JSON.stringify({ data: [{ url: `https://example.test/result-${videoServiceCalls.length}.png` }] }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
};
const externalVideoMaterializedJob = await materializeLiveImages(externalVideoJob);
const externalVideoResult = externalVideoMaterializedJob.results.find((result) => result.mediaType === "video");
assert.equal(videoServiceCalls.filter((call) => call.url === "https://video.example.test/generate").length, 1);
assert.match(externalVideoResult.imageUrl, /^\/generated-videos\/[a-f0-9-]+\.mp4$/);
assert.equal(externalVideoResult.metadata.videoProvider, "external-video-service");
assert.equal(externalVideoResult.metadata.videoServiceUsed, true);
assert.equal(externalVideoResult.metadata.motionPreviewGenerated, false);
assert.equal(externalVideoResult.metadata.requiresVideoModelForMp4, false);
assert.equal(externalVideoResult.metadata.requiresAiVideoModelForMotion, false);
assert.equal(externalVideoResult.metadata.videoInspection?.mode, "external_video_service");
assert.equal((await fs.readFile(path.join(workflowVideoDir, externalVideoResult.metadata.videoInspection.fileName))).subarray(4, 8).toString("utf8"), "ftyp");
delete process.env.AI_VIDEO_API_URL;
delete process.env.AI_VIDEO_API_KEY;
globalThis.fetch = async (url, init = {}) => {
  liveFetchCalls.push({ url: String(url), init });
  if (String(url).startsWith("https://example.test/result-")) {
    return pngDownloadResponse();
  }
  return new Response(JSON.stringify({ data: [{ url: `https://example.test/result-${liveFetchCalls.length}.png` }] }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
};

liveFetchCalls.length = 0;
const livePostprocessJob = await materializeLiveImages(postprocessJob);
const postprocessApiCalls = liveFetchCalls.filter((call) => call.init?.method === "POST");
assert.equal(postprocessApiCalls.length, 2);
assert(postprocessApiCalls.every((call) => String(call.init.body.get("prompt")).includes("透明 alpha")));
assert(String(postprocessApiCalls[0].init.body.get("prompt")).includes("批量后期：第1/2张，来源 look-1.png，目标场景 棚拍场景"));
assert(String(postprocessApiCalls[0].init.body.get("prompt")).includes("处理动作：智能抠图、图片美化与增强、手部修复、对象擦除、智能重色、调整图片比例"));
assert(String(postprocessApiCalls[0].init.body.get("prompt")).includes("目标颜色 象牙白，目标比例 4:5"));
assert(String(postprocessApiCalls[0].init.body.get("prompt")).includes("精修控制：擦除衣服旁边的多余衣架 · 补光72% · 美体38% · 修复重点手部"));
assert(livePostprocessJob.results.every((result) => result.metadata.qualityGate?.status === "rework"));
assert(livePostprocessJob.results.every((result) => result.metadata.qualityGate?.warnings.includes("cutout_alpha_missing")));
assert(livePostprocessJob.results.every((result) => result.metadata.qualityGate?.issues.includes("抠图结果未检测到透明 alpha，不能视为像素级精准抠图。")));
assert(livePostprocessJob.results.every((result) => result.metadata.qualityGate?.nextActions.includes("接入专用分割/抠图服务或重新生成透明 PNG 后再验收。")));
globalThis.fetch = originalFetch;

const segmentationCutoutJob = createWorkflowJob({
  userId,
  type: "postprocess-suite",
  title: "专用分割服务抠图",
  prompt: "配置专用分割服务时，应直接返回真实透明 PNG。",
  assets: [{ kind: "result", name: "segmentation-source.png", mimeType: "image/png", sourceUrl: validAssetPng }],
  options: { actions: ["cutout"] },
});
process.env.SEGMENTATION_API_URL = "https://segment.example.test/cutout";
process.env.SEGMENTATION_API_KEY = "segment-test-key";
const segmentationFetchCalls = [];
globalThis.fetch = async (url, init = {}) => {
  segmentationFetchCalls.push({ url: String(url), init });
  assert.equal(String(url), "https://segment.example.test/cutout");
  assert.equal(init?.method, "POST");
  assert.equal(init?.headers?.Authorization, "Bearer segment-test-key");
  assert(init.body instanceof FormData);
  assert.equal(init.body.getAll("image").length, 1);
  return new Response(JSON.stringify({ b64_json: segmentationCutoutBytes.toString("base64") }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
};
const segmentedCutoutJob = await materializeLiveImages(segmentationCutoutJob);
const segmentedCutout = segmentedCutoutJob.results[0];
assert.equal(segmentationFetchCalls.length, 1);
assert.equal(segmentedCutout.metadata.provider, "Segmentation API");
assert.equal(segmentedCutout.metadata.generationMode, "segmentation_service");
assert.equal(segmentedCutout.metadata.segmentationServiceUsed, true);
assert.equal(segmentedCutout.metadata.imageInspection?.alpha?.transparentPixels, 196608);
assert.equal(segmentedCutout.metadata.imageInspection?.alpha?.opaquePixels, 65536);
assert.equal(segmentedCutout.metadata.qualityGate?.status, "passed");
assert(segmentedCutout.metadata.qualityGate?.checks.includes("transparent_alpha"));
assert(segmentedCutout.metadata.qualityGate?.checks.includes("asset_grounding"));
delete process.env.SEGMENTATION_API_URL;
delete process.env.SEGMENTATION_API_KEY;
globalThis.fetch = originalFetch;

const rawSegmentationCutoutJob = createWorkflowJob({
  userId,
  type: "postprocess-suite",
  title: "专用分割服务二进制抠图",
  prompt: "分割服务直接返回 image/png 时也应落盘验收。",
  assets: [{ kind: "result", name: "raw-segmentation-source.png", mimeType: "image/png", sourceUrl: validAssetPng }],
  options: { actions: ["cutout"] },
});
process.env.SEGMENTATION_API_URL = "https://segment.example.test/raw-cutout";
process.env.SEGMENTATION_API_KEY = "segment-test-key";
globalThis.fetch = async (url, init = {}) => {
  assert.equal(String(url), "https://segment.example.test/raw-cutout");
  assert.equal(init?.method, "POST");
  return new Response(segmentationCutoutBytes, {
    status: 200,
    headers: { "content-type": "image/png" },
  });
};
const rawSegmentedCutoutJob = await materializeLiveImages(rawSegmentationCutoutJob);
const rawSegmentedCutout = rawSegmentedCutoutJob.results[0];
assert.equal(rawSegmentedCutout.metadata.segmentationServiceUsed, true);
assert.equal(rawSegmentedCutout.metadata.imageInspection?.alpha?.transparentPixels, 196608);
assert.equal(rawSegmentedCutout.metadata.qualityGate?.status, "passed");
delete process.env.SEGMENTATION_API_URL;
delete process.env.SEGMENTATION_API_KEY;
globalThis.fetch = originalFetch;

const repairablePostprocessJob = createWorkflowJob({
  userId,
  type: "postprocess-suite",
  title: "棋盘格假透明应修复",
  prompt: "模型返回棋盘格背景时应转成真实透明 alpha。",
  assets: [{ kind: "result", name: "checkerboard-product.png", mimeType: "image/png", sourceUrl: validAssetPng }],
  options: { actions: ["cutout"] },
});
globalThis.fetch = async (url, init = {}) => {
  if (init?.method === "POST") {
    return new Response(JSON.stringify({ data: [{ url: "https://example.test/checkerboard-cutout.png" }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }
  return new Response(checkerboardCutoutBytes, { status: 200, headers: { "content-type": "image/png" } });
};
const repairedPostprocessJob = await materializeLiveImages(repairablePostprocessJob);
const repairedCutout = repairedPostprocessJob.results[0];
assert.equal(repairedCutout.metadata.imageInspection?.repair?.method, "checkerboard_background");
assert.equal(repairedCutout.metadata.imageInspection?.alpha?.transparentPixels, 196608);
assert.equal(repairedCutout.metadata.imageInspection?.alpha?.opaquePixels, 65536);
assert.equal(repairedCutout.metadata.qualityGate?.status, "passed");
assert(repairedCutout.metadata.qualityGate?.checks.includes("transparent_alpha"));

const localCutoutPostprocessJob = createWorkflowJob({
  userId,
  type: "postprocess-suite",
  title: "白底商品图本地抠图",
  prompt: "模型返回白底商品图时应本地转成真实透明 alpha。",
  assets: [{ kind: "result", name: "white-background-product.png", mimeType: "image/png", sourceUrl: validAssetPng }],
  options: { actions: ["cutout"] },
});
globalThis.fetch = async (url, init = {}) => {
  if (init?.method === "POST") {
    return new Response(JSON.stringify({ data: [{ url: "https://example.test/white-background-product.png" }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }
  return new Response(whiteBackgroundProductBytes, { status: 200, headers: { "content-type": "image/png" } });
};
const localCutoutJob = await materializeLiveImages(localCutoutPostprocessJob);
const localCutout = localCutoutJob.results[0];
assert.equal(localCutout.metadata.imageInspection?.repair?.method, "solid_background");
assert.equal(localCutout.metadata.imageInspection?.alpha?.transparentPixels, 196608);
assert.equal(localCutout.metadata.imageInspection?.alpha?.opaquePixels, 65536);
assert.equal(localCutout.metadata.qualityGate?.status, "passed");
assert(localCutout.metadata.qualityGate?.checks.includes("transparent_alpha"));

const leakyAlphaPostprocessJob = createWorkflowJob({
  userId,
  type: "postprocess-suite",
  title: "背景残留的 alpha 假阳性",
  prompt: "有少量透明像素但背景仍铺满四边时不能通过抠图质量门。",
  assets: [{ kind: "result", name: "leaky-alpha-product.png", mimeType: "image/png", sourceUrl: validAssetPng }],
  options: { actions: ["cutout"] },
});
globalThis.fetch = async (url, init = {}) => {
  if (init?.method === "POST") {
    return new Response(JSON.stringify({ data: [{ url: "https://example.test/leaky-alpha-product.png" }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }
  return new Response(leakyAlphaCutoutBytes, { status: 200, headers: { "content-type": "image/png" } });
};
const leakyAlphaJob = await materializeLiveImages(leakyAlphaPostprocessJob);
const leakyAlpha = leakyAlphaJob.results[0];
assert.equal(leakyAlpha.metadata.imageInspection?.alpha?.visibleBounds?.touchesAllEdges, true);
assert.equal(leakyAlpha.metadata.qualityGate?.status, "rework");
assert(leakyAlpha.metadata.qualityGate?.warnings.includes("cutout_background_not_removed"));
assert(leakyAlpha.metadata.qualityGate?.issues.includes("抠图结果仍有不透明背景铺满画面边界，不能视为可交付抠图。"));
globalThis.fetch = originalFetch;

const managedSourceName = "11111111-1111-4111-8111-111111111111.png";
await fs.mkdir(workflowAssetDir, { recursive: true });
await fs.writeFile(path.join(workflowAssetDir, managedSourceName), validResultBytes);
const managedSourcePostprocessJob = createWorkflowJob({
  userId,
  type: "postprocess-suite",
  title: "复用真实生成图后期",
  prompt: "功能中心应复用前面真实生成的商品图做后期，而不是退回纯文生图。",
  assets: [{ kind: "result", name: "managed-look.png", mimeType: "image/png", sourceUrl: `/generated-images/${managedSourceName}` }],
  options: { actions: ["enhance", "recolor"] },
});
const managedSourceCalls = [];
globalThis.fetch = async (url, init = {}) => {
  managedSourceCalls.push({ url: String(url), init });
  if (String(url) === "https://example.test/managed-result.png") {
    return pngDownloadResponse();
  }
  return new Response(JSON.stringify({ data: [{ url: "https://example.test/managed-result.png" }] }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
};
const managedSourceJob = await materializeLiveImages(managedSourcePostprocessJob);
const managedSourceApiCall = managedSourceCalls.find((call) => call.init?.method === "POST");
assert(managedSourceApiCall?.init?.body instanceof FormData);
assert.equal(managedSourceApiCall.init.body.getAll("image").length, 1);
assert.equal(managedSourceJob.results[0].metadata.generationMode, "image_edit");
assert.equal(managedSourceJob.results[0].metadata.assetInputCount, 1);
assert.deepEqual(managedSourceJob.results[0].metadata.assetInputNames, ["managed-look.png"]);
globalThis.fetch = originalFetch;

const retryFetchCalls = [];
globalThis.fetch = async (url, init = {}) => {
  retryFetchCalls.push({ url: String(url), init });
  if (String(url) === "https://example.test/retry-success.png") {
    return pngDownloadResponse();
  }
  const apiCallCount = retryFetchCalls.filter((call) => call.init?.method === "POST").length;
  if (apiCallCount <= 2) {
    return new Response(JSON.stringify({ error: { message: "temporary upstream failure" } }), {
      status: 502,
      headers: { "content-type": "application/json" },
    });
  }
  return new Response(JSON.stringify({ data: [{ url: "https://example.test/retry-success.png" }] }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
};
const retryJob = await materializeLiveImages(clampedFabricJob);
assert.equal(retryFetchCalls.filter((call) => call.init?.method === "POST").length, 3);
assert.equal(retryJob.results[0].metadata.retryCount, 2);
assert.equal(retryJob.results[0].metadata.qualityGate.status, "passed");
globalThis.fetch = originalFetch;

const brandTrainingJob = createWorkflowJob({
  userId,
  type: "trend-brand-lab",
  title: "真实品牌训练服务",
  prompt: "使用品牌历史款式训练专属模型。",
  assets: [
    { kind: "brand", name: "training-look-1.png", mimeType: "image/png", sourceUrl: validAssetPng, note: "moss green silk dress" },
    { kind: "brand", name: "training-look-2.png", mimeType: "image/png", sourceUrl: validAssetPng, note: "ivory linen skirt" },
  ],
  options: { trendKeywords: ["moss green", "linen dress"], marketVariants: 1, trainBrandProfile: true },
});
process.env.BRAND_TRAINING_API_URL = "https://brand.example.test/train";
process.env.BRAND_TRAINING_API_KEY = "brand-test-key";
const brandTrainingCalls = [];
globalThis.fetch = async (url, init = {}) => {
  brandTrainingCalls.push({ url: String(url), init });
  if (String(url).startsWith("https://example.test/result-")) {
    return pngDownloadResponse();
  }
  if (String(url) === "https://brand.example.test/train") {
    assert.equal(init?.method, "POST");
    assert.equal(init?.headers?.Authorization, "Bearer brand-test-key");
    assert(init.body instanceof FormData);
    assert.equal(init.body.getAll("image").length, 2);
    assert(String(init.body.get("dna_json")).includes("moss green"));
    assert.equal(init.body.get("profile_title"), "真实品牌训练服务 品牌 DNA");
    return new Response(
      JSON.stringify({
        training_job_id: "train_brand_001",
        model_id: "brand_moss_linen_v1",
        status: "training",
        dashboard_url: "https://brand.example.test/train_brand_001",
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }
  return new Response(JSON.stringify({ data: [{ url: `https://example.test/result-${brandTrainingCalls.length}.png` }] }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
};
const trainedBrandJob = await materializeLiveImages(brandTrainingJob);
const trainedBrandResult = trainedBrandJob.results.find((result) => result.versionType === "brand_profile");
assert.equal(brandTrainingCalls.filter((call) => call.url === "https://brand.example.test/train").length, 1);
assert.equal(trainedBrandResult.metadata.training.status, "training");
assert.equal(trainedBrandResult.metadata.training.trainingJobId, "train_brand_001");
assert.equal(trainedBrandResult.metadata.training.modelId, "brand_moss_linen_v1");
const trainedBrandDashboard = getWorkflowDashboard(userId);
const trainedBrandProfile = trainedBrandDashboard.brandProfiles.find((profile) => profile.jobId === brandTrainingJob.id);
assert.equal(trainedBrandProfile.status, "training");
assert.equal(trainedBrandProfile.dna.training.status, "training");
assert.equal(trainedBrandProfile.dna.training.trainingJobId, "train_brand_001");
assert.equal(trainedBrandDashboard.summary.activeBrandProfiles, 2);
delete process.env.BRAND_TRAINING_API_URL;
delete process.env.BRAND_TRAINING_API_KEY;
globalThis.fetch = originalFetch;

const textGenerateJob = createWorkflowJob({
  userId,
  type: "trend-brand-lab",
  title: "无品牌素材测款",
  prompt: "没有品牌素材时只能生成初版测款。",
  assets: [],
  options: { trendKeywords: ["linen dress"], marketVariants: 1, trainBrandProfile: false },
});
const textFetchCalls = [];
globalThis.fetch = async (url, init = {}) => {
  textFetchCalls.push({ url: String(url), init });
  if (String(url) === "https://example.test/text-generate.png") {
    return pngDownloadResponse();
  }
  return new Response(JSON.stringify({ data: [{ url: "https://example.test/text-generate.png" }] }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
};
const textMaterializedJob = await materializeLiveImages(textGenerateJob);
assert.equal(textFetchCalls.filter((call) => call.init?.method === "POST").length, 1);
assert(textFetchCalls.find((call) => call.init?.method === "POST").url.endsWith("/images/generations"));
assert.equal(textMaterializedJob.results[0].metadata.generationMode, "text_generate");
assert.equal(textMaterializedJob.results[0].metadata.qualityGate.status, "review");
assert(textMaterializedJob.results[0].metadata.qualityGate.issues.includes("未使用素材输入，品牌一致性需要人工复核。"));
assert(textMaterializedJob.results[0].metadata.qualityGate.nextActions.includes("补充面料、服装或品牌参考图后重新生成。"));
assert(textMaterializedJob.message.includes("需人工复核"));
globalThis.fetch = originalFetch;

const invalidGeneratedImageJob = createWorkflowJob({
  userId,
  type: "fabric-to-style",
  title: "上游返回非图片 URL 不能通过",
  prompt: "生成图 URL 如果不是图片，任务必须失败。",
  assets: [{ kind: "fabric", name: "not-image-source.png", mimeType: "image/png", sourceUrl: validAssetPng, note: "green silk" }],
  options: { variants: 1 },
});
globalThis.fetch = async (url) => {
  if (String(url).endsWith("/images/edits")) {
    return new Response(JSON.stringify({ data: [{ url: "https://example.test/not-image.txt" }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }
  return new Response("not an image", { status: 200, headers: { "content-type": "text/plain" } });
};
await assert.rejects(() => materializeLiveImages(invalidGeneratedImageJob), /生成图片不是图片格式/);
globalThis.fetch = originalFetch;

const invalidAssetJob = createWorkflowJob({
  userId,
  type: "postprocess-suite",
  title: "无效素材不能静默降级",
  prompt: "这张素材无效时应失败，而不是退回纯文生图。",
  assets: [{ kind: "result", name: "bad.png", mimeType: "image/png", sourceUrl: "data:image/png;base64," }],
  options: { actions: ["cutout"] },
});
globalThis.fetch = async () => {
  throw new Error("fetch should not be called for invalid image assets");
};
await assert.rejects(() => materializeLiveImages(invalidAssetJob), /没有可用于图像编辑的有效素材/);
globalThis.fetch = originalFetch;

const tinyAssetJob = createWorkflowJob({
  userId,
  type: "fabric-to-style",
  title: "过小素材不能发送给图像引擎",
  prompt: "1x1 素材应在本地拦截，不能交给 image edit。",
  assets: [{ kind: "fabric", name: "tiny-source.png", mimeType: "image/png", sourceUrl: onePixelPng, note: "tiny green silk" }],
  options: { variants: 1 },
});
globalThis.fetch = async () => {
  throw new Error("fetch should not be called for tiny workflow assets");
};
await assert.rejects(() => materializeLiveImages(tinyAssetJob), /素材尺寸过小/);
globalThis.fetch = originalFetch;

const providerFailureJob = createWorkflowJob({
  userId,
  type: "fabric-to-style",
  title: "上游失败任务需要落库",
  prompt: "真实图像上游失败时，任务不能继续显示为成功。",
  assets: [{ kind: "fabric", name: "failure-fabric.png", mimeType: "image/png", sourceUrl: validAssetPng, note: "green silk" }],
  options: { variants: 1 },
});
globalThis.fetch = async () =>
  new Response(JSON.stringify({ error: { message: "upstream unavailable" } }), {
    status: 500,
    headers: { "content-type": "application/json" },
  });
await assert.rejects(() => materializeLiveImages(providerFailureJob), /upstream unavailable/);
markWorkflowJobFailed(providerFailureJob.userId, providerFailureJob.id, new Error("upstream unavailable"));
const failedProviderJob = getWorkflowJob(providerFailureJob.userId, providerFailureJob.id);
assert.equal(failedProviderJob.status, "failed");
assert.equal(failedProviderJob.progress, 100);
assert(failedProviderJob.message.includes("真实图像生成失败"));
assert(failedProviderJob.message.includes("upstream unavailable"));
const failedProviderStep = failedProviderJob.steps.find((step) => step.status === "failed" && step.capability === "delivery.failure");
assert(failedProviderStep, "failed workflow should include a visible failure evidence step");
assert(failedProviderStep.message.includes("upstream unavailable"));
assert.equal(failedProviderStep.metadata.failureEvidence.status, "failed");
assert.equal(failedProviderStep.metadata.failureEvidence.reason, "upstream unavailable");
assert(failedProviderStep.metadata.failureEvidence.nextActions.includes("检查图像生成服务配置、额度和返回格式。"));
assert.equal(failedProviderJob.results[0].metadata.deliveryStatus, "failed");
assert.equal(failedProviderJob.results[0].metadata.failureEvidence.reason, "upstream unavailable");
assert(failedProviderJob.results[0].metadata.failureEvidence.nextActions.includes("不要交付当前占位结果，修复外部服务后重新运行工作流。"));
globalThis.fetch = originalFetch;

const dashboard = getWorkflowDashboard(userId);
assert.equal(dashboard.summary.totalJobs, 26);
assert.equal(dashboard.summary.totalAssets, 30);
assert.equal(dashboard.summary.readyResults, dashboard.jobs.reduce((count, job) => count + job.results.length, 0));
assert.equal(dashboard.summary.quality.passed, 13);
assert.equal(dashboard.summary.quality.review, 1);
assert.equal(dashboard.summary.quality.rework, 5);
assert(dashboard.summary.quality.unchecked > 0);
assert.equal(dashboard.summary.productionReadiness.provider.mode, "live");
assert.equal(dashboard.summary.productionReadiness.provider.model, "gpt-image-2");
assert.equal(dashboard.summary.productionReadiness.provider.health.status, "error");
assert.equal(dashboard.summary.productionReadiness.provider.health.blocking, true);
assert.equal(dashboard.summary.productionReadiness.runtime.liveImageRequests, true);
assert.equal(dashboard.summary.productionReadiness.runtime.label, "图像接口异常");
assert.equal(dashboard.summary.productionReadiness.capabilityCounts.live, 16);
assert.equal(dashboard.summary.productionReadiness.capabilityCounts.preview, 4);
assert.equal(dashboard.summary.productionReadiness.capabilityCounts.requiresService, 0);
assert.deepEqual(dashboard.summary.productionReadiness.blockers, []);
assert.equal(dashboard.summary.productionReadiness.optionalServices.length, 3);
assert.deepEqual(
  dashboard.summary.productionReadiness.optionalServices.map((service) => service.capabilityId),
  ["video.mp4", "image.segment.precise", "brandTraining.model"],
);
const videoOptionalService = dashboard.summary.productionReadiness.optionalServices.find((service) => service.capabilityId === "video.mp4");
assert.deepEqual(videoOptionalService.requiredEnv, ["AI_VIDEO_API_URL", "AI_VIDEO_API_KEY"]);
assert.equal(videoOptionalService.configured, false);
assert(videoOptionalService.nextAction.includes("可选"));
const segmentationOptionalService = dashboard.summary.productionReadiness.optionalServices.find((service) => service.capabilityId === "image.segment.precise");
assert.deepEqual(segmentationOptionalService.requiredEnv, ["SEGMENTATION_API_URL", "SEGMENTATION_API_KEY"]);
assert.equal(segmentationOptionalService.configured, false);
const brandTrainingOptionalService = dashboard.summary.productionReadiness.optionalServices.find((service) => service.capabilityId === "brandTraining.model");
assert.deepEqual(brandTrainingOptionalService.requiredEnv, ["BRAND_TRAINING_API_URL", "BRAND_TRAINING_API_KEY"]);
assert.equal(brandTrainingOptionalService.configured, false);
const envExample = await fs.readFile(".env.example", "utf8");
for (const envName of [
  "AI_VIDEO_API_URL",
  "AI_VIDEO_API_KEY",
  "AI_VIDEO_TIMEOUT_MS",
  "VIDEO_DOWNLOAD_TIMEOUT_MS",
  "SEGMENTATION_API_URL",
  "SEGMENTATION_API_KEY",
  "SEGMENTATION_TIMEOUT_MS",
  "BRAND_TRAINING_API_URL",
  "BRAND_TRAINING_API_KEY",
  "BRAND_TRAINING_TIMEOUT_MS",
  "WORKFLOW_ASSET_DOWNLOAD_TIMEOUT_MS",
]) {
  assert(envExample.includes(`${envName}=`), `.env.example missing ${envName}`);
}
process.env.AI_VIDEO_API_URL = "https://video.example.test";
process.env.AI_VIDEO_API_KEY = "video-test-key";
const configuredReadinessDashboard = getWorkflowDashboard(userId);
const configuredVideoCapability = configuredReadinessDashboard.definitions
  .find((workflow) => workflow.id === "virtual-model-showcase")
  .capabilityStatus.find((capability) => capability.id === "video.mp4");
assert.equal(configuredVideoCapability.status, "live");
assert(configuredVideoCapability.note.includes("AI_VIDEO_API_URL"));
assert.equal(configuredReadinessDashboard.summary.productionReadiness.capabilityCounts.live, 17);
assert.equal(configuredReadinessDashboard.summary.productionReadiness.capabilityCounts.requiresService, 0);
assert.equal(configuredReadinessDashboard.summary.productionReadiness.blockers.some((blocker) => blocker.capabilityId === "video.mp4"), false);
assert.equal(configuredReadinessDashboard.summary.productionReadiness.optionalServices.find((service) => service.capabilityId === "video.mp4").configured, true);
delete process.env.AI_VIDEO_API_URL;
delete process.env.AI_VIDEO_API_KEY;
process.env.AI_VIDEO_API_URL = "https://video.example.test";
process.env.AI_VIDEO_API_KEY = "video-test-key";
process.env.SEGMENTATION_API_URL = "https://segment.example.test";
process.env.SEGMENTATION_API_KEY = "segment-test-key";
process.env.BRAND_TRAINING_API_URL = "https://brand.example.test/train";
process.env.BRAND_TRAINING_API_KEY = "brand-test-key";
const fullyConfiguredReadinessDashboard = getWorkflowDashboard(userId);
assert.equal(fullyConfiguredReadinessDashboard.summary.productionReadiness.capabilityCounts.live, 19);
assert.equal(fullyConfiguredReadinessDashboard.summary.productionReadiness.capabilityCounts.requiresService, 0);
assert.deepEqual(fullyConfiguredReadinessDashboard.summary.productionReadiness.blockers, []);
assert(fullyConfiguredReadinessDashboard.summary.productionReadiness.optionalServices.every((service) => service.configured === true));
for (const [workflowId, capabilityId] of [
  ["virtual-model-showcase", "video.mp4"],
  ["postprocess-suite", "image.segment.precise"],
  ["trend-brand-lab", "brandTraining.model"],
]) {
  const capability = fullyConfiguredReadinessDashboard.definitions
    .find((workflow) => workflow.id === workflowId)
    .capabilityStatus.find((item) => item.id === capabilityId);
  assert.equal(capability.status, "live");
}
delete process.env.AI_VIDEO_API_URL;
delete process.env.AI_VIDEO_API_KEY;
delete process.env.SEGMENTATION_API_URL;
delete process.env.SEGMENTATION_API_KEY;
delete process.env.BRAND_TRAINING_API_URL;
delete process.env.BRAND_TRAINING_API_KEY;
delete process.env.OPENAI_API_KEY;
const demoReadinessDashboard = getWorkflowDashboard(userId);
assert.equal(demoReadinessDashboard.summary.productionReadiness.provider.mode, "demo");
assert.equal(demoReadinessDashboard.summary.productionReadiness.provider.health.status, "demo");
assert.equal(demoReadinessDashboard.summary.productionReadiness.runtime.liveImageRequests, false);
assert.equal(demoReadinessDashboard.summary.productionReadiness.runtime.label, "当前会话仅演示");
process.env.OPENAI_API_KEY = savedKey;
const imageAnalyzedFabricPng = `data:image/png;base64,${rgbPngBytes(512, 512, (x) =>
  x % 64 < 32 ? [58, 118, 75] : [238, 229, 211],
).toString("base64")}`;
const imageAnalyzedFabricJob = createWorkflowJob({
  userId,
  type: "fabric-to-style",
  title: "自动解析上传面料图",
  prompt: "请自动解析这张面料图，并推荐适合的连衣裙款式。",
  assets: [{ kind: "fabric", name: "uploaded-fabric.png", mimeType: "image/png", sourceUrl: imageAnalyzedFabricPng, note: "" }],
  options: { variants: 1, garmentCategory: "dress" },
});
assert.equal(imageAnalyzedFabricJob.assets[0].metadata.analysisSource, "image");
assert.deepEqual(imageAnalyzedFabricJob.assets[0].metadata.colors, ["moss green", "ivory"]);
assert(imageAnalyzedFabricJob.assets[0].metadata.colors.includes("moss green"));
assert(imageAnalyzedFabricJob.assets[0].metadata.colors.includes("ivory"));
assert.equal(imageAnalyzedFabricJob.assets[0].metadata.pattern, "stripe");
assert.equal(imageAnalyzedFabricJob.steps[0].metadata.fabricAnalysis.pattern, "stripe");
assert.equal(imageAnalyzedFabricJob.results[0].metadata.fabricAnalysis.pattern, "stripe");
assert.equal(imageAnalyzedFabricJob.results[0].metadata.fabricAnalysis.texture, "woven stripe");
const providerUsageLimitJob = createWorkflowJob({
  userId,
  type: "fabric-to-style",
  title: "上游额度限制需要保留重置时间",
  prompt: "真实图像上游返回额度限制时，任务失败证据必须保留 resets_at。",
  assets: [{ kind: "fabric", name: "quota-fabric.png", mimeType: "image/png", sourceUrl: validAssetPng, note: "green silk" }],
  options: { variants: 1 },
});
globalThis.fetch = async () =>
  new Response(
    JSON.stringify({
      error: {
        type: "usage_limit_reached",
        message: "The usage limit has been reached",
        resets_at: 1782721841,
      },
    }),
    {
      status: 429,
      headers: { "content-type": "application/json" },
    },
  );
let providerUsageLimitError = null;
await assert.rejects(
  async () => {
    try {
      await materializeLiveImages(providerUsageLimitJob);
    } catch (error) {
      providerUsageLimitError = error;
      throw error;
    }
  },
  /usage_limit_reached/,
);
assert.match(providerUsageLimitError.message, /resets_at=1782721841/);
markWorkflowJobFailed(providerUsageLimitJob.userId, providerUsageLimitJob.id, providerUsageLimitError);
const usageLimitedDashboard = getWorkflowDashboard(userId);
assert.equal(usageLimitedDashboard.summary.productionReadiness.provider.health.status, "usage_limited");
assert.equal(usageLimitedDashboard.summary.productionReadiness.provider.health.resetAt, "2026-06-29T08:30:41.000Z");
globalThis.fetch = originalFetch;
assert(dashboard.trendSignals.some((signal) => signal.keyword === "butter yellow"));
assert(dashboard.brandProfiles.some((profile) => profile.status === "ready"));
assert(listWorkflowAssets(userId).some((asset) => asset.kind === "fabric" && asset.metadata.pattern === "jacquard floral"));

const cappedUserId = "u-dashboard-limit";
sqlite
  .prepare(
    `INSERT INTO user_profile
      (user_id, display_name, role, plan, credits, monthly_used, status, created_at, updated_at)
     VALUES (?, 'Dashboard limit user', 'owner', '测试版', 5000, 0, 'active', ?, ?)`,
  )
  .run(cappedUserId, nowIso(), nowIso());
for (let index = 0; index < 41; index += 1) {
  createWorkflowJob({
    userId: cappedUserId,
    type: "fabric-to-style",
    title: `摘要计数任务 ${index + 1}`,
    prompt: "验证 dashboard 摘要不能被最近任务列表截断。",
    assets: [],
    options: { variants: 1 },
  });
}
const cappedDashboard = getWorkflowDashboard(cappedUserId);
assert.equal(cappedDashboard.jobs.length, 40);
assert.equal(cappedDashboard.summary.totalJobs, 41);

const cappedBrandUserId = "u-brand-dashboard-limit";
sqlite
  .prepare(
    `INSERT INTO user_profile
      (user_id, display_name, role, plan, credits, monthly_used, status, created_at, updated_at)
     VALUES (?, 'Brand dashboard limit user', 'owner', '测试版', 5000, 0, 'active', ?, ?)`,
  )
  .run(cappedBrandUserId, nowIso(), nowIso());
for (let index = 0; index < 21; index += 1) {
  createWorkflowJob({
    userId: cappedBrandUserId,
    type: "trend-brand-lab",
    title: `品牌摘要任务 ${index + 1}`,
    prompt: "验证品牌 DNA 摘要不能被最近档案列表截断。",
    assets: [{ kind: "brand", name: `brand-${index + 1}.png`, mimeType: "image/png", sourceUrl: validAssetPng, note: "brand look" }],
    options: { trendKeywords: ["moss green"], marketVariants: 1, trainBrandProfile: true },
  });
}
const cappedBrandDashboard = getWorkflowDashboard(cappedBrandUserId);
assert.equal(cappedBrandDashboard.brandProfiles.length, 20);
assert.equal(cappedBrandDashboard.summary.activeBrandProfiles, 21);

const corruptAssetJob = createWorkflowJob({
  userId,
  type: "postprocess-suite",
  title: "损坏素材不能发送给图像引擎",
  prompt: "损坏的 data image 应在本地失败。",
  assets: [{ kind: "result", name: "corrupt.png", mimeType: "image/png", sourceUrl: `data:image/png;base64,${Buffer.from("not an image").toString("base64")}` }],
  options: { actions: ["cutout"] },
});
globalThis.fetch = async () => {
  throw new Error("fetch should not be called for corrupt image assets");
};
await assert.rejects(() => materializeLiveImages(corruptAssetJob), /素材不是有效图片文件/);
globalThis.fetch = originalFetch;

function hangingResponse(init = {}) {
  return new Promise((_, reject) => {
    init.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
  });
}

const assetTimeoutJob = createWorkflowJob({
  userId,
  type: "fabric-to-style",
  title: "素材下载超时",
  prompt: "外部素材下载不能无限挂起。",
  assets: [{ kind: "fabric", name: "remote-hangs.png", mimeType: "image/png", sourceUrl: "https://asset.example.test/hangs.png" }],
  options: { variants: 1 },
});
process.env.WORKFLOW_ASSET_DOWNLOAD_TIMEOUT_MS = "100";
globalThis.fetch = async (url, init = {}) => {
  assert.equal(String(url), "https://asset.example.test/hangs.png");
  return hangingResponse(init);
};
await assert.rejects(() => materializeLiveImages(assetTimeoutJob), /素材图片下载超时/);
globalThis.fetch = originalFetch;
delete process.env.WORKFLOW_ASSET_DOWNLOAD_TIMEOUT_MS;

const segmentationTimeoutJob = createWorkflowJob({
  userId,
  type: "postprocess-suite",
  title: "分割服务超时",
  prompt: "专用抠图服务不能无限挂起。",
  assets: [{ kind: "result", name: "segment-timeout-source.png", mimeType: "image/png", sourceUrl: validAssetPng }],
  options: { actions: ["cutout"] },
});
process.env.SEGMENTATION_API_URL = "https://segment.example.test/timeout";
process.env.SEGMENTATION_API_KEY = "segment-test-key";
process.env.SEGMENTATION_TIMEOUT_MS = "100";
globalThis.fetch = async (url, init = {}) => {
  assert.equal(String(url), "https://segment.example.test/timeout");
  return hangingResponse(init);
};
await assert.rejects(() => materializeLiveImages(segmentationTimeoutJob), /分割服务请求超时/);
globalThis.fetch = originalFetch;
delete process.env.SEGMENTATION_API_URL;
delete process.env.SEGMENTATION_API_KEY;
delete process.env.SEGMENTATION_TIMEOUT_MS;

const videoTimeoutJob = createWorkflowJob({
  userId,
  type: "virtual-model-showcase",
  title: "视频服务超时",
  prompt: "外部视频服务不能无限挂起。",
  assets: [{ kind: "garment", name: "video-timeout-dress.png", mimeType: "image/png", sourceUrl: validAssetPng }],
  options: { modelId: "child-east-asian-01", sceneId: "forest", poseId: "walking", makeVideo: true },
});
process.env.AI_VIDEO_API_URL = "https://video.example.test/timeout";
process.env.AI_VIDEO_API_KEY = "video-test-key";
process.env.AI_VIDEO_TIMEOUT_MS = "100";
const videoTimeoutCalls = [];
globalThis.fetch = async (url, init = {}) => {
  videoTimeoutCalls.push({ url: String(url), init });
  if (String(url) === "https://example.test/video-timeout-image.png") return pngDownloadResponse();
  if (String(url) === "https://video.example.test/timeout") return hangingResponse(init);
  return new Response(JSON.stringify({ data: [{ url: "https://example.test/video-timeout-image.png" }] }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
};
await assert.rejects(() => materializeLiveImages(videoTimeoutJob), /视频服务请求超时/);
assert(videoTimeoutCalls.some((call) => call.url === "https://video.example.test/timeout"));
globalThis.fetch = originalFetch;
delete process.env.AI_VIDEO_API_URL;
delete process.env.AI_VIDEO_API_KEY;
delete process.env.AI_VIDEO_TIMEOUT_MS;

const failedBrandTrainingStatusJob = createWorkflowJob({
  userId,
  type: "trend-brand-lab",
  title: "品牌训练失败状态",
  prompt: "训练服务返回失败状态时不能视为可交付。",
  assets: [{ kind: "brand", name: "failed-training-look.png", mimeType: "image/png", sourceUrl: validAssetPng, note: "moss green silk" }],
  options: { trendKeywords: ["moss green"], marketVariants: 1, trainBrandProfile: true },
});
process.env.BRAND_TRAINING_API_URL = "https://brand.example.test/failed-status";
process.env.BRAND_TRAINING_API_KEY = "brand-test-key";
globalThis.fetch = async (url) => {
  if (String(url) === "https://example.test/failed-status-image.png") return pngDownloadResponse();
  if (String(url) === "https://brand.example.test/failed-status") {
    return new Response(
      JSON.stringify({
        training_job_id: "train_brand_failed_001",
        status: "failed",
        error: "dataset quality below threshold",
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }
  return new Response(JSON.stringify({ data: [{ url: "https://example.test/failed-status-image.png" }] }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
};
let failedBrandTrainingStatusError = null;
try {
  await materializeLiveImages(failedBrandTrainingStatusJob);
} catch (error) {
  failedBrandTrainingStatusError = error;
}
assert.match(failedBrandTrainingStatusError?.message || "", /品牌训练服务返回失败状态：failed/);
markWorkflowJobFailed(failedBrandTrainingStatusJob.userId, failedBrandTrainingStatusJob.id, failedBrandTrainingStatusError);
const failedBrandTrainingDashboard = getWorkflowDashboard(userId);
const failedBrandTrainingProfile = failedBrandTrainingDashboard.brandProfiles.find((profile) => profile.jobId === failedBrandTrainingStatusJob.id);
assert.equal(failedBrandTrainingProfile.status, "failed");
assert.equal(failedBrandTrainingProfile.dna.failureEvidence.reason, failedBrandTrainingStatusError.message);
assert.equal(failedBrandTrainingDashboard.summary.activeBrandProfiles, 2);
delete process.env.BRAND_TRAINING_API_URL;
delete process.env.BRAND_TRAINING_API_KEY;
globalThis.fetch = originalFetch;

const brandTrainingTimeoutJob = createWorkflowJob({
  userId,
  type: "trend-brand-lab",
  title: "品牌训练服务超时",
  prompt: "品牌训练提交不能无限挂起。",
  assets: [{ kind: "brand", name: "brand-timeout.png", mimeType: "image/png", sourceUrl: validAssetPng, note: "moss green silk" }],
  options: { trendKeywords: ["moss green"], marketVariants: 1, trainBrandProfile: true },
});
process.env.BRAND_TRAINING_API_URL = "https://brand.example.test/timeout";
process.env.BRAND_TRAINING_API_KEY = "brand-test-key";
process.env.BRAND_TRAINING_TIMEOUT_MS = "100";
globalThis.fetch = async (url, init = {}) => {
  if (String(url) === "https://example.test/brand-timeout-image.png") return pngDownloadResponse();
  if (String(url) === "https://brand.example.test/timeout") return hangingResponse(init);
  return new Response(JSON.stringify({ data: [{ url: "https://example.test/brand-timeout-image.png" }] }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
};
await assert.rejects(() => materializeLiveImages(brandTrainingTimeoutJob), /品牌训练服务请求超时/);
globalThis.fetch = originalFetch;
delete process.env.BRAND_TRAINING_API_URL;
delete process.env.BRAND_TRAINING_API_KEY;
delete process.env.BRAND_TRAINING_TIMEOUT_MS;

sqlite.close();
await fs.rm(tmpDir, { recursive: true, force: true });

console.log(JSON.stringify({ checks: "passed" }, null, 2));
