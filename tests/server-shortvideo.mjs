/**
 * 短视频模块：MoneyPrinterTurbo 只当渲染引擎，账号、权限、任务、文件、轮询都在本站。
 *
 * 这里起真实 Express，再用 Node 假扮 MPT 的 FastAPI（/api/v1/videos、/tasks/{id}、静态成片、素材、音乐）
 * 和一个 OpenAI 兼容的 chat 接口，覆盖：权限门禁、文案/关键词、创建 → 轮询 → 回传成片 → 文件路由（Range）、
 * 参数校验、并发上限、引擎失败 / 引擎丢任务、删除、后台按账号开关。
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";

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
    const response = await request(baseUrl, jar, `/api/shortvideo/tasks/${id}`);
    await assertOk(response);
    last = (await response.json()).task;
    if (predicate(last)) return last;
    await sleep(120);
  }
  throw new Error(`任务 ${id} 没等到预期状态：${JSON.stringify(last)}`);
}

/* ── 先在进程内测纯函数：参数规范化、引擎请求映射、未配置引擎的状态 ────────── */

const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "clothdesign-shortvideo-"));
process.env.DATABASE_URL = `file:${path.join(tmpDir, "unit.db")}`;
process.env.SHORTVIDEO_ASSET_DIR = path.join(tmpDir, "unit-assets");
delete process.env.SHORTVIDEO_ENGINE_URL;
const { migrateBusinessDatabase } = await import("../server/db.mjs");
migrateBusinessDatabase();
const shortvideo = await import("../server/shortvideo.mjs");
shortvideo.migrateShortVideoDatabase();
const llm = await import("../server/shortvideo-llm.mjs");
const engine = await import("../server/shortvideo-engine.mjs");

