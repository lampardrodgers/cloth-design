/**
 * Seedance 模块（火山方舟视频生成）：
 * 1) 进程内测纯函数：模型能力矩阵、参数规范化、方舟请求组装、素材分类、后台设置；
 * 2) 起一个假的方舟 API（绝不碰真接口、不产生费用），整条链路走一遍：
 *    权限 → 总览 → 素材上传 / 公网暴露 → 建任务 → 轮询 → 回传成片 → Range 播放 → 尾帧接力 → 取消 / 删除 → 各种失败 → 后台配置。
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

function waitForOutput(child, pattern) {
  return new Promise((resolve, reject) => {
    let stderr = "";
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${pattern}\n${stderr}`)), 20000);
    const onData = (chunk) => {
      if (!pattern.test(String(chunk))) return;
      clearTimeout(timer);
      child.stdout.off("data", onData);
      resolve();
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`App exited before startup: ${code}\n${stderr}`));
    });
  });
}

function appendCookies(jar, response) {
  for (const item of response.headers.getSetCookie?.() || []) {
    const cookie = item.split(";", 1)[0];
    if (cookie) jar.set(cookie.split("=", 1)[0], cookie);
  }
}

async function request(baseUrl, jar, pathname, init = {}) {
  const headers = new Headers(init.headers || {});
  headers.set("Origin", baseUrl);
  if (jar.size) headers.set("Cookie", [...jar.values()].join("; "));
  const response = await fetch(`${baseUrl}${pathname}`, { ...init, headers });
  appendCookies(jar, response);
  return response;
}

async function assertOk(response, expectedStatus = 200) {
  if (response.status === expectedStatus) return response;
  throw new Error(`${response.status}: ${await response.text()}`);
}

function jsonBody(value) {
  return { headers: { "Content-Type": "application/json" }, body: JSON.stringify(value) };
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForTask(baseUrl, jar, id, predicate, { timeoutMs = 15000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    const response = await request(baseUrl, jar, `/api/seedance/tasks/${id}`);
    await assertOk(response);
    last = (await response.json()).task;
    if (predicate(last)) return last;
    await sleep(120);
  }
  throw new Error(`任务 ${id} 没等到预期状态：${JSON.stringify(last)}`);
}

async function uploadRef(baseUrl, jar, { name, type, buffer }) {
  const form = new FormData();
  form.append("file", new Blob([buffer], { type }), name);
  return request(baseUrl, jar, "/api/seedance/refs", { method: "POST", body: form });
}

const pngSquare = await sharp({ create: { width: 640, height: 640, channels: 3, background: { r: 220, g: 200, b: 180 } } }).png().toBuffer();
const pngTiny = await sharp({ create: { width: 100, height: 100, channels: 3, background: { r: 10, g: 10, b: 10 } } }).png().toBuffer();
const pngWide = await sharp({ create: { width: 3000, height: 600, channels: 3, background: { r: 10, g: 10, b: 10 } } }).png().toBuffer();
// 假 mp4：只要开头像个 ISO BMFF 就行，谁也不会真去解码。
const fakeMp3 = Buffer.concat([Buffer.from("ID3"), Buffer.alloc(2048, 1)]);
/** 假方舟回的成片：有 ffmpeg 就真做一段 1 秒的小视频（分段接力要拿它来拼），没有就给个只有文件头的假 mp4。 */
const { spawnSync } = await import("node:child_process");
const sample = await (async () => {
  const stub = Buffer.concat([Buffer.from([0, 0, 0, 0x1c]), Buffer.from("ftypisom"), Buffer.alloc(4096, 7)]);
  const probe = spawnSync(process.env.FFMPEG_BIN || "ffmpeg", ["-version"], { encoding: "utf8" });
  if (probe.error || probe.status !== 0) return { buffer: stub, real: false };
  const out = path.join(os.tmpdir(), `clothdesign-seedance-sample-${process.pid}.mp4`);
  const made = spawnSync(process.env.FFMPEG_BIN || "ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=black:s=320x320:r=24:d=3", "-f", "lavfi", "-i", "anullsrc=r=44100:cl=mono", "-shortest", "-pix_fmt", "yuv420p", "-c:v", "libx264", "-c:a", "aac", "-movflags", "+faststart", out], { encoding: "utf8" });
  if (made.status !== 0) return { buffer: stub, real: false };
  const buffer = await fs.readFile(out);
  await fs.rm(out, { force: true });
  return { buffer, real: true };
})();
const fakeMp4 = sample.buffer;
const ffmpegReady = sample.real;
if (!ffmpegReady) console.warn("[seedance-test] 没找到 ffmpeg，分段接力的合并断言会跳过");
// 假方舟里这一个模型对这把 Key「没权限」：真方舟的 API Key 可以限定资源范围，越界时回 AuthenticationError 而不是 ModelNotOpen。
const RESTRICTED_MODEL = "doubao-seedance-1-0-pro-fast-251015";

/* ── 进程内：纯函数 ──────────────────────────────────────────────────────── */

const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "clothdesign-seedance-"));
process.env.DATABASE_URL = `file:${path.join(tmpDir, "unit.db")}`;
process.env.SEEDANCE_ASSET_DIR = path.join(tmpDir, "unit-assets");
process.env.SEEDANCE_API_KEY = "sk-unit-ark-key-0000";
process.env.PUBLIC_APP_URL = "https://example.test";
const { migrateBusinessDatabase } = await import("../server/db.mjs");
migrateBusinessDatabase();
const seedance = await import("../server/seedance.mjs");
seedance.migrateSeedanceDatabase();
const settings = await import("../server/seedance-settings.mjs");

// 目录：7 个官方文档里列出的模型，各自的能力别写串
assert.equal(seedance.SEEDANCE_MODELS.length, 7);
const byId = Object.fromEntries(seedance.SEEDANCE_MODELS.map((model) => [model.id, model]));
assert.deepEqual(byId["doubao-seedance-2-5-260628"].resolutions, ["480p", "720p", "1080p"]);
assert.deepEqual(byId["doubao-seedance-2-0-260128"].resolutions, ["480p", "720p", "1080p", "4k"], "只有 2.0 能出 4K");
assert.deepEqual(byId["doubao-seedance-2-0-fast-260128"].resolutions, ["480p", "720p"]);
assert.equal(byId["doubao-seedance-2-5-260628"].omni.images, 30);
assert.equal(byId["doubao-seedance-2-0-mini-260615"].omni.images, 9);
assert.equal(byId["doubao-seedance-1-5-pro-251215"].draft, true);
assert.equal(byId["doubao-seedance-1-0-pro-250528"].frames, true);
assert.equal(byId["doubao-seedance-1-0-pro-250528"].audio, false, "1.0 系列无声");
assert.equal(byId["doubao-seedance-1-0-pro-fast-251015"].lastFrame, false, "1.0 pro fast 只支持首帧");
assert.deepEqual(byId["doubao-seedance-2-5-260628"].outputFormats, ["mp4", "mov"]);
assert.equal(byId["doubao-seedance-2-5-260628"].omniTaskType, true);
assert.equal(byId["doubao-seedance-2-0-260128"].omniTaskType, false);
assert(seedance.SEEDANCE_RATIOS.some((item) => item.id === "21:9") && seedance.SEEDANCE_RATIOS.some((item) => item.id === "adaptive"));

