import crypto from "node:crypto";
import { nowIso, sqlite } from "./db.mjs";
import {
  effectiveMaxResolution,
  imageProviderSettings,
  isValidProviderId,
  maxResolutionSource,
  normalizeProviderId,
  normalizeResolution,
  providerKeyEnv,
} from "./provider-config.mjs";

/**
 * 每个账号可以自备图像接口的 API Key。
 * 落库前用 AUTH_SECRET 派生的密钥做 AES-256-GCM 加密，只在真正调接口的一刻解开；
 * 接口只回传脱敏提示（前 3 位 + 后 4 位），永远不回传原文。
 */

const FALLBACK_SECRET = "dev-only-change-me-clothdesign-auth-secret-2026";
const MIN_KEY_LENGTH = 8;
const MAX_KEY_LENGTH = 400;

function derivedKey() {
  const secret = process.env.AUTH_SECRET || FALLBACK_SECRET;
  return crypto.createHash("sha256").update(`clothdesign-user-api-key:${secret}`).digest();
}

export function normalizeApiKey(raw) {
  const value = String(raw ?? "").trim();
  if (!value) return { error: "请填写 API Key。" };
  if (/\s/.test(value)) return { error: "API Key 里不能有空格或换行。" };
  if (value.length < MIN_KEY_LENGTH) return { error: "API Key 太短，像是复制漏了。" };
  if (value.length > MAX_KEY_LENGTH) return { error: "API Key 太长，请检查是否粘贴了多余内容。" };
  return { value };
}

export function apiKeyHint(plain) {
  const value = String(plain || "");
  if (value.length <= 8) return `${value.slice(0, 2)}…`;
  return `${value.slice(0, 3)}…${value.slice(-4)}`;
}