{
  const normalized = shortvideo.normalizeShortVideoRequest({ subject: "  秋冬大衣  穿搭 ", aspect: "16:9", count: "2", clipDuration: 7.4, voiceRate: 1.2 });
  assert.equal(normalized.subject, "秋冬大衣 穿搭");
  assert.equal(normalized.aspect, "16:9");
  assert.equal(normalized.count, 2);
  assert.equal(normalized.clipDuration, 7, "单段时长取整");
  assert.equal(normalized.source, "pexels");
  assert.equal(normalized.subtitle.enabled, true);
  assert.equal(normalized.bgm.type, "random");
  assert.throws(() => shortvideo.normalizeShortVideoRequest({}), /主题和文案至少填一个/);
  assert.throws(() => shortvideo.normalizeShortVideoRequest({ subject: "x", aspect: "4:3" }), /画幅不在可选范围内/);
  assert.throws(() => shortvideo.normalizeShortVideoRequest({ subject: "x", source: "local" }), /至少要挑一个文件/);
  assert.throws(() => shortvideo.normalizeShortVideoRequest({ subject: "x", count: 9 }), /生成条数要在 1–3 之间/);
  assert.throws(() => shortvideo.normalizeShortVideoRequest({ subject: "x", subtitle: { color: "white" } }), /#RRGGBB/);
  assert.throws(() => shortvideo.normalizeShortVideoRequest({ subject: "x", bgm: { type: "file" } }), /选一个文件/);
  const local = shortvideo.normalizeShortVideoRequest({ subject: "x", source: "local", materials: ["../../etc/passwd", "a b.mp4", "clip-1.mp4"] });
  assert.deepEqual(local.materials, ["passwd", "clip-1.mp4"], "素材名只留文件名，带空格的直接丢掉");

  // 新增的参数：倍速、素材跟文案、段落数、字幕自定义高度与底色。
  assert.equal(normalized.clipSpeed, 1, "倍速默认 1×");
  assert.equal(normalized.matchScript, false);
  assert.equal(normalized.paragraphs, 1);
  assert.equal(normalized.subtitle.customPosition, 70);
  assert.deepEqual(normalized.subtitle.background, { enabled: false, color: "#000000", rounded: true });
  assert.throws(() => shortvideo.normalizeShortVideoRequest({ subject: "x", clipSpeed: 3 }), /片段倍速要在 0.5–2 之间/);
  assert.throws(() => shortvideo.normalizeShortVideoRequest({ subject: "x", paragraphs: 20 }), /段落数要在 1–10 之间/);
  assert.throws(() => shortvideo.normalizeShortVideoRequest({ subject: "x", subtitle: { position: "middle" } }), /字幕位置不在可选范围内/);
  const rich = shortvideo.normalizeShortVideoRequest({
    subject: "x",
    clipSpeed: 1.25,
    matchScript: true,
    paragraphs: 3,
    scriptPrompt: " 口语一点 ",
    subtitle: { position: "custom", customPosition: 62, background: { enabled: true, color: "#112233", rounded: false } },
  });
  assert.equal(rich.clipSpeed, 1.25);
  assert.equal(rich.matchScript, true);
  assert.equal(rich.paragraphs, 3);
  assert.equal(rich.scriptPrompt, "口语一点");
  assert.equal(rich.subtitle.position, "custom");
  assert.equal(rich.subtitle.customPosition, 62);
  assert.deepEqual(rich.subtitle.background, { enabled: true, color: "#112233", rounded: false });
  const richBody = shortvideo.engineRequestFor(rich, { script: "s", terms: [] });
  assert.equal(richBody.video_clip_speed, 1.25);
  assert.equal(richBody.match_materials_to_script, true);
  assert.equal(richBody.paragraph_number, 3);
  assert.equal(richBody.custom_position, 62);
  assert.equal(richBody.text_background_color, "#112233", "开了底色就传颜色字符串");
  assert.equal(richBody.rounded_subtitle_background, false);
  assert.equal(richBody.n_threads, 2, "渲染线程默认 2，可在后台改");

  // 上游能选的这几项以前漏了：Coverr 素材源、第 9 个字体、字幕自定义高度。
  assert(shortvideo.SHORTVIDEO_SOURCES.some((item) => item.id === "coverr"), "素材源要有 Coverr");
  // 上传图片会被引擎转成带缓慢推近的片段，这事得在界面上说，否则用户以为图片不能用。
  assert.match(shortvideo.SHORTVIDEO_SOURCES.find((item) => item.id === "local").hint, /图片/);
  assert.equal(shortvideo.SHORTVIDEO_FONTS.length, 9, "引擎自带 9 个字体，别少一个");
  assert(shortvideo.SHORTVIDEO_SUBTITLE_POSITIONS.some((item) => item.id === "custom"), "字幕要能自定义高度");
  assert(shortvideo.SHORTVIDEO_PLATFORMS.length >= 6, "发布文案要覆盖国内外主流平台");

  const engineBody = shortvideo.engineRequestFor(normalized, { script: "旁白正文", terms: ["autumn coat", "street"] });
  assert.equal(engineBody.video_script, "旁白正文");
  assert.deepEqual(engineBody.video_terms, ["autumn coat", "street"]);
  assert.equal(engineBody.video_aspect, "16:9");
  assert.equal(engineBody.video_transition_mode, null, "MPT 的无转场是 null，不是空串");
  assert.equal(engineBody.text_background_color, false, "不加底色时是 false，不是空串");
  assert.equal(engineBody.bgm_type, "random");
  const noBgm = shortvideo.engineRequestFor({ ...normalized, bgm: { type: "none", file: "", volume: 0.2 } }, { script: "s", terms: [] });
  assert.equal(noBgm.bgm_type, "", "不要背景音乐 = 空串");
  const localBody = shortvideo.engineRequestFor(local, { script: "s", terms: ["ignored"] });
  assert.deepEqual(localBody.video_terms, [], "本地素材不带关键词");
  assert.deepEqual(localBody.video_materials, [
    { provider: "local", url: "passwd", duration: 0 },
    { provider: "local", url: "clip-1.mp4", duration: 0 },
  ]);

  const status = await shortvideo.shortVideoEngineStatus({ force: true });
  assert.equal(status.configured, false);
  assert.equal(status.online, false);
  await assert.rejects(() => shortvideo.createShortVideoTask({ userId: "u-none", body: { subject: "x" } }), /未接入/);

  assert.equal(shortvideo.canUseShortVideo({ role: "owner", shortvideo_enabled: 0 }), true, "admin 天然可用");
  assert.equal(shortvideo.canUseShortVideo({ role: "user", shortvideo_enabled: 0 }), false);
  assert.equal(shortvideo.canUseShortVideo({ role: "user", shortvideo_enabled: 1 }), true, "后台单独打开也行");
  assert.equal(shortvideo.estimateShortVideoCredits(), 0, "第一版不扣费");

  assert.equal(llm.cleanScript("## 标题\n\n**文案：**「今天聊聊大衣。」\n\n1. 第二段"), "今天聊聊大衣。\n第二段");
  assert.deepEqual(llm.normalizeTerms('好的：["City Skyline", "coffee cup", "city skyline"]', 5), ["City Skyline", "coffee cup"]);
  assert.deepEqual(llm.normalizeTerms("a, b，c", 2), ["a", "b"]);
  // 有的中转不写 stream 也按 SSE 回：得把 delta 拼回来，不能当成空内容。
  const sse = 'data: {"choices":[{"delta":{"role":"assistant","content":""}}]}\n\ndata: {"choices":[{"delta":{"content":"秋冬"}}]}\n\ndata: {"choices":[{"delta":{"content":"大衣"}}]}\n\ndata: [DONE]\n';
  assert.equal(llm.sseText(sse), "秋冬大衣");

  // 发布文案：模型爱在 JSON 外面裹解释 / 代码块，得抠得出来。
  const parsed = llm.parseMetadata('好的：```json\n{"title":"三招穿好大衣","caption":"照着做就行。","hashtags":["穿搭","秋冬","大衣"]}\n```', "大衣", "douyin");
  assert.equal(parsed.title, "三招穿好大衣");
  assert.deepEqual(parsed.hashtags, ["#穿搭", "#秋冬", "#大衣"]);
  const fallbackMeta = llm.parseMetadata("模型今天不听话", "大衣", "douyin");
  assert(fallbackMeta.title && fallbackMeta.hashtags.length, "抠不出 JSON 也要给一份能用的兜底");

  assert.equal(engine.safeEngineFileName("/tasks/abc/final-1.mp4"), "final-1.mp4");
  assert.equal(engine.safeEngineFileName("../x"), "x");
  assert.equal(engine.safeEngineFileName("bad name.mp4"), "");
}

/* ── 假 MPT 引擎 ──────────────────────────────────────────────────────────── */

const engineTasks = new Map(); // id → { body, ticks, mode }
const engineLog = [];
const fakeMp4 = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from("ftypisom"), Buffer.alloc(6000, 7)]);
let releaseSlow = false;

function engineJson(res, status, data, message = "success") {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ status, message, data }));
}

