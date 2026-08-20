import { nowIso, sqlite } from "./db.mjs";
import { decryptApiKey, encryptApiKey, apiKeyHint, normalizeApiKey } from "./user-keys.mjs";

/**
 * Seedance（火山方舟视频生成）模块的可改配置，存 app_config，和短视频 / 图像接口一个路子：
 * 后台改完立刻生效，不用 ssh 改 .env 再重启。
 *
 * 优先级：后台改过的值 → .env → 内置默认。
 * API Key 落库前加密（和账号自备 Key 同一套 AES-256-GCM），只回传脱敏提示。
 *
 * 火山方舟的鉴权是 `Authorization: Bearer <API Key>`；控制台「API Key 管理」里给的那串
 * 「API Key Secret」就是这里要填的 Key（「API Key ID」不用填）。
 */

const CONFIG_KEY = "seedance";
export const SEEDANCE_DEFAULT_BASE_URL = "https://ark.cn-beijing.volces.com/api/v3";
export const SEEDANCE_DEFAULT_MODEL = "doubao-seedance-2-5-260628";

let cache = null;

function readOverride() {
  if (cache) return cache;
  const row = sqlite.prepare("SELECT value_json FROM app_config WHERE key = ?").get(CONFIG_KEY);
  let parsed = {};
  if (row) {
    try {
      const value = JSON.parse(row.value_json);
      if (value && typeof value === "object") parsed = value;
    } catch {
      parsed = {};
    }
  }
  cache = parsed;
  return parsed;
}

export function invalidateSeedanceSettingsCache() {
  cache = null;
}

