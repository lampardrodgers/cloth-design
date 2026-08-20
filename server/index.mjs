import "dotenv/config";
import express from "express";
import multer from "multer";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer as createViteServer } from "vite";
import { authHandler, requireAccount, runAuthMigrations, selfSignupAllowed } from "./auth.mjs";
import { registerBusinessRoutes, serializeAccount } from "./api.mjs";
import { creditPolicySettings } from "./app-settings.mjs";
import { migrateBusinessDatabase, nowIso, sqlite } from "./db.mjs";
import { assertDebugProductionReady, debugUnlimitedAvailable } from "./debug.mjs";
import { MAX_IMAGE_BYTES, generatedImageStaticMount, persistGeneratedImage, readManagedGeneratedImage, validateImageBuffer } from "./image-provider.mjs";
import { imageQualityGate } from "./image-quality.mjs";
import { assertPaymentProductionReady, consumeCredits, handleAlipayNotify, handleWechatNotify, refundCredits } from "./payments.mjs";
import { imageProviderHealth, summarizeProviderErrorText } from "./provider-health.mjs";
import { generatedVideoStaticMount } from "./video-provider.mjs";
import { migrateWorkflowDatabase, registerWorkflowRoutes } from "./workflows.mjs";
import { migrateShortVideoDatabase, registerShortVideoRoutes, resumeShortVideoPolling } from "./shortvideo.mjs";
import { migrateSeedanceDatabase, registerSeedanceRoutes, resumeSeedancePolling } from "./seedance.mjs";
import { fetchWithTimeout, timeoutMsFromEnv } from "./timeouts.mjs";
import { readResponseBufferLimited, safeOutboundFetch } from "./safe-outbound.mjs";
import { resolveProviderApiKey, serverApiKey } from "./user-keys.mjs";
import { clampResolution, imageApiUrl, imageProviderSettings, imageProviderSettingsList, normalizeResolution } from "./provider-config.mjs";
import { SERVER_RETENTION_DAYS, autoArchiveTaskResults, scheduleStorageMaintenance } from "./storage.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const isProduction = process.env.NODE_ENV === "production";
const port = Number(process.env.PORT || 8888);
const host = process.env.HOST || "127.0.0.1";

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_IMAGE_BYTES,
    files: 16,
  },
});

const app = express();
app.disable("x-powered-by");

assertDebugProductionReady();
await runAuthMigrations();
migrateBusinessDatabase();
migrateWorkflowDatabase();
migrateShortVideoDatabase();
migrateSeedanceDatabase();
assertPaymentProductionReady();
if (isProduction && process.env.PAYMENT_DEMO_MODE !== "false") {
  console.warn("Payment demo mode is active in production. Set PAYMENT_DEMO_MODE=false after configuring Alipay and WeChat Pay credentials.");
}

// 关掉自助注册时，直接在 HTTP 层挡住注册端点；后台建号走的是服务端 API，不经过这里。
app.post("/api/auth/sign-up/{*any}", (req, res, next) => {
  if (selfSignupAllowed()) return next();
  res.status(403).json({ error: "本站不开放自助注册，请联系管理员开通账号。" });
});
app.all("/api/auth/{*any}", authHandler);

app.post("/api/payments/alipay/notify", express.urlencoded({ extended: false }), async (req, res) => {
  try {
    await handleAlipayNotify(req.body);
    res.type("text/plain").send("success");
  } catch (error) {
    console.error(error);
    res.type("text/plain").status(400).send("failure");
  }
});

app.post("/api/payments/wechat/notify", express.raw({ type: "application/json", limit: "2mb" }), async (req, res) => {
  try {
    await handleWechatNotify(req.headers, req.body.toString("utf8"));
    res.json({ code: "SUCCESS", message: "成功" });
  } catch (error) {
    console.error(error);
    res.status(400).json({ code: "FAIL", message: error instanceof Error ? error.message : "失败" });
  }
});

const protectedJson = express.json({ limit: "25mb" });
const smallPublicJson = express.json({ limit: "64kb" });