const fakeEngine = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  engineLog.push({ method: req.method, path: url.pathname, apiKey: req.headers["x-api-key"] || "" });
  if (req.method === "GET" && url.pathname === "/api/v1/tasks") {
    engineJson(res, 200, { tasks: [], total: engineTasks.size, page: 1, page_size: 1 });
    return;
  }
  if (req.method === "GET" && url.pathname === "/api/v1/musics") {
    engineJson(res, 200, { files: [{ name: "output000.mp3", size: 2249517, file: "output000.mp3" }] });
    return;
  }
  if (req.method === "GET" && url.pathname === "/api/v1/video_materials") {
    engineJson(res, 200, { files: [{ name: "clip-1.mp4", size: 89445, file: "clip-1.mp4" }] });
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/v1/musics") {
    const raw = (await readBody(req)).toString("latin1");
    const match = raw.match(/filename="([^"]+)"/);
    engineJson(res, 200, { file: `uuid-${match ? match[1] : "x"}` });
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/v1/video_materials") {
    const raw = (await readBody(req)).toString("latin1");
    const match = raw.match(/filename="([^"]+)"/);
    engineJson(res, 200, { file: match ? match[1] : "" });
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/v1/videos") {
    const body = JSON.parse((await readBody(req)).toString("utf8"));
    const id = `mpt-${engineTasks.size + 1}`;
    const subject = String(body.video_subject || "");
    const mode = subject.includes("FAIL") ? "fail" : subject.includes("SLOW") ? "slow" : subject.includes("LOST") ? "lost" : "ok";
    engineTasks.set(id, { body, ticks: 0, mode });
    engineJson(res, 200, { task_id: id });
    return;
  }
  const taskMatch = url.pathname.match(/^\/api\/v1\/tasks\/([^/]+)$/);
  if (taskMatch && req.method === "GET") {
    const task = engineTasks.get(taskMatch[1]);
    if (!task || task.mode === "lost") {
      engineJson(res, 404, null, "task not found");
      return;
    }
    task.ticks += 1;
    if (task.mode === "fail") {
      engineJson(res, 200, { task_id: taskMatch[1], state: -1, progress: 30, failed_stage: "audio", error: "TTS request timed out" });
      return;
    }
    if (task.mode === "slow" && !releaseSlow) {
      engineJson(res, 200, { task_id: taskMatch[1], state: 4, progress: 45 });
      return;
    }
    if (task.ticks < 3) {
      engineJson(res, 200, { task_id: taskMatch[1], state: 4, progress: task.ticks === 1 ? 5 : 30 });
      return;
    }
    engineJson(res, 200, {
      task_id: taskMatch[1],
      state: 1,
      progress: 100,
      videos: [`/tasks/${taskMatch[1]}/final-1.mp4`],
      combined_videos: [`/tasks/${taskMatch[1]}/combined-1.mp4`],
      script: task.body.video_script,
      terms: task.body.video_terms,
      audio_duration: 14,
      subtitle_path: `/srv/mpt/storage/tasks/${taskMatch[1]}/subtitle.srt`,
      warnings: null,
    });
    return;
  }
  if (taskMatch && req.method === "DELETE") {
    engineTasks.delete(taskMatch[1]);
    engineJson(res, 200, null);
    return;
  }
  const fileMatch = url.pathname.match(/^\/tasks\/([^/]+)\/([^/]+)$/);
  if (fileMatch && (req.method === "GET" || req.method === "HEAD")) {
    const [, taskId, name] = fileMatch;
    const known = engineTasks.has(taskId);
    if (!known) {
      res.statusCode = 404;
      res.end();
      return;
    }
    if (name.endsWith(".mp4")) {
      res.setHeader("content-type", "video/mp4");
      res.setHeader("content-length", String(fakeMp4.length));
      res.end(req.method === "HEAD" ? undefined : fakeMp4);
      return;
    }
    if (name === "subtitle.srt") {
      const srt = "1\n00:00:00,000 --> 00:00:02,000\n测试字幕\n";
      res.setHeader("content-type", "text/plain");
      res.end(req.method === "HEAD" ? undefined : srt);
      return;
    }
  }
  res.statusCode = 404;
  res.end(JSON.stringify({ detail: "Not Found" }));
});
const enginePort = await listen(fakeEngine);

/* ── 假 chat 接口 ─────────────────────────────────────────────────────────── */

const chatRequests = [];
const fakeChat = http.createServer(async (req, res) => {
  const body = JSON.parse((await readBody(req)).toString("utf8"));
  chatRequests.push({ url: req.url, auth: req.headers.authorization, body });
  const system = String(body.messages?.[0]?.content || "");
  const content = system.includes("检索词")
    ? '["autumn coat", "city street", "wool fabric", "walking outdoors", "sunset skyline"]'
    : "## 文案\n\n今天聊聊秋冬大衣。很多人第一步就买错了颜色。\n\n先挑基础色，再谈版型，最后才是细节。";
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content } }] }));
});
const chatPort = await listen(fakeChat);

/* ── 起真实服务 ───────────────────────────────────────────────────────────── */

