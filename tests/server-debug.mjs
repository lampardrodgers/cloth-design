import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "clothdesign-debug-"));
process.env.DATABASE_URL = `file:${path.join(tmpDir, "test.db")}`;
process.env.NODE_ENV = "test";
delete process.env.DEBUG_UNLIMITED;

const { migrateBusinessDatabase, sqlite } = await import("../server/db.mjs");
const {
  DEBUG_UNLIMITED_CREDITS,
  DEBUG_USER_ID,
  DEBUG_USER_PREFIX,
  debugAccount,
  debugCookieHeader,
  debugSeatFromRequest,
  debugUnlimitedAvailable,
  debugUserIdFromRequest,
  debugUserIdFromSeat,
  hasDebugCookie,
  isDebugUserId,
  newDebugSeat,
} = await import("../server/debug.mjs");
const { consumeCredits, refundCredits } = await import("../server/payments.mjs");

migrateBusinessDatabase();
assert.equal(debugUnlimitedAvailable(), true);
assert.equal(hasDebugCookie({ headers: { cookie: "clothdesign_debug=1" } }), true);
assert.equal(hasDebugCookie({ headers: { cookie: "clothdesign_debug=0" } }), false);

const account = debugAccount();
assert.equal(account.user.id, DEBUG_USER_ID);
assert.equal(account.profile.credits, DEBUG_UNLIMITED_CREDITS);

consumeCredits({ userId: DEBUG_USER_ID, taskId: "debug-task", amount: 1000000, reason: "调试扣费" });
refundCredits({ userId: DEBUG_USER_ID, taskId: "debug-task", amount: 1000000, reason: "调试退款" });
assert.equal(sqlite.prepare("SELECT credits, monthly_used FROM user_profile WHERE user_id = ?").get(DEBUG_USER_ID).credits, DEBUG_UNLIMITED_CREDITS);
assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM credit_ledger WHERE user_id = ?").get(DEBUG_USER_ID).count, 0);

/* ── 每个调试座位是独立账号 ─────────────────────────────────────────────── */

const seatA = newDebugSeat();
const seatB = newDebugSeat();
assert.notEqual(seatA, seatB, "每次发的座位号必须不同，否则又变成共用一个账号");
assert.match(seatA, /^[a-f0-9]{12}$/);

const userA = debugUserIdFromSeat(seatA);
const userB = debugUserIdFromSeat(seatB);
assert.equal(userA, `${DEBUG_USER_PREFIX}${seatA}`);
assert.notEqual(userA, userB);
assert(isDebugUserId(userA) && isDebugUserId(userB), "座位账号也要认成调试账号，才能免扣积分");

// cookie 里的座位号要能读回来，且只认自己发的格式
assert.equal(debugSeatFromRequest({ headers: { cookie: `clothdesign_debug=${seatA}` } }), seatA);
assert.equal(debugUserIdFromRequest({ headers: { cookie: `clothdesign_debug=${seatA}` } }), userA);
assert.equal(debugUserIdFromRequest({ headers: { cookie: "clothdesign_debug=1" } }), DEBUG_USER_ID, "老 cookie 仍然能用");
assert.equal(debugUserIdFromRequest({ headers: { cookie: "clothdesign_debug=../../etc" } }), "", "手搓的座位号不认");
assert.equal(debugUserIdFromRequest({ headers: { cookie: "clothdesign_debug=zzzzzzzzzzzz" } }), "", "非十六进制不认");
assert.equal(debugUserIdFromRequest({ headers: {} }), "");

const a = debugAccount(userA);
const b = debugAccount(userB);
assert.equal(a.user.id, userA);
assert.notEqual(a.user.name, b.user.name, "两个座位在后台要能分辨出来");
assert(a.user.name.startsWith("开发调试 · "));
assert.equal(a.profile.credits, DEBUG_UNLIMITED_CREDITS);
assert.equal(a.profile.approved, 1, "调试座位不用再走管理员开通");
assert.equal(
  sqlite.prepare("SELECT COUNT(*) AS count FROM user_profile WHERE user_id LIKE ?").get(`${DEBUG_USER_PREFIX}%`).count,
  3,
  "共用账号 + 两个座位，各自一条 user_profile，成片和用量才分得开",
);

// 座位账号同样免扣积分
consumeCredits({ userId: userA, taskId: "seat-task", amount: 999, reason: "座位扣费" });
assert.equal(sqlite.prepare("SELECT credits FROM user_profile WHERE user_id = ?").get(userA).credits, DEBUG_UNLIMITED_CREDITS);

// cookie 有效期要够长，否则每天换一个新身份、看不到昨天的成片
const setCookie = debugCookieHeader({ seat: seatA });
assert(setCookie.includes(`clothdesign_debug=${seatA}`));
assert(setCookie.includes("HttpOnly"));
const maxAge = Number(setCookie.match(/Max-Age=(\d+)/)[1]);
assert(maxAge > 30 * 24 * 60 * 60, `Max-Age ${maxAge} 太短`);
assert.match(debugCookieHeader({ clear: true }), /Max-Age=0/);

/* ── 开关：显式打开时生产环境也可用 ─────────────────────────────────────── */

process.env.NODE_ENV = "production";
delete process.env.DEBUG_UNLIMITED;
assert.equal(debugUnlimitedAvailable(), false, "生产环境默认仍然关闭");
assert.equal(hasDebugCookie({ headers: { cookie: `clothdesign_debug=${seatA}` } }), false);

process.env.DEBUG_UNLIMITED = "true";
assert.equal(debugUnlimitedAvailable(), true, "内部部署显式打开后，NODE_ENV=production 也要能用");
assert.equal(debugUserIdFromRequest({ headers: { cookie: `clothdesign_debug=${seatA}` } }), userA);

process.env.DEBUG_UNLIMITED = "false";
process.env.NODE_ENV = "test";
assert.equal(debugUnlimitedAvailable(), false, "显式关闭的优先级最高");
delete process.env.DEBUG_UNLIMITED;

/* ── 接线 ────────────────────────────────────────────────────────────────── */

const api = await fs.readFile("server/api.mjs", "utf8");
assert(api.includes("debugSeatFromRequest(req) || newDebugSeat()"), "已有座位要沿用，别每次点都换新身份");
assert(api.includes("account.user.id === DEBUG_USER_ID"), "只有早期共用账号不能存 Key，独立座位可以");
const auth = await fs.readFile("server/auth.mjs", "utf8");
assert(auth.includes("debugUserIdFromRequest(req)") && auth.includes("debugAccount(debugUserId)"), "登录旁路要按座位取账号");

sqlite.close();
await fs.rm(tmpDir, { recursive: true, force: true });

console.log(JSON.stringify({ checks: "passed" }, null, 2));