export function encryptApiKey(plain) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", derivedKey(), iv);
  const data = Buffer.concat([cipher.update(String(plain), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString("base64")}:${tag.toString("base64")}:${data.toString("base64")}`;
}

export function decryptApiKey(stored) {
  const parts = String(stored || "").split(":");
  if (parts.length !== 4 || parts[0] !== "v1") throw new Error("unsupported key format");
  const [, iv, tag, data] = parts;
  const decipher = crypto.createDecipheriv("aes-256-gcm", derivedKey(), Buffer.from(iv, "base64"));
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(data, "base64")), decipher.final()]).toString("utf8");
}

export function setUserApiKey(userId, plain, providerId) {
  const timestamp = nowIso();
  const selectedProviderId = providerId === undefined ? userApiProviderId(userId) : normalizeProviderId(providerId, "");
  if (!selectedProviderId) return { error: "图像供应商不存在。" };
  sqlite
    .prepare(
      "UPDATE user_profile SET api_key_encrypted = ?, api_key_hint = ?, api_key_updated_at = ?, api_provider_id = ?, updated_at = ? WHERE user_id = ?",
    )
    .run(encryptApiKey(plain), apiKeyHint(plain), timestamp, selectedProviderId, timestamp, userId);
  return { apiKeyHint: apiKeyHint(plain), apiKeyUpdatedAt: timestamp, apiProviderId: selectedProviderId };
}

export function setUserApiProvider(userId, providerId) {
  if (!isValidProviderId(providerId)) return { error: "图像供应商不存在。" };
  const timestamp = nowIso();
  sqlite.prepare("UPDATE user_profile SET api_provider_id = ?, updated_at = ? WHERE user_id = ?").run(providerId, timestamp, userId);
  return { apiProviderId: providerId };
}

export function userApiProviderId(userId) {
  if (!userId) return "default";
  const row = sqlite.prepare("SELECT api_provider_id FROM user_profile WHERE user_id = ?").get(userId);
  return normalizeProviderId(row?.api_provider_id);
}

/**
 * 这个账号最高能出到哪一档：线路能力和后台按账号设的上限取低的那个。
 * 前端拿它决定 1K/2K/4K 哪些能点，服务端出图前也按它兜底裁剪。
 */
export function userResolutionPolicy(userId) {
  const row = userId
    ? sqlite.prepare("SELECT api_provider_id, max_resolution FROM user_profile WHERE user_id = ?").get(userId)
    : null;
  return resolutionPolicyFor(row?.api_provider_id, row?.max_resolution);
}

/** 同上，但直接吃 user_profile 那一行，省掉重复查询。 */
export function resolutionPolicyFor(providerId, accountLimit) {
  const id = normalizeProviderId(providerId);
  return {
    maxResolution: effectiveMaxResolution(id, accountLimit),
    // 后台设的原值（空串 = 跟随线路），后台表格要拿它回显下拉框。
    maxResolutionSetting: normalizeResolution(accountLimit, ""),
    maxResolutionSource: maxResolutionSource(id, accountLimit),
  };
}

export function clearUserApiKey(userId) {
  const timestamp = nowIso();
  sqlite
    .prepare(
      "UPDATE user_profile SET api_key_encrypted = NULL, api_key_hint = NULL, api_key_updated_at = NULL, updated_at = ? WHERE user_id = ?",
    )
    .run(timestamp, userId);
}

/** 解出某个账号自备的 Key；没有、或密钥换过解不开时返回空串。 */
export function userApiKey(userId) {
  const row = sqlite.prepare("SELECT api_key_encrypted FROM user_profile WHERE user_id = ?").get(userId);
  if (!row?.api_key_encrypted) return "";
  try {
    return decryptApiKey(row.api_key_encrypted);
  } catch {
    return "";
  }
}

function sharedProviderKeyConfigKey(providerId) {
  return `imageProviderKey:${providerId}`;
}

function sharedProviderKeyOverride(providerId) {
  const id = normalizeProviderId(providerId);
  const row = sqlite.prepare("SELECT value_json FROM app_config WHERE key = ?").get(sharedProviderKeyConfigKey(id));
  if (!row?.value_json) return null;
  try {
    const parsed = JSON.parse(row.value_json);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function sharedProviderApiKey(providerId) {
  const override = sharedProviderKeyOverride(providerId);
  if (!override?.apiKeyEncrypted) return "";
  try {
    return decryptApiKey(override.apiKeyEncrypted);
  } catch {
    return "";
  }
}

/**
 * 后台给某条供应商线路配置的共享 Key。
 * 和用户自备 Key 使用同一套 AES-256-GCM 加密，只回传脱敏提示，绝不回传明文。
 */
export function setSharedProviderApiKey(providerId, plain) {
  const id = normalizeProviderId(providerId, "");
  if (!id) return { error: "图像供应商不存在。" };
  const normalized = normalizeApiKey(plain);
  if (normalized.error) return normalized;
  const timestamp = nowIso();
  const value = {
    apiKeyEncrypted: encryptApiKey(normalized.value),
    apiKeyHint: apiKeyHint(normalized.value),
    updatedAt: timestamp,
  };
  sqlite
    .prepare(
      `INSERT INTO app_config (key, value_json, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
    )
    .run(sharedProviderKeyConfigKey(id), JSON.stringify(value), timestamp);
  return sharedProviderApiKeyStatus(id);
}

/** 清掉后台覆盖值；如果 .env 里还有 Key，会自动回退到 .env。 */
export function clearSharedProviderApiKey(providerId) {
  const id = normalizeProviderId(providerId, "");
  if (!id) return { error: "图像供应商不存在。" };
  sqlite.prepare("DELETE FROM app_config WHERE key = ?").run(sharedProviderKeyConfigKey(id));
  return sharedProviderApiKeyStatus(id);
}

export function sharedProviderApiKeyStatus(providerId = "default") {
  const id = normalizeProviderId(providerId);
  const override = sharedProviderKeyOverride(id);
  const custom = sharedProviderApiKey(id);
  if (custom) {
    return {
      serverKeyConfigured: true,
      serverKeyHint: override?.apiKeyHint || apiKeyHint(custom),
      serverKeySource: "admin",
      serverKeyUpdatedAt: override?.updatedAt || null,
    };
  }
  const envKey = String(process.env[providerKeyEnv(id)] || "").trim();
  return {
    serverKeyConfigured: Boolean(envKey),
    serverKeyHint: envKey ? apiKeyHint(envKey) : null,
    serverKeySource: envKey ? "env" : "none",
    serverKeyUpdatedAt: null,
  };
}

export function serverApiKey(providerId = "default") {
  const id = normalizeProviderId(providerId);
  return sharedProviderApiKey(id) || String(process.env[providerKeyEnv(id)] || "").trim();
}

/**
 * 这次调用图像接口该用谁的 Key：账号自备的优先，其次是服务端 .env 里的。
 * source 供扣费逻辑判断——自备 Key 的请求不扣积分。
 */
export function resolveProviderApiKey(userId) {
  const row = userId
    ? sqlite.prepare("SELECT api_provider_id, max_resolution FROM user_profile WHERE user_id = ?").get(userId)
    : null;
  const providerId = normalizeProviderId(row?.api_provider_id);
  const provider = imageProviderSettings(providerId);
  const policy = resolutionPolicyFor(providerId, row?.max_resolution);
  const base = { providerId, provider, ...policy };
  const own = userId ? userApiKey(userId) : "";
  if (own) return { ...base, apiKey: own, source: "user" };
  const shared = serverApiKey(providerId);
  if (shared) return { ...base, apiKey: shared, source: "server" };
  return { ...base, apiKey: "", source: "" };
}