// 规范化：按模型能力裁剪
const unit = (body) => seedance.normalizeSeedanceRequest(body, { userId: "u1" });
const expect400 = (body, pattern) => {
  try {
    unit(body);
  } catch (error) {
    assert(error instanceof seedance.SeedanceValidationError, `要是 ValidationError：${error.message}`);
    assert.match(error.message, pattern);
    return;
  }
  throw new Error(`应该拒绝：${JSON.stringify(body)}`);
};
const t25 = unit({ model: "doubao-seedance-2-5-260628", mode: "text", prompt: "一只猫", ratio: "9:16", duration: 6, priority: 3, webSearch: true, outputFormat: "mov" });
assert.equal(t25.resolution, "720p");
assert.equal(t25.generateAudio, true, "2.5 默认有声");
assert.equal(t25.priority, 3);
expect400({ model: "doubao-seedance-1-0-pro-250528", mode: "text", prompt: "x", ratio: "adaptive" }, /画幅不支持/);
expect400({ model: "doubao-seedance-2-0-fast-260128", mode: "text", prompt: "x", resolution: "1080p" }, /分辨率不支持/);
expect400({ model: "doubao-seedance-2-5-260628", mode: "text", prompt: "x", duration: 31 }, /4–30/);
expect400({ model: "doubao-seedance-1-0-pro-250528", mode: "text", prompt: "x", duration: -1 }, /不支持智能时长/);
expect400({ model: "doubao-seedance-1-0-pro-250528", mode: "text", prompt: "x", frames: 30 }, /25 \+ 4n/);
expect400({ model: "doubao-seedance-1-5-pro-251215", mode: "omni", prompt: "x" }, /生成方式不支持/);
expect400({ model: "doubao-seedance-2-5-260628", mode: "omni", prompt: "x", references: [] }, /至少要给一个/);
expect400({ model: "doubao-seedance-2-0-260128", mode: "omni", prompt: "x", references: [{ kind: "audio", url: "https://a/b.mp3" }] }, /不能只给音频/);
expect400({ model: "doubao-seedance-2-5-260628", mode: "omni", prompt: "x", omniTaskType: "edit", references: [{ kind: "image", url: "https://a/b.png" }] }, /至少要给一个参考视频/);
expect400({ model: "doubao-seedance-1-0-pro-fast-251015", mode: "image", firstFrame: { url: "https://a/1.png" }, lastFrame: { url: "https://a/2.png" } }, /不支持尾帧/);
expect400({ model: "doubao-seedance-2-5-260628", mode: "image" }, /首帧还没选/);
expect400({ model: "doubao-seedance-2-5-260628", mode: "text", prompt: "" }, /先写提示词/);
expect400({ model: "doubao-seedance-2-5-260628", mode: "text", prompt: "x", count: 9 }, /条数要在/);
expect400({ model: "doubao-seedance-2-0-260128", mode: "omni", prompt: "x", references: Array.from({ length: 10 }, () => ({ kind: "image", url: "https://a/b.png" })) }, /最多 9 张参考图/);
expect400({ model: "no-such-model", mode: "text", prompt: "x" }, /不在可选范围/);
expect400({ model: "doubao-seedance-2-5-260628", mode: "image", firstFrame: { url: "ftp://a/1.png" } }, /http\(s\)/);
expect400({ model: "doubao-seedance-2-5-260628", mode: "image", firstFrame: { refId: "0".repeat(32) } }, /不存在或不是你的/);
const i25 = unit({ model: "doubao-seedance-2-5-260628", mode: "image", firstFrame: { url: "https://a/1.png" }, ratio: "16:9" });
assert.equal(i25.ratio, "adaptive", "2.5 首帧生视频只能 adaptive");
assert.equal(i25.ratioLocked, true);
const i20 = unit({ model: "doubao-seedance-2-0-260128", mode: "image", firstFrame: { url: "https://a/1.png" }, ratio: "16:9" });
assert.equal(i20.ratio, "16:9", "2.0 首帧生视频可以指定画幅");
const edit = unit({ model: "doubao-seedance-2-5-260628", mode: "omni", prompt: "把@视频1 调黑白", omniTaskType: "edit", duration: 8, references: [{ kind: "video", url: "https://a/v.mp4" }] });
assert.equal(edit.duration, -1, "编辑任务时长只能 -1");
assert.equal(edit.ratio, "adaptive");
const draft = unit({ model: "doubao-seedance-1-5-pro-251215", mode: "text", prompt: "x", draft: true, resolution: "1080p", returnLastFrame: true });
assert.equal(draft.resolution, "480p", "样片只能 480p");
assert.equal(draft.returnLastFrame, false, "样片不能返回尾帧");
const t10 = unit({ model: "doubao-seedance-1-0-pro-250528", mode: "text", prompt: "x" });
assert.equal(t10.ratio, "16:9", "1.0 文生视频默认 16:9");
assert.equal(t10.resolution, "1080p");
assert.equal(t10.generateAudio, false);
const omni20 = unit({ model: "doubao-seedance-2-0-260128", mode: "omni", prompt: "x", omniTaskType: "edit", references: [{ kind: "image", url: "https://a/b.png" }] });
assert.equal(omni20.omniTaskType, null, "2.0 没有 omni_reference_task_type，传了也忽略");

// 方舟请求：不支持的字段别发；safety_identifier 是账号哈希
const payload25 = await seedance.arkPayloadFor(t25, { userId: "u1" });
assert.deepEqual(payload25.content, [{ type: "text", text: "一只猫" }]);
assert.equal(payload25.generate_audio, true);
assert.equal(payload25.output_format, "mov");
assert.equal(payload25.priority, 3);
assert.deepEqual(payload25.tools, [{ type: "web_search" }]);
assert.equal("seed" in payload25, false, "2.5 不支持 seed");
assert.equal("camera_fixed" in payload25, false);
assert.match(payload25.safety_identifier, /^[a-f0-9]{48}$/);
const payload10 = await seedance.arkPayloadFor(unit({ model: "doubao-seedance-1-0-pro-250528", mode: "image", firstFrame: { url: "https://a/1.png" }, frames: 57, seed: 42, cameraFixed: true, serviceTier: "flex", generateAudio: true }), { userId: "u1" });
assert.equal(payload10.frames, 57);
assert.equal("duration" in payload10, false, "给了帧数就不传秒数");
assert.equal(payload10.seed, 42);
assert.equal(payload10.camera_fixed, true);
assert.equal(payload10.service_tier, "flex");
assert.equal("generate_audio" in payload10, false, "1.0 不支持有声");
assert.deepEqual(payload10.content[0], { type: "image_url", image_url: { url: "https://a/1.png" }, role: "first_frame" });
const payloadEdit = await seedance.arkPayloadFor(edit, { userId: "u1" });
assert.equal(payloadEdit.omni_reference_task_type, "edit");
assert.equal(payloadEdit.duration, -1);
assert.equal(payloadEdit.content[1].role, "reference_video");
const payloadFinal = await seedance.arkPayloadFor(unit({ model: "doubao-seedance-1-5-pro-251215", draftTaskId: "cgt-2026-abc" }), { userId: "u1" });
assert.deepEqual(payloadFinal.content, [{ type: "draft_task", draft_task: { id: "cgt-2026-abc" } }]);
assert.equal("ratio" in payloadFinal, false, "出正式版时方舟复用样片参数，别再传画幅 / 时长");
assert.equal("duration" in payloadFinal, false);

// 中间帧：2.x 默认参考图一镜到底；1.0 pro 只能分段；1.0 pro fast 两条路都走不通；分段时 count 强制 1
const kf25 = unit({ model: "doubao-seedance-2-5-260628", mode: "image", firstFrame: { url: "https://a/1.png" }, middleFrames: [{ url: "https://a/2.png" }, { url: "https://a/3.png" }], lastFrame: { url: "https://a/4.png" }, count: 3 });
assert.equal(kf25.keyframeStrategy, "reference");
assert.equal(kf25.middleFrames.length, 2);
assert.equal(kf25.count, 3, "一镜到底还是一条任务，count 照用");
const kf10 = unit({ model: "doubao-seedance-1-0-pro-250528", mode: "image", firstFrame: { url: "https://a/1.png" }, middleFrames: [{ url: "https://a/2.png" }], count: 3 });
assert.equal(kf10.keyframeStrategy, "segments", "1.0 没有参考图，只能分段");
assert.equal(kf10.count, 1, "分段接力本身就是多条，不再乘 count");
expect400({ model: "doubao-seedance-1-0-pro-250528", mode: "image", firstFrame: { url: "https://a/1.png" }, middleFrames: [{ url: "https://a/2.png" }], keyframeStrategy: "reference" }, /不支持参考图/);
expect400({ model: "doubao-seedance-1-0-pro-fast-251015", mode: "image", firstFrame: { url: "https://a/1.png" }, middleFrames: [{ url: "https://a/2.png" }] }, /不支持尾帧/);
expect400({ model: "doubao-seedance-2-5-260628", mode: "image", firstFrame: { url: "https://a/1.png" }, middleFrames: Array.from({ length: 8 }, () => ({ url: "https://a/2.png" })) }, /中间帧最多 7 张/);
expect400({ model: "doubao-seedance-2-5-260628", mode: "image", firstFrame: { url: "https://a/1.png" }, middleFrames: [{ url: "https://a/2.png" }], keyframeStrategy: "nope" }, /中间帧方式不支持/);
const kfPayload = await seedance.arkPayloadFor(kf25, { userId: "u1" });
assert.equal(kfPayload.content.length, 5, "提示词 + 4 张参考图");
assert.equal(kfPayload.content[0].type, "text");
assert.match(kfPayload.content[0].text, /^@图像1 是视频的第一帧画面；随后依次经过 @图像2、@图像3 的画面；@图像4 是视频的最后一帧画面/);
assert(kfPayload.content.slice(1).every((item) => item.role === "reference_image"), "一镜到底全是 reference_image，不混 first_frame");
assert.deepEqual(kfPayload.content.slice(1).map((item) => item.image_url.url), ["https://a/1.png", "https://a/2.png", "https://a/3.png", "https://a/4.png"]);
assert.equal("omni_reference_task_type" in kfPayload, false);
assert.match(seedance.keyframePrompt(3, false, "镜头缓慢推进"), /@图像1 是视频的第一帧画面；随后依次经过 @图像2、@图像3 的画面。[^\n]*\n镜头缓慢推进$/);
assert.equal(seedance.keyframePrompt(2, true).includes("随后依次经过"), false, "只有首尾两张就没有「经过」");
assert(seedance.seedanceOptions().keyframeStrategies.map((item) => item.id).join(",") === "reference,segments");
assert.deepEqual(seedance.seedanceOptions().limits.retention, { uploadHours: 24, outputDays: 3 });

// 素材分类
assert.deepEqual(seedance.classifyRefFile("a.JPG", "image/jpeg"), { kind: "image", ext: "jpg" });
assert.deepEqual(seedance.classifyRefFile("clip.mov", "video/quicktime"), { kind: "video", ext: "mov" });
assert.deepEqual(seedance.classifyRefFile("voice.wav", "audio/wav"), { kind: "audio", ext: "wav" });
assert.deepEqual(seedance.classifyRefFile("blob", "image/webp"), { kind: "image", ext: "webp" }, "没扩展名看 MIME");
assert.equal(seedance.classifyRefFile("x.exe", "application/octet-stream"), null);

