import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "clothdesign-payments-"));
process.env.DATABASE_URL = `file:${path.join(tmpDir, "test.db")}`;
process.env.PAYMENT_DEMO_MODE = "true";

const { migrateBusinessDatabase, nowIso, sqlite } = await import("../server/db.mjs");
const {
  assertPaymentProductionReady,
  adjustCredits,
  consumeCredits,
  createPaymentOrder,
  markOrderPaid,
  paymentCapabilities,
  paymentConfigStatus,
  refundCredits,
} = await import("../server/payments.mjs");

migrateBusinessDatabase();

let configStatus = paymentConfigStatus();
assert.equal(configStatus.alipay.ready, false);
assert.equal(configStatus.wechat.ready, false);
assert(configStatus.alipay.missing.includes("ALIPAY_APP_ID"));
assert(configStatus.wechat.missing.includes("WECHAT_MCH_ID"));
process.env.PAYMENT_DEMO_MODE = "false";
assert.throws(() => assertPaymentProductionReady(), /支付生产配置不完整/);

const fakeSecretPath = path.join(tmpDir, "fake.pem");
await fs.writeFile(fakeSecretPath, "fake-key");
Object.assign(process.env, {
  ALIPAY_APP_ID: "app-id",
  ALIPAY_PRIVATE_KEY_PATH: fakeSecretPath,
  ALIPAY_PUBLIC_KEY_PATH: fakeSecretPath,
  ALIPAY_NOTIFY_URL: "https://example.test/api/payments/alipay/notify",
  WECHAT_APP_ID: "wx-app-id",
  WECHAT_MCH_ID: "mch-id",
  WECHAT_MCH_SERIAL_NO: "serial",
  WECHAT_PRIVATE_KEY_PATH: fakeSecretPath,
  WECHAT_API_V3_KEY: "12345678901234567890123456789012",
  WECHAT_PAY_PUBLIC_KEY_PATH: fakeSecretPath,
  WECHAT_NOTIFY_URL: "https://example.test/api/payments/wechat/notify",
});
configStatus = paymentConfigStatus();
assert.equal(configStatus.alipay.ready, true);
assert.equal(configStatus.wechat.ready, true);
assert.doesNotThrow(() => assertPaymentProductionReady());
process.env.PAYMENT_DEMO_MODE = "true";

const userId = "u-test";
sqlite
  .prepare(
    `INSERT INTO user_profile
      (user_id, display_name, role, plan, credits, monthly_used, status, created_at, updated_at)
     VALUES (?, '测试用户', 'owner', '测试版', 0, 0, 'active', ?, ?)`,
  )
  .run(userId, nowIso(), nowIso());

const firstOrder = await createPaymentOrder({ userId, packageId: "pkg-1", provider: "alipay" });
assert.equal(firstOrder.status, "pending");
assert.equal(firstOrder.amount_cents, 9900);

let paid = markOrderPaid({
  orderId: firstOrder.id,
  provider: "alipay",
  transactionId: "txn-1",
  amountCents: 9900,
  payload: { out_trade_no: firstOrder.id, trade_no: "txn-1" },
});
assert.equal(paid.duplicate, false);
assert.equal(sqlite.prepare("SELECT credits FROM user_profile WHERE user_id = ?").get(userId).credits, 300);
assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM credit_ledger WHERE order_id = ? AND kind = 'recharge'").get(firstOrder.id).count, 1);

paid = markOrderPaid({
  orderId: firstOrder.id,
  provider: "alipay",
  transactionId: "txn-1",
  amountCents: 9900,
  payload: { out_trade_no: firstOrder.id, trade_no: "txn-1" },
});
assert.equal(paid.duplicate, true);
assert.equal(sqlite.prepare("SELECT credits FROM user_profile WHERE user_id = ?").get(userId).credits, 300);
assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM credit_ledger WHERE order_id = ? AND kind = 'recharge'").get(firstOrder.id).count, 1);

