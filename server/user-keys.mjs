import crypto from "node:crypto";
import { nowIso, sqlite } from "./db.mjs";

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

export function setUserApiKey(userId, plain) {
  const timestamp = nowIso();
  sqlite
    .prepare(
      "UPDATE user_profile SET api_key_encrypted = ?, api_key_hint = ?, api_key_updated_at = ?, updated_at = ? WHERE user_id = ?",
    )
    .run(encryptApiKey(plain), apiKeyHint(plain), timestamp, timestamp, userId);
  return { apiKeyHint: apiKeyHint(plain), apiKeyUpdatedAt: timestamp };
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

export function serverApiKey() {
  return String(process.env.OPENAI_API_KEY || "").trim();
}

/**
 * 这次调用图像接口该用谁的 Key：账号自备的优先，其次是服务端 .env 里的。
 * source 供扣费逻辑判断——自备 Key 的请求不扣积分。
 */
export function resolveProviderApiKey(userId) {
  const own = userId ? userApiKey(userId) : "";
  if (own) return { apiKey: own, source: "user" };
  const shared = serverApiKey();
  if (shared) return { apiKey: shared, source: "server" };
  return { apiKey: "", source: "" };
}