// 引擎的 config.toml：后台要能直接改它（素材库 Key、字幕方案、并发）。
const engineConfigPath = path.join(tmpDir, "engine-config.toml");
await fs.writeFile(
  engineConfigPath,
  [
    "[app]",
    '# Register at https://www.pexels.com/api/',
    "pexels_api_keys = []",
    "pixabay_api_keys = []",
    "coverr_api_keys = []",
    'subtitle_provider = "edge"',
    "max_concurrent_tasks = 5",
    "max_queued_tasks = 100",
    "",
    "[whisper]",
    'model_size = "large-v3"',
    'device = "cpu"',
    "",
    "[azure]",
    'speech_key = ""',
    'speech_region = ""',
    "",
    "[siliconflow]",
    'api_key = ""',
    "",
  ].join("\n"),
  "utf8",
);

const appPort = 22450 + Math.floor(Math.random() * 500);
const assetDir = path.join(tmpDir, "shortvideo-assets");
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
    SHORTVIDEO_ASSET_DIR: assetDir,
    SHORTVIDEO_ENGINE_URL: `http://127.0.0.1:${enginePort}/`,
    SHORTVIDEO_ENGINE_API_KEY: "mpt-secret-key",
    SHORTVIDEO_POLL_INTERVAL_MS: "100",
    SHORTVIDEO_MAX_ACTIVE_PER_USER: "1",
    SHORTVIDEO_ENGINE_CONFIG: engineConfigPath,
    // 测试里的「重启引擎」只运行一个无害命令，验证的是链路而不是真去重启服务。
    SHORTVIDEO_ENGINE_RESTART_CMD: `${process.execPath} -e process.exit(0)`,
    SHORTVIDEO_LLM_BASE_URL: `http://127.0.0.1:${chatPort}/v1`,
    SHORTVIDEO_LLM_API_KEY: "sk-shortvideo-llm-test-000000",
    SHORTVIDEO_LLM_MODEL: "test-chat-model",
    AUTH_SECRET: "test-shortvideo-secret-1234567890",
    PUBLIC_APP_URL: `http://127.0.0.1:${appPort}`,
    NODE_ENV: "test",
    PAYMENT_DEMO_MODE: "true",
    ALLOW_PAYMENT_DEMO_API: "true",
    OPENAI_DEMO_MODE: "false",
    OPENAI_API_KEY: "sk-test-shortvideo-image-0000000000",
    OPENAI_BASE_URL: `http://127.0.0.1:${chatPort}`,
    OPENAI_IMAGE_MODEL: "gpt-image-2",
  },
});

