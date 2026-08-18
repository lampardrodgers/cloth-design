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
const { signupApprovalRequired, selfSignupAllowed, ensureUserProfile } = await import("../server/auth.mjs");
const { ensureDebugUserProfile, newDebugSeat, debugUserIdFromSeat } = await import("../server/debug.mjs");

/* ── 迁移：老库升级后老账号视为已开通，任务表带 key_source ───────────────── */
const profileColumns = sqlite.prepare("PRAGMA table_info(user_profile)").all().map((row) => row.name);
for (const column of ["approved", "api_key_encrypted", "api_key_hint", "api_key_updated_at", "api_provider_id", "max_resolution"]) {
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

/* ── 每个账号能开到几 K：线路能力和后台上限取低 ──────────────────────────── */
const policyUserId = "u-second-real";
assert.deepEqual(keys.userResolutionPolicy(policyUserId), {
  maxResolution: "native",
  maxResolutionSetting: "",
  maxResolutionSource: "provider",
});
// 出图那一刻用的也是同一份上限，前端漏拦了服务端还能兜住。
assert.equal(keys.resolveProviderApiKey(policyUserId).maxResolution, "native");

sqlite.prepare("UPDATE user_profile SET api_provider_id = 'apimart' WHERE user_id = ?").run(policyUserId);
assert.equal(keys.userResolutionPolicy(policyUserId).maxResolution, "fourK", "APIMart 线路才有 4K");
sqlite.prepare("UPDATE user_profile SET max_resolution = 'hd' WHERE user_id = ?").run(policyUserId);
assert.deepEqual(keys.userResolutionPolicy(policyUserId), {
  maxResolution: "hd",
  maxResolutionSetting: "hd",
  maxResolutionSource: "account",
});
sqlite.prepare("UPDATE user_profile SET api_provider_id = 'default' WHERE user_id = ?").run(policyUserId);
assert.equal(keys.userResolutionPolicy(policyUserId).maxResolution, "native", "换回只出 1K 的线路，后台设的 2K 也顶不上去");
sqlite.prepare("UPDATE user_profile SET max_resolution = NULL WHERE user_id = ?").run(policyUserId);

/* ── 账号名 ↔ 内部邮箱 ───────────────────────────────────────────────────── */
const accounts = await import("../server/accounts.mjs");
assert.equal(accounts.normalizeUsername("  Admin  ").value, "admin", "账号名统一小写并去空格");
assert.equal(accounts.usernameToEmail("admin"), "admin@clothdesign.local");
assert.equal(accounts.emailToUsername("admin@clothdesign.local"), "admin");
assert.equal(accounts.emailToUsername("someone@gmail.com"), "someone@gmail.com", "真实邮箱原样显示，不能截成 someone");
assert(accounts.normalizeUsername("has space").error, "账号名不能有空格");
assert(accounts.normalizeUsername("a@b").error.includes("@"), "带 @ 要单独提示");
assert(accounts.normalizeUsername("x").error, "太短不行");
assert(accounts.normalizeUsername("_lead").error, "不能以下划线开头");
assert.equal(accounts.normalizeUsername("xiao.li-01_a").value, "xiao.li-01_a");

// 客户端那份规则要跟服务端一致，否则登录框补出来的邮箱对不上
const clientAccounts = await fs.readFile("src/lib/accounts.ts", "utf8");
assert(clientAccounts.includes('INTERNAL_EMAIL_DOMAIN = "clothdesign.local"'), "两侧的内部域名必须相同");
assert(clientAccounts.includes("loginIdentifierToEmail"), "登录框要把账号名补成内部邮箱");

/* ── 自助注册开关 ────────────────────────────────────────────────────────── */
delete process.env.ALLOW_SELF_SIGNUP;
assert.equal(selfSignupAllowed(), true, "默认允许自助注册，本地开发和首次装机要能拿到 owner");
process.env.ALLOW_SELF_SIGNUP = "false";
assert.equal(selfSignupAllowed(), false, "关掉后只能后台建号");
delete process.env.ALLOW_SELF_SIGNUP;

/* ── 无限额度账号不走积分账本 ────────────────────────────────────────────── */
const { consumeCredits } = await import("../server/payments.mjs");
sqlite
  .prepare("UPDATE user_profile SET credits = 5, unlimited = 1 WHERE user_id = 'u-second-real'")
  .run();
consumeCredits({ userId: "u-second-real", taskId: "unlimited-task", amount: 9999, reason: "无限额度扣费" });
assert.equal(
  sqlite.prepare("SELECT credits FROM user_profile WHERE user_id = 'u-second-real'").get().credits,
  5,
  "开了无限额度的账号余额不该被扣",
);
assert.equal(
  sqlite.prepare("SELECT COUNT(*) AS c FROM credit_ledger WHERE user_id = 'u-second-real'").get().c,
  0,
  "无限额度也不写流水",
);
// 关掉之后恢复正常扣费
sqlite.prepare("UPDATE user_profile SET unlimited = 0 WHERE user_id = 'u-second-real'").run();
assert.throws(
  () => consumeCredits({ userId: "u-second-real", taskId: "t2", amount: 9999, reason: "普通扣费" }),
  /积分余额不足/,
  "取消无限额度后要恢复按余额校验",
);

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
assert.equal(keys.resolveProviderApiKey("u-legacy").source, "", "没有任何 Key 时要能识别出来");
assert.equal(keys.resolveProviderApiKey("u-legacy").providerId, "default");
process.env.OPENAI_API_KEY = "sk-server-shared-key-0000";
assert.equal(keys.resolveProviderApiKey("u-legacy").apiKey, "sk-server-shared-key-0000");
assert.equal(keys.resolveProviderApiKey("u-legacy").source, "server");

const saved = keys.setUserApiKey("u-legacy", "sk-test-key-1234567890");
assert.equal(saved.apiKeyHint, "sk-…7890");
const stored = sqlite.prepare("SELECT api_key_encrypted, api_key_hint FROM user_profile WHERE user_id = 'u-legacy'").get();
assert(stored.api_key_encrypted.startsWith("v1:") && !stored.api_key_encrypted.includes("sk-test-key"), "库里只放密文");
assert.equal(stored.api_key_hint, "sk-…7890");
assert.equal(keys.resolveProviderApiKey("u-legacy").apiKey, "sk-test-key-1234567890", "自备 Key 优先于服务端 Key");
assert.equal(keys.resolveProviderApiKey("u-legacy").source, "user");
assert.equal(keys.setUserApiProvider("u-legacy", "apimart").apiProviderId, "apimart");
process.env.APIMART_API_KEY = "sk-apimart-shared-key-0000";
assert.equal(keys.resolveProviderApiKey("u-legacy").provider.protocol, "apimart");
assert.equal(keys.resolveProviderApiKey("u-legacy").apiKey, "sk-test-key-1234567890", "切换 URL Base 后自备 Key 仍优先");
assert(keys.setUserApiProvider("u-legacy", "missing").error, "未知 URL Base 要拒绝");

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
assert(index.includes("callOpenAIImages(payload, files, providerKey.apiKey, providerKey.provider)"), "调接口时 Key 和 URL Base 要成套使用");
const api = await fs.readFile("server/api.mjs", "utf8");
const auth = await fs.readFile("server/auth.mjs", "utf8");
assert(api.includes('app.put("/api/me/api-key"') && api.includes('app.delete("/api/me/api-key"'), "账户要能保存 / 清除自备 Key");
assert(api.includes("export function usageByUser"), "后台按账号汇总用量");
assert(api.includes("nextApproved"), "后台能开通 / 收回账号");
assert(api.includes("nextUnlimited"), "后台能开 / 关无限额度");
// 后台只有 admin 这一个账号能进：角色不开放修改（下拉框误点把人提成管理员 / 把自己降级，线上两头都踩过）
assert(api.includes("账号角色不能改"), "PATCH 用户不允许改角色");
assert(api.includes("const nextRole = current.role;"), "角色永远保持原值");
assert(api.includes('if (isSelf && nextStatus === "locked")'), "不能锁定自己");
assert(auth.includes("export function isAdminRole(role) {\n  return role === \"owner\";"), "服务端只认 owner 为管理员");
assert(!api.includes('["owner", "admin"].includes'), "服务端不再把 admin 角色当管理员");
const dbSrc = await fs.readFile("server/db.mjs", "utf8");
assert(dbSrc.includes("WHERE role = 'admin'"), "升级时把早期提成 admin 的账号降回普通用户");
const adminPanel = await fs.readFile("src/components/AdminPanel.tsx", "utf8");
assert(!adminPanel.includes('<option value="admin">admin</option>'), "后台用户表不能再有角色下拉框");
assert(adminPanel.includes("user.id === currentUserId"), "自己那一行的状态要只读");
assert(adminPanel.includes("setCreateNotice(error)"), "改动被服务端拒绝时要提示，不能界面改了库里没改");
assert(api.includes('app.post("/api/admin/users"'), "后台能直接建账号");
assert(api.includes('app.put("/api/admin/users/:id/api-key"'), "后台能给账号配 Key");
assert(api.includes('const role = "user";'), "后台发的号一律普通用户，保证只有管理员能进 /admin");
assert(api.includes("if (presetKey) setUserApiKey(userId, presetKey, apiProviderId);"), "建号时填的 Key 要和 URL Base 一起落到这个账号上");
assert(api.includes("username: emailToUsername(user.email)"), "账号信息里要带账号名");
assert(api.includes('app.post("/api/admin/users/:id/password"'), "后台能重置密码");
assert(api.includes("export function adminSummary"), "后台要有一眼概览");
const indexSrc = await fs.readFile("server/index.mjs", "utf8");
assert(indexSrc.includes('app.post("/api/auth/sign-up/{*any}"'), "关掉自助注册时要在 HTTP 层挡住注册端点");
assert(indexSrc.includes("selfSignupAllowed: selfSignupAllowed()"), "前端要能知道注册是否开放");
const authPanel = await fs.readFile("src/components/AuthPanel.tsx", "utf8");
assert(authPanel.includes("selfSignupAllowed ? ("), "关掉自助注册后登录页不显示注册 tab");
// 调试入口不能出现在登录页；无限额度改由管理员按账号授予
assert(!authPanel.includes("开发调试"), "登录页不该再有开发调试入口");
// 后台发的号是裸账号名，登录框用 type="email" 会被浏览器拦下
assert(!authPanel.includes('type={selfSignupAllowed ? "email" : "text"}'), "登录框不能按模式切成 email 类型");
const appSrc = await fs.readFile("src/App.tsx", "utf8");
assert(!appSrc.includes("debug-mode-button"), "顶栏不该再有开发调试切换按钮");
assert(appSrc.includes('currentUser?.unlimited === true'), "顶栏的 ∞ 要跟着账号上的无限额度走");
assert(!appSrc.includes('["owner", "admin"].includes'), "客户端也只认 owner 为管理员");
assert(appSrc.includes('window.history.replaceState({}, "", "/")'), "普通账号敲 /admin 要被送回首页");
assert(!api.includes("api_key_encrypted:") , "接口不回传密文");
assert(auth.includes("pendingApproval: true"), "未开通的账号要被明确拦下并说明原因");
const workflows = await fs.readFile("server/workflows.mjs", "utf8");
assert(!workflows.includes("Bearer ${process.env.OPENAI_API_KEY}"), "功能中心也要走账号自备 Key");

await fs.rm(tmpDir, { recursive: true, force: true });
console.log(JSON.stringify({ checks: "passed" }, null, 2));
