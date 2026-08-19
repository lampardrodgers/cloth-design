import { nowIso, sqlite } from "./db.mjs";
import { imageProviderSettingsList, normalizeProviderId } from "./provider-config.mjs";
import { decryptApiKey, encryptApiKey, apiKeyHint, normalizeApiKey } from "./user-keys.mjs";

/**
 * 短视频模块自己的可改配置（存 app_config，和图像接口那套一个路子）：
 * 后台改完立刻生效，不用 ssh 改 .env 再重启。
 *
 * 优先级：后台改过的值 → .env → 内置默认。
 * 写文案用的 Key 落库前加密（和账号自备 Key 同一套 AES-256-GCM），只回传脱敏提示。
 */

const CONFIG_KEY = "shortvideo";
const DEFAULT_MODEL = "gpt-4o-mini";

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

export function invalidateShortVideoSettingsCache() {
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
  invalidateShortVideoSettingsCache();
}

function envInt(name, fallback, { min = 1, max = 20 } = {}) {
  const value = Number(process.env[name]);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(Math.max(Math.round(value), min), max);
}

/** 当前实际生效的短视频设置（含解密后的 Key，只在服务端内部用）。 */
export function shortVideoSettings() {
  const override = readOverride();
  const envProvider = normalizeProviderId(process.env.SHORTVIDEO_LLM_PROVIDER, "default");
  const llmProviderId = override.llmProviderId ? normalizeProviderId(override.llmProviderId, envProvider) : envProvider;
  let llmApiKey = String(process.env.SHORTVIDEO_LLM_API_KEY || "").trim();
  if (override.llmApiKeyEncrypted) {
    try {
      llmApiKey = decryptApiKey(override.llmApiKeyEncrypted);
    } catch {
      llmApiKey = "";
    }
  }
  return {
    llmProviderId,
    llmBaseUrl: String(override.llmBaseUrl ?? process.env.SHORTVIDEO_LLM_BASE_URL ?? "").trim(),
    llmApiKey,
    llmApiKeyHint: override.llmApiKeyHint || "",
    llmApiKeySource: override.llmApiKeyEncrypted ? "admin" : process.env.SHORTVIDEO_LLM_API_KEY ? "env" : "provider",
    llmModel: String(override.llmModel ?? process.env.SHORTVIDEO_LLM_MODEL ?? "").trim() || DEFAULT_MODEL,
    maxActivePerUser: Number(override.maxActivePerUser) || envInt("SHORTVIDEO_MAX_ACTIVE_PER_USER", 2, { min: 1, max: 10 }),
    // 交给引擎的 FFmpeg 线程数。2 核的机器给 2；机器好就调大，渲染会快不少。
    renderThreads: Number(override.renderThreads) || envInt("SHORTVIDEO_RENDER_THREADS", 2, { min: 1, max: 16 }),
    sources: {
      llmProviderId: override.llmProviderId ? "admin" : "env",
      llmBaseUrl: override.llmBaseUrl !== undefined ? "admin" : "env",
      llmModel: override.llmModel !== undefined ? "admin" : "env",
      maxActivePerUser: override.maxActivePerUser !== undefined ? "admin" : "env",
      renderThreads: override.renderThreads !== undefined ? "admin" : "env",
    },
    updatedAt: override.updatedAt || null,
  };
}

/** 给后台看的：不含任何明文 Key。 */
export function shortVideoSettingsView() {
  const settings = shortVideoSettings();
  return {
    llmProviderId: settings.llmProviderId,
    llmBaseUrl: settings.llmBaseUrl,
    llmModel: settings.llmModel,
    llmApiKeyConfigured: Boolean(settings.llmApiKey),
    llmApiKeyHint: settings.llmApiKeyHint,
    llmApiKeySource: settings.llmApiKeySource,
    maxActivePerUser: settings.maxActivePerUser,
    renderThreads: settings.renderThreads,
    providers: imageProviderSettingsList().map(({ id, name }) => ({ id, name })),
    sources: settings.sources,
    updatedAt: settings.updatedAt,
  };
}

/**
 * 保存后台改动。约定和图像接口一致：某一项传空串 = 恢复成 .env / 默认值。
 * llmApiKey 传空串就是清掉后台配的那把，退回 .env 或线路共享 Key。
 */
export function saveShortVideoSettings(input = {}) {
  const next = { ...readOverride() };
  delete next.updatedAt;

  if (input.llmProviderId !== undefined) {
    const raw = String(input.llmProviderId || "").trim();
    if (!raw) delete next.llmProviderId;
    else {
      const normalized = normalizeProviderId(raw, "");
      if (!normalized) return { error: "文案线路不存在。" };
      next.llmProviderId = normalized;
    }
  }
  if (input.llmBaseUrl !== undefined) {
    const raw = String(input.llmBaseUrl || "").trim();
    if (!raw) delete next.llmBaseUrl;
    else {
      let parsed;
      try {
        parsed = new URL(raw);
      } catch {
        return { error: "文案接口地址不是合法的 URL，要带 http:// 或 https://。" };
      }
      if (!["http:", "https:"].includes(parsed.protocol)) return { error: "文案接口地址只支持 http 或 https。" };
      next.llmBaseUrl = `${parsed.origin}${parsed.pathname}`.replace(/\/+$/, "");
    }
  }
  if (input.llmModel !== undefined) {
    const raw = String(input.llmModel || "").trim();
    if (!raw) delete next.llmModel;
    else if (raw.length > 120 || /\s/.test(raw)) return { error: "模型名不合法。" };
    else next.llmModel = raw;
  }
  if (input.llmApiKey !== undefined) {
    const raw = String(input.llmApiKey || "").trim();
    if (!raw) {
      delete next.llmApiKeyEncrypted;
      delete next.llmApiKeyHint;
    } else {
      const normalized = normalizeApiKey(raw);
      if (normalized.error) return { error: normalized.error };
      next.llmApiKeyEncrypted = encryptApiKey(normalized.value);
      next.llmApiKeyHint = apiKeyHint(normalized.value);
    }
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

  if (input.renderThreads !== undefined) {
    const raw = String(input.renderThreads ?? "").trim();
    if (!raw) delete next.renderThreads;
    else {
      const value = Number(raw);
      if (!Number.isFinite(value) || value < 1 || value > 16) return { error: "渲染线程要在 1–16 之间。" };
      next.renderThreads = Math.round(value);
    }
  }

  writeOverride(next);
  return { settings: shortVideoSettingsView() };
}
