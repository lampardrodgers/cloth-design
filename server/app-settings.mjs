/**
 * 后台可改、对所有人生效的站点设置：积分规则、系统提示词模板。
 *
 * 以前这两块只存在管理员自己浏览器的 localStorage 里——改了倍率只有他自己的报价变，
 * 服务端照旧按写死的数字扣费；改了提示词模板也只有他自己那台机器拼进去。
 * 现在统一落 app_config，/api/me 下发给每个客户端，服务端计费用的也是同一份。
 */
import { nowIso, sqlite } from "./db.mjs";

const CREDIT_POLICY_KEY = "credit_policy";
const SYSTEM_PROMPTS_KEY = "system_prompts";

/** 和 src/data/catalog.ts 里的 creditPolicy 保持一致；服务端计费的兜底值。 */
export const DEFAULT_CREDIT_POLICY = Object.freeze({
  perReference: 4,
  highQualityMultiplier: 1.35,
  fourKMultiplier: 1.9,
  transparentBackgroundFee: 3,
  failureRefundRate: 1,
});

const CREDIT_POLICY_RULES = {
  perReference: { min: 0, max: 1000, integer: true },
  highQualityMultiplier: { min: 1, max: 10 },
  fourKMultiplier: { min: 1, max: 10 },
  transparentBackgroundFee: { min: 0, max: 1000, integer: true },
  failureRefundRate: { min: 0, max: 1 },
};

/** 和 src/data/catalog.ts 里 generationModes 的 id 一致；模板只认这些键。 */
export const SYSTEM_PROMPT_MODES = Object.freeze(["text", "free", "tryon", "fusion", "campaign", "product", "fabric", "lookbook"]);
const SYSTEM_PROMPT_MAX_LENGTH = 4000;

function readConfig(key) {
  const row = sqlite.prepare("SELECT value_json FROM app_config WHERE key = ?").get(key);
  if (!row) return null;
  try {
    const parsed = JSON.parse(row.value_json);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function writeConfig(key, value) {
  const timestamp = nowIso();
  sqlite
    .prepare(
      `INSERT INTO app_config (key, value_json, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
    )
    .run(key, JSON.stringify(value), timestamp);
  return timestamp;
}

export function normalizeCreditPolicy(input = {}, base = DEFAULT_CREDIT_POLICY) {
  const next = { ...base };
  for (const [field, rule] of Object.entries(CREDIT_POLICY_RULES)) {
    if (input[field] === undefined || input[field] === null || input[field] === "") continue;
    const value = Number(input[field]);
    if (!Number.isFinite(value)) return { error: `积分规则「${field}」不是数字。` };
    if (value < rule.min || value > rule.max) return { error: `积分规则「${field}」要在 ${rule.min} 到 ${rule.max} 之间。` };
    next[field] = rule.integer ? Math.round(value) : Math.round(value * 1000) / 1000;
  }
  return { value: next };
}

/** 当前生效的积分规则（后台改过的覆盖默认值）。 */
export function creditPolicySettings() {
  const stored = readConfig(CREDIT_POLICY_KEY);
  if (!stored) return { ...DEFAULT_CREDIT_POLICY };
  const normalized = normalizeCreditPolicy(stored);
  return normalized.value || { ...DEFAULT_CREDIT_POLICY };
}

export function saveCreditPolicy(patch) {
  const normalized = normalizeCreditPolicy(patch, creditPolicySettings());
  if (normalized.error) return normalized;
  writeConfig(CREDIT_POLICY_KEY, normalized.value);
  return { value: creditPolicySettings() };
}

/** 后台改过的系统提示词模板（按模式 id）；没改过的模式不在结果里，客户端用内置默认。 */
export function systemPromptOverrides() {
  const stored = readConfig(SYSTEM_PROMPTS_KEY);
  if (!stored) return {};
  const result = {};
  for (const mode of SYSTEM_PROMPT_MODES) {
    if (typeof stored[mode] === "string") result[mode] = stored[mode].slice(0, SYSTEM_PROMPT_MAX_LENGTH);
  }
  return result;
}

/**
 * 保存模板。值为 null / undefined 表示「恢复内置默认」，这一项会从覆盖表里删掉。
 */
export function saveSystemPrompts(patch = {}) {
  const next = { ...systemPromptOverrides() };
  for (const [mode, value] of Object.entries(patch)) {
    if (!SYSTEM_PROMPT_MODES.includes(mode)) return { error: `不认识的模式「${mode}」。` };
    if (value === null || value === undefined) {
      delete next[mode];
      continue;
    }
    if (typeof value !== "string") return { error: `模式「${mode}」的模板必须是文本。` };
    if (value.length > SYSTEM_PROMPT_MAX_LENGTH) return { error: `模式「${mode}」的模板太长（最多 ${SYSTEM_PROMPT_MAX_LENGTH} 字）。` };
    next[mode] = value;
  }
  writeConfig(SYSTEM_PROMPTS_KEY, next);
  return { value: next };
}

/* ── 账号偏好（跨设备同步的那一小份本地状态） ───────────────────────────── */

/** 每个账号最多存这么大的偏好 JSON；提示词库 + 草稿 + 设置远用不到。 */
export const PREFERENCES_MAX_BYTES = 256 * 1024;
const PREFERENCE_KEY_PATTERN = /^clothdesign:[\w:.-]{1,80}$/;

export function readUserPreferences(userId) {
  const row = sqlite.prepare("SELECT preferences_json FROM user_profile WHERE user_id = ?").get(userId);
  if (!row?.preferences_json) return {};
  try {
    const parsed = JSON.parse(row.preferences_json);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * 合并写入：patch 里为 null 的键表示删除。整份 JSON 超上限就拒绝，别让一个账号把表撑爆。
 */
export function mergeUserPreferences(userId, patch) {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) return { error: "偏好格式不对。" };
  const next = { ...readUserPreferences(userId) };
  for (const [key, value] of Object.entries(patch)) {
    if (!PREFERENCE_KEY_PATTERN.test(key)) return { error: `偏好键「${key}」不合法。` };
    if (value === null || value === undefined) delete next[key];
    else next[key] = value;
  }
  const serialized = JSON.stringify(next);
  if (Buffer.byteLength(serialized, "utf8") > PREFERENCES_MAX_BYTES) {
    return { error: `偏好数据超过 ${Math.round(PREFERENCES_MAX_BYTES / 1024)}KB 上限。` };
  }
  sqlite.prepare("UPDATE user_profile SET preferences_json = ?, updated_at = ? WHERE user_id = ?").run(serialized, nowIso(), userId);
  return { value: next };
}