try {
  await waitForOutput(app, /ClothDesign AI running/);
  const baseUrl = `http://127.0.0.1:${appPort}`;
  const admin = new Map();
  const viewer = new Map();

  /* ── 第一个注册的是 owner（admin），天然能用短视频 ─────────────────────── */
  let response = await request(baseUrl, admin, "/api/auth/sign-up/email", {
    method: "POST",
    ...jsonBody({ name: "Admin", email: "admin@example.test", password: "clothdesign123" }),
  });
  await assertOk(response);
  response = await request(baseUrl, admin, "/api/me");
  await assertOk(response);
  const adminAccount = (await response.json()).account;
  assert.equal(adminAccount.role, "owner");
  assert.deepEqual(adminAccount.features, { shortVideo: true }, "admin 的账号信息里要带短视频开关");

  /* ── 后台建一个普通账号：默认看不到、也用不了 ───────────────────────────── */
  response = await request(baseUrl, admin, "/api/admin/users", { method: "POST", ...jsonBody({ username: "viewer", password: "clothdesign123" }) });
  await assertOk(response, 201);
  const viewerUser = (await response.json()).user;
  assert.equal(viewerUser.shortVideoEnabled, false);
  assert.equal(viewerUser.canUseShortVideo, false);
  response = await request(baseUrl, viewer, "/api/auth/sign-in/email", {
    method: "POST",
    ...jsonBody({ email: "viewer@clothdesign.local", password: "clothdesign123" }),
  });
  await assertOk(response);
  response = await request(baseUrl, viewer, "/api/me");
  await assertOk(response);
  assert.deepEqual((await response.json()).account.features, { shortVideo: false }, "普通账号默认关着");
  response = await request(baseUrl, viewer, "/api/shortvideo/overview");
  assert.equal(response.status, 403, "普通账号打短视频接口要吃 403");
  assert.match((await response.json()).error, /暂未对这个账号开放/);
  response = await request(baseUrl, viewer, "/api/shortvideo/tasks", { method: "POST", ...jsonBody({ subject: "x" }) });
  assert.equal(response.status, 403);
  response = await request(baseUrl, new Map(), "/api/shortvideo/overview");
  assert.equal(response.status, 401, "没登录 401");

  /* ── 总览：引擎在线、选项目录、素材与音乐来自引擎 ───────────────────────── */
  response = await request(baseUrl, admin, "/api/shortvideo/overview");
  await assertOk(response);
  const overview = await response.json();
  assert.equal(overview.engine.configured, true);
  assert.equal(overview.engine.online, true);
  assert.equal(overview.engine.url, `127.0.0.1:${enginePort}`, "只给主机端口，不给整段 URL");
  assert.equal(overview.llm.configured, true);
  assert.equal(overview.llm.model, "test-chat-model");
  assert(overview.options.aspects.some((item) => item.id === "9:16"));
  assert(overview.options.voices.length >= 10);
  assert.equal(overview.options.limits.maxActivePerUser, 1);
  assert.deepEqual(overview.musics, [{ name: "output000.mp3", size: 2249517 }]);
  assert.deepEqual(overview.materials, [{ name: "clip-1.mp4", size: 89445 }]);
  assert.deepEqual(overview.tasks, []);
  assert(engineLog.some((entry) => entry.path === "/api/v1/tasks" && entry.apiKey === "mpt-secret-key"), "探活要带 x-api-key");

  response = await request(baseUrl, admin, "/api/shortvideo/engine/test", { method: "POST" });
  await assertOk(response);
  assert.equal((await response.json()).engine.online, true);

  /* ── 文案 / 关键词走本站的 chat 接口 ───────────────────────────────────── */
  response = await request(baseUrl, admin, "/api/shortvideo/script", { method: "POST", ...jsonBody({ subject: "秋冬大衣穿搭", language: "zh-CN" }) });
  await assertOk(response);
  const script = (await response.json()).script;
  assert.equal(script, "今天聊聊秋冬大衣。很多人第一步就买错了颜色。\n先挑基础色，再谈版型，最后才是细节。", "markdown 标题和「文案：」前缀要剥掉");
  assert.equal(chatRequests.at(-1).url, "/v1/chat/completions");
  assert.equal(chatRequests.at(-1).auth, "Bearer sk-shortvideo-llm-test-000000");
  assert.equal(chatRequests.at(-1).body.model, "test-chat-model");
  assert.equal(chatRequests.at(-1).body.stream, false, "明确不要流式，免得中转默认按 SSE 回");
  response = await request(baseUrl, admin, "/api/shortvideo/terms", { method: "POST", ...jsonBody({ subject: "秋冬大衣穿搭", script, amount: 3 }) });
  await assertOk(response);
  assert.deepEqual((await response.json()).terms, ["autumn coat", "city street", "wool fabric"]);
  response = await request(baseUrl, admin, "/api/shortvideo/script", { method: "POST", ...jsonBody({ subject: "" }) });
  assert.equal(response.status, 400);

  /* ── 参数校验 ───────────────────────────────────────────────────────────── */
  response = await request(baseUrl, admin, "/api/shortvideo/tasks", { method: "POST", ...jsonBody({}) });
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /主题和文案至少填一个/);
  response = await request(baseUrl, admin, "/api/shortvideo/tasks", { method: "POST", ...jsonBody({ subject: "x", aspect: "4:3" }) });
  assert.equal(response.status, 400);

  /* ── 只给主题：服务端先写文案、抽关键词，再交给引擎 ─────────────────────── */
  const chatCountBefore = chatRequests.length;
  response = await request(baseUrl, admin, "/api/shortvideo/tasks", {
    method: "POST",
    ...jsonBody({ subject: "秋冬大衣穿搭三招", aspect: "9:16", voice: "zh-CN-YunxiNeural-Male", subtitle: { position: "center", size: 64 } }),
  });
  await assertOk(response, 202);
  let task = (await response.json()).task;
  assert.match(task.id, /^sv-/);
  assert.equal(task.status, "queued");
  assert.equal(task.credits, 0);
  assert.equal(task.params.voice, "zh-CN-YunxiNeural-Male");
  assert.equal(chatRequests.length, chatCountBefore + 2, "文案 + 关键词各调一次");
  const engineBody = [...engineTasks.values()].at(-1).body;
  assert.equal(engineBody.video_subject, "秋冬大衣穿搭三招");
  assert.equal(engineBody.video_script, script);
  assert.deepEqual(engineBody.video_terms, ["autumn coat", "city street", "wool fabric", "walking outdoors", "sunset skyline"]);
  assert.equal(engineBody.voice_name, "zh-CN-YunxiNeural-Male");
  assert.equal(engineBody.subtitle_position, "center");
  assert.equal(engineBody.font_size, 64);
  assert.equal(engineBody.video_aspect, "9:16");
  assert(engineLog.some((entry) => entry.method === "POST" && entry.path === "/api/v1/videos" && entry.apiKey === "mpt-secret-key"));

  const running = await waitForTask(baseUrl, admin, task.id, (item) => item.status === "running");
  assert(["script", "terms", "audio", "subtitle", "materials", "render", "import"].includes(running.stage));
  task = await waitForTask(baseUrl, admin, task.id, (item) => item.status === "completed");
  assert.equal(task.progress, 100);
  assert.equal(task.stage, "done");
  assert.equal(task.stageLabel, "完成");
  assert.equal(task.result.videos.length, 1);
  assert.equal(task.result.videos[0].name, "final-1.mp4");
  assert.equal(task.result.videos[0].bytes, fakeMp4.length);
  assert.equal(task.result.videos[0].url, `/api/shortvideo/tasks/${task.id}/files/final-1.mp4`);
  assert.equal(task.result.subtitle, `/api/shortvideo/tasks/${task.id}/files/subtitle.srt`);
  assert.equal(task.result.audioDuration, 14);
  assert.equal(task.finishedAt !== null, true);
  const stored = await fs.readFile(path.join(assetDir, task.id, "final-1.mp4"));
  assert.equal(stored.length, fakeMp4.length, "成片要落到本站目录");

  /* ── 文件路由：认登录、认归属、支持 Range ────────────────────────────────── */
  response = await request(baseUrl, admin, task.result.videos[0].url);
  await assertOk(response);
  assert.equal(response.headers.get("content-type"), "video/mp4");
  assert.equal((await response.arrayBuffer()).byteLength, fakeMp4.length);
  response = await request(baseUrl, admin, task.result.videos[0].url, { headers: { Range: "bytes=0-99" } });
  assert.equal(response.status, 206, "<video> 拖进度条靠 Range");
  assert.equal((await response.arrayBuffer()).byteLength, 100);
  response = await request(baseUrl, admin, `${task.result.videos[0].url}?download`);
  await assertOk(response);
  assert.match(response.headers.get("content-disposition"), /attachment/);
  response = await request(baseUrl, admin, task.result.subtitle);
  await assertOk(response);
  assert.match(await response.text(), /测试字幕/);
  response = await request(baseUrl, admin, `/api/shortvideo/tasks/${task.id}/files/..%2F..%2Fapp.db`);
  assert.equal(response.status, 404, "没登记过的文件名一律 404");
  response = await request(baseUrl, admin, `/api/shortvideo/tasks/${task.id}/files/combined-1.mp4`);
  assert.equal(response.status, 404);
  response = await request(baseUrl, viewer, task.result.videos[0].url);
  assert.equal(response.status, 403, "没权限的账号连文件都拿不到");
  response = await request(baseUrl, new Map(), task.result.videos[0].url);
  assert.equal(response.status, 401);

  response = await request(baseUrl, admin, "/api/shortvideo/tasks");
  await assertOk(response);
  assert.equal((await response.json()).tasks[0].id, task.id);

  /* ── 后台给普通账号打开：能用了，但只看得到自己的任务 ──────────────────── */
  response = await request(baseUrl, viewer, `/api/admin/users/${viewerUser.id}/shortvideo`, { method: "PUT", ...jsonBody({ enabled: true }) });
  assert.equal(response.status, 403, "普通账号不能给自己开");
  response = await request(baseUrl, admin, `/api/admin/users/${viewerUser.id}/shortvideo`, { method: "PUT", ...jsonBody({ enabled: "yes" }) });
  assert.equal(response.status, 400);
  response = await request(baseUrl, admin, `/api/admin/users/${viewerUser.id}/shortvideo`, { method: "PUT", ...jsonBody({ enabled: true }) });
  await assertOk(response);
  assert.deepEqual(await response.json(), { shortVideoEnabled: true, canUseShortVideo: true });
  response = await request(baseUrl, admin, "/api/admin/overview");
  await assertOk(response);
  const adminUsers = (await response.json()).users;
  assert.equal(adminUsers.find((item) => item.id === viewerUser.id).shortVideoEnabled, true);
  assert.equal(adminUsers.find((item) => item.id === adminAccount.id).canUseShortVideo, true);
  response = await request(baseUrl, viewer, "/api/me");
  assert.deepEqual((await response.json()).account.features, { shortVideo: true });
  response = await request(baseUrl, viewer, "/api/shortvideo/overview");
  await assertOk(response);
  assert.deepEqual((await response.json()).tasks, [], "只看自己的");
  response = await request(baseUrl, viewer, `/api/shortvideo/tasks/${task.id}`);
  assert.equal(response.status, 404, "别人的任务当不存在");
  response = await request(baseUrl, viewer, task.result.videos[0].url);
  assert.equal(response.status, 404);
  response = await request(baseUrl, admin, `/api/admin/users/${viewerUser.id}/shortvideo`, { method: "PUT", ...jsonBody({ enabled: false }) });
  await assertOk(response);
  response = await request(baseUrl, viewer, "/api/shortvideo/overview");
  assert.equal(response.status, 403, "关掉立刻生效");

  /* ── 并发上限：同一账号最多 N 条在跑 ─────────────────────────────────── */
  response = await request(baseUrl, admin, "/api/shortvideo/tasks", { method: "POST", ...jsonBody({ subject: "SLOW 慢任务", script: "现成文案", terms: ["a"] }) });
  await assertOk(response, 202);
  const slow = (await response.json()).task;
  await waitForTask(baseUrl, admin, slow.id, (item) => item.status === "running" && item.progress === 45);
  response = await request(baseUrl, admin, "/api/shortvideo/tasks", { method: "POST", ...jsonBody({ subject: "第二条", script: "现成文案", terms: ["a"] }) });
  assert.equal(response.status, 429);
  assert.match((await response.json()).error, /最多跑 1 条/);
  response = await request(baseUrl, admin, `/api/shortvideo/tasks/${slow.id}`, { method: "DELETE" });
  assert.equal(response.status, 409, "跑着的任务不能删");
  releaseSlow = true;
  const slowDone = await waitForTask(baseUrl, admin, slow.id, (item) => item.status === "completed");
  assert.equal(slowDone.script, "现成文案", "给了现成文案就不再调模型");

  /* ── 取消：跑着的任务本站标 cancelled、不再轮询，引擎那边顺手 DELETE；结束的任务不能再取消 ── */
  releaseSlow = false;
  response = await request(baseUrl, admin, "/api/shortvideo/tasks", { method: "POST", ...jsonBody({ subject: "SLOW 取消我", script: "现成文案", terms: ["a"] }) });
  await assertOk(response, 202);
  const cancelMe = (await response.json()).task;
  await waitForTask(baseUrl, admin, cancelMe.id, (item) => item.status === "running" && item.progress === 45);
  const cancelDeleteBefore = engineLog.filter((entry) => entry.method === "DELETE").length;
  response = await request(baseUrl, admin, `/api/shortvideo/tasks/${cancelMe.id}/cancel`, { method: "POST" });
  await assertOk(response, 200);
  const cancelled = await response.json();
  assert.equal(cancelled.task.status, "cancelled", "取消后状态是 cancelled");
  assert.equal(cancelled.activeCount, 0, "取消后不再占并发");
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(engineLog.filter((entry) => entry.method === "DELETE").length, cancelDeleteBefore + 1, "取消要把引擎侧任务删掉");
  response = await request(baseUrl, admin, `/api/shortvideo/tasks/${cancelMe.id}/cancel`, { method: "POST" });
  assert.equal(response.status, 409, "已经结束的任务不能再取消");
  response = await request(baseUrl, admin, `/api/shortvideo/tasks/${slow.id}/cancel`, { method: "POST" });
  assert.equal(response.status, 409, "完成的任务不能取消");
  response = await request(baseUrl, admin, `/api/shortvideo/tasks/${cancelMe.id}`, { method: "DELETE" });
  await assertOk(response, 200);
  releaseSlow = true;

  /* ── 引擎失败：阶段和原因原样带回来 ────────────────────────────────────── */
  response = await request(baseUrl, admin, "/api/shortvideo/tasks", { method: "POST", ...jsonBody({ subject: "FAIL 配音会挂", script: "文案", source: "local", materials: ["clip-1.mp4"] }) });
  await assertOk(response, 202);
  const failing = (await response.json()).task;
  const failed = await waitForTask(baseUrl, admin, failing.id, (item) => item.status === "failed");
  assert.equal(failed.stage, "failed");
  assert.equal(failed.failureSource, "engine");
  assert.match(failed.error, /配音阶段失败：TTS request timed out/);
  assert.equal([...engineTasks.values()].at(-1).body.video_source, "local");
  assert.deepEqual([...engineTasks.values()].at(-1).body.video_materials, [{ provider: "local", url: "clip-1.mp4", duration: 0 }]);

  /* ── 引擎重启丢了任务态，但成片已经落盘：照常收工 ──────────────────────── */
  response = await request(baseUrl, admin, "/api/shortvideo/tasks", { method: "POST", ...jsonBody({ subject: "LOST 引擎重启", script: "文案", terms: ["x"] }) });
  await assertOk(response, 202);
  const lost = (await response.json()).task;
  const recovered = await waitForTask(baseUrl, admin, lost.id, (item) => item.status === "completed");
  assert.equal(recovered.result.videos[0].name, "final-1.mp4");

  /* ── 素材上传转发给引擎，文件名重新起 ─────────────────────────────────── */
  const form = new FormData();
  form.append("file", new Blob([fakeMp4], { type: "video/mp4" }), "我的 素材.MP4");
  response = await request(baseUrl, admin, "/api/shortvideo/materials", { method: "POST", body: form });
  await assertOk(response);
  const uploaded = await response.json();
  assert.match(uploaded.file, /^[a-z0-9]+-[a-f0-9]{6}\.mp4$/, "中文名和空格不能原样发给引擎");
  assert.equal(uploaded.originalName, "我的 素材.MP4");
  const badForm = new FormData();
  badForm.append("file", new Blob([Buffer.from("x")], { type: "text/plain" }), "notes.txt");
  response = await request(baseUrl, admin, "/api/shortvideo/materials", { method: "POST", body: badForm });
  assert.equal(response.status, 400);
  response = await request(baseUrl, admin, "/api/shortvideo/materials");
  await assertOk(response);
  assert.deepEqual((await response.json()).files, [{ name: "clip-1.mp4", size: 89445 }]);
  response = await request(baseUrl, admin, "/api/shortvideo/musics");
  await assertOk(response);
  assert.equal((await response.json()).files[0].name, "output000.mp3");

  /* ── 发布文案：标题 / 简介 / 话题标签 ───────────────────────────────────── */
  response = await request(baseUrl, admin, "/api/shortvideo/metadata", { method: "POST", ...jsonBody({ subject: "秋冬大衣穿搭", script: "文案", platform: "xiaohongshu" }) });
  await assertOk(response);
  const metadataBody = await response.json();
  assert.equal(metadataBody.platform, "xiaohongshu");
  assert.equal(typeof metadataBody.metadata.title, "string");
  assert(Array.isArray(metadataBody.metadata.hashtags));
  assert(metadataBody.metadata.hashtags.every((tag) => tag.startsWith("#")), "话题标签都要带 #");
  response = await request(baseUrl, admin, "/api/shortvideo/metadata", { method: "POST", ...jsonBody({ subject: "x", platform: "myspace" }) });
  assert.equal(response.status, 400, "平台不在列表里要挡掉");

  /* ── 背景音乐上传 ───────────────────────────────────────────────────────── */
  const musicForm = new FormData();
  musicForm.append("file", new Blob([Buffer.alloc(2048, 1)], { type: "audio/mpeg" }), "我的 曲子.MP3");
  response = await request(baseUrl, admin, "/api/shortvideo/musics", { method: "POST", body: musicForm });
  await assertOk(response);
  const musicUploaded = await response.json();
  assert.match(musicUploaded.file, /^uuid-/, "引擎会把音乐改成不可变的文件名");
  assert.equal(musicUploaded.originalName, "我的 曲子.MP3");
  const badMusic = new FormData();
  badMusic.append("file", new Blob([Buffer.from("x")], { type: "video/mp4" }), "clip.mp4");
  response = await request(baseUrl, admin, "/api/shortvideo/musics", { method: "POST", body: badMusic });
  assert.equal(response.status, 400);

  /* ── 后台：配置页读得到、改得动 ─────────────────────────────────────────── */
  response = await request(baseUrl, viewer, "/api/admin/shortvideo");
  assert.equal(response.status, 403, "普通账号看不了短视频配置");
  response = await request(baseUrl, admin, "/api/admin/shortvideo");
  await assertOk(response);
  const adminConfig = await response.json();
  assert.equal(adminConfig.settings.llmModel, "test-chat-model");
  assert.equal(adminConfig.settings.maxActivePerUser, 1);
  assert.equal(adminConfig.settings.renderThreads, 2);
  assert.equal(adminConfig.engineConfig.editable, true, "配了 SHORTVIDEO_ENGINE_CONFIG 就能改引擎配置");
  assert.equal(adminConfig.engineConfig.restartAvailable, true);
  const pexelsField = adminConfig.engineConfig.fields.find((field) => field.id === "pexelsApiKeys");
  assert.equal(pexelsField.configured, false, "还没配 Pexels Key");
  assert.equal(pexelsField.value, "", "Key 字段永远不回明文");
  assert.equal(adminConfig.engineConfig.fields.find((field) => field.id === "subtitleProvider").value, "edge");

  response = await request(baseUrl, admin, "/api/admin/shortvideo/settings", {
    method: "PUT",
    ...jsonBody({ llmModel: "gpt-4.1-mini", maxActivePerUser: 3, renderThreads: 4, llmApiKey: "sk-admin-configured-key-0001" }),
  });
  await assertOk(response);
  const savedSettings = (await response.json()).settings;
  assert.equal(savedSettings.llmModel, "gpt-4.1-mini");
  assert.equal(savedSettings.maxActivePerUser, 3);
  assert.equal(savedSettings.renderThreads, 4);
  assert.equal(savedSettings.llmApiKeySource, "admin");
  assert.match(savedSettings.llmApiKeyHint, /^sk-…/, "只回脱敏提示");
  assert(!JSON.stringify(savedSettings).includes("sk-admin-configured-key-0001"), "明文 Key 不能回传");
  response = await request(baseUrl, admin, "/api/admin/shortvideo/settings", { method: "PUT", ...jsonBody({ maxActivePerUser: 99 }) });
  assert.equal(response.status, 400);
  // 改回来，后面的用例还要按原来的模型和并发跑。
  response = await request(baseUrl, admin, "/api/admin/shortvideo/settings", {
    method: "PUT",
    ...jsonBody({ llmModel: "", maxActivePerUser: "", renderThreads: "", llmApiKey: "" }),
  });
  await assertOk(response);
  assert.equal((await response.json()).settings.llmApiKeySource, "env", "清掉后台那把就退回 .env");

  response = await request(baseUrl, admin, "/api/admin/shortvideo/engine-config", {
    method: "PUT",
    ...jsonBody({ pexelsApiKeys: "key-one, key-two", subtitleProvider: "whisper", maxConcurrentTasks: 2 }),
  });
  await assertOk(response);
  const engineSaved = await response.json();
  assert.deepEqual(engineSaved.changed.sort(), ["maxConcurrentTasks", "pexelsApiKeys", "subtitleProvider"]);
  assert.equal(engineSaved.needsRestart, true, "引擎只在启动时读配置");
  const configText = await fs.readFile(engineConfigPath, "utf8");
  assert(configText.includes('pexels_api_keys = ["key-one", "key-two"]'));
  assert(configText.includes('subtitle_provider = "whisper"'));
  assert(configText.includes("max_concurrent_tasks = 2"));
  assert(configText.includes("# Register at https://www.pexels.com/api/"), "改配置不能把注释洗掉");
  assert.equal(engineSaved.engineConfig.fields.find((field) => field.id === "pexelsApiKeys").count, 2);
  response = await request(baseUrl, admin, "/api/admin/shortvideo/engine-config", { method: "PUT", ...jsonBody({ subtitleProvider: "vosk" }) });
  assert.equal(response.status, 400);
  response = await request(baseUrl, viewer, "/api/admin/shortvideo/engine-config", { method: "PUT", ...jsonBody({ subtitleProvider: "edge" }) });
  assert.equal(response.status, 403);

  response = await request(baseUrl, admin, "/api/admin/shortvideo/llm/test", { method: "POST" });
  await assertOk(response);
  assert.equal((await response.json()).result.ok, true);

  /* ── 删除：本站文件清掉，引擎那边顺手 DELETE ─────────────────────────── */
  const deleteCountBefore = engineLog.filter((entry) => entry.method === "DELETE").length;
  response = await request(baseUrl, admin, `/api/shortvideo/tasks/${task.id}`, { method: "DELETE" });
  await assertOk(response);
  await sleep(200);
  await assert.rejects(() => fs.access(path.join(assetDir, task.id)), "本站成片目录要删掉");
  assert.equal(engineLog.filter((entry) => entry.method === "DELETE").length, deleteCountBefore + 1);
  response = await request(baseUrl, admin, `/api/shortvideo/tasks/${task.id}`);
  assert.equal(response.status, 404);
  response = await request(baseUrl, admin, "/api/shortvideo/tasks");
  const remaining = (await response.json()).tasks.map((item) => item.id);
  assert(!remaining.includes(task.id));
  assert(remaining.includes(slow.id));

  console.log(JSON.stringify({ checks: "passed", engineCalls: engineLog.length, chatCalls: chatRequests.length }, null, 2));
} finally {
  app.kill("SIGTERM");
  fakeEngine.close();
  fakeChat.close();
  await fs.rm(tmpDir, { recursive: true, force: true });
}