// 后台设置：Key 加密落库，视图里不出明文
const saved = settings.saveSeedanceSettings({ apiKey: "VxCgNvLTE.secret-part.signature-part", defaultModel: "doubao-seedance-2-0-fast-260128", maxActivePerUser: "3", enabledModels: ["doubao-seedance-2-0-fast-260128", "doubao-seedance-2-5-260628"] }, { knownModels: seedance.SEEDANCE_MODELS.map((model) => model.id) });
assert.equal(saved.error, undefined, saved.error);
assert.equal(saved.settings.apiKeyConfigured, true);
assert.equal(saved.settings.apiKeySource, "admin");
assert.equal(saved.settings.apiKeyHint, "VxC…part");
assert.equal(JSON.stringify(saved.settings).includes("secret-part"), false, "视图里不能有明文 Key");
assert.equal(settings.seedanceSettings().apiKey, "VxCgNvLTE.secret-part.signature-part");
assert.equal(seedance.seedanceEnabledModels().length, 2);
assert.equal(seedance.seedanceOptions().defaultModel, "doubao-seedance-2-0-fast-260128");
expect400({ model: "doubao-seedance-1-0-pro-250528", mode: "text", prompt: "x" }, /不在可选范围/);
assert.match(settings.saveSeedanceSettings({ enabledModels: ["nope"] }, { knownModels: ["a"] }).error, /不认识的模型/);
assert.match(settings.saveSeedanceSettings({ baseUrl: "not a url" }).error, /不是合法的 URL/);
assert.match(settings.saveSeedanceSettings({ maxActivePerUser: "99" }).error, /1–10/);
settings.saveSeedanceSettings({ apiKey: "", defaultModel: "", maxActivePerUser: "", enabledModels: "" });
assert.equal(settings.seedanceSettings().apiKeySource, "env");
assert.equal(seedance.seedanceEnabledModels().length, 7);
assert.equal(seedance.publicMediaBaseUrl(), "https://example.test");
settings.saveSeedanceSettings({ publicBaseUrl: "http://127.0.0.1:8888" });
assert.equal(seedance.publicMediaBaseUrl(), "", "回环地址不算公网");
settings.saveSeedanceSettings({ publicBaseUrl: "" });

// 到期清理：素材 24 小时、成片 3 天（记录留着、标 expired），还被在跑任务引用的素材先不动
{
  const { sqlite, nowIso } = await import("../server/db.mjs");
  const unitAssets = process.env.SEEDANCE_ASSET_DIR;
  const DAY = 24 * 60 * 60 * 1000;
  const ago = (ms) => new Date(Date.now() - ms).toISOString();
  const refRow = (id, createdAt) => {
    sqlite
      .prepare("INSERT INTO seedance_ref (id, user_id, kind, ext, mime, original_name, bytes, source, created_at) VALUES (?, 'u1', 'image', 'png', 'image/png', ?, 4, 'upload', ?)")
      .run(id, `${id}.png`, createdAt);
  };
  await fs.mkdir(path.join(unitAssets, "refs"), { recursive: true });
  await fs.mkdir(path.join(unitAssets, "tmp"), { recursive: true });
  const oldRef = "a".repeat(32);
  const freshRef = "b".repeat(32);
  const busyRef = "c".repeat(32);
  for (const id of [oldRef, freshRef, busyRef]) await fs.writeFile(path.join(unitAssets, "refs", `${id}.png`), "png!");
  refRow(oldRef, ago(25 * 60 * 60 * 1000));
  refRow(freshRef, ago(60 * 60 * 1000));
  refRow(busyRef, ago(30 * 60 * 60 * 1000));
  const taskRow = (id, status, finishedAt, content = "[]") => {
    sqlite
      .prepare("INSERT INTO seedance_task (id, user_id, ark_task_id, model, mode, status, prompt, params_json, content_json, result_json, credits, created_at, updated_at, finished_at) VALUES (?, 'u1', ?, 'doubao-seedance-2-5-260628', 'image', ?, 'p', '{}', ?, ?, 0, ?, ?, ?)")
      .run(id, `cgt-${id}`, status, content, JSON.stringify({ video: { name: "video.mp4", bytes: 3, format: "mp4" } }), finishedAt || nowIso(), finishedAt || nowIso(), finishedAt);
  };
  taskRow("sd-old", "completed", ago(4 * DAY));
  taskRow("sd-fresh", "completed", ago(1 * DAY));
  taskRow("sd-running", "running", null, JSON.stringify([{ type: "image_url", role: "first_frame", refId: busyRef }]));
  for (const id of ["sd-old", "sd-fresh"]) {
    await fs.mkdir(path.join(unitAssets, "tasks", id), { recursive: true });
    await fs.writeFile(path.join(unitAssets, "tasks", id, "video.mp4"), "mp4");
  }
  await fs.writeFile(path.join(unitAssets, "tmp", "stale.upload"), "x");
  await fs.utimes(path.join(unitAssets, "tmp", "stale.upload"), new Date(Date.now() - 2 * DAY), new Date(Date.now() - 2 * DAY));
  const dry = await seedance.runSeedanceMaintenance({ dryRun: true });
  assert.equal(dry.expiredTasks, 1);
  assert.equal(dry.refsDeleted, 1, "只清超过 24 小时且没被在跑任务引用的素材");
  await fs.access(path.join(unitAssets, "refs", `${oldRef}.png`));
  const summary = await seedance.runSeedanceMaintenance();
  assert.equal(summary.expiredTasks, 1);
  assert.equal(summary.refsDeleted, 1);
  assert.equal(summary.tmpDeleted, 1);
  await assert.rejects(fs.access(path.join(unitAssets, "refs", `${oldRef}.png`)), "24 小时前上传的素材要删掉");
  await fs.access(path.join(unitAssets, "refs", `${freshRef}.png`));
  await fs.access(path.join(unitAssets, "refs", `${busyRef}.png`)); // 在跑任务还引用着的素材先留着
  await assert.rejects(fs.access(path.join(unitAssets, "tasks", "sd-old", "video.mp4")), "3 天前的成片文件要删掉");
  await fs.access(path.join(unitAssets, "tasks", "sd-fresh", "video.mp4"));
  const expired = sqlite.prepare("SELECT storage_status, expired_at FROM seedance_task WHERE id = 'sd-old'").get();
  assert.equal(expired.storage_status, "expired");
  assert(expired.expired_at, "记录留着、标过期");
  const view = seedance.serializeSeedanceTask(sqlite.prepare("SELECT * FROM seedance_task WHERE id = 'sd-old'").get());
  assert.equal(view.result.video, null, "过期后不再给出文件地址");
  assert.equal(view.storage.status, "expired");
  const fresh = seedance.serializeSeedanceTask(sqlite.prepare("SELECT * FROM seedance_task WHERE id = 'sd-fresh'").get());
  assert.equal(fresh.storage.status, "cloud-temp");
  assert(fresh.storage.expiresAt && Date.parse(fresh.storage.expiresAt) > Date.now(), "还没到期的成片带着到期时间");
  sqlite.exec("DELETE FROM seedance_task; DELETE FROM seedance_ref");
}