function publicApiRequest(req) {
  const pathname = String(req.originalUrl || req.url || "").split("?", 1)[0];
  if (pathname.startsWith("/api/auth/")) return true;
  if (pathname === "/api/config" && req.method === "GET") return true;
  if (pathname === "/api/packages" && req.method === "GET") return true;
  if (pathname === "/api/debug/config" && req.method === "GET") return true;
  if (pathname === "/api/debug/session" && ["POST", "DELETE"].includes(req.method)) return true;
  // 火山方舟必须能回源读取随机 ID 素材；路由自身还会校验 ID、扩展名和文件归属状态。
  if (pathname.startsWith("/api/seedance/refs/public/") && req.method === "GET") return true;
  return pathname === "/api/client-errors" && req.method === "POST";
}

// 两个公开 POST 只接受很小的 JSON；其余 API 必须先完成认证，再解析大 JSON 或 multipart。
app.use("/api/client-errors", smallPublicJson);
app.use("/api/debug/session", smallPublicJson);
app.use("/api", async (req, res, next) => {
  if (publicApiRequest(req)) return next();
  const account = await requireAccount(req, res);
  if (!account) return;
  next();
});
app.use("/api", (req, res, next) => {
  if (publicApiRequest(req)) return next();
  protectedJson(req, res, next);
});

function hasServerImageKey() {
  return imageProviderSettingsList().some((provider) => Boolean(serverApiKey(provider.id)));
}

/** 有没有可用的 Key：账号自备、后台共享和 .env 任一存在都算。 */
function isDemoMode(apiKey) {
  const ready = apiKey === undefined ? hasServerImageKey() : Boolean(String(apiKey || "").trim());
  return process.env.OPENAI_DEMO_MODE === "true" || !ready;
}

function imageRequestTimeoutMs() {
  return timeoutMsFromEnv("OPENAI_IMAGE_TIMEOUT_MS", 180000);
}

function publicConfig(apiKey, provider = imageProviderSettings()) {
  const mode = isDemoMode(apiKey) ? "demo" : "live";
  const providerReady = apiKey === undefined ? hasServerImageKey() : Boolean(String(apiKey || "").trim());
  return {
    mode,
    providerReady,
    imageModelConfigured: Boolean(provider.model),
    authEnabled: true,
    selfSignupAllowed: selfSignupAllowed(),
    debugUnlimitedAvailable: debugUnlimitedAvailable(),
    storageRetentionDays: SERVER_RETENTION_DAYS,
    port,
    providerHealth: imageProviderHealth({ mode, providerReady }),
    imageProviders: imageProviderSettingsList().map(({ id, name, protocol, maxResolution, baseUrl, model }) => ({ id, name, protocol, maxResolution, baseUrl, model })),
  };
}

function mimeForFormat(format = "png") {
  if (format === "jpeg") return "image/jpeg";
  if (format === "webp") return "image/webp";
  return "image/png";
}

function safeOutputFormat(format) {
  return ["png", "jpeg", "webp"].includes(format) ? format : "png";
}

