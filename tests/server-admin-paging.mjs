import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";

/**
 * 后台列表分页。
 *
 * 之前 /api/admin/overview 把用户全表 + 订单/事件/流水/成片各 80 条一次性塞在一个响应里，
 * 前端再 slice 出 8~12 条渲染：第 13 条往后永远看不到，用户涨到几百之后这个响应也扛不住。
 * 这里核对：每个列表都只给一页、总数单独给、页码能翻到底、越界夹回最后一页、
 * 用户列表能搜能筛、pageSize 有上限、非管理员一律 403。
 */

const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "clothdesign-admin-paging-"));
const dbPath = path.join(tmpDir, "app.db");

function waitForOutput(child, pattern) {
  return new Promise((resolve, reject) => {
    let stderr = "";
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${pattern}\n${stderr}`)), 20000);
    const onData = (chunk) => {
      if (pattern.test(String(chunk))) {
        clearTimeout(timer);
        child.stdout.off("data", onData);
        resolve();
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`App exited before startup: ${code}\n${stderr}`));
    });
  });
}

function appendCookies(jar, response) {
  for (const item of response.headers.getSetCookie?.() || []) {
    const cookie = item.split(";", 1)[0];
    if (cookie) jar.set(cookie.split("=", 1)[0], cookie);
  }
}

async function request(baseUrl, jar, pathname, init = {}) {
  const headers = new Headers(init.headers || {});
  headers.set("Origin", baseUrl);
  if (jar.size) headers.set("Cookie", [...jar.values()].join("; "));
  const response = await fetch(`${baseUrl}${pathname}`, { ...init, headers });
  appendCookies(jar, response);
  return response;
}

const jsonBody = (value) => ({ headers: { "Content-Type": "application/json" }, body: JSON.stringify(value) });

async function expectOk(response) {
  if (response.ok) return response.json();
  throw new Error(`${response.status} ${await response.text()}`);
}

const appPort = 22000 + Math.floor(Math.random() * 900);
const app = spawn(process.execPath, ["server/index.mjs"], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    HOST: "127.0.0.1",
    PORT: String(appPort),
    DATABASE_URL: `file:${dbPath}`,
    AUTH_SECRET: "test-admin-paging-secret-1234567890",
    SIGNUP_APPROVAL: "false",
    ALLOW_SELF_SIGNUP: "true",
    PUBLIC_APP_URL: `http://127.0.0.1:${appPort}`,
    NODE_ENV: "test",
    PAYMENT_DEMO_MODE: "true",
    OPENAI_DEMO_MODE: "true",
  },
});

const iso = (offsetMinutes) => new Date(Date.UTC(2026, 0, 1, 0, offsetMinutes, 0)).toISOString();