// 文案成片的到期清理：上传的素材 / 音乐 24 小时（引擎在本机就直接删文件，自带歌曲不动），成片 3 天，引擎 tasks 目录的旧任务
{
  const { sqlite, nowIso } = await import("../server/db.mjs");
  const shortvideo = await import("../server/shortvideo.mjs");
  shortvideo.migrateShortVideoDatabase();
  const DAY = 24 * 60 * 60 * 1000;
  const engineDir = path.join(tmpDir, "engine");
  process.env.SHORTVIDEO_ENGINE_DIR = engineDir;
  process.env.SHORTVIDEO_ASSET_DIR = path.join(tmpDir, "unit-shortvideo");
  await fs.mkdir(path.join(engineDir, "storage", "local_videos"), { recursive: true });
  await fs.mkdir(path.join(engineDir, "resource", "songs"), { recursive: true });
  await fs.mkdir(path.join(engineDir, "storage", "tasks", "engine-old"), { recursive: true });
  await fs.mkdir(path.join(engineDir, "storage", "tasks", "engine-busy"), { recursive: true });
  const old = new Date(Date.now() - 2 * DAY);
  const touchOld = async (file, content = "x") => {
    await fs.writeFile(file, content);
    await fs.utimes(file, old, old);
  };
  await touchOld(path.join(engineDir, "storage", "local_videos", "tracked-old.mp4"));
  await touchOld(path.join(engineDir, "storage", "local_videos", "untracked-old.mp4"));
  await fs.writeFile(path.join(engineDir, "storage", "local_videos", "untracked-fresh.mp4"), "x");
  await touchOld(path.join(engineDir, "resource", "songs", "output000.mp3"), "bundled");
  await touchOld(path.join(engineDir, "resource", "songs", "uploaded-old.mp3"));
  await touchOld(path.join(engineDir, "storage", "tasks", "engine-old", "final-1.mp4"));
  await fs.utimes(path.join(engineDir, "storage", "tasks", "engine-old"), old, old);
  await touchOld(path.join(engineDir, "storage", "tasks", "engine-busy", "final-1.mp4"));
  await fs.utimes(path.join(engineDir, "storage", "tasks", "engine-busy"), old, old);
  const ins = sqlite.prepare("INSERT INTO shortvideo_upload (id, user_id, kind, file, original_name, bytes, created_at) VALUES (?, 'u1', ?, ?, ?, 1, ?)");
  ins.run("up1", "material", "tracked-old.mp4", "素材.mp4", new Date(Date.now() - 25 * 3600000).toISOString());
  ins.run("up2", "music", "uploaded-old.mp3", "bgm.mp3", new Date(Date.now() - 25 * 3600000).toISOString());
  ins.run("up3", "music", "output000.mp3", "不该被登记但万一", new Date().toISOString());
  sqlite
    .prepare("INSERT INTO shortvideo_task (id, user_id, engine_task_id, status, progress, stage, subject, script, terms_json, params_json, result_json, credits, created_at, updated_at, finished_at) VALUES (?, 'u1', ?, ?, 100, 'done', 's', 's', '[]', '{}', ?, 0, ?, ?, ?)")
    .run("sv-old", "engine-old", "completed", JSON.stringify({ videos: [{ name: "final-1.mp4", bytes: 1 }] }), nowIso(), nowIso(), new Date(Date.now() - 4 * DAY).toISOString());
  sqlite
    .prepare("INSERT INTO shortvideo_task (id, user_id, engine_task_id, status, progress, stage, subject, script, terms_json, params_json, result_json, credits, created_at, updated_at) VALUES (?, 'u1', ?, 'running', 50, 'render', 's', 's', '[]', '{}', '{}', 0, ?, ?)")
    .run("sv-busy", "engine-busy", nowIso(), nowIso());
  await fs.mkdir(path.join(process.env.SHORTVIDEO_ASSET_DIR, "sv-old"), { recursive: true });
  await fs.writeFile(path.join(process.env.SHORTVIDEO_ASSET_DIR, "sv-old", "final-1.mp4"), "mp4");
  const summary = await shortvideo.runShortVideoMaintenance();
  assert.equal(summary.engineLocal, true);
  assert.equal(summary.expiredTasks, 1);
  assert.equal(summary.uploadsDeleted, 2, "登记过、超过 24 小时的两个上传");
  assert.equal(summary.uploadsUntracked, 1, "local_videos 里没登记的旧文件也清");
  assert.equal(summary.engineTaskDirsDeleted, 1, "引擎里旧任务目录清掉，在跑的留着");
  await assert.rejects(fs.access(path.join(engineDir, "storage", "local_videos", "tracked-old.mp4")));
  await assert.rejects(fs.access(path.join(engineDir, "storage", "local_videos", "untracked-old.mp4")));
  await fs.access(path.join(engineDir, "storage", "local_videos", "untracked-fresh.mp4"));
  await assert.rejects(fs.access(path.join(engineDir, "resource", "songs", "uploaded-old.mp3")));
  await fs.access(path.join(engineDir, "resource", "songs", "output000.mp3")); // 引擎自带的歌不能动
  await assert.rejects(fs.access(path.join(engineDir, "storage", "tasks", "engine-old")));
  await fs.access(path.join(engineDir, "storage", "tasks", "engine-busy"));
  await assert.rejects(fs.access(path.join(process.env.SHORTVIDEO_ASSET_DIR, "sv-old", "final-1.mp4")));
  const row = sqlite.prepare("SELECT storage_status, expired_at FROM shortvideo_task WHERE id = 'sv-old'").get();
  assert.equal(row.storage_status, "expired");
  assert(row.expired_at);
  assert.equal(shortvideo.serializeShortVideoTask(sqlite.prepare("SELECT * FROM shortvideo_task WHERE id = 'sv-old'").get()).result.videos.length, 0);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS c FROM shortvideo_upload").get().c, 1, "没到期的登记留着");
  sqlite.exec("DELETE FROM shortvideo_task; DELETE FROM shortvideo_upload");
  delete process.env.SHORTVIDEO_ENGINE_DIR;
}

/* ── 假方舟 ─────────────────────────────────────────────────────────────── */

const ARK_KEY = "sk-ark-test-key-0000";
const arkTasks = new Map();
const arkLog = [];
let arkSeq = 0;

function arkJson(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

const ark = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  const auth = req.headers.authorization || "";
  arkLog.push({ method: req.method, path: url.pathname, auth });
  if (url.pathname.startsWith("/files/")) {
    if (url.pathname.endsWith(".mp4")) {
      res.writeHead(200, { "Content-Type": "video/mp4" });
      res.end(fakeMp4);
    } else {
      res.writeHead(200, { "Content-Type": "image/png" });
      res.end(pngSquare);
    }
    return;
  }
  if (auth !== `Bearer ${ARK_KEY}`) {
    arkJson(res, 401, { error: { code: "AuthenticationError", message: "The API key format is incorrect. Request id: 0217871463875898", param: "", type: "Unauthorized" } });
    return;
  }
  if (req.method === "GET" && url.pathname === "/api/v3/models") {
    arkJson(res, 200, {
      data: [
        { id: "doubao-seed-2-1-turbo-260628", name: "doubao-seed-2-1-turbo", object: "model", modalities: { input_modalities: ["text"], output_modalities: ["text"] } },
        { id: "doubao-seedance-2-5-260628", name: "doubao-seedance-2-5", object: "model", domain: "VideoGeneration", modalities: { input_modalities: ["text", "image", "video", "audio"], output_modalities: ["video"] }, task_type: ["MultimodalToVideo"], version: "260628" },
        { id: "doubao-seedance-1-5-pro-251215", name: "doubao-seedance-1-5-pro", object: "model", domain: "VideoGeneration", status: "Retiring", modalities: { input_modalities: ["text", "image"], output_modalities: ["video"] }, task_type: ["TextToVideo"], version: "251215" },
        { id: "doubao-seaweed-241128", name: "doubao-seaweed", object: "model", domain: "VideoGeneration", status: "Shutdown", modalities: { input_modalities: ["text"], output_modalities: ["video"] }, task_type: [], version: "241128" },
      ],
    });
    return;
  }
  if (req.method === "GET" && url.pathname === "/api/v3/contents/generations/tasks") {
    arkJson(res, 200, { total: arkTasks.size, items: [...arkTasks.values()].slice(0, Number(url.searchParams.get("page_size") || 20)) });
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/v3/contents/generations/tasks") {
    const body = JSON.parse((await readBody(req)).toString("utf8") || "{}");
    arkLog.at(-1).payload = body;
    if (!body.model) {
      arkJson(res, 400, { error: { code: "MissingParameter", message: "The request failed because it is missing `model` parameter. Request id: 0217871", param: "", type: "Bad Request" } });
      return;
    }
    if (body.model === RESTRICTED_MODEL) {
      arkJson(res, 401, { error: { code: "AuthenticationError", message: "The API key or AK/SK in the request is missing or invalid. Request id: 0217871521440685e05", param: "", type: "Unauthorized" } });
      return;
    }
    if (!Array.isArray(body.content) || !body.content.length) {
      arkJson(res, 400, { error: { code: "MissingParameter", message: "The request failed because it is missing `content` parameter. Request id: 0217871", param: "", type: "Bad Request" } });
      return;
    }
    const text = body.content?.find((item) => item.type === "text")?.text || "";
    if (/MODELNOTOPEN/.test(text)) {
      arkJson(res, 400, { error: { code: "ModelNotOpen", message: "The model or endpoint doubao-seedance-2-5-260628 has not been activated. Request id: 0217871", type: "BadRequest" } });
      return;
    }
    if (/BADPARAM/.test(text)) {
      arkJson(res, 400, { error: { code: "InvalidParameter", message: "The parameter `ratio` specified in the request is not valid. Request id: 0217871", type: "BadRequest" } });
      return;
    }
    arkSeq += 1;
    const id = `cgt-2026081900000${arkSeq}-test`;
    arkTasks.set(id, {
      id,
      model: body.model,
      status: "queued",
      gets: 0,
      behavior: /FAIL/.test(text) ? "fail" : /SLOW/.test(text) ? "slow" : /RUNNING/.test(text) ? "running" : /LOST/.test(text) ? "lost" : "ok",
      request: body,
      created_at: Math.floor(Date.now() / 1000),
    });
    arkJson(res, 200, { id });
    return;
  }
  const taskMatch = /^\/api\/v3\/contents\/generations\/tasks\/([^/]+)$/.exec(url.pathname);
  if (taskMatch) {
    const task = arkTasks.get(decodeURIComponent(taskMatch[1]));
    if (!task) {
      arkJson(res, 404, { error: { code: "NotFound", message: "task not found", type: "NotFound" } });
      return;
    }
    if (req.method === "DELETE") {
      if (task.status === "queued") task.status = "cancelled";
      else if (task.status === "running") {
        arkJson(res, 400, { error: { code: "InvalidParameter", message: "running task cannot be cancelled", type: "BadRequest" } });
        return;
      } else arkTasks.delete(task.id);
      arkJson(res, 200, {});
      return;
    }
    task.gets += 1;
    if (task.behavior === "lost") {
      arkJson(res, 404, { error: { code: "NotFound", message: "task not found", type: "NotFound" } });
      return;
    }
    if (task.status === "queued" && task.gets >= 2 && task.behavior !== "slow") task.status = "running";
    if (task.status === "running" && task.gets >= 3 && task.behavior !== "running") {
      if (task.behavior === "fail") {
        task.status = "failed";
        task.error = { code: "OutputVideoSensitiveContentDetected", message: "The request failed because the output video may contain sensitive information." };
      } else {
        task.status = "succeeded";
        task.content = { video_url: `http://127.0.0.1:${arkPort}/files/${task.id}.mp4`, last_frame_url: task.request.return_last_frame ? `http://127.0.0.1:${arkPort}/files/${task.id}-last.png` : undefined };
        task.usage = { completion_tokens: 123456, total_tokens: 123456 };
        task.duration = task.request.duration && task.request.duration > 0 ? task.request.duration : 7;
        task.ratio = task.request.ratio === "adaptive" ? "9:16" : task.request.ratio;
        task.resolution = task.request.resolution;
        task.seed = 33608;
        task.framespersecond = 24;
        task.generate_audio = task.request.generate_audio ?? false;
        task.draft = task.request.draft ?? false;
        task.output_format = task.request.output_format || "mp4";
      }
    }
    const { gets, behavior, request: _request, ...view } = task;
    arkJson(res, 200, { ...view, error: task.error ?? null });
    return;
  }
  arkJson(res, 404, { error: { code: "NotFound", message: `no route ${url.pathname}`, type: "NotFound" } });
});
const arkPort = await listen(ark);

