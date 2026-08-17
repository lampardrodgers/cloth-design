import { nowIso, sqlite } from "./db.mjs";

/**
 * 图像接口的地址和模型名。
 * `.env` 里的值是默认值；管理员在后台改过之后覆盖值落在 app_config 里，
 * 改完立刻生效，不用重启服务。清空即回到 .env 的默认值。
 */

const CONFIG_KEY = "imageProvider";
const DEFAULT_BASE_URL = "https://api.openai.com";
const DEFAULT_MODEL = "gpt-image-2";

// 每个请求都要用，做一层内存缓存；写入时主动失效。
let cache = null;

export function normalizeBaseUrl(raw) {
  const value = String(raw ?? "").trim();
  if (!value) return { error: "请填写接口地址。" };
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return { error: "接口地址不是合法的 URL，要带 http:// 或 https://。" };
  }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    return { error: "接口地址只支持 http 或 https。" };
  }
  if (!parsed.hostname) return { error: "接口地址缺少域名。" };
  // 统一收敛成 .../v1，和原来 .env 的处理保持一致：填根地址或 /v1 都行
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

/** .env 里的默认值（后台「恢复默认」就是回到这里）。 */
export function envImageProvider() {
  const raw =
    process.env.OPENAI_BASE_URL || process.env.OPENAI_API_BASE_URL || process.env.PACKY_API_BASE_URL || DEFAULT_BASE_URL;
  const normalized = normalizeBaseUrl(raw);
  return {
    baseUrl: normalized.value || `${DEFAULT_BASE_URL}/v1`,
    model: (process.env.OPENAI_IMAGE_MODEL || "").trim() || DEFAULT_MODEL,
  };
}

function readOverride() {
  const row = sqlite.prepare("SELECT value_json FROM app_config WHERE key = ?").get(CONFIG_KEY);
  if (!row) return {};
  try {
    const parsed = JSON.parse(row.value_json);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

/** 当前实际生效的地址和模型，以及每一项是来自 .env 还是后台改过的。 */
export function imageProviderSettings() {
  if (cache) return cache;
  const fallback = envImageProvider();
  const override = readOverride();
  cache = {
    baseUrl: override.baseUrl || fallback.baseUrl,
    model: override.model || fallback.model,
    baseUrlSource: override.baseUrl ? "custom" : "env",
    modelSource: override.model ? "custom" : "env",
    defaults: fallback,
    updatedAt: override.updatedAt || null,
  };
  return cache;
}

export function imageApiBaseUrl() {
  return imageProviderSettings().baseUrl;
}

export function imageApiModel() {
  return imageProviderSettings().model;
}

/** 拼出具体端点，例如 /images/generations。 */
export function imageApiUrl(pathname) {
  return `${imageApiBaseUrl()}/${String(pathname).replace(/^\/+/, "")}`;
}

/** 传空字符串表示这一项恢复成 .env 的默认值。 */
export function saveImageProviderSettings({ baseUrl, model }) {
  const override = readOverride();
  const fallback = envImageProvider();
  const next = { ...override };

  if (baseUrl !== undefined) {
    const raw = String(baseUrl ?? "").trim();
    if (!raw) delete next.baseUrl;
    else {
      const normalized = normalizeBaseUrl(raw);
      if (normalized.error) return { error: normalized.error };
      // 和 .env 里一样就不记成覆盖，否则「来自 .env / 后台已改」的标签会说谎
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
    sqlite.prepare("DELETE FROM app_config WHERE key = ?").run(CONFIG_KEY);
  } else {
    next.updatedAt = timestamp;
    sqlite
      .prepare(
        `INSERT INTO app_config (key, value_json, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
      )
      .run(CONFIG_KEY, JSON.stringify(next), timestamp);
  }
  cache = null;
  return { settings: imageProviderSettings() };
}

export function resetImageProviderSettings() {
  sqlite.prepare("DELETE FROM app_config WHERE key = ?").run(CONFIG_KEY);
  cache = null;
  return imageProviderSettings();
}

/** 测试用：让单元测试能清掉内存缓存。 */
export function invalidateImageProviderCache() {
  cache = null;
}