try {
  await waitForOutput(app, /ClothDesign AI running/);
  const baseUrl = `http://127.0.0.1:${appPort}`;
  const jar = new Map();

  // 第一个真实账号是 owner，能进后台。
  await expectOk(
    await request(baseUrl, jar, "/api/auth/sign-up/email", {
      method: "POST",
      ...jsonBody({ name: "Paging Admin", email: "admin@example.test", password: "clothdesign123" }),
    }),
  );
  const me = await expectOk(await request(baseUrl, jar, "/api/me"));
  assert.equal(me.account.role, "owner");
  const adminId = me.account.id;

  // ---------- 直接往库里灌数据：45 个账号、45 笔订单 / 事件 / 流水 / 成片 ----------
  const SEED = 45;
  const db = new Database(dbPath);
  db.pragma("busy_timeout = 5000");
  const insertProfile = db.prepare(
    `INSERT INTO user_profile
       (user_id, display_name, role, plan, credits, monthly_used, status, approved, unlimited, api_provider_id, shortvideo_enabled, created_at, updated_at)
     VALUES (?, ?, 'user', '测试版', 0, 0, ?, ?, 0, 'default', 0, ?, ?)`,
  );
  const insertOrder = db.prepare(
    `INSERT INTO payment_order
       (id, user_id, package_id, provider, status, amount_cents, credits, subject, qr_code_url, qr_code_data_url, expires_at, created_at, updated_at)
     VALUES (?, ?, 'pkg-1', 'alipay', 'pending', 9900, 300, ?, '', '', ?, ?, ?)`,
  );
  const insertEvent = db.prepare(
    `INSERT INTO payment_event (id, provider, event_key, order_id, transaction_id, processed, payload, created_at)
     VALUES (?, 'alipay', ?, NULL, NULL, 0, '{}', ?)`,
  );
  const insertLedger = db.prepare(
    `INSERT INTO credit_ledger (id, user_id, kind, amount, balance_after, reason, created_at)
     VALUES (?, ?, 'recharge', 10, 10, ?, ?)`,
  );
  const insertTask = db.prepare(
    `INSERT INTO generation_task (id, user_id, mode, prompt, status, credits, message, key_source, created_at, updated_at)
     VALUES (?, ?, 'text', 'p', 'success', 1, '', 'server', ?, ?)`,
  );
  const insertResult = db.prepare(
    `INSERT INTO generated_result (id, task_id, user_id, title, mode, ratio_label, storage_status, credits, image_url, metadata_json, created_at)
     VALUES (?, ?, ?, ?, 'text', '1:1', 'cloud-temp', 1, '/x.png', '{}', ?)`,
  );

  db.transaction(() => {
    for (let index = 0; index < SEED; index += 1) {
      const at = iso(index);
      const userId = `seed-user-${String(index).padStart(2, "0")}`;
      // 前三个账号故意做成待开通 / 锁定，用来验筛选。
      insertProfile.run(userId, `种子账号 ${index}`, index === 1 ? "locked" : "active", index === 0 ? 0 : 1, at, at);
      insertOrder.run(`seed-order-${index}`, adminId, `订单 ${index}`, iso(index + 60), at, at);
      insertEvent.run(`seed-event-${index}`, `key-${index}`, at);
      insertLedger.run(`seed-ledger-${index}`, adminId, `流水 ${index}`, at);
      insertTask.run(`seed-task-${index}`, adminId, at, at);
      insertResult.run(`seed-result-${index}`, `seed-task-${index}`, adminId, `成片 ${index}`, at);
    }
    // 名字里带 LIKE 通配符的账号：搜 "a_b" 不能把 "axb" 也搜出来。
    insertProfile.run("seed-user-literal", "a_b 特殊名", "active", 1, iso(500), iso(500));
    insertProfile.run("seed-user-decoy", "axb 干扰项", "active", 1, iso(501), iso(501));
  })();
  db.close();

  const totalUsers = SEED + 2 + 1; // 种子账号 + 两个特殊名 + admin 自己

  // ---------- overview 只给第一页 ----------
  const overview = await expectOk(await request(baseUrl, jar, "/api/admin/overview"));
  assert.equal(overview.users.length, 20, "overview 的用户只给一页");
  assert.equal(overview.orders.length, 20);
  assert.equal(overview.paymentEvents.length, 20);
  assert.equal(overview.ledger.length, 20);
  assert.equal(overview.generationResults.length, 15, "生成审计排 3 列 × 5 行，一页 15 张");
  assert.equal(overview.pagination.users.total, totalUsers, "总数要单独给，不然前端不知道还有多少");
  assert.equal(overview.pagination.users.pageSize, 20);
  assert.equal(overview.pagination.users.pageCount, Math.ceil(totalUsers / 20));
  assert.equal(overview.pagination.orders.total, SEED);
  assert.equal(overview.pagination.ledger.total, SEED);
  assert.equal(overview.pagination.generationResults.total, SEED);
  assert.equal(overview.pagination.generationResults.pageSize, 15);
  assert.equal(overview.pagination.generationResults.pageCount, Math.ceil(SEED / 15));
  assert(!("items" in overview.pagination.users), "pagination 里不重复带数据体");

  // ---------- 翻页：页与页之间不重不漏 ----------
  const ledgerPage1 = await expectOk(await request(baseUrl, jar, "/api/admin/ledger?page=1&pageSize=20"));
  const ledgerPage2 = await expectOk(await request(baseUrl, jar, "/api/admin/ledger?page=2&pageSize=20"));
  const ledgerPage3 = await expectOk(await request(baseUrl, jar, "/api/admin/ledger?page=3&pageSize=20"));
  assert.equal(ledgerPage2.page, 2);
  assert.equal(ledgerPage3.items.length, SEED - 40, "最后一页只剩零头");
  const ledgerIds = [...ledgerPage1.items, ...ledgerPage2.items, ...ledgerPage3.items].map((item) => item.id);
  assert.equal(new Set(ledgerIds).size, SEED, "三页拼起来正好是全部，不重不漏");
  // 倒序：第一页是最新的
  assert.equal(ledgerPage1.items[0].id, `seed-ledger-${SEED - 1}`);

  // ---------- 页码越界夹回最后一页，不给空白页 ----------
  const beyond = await expectOk(await request(baseUrl, jar, "/api/admin/orders?page=999&pageSize=20"));
  assert.equal(beyond.page, beyond.pageCount, "页码超范围要夹回最后一页");
  assert(beyond.items.length > 0, "夹回来之后必须有数据，不能是空白页");

  // ---------- pageSize 有上限，别让人一把拉全表 ----------
  const auditDefault = await expectOk(await request(baseUrl, jar, "/api/admin/generation-results"));
  assert.equal(auditDefault.pageSize, 15, "生成审计的默认页大小也是 15，翻页不能换成 20");
  assert.equal(auditDefault.items.length, 15);

  const huge = await expectOk(await request(baseUrl, jar, "/api/admin/generation-results?pageSize=5000"));
  assert.equal(huge.pageSize, 100, "pageSize 上限 100");
  assert.equal(huge.items.length, SEED);

  // ---------- 用户列表：搜索 + 筛选 ----------
  const searched = await expectOk(await request(baseUrl, jar, "/api/admin/users?q=%E7%A7%8D%E5%AD%90%E8%B4%A6%E5%8F%B7"));
  assert.equal(searched.total, SEED, "按显示名搜到的是全部种子账号");
  const literal = await expectOk(await request(baseUrl, jar, "/api/admin/users?q=a_b"));
  assert.equal(literal.total, 1, "LIKE 的下划线要当字面量，不能把 axb 也匹配进来");
  assert.equal(literal.items[0].name, "a_b 特殊名");

  const pending = await expectOk(await request(baseUrl, jar, "/api/admin/users?filter=pending"));
  assert.equal(pending.total, 1);
  assert.equal(pending.items[0].id, "seed-user-00");
  const locked = await expectOk(await request(baseUrl, jar, "/api/admin/users?filter=locked"));
  assert.equal(locked.total, 1);
  assert.equal(locked.items[0].id, "seed-user-01");

  // 搜索和翻页要能叠加
  const searchedPage2 = await expectOk(
    await request(baseUrl, jar, "/api/admin/users?q=%E7%A7%8D%E5%AD%90%E8%B4%A6%E5%8F%B7&page=2&pageSize=20"),
  );
  assert.equal(searchedPage2.page, 2);
  assert.equal(searchedPage2.total, SEED);
  assert.equal(searchedPage2.items.length, 20);

  // 用量还是要带上（分页之后是按当页账号单独算的，不能算丢）
  const withUsage = await expectOk(await request(baseUrl, jar, "/api/admin/users?q=admin"));
  assert.equal(withUsage.items[0].usage.taskCount, SEED, "admin 名下 45 条任务要照常统计出来");

  // ---------- 文件管理：账号自己的成片也分页 ----------
  const storage = await expectOk(await request(baseUrl, jar, "/api/me/storage"));
  assert.equal(storage.results.length, 24, "文件管理一页 24 张");
  assert.equal(storage.resultsPagination.total, SEED);
  const storagePage2 = await expectOk(await request(baseUrl, jar, "/api/me/storage?page=2"));
  assert.equal(storagePage2.results.length, SEED - 24);
  assert.equal(storage.overview.active, SEED, "概览里的数字是全量口径，不跟着分页走");

  // ---------- 非管理员一律挡掉 ----------
  const otherJar = new Map();
  await expectOk(
    await request(baseUrl, otherJar, "/api/auth/sign-up/email", {
      method: "POST",
      ...jsonBody({ name: "Plain User", email: "plain@example.test", password: "clothdesign123" }),
    }),
  );
  for (const route of ["/api/admin/users", "/api/admin/orders", "/api/admin/payment-events", "/api/admin/ledger", "/api/admin/generation-results"]) {
    const denied = await request(baseUrl, otherJar, route);
    assert.equal(denied.status, 403, `${route} 必须只有管理员能看`);
  }
} finally {
  app.kill("SIGTERM");
  await new Promise((resolve) => app.once("exit", resolve));
  await fs.rm(tmpDir, { recursive: true, force: true });
}

console.log(JSON.stringify({ checks: "passed" }, null, 2));
