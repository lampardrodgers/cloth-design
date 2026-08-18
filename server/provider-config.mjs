import { nowIso, sqlite } from "./db.mjs";

/**
 * 多图像供应商配置。default 保留原 OPENAI_* / Packy 配置和旧数据库 key；
 * apimart 使用独立的 APIMART_* 环境变量。账号只保存 provider id，Key 与
 * URL Base 在服务端按同一个 id 配对，避免把 A 供应商的 Key 发给 B。
 */
const PROVIDER_DEFINITIONS = Object.freeze({
  default: {
    id: "default",
    name: "Packy / OpenAI 兼容接口",
    protocol: "openai",
    configKey: "imageProvider",
    baseUrlEnv: ["OPENAI_BASE_URL", "OPENAI_API_BASE_URL", "PACKY_API_BASE_URL"],
    modelEnv: "OPENAI_IMAGE_MODEL",
    keyEnv: "OPENAI_API_KEY",
    defaultBaseUrl: "https://api.openai.com",
    defaultModel: "gpt-image-2",
    // OpenAI 兼容协议没有 resolution 这个参数，出图就是 1024/1536 那一档，
    // 再给用户 2K / 4K 只会多扣积分却拿到同样的图。
    maxResolution: "native",
  },
  apimart: {
    id: "apimart",
    name: "APIMart",
    protocol: "apimart",
    configKey: "imageProvider:apimart",
    baseUrlEnv: ["APIMART_BASE_URL"],
    modelEnv: "APIMART_IMAGE_MODEL",
    keyEnv: "APIMART_API_KEY",
    defaultBaseUrl: "https://api.apimart.ai/v1",
    defaultModel: "gpt-image-2",
    // APIMart 的 /images/generations 接受 resolution=1k|2k|4k。
    maxResolution: "fourK",
  },
});

const caches = new Map();

/** 分辨率档位从低到高；1K = native、2K = hd、4K = fourK。 */
export const RESOLUTION_KEYS = Object.freeze(["native", "hd", "fourK"]);

export const RESOLUTION_LABELS = Object.freeze({ native: "1K", hd: "2K", fourK: "4K" });

export function normalizeResolution(raw, fallback = "native") {
  const value = String(raw ?? "").trim();
  return RESOLUTION_KEYS.includes(value) ? value : fallback;
}

/** 取「请求档位」和「上限」里低的那个。 */
export function clampResolution(value, cap) {
  const requested = RESOLUTION_KEYS.indexOf(normalizeResolution(value));
  const limit = RESOLUTION_KEYS.indexOf(normalizeResolution(cap));
  return RESOLUTION_KEYS[Math.min(requested, limit)];
}

export function providerMaxResolution(providerId = "default") {
  return definitionFor(providerId).maxResolution;
}

/**
 * 这个账号实际能开到多高：先看线路本身给不给，再看管理员有没有按账号往下压。
 * 账号上限只能压低、压不高——线路出不来的档位，后台点了也没用。
 */
export function effectiveMaxResolution(providerId, accountLimit) {
  const providerCap = providerMaxResolution(providerId);
  const raw = String(accountLimit ?? "").trim();
  if (!raw) return providerCap;
  return clampResolution(raw, providerCap);
}

/** 上限是线路给的还是后台按账号压的——UI 要照实说清楚是哪一种。 */
export function maxResolutionSource(providerId, accountLimit) {
  const providerCap = providerMaxResolution(providerId);
  const raw = normalizeResolution(accountLimit, "");
  if (!raw) return "provider";
  return RESOLUTION_KEYS.indexOf(raw) < RESOLUTION_KEYS.indexOf(providerCap) ? "account" : "provider";
}

export function normalizeProviderId(raw, fallback = "default") {
  const value = String(raw || "").trim();
  return Object.hasOwn(PROVIDER_DEFINITIONS, value) ? value : fallback;
}

export function isValidProviderId(raw) {
  return Object.hasOwn(PROVIDER_DEFINITIONS, String(raw || "").trim());
}

export function normalizeBaseUrl(raw) {
  const value = String(raw ?? "").trim();
  if (!value) return { error: "请填写接口地址。" };
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return { error: "接口地址不是合法的 URL，要带 http:// 或 https://。" };
  }
  if (!["http:", "https:"].includes(parsed.protocol)) return { error: "接口地址只支持 http 或 https。" };
  if (!parsed.hostname) return { error: "接口地址缺少域名。" };
  const trimmed = `${parsed.origin}${parsed.pathname}`.replace(/\/+$/, "");
  return { value: trimmed.endsWith("/v1") ? trimmed : `${trimmed}/v1` };
}

