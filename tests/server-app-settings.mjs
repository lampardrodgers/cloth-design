// 后台「积分规则」「系统提示词模板」以前只存管理员自己浏览器的 localStorage，改了对谁都不生效；
// 现在落 app_config、/api/me 下发、服务端扣费按同一份算。账号偏好（提示词库 / 设置 / 草稿）也落库跨设备同步。
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "clothdesign-app-settings-"));
process.env.DATABASE_URL = `file:${path.join(tmpDir, "test.db")}`;
process.env.AUTH_SECRET = "test-auth-secret-for-app-settings-1234567890";

const { migrateBusinessDatabase, sqlite, nowIso } = await import("../server/db.mjs");
migrateBusinessDatabase();
const settings = await import("../server/app-settings.mjs");

/* ── 积分规则：默认值 / 校验 / 保存后生效 ───────────────────────────────── */
assert.deepEqual(settings.creditPolicySettings(), { ...settings.DEFAULT_CREDIT_POLICY }, "没改过就是默认值");
assert.match(settings.normalizeCreditPolicy({ perReference: "abc" }).error, /不是数字/);
assert.match(settings.normalizeCreditPolicy({ highQualityMultiplier: 0.5 }).error, /之间/);
assert.match(settings.saveCreditPolicy({ fourKMultiplier: 99 }).error, /之间/, "越界不落库");
assert.deepEqual(settings.creditPolicySettings(), { ...settings.DEFAULT_CREDIT_POLICY }, "保存失败不能改掉原值");

const saved = settings.saveCreditPolicy({ perReference: 6, highQualityMultiplier: 1.5 });
assert.equal(saved.value.perReference, 6);
assert.equal(saved.value.highQualityMultiplier, 1.5);
assert.equal(saved.value.fourKMultiplier, settings.DEFAULT_CREDIT_POLICY.fourKMultiplier, "没传的字段沿用当前值");
assert.equal(settings.creditPolicySettings().perReference, 6, "读回来的是刚保存的");
assert(sqlite.prepare("SELECT value_json FROM app_config WHERE key = 'credit_policy'").get(), "要落在 app_config");

// 服务端扣费用的就是这份：index.mjs 的 estimateCredits 不再写死。
const indexSource = await fs.readFile("server/index.mjs", "utf8");
assert(indexSource.includes("const policy = creditPolicySettings();"), "estimateCredits 要读 app_config 里的规则");
assert(!/perReference: 4,\n\s+highQualityMultiplier: 1\.35/.test(indexSource.replace(/DEFAULT_CREDIT_POLICY[\s\S]*?\}\);/, "")), "index.mjs 里不该再有写死的倍率表");
// 客户端默认值和服务端默认值必须一致，否则登录前后报价会跳。
const catalog = await fs.readFile("src/data/catalog.ts", "utf8");
const clientPolicy = catalog.match(/export const creditPolicy: CreditPolicy = \{([\s\S]*?)\};/)[1];
for (const [field, value] of Object.entries(settings.DEFAULT_CREDIT_POLICY)) {
  assert(clientPolicy.includes(`${field}: ${value}`), `客户端默认 ${field} 要和服务端一致（${value}）`);
}

/* ── 系统提示词模板：按模式覆盖，null 恢复默认 ───────────────────────────── */
assert.deepEqual(settings.systemPromptOverrides(), {}, "没改过就没有覆盖");
assert.match(settings.saveSystemPrompts({ nope: "x" }).error, /不认识的模式/);
assert.match(settings.saveSystemPrompts({ text: 123 }).error, /文本/);
assert.match(settings.saveSystemPrompts({ text: "x".repeat(5000) }).error, /太长/);
settings.saveSystemPrompts({ text: "只输出服装提示词（测试覆盖）", free: "" });
assert.deepEqual(settings.systemPromptOverrides(), { text: "只输出服装提示词（测试覆盖）", free: "" }, "空串也是一种覆盖（表示不要模板）");
settings.saveSystemPrompts({ free: null });
assert.deepEqual(settings.systemPromptOverrides(), { text: "只输出服装提示词（测试覆盖）" }, "null 恢复默认 = 从覆盖表里删掉");
// 模式列表要和客户端 catalog 一致
for (const mode of settings.SYSTEM_PROMPT_MODES) {
  assert(catalog.includes(`id: "${mode}"`), `catalog 里要有模式 ${mode}`);
}

/* ── 账号偏好：合并写、null 删、键名和大小都有限制 ─────────────────────── */
const timestamp = nowIso();
sqlite
  .prepare(
    `INSERT INTO user_profile (user_id, display_name, role, plan, credits, monthly_used, status, created_at, updated_at)
     VALUES ('u-pref', 'Pref', 'user', '基础版', 0, 0, 'active', ?, ?)`,
  )
  .run(timestamp, timestamp);