function writeOverride(next) {
  const timestamp = nowIso();
  const payload = { ...next, updatedAt: timestamp };
  const empty = Object.keys(next).length === 0;
  if (empty) sqlite.prepare("DELETE FROM app_config WHERE key = ?").run(CONFIG_KEY);
  else {
    sqlite
      .prepare(
        `INSERT INTO app_config (key, value_json, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
      )
      .run(CONFIG_KEY, JSON.stringify(payload), timestamp);
  }
  invalidateSeedanceSettingsCache();
}

function envInt(name, fallback, { min = 1, max = 20 } = {}) {
  const value = Number(process.env[name]);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(Math.max(Math.round(value), min), max);
}

function normalizeBaseUrl(raw) {
  const value = String(raw || "").trim();
  if (!value) return "";
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  if (!["http:", "https:"].includes(parsed.protocol)) return null;
  return `${parsed.origin}${parsed.pathname}`.replace(/\/+$/, "");
}

/** 当前实际生效的 Seedance 设置（含解密后的 Key，只在服务端内部用）。 */
export function seedanceSettings() {
  const override = readOverride();
  let apiKey = String(process.env.SEEDANCE_API_KEY || "").trim();
  if (override.apiKeyEncrypted) {
    try {
      apiKey = decryptApiKey(override.apiKeyEncrypted);
    } catch {
      apiKey = "";
    }
  }
  const envPublic = String(process.env.SEEDANCE_PUBLIC_BASE_URL || process.env.PUBLIC_APP_URL || "").trim();
  return {
    apiKey,
    apiKeyHint: override.apiKeyHint || "",
    apiKeySource: override.apiKeyEncrypted ? "admin" : process.env.SEEDANCE_API_KEY ? "env" : "none",
    baseUrl: normalizeBaseUrl(override.baseUrl ?? process.env.SEEDANCE_BASE_URL) || SEEDANCE_DEFAULT_BASE_URL,
    defaultModel: String(override.defaultModel ?? process.env.SEEDANCE_DEFAULT_MODEL ?? "").trim() || SEEDANCE_DEFAULT_MODEL,
    maxActivePerUser: Number(override.maxActivePerUser) || envInt("SEEDANCE_MAX_ACTIVE_PER_USER", 2, { min: 1, max: 10 }),
    // 参考视频 / 音频只能以公网 URL 交给方舟，这个地址就是方舟回来取文件时用的本站根地址。
    publicBaseUrl: normalizeBaseUrl(override.publicBaseUrl ?? envPublic) || "",
    // 后台可以把贵的 / 退役的模型从用户可选里摘掉；空数组 = 全部可选。
    enabledModels: Array.isArray(override.enabledModels) ? override.enabledModels.map(String) : [],
    sources: {
      baseUrl: override.baseUrl !== undefined ? "admin" : "env",
      defaultModel: override.defaultModel !== undefined ? "admin" : "env",
      maxActivePerUser: override.maxActivePerUser !== undefined ? "admin" : "env",
      publicBaseUrl: override.publicBaseUrl !== undefined ? "admin" : "env",
      enabledModels: override.enabledModels !== undefined ? "admin" : "env",
    },
    updatedAt: override.updatedAt || null,
  };
}

/** 给后台看的：不含任何明文 Key。 */
export function seedanceSettingsView() {
  const settings = seedanceSettings();
  return {
    apiKeyConfigured: Boolean(settings.apiKey),
    apiKeyHint: settings.apiKeyHint,
    apiKeySource: settings.apiKeySource,
    baseUrl: settings.baseUrl,
    defaultModel: settings.defaultModel,
    maxActivePerUser: settings.maxActivePerUser,
    publicBaseUrl: settings.publicBaseUrl,
    enabledModels: settings.enabledModels,
    sources: settings.sources,
    updatedAt: settings.updatedAt,
  };
}

/**
 * 保存后台改动。约定和图像接口一致：某一项传空串 = 恢复成 .env / 默认值。
 * apiKey 传空串就是清掉后台配的那把，退回 .env。
 * `knownModels` 由调用方传进来（模型目录在 seedance.mjs），这里只管校验 enabledModels 别写进不认识的 ID。
 */
export function saveSeedanceSettings(input = {}, { knownModels = [] } = {}) {
  const next = { ...readOverride() };
  delete next.updatedAt;

  if (input.apiKey !== undefined) {
    const raw = String(input.apiKey || "").trim();
    if (!raw) {
      delete next.apiKeyEncrypted;
      delete next.apiKeyHint;
    } else {
      const normalized = normalizeApiKey(raw);
      if (normalized.error) return { error: normalized.error };
      next.apiKeyEncrypted = encryptApiKey(normalized.value);
      next.apiKeyHint = apiKeyHint(normalized.value);
    }
  }
  if (input.baseUrl !== undefined) {
    const raw = String(input.baseUrl || "").trim();
    if (!raw) delete next.baseUrl;
    else {
      const normalized = normalizeBaseUrl(raw);
      if (!normalized) return { error: "接口地址不是合法的 URL，要带 http:// 或 https://。" };
      next.baseUrl = normalized;
    }
  }
  if (input.defaultModel !== undefined) {
    const raw = String(input.defaultModel || "").trim();
    if (!raw) delete next.defaultModel;
    else if (knownModels.length && !knownModels.includes(raw)) return { error: "默认模型不在目录里。" };
    else next.defaultModel = raw;
  }
  if (input.maxActivePerUser !== undefined) {
    const raw = String(input.maxActivePerUser ?? "").trim();
    if (!raw) delete next.maxActivePerUser;
    else {
      const value = Number(raw);
      if (!Number.isFinite(value) || value < 1 || value > 10) return { error: "每人同时在跑的条数要在 1–10 之间。" };
      next.maxActivePerUser = Math.round(value);
    }
  }
  if (input.publicBaseUrl !== undefined) {
    const raw = String(input.publicBaseUrl || "").trim();
    if (!raw) delete next.publicBaseUrl;
    else {
      const normalized = normalizeBaseUrl(raw);
      if (!normalized) return { error: "公网地址不是合法的 URL，要带 http:// 或 https://。" };
      next.publicBaseUrl = normalized;
    }
  }
  if (input.enabledModels !== undefined) {
    if (input.enabledModels === "" || input.enabledModels === null) delete next.enabledModels;
    else {
      if (!Array.isArray(input.enabledModels)) return { error: "可用模型要是一个列表。" };
      const list = [...new Set(input.enabledModels.map((item) => String(item || "").trim()).filter(Boolean))];
      const unknown = knownModels.length ? list.filter((id) => !knownModels.includes(id)) : [];
      if (unknown.length) return { error: `不认识的模型：${unknown.join("、")}` };
      if (list.length === 0) return { error: "至少留一个可用模型。" };
      next.enabledModels = list;
    }
  }

  writeOverride(next);
  return { settings: seedanceSettingsView() };
}