export function normalizeModel(raw) {
  const value = String(raw ?? "").trim();
  if (!value) return { error: "请填写模型名。" };
  if (value.length > 120) return { error: "模型名太长。" };
  if (/\s/.test(value)) return { error: "模型名里不能有空格。" };
  return { value };
}

function definitionFor(providerId = "default") {
  return PROVIDER_DEFINITIONS[normalizeProviderId(providerId)];
}

export function envImageProvider(providerId = "default") {
  const definition = definitionFor(providerId);
  const rawBaseUrl = definition.baseUrlEnv.map((name) => process.env[name]).find((value) => String(value || "").trim());
  const normalized = normalizeBaseUrl(rawBaseUrl || definition.defaultBaseUrl);
  return {
    baseUrl: normalized.value || normalizeBaseUrl(definition.defaultBaseUrl).value,
    model: String(process.env[definition.modelEnv] || "").trim() || definition.defaultModel,
  };
}

function readOverride(providerId = "default") {
  const definition = definitionFor(providerId);
  const row = sqlite.prepare("SELECT value_json FROM app_config WHERE key = ?").get(definition.configKey);
  if (!row) return {};
  try {
    const parsed = JSON.parse(row.value_json);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

/** 当前某个供应商实际生效的安全配置（永不包含 Key）。 */
export function imageProviderSettings(providerId = "default") {
  const id = normalizeProviderId(providerId);
  if (caches.has(id)) return caches.get(id);
  const definition = definitionFor(id);
  const fallback = envImageProvider(id);
  const override = readOverride(id);
  const settings = {
    id,
    name: definition.name,
    protocol: definition.protocol,
    maxResolution: definition.maxResolution,
    baseUrl: override.baseUrl || fallback.baseUrl,
    model: override.model || fallback.model,
    baseUrlSource: override.baseUrl ? "custom" : "env",
    modelSource: override.model ? "custom" : "env",
    defaults: fallback,
    updatedAt: override.updatedAt || null,
  };
  caches.set(id, settings);
  return settings;
}

export function imageProviderSettingsList() {
  return Object.keys(PROVIDER_DEFINITIONS).map((id) => imageProviderSettings(id));
}

export function imageApiBaseUrl(providerId = "default") {
  return imageProviderSettings(providerId).baseUrl;
}

export function imageApiModel(providerId = "default") {
  return imageProviderSettings(providerId).model;
}

export function imageApiUrl(pathname, providerId = "default") {
  return `${imageApiBaseUrl(providerId)}/${String(pathname).replace(/^\/+/, "")}`;
}

export function providerKeyEnv(providerId = "default") {
  return definitionFor(providerId).keyEnv;
}

/** 传空字符串表示这一项恢复成该供应商对应的 .env 默认值。 */
export function saveImageProviderSettings({ providerId = "default", baseUrl, model }) {
  const id = normalizeProviderId(providerId, "");
  if (!id) return { error: "图像供应商不存在。" };
  const definition = definitionFor(id);
  const override = readOverride(id);
  const fallback = envImageProvider(id);
  const next = { ...override };

  if (baseUrl !== undefined) {
    const raw = String(baseUrl ?? "").trim();
    if (!raw) delete next.baseUrl;
    else {
      const normalized = normalizeBaseUrl(raw);
      if (normalized.error) return { error: normalized.error };
      if (normalized.value === fallback.baseUrl) delete next.baseUrl;
      else next.baseUrl = normalized.value;
    }
  }
  if (model !== undefined) {
    const raw = String(model ?? "").trim();
    if (!raw) delete next.model;
    else {
      const normalized = normalizeModel(raw);
      if (normalized.error) return { error: normalized.error };
      if (normalized.value === fallback.model) delete next.model;
      else next.model = normalized.value;
    }
  }

  const timestamp = nowIso();
  if (!next.baseUrl && !next.model) {
    sqlite.prepare("DELETE FROM app_config WHERE key = ?").run(definition.configKey);
  } else {
    next.updatedAt = timestamp;
    sqlite
      .prepare(
        `INSERT INTO app_config (key, value_json, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
      )
      .run(definition.configKey, JSON.stringify(next), timestamp);
  }
  caches.delete(id);
  return { settings: imageProviderSettings(id) };
}

export function resetImageProviderSettings(providerId = "default") {
  const id = normalizeProviderId(providerId, "");
  if (!id) return null;
  sqlite.prepare("DELETE FROM app_config WHERE key = ?").run(definitionFor(id).configKey);
  caches.delete(id);
  return imageProviderSettings(id);
}

export function invalidateImageProviderCache(providerId) {
  if (providerId === undefined) caches.clear();
  else caches.delete(normalizeProviderId(providerId));
}