assert(sqlite.prepare("PRAGMA table_info(user_profile)").all().some((row) => row.name === "preferences_json"), "user_profile 要有 preferences_json");
assert.deepEqual(settings.readUserPreferences("u-pref"), {});
assert.match(settings.mergeUserPreferences("u-pref", null).error, /格式/);
assert.match(settings.mergeUserPreferences("u-pref", { "evil key": 1 }).error, /不合法/);
assert.match(settings.mergeUserPreferences("u-pref", { "other:settings": 1 }).error, /不合法/, "只认 clothdesign: 前缀");
settings.mergeUserPreferences("u-pref", { "clothdesign:settings": { quality: "high" }, "clothdesign:free:ratio": "16-9" });
settings.mergeUserPreferences("u-pref", { "clothdesign:free:ratio": null, "clothdesign:promptLibrary": { colors: [] } });
assert.deepEqual(settings.readUserPreferences("u-pref"), {
  "clothdesign:settings": { quality: "high" },
  "clothdesign:promptLibrary": { colors: [] },
}, "合并写：新键加上、null 的删掉、没提到的不动");
const tooBig = settings.mergeUserPreferences("u-pref", { "clothdesign:modeDrafts": "x".repeat(settings.PREFERENCES_MAX_BYTES + 10) });
assert.match(tooBig.error, /上限/);
assert.deepEqual(Object.keys(settings.readUserPreferences("u-pref")).sort(), ["clothdesign:promptLibrary", "clothdesign:settings"], "超限那次不落库");

/* ── 接口和客户端接线 ───────────────────────────────────────────────────── */
const apiSource = await fs.readFile("server/api.mjs", "utf8");
assert(apiSource.includes('app.put("/api/admin/credit-policy"'), "后台改积分规则的接口");
assert(apiSource.includes('app.put("/api/admin/system-prompts"'), "后台改提示词模板的接口");
assert(apiSource.includes('app.put("/api/me/preferences"'), "账号偏好写入接口");
assert(apiSource.includes("creditPolicy: creditPolicySettings(),") && apiSource.includes("preferences: readUserPreferences(account.user.id),"), "/api/me 要下发规则和偏好");

const app = await fs.readFile("src/App.tsx", "utf8");
assert(!app.includes('useStoredState<CreditPolicy>("clothdesign:creditPolicy"'), "积分规则不再存管理员本机");
assert(!app.includes('useStoredState<SystemPromptMap>("clothdesign:systemPrompts"'), "提示词模板不再存管理员本机");
assert(app.includes("if (data.creditPolicy) setCreditPolicy(data.creditPolicy);"), "登录时接服务端下发的积分规则");
assert(app.includes("seedAccountPreferences(data.account.id, data.preferences);"), "登录时先把服务端偏好落到本地命名空间");
assert(app.indexOf("seedAccountPreferences(data.account.id, data.preferences);") < app.indexOf("setStoredStateAccount(data.account.id);"), "偏好要在切命名空间之前落地，否则 hook 读到的还是旧的");

const stored = await fs.readFile("src/lib/storedState.ts", "utf8");
assert(stored.includes("export const SYNCED_PREFERENCE_KEYS"), "同步哪些键要有一张明确的表");
for (const key of ["clothdesign:promptLibrary", "clothdesign:settings", "clothdesign:modeDrafts"]) {
  assert(stored.includes(`"${key}"`), `${key} 要跨设备同步`);
}
assert(!stored.includes('"clothdesign:tasks"') && !stored.includes('"clothdesign:results"'), "任务 / 成片不同步（服务端本来就有，也太大）");
assert(stored.includes("if (dirtyRef.current) queuePreferenceSync(key, value);"), "只有用户改过才推，首次挂载重读那一轮不推");

const admin = await fs.readFile("src/components/AdminPanel.tsx", "utf8");
assert(!admin.includes("window.prompt("), "后台改密 / 配 Key 不再用明文的 window.prompt");
assert(admin.includes('className="admin-inline-editor"') && admin.includes('type="password"'), "改成行内 password 小表单");
assert(admin.includes("onCreditPolicySave") && admin.includes("onSystemPromptsSave"), "积分规则和提示词模板要有保存到服务端的动作");
assert(admin.includes("保存后对<strong>所有账号</strong>生效"), "页面上要写清楚这是对所有人生效的");

const account = await fs.readFile("src/components/AccountPanel.tsx", "utf8");
assert(account.includes("changeMyPassword(") && account.includes('autoComplete="current-password"'), "账户页要有自助改密");

await fs.rm(tmpDir, { recursive: true, force: true });
console.log(JSON.stringify({ checks: "passed" }, null, 2));
