import "dotenv/config";
import express from "express";
import multer from "multer";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer as createViteServer } from "vite";
import { authHandler, requireAccount, runAuthMigrations, selfSignupAllowed } from "./auth.mjs";
import { registerBusinessRoutes, serializeAccount } from "./api.mjs";
import { migrateBusinessDatabase, nowIso, sqlite } from "./db.mjs";
import { debugUnlimitedAvailable } from "./debug.mjs";
import { generatedImageStaticMount, persistGeneratedImage, readManagedGeneratedImage, validateImageBuffer } from "./image-provider.mjs";
import { imageQualityGate } from "./image-quality.mjs";
import { assertPaymentProductionReady, consumeCredits, handleAlipayNotify, handleWechatNotify, refundCredits } from "./payments.mjs";
import { imageProviderHealth, summarizeProviderErrorText } from "./provider-health.mjs";
import { generatedVideoStaticMount } from "./video-provider.mjs";
import { migrateWorkflowDatabase, registerWorkflowRoutes } from "./workflows.mjs";
import { fetchWithTimeout, timeoutMsFromEnv } from "./timeouts.mjs";
import { resolveProviderApiKey } from "./user-keys.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const isProduction = process.env.NODE_ENV === "production";
const port = Number(process.env.PORT || 8888);
const host = process.env.HOST || "127.0.0.1";

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 50 * 1024 * 1024,
    files: 16,
  },
});

const app = express();
app.disable("x-powered-by");

await runAuthMigrations();
migrateBusinessDatabase();
migrateWorkflowDatabase();
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

app.use(express.json({ limit: "25mb" }));

function hasOpenAIKey() {
  return Boolean(process.env.OPENAI_API_KEY && process.env.OPENAI_API_KEY.trim().length > 0);
}

/** 有没有可用的 Key：账号自备的也算。没传 apiKey 时只看服务端 .env。 */
function isDemoMode(apiKey = process.env.OPENAI_API_KEY) {
  return process.env.OPENAI_DEMO_MODE === "true" || !String(apiKey || "").trim();
}

function configuredImageApiBaseUrl() {
  const configuredUrl =
    process.env.OPENAI_BASE_URL || process.env.OPENAI_API_BASE_URL || process.env.PACKY_API_BASE_URL || "https://api.openai.com";
  const trimmed = configuredUrl.trim().replace(/\/+$/, "");
  return trimmed.endsWith("/v1") ? trimmed : `${trimmed}/v1`;
}

function imageApiUrl(pathname) {
  return `${configuredImageApiBaseUrl()}/${pathname.replace(/^\/+/, "")}`;
}

function imageRequestTimeoutMs() {
  return timeoutMsFromEnv("OPENAI_IMAGE_TIMEOUT_MS", 180000);
}

