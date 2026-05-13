import "dotenv/config";
import express from "express";
import multer from "multer";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer as createViteServer } from "vite";

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
app.use(express.json({ limit: "2mb" }));

function hasOpenAIKey() {
  return Boolean(process.env.OPENAI_API_KEY && process.env.OPENAI_API_KEY.trim().length > 0);
}

function isDemoMode() {
  return process.env.OPENAI_DEMO_MODE === "true" || !hasOpenAIKey();
}

function publicConfig() {
  return {
    mode: isDemoMode() ? "demo" : "live",
    providerReady: hasOpenAIKey(),
    imageModelConfigured: Boolean(process.env.OPENAI_IMAGE_MODEL),
    port,
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
    prompt: String(payload.prompt || "").slice(0, 32000),
    mode: payload.mode || "text",
    action: payload.action || "generate",
    ratioLabel: payload.ratioLabel || "1:1",
    size: payload.apiSize || "auto",
    quantity: Math.min(Math.max(Number(settings.quantity || 1), 1), 10),
    quality: settings.quality || "auto",
    background: settings.background || "auto",
    moderation: settings.moderation || "auto",
    outputFormat: format,
    outputCompression: Number(settings.compression || 100),
    inputFidelity: settings.inputFidelity === "high" ? "high" : "low",
  };
}

async function parseOpenAIResponse(response, outputFormat) {
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`OpenAI Images API failed: ${response.status} ${text.slice(0, 500)}`);
  }
  const data = await response.json();
  const mime = mimeForFormat(outputFormat);
  return (data.data || []).map((item, index) => ({
    imageUrl: item.b64_json ? `data:${mime};base64,${item.b64_json}` : item.url,
    revisedPrompt: item.revised_prompt,
    index,
  }));
}

async function callOpenAIImages(payload, files) {
  const model = process.env.OPENAI_IMAGE_MODEL || "gpt-image-2";
  const headers = {
    Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
  };

  if (files.length > 0 || payload.action !== "generate") {
    const form = new FormData();
    form.append("model", model);
    form.append("prompt", payload.prompt);
    form.append("n", String(payload.quantity));
    form.append("size", payload.size);
    form.append("quality", payload.quality);
    form.append("background", payload.background);
    form.append("moderation", payload.moderation);
    form.append("output_format", payload.outputFormat);
    form.append("input_fidelity", payload.inputFidelity);
    if (payload.outputFormat !== "png") {
      form.append("output_compression", String(payload.outputCompression));
    }
    for (const file of files) {
      const blob = new Blob([file.buffer], { type: file.mimetype || "image/png" });
      form.append("image[]", blob, file.originalname || "reference.png");
    }

    const response = await fetch("https://api.openai.com/v1/images/edits", {
      method: "POST",
      headers,
      body: form,
    });
    return parseOpenAIResponse(response, payload.outputFormat);
  }

  const body = {
    model,
    prompt: payload.prompt,
    n: payload.quantity,
    size: payload.size,
    quality: payload.quality,
    background: payload.background,
    moderation: payload.moderation,
    output_format: payload.outputFormat,
  };
  if (payload.outputFormat !== "png") {
    body.output_compression = payload.outputCompression;
  }

  const response = await fetch("https://api.openai.com/v1/images/generations", {
    method: "POST",
    headers: {
      ...headers,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  return parseOpenAIResponse(response, payload.outputFormat);
}

app.get("/api/config", (_req, res) => {
  res.json(publicConfig());
});

app.post("/api/generate", upload.array("images", 16), async (req, res) => {
  try {
    const payload = normalizePayload(req.body.payload);
    const files = Array.isArray(req.files) ? req.files : [];

    if (isDemoMode()) {
      const results = Array.from({ length: payload.quantity }, (_, index) => ({
        imageUrl: createDemoImage({
          mode: payload.mode,
          label: payload.mode,
          ratioLabel: payload.ratioLabel,
          index: index + 1,
        }),
        index,
      }));
      res.json({
        ...publicConfig(),
        results,
        message: hasOpenAIKey() ? "演示模式已开启，未调用 OpenAI。" : "未配置 OPENAI_API_KEY，已使用演示模式。",
      });
      return;
    }

    const results = await callOpenAIImages(payload, files);
    res.json({
      ...publicConfig(),
      results,
      message: "OpenAI Images API 已返回结果。",
    });
  } catch (error) {
    res.status(500).json({
      ...publicConfig(),
      error: error instanceof Error ? error.message : "Unknown generation error",
    });
  }
});

if (isProduction) {
  const distPath = path.join(root, "dist");
  app.use(express.static(distPath));
  app.get(/.*/, (_req, res) => {
    res.sendFile(path.join(distPath, "index.html"));
  });
} else {
  const vite = await createViteServer({
    root,
    server: { middlewareMode: true },
    appType: "spa",
  });
  app.use(vite.middlewares);
}

app.listen(port, host, () => {
  console.log(`ClothDesign AI running at http://${host}:${port}/ (${isDemoMode() ? "demo" : "live"} mode)`);
});