function createDemoImage({ mode = "text", label = "演示图", ratioLabel = "1:1", index = 1 }) {
  const palettes = {
    text: ["#e9d7c3", "#2f6f61", "#c24e32"],
    free: ["#e5e7eb", "#4f46e5", "#0f766e"],
    tryon: ["#dbe8e4", "#1f5c68", "#d77047"],
    fusion: ["#ebe4d7", "#5d5a95", "#2c8c7d"],
    campaign: ["#f0d5ce", "#b83534", "#2e624c"],
    product: ["#f2f3f0", "#34302d", "#a7b6a4"],
    fabric: ["#e7e1f0", "#7e3f8f", "#2e8d73"],
    lookbook: ["#dde5d6", "#4b6d3a", "#c15f3d"],
  };
  const [bg, primary, accent] = palettes[mode] || palettes.text;
  const width = ratioLabel === "16:9" ? 1280 : ratioLabel === "9:16" ? 900 : 1080;
  const height = ratioLabel === "16:9" ? 720 : ratioLabel === "9:16" ? 1600 : 1080;
  const cx = width / 2;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
    <defs>
      <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${bg}"/><stop offset="1" stop-color="#ffffff"/></linearGradient>
      <pattern id="pin" width="38" height="38" patternUnits="userSpaceOnUse"><path d="M0 38 L38 0" stroke="${accent}" stroke-opacity="0.15" stroke-width="3"/></pattern>
      <filter id="shadow" x="-20%" y="-20%" width="140%" height="140%"><feDropShadow dx="0" dy="24" stdDeviation="28" flood-color="#000000" flood-opacity="0.18"/></filter>
    </defs>
    <rect width="100%" height="100%" fill="url(#bg)"/>
    <rect x="${width * 0.08}" y="${height * 0.08}" width="${width * 0.84}" height="${height * 0.84}" rx="28" fill="url(#pin)" opacity="0.75"/>
    <circle cx="${cx}" cy="${height * 0.2}" r="${Math.min(width, height) * 0.075}" fill="${primary}" opacity="0.9"/>
    <path filter="url(#shadow)" d="M${cx - width * 0.12} ${height * 0.3} C${cx - width * 0.22} ${height * 0.42} ${cx - width * 0.25} ${height * 0.58} ${cx - width * 0.2} ${height * 0.72} L${cx + width * 0.2} ${height * 0.72} C${cx + width * 0.25} ${height * 0.58} ${cx + width * 0.22} ${height * 0.42} ${cx + width * 0.12} ${height * 0.3} C${cx + width * 0.06} ${height * 0.34} ${cx - width * 0.06} ${height * 0.34} ${cx - width * 0.12} ${height * 0.3} Z" fill="${primary}"/>
    <path d="M${cx - width * 0.16} ${height * 0.46} C${cx - width * 0.05} ${height * 0.5} ${cx + width * 0.05} ${height * 0.5} ${cx + width * 0.16} ${height * 0.46}" fill="none" stroke="${accent}" stroke-width="12" stroke-linecap="round"/>
    <text x="${width * 0.08}" y="${height * 0.9}" fill="#282522" font-family="Arial, sans-serif" font-size="${Math.max(30, width * 0.045)}" font-weight="700">${label}</text>
    <text x="${width * 0.08}" y="${height * 0.94}" fill="#5d625f" font-family="Arial, sans-serif" font-size="${Math.max(18, width * 0.024)}">Demo mode ${index.toString().padStart(2, "0")}</text>
  </svg>`;
  return `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`;
}

function normalizePayload(rawPayload) {
  const payload = JSON.parse(rawPayload || "{}");
  const settings = payload.settings || {};
  const format = safeOutputFormat(settings.outputFormat);
  return {
    prompt: String(payload.prompt || "").trim().slice(0, 32000),
    // 用户原话另存一份：拼装后的 prompt 带满行业约束，回看时读的不是那个。
    userPrompt: String(payload.userPrompt || payload.prompt || "").trim().slice(0, 4000),
    mode: payload.mode || "text",
    action: payload.action || "generate",
    ratioLabel: payload.ratioLabel || "1:1",
    size: payload.apiSize || "auto",
    quantity: Math.min(Math.max(Number(settings.quantity || 1), 1), 10),
    quality: settings.quality || "auto",
    background: settings.background || "auto",
    moderation: settings.moderation || "auto",
    references: Array.isArray(payload.references) ? payload.references : [],
    outputFormat: format,
    outputCompression: Number(settings.compression || 100),
    inputFidelity: settings.inputFidelity === "high" ? "high" : "low",
    resolution: normalizeResolution(settings.resolution),
    apiResolution: apiResolutionOf(settings.resolution),
  };
}

/** 内部档位名换成接口认的写法。 */
function apiResolutionOf(resolution) {
  return normalizeResolution(resolution) === "fourK" ? "4k" : normalizeResolution(resolution) === "hd" ? "2k" : "1k";
}

/**
 * 出图前按账号上限裁一刀：线路给不了的档位不能提交，也不能按那个档位计费。
 * 前端已经把超限的档位禁掉了，这里是老页面 / 直接打接口的兜底。
 */
function applyResolutionLimit(payload, maxResolution) {
  const capped = clampResolution(payload.resolution, maxResolution);
  if (capped === payload.resolution) return payload;
  payload.resolution = capped;
  payload.apiResolution = apiResolutionOf(capped);
  return payload;
}

function validateGenerationPayload(payload) {
  if (!payload.prompt) {
    return "提示词不能为空。";
  }
  return "";
}

function safeReferenceSourceUrl(value) {
  const sourceUrl = String(value || "");
  if (sourceUrl.startsWith("data:image/")) return sourceUrl;
  const { publicPath } = generatedImageStaticMount();
  if (sourceUrl.startsWith(`${publicPath}/`)) return sourceUrl;
  try {
    const url = new URL(sourceUrl);
    return url.protocol === "https:" ? url.href : "";
  } catch {
    return "";
  }
}

async function fetchReferenceSource(reference) {
  const sourceUrl = safeReferenceSourceUrl(reference.sourceUrl);
  if (!sourceUrl) return null;
  const { publicPath } = generatedImageStaticMount();
  const label = `参考图${reference.label || ""}`;
  const assertValidReference = (file) => {
    const validation = validateImageBuffer(file.buffer, file.mimetype, label);
    assertReferenceImageUsable(validation, label);
    return { ...file, mimetype: validation.mimeType };
  };
  if (sourceUrl.startsWith(`${publicPath}/`)) {
    return assertValidReference(await readManagedGeneratedImage(sourceUrl, `${reference.label || "reference"}.png`));
  }
  if (sourceUrl.startsWith("data:image/")) {
    const [meta, encoded] = sourceUrl.split(",", 2);
    const mime = meta.match(/^data:([^;]+)/)?.[1] || "image/png";
    return assertValidReference({
      buffer: Buffer.from(encoded || "", meta.includes(";base64") ? "base64" : "utf8"),
      mimetype: mime,
      originalname: `${reference.label || "reference"}.png`,
    });
  }
  const response = await safeOutboundFetch(sourceUrl, {}, {
    timeoutMs: imageRequestTimeoutMs(),
    timeoutMessage: `参考图${reference.label || ""}下载超时。`,
    label: `参考图${reference.label || ""}地址`,
  });
  if (!response.ok) {
    throw new Error(`参考图${reference.label || ""}下载失败 (${response.status})`);
  }
  const mime = response.headers.get("content-type") || "image/png";
  if (!mime.startsWith("image/")) {
    throw new Error(`参考图${reference.label || ""}不是图片资源`);
  }
  const buffer = await readResponseBufferLimited(response, {
    maxBytes: MAX_IMAGE_BYTES,
    timeoutMs: imageRequestTimeoutMs(),
    timeoutMessage: `参考图${reference.label || ""}下载超时。`,
    label,
  });
  return assertValidReference({
    buffer,
    mimetype: mime,
    originalname: `${reference.label || "reference"}.png`,
  });
}

function validateUploadedReferenceFile(file, reference, uploadIndex) {
  const label = `参考图${reference.label || uploadIndex}`;
  const validation = validateImageBuffer(file.buffer, file.mimetype || "image/png", label);
  assertReferenceImageUsable(validation, label);
  return {
    ...file,
    mimetype: validation.mimeType,
    originalname: `${reference.label || uploadIndex}-${file.originalname || "reference.png"}`,
  };
}

function assertReferenceImageUsable(validation, label) {
  const width = Number(validation.dimensions?.width || 0);
  const height = Number(validation.dimensions?.height || 0);
  if (width < 256 || height < 256) {
    throw new Error(`${label}尺寸过小，最小需要 256x256。`);
  }
}

async function orderedReferenceFiles(payload, uploadedFiles) {
  const files = [];
  let uploadIndex = 0;
  for (const reference of payload.references) {
    if (reference.hasFile) {
      const uploaded = uploadedFiles[uploadIndex];
      uploadIndex += 1;
      if (uploaded) {
        files.push(validateUploadedReferenceFile(uploaded, reference, uploadIndex));
      }
      continue;
    }
    const fetched = await fetchReferenceSource(reference);
    if (fetched) files.push(fetched);
  }
  return files;
}

function estimateCredits(payload) {
  const baseCredits = {
    text: 12,
    free: 12,
    tryon: 28,
    fusion: 34,
    campaign: 24,
    product: 18,
    fabric: 16,
    lookbook: 26,
  };
  // 后台「积分规则」改过的覆盖默认值；和 /api/me 下发给客户端报价的是同一份。
  const policy = creditPolicySettings();
  const activeReferenceCount = payload.references.filter(
    (item) => item.hasFile || item.fileName || safeReferenceSourceUrl(item.sourceUrl),
  ).length;
  let total = (baseCredits[payload.mode] || baseCredits.text) + activeReferenceCount * policy.perReference;
  if (payload.quality === "high") total *= policy.highQualityMultiplier;
  if (payload.resolution === "fourK") total *= policy.fourKMultiplier;
  if (payload.background === "transparent") total += policy.transparentBackgroundFee;
  if (payload.inputFidelity === "high" && activeReferenceCount > 0) total += activeReferenceCount * 3;
  return Math.ceil(total * payload.quantity);
}

function insertGenerationTask({ id, userId, payload, cost, keySource = "server" }) {
  const timestamp = nowIso();
  sqlite
    .prepare(
      `INSERT INTO generation_task (id, user_id, mode, prompt, status, credits, message, key_source, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'running', ?, '生成中', ?, ?, ?)`,
    )
    .run(id, userId, payload.mode, payload.prompt, cost, keySource, timestamp, timestamp);
}

/**
 * failureSource：这次失败算谁的。
 * - provider：图像接口（超时、报错、额度）——「图像接口健康度」看的就是这一类；
 * - system：我们自己（积分扣费失败、服务重启收口）——不能拿它把接口报成故障。
 */
function updateGenerationTask({ id, status, credits, message, failureSource = null }) {
  sqlite
    .prepare("UPDATE generation_task SET status = ?, credits = ?, message = ?, failure_source = ?, updated_at = ? WHERE id = ?")
    .run(status, credits, message, failureSource, nowIso(), id);
}

function generatedResultMetadata(result, index, payload = {}) {
  return JSON.stringify({
    index: result.index ?? index,
    prompt: payload.userPrompt || null,
    imageInspection: result.imageInspection || null,
    qualityGate: result.qualityGate || null,
    revisedPrompt: result.revisedPrompt || null,
  });
}

function insertGeneratedResults({ userId, taskId, payload, results, cost }) {
  const timestamp = nowIso();
  const insert = sqlite.prepare(
    `INSERT INTO generated_result
      (id, task_id, user_id, title, mode, ratio_label, storage_status, credits, image_url, metadata_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'cloud-temp', ?, ?, ?, ?)`,
  );
  results.forEach((result, index) => {
    insert.run(
      `result-${taskId}-${index}`,
      taskId,
      userId,
      `${payload.mode}-${timestamp.slice(11, 16).replace(":", "")}-${index + 1}`,
      payload.mode,
      payload.ratioLabel,
      Math.ceil(cost / Math.max(results.length, 1)),
      result.imageUrl,
      generatedResultMetadata(result, index, payload),
      timestamp,
    );
  });
}

function summarizeImagesApiError(status, text) {
  const message = summarizeProviderErrorText(text, 500);
  if (/model_not_found|无可用渠道|分组/.test(text)) {
    return `图像模型不可用 (${status})：${message}。请检查 API 令牌分组是否支持当前模型。`;
  }
  return `图像引擎请求失败 (${status})：${message}`;
}

async function parseOpenAIResponse(response, outputFormat, targetSize, outputCompression) {
  if (!response.ok) {
    const text = await response.text();
    throw new Error(summarizeImagesApiError(response.status, text));
  }
  const data = await response.json();
  const items = Array.isArray(data.data) ? data.data : [];
  if (items.length === 0) {
    throw new Error("图像引擎没有返回图片。");
  }
  return persistApiImageItems(items, { outputFormat, targetSize, outputCompression });
}

async function persistApiImageItems(items, { outputFormat = "png", targetSize, outputCompression } = {}) {
  return Promise.all(
    items.map(async (item, index) => {
      const persisted = await persistGeneratedImage(item, {
        fallbackMimeType: mimeForFormat(outputFormat),
        targetSize,
        outputCompression,
      });
      return {
        ...persisted,
        qualityGate: imageQualityGate(persisted.imageInspection),
        revisedPrompt: item.revised_prompt,
        index,
      };
    }),
  );
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function apimartResultItems(task) {
  const images = Array.isArray(task?.result?.images) ? task.result.images : [];
  return images.flatMap((image) => {
    const urls = Array.isArray(image?.url) ? image.url : image?.url ? [image.url] : [];
    return urls.map((url) => ({ url }));
  });
}

async function callApimartImages(payload, files, apiKey, provider) {
  const headers = { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" };
  const results = [];
  for (let index = 0; index < Math.max(1, payload.quantity); index += 1) {
    const body = {
      model: provider.model,
      prompt: payload.prompt,
      n: 1,
      size: payload.size === "auto" ? "auto" : payload.ratioLabel || "1:1",
      resolution: payload.apiResolution,
    };
    if (files.length > 0) {
      body.image_urls = files.map((file) => {
        if (file.buffer.length > 20 * 1024 * 1024) throw new Error("APIMart 单张参考图不能超过 20MB。");
        return `data:${file.mimetype || "image/png"};base64,${file.buffer.toString("base64")}`;
      });
    }
    const submitted = await fetchWithTimeout(imageApiUrl("/images/generations", provider.id), {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    }, {
      timeoutMs: imageRequestTimeoutMs(),
      timeoutMessage: "APIMart 图像任务提交超时。",
    });
    if (!submitted.ok) {
      const text = await submitted.text();
      throw new Error(summarizeImagesApiError(submitted.status, text));
    }
    const submitData = await submitted.json();
    const taskId = submitData?.data?.[0]?.task_id;
    if (!taskId) throw new Error("APIMart 没有返回任务 ID。");

    const deadline = Date.now() + imageRequestTimeoutMs();
    let task = null;
    while (Date.now() < deadline) {
      await wait(1500);
      const statusResponse = await fetchWithTimeout(
        `${imageApiUrl(`/tasks/${encodeURIComponent(taskId)}`, provider.id)}?language=zh`,
        { headers: { Authorization: `Bearer ${apiKey}` } },
        { timeoutMs: Math.max(100, deadline - Date.now()), timeoutMessage: "APIMart 图像任务查询超时。" },
      );
      if (!statusResponse.ok) {
        const text = await statusResponse.text();
        throw new Error(summarizeImagesApiError(statusResponse.status, text));
      }
      task = (await statusResponse.json())?.data;
      if (["failed", "cancelled"].includes(task?.status)) {
        throw new Error(`APIMart 图像任务失败：${task?.error?.message || task?.status || "未知错误"}`);
      }
      if (task?.status === "completed") break;
    }
    if (task?.status !== "completed") throw new Error("APIMart 图像任务等待超时。");
    const items = apimartResultItems(task);
    if (items.length === 0) throw new Error("APIMart 图像任务完成但没有返回图片。");
    results.push(...(await persistApiImageItems(items, {
      outputFormat: payload.outputFormat,
      outputCompression: payload.outputCompression,
    })));
  }
  return results.map((result, index) => ({ ...result, index }));
}

async function callOpenAIImages(payload, files, apiKey, provider) {
  if (provider.protocol === "apimart") return callApimartImages(payload, files, apiKey, provider);
  const model = provider.model;
  const headers = {
    Authorization: `Bearer ${apiKey}`,
  };
  const results = [];
  const requestCount = Math.max(1, payload.quantity);

  for (let index = 0; index < requestCount; index += 1) {
    if (files.length > 0 || payload.action !== "generate") {
      const form = new FormData();
      form.append("model", model);
      form.append("prompt", payload.prompt);
      form.append("n", "1");
      form.append("size", payload.size);
      form.append("quality", payload.quality);
      form.append("background", payload.background);
      form.append("moderation", payload.moderation);
      form.append("response_format", "url");
      form.append("output_format", payload.outputFormat);
      form.append("input_fidelity", payload.inputFidelity);
      if (payload.outputFormat !== "png") {
        form.append("output_compression", String(payload.outputCompression));
      }
      for (const file of files) {
        const blob = new Blob([file.buffer], { type: file.mimetype || "image/png" });
        form.append("image", blob, file.originalname || "reference.png");
      }

      const response = await fetchWithTimeout(imageApiUrl("/images/edits", provider.id), {
        method: "POST",
        headers,
        body: form,
      }, {
        timeoutMs: imageRequestTimeoutMs(),
        timeoutMessage: "图像引擎请求超时。",
      });
      results.push(...(await parseOpenAIResponse(response, payload.outputFormat, payload.size, payload.outputCompression)));
      continue;
    }

    const body = {
      model,
      prompt: payload.prompt,
      n: 1,
      size: payload.size,
      quality: payload.quality,
      background: payload.background,
      moderation: payload.moderation,
      response_format: "url",
      output_format: payload.outputFormat,
    };
    if (payload.outputFormat !== "png") {
      body.output_compression = payload.outputCompression;
    }

    const response = await fetchWithTimeout(imageApiUrl("/images/generations", provider.id), {
      method: "POST",
      headers: {
        ...headers,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    }, {
      timeoutMs: imageRequestTimeoutMs(),
      timeoutMessage: "图像引擎请求超时。",
    });
    results.push(...(await parseOpenAIResponse(response, payload.outputFormat, payload.size, payload.outputCompression)));
  }

  return results.map((result, index) => ({ ...result, index }));
}

app.get("/api/config", (_req, res) => {
  res.json(publicConfig());
});

registerBusinessRoutes(app);
registerWorkflowRoutes(app);
registerShortVideoRoutes(app);
registerSeedanceRoutes(app);

app.post("/api/generate", upload.array("images", 16), async (req, res) => {
  let taskId = "";
  let account = null;
  let cost = 0;
  let providerKey = null;
  try {
    account = await requireAccount(req, res);
    if (!account) return;

    const payload = normalizePayload(req.body.payload);
    const validationError = validateGenerationPayload(payload);
    if (validationError) {
      res.status(400).json({
        ...publicConfig(),
        error: validationError,
      });
      return;
    }
    const files = await orderedReferenceFiles(payload, Array.isArray(req.files) ? req.files : []);
    taskId = `task-${Date.now()}`;
    // 账号自备 Key 的请求接口费用是他们自己的，不再扣积分；用服务端 Key 才计费。
    providerKey = resolveProviderApiKey(account.user.id);
    applyResolutionLimit(payload, providerKey.maxResolution);
    const ownKey = providerKey.source === "user";
    cost = ownKey ? 0 : estimateCredits(payload);

    insertGenerationTask({ id: taskId, userId: account.user.id, payload, cost, keySource: ownKey ? "user" : "server" });
    try {
      if (cost > 0) {
        consumeCredits({
          userId: account.user.id,
          taskId,
          amount: cost,
          reason: `${payload.mode} 图片生成`,
        });
      }
    } catch (error) {
      updateGenerationTask({
        id: taskId,
        status: "failed",
        credits: 0,
        message: error instanceof Error ? error.message : "积分扣费失败",
        failureSource: "system",
      });
      res.status(402).json({
        ...publicConfig(providerKey.apiKey, providerKey.provider),
        error: error instanceof Error ? error.message : "积分余额不足。",
      });
      return;
    }

    if (isDemoMode(providerKey.apiKey)) {
      const demoMessage = process.env.OPENAI_DEMO_MODE === "true"
        ? "演示模式已开启，未调用图像引擎。"
        : `${providerKey.provider.name} 未配置可用 API Key，已使用演示模式。`;
      const results = Array.from({ length: payload.quantity }, (_, index) => ({
        imageUrl: createDemoImage({
          mode: payload.mode,
          label: payload.mode,
          ratioLabel: payload.ratioLabel,
          index: index + 1,
        }),
        index,
      }));
      updateGenerationTask({
        id: taskId,
        status: "success",
        credits: cost,
        message: demoMessage,
      });
      insertGeneratedResults({ userId: account.user.id, taskId, payload, results, cost });
      const profile = sqlite.prepare("SELECT * FROM user_profile WHERE user_id = ?").get(account.user.id);
      res.json({
        ...publicConfig(providerKey.apiKey, providerKey.provider),
        results,
        taskId,
        credits: cost,
        account: serializeAccount(account.user, profile),
        message: demoMessage,
      });
      return;
    }

    const results = await callOpenAIImages(payload, files, providerKey.apiKey, providerKey.provider);
    const doneMessage = ownKey
      ? `${providerKey.provider.name} 已返回结果（自备 Key，未扣积分）。`
      : `${providerKey.provider.name} 已返回结果。`;
    updateGenerationTask({
      id: taskId,
      status: "success",
      credits: cost,
      message: doneMessage,
    });
    insertGeneratedResults({ userId: account.user.id, taskId, payload, results, cost });
    // 账号开了 WebDAV 自动归档就在后台推上去，不拖慢这次响应
    void autoArchiveTaskResults(account.user.id, taskId).catch((error) => console.warn("[storage] auto archive", error));
    const profile = sqlite.prepare("SELECT * FROM user_profile WHERE user_id = ?").get(account.user.id);
    res.json({
      ...publicConfig(providerKey.apiKey, providerKey.provider),
      results,
      taskId,
      credits: cost,
      account: serializeAccount(account.user, profile),
      message: doneMessage,
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : "生成失败";
    // 任务状态必须收口。以前退款和落库写在一起，自备 Key 的账号 cost 恒为 0，
    // 一失败就跳过整段，任务永远停在「运行中」，后台看着像还在跑，其实早就断了。
    if (taskId) {
      console.error(`[generate] task ${taskId} failed: ${reason}`);
      let message = reason;
      if (account && cost > 0) {
        try {
          refundCredits({
            userId: account.user.id,
            taskId,
            amount: cost,
            reason: "生成失败自动退款",
          });
          message = `${reason}，积分已退回`;
        } catch (refundError) {
          console.error(refundError);
          message = `${reason}（积分退回失败，请联系管理员）`;
        }
      }
      try {
        updateGenerationTask({ id: taskId, status: "failed", credits: 0, message, failureSource: "provider" });
      } catch (updateError) {
        console.error(updateError);
      }
    }
    const status = !taskId && error instanceof Error && /^参考图/.test(error.message) ? 400 : 500;
    res.status(status).json({
      ...publicConfig(providerKey?.apiKey, providerKey?.provider),
      error: error instanceof Error ? error.message : "Unknown generation error",
    });
  }
});

const generatedImages = generatedImageStaticMount();
app.use(generatedImages.publicPath, express.static(generatedImages.directory));
const generatedVideos = generatedVideoStaticMount();
app.use(generatedVideos.publicPath, express.static(generatedVideos.directory));
// 成片 / 视频路径下找不到文件就明确 404：不然会一路掉进下面的 SPA 回退，返回 index.html + 200——
// 客户端的「过期检测」整个被打穿，画布还会把这页 HTML 当图片存进资产里。
const missingManagedAsset = (_req, res) => {
  res.status(404).type("text/plain").send("文件不存在或已按保留期清理");
};
app.use(generatedImages.publicPath, missingManagedAsset);
app.use(generatedVideos.publicPath, missingManagedAsset);

if (isProduction) {
  const distPath = path.join(root, "dist");
  app.use(express.static(distPath));
  app.get(/.*/, (_req, res) => {
    res.sendFile(path.join(distPath, "index.html"));
  });
} else {
  const vite = await createViteServer({
    root,
    server: { middlewareMode: true, hmr: process.env.NODE_ENV === "test" ? false : undefined },
    appType: "spa",
  });
  app.use(vite.middlewares);
}

/**
 * 进程重启会把手上正在跑的生成一起带走：请求断了，任务却还写着「运行中」，
 * 后台看上去像在跑，其实永远不会有结果。启动时统一收口成失败。
 */
function failInterruptedTasks() {
  const stuck = sqlite
    .prepare(
      "UPDATE generation_task SET status = 'failed', message = ?, failure_source = 'system', updated_at = ? WHERE status = 'running'",
    )
    .run("服务重启时这条任务被中断，没有出图。", nowIso());
  if (stuck.changes > 0) console.warn(`[startup] ${stuck.changes} 条中断的生成任务已标记为失败`);
}

failInterruptedTasks();
// 短视频任务跑在独立引擎里，本站重启不影响它继续渲染：把没跑完的重新纳入轮询。
resumeShortVideoPolling();
resumeSeedancePolling();

app.listen(port, host, () => {
  console.log(`ClothDesign AI running at http://${host}:${port}/ (${isDemoMode() ? "demo" : "live"} mode)`);
});

// 服务器暂存固定 3 天：每小时巡检一次，到期删文件、标过期，顺手清孤儿文件。
// 测试进程里不跑，免得干扰按时间断言的用例。
if (process.env.NODE_ENV !== "test" && process.env.STORAGE_MAINTENANCE !== "false") {
  scheduleStorageMaintenance();
}
