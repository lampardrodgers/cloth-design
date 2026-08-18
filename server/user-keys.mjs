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

export function serverApiKey(providerId = "default") {
  return String(process.env[providerKeyEnv(providerId)] || "").trim();
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