const secondOrder = await createPaymentOrder({ userId, packageId: "pkg-1", provider: "wechat" });
assert.throws(
  () =>
    markOrderPaid({
      orderId: secondOrder.id,
      provider: "wechat",
      transactionId: "txn-bad-amount",
      amountCents: 1,
      payload: { resource: { out_trade_no: secondOrder.id } },
    }),
  /支付金额不匹配/,
);
assert.equal(sqlite.prepare("SELECT status FROM payment_order WHERE id = ?").get(secondOrder.id).status, "pending");
assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM payment_event WHERE order_id = ?").get(secondOrder.id).count, 0);

markOrderPaid({
  orderId: secondOrder.id,
  provider: "wechat",
  transactionId: "txn-2",
  amountCents: 9900,
  payload: { resource: { out_trade_no: secondOrder.id } },
});
assert.equal(sqlite.prepare("SELECT credits FROM user_profile WHERE user_id = ?").get(userId).credits, 600);

const { completeDemoOrder } = await import("../server/payments.mjs");
const thirdOrder = await createPaymentOrder({ userId, packageId: "pkg-1", provider: "alipay" });
process.env.NODE_ENV = "production";
delete process.env.ALLOW_PAYMENT_DEMO_API;
let capabilities = paymentCapabilities();
assert.equal(capabilities.alipay.demoCompleteAllowed, false);
assert.equal(capabilities.wechat.demoCompleteAllowed, false);
await assert.rejects(() => completeDemoOrder(thirdOrder.id, userId), /生产环境禁止使用模拟支付接口/);
process.env.ALLOW_PAYMENT_DEMO_API = "true";
capabilities = paymentCapabilities();
assert.equal(capabilities.alipay.demoCompleteAllowed, true);
assert.equal(capabilities.wechat.demoCompleteAllowed, true);
delete process.env.ALLOW_PAYMENT_DEMO_API;
process.env.NODE_ENV = "test";

consumeCredits({ userId, taskId: "task-1", amount: 50, reason: "测试扣费" });
let profile = sqlite.prepare("SELECT credits, monthly_used FROM user_profile WHERE user_id = ?").get(userId);
assert.equal(profile.credits, 550);
assert.equal(profile.monthly_used, 50);

assert.throws(() => consumeCredits({ userId, taskId: "task-2", amount: 99999, reason: "余额不足" }), /积分余额不足/);
profile = sqlite.prepare("SELECT credits, monthly_used FROM user_profile WHERE user_id = ?").get(userId);
assert.equal(profile.credits, 550);
assert.equal(profile.monthly_used, 50);

refundCredits({ userId, taskId: "task-1", amount: 25, reason: "测试退款" });
assert.equal(sqlite.prepare("SELECT credits FROM user_profile WHERE user_id = ?").get(userId).credits, 575);

const balanceAfter = adjustCredits({ userId, amount: -75, reason: "人工调分测试", actorUserId: userId });
assert.equal(balanceAfter, 500);
assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM audit_log WHERE action = 'credits.adjust'").get().count, 1);

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const wechatPrivateKeyPath = path.join(tmpDir, "wechat-private.pem");
const wechatPublicKeyPath = path.join(tmpDir, "wechat-public.pem");
await fs.writeFile(wechatPrivateKeyPath, privateKey.export({ type: "pkcs8", format: "pem" }));
await fs.writeFile(wechatPublicKeyPath, publicKey.export({ type: "spki", format: "pem" }));
Object.assign(process.env, {
  PAYMENT_DEMO_MODE: "false",
  PAYMENT_REQUEST_TIMEOUT_MS: "100",
  WECHAT_PRIVATE_KEY_PATH: wechatPrivateKeyPath,
  WECHAT_PAY_PUBLIC_KEY_PATH: wechatPublicKeyPath,
});
const originalFetch = globalThis.fetch;
globalThis.fetch = async (_url, init = {}) =>
  new Promise((_, reject) => {
    init.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
  });
await assert.rejects(() => createPaymentOrder({ userId, packageId: "pkg-1", provider: "wechat" }), /微信支付请求超时/);
globalThis.fetch = originalFetch;
process.env.PAYMENT_DEMO_MODE = "true";
delete process.env.PAYMENT_REQUEST_TIMEOUT_MS;

sqlite.close();
await fs.rm(tmpDir, { recursive: true, force: true });

console.log(JSON.stringify({ checks: "passed" }, null, 2));
