import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "clothdesign-user-keys-"));
process.env.DATABASE_URL = `file:${path.join(tmpDir, "test.db")}`;
process.env.AUTH_SECRET = "test-auth-secret-for-user-keys-1234567890";
delete process.env.OPENAI_API_KEY;

const { migrateBusinessDatabase, sqlite, nowIso } = await import("../server/db.mjs");
migrateBusinessDatabase();
const keys = await import("../server/user-keys.mjs");
const { signupApprovalRequired, ensureUserProfile } = await import("../server/auth.mjs");
const { ensureDebugUserProfile, newDebugSeat, debugUserIdFromSeat } = await import("../server/debug.mjs");

/* ── 迁移：老库升级后老账号视为已开通，任务表带 key_source ───────────────── */
const profileColumns = sqlite.prepare("PRAGMA table_info(user_profile)").all().map((row) => row.name);
for (const column of ["approved", "api_key_encrypted", "api_key_hint", "api_key_updated_at"]) {
  assert(profileColumns.includes(column), `user_profile should have ${column}`);
}
assert(sqlite.prepare("PRAGMA table_info(generation_task)").all().some((row) => row.name === "key_source"));

/* ── 调试座位不能顶掉第一个真实账号的 owner 身份 ─────────────────────────── */
// 内部部署时往往先有人点「开发调试」，再有人正式注册；座位也是 user_profile，
// 如果算进「已有账号数」，第一个注册的人就当不上 owner 了。
ensureDebugUserProfile(debugUserIdFromSeat(newDebugSeat()));
ensureDebugUserProfile(debugUserIdFromSeat(newDebugSeat()));
delete process.env.ADMIN_EMAILS;
const firstReal = ensureUserProfile({ id: "u-first-real", email: "first@example.test", name: "First" });
assert.equal(firstReal.role, "owner", "先有调试座位，第一个注册的真人仍然要当 owner");
assert.equal(Number(firstReal.approved), 1, "owner 不用等自己开通");
const secondReal = ensureUserProfile({ id: "u-second-real", email: "second@example.test", name: "Second" });
assert.equal(secondReal.role, "user");
assert.equal(Number(secondReal.approved), 0, "第二个真人默认待开通");

const timestamp = nowIso();
sqlite
  .prepare(
    `INSERT INTO user_profile (user_id, display_name, role, plan, credits, monthly_used, status, created_at, updated_at)
     VALUES ('u-legacy', 'Legacy', 'user', '基础版', 0, 0, 'active', ?, ?)`,
  )
  .run(timestamp, timestamp);
assert.equal(sqlite.prepare("SELECT approved FROM user_profile WHERE user_id = 'u-legacy'").get().approved, 1, "老账号默认已开通");

/* ── 注册审批开关 ────────────────────────────────────────────────────────── */
delete process.env.SIGNUP_APPROVAL;
assert.equal(signupApprovalRequired(), true, "默认新账号要等管理员开通");
process.env.SIGNUP_APPROVAL = "false";
assert.equal(signupApprovalRequired(), false);
process.env.SIGNUP_APPROVAL = "true";

/* ── Key 校验 / 加密 / 脱敏 ──────────────────────────────────────────────── */
assert.equal(keys.normalizeApiKey("").error, "请填写 API Key。");
assert(keys.normalizeApiKey("sk 123456789").error.includes("空格"));
assert(keys.normalizeApiKey("short").error.includes("太短"));
assert.equal(keys.normalizeApiKey("  sk-test-key-1234567890  ").value, "sk-test-key-1234567890");

const encrypted = keys.encryptApiKey("sk-test-key-1234567890");
assert(encrypted.startsWith("v1:"), "密文要带版本前缀，将来换算法有得认");
assert(!encrypted.includes("sk-test-key"), "密文里不能看到明文");
assert.equal(keys.decryptApiKey(encrypted), "sk-test-key-1234567890");
assert.notEqual(keys.encryptApiKey("sk-test-key-1234567890"), encrypted, "每次随机 IV，同一把 Key 密文也不同");
assert.equal(keys.apiKeyHint("sk-test-key-1234567890"), "sk-…7890");
assert.equal(keys.apiKeyHint("abcdefg"), "ab…");

/* ── 落库 / 解析 / 优先级 ────────────────────────────────────────────────── */
assert.deepEqual(keys.resolveProviderApiKey("u-legacy"), { apiKey: "", source: "" }, "没有任何 Key 时要能识别出来");
process.env.OPENAI_API_KEY = "sk-server-shared-key-0000";
assert.deepEqual(keys.resolveProviderApiKey("u-legacy"), { apiKey: "sk-server-shared-key-0000", source: "server" });

const saved = keys.setUserApiKey("u-legacy", "sk-test-key-1234567890");
assert.equal(saved.apiKeyHint, "sk-…7890");
const stored = sqlite.prepare("SELECT api_key_encrypted, api_key_hint FROM user_profile WHERE user_id = 'u-legacy'").get();
assert(stored.api_key_encrypted.startsWith("v1:") && !stored.api_key_encrypted.includes("sk-test-key"), "库里只放密文");
assert.equal(stored.api_key_hint, "sk-…7890");
assert.deepEqual(keys.resolveProviderApiKey("u-legacy"), { apiKey: "sk-test-key-1234567890", source: "user" }, "自备 Key 优先于服务端 Key");

// AUTH_SECRET 换了解不开：当成没有 Key，回退到服务端，别把整个请求打挂
process.env.AUTH_SECRET = "another-secret-after-rotation-1234567890";
assert.equal(keys.userApiKey("u-legacy"), "");
assert.equal(keys.resolveProviderApiKey("u-legacy").source, "server");
process.env.AUTH_SECRET = "test-auth-secret-for-user-keys-1234567890";

keys.clearUserApiKey("u-legacy");
assert.equal(keys.userApiKey("u-legacy"), "");
assert.equal(sqlite.prepare("SELECT api_key_hint FROM user_profile WHERE user_id = 'u-legacy'").get().api_key_hint, null);

/* ── 接线：生成路由按 Key 来源决定扣不扣分，后台能看到用量 ─────────────── */
const index = await fs.readFile("server/index.mjs", "utf8");
assert(index.includes("resolveProviderApiKey(account.user.id)"), "生成路由要先解析这次该用谁的 Key");
assert(index.includes('cost = ownKey ? 0 : estimateCredits(payload)'), "自备 Key 不扣积分");
assert(index.includes('keySource: ownKey ? "user" : "server"'), "任务要记下 Key 来源");
assert(index.includes("callOpenAIImages(payload, files, providerKey.apiKey)"), "调接口时用解析出来的 Key");
const api = await fs.readFile("server/api.mjs", "utf8");
assert(api.includes('app.put("/api/me/api-key"') && api.includes('app.delete("/api/me/api-key"'), "账户要能保存 / 清除自备 Key");
assert(api.includes("export function usageByUser"), "后台按账号汇总用量");
assert(api.includes("nextApproved"), "后台能开通 / 收回账号");
assert(!api.includes("api_key_encrypted:") , "接口不回传密文");
const auth = await fs.readFile("server/auth.mjs", "utf8");
assert(auth.includes("pendingApproval: true"), "未开通的账号要被明确拦下并说明原因");
const workflows = await fs.readFile("server/workflows.mjs", "utf8");
assert(!workflows.includes("Bearer ${process.env.OPENAI_API_KEY}"), "功能中心也要走账号自备 Key");

await fs.rm(tmpDir, { recursive: true, force: true });
console.log(JSON.stringify({ checks: "passed" }, null, 2));