/* ── 起应用 ─────────────────────────────────────────────────────────────── */

const appPort = 23450 + Math.floor(Math.random() * 500);
const assetDir = path.join(tmpDir, "seedance-assets");
const app = spawn(process.execPath, ["server/index.mjs"], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    HOST: "127.0.0.1",
    PORT: String(appPort),
    DATABASE_URL: `file:${path.join(tmpDir, "app.db")}`,
    IMAGE_ASSET_DIR: path.join(tmpDir, "generated-images"),
    IMAGE_ASSET_PUBLIC_PATH: "/generated-images",
    VIDEO_ASSET_DIR: path.join(tmpDir, "generated-videos"),
    VIDEO_ASSET_PUBLIC_PATH: "/generated-videos",
    SHORTVIDEO_ASSET_DIR: path.join(tmpDir, "shortvideo-assets"),
    SEEDANCE_ASSET_DIR: assetDir,
    SEEDANCE_BASE_URL: `http://127.0.0.1:${arkPort}/api/v3/`,
    SEEDANCE_API_KEY: ARK_KEY,
    SEEDANCE_POLL_INTERVAL_MS: "100",
    SEEDANCE_MAX_ACTIVE_PER_USER: "2",
    AUTH_SECRET: "test-seedance-secret-1234567890",
    PUBLIC_APP_URL: `http://127.0.0.1:${appPort}`,
    NODE_ENV: "test",
    PAYMENT_DEMO_MODE: "true",
    ALLOW_PAYMENT_DEMO_API: "true",
    OPENAI_DEMO_MODE: "true",
  },
});