function publicConfig() {
  const mode = isDemoMode() ? "demo" : "live";
  const providerReady = hasOpenAIKey();
  return {
    mode,
    providerReady,
    imageModelConfigured: Boolean(process.env.OPENAI_IMAGE_MODEL),
    authEnabled: true,
    selfSignupAllowed: selfSignupAllowed(),
    debugUnlimitedAvailable: debugUnlimitedAvailable(),
    port,
    providerHealth: imageProviderHealth({ mode, providerReady }),
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
    resolution: settings.resolution || "native",
  };
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
  const response = await fetchWithTimeout(sourceUrl, {}, {
    timeoutMs: imageRequestTimeoutMs(),
    timeoutMessage: `参考图${reference.label || ""}下载超时。`,
  });
  if (!response.ok) {
    throw new Error(`参考图${reference.label || ""}下载失败 (${response.status})`);
  }
  const mime = response.headers.get("content-type") || "image/png";
  if (!mime.startsWith("image/")) {
    throw new Error(`参考图${reference.label || ""}不是图片资源`);
  }
  return assertValidReference({
    buffer: Buffer.from(await response.arrayBuffer()),
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
  const policy = {
    perReference: 4,
    highQualityMultiplier: 1.35,
    fourKMultiplier: 1.9,
    transparentBackgroundFee: 3,
  };
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

function updateGenerationTask({ id, status, credits, message }) {
  sqlite
    .prepare("UPDATE generation_task SET status = ?, credits = ?, message = ?, updated_at = ? WHERE id = ?")
    .run(status, credits, message, nowIso(), id);
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
     VALUES (?, ?, ?, ?, ?, ?, 'local-cache', ?, ?, ?, ?)`,
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
  const mime = mimeForFormat(outputFormat);
  const items = Array.isArray(data.data) ? data.data : [];
  if (items.length === 0) {
    throw new Error("图像引擎没有返回图片。");
  }
  return Promise.all(
    items.map(async (item, index) => {
      const persisted = await persistGeneratedImage(item, { fallbackMimeType: mime, targetSize, outputCompression });
      return {
        ...persisted,
        qualityGate: imageQualityGate(persisted.imageInspection),
        revisedPrompt: item.revised_prompt,
        index,
      };
    }),
  );
}

async function callOpenAIImages(payload, files, apiKey = process.env.OPENAI_API_KEY) {
  const model = process.env.OPENAI_IMAGE_MODEL || "gpt-image-2";
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

      const response = await fetchWithTimeout(imageApiUrl("/images/edits"), {
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

    const response = await fetchWithTimeout(imageApiUrl("/images/generations"), {
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

app.post("/api/generate", upload.array("images", 16), async (req, res) => {
  let taskId = "";
  let account = null;
  let cost = 0;
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
    const providerKey = resolveProviderApiKey(account.user.id);
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
      });
      res.status(402).json({
        ...publicConfig(),
        error: error instanceof Error ? error.message : "积分余额不足。",
      });
      return;
    }

    if (isDemoMode(providerKey.apiKey)) {
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
        message: hasOpenAIKey() ? "演示模式已开启，未调用图像引擎。" : "未配置 OPENAI_API_KEY，已使用演示模式。",
      });
      insertGeneratedResults({ userId: account.user.id, taskId, payload, results, cost });
      const profile = sqlite.prepare("SELECT * FROM user_profile WHERE user_id = ?").get(account.user.id);
      res.json({
        ...publicConfig(),
        results,
        taskId,
        credits: cost,
        account: serializeAccount(account.user, profile),
        message: hasOpenAIKey() ? "演示模式已开启，未调用图像引擎。" : "未配置 OPENAI_API_KEY，已使用演示模式。",
      });
      return;
    }

    const results = await callOpenAIImages(payload, files, providerKey.apiKey);
    const doneMessage = ownKey ? "图像引擎已返回结果（自备 Key，未扣积分）。" : "图像引擎已返回结果。";
    updateGenerationTask({
      id: taskId,
      status: "success",
      credits: cost,
      message: doneMessage,
    });
    insertGeneratedResults({ userId: account.user.id, taskId, payload, results, cost });
    const profile = sqlite.prepare("SELECT * FROM user_profile WHERE user_id = ?").get(account.user.id);
    res.json({
      ...publicConfig(),
      results,
      taskId,
      credits: cost,
      account: serializeAccount(account.user, profile),
      message: doneMessage,
    });
  } catch (error) {
    if (account && taskId && cost > 0) {
      try {
        refundCredits({
          userId: account.user.id,
          taskId,
          amount: cost,
          reason: "生成失败自动退款",
        });
        updateGenerationTask({
          id: taskId,
          status: "failed",
          credits: 0,
          message: error instanceof Error ? `${error.message}，积分已退回` : "生成失败，积分已退回",
        });
      } catch (refundError) {
        console.error(refundError);
      }
    }
    const status = !taskId && error instanceof Error && /^参考图/.test(error.message) ? 400 : 500;
    res.status(status).json({
      ...publicConfig(),
      error: error instanceof Error ? error.message : "Unknown generation error",
    });
  }
});

const generatedImages = generatedImageStaticMount();
app.use(generatedImages.publicPath, express.static(generatedImages.directory));
const generatedVideos = generatedVideoStaticMount();
app.use(generatedVideos.publicPath, express.static(generatedVideos.directory));

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

app.listen(port, host, () => {
  console.log(`ClothDesign AI running at http://${host}:${port}/ (${isDemoMode() ? "demo" : "live"} mode)`);
});
