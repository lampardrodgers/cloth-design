import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "clothdesign-provider-"));
process.env.DATABASE_URL = `file:${path.join(tmpDir, "test.db")}`;
process.env.OPENAI_BASE_URL = "https://www.packyapi.com";
process.env.OPENAI_IMAGE_MODEL = "gpt-image-2";

const { migrateBusinessDatabase, sqlite } = await import("../server/db.mjs");
migrateBusinessDatabase();
const pc = await import("../server/provider-config.mjs");

/* ── 默认取 .env ─────────────────────────────────────────────────────────── */
assert.equal(pc.imageApiBaseUrl(), "https://www.packyapi.com/v1", "根地址要自动补上 /v1");
assert.equal(pc.imageApiModel(), "gpt-image-2");
assert.equal(pc.imageProviderSettings().baseUrlSource, "env");
assert.equal(pc.imageApiUrl("/images/generations"), "https://www.packyapi.com/v1/images/generations");
assert.equal(pc.imageApiUrl("images/edits"), "https://www.packyapi.com/v1/images/edits", "前导斜杠有没有都要拼对");

/* ── 校验 ────────────────────────────────────────────────────────────────── */
assert(pc.normalizeBaseUrl("").error, "空地址要挡住");
assert(pc.normalizeBaseUrl("哈哈").error, "非 URL 要挡住");
assert(pc.normalizeBaseUrl("ftp://a.com").error, "只允许 http/https");
assert.equal(pc.normalizeBaseUrl("https://a.com/").value, "https://a.com/v1", "尾斜杠要吃掉并补 /v1");
assert.equal(pc.normalizeBaseUrl("https://a.com/v1").value, "https://a.com/v1", "已经带 /v1 就不要再加一层");
assert.equal(pc.normalizeBaseUrl("  https://a.com/v1/  ").value, "https://a.com/v1");
assert.equal(pc.normalizeBaseUrl("http://127.0.0.1:8907").value, "http://127.0.0.1:8907/v1", "带端口的内网地址也要能用");
assert(pc.normalizeModel("a b").error, "模型名不能有空格");
assert(pc.normalizeModel("").error);

/* ── 覆盖值落库并立刻生效 ────────────────────────────────────────────────── */
const saved = pc.saveImageProviderSettings({ baseUrl: "https://other.example.com", model: "gpt-image-3" });
assert(!saved.error);
assert.equal(pc.imageApiBaseUrl(), "https://other.example.com/v1", "改完不用重启就要生效");
assert.equal(pc.imageApiModel(), "gpt-image-3");
assert.equal(pc.imageProviderSettings().baseUrlSource, "custom");
assert.equal(pc.imageProviderSettings().defaults.baseUrl, "https://www.packyapi.com/v1", "默认值要一直看得见，才能「恢复默认」");
assert.equal(sqlite.prepare("SELECT COUNT(*) c FROM app_config WHERE key = 'imageProvider'").get().c, 1);

// 新进程读同一个库要拿到同样的值（缓存不能盖住持久化）
pc.invalidateImageProviderCache();
assert.equal(pc.imageApiBaseUrl(), "https://other.example.com/v1", "覆盖值必须真的写进了 app_config");

// 只改一项时另一项保持不变
pc.saveImageProviderSettings({ model: "gpt-image-4" });
assert.equal(pc.imageApiBaseUrl(), "https://other.example.com/v1", "只改模型不该把地址带回默认");
assert.equal(pc.imageApiModel(), "gpt-image-4");

// 非法值不能把已有配置写坏
const bad = pc.saveImageProviderSettings({ baseUrl: "nonsense" });
assert(bad.error);
assert.equal(pc.imageApiBaseUrl(), "https://other.example.com/v1", "保存失败时旧值要原样保留");

// 提交的值和 .env 默认值相同时不记成覆盖，来源标签才不会说谎
pc.resetImageProviderSettings();
pc.saveImageProviderSettings({ baseUrl: "https://relay.example.com", model: "gpt-image-2" });
assert.equal(pc.imageProviderSettings().baseUrlSource, "custom", "地址确实改了");
assert.equal(pc.imageProviderSettings().modelSource, "env", "模型跟默认一样，不该标成后台已改");
assert.equal(pc.imageApiModel(), "gpt-image-2");
pc.resetImageProviderSettings();

/* ── 恢复默认 ────────────────────────────────────────────────────────────── */
pc.saveImageProviderSettings({ baseUrl: "", model: "" });
assert.equal(pc.imageApiBaseUrl(), "https://www.packyapi.com/v1");
assert.equal(pc.imageProviderSettings().baseUrlSource, "env");
assert.equal(sqlite.prepare("SELECT COUNT(*) c FROM app_config WHERE key = 'imageProvider'").get().c, 0, "全清空后不该留下空记录");

pc.saveImageProviderSettings({ baseUrl: "https://x.com" });
pc.resetImageProviderSettings();
assert.equal(pc.imageProviderSettings().baseUrlSource, "env");

/* ── 接线：出图和功能中心都要走这一份配置 ────────────────────────────────── */
const index = await fs.readFile("server/index.mjs", "utf8");
assert(!index.includes("function configuredImageApiBaseUrl"), "index.mjs 不该再自己拼地址");
assert(!index.includes("process.env.OPENAI_IMAGE_MODEL"), "模型名也要走统一配置");
assert(index.includes('from "./provider-config.mjs"'));
const workflows = await fs.readFile("server/workflows.mjs", "utf8");
assert(!workflows.includes("function configuredImageApiBaseUrl"), "功能中心不该再自己拼地址");
assert(workflows.includes('from "./provider-config.mjs"'));
const api = await fs.readFile("server/api.mjs", "utf8");
assert(api.includes('app.put("/api/admin/image-provider"'), "后台要能改");
assert(api.includes('app.delete("/api/admin/image-provider"'), "后台要能恢复默认");
assert(api.includes('app.post("/api/admin/image-provider/test"'), "后台要能测连通");
assert(api.includes("imageProvider: imageProviderSettings()"), "总览里要带上当前配置");
assert(api.includes("/models"), "连通测试用不花钱的 /models");

await fs.rm(tmpDir, { recursive: true, force: true });
console.log(JSON.stringify({ checks: "passed" }, null, 2));