try {
  await waitForOutput(app, /ClothDesign AI running/);
  const baseUrl = `http://127.0.0.1:${appPort}`;
  const admin = new Map();
  const viewer = new Map();

  /* ── 权限：和短视频共用一把开关 ─────────────────────────────────────────── */
  let response = await request(baseUrl, admin, "/api/auth/sign-up/email", { method: "POST", ...jsonBody({ name: "Admin", email: "admin@example.test", password: "clothdesign123" }) });
  await assertOk(response);
  response = await request(baseUrl, admin, "/api/admin/users", { method: "POST", ...jsonBody({ username: "viewer", password: "clothdesign123" }) });
  await assertOk(response, 201);
  response = await request(baseUrl, viewer, "/api/auth/sign-in/email", { method: "POST", ...jsonBody({ email: "viewer@clothdesign.local", password: "clothdesign123" }) });
  await assertOk(response);
  response = await request(baseUrl, viewer, "/api/seedance/overview");
  assert.equal(response.status, 403, "普通账号打 Seedance 接口要吃 403");
  response = await request(baseUrl, viewer, "/api/seedance/tasks", { method: "POST", ...jsonBody({ prompt: "x" }) });
  assert.equal(response.status, 403);
  response = await request(baseUrl, viewer, "/api/admin/seedance");
  assert.equal(response.status, 403, "后台配置只有 admin 能看");
  response = await request(baseUrl, new Map(), "/api/seedance/overview");
  assert.equal(response.status, 401);

  /* ── 总览：方舟在线、目录齐全、公网地址因为是回环所以不可用 ─────────────── */
  response = await request(baseUrl, admin, "/api/seedance/overview");
  await assertOk(response);
  let overview = await response.json();
  assert.equal(overview.status.configured, true);
  assert.equal(overview.status.online, true);
  assert.equal(overview.status.keySource, "env");
  assert.equal(overview.status.publicMediaReady, false, "127.0.0.1 不算公网地址");
  assert.equal(overview.options.models.length, 7);
  assert.equal(overview.options.defaultModel, "doubao-seedance-2-5-260628");
  assert.equal(overview.options.limits.maxActivePerUser, 2);
  assert.deepEqual(overview.tasks, []);
  assert.deepEqual(overview.refs, []);
  assert(arkLog.some((entry) => entry.path === "/api/v3/contents/generations/tasks" && entry.method === "GET"), "探活只列任务");
  assert(!arkLog.some((entry) => entry.method === "POST"), "探活绝不能创建任务");

  /* ── 后台：读 / 改 / 测 ─────────────────────────────────────────────────── */
  response = await request(baseUrl, admin, "/api/admin/seedance");
  await assertOk(response);
  let adminView = await response.json();
  assert.equal(adminView.settings.apiKeySource, "env");
  assert.equal(adminView.settings.apiKeyConfigured, true);
  assert.equal(JSON.stringify(adminView).includes(ARK_KEY), false, "后台视图不能带明文 Key");
  assert.equal(adminView.models.length, 7);
  response = await request(baseUrl, admin, "/api/admin/seedance/test", { method: "POST" });
  await assertOk(response);
  const testResult = await response.json();
  assert.equal(testResult.ok, true);
  assert(testResult.models.some((model) => model.id === "doubao-seedance-2-5-260628" && model.inCatalog === true));
  assert(testResult.models.some((model) => model.id === "doubao-seaweed-241128" && model.status === "Shutdown" && model.inCatalog === false));
  assert(!testResult.models.some((model) => model.id === "doubao-seed-2-1-turbo-260628"), "只列视频模型");
  // 「测一下」会对每个模型发一个 content 为空、分辨率非法的探测请求：方舟一定先鉴权再校验参数，所以永远建不出任务。
  const probes = arkLog.filter((entry) => entry.method === "POST");
  assert.equal(probes.length, 7, "7 个模型各探一次权限");
  assert(probes.every((entry) => Array.isArray(entry.payload?.content) && entry.payload.content.length === 0 && entry.payload.resolution === "0p"), "探测请求注定被参数校验拦下");
  assert.equal(arkTasks.size, 0, "「测一下」不能创建任务");
  assert.equal(testResult.modelAccess.find((item) => item.model === RESTRICTED_MODEL)?.access, "unauthorized");
  assert.equal(testResult.modelAccess.filter((item) => item.access === "ok").length, 6);
  // 改默认模型 / 并发；Key 不传就不动
  response = await request(baseUrl, admin, "/api/admin/seedance/settings", { method: "PUT", ...jsonBody({ defaultModel: "doubao-seedance-2-0-fast-260128", maxActivePerUser: 2 }) });
  await assertOk(response);
  assert.equal((await response.json()).settings.defaultModel, "doubao-seedance-2-0-fast-260128");
  response = await request(baseUrl, admin, "/api/admin/seedance/settings", { method: "PUT", ...jsonBody({ maxActivePerUser: 42 }) });
  assert.equal(response.status, 400);
  response = await request(baseUrl, admin, "/api/admin/seedance/settings", { method: "PUT", ...jsonBody({ defaultModel: "" }) });
  await assertOk(response);

  /* ── 素材：上传 / 校验 / 私有与公网两种地址 / 越权 ─────────────────────── */
  response = await uploadRef(baseUrl, admin, { name: "首帧.png", type: "image/png", buffer: pngSquare });
  await assertOk(response);
  const imageRef = (await response.json()).ref;
  assert.equal(imageRef.kind, "image");
  assert.equal(imageRef.ext, "png");
  assert.equal(imageRef.name, "首帧.png", "中文文件名不能乱码");
  assert.equal(imageRef.width, 640);
  assert.match(imageRef.url, /^\/api\/seedance\/refs\/[a-f0-9]{32}\/file$/);
  response = await uploadRef(baseUrl, admin, { name: "tiny.png", type: "image/png", buffer: pngTiny });
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /300–6000 px/);
  response = await uploadRef(baseUrl, admin, { name: "wide.png", type: "image/png", buffer: pngWide });
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /宽高比/);
  response = await uploadRef(baseUrl, admin, { name: "evil.exe", type: "application/octet-stream", buffer: fakeMp3 });
  assert.equal(response.status, 400);
  response = await uploadRef(baseUrl, admin, { name: "clip.mp4", type: "video/mp4", buffer: fakeMp4 });
  await assertOk(response);
  const videoRef = (await response.json()).ref;
  assert.equal(videoRef.kind, "video");
  response = await uploadRef(baseUrl, admin, { name: "bgm.mp3", type: "audio/mpeg", buffer: fakeMp3 });
  await assertOk(response);
  const audioRef = (await response.json()).ref;
  assert.equal(audioRef.kind, "audio");

  response = await request(baseUrl, admin, imageRef.url);
  await assertOk(response);
  assert.equal(response.headers.get("content-type"), "image/png");
  response = await request(baseUrl, viewer, imageRef.url);
  assert.equal(response.status, 403, "没权限的账号连私有地址也不能看");
  response = await fetch(`${baseUrl}/api/seedance/refs/public/${imageRef.id}.png`);
  assert.equal(response.status, 200, "公网地址不带登录态也能取（给方舟用）");
  assert.equal((await response.arrayBuffer()).byteLength, pngSquare.length);
  response = await fetch(`${baseUrl}/api/seedance/refs/public/${imageRef.id}.jpg`);
  assert.equal(response.status, 404, "扩展名对不上就 404");
  response = await fetch(`${baseUrl}/api/seedance/refs/public/${"0".repeat(32)}.png`);
  assert.equal(response.status, 404);
  response = await fetch(`${baseUrl}/api/seedance/refs/public/..%2F..%2Fetc%2Fpasswd`);
  assert.equal(response.status, 404);
  response = await request(baseUrl, admin, "/api/seedance/refs");
  await assertOk(response);
  assert.equal((await response.json()).refs.length, 3);

  /* ── 文生视频：建任务 → 轮询 → 成片回传 → Range 播放 ────────────────────── */
  response = await request(baseUrl, admin, "/api/seedance/tasks", {
    method: "POST",
    ...jsonBody({ model: "doubao-seedance-2-5-260628", mode: "text", prompt: "一位模特走在清晨的石板路上", ratio: "9:16", resolution: "720p", duration: 6, generateAudio: true, returnLastFrame: true, priority: 2 }),
  });
  await assertOk(response, 201);
  let created = await response.json();
  assert.equal(created.tasks.length, 1);
  assert.equal(created.warning, null);
  const textTask = created.tasks[0];
  assert.equal(textTask.status, "queued");
  assert.match(textTask.arkTaskId, /^cgt-/);
  assert.equal(textTask.modelName, "Seedance 2.5");
  const createLog = arkLog.findLast((entry) => entry.method === "POST" && entry.path === "/api/v3/contents/generations/tasks");
  assert.equal(createLog.auth, `Bearer ${ARK_KEY}`);
  assert.equal(createLog.payload.model, "doubao-seedance-2-5-260628");
  assert.deepEqual(createLog.payload.content, [{ type: "text", text: "一位模特走在清晨的石板路上" }]);
  assert.equal(createLog.payload.ratio, "9:16");
  assert.equal(createLog.payload.duration, 6);
  assert.equal(createLog.payload.generate_audio, true);
  assert.equal(createLog.payload.return_last_frame, true);
  assert.equal(createLog.payload.priority, 2);
  assert.equal("seed" in createLog.payload, false);
  assert.match(createLog.payload.safety_identifier, /^[a-f0-9]{48}$/);

  let done = await waitForTask(baseUrl, admin, textTask.id, (task) => task.status === "completed");
  assert.equal(done.result.video.name, "video.mp4");
  assert.equal(done.result.video.bytes, fakeMp4.length);
  assert.equal(done.result.lastFrame.name, "last-frame.png");
  assert.equal(done.result.duration, 6);
  assert.equal(done.result.resolution, "720p");
  assert.equal(done.result.seed, 33608);
  assert.equal(done.result.usage.completionTokens, 123456);
  assert.equal(done.result.remoteVideoUrl.includes("/files/"), true);
  assert.equal(done.finishedAt !== null, true);

  response = await request(baseUrl, admin, done.result.video.url, { headers: { Range: "bytes=0-99" } });
  assert.equal(response.status, 206, "成片要支持 Range，不然拖不了进度条");
  assert.equal(response.headers.get("content-type"), "video/mp4");
  assert.equal((await response.arrayBuffer()).byteLength, 100);
  response = await request(baseUrl, admin, `${done.result.video.url}?download`);
  await assertOk(response);
  assert.match(response.headers.get("content-disposition"), /attachment/);
  response = await request(baseUrl, admin, done.result.lastFrame.url);
  await assertOk(response);
  assert.equal(response.headers.get("content-type"), "image/png");
  response = await request(baseUrl, admin, `/api/seedance/tasks/${textTask.id}/files/..%2F..%2Fetc%2Fpasswd`);
  assert.equal(response.status, 404);
  response = await request(baseUrl, admin, `/api/seedance/tasks/${textTask.id}/files/other.mp4`);
  assert.equal(response.status, 404, "只认结果里登记过的文件名");
  response = await request(baseUrl, viewer, `/api/seedance/tasks/${textTask.id}`);
  assert.equal(response.status, 403);

  // 尾帧接力：登记成素材
  response = await request(baseUrl, admin, `/api/seedance/tasks/${textTask.id}/last-frame-ref`, { method: "POST" });
  await assertOk(response);
  const frameRef = (await response.json()).ref;
  assert.equal(frameRef.kind, "image");
  assert.equal(frameRef.source, "last_frame");
  assert.equal(frameRef.width, 640);

  /* ── 图生视频：首帧走 base64 内联，尾帧也带上 ─────────────────────────── */
  response = await request(baseUrl, admin, "/api/seedance/tasks", {
    method: "POST",
    ...jsonBody({ model: "doubao-seedance-2-0-260128", mode: "image", prompt: "让她转身", firstFrame: { refId: imageRef.id }, lastFrame: { refId: frameRef.id }, ratio: "16:9", resolution: "4k", duration: -1 }),
  });
  await assertOk(response, 201);
  const imageTask = (await response.json()).tasks[0];
  const imagePayload = arkLog.findLast((entry) => entry.method === "POST" && entry.payload).payload;
  assert.equal(imagePayload.content[0].type, "text");
  assert.equal(imagePayload.content[1].role, "first_frame");
  assert.match(imagePayload.content[1].image_url.url, /^data:image\/png;base64,/, "小图直接 base64 内联，不依赖公网地址");
  assert.equal(imagePayload.content[2].role, "last_frame");
  assert.equal(imagePayload.ratio, "16:9");
  assert.equal(imagePayload.resolution, "4k");
  assert.equal(imagePayload.duration, -1);
  done = await waitForTask(baseUrl, admin, imageTask.id, (task) => task.status === "completed");
  assert.equal(done.result.ratio, "16:9");
  assert.equal(done.content.filter((item) => item.type === "image_url").length, 2, "任务里记素材清单，不记 base64");
  assert.equal(JSON.stringify(done.content).includes("base64"), false);

  /* ── 多模态参考：视频 / 音频必须走公网地址 ─────────────────────────────── */
  response = await request(baseUrl, admin, "/api/seedance/tasks", {
    method: "POST",
    ...jsonBody({ model: "doubao-seedance-2-5-260628", mode: "omni", prompt: "参考@视频1 的运镜", references: [{ kind: "video", refId: videoRef.id }, { kind: "image", refId: imageRef.id }] }),
  });
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /公网地址/);
  // 后台配上公网地址（测试里只要不是回环就行，假方舟不会真去取）
  response = await request(baseUrl, admin, "/api/admin/seedance/settings", { method: "PUT", ...jsonBody({ publicBaseUrl: "https://seedance-test.invalid" }) });
  await assertOk(response);
  assert.equal((await response.json()).status.publicMediaReady, true);
  response = await request(baseUrl, admin, "/api/seedance/tasks", {
    method: "POST",
    ...jsonBody({
      model: "doubao-seedance-2-5-260628",
      mode: "omni",
      prompt: "参考@视频1 的运镜，@音频1 的节奏，@图像1 的配色",
      references: [
        { kind: "video", refId: videoRef.id },
        { kind: "audio", refId: audioRef.id },
        { kind: "image", refId: imageRef.id },
        { kind: "image", url: "https://cdn.example.test/ref2.png" },
      ],
      omniTaskType: "reference",
      webSearch: true,
      outputFormat: "mov",
      duration: 12,
    }),
  });
  await assertOk(response, 201);
  const omniTask = (await response.json()).tasks[0];
  const omniPayload = arkLog.findLast((entry) => entry.method === "POST" && entry.payload).payload;
  assert.equal(omniPayload.content.length, 5);
  assert.deepEqual(omniPayload.content[1], { type: "image_url", image_url: { url: omniPayload.content[1].image_url.url }, role: "reference_image" });
  assert.match(omniPayload.content[1].image_url.url, /^data:image\/png;base64,/);
  assert.deepEqual(omniPayload.content[2], { type: "image_url", image_url: { url: "https://cdn.example.test/ref2.png" }, role: "reference_image" });
  assert.deepEqual(omniPayload.content[3], { type: "video_url", video_url: { url: `https://seedance-test.invalid/api/seedance/refs/public/${videoRef.id}.mp4` }, role: "reference_video" });
  assert.deepEqual(omniPayload.content[4], { type: "audio_url", audio_url: { url: `https://seedance-test.invalid/api/seedance/refs/public/${audioRef.id}.mp3` }, role: "reference_audio" });
  assert.equal(omniPayload.omni_reference_task_type, "reference");
  assert.deepEqual(omniPayload.tools, [{ type: "web_search" }]);
  assert.equal(omniPayload.output_format, "mov");
  done = await waitForTask(baseUrl, admin, omniTask.id, (task) => task.status === "completed");
  assert.equal(done.result.video.name, "video.mov", "方舟回 mov 就按 mov 存");
  assert.equal(done.result.outputFormat, "mov");
  response = await request(baseUrl, admin, done.result.video.url);
  await assertOk(response);
  assert.equal(response.headers.get("content-type"), "video/quicktime");

  /* ── 校验走接口：400 ─────────────────────────────────────────────────── */
  response = await request(baseUrl, admin, "/api/seedance/tasks", { method: "POST", ...jsonBody({ model: "doubao-seedance-1-0-pro-250528", mode: "text", prompt: "x", ratio: "adaptive" }) });
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /画幅不支持/);
  response = await request(baseUrl, admin, "/api/seedance/tasks", { method: "POST", ...jsonBody({ mode: "text", prompt: "" }) });
  assert.equal(response.status, 400);
  // 用别人的素材当首帧：不行
  response = await request(baseUrl, viewer, "/api/seedance/refs");
  assert.equal(response.status, 403);

  /* ── 方舟侧错误：模型未开通 / 参数错 / Key 失效 ─────────────────────────── */
  response = await request(baseUrl, admin, "/api/seedance/tasks", { method: "POST", ...jsonBody({ mode: "text", prompt: "MODELNOTOPEN test" }) });
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /还没在火山方舟开通/);
  response = await request(baseUrl, admin, "/api/seedance/tasks", { method: "POST", ...jsonBody({ mode: "text", prompt: "BADPARAM test" }) });
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /方舟说参数不对/);
  response = await request(baseUrl, admin, "/api/seedance/tasks");
  await assertOk(response);
  assert.equal((await response.json()).tasks.length, 3, "方舟拒收的请求不落任务表");

  response = await request(baseUrl, admin, "/api/admin/seedance/settings", { method: "PUT", ...jsonBody({ apiKey: "sk-wrong-key-000000" }) });
  await assertOk(response);
  let saveResult = await response.json();
  assert.equal(saveResult.settings.apiKeySource, "admin");
  assert.equal(saveResult.settings.apiKeyHint, "sk-…0000");
  assert.equal(saveResult.status.online, false, "错的 Key 探活应该离线");
  assert.match(saveResult.status.error, /不认这把 Key/);
  response = await request(baseUrl, admin, "/api/seedance/tasks", { method: "POST", ...jsonBody({ mode: "text", prompt: "hello" }) });
  assert.equal(response.status, 502, "方舟的 401 不能原样回给浏览器（会被当成掉线），包成 502");
  let upstream = await response.json();
  assert.equal(upstream.arkCode, "AuthenticationError");
  assert.equal(upstream.arkStatus, 401);
  response = await request(baseUrl, admin, "/api/admin/seedance/settings", { method: "PUT", ...jsonBody({ apiKey: "" }) });
  await assertOk(response);
  saveResult = await response.json();
  assert.equal(saveResult.settings.apiKeySource, "env", "清掉后台 Key 退回 .env");
  assert.equal(saveResult.status.online, true);

  /* ── Key 有效但没这个模型的权限：方舟回 AuthenticationError，要说清是权限不是 Key 错 ──── */
  response = await request(baseUrl, admin, "/api/seedance/tasks", { method: "POST", ...jsonBody({ model: RESTRICTED_MODEL, mode: "text", prompt: "hello" }) });
  assert.equal(response.status, 502);
  upstream = await response.json();
  assert.match(upstream.error, /能查账号、却没有调用模型 doubao-seedance-1-0-pro-fast-251015 的权限/);
  assert.match(upstream.error, /API Key 管理/);
  assert.equal(upstream.arkCode, "AuthenticationError");

  /* ── 后台「测一下」顺带自检每个模型的调用权限（只发注定被参数校验拦下的请求） ── */
  const probeCallsBefore = arkLog.filter((entry) => entry.method === "POST").length;
  response = await request(baseUrl, admin, "/api/admin/seedance/test", { method: "POST", ...jsonBody({ probeModels: true }) });
  await assertOk(response);
  const adminTest = await response.json();
  assert.equal(adminTest.modelAccess.length, 7, "目录里 7 个模型各探一次");
  const accessById = Object.fromEntries(adminTest.modelAccess.map((item) => [item.model, item.access]));
  assert.equal(accessById[RESTRICTED_MODEL], "unauthorized");
  assert.equal(accessById["doubao-seedance-2-5-260628"], "ok");
  assert.equal(arkLog.filter((entry) => entry.method === "POST").length - probeCallsBefore, 7);
  const arkTasksBefore = arkTasks.size;
  assert(arkLog.filter((entry) => entry.method === "POST").slice(-7).every((entry) => Array.isArray(entry.payload?.content) && entry.payload.content.length === 0), "探测请求 content 为空，方舟不可能建出任务");
  assert.equal(arkTasks.size, arkTasksBefore, "没有新任务");

  /* ── 生成失败 / 任务丢失 ───────────────────────────────────────────────── */
  response = await request(baseUrl, admin, "/api/seedance/tasks", { method: "POST", ...jsonBody({ mode: "text", prompt: "FAIL 一段会被拦的内容" }) });
  await assertOk(response, 201);
  const failTask = (await response.json()).tasks[0];
  done = await waitForTask(baseUrl, admin, failTask.id, (task) => task.status === "failed");
  assert.match(done.error, /安全审核/);
  assert.equal(done.errorCode, "OutputVideoSensitiveContentDetected");
  response = await request(baseUrl, admin, "/api/seedance/tasks", { method: "POST", ...jsonBody({ mode: "text", prompt: "LOST 任务" }) });
  await assertOk(response, 201);
  const lostTask = (await response.json()).tasks[0];
  done = await waitForTask(baseUrl, admin, lostTask.id, (task) => task.status === "failed");
  assert.equal(done.errorCode, "not_found");
  assert.match(done.error, /找不到了/);

  /* ── 并发上限 / 取消排队 / 生成中不能取消 ───────────────────────────────── */
  response = await request(baseUrl, admin, "/api/seedance/tasks", { method: "POST", ...jsonBody({ mode: "text", prompt: "SLOW 慢任务", count: 3 }) });
  assert.equal(response.status, 429, "count 超过剩余并发要拦");
  response = await request(baseUrl, admin, "/api/seedance/tasks", { method: "POST", ...jsonBody({ mode: "text", prompt: "SLOW 慢任务", count: 2 }) });
  await assertOk(response, 201);
  created = await response.json();
  assert.equal(created.tasks.length, 2, "一次出两条就是两条方舟任务");
  assert.equal(created.activeCount, 2);
  assert.notEqual(created.tasks[0].arkTaskId, created.tasks[1].arkTaskId);
  response = await request(baseUrl, admin, "/api/seedance/tasks", { method: "POST", ...jsonBody({ mode: "text", prompt: "再来一条" }) });
  assert.equal(response.status, 429);
  assert.match((await response.json()).error, /同时最多跑 2 条/);
  // 取消排队中的
  const slowA = created.tasks[0];
  response = await request(baseUrl, admin, `/api/seedance/tasks/${slowA.id}`, { method: "DELETE" });
  await assertOk(response);
  assert.equal((await response.json()).activeCount, 1);
  assert(arkLog.some((entry) => entry.method === "DELETE" && entry.path.endsWith(slowA.arkTaskId)), "排队中的要去方舟取消");
  assert.equal(arkTasks.get(slowA.arkTaskId).status, "cancelled");
  response = await request(baseUrl, admin, `/api/seedance/tasks/${slowA.id}`);
  assert.equal(response.status, 404, "取消后记录删掉");
  // 生成中的：不让删，除非 force
  response = await request(baseUrl, admin, "/api/seedance/tasks", { method: "POST", ...jsonBody({ mode: "text", prompt: "RUNNING 一直跑" }) });
  await assertOk(response, 201);
  const runningTask = (await response.json()).tasks[0];
  await waitForTask(baseUrl, admin, runningTask.id, (task) => task.status === "running");
  response = await request(baseUrl, admin, `/api/seedance/tasks/${runningTask.id}`, { method: "DELETE" });
  assert.equal(response.status, 409);
  assert.match((await response.json()).error, /不支持中途取消/);
  response = await request(baseUrl, admin, `/api/seedance/tasks/${runningTask.id}?force`, { method: "DELETE" });
  await assertOk(response);
  response = await request(baseUrl, admin, `/api/seedance/tasks/${created.tasks[1].id}`, { method: "DELETE" });
  await assertOk(response);
  response = await request(baseUrl, viewer, `/api/seedance/tasks/${textTask.id}`, { method: "DELETE" });
  assert.equal(response.status, 403);

  /* ── 样片 → 正式版（1.5 pro） ──────────────────────────────────────────── */
  response = await request(baseUrl, admin, "/api/seedance/tasks", { method: "POST", ...jsonBody({ model: "doubao-seedance-1-5-pro-251215", mode: "text", prompt: "样片试试", draft: true, resolution: "1080p", seed: 7, cameraFixed: true }) });
  await assertOk(response, 201);
  const draftTask = (await response.json()).tasks[0];
  const draftPayload = arkLog.findLast((entry) => entry.method === "POST" && entry.payload).payload;
  assert.equal(draftPayload.draft, true);
  assert.equal(draftPayload.resolution, "480p", "样片强制 480p");
  assert.equal(draftPayload.seed, 7);
  assert.equal(draftPayload.camera_fixed, true);
  done = await waitForTask(baseUrl, admin, draftTask.id, (task) => task.status === "completed");
  assert.equal(done.result.draft, true);
  response = await request(baseUrl, admin, "/api/seedance/tasks", { method: "POST", ...jsonBody({ model: "doubao-seedance-1-5-pro-251215", draftTaskId: done.arkTaskId, resolution: "1080p" }) });
  await assertOk(response, 201);
  const finalPayload = arkLog.findLast((entry) => entry.method === "POST" && entry.payload).payload;
  assert.deepEqual(finalPayload.content, [{ type: "draft_task", draft_task: { id: done.arkTaskId } }]);
  assert.equal(finalPayload.resolution, "1080p");
  assert.equal("ratio" in finalPayload, false);
  response = await request(baseUrl, admin, "/api/seedance/tasks", { method: "POST", ...jsonBody({ model: "doubao-seedance-2-5-260628", draftTaskId: done.arkTaskId }) });
  assert.equal(response.status, 400, "2.5 没有样片模式");

  /* ── 中间帧 · 一镜到底：2.x 把关键帧全当参考图，提示词前面带顺序说明 ─────── */
  response = await uploadRef(baseUrl, admin, { name: "中间.png", type: "image/png", buffer: pngSquare });
  await assertOk(response);
  const middleRef = (await response.json()).ref;
  response = await uploadRef(baseUrl, admin, { name: "尾.png", type: "image/png", buffer: pngSquare });
  await assertOk(response);
  const tailRef = (await response.json()).ref;
  await waitForTask(baseUrl, admin, draftTask.id, (task) => !["queued", "running"].includes(task.status));
  response = await request(baseUrl, admin, "/api/seedance/tasks", {
    method: "POST",
    ...jsonBody({ model: "doubao-seedance-2-5-260628", mode: "image", prompt: "RUNNING 走起来", firstFrame: { refId: imageRef.id }, middleFrames: [{ refId: middleRef.id }], lastFrame: { refId: tailRef.id }, keyframeStrategy: "reference" }),
  });
  await assertOk(response, 201);
  const refTask = (await response.json()).tasks[0];
  assert.equal(refTask.group, null, "一镜到底不是分段组");
  const refPayload = arkLog.findLast((entry) => entry.method === "POST" && entry.payload).payload;
  assert.equal(refPayload.content.length, 4);
  assert.match(refPayload.content[0].text, /^@图像1 是视频的第一帧画面；随后依次经过 @图像2 的画面；@图像3 是视频的最后一帧画面[^\n]*\nRUNNING 走起来$/);
  assert(refPayload.content.slice(1).every((item) => item.role === "reference_image" && item.image_url.url.startsWith("data:image/png;base64,")));
  assert.equal(refTask.content.filter((item) => item.role === "middle_frame").length, 1, "任务详情里中间帧标成 middle_frame");
  response = await request(baseUrl, admin, `/api/seedance/tasks/${refTask.id}?force`, { method: "DELETE" });
  await assertOk(response);

  /* ── 中间帧 · 分段接力：3 张关键帧 → 2 段；并发 1 时第二段在本站排队，齐了自动拼成一条 ── */
  for (let tick = 0; tick < 200; tick += 1) {
    response = await request(baseUrl, admin, "/api/seedance/tasks");
    await assertOk(response);
    if ((await response.json()).activeCount === 0) break;
    await sleep(100);
  }
  response = await request(baseUrl, admin, "/api/admin/seedance/settings", { method: "PUT", ...jsonBody({ maxActivePerUser: "1" }) });
  await assertOk(response);
  response = await request(baseUrl, admin, "/api/seedance/tasks", {
    method: "POST",
    ...jsonBody({ model: "doubao-seedance-1-0-pro-250528", mode: "image", prompt: "接力", firstFrame: { refId: imageRef.id }, middleFrames: [{ refId: middleRef.id }], lastFrame: { refId: tailRef.id }, keyframeStrategy: "segments", count: 3, returnLastFrame: true }),
  });
  await assertOk(response, 201);
  const groupResult = await response.json();
  assert.equal(groupResult.tasks.length, 2, "3 张关键帧 = 2 段");
  assert.equal(groupResult.group.total, 2);
  assert.equal(groupResult.group.status, "pending");
  assert.equal(groupResult.tasks[0].pendingSubmit, false, "第一段立刻交给方舟");
  assert.equal(groupResult.tasks[1].pendingSubmit, true, "并发只有 1，第二段先在本站排队");
  assert.equal(groupResult.tasks[1].statusLabel, "本站排队");
  assert.equal(groupResult.tasks[1].arkTaskId, null);
  assert.deepEqual(groupResult.tasks.map((task) => task.group.index), [1, 2]);
  const seg1Payload = arkLog.findLast((entry) => entry.method === "POST" && entry.payload).payload;
  assert.equal(seg1Payload.content[1].role, "first_frame");
  assert.equal(seg1Payload.content[2].role, "last_frame");
  assert.equal(seg1Payload.content.length, 3, "每段只有首尾两张");
  const seg2 = await waitForTask(baseUrl, admin, groupResult.tasks[1].id, (task) => Boolean(task.arkTaskId), { timeoutMs: 20000 });
  assert.equal(seg2.pendingSubmit, false, "第一段完成后第二段自动补交");
  const seg2Payload = arkLog.findLast((entry) => entry.method === "POST" && entry.payload).payload;
  assert.equal(seg2Payload.content[1].image_url.url, seg1Payload.content[2].image_url.url, "第二段的首帧就是第一段的尾帧");
  const seg2Done = await waitForTask(baseUrl, admin, seg2.id, (task) => task.status === "completed" && task.group.status !== "pending" && task.group.status !== "merging", { timeoutMs: 30000 });
  if (ffmpegReady) {
    assert.equal(seg2Done.group.status, "merged", seg2Done.group.error || "");
    assert.equal(seg2Done.group.completed, 2);
    assert(seg2Done.group.merged?.url, "合并成片地址");
    response = await request(baseUrl, admin, seg2Done.group.merged.url);
    await assertOk(response);
    assert.equal(response.headers.get("content-type"), "video/mp4");
    assert((await response.arrayBuffer()).byteLength > fakeMp4.length, "拼出来的比单段长");
    response = await request(baseUrl, admin, `/api/seedance/groups/${seg2Done.group.id}`);
    await assertOk(response);
    assert.equal((await response.json()).tasks.length, 2);
  } else {
    assert.equal(seg2Done.group.status, "failed");
    assert.match(seg2Done.group.error || "", /ffmpeg/);
  }
  response = await request(baseUrl, viewer, `/api/seedance/groups/${seg2Done.group.id}`);
  assert.equal(response.status, 403);
  response = await request(baseUrl, admin, "/api/admin/seedance/settings", { method: "PUT", ...jsonBody({ maxActivePerUser: "" }) });
  await assertOk(response);
  // 删掉两段，组和合并成片一起清
  for (const task of groupResult.tasks) {
    response = await request(baseUrl, admin, `/api/seedance/tasks/${task.id}`, { method: "DELETE" });
    await assertOk(response);
  }
  response = await request(baseUrl, admin, `/api/seedance/groups/${seg2Done.group.id}`);
  assert.equal(response.status, 404, "最后一段删掉后组也没了");
  await assert.rejects(fs.access(path.join(assetDir, "groups", seg2Done.group.id)));

  /* ── 成片到期后：文件地址不再给、直接取回 410 ──────────────────────────── */
  {
    const Database = (await import("better-sqlite3")).default;
    const appDb = new Database(path.join(tmpDir, "app.db"));
    appDb.prepare("UPDATE seedance_task SET storage_status = 'expired', expired_at = ? WHERE id = ?").run(new Date().toISOString(), textTask.id);
    appDb.close();
  }
  response = await request(baseUrl, admin, `/api/seedance/tasks/${textTask.id}`);
  await assertOk(response);
  const expiredView = (await response.json()).task;
  assert.equal(expiredView.result.video, null);
  assert.equal(expiredView.storage.status, "expired");
  response = await request(baseUrl, admin, `/api/seedance/tasks/${textTask.id}/files/video.mp4`);
  assert.equal(response.status, 410);
  assert.match((await response.json()).error, /只保留 3 天/);
  response = await request(baseUrl, admin, `/api/seedance/tasks/${textTask.id}/archive`, { method: "POST" });
  assert.equal(response.status, 409, "过期的没法再归档");

  /* ── 后台限制可用模型 ──────────────────────────────────────────────────── */
  response = await request(baseUrl, admin, "/api/admin/seedance/settings", { method: "PUT", ...jsonBody({ enabledModels: ["doubao-seedance-2-0-mini-260615"] }) });
  await assertOk(response);
  response = await request(baseUrl, admin, "/api/seedance/overview");
  await assertOk(response);
  overview = await response.json();
  assert.equal(overview.options.models.length, 1);
  assert.equal(overview.options.defaultModel, "doubao-seedance-2-0-mini-260615", "默认模型不在可选里就退到第一个可选");
  response = await request(baseUrl, admin, "/api/seedance/tasks", { method: "POST", ...jsonBody({ model: "doubao-seedance-2-5-260628", mode: "text", prompt: "x" }) });
  assert.equal(response.status, 400);
  response = await request(baseUrl, admin, "/api/admin/seedance/settings", { method: "PUT", ...jsonBody({ enabledModels: "" }) });
  await assertOk(response);

  /* ── 删除素材会把文件一起清掉 ───────────────────────────────────────────── */
  response = await request(baseUrl, admin, `/api/seedance/refs/${audioRef.id}`, { method: "DELETE" });
  await assertOk(response);
  response = await fetch(`${baseUrl}/api/seedance/refs/public/${audioRef.id}.mp3`);
  assert.equal(response.status, 404);
  response = await request(baseUrl, admin, `/api/seedance/refs/${videoRef.id}`, { method: "DELETE" });
  await assertOk(response);
  await assert.rejects(fs.access(path.join(assetDir, "refs", `${videoRef.id}.mp4`)));

  /* ── 删除已完成任务：本地文件清掉，方舟记录顺手删 ───────────────────────── */
  response = await request(baseUrl, admin, `/api/seedance/tasks/${textTask.id}`, { method: "DELETE" });
  await assertOk(response);
  await sleep(150);
  await assert.rejects(fs.access(path.join(assetDir, "tasks", textTask.id)));
  assert.equal(arkTasks.has(textTask.arkTaskId), false, "跑完的任务删掉时方舟那边的记录也删");

  console.log(JSON.stringify({ checks: "passed", arkCalls: arkLog.length }, null, 2));
} finally {
  app.kill("SIGTERM");
  ark.close();
  await fs.rm(tmpDir, { recursive: true, force: true });
}
