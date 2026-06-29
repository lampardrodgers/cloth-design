import { AlipaySdk } from "alipay-sdk";
import QRCode from "qrcode";
import crypto from "node:crypto";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { nowIso, runTransaction, sqlite } from "./db.mjs";
import { fetchWithTimeout, promiseWithTimeout, timeoutMsFromEnv } from "./timeouts.mjs";

const orderTtlMs = 15 * 60 * 1000;

function env(name) {
  return process.env[name]?.trim() || "";
}

function readSecretFile(filePath) {
  if (!filePath) return "";
  return fs.readFileSync(filePath, "utf8");
}

function configuredFile(name) {
  const value = env(name);
  return Boolean(value && fs.existsSync(value));
}

function configuredInlineOrFile(inlineName, fileName) {
  return Boolean(env(inlineName) || configuredFile(fileName));
}

function isHttpsUrl(value) {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

function providerRequirements(provider) {
  if (provider === "alipay") {
    return [
      { name: "ALIPAY_APP_ID", ok: Boolean(env("ALIPAY_APP_ID")) },
      { name: "ALIPAY_PRIVATE_KEY_PATH", ok: configuredFile("ALIPAY_PRIVATE_KEY_PATH") },
      { name: "ALIPAY_PUBLIC_KEY_PATH or ALIPAY_ALIPAY_PUBLIC_KEY", ok: configuredInlineOrFile("ALIPAY_ALIPAY_PUBLIC_KEY", "ALIPAY_PUBLIC_KEY_PATH") },
      { name: "ALIPAY_NOTIFY_URL", ok: isHttpsUrl(env("ALIPAY_NOTIFY_URL")) },
    ];
  }
  if (provider === "wechat") {
    return [
      { name: "WECHAT_APP_ID", ok: Boolean(env("WECHAT_APP_ID")) },
      { name: "WECHAT_MCH_ID", ok: Boolean(env("WECHAT_MCH_ID")) },
      { name: "WECHAT_MCH_SERIAL_NO", ok: Boolean(env("WECHAT_MCH_SERIAL_NO")) },
      { name: "WECHAT_PRIVATE_KEY_PATH", ok: configuredFile("WECHAT_PRIVATE_KEY_PATH") },
      { name: "WECHAT_API_V3_KEY", ok: env("WECHAT_API_V3_KEY").length === 32 },
      { name: "WECHAT_PAY_PUBLIC_KEY_PATH or WECHAT_PAY_PUBLIC_KEY", ok: configuredInlineOrFile("WECHAT_PAY_PUBLIC_KEY", "WECHAT_PAY_PUBLIC_KEY_PATH") },
      { name: "WECHAT_NOTIFY_URL", ok: isHttpsUrl(env("WECHAT_NOTIFY_URL")) },
    ];
  }
  return [];
}

export function paymentConfigStatus() {
  return Object.fromEntries(
    ["alipay", "wechat"].map((provider) => {
      const requirements = providerRequirements(provider);
      const missing = requirements.filter((item) => !item.ok).map((item) => item.name);
      const demoMode = isPaymentDemoMode(provider);
      return [
        provider,
        {
          provider,
          enabled: true,
          demoMode,
          ready: missing.length === 0,
          missing,
        },
      ];
    }),
  );
}

export function assertPaymentProductionReady() {
  if (process.env.PAYMENT_DEMO_MODE !== "false") return;
  const requiredProviders = String(process.env.PAYMENT_REQUIRED_PROVIDERS || "alipay,wechat")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  const status = paymentConfigStatus();
  const failures = requiredProviders.flatMap((provider) =>
    status[provider]?.ready ? [] : [`${provider}: ${(status[provider]?.missing || ["unknown"]).join(", ")}`],
  );
  if (failures.length > 0) {
    throw new Error(`支付生产配置不完整，无法关闭演示模式: ${failures.join("; ")}`);
  }
}

export function isPaymentDemoMode(provider) {
  if (process.env.PAYMENT_DEMO_MODE === "true") return true;
  if (process.env.PAYMENT_DEMO_MODE === "false") return false;
  if (provider === "alipay") {
    return !(env("ALIPAY_APP_ID") && env("ALIPAY_PRIVATE_KEY_PATH") && (env("ALIPAY_PUBLIC_KEY_PATH") || env("ALIPAY_ALIPAY_PUBLIC_KEY")));
  }
  if (provider === "wechat") {
    return !(
      env("WECHAT_APP_ID") &&
      env("WECHAT_MCH_ID") &&
      env("WECHAT_MCH_SERIAL_NO") &&
      env("WECHAT_PRIVATE_KEY_PATH") &&
      env("WECHAT_API_V3_KEY") &&
      (env("WECHAT_PAY_PUBLIC_KEY_PATH") || env("WECHAT_PAY_PUBLIC_KEY"))
    );
  }
  return true;
}

export function paymentCapabilities() {
  const status = paymentConfigStatus();
  const demoCompleteAllowed = process.env.NODE_ENV !== "production" || process.env.ALLOW_PAYMENT_DEMO_API === "true";
  return {
    alipay: { enabled: true, demoMode: status.alipay.demoMode, demoCompleteAllowed: status.alipay.demoMode && demoCompleteAllowed, ready: status.alipay.ready },
    wechat: { enabled: true, demoMode: status.wechat.demoMode, demoCompleteAllowed: status.wechat.demoMode && demoCompleteAllowed, ready: status.wechat.ready },
  };
}

function nextOrderId() {
  return `CD${Date.now().toString(36).toUpperCase()}${crypto.randomBytes(4).toString("hex").toUpperCase()}`;
}

function amountYuan(amountCents) {
  return (amountCents / 100).toFixed(2);
}

function paymentRequestTimeoutMs() {
  return timeoutMsFromEnv("PAYMENT_REQUEST_TIMEOUT_MS", 30000);
}

async function qrDataUrl(content) {
  return QRCode.toDataURL(content, {
    errorCorrectionLevel: "M",
    margin: 1,
    width: 220,
  });
}

function alipaySdk() {
  const alipayPublicKey = env("ALIPAY_ALIPAY_PUBLIC_KEY") || readSecretFile(env("ALIPAY_PUBLIC_KEY_PATH"));
  return new AlipaySdk({
    appId: env("ALIPAY_APP_ID"),
    privateKey: readSecretFile(env("ALIPAY_PRIVATE_KEY_PATH")),
    alipayPublicKey,
    gateway: env("ALIPAY_GATEWAY") || "https://openapi.alipay.com/gateway.do",
  });
}

async function createAlipayOrder({ orderId, amountCents, subject }) {
  if (isPaymentDemoMode("alipay")) {
    return `clothdesign://demo-pay/alipay/${orderId}`;
  }

  const sdk = alipaySdk();
  const result = await promiseWithTimeout(
    sdk.exec("alipay.trade.precreate", {
      notify_url: env("ALIPAY_NOTIFY_URL"),
      bizContent: {
        out_trade_no: orderId,
        total_amount: amountYuan(amountCents),
        subject,
        timeout_express: "15m",
      },
    }),
    { timeoutMs: paymentRequestTimeoutMs(), timeoutMessage: "支付宝预下单超时。" },
  );
  const response = result.alipay_trade_precreate_response || result.alipayTradePrecreateResponse || result;
  if (response.code !== "10000" || !response.qr_code) {
    throw new Error(`支付宝预下单失败: ${response.sub_msg || response.msg || "unknown"}`);
  }
  return response.qr_code;
}

function wechatPrivateKey() {
  return readSecretFile(env("WECHAT_PRIVATE_KEY_PATH"));
}

function wechatPublicKey() {
  return env("WECHAT_PAY_PUBLIC_KEY") || readSecretFile(env("WECHAT_PAY_PUBLIC_KEY_PATH"));
}

function signWechatMessage(message) {
  return crypto.createSign("RSA-SHA256").update(message).sign(wechatPrivateKey(), "base64");
}

function verifyWechatMessage(message, signature) {
  return crypto.createVerify("RSA-SHA256").update(message).verify(wechatPublicKey(), signature, "base64");
}

function wechatAuthorization(method, pathAndQuery, body) {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const nonce = crypto.randomBytes(16).toString("hex");
  const message = `${method}\n${pathAndQuery}\n${timestamp}\n${nonce}\n${body}\n`;
  const signature = signWechatMessage(message);
  const schema = "WECHATPAY2-SHA256-RSA2048";
  return `${schema} mchid="${env("WECHAT_MCH_ID")}",nonce_str="${nonce}",timestamp="${timestamp}",serial_no="${env(
    "WECHAT_MCH_SERIAL_NO",
  )}",signature="${signature}"`;
}

async function wechatRequest(method, pathAndQuery, payload) {
  const body = payload ? JSON.stringify(payload) : "";
  const response = await fetchWithTimeout(
    `https://api.mch.weixin.qq.com${pathAndQuery}`,
    {
      method,
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        Authorization: wechatAuthorization(method, pathAndQuery, body),
      },
      body: body || undefined,
    },
    { timeoutMs: paymentRequestTimeoutMs(), timeoutMessage: "微信支付请求超时。" },
  );
  const text = await response.text();
  const data = text ? JSON.parse(text) : {};
  if (!response.ok) {
    throw new Error(`微信支付请求失败: ${response.status} ${data.message || text}`);
  }
  return data;
}

async function createWechatOrder({ orderId, amountCents, subject }) {
  if (isPaymentDemoMode("wechat")) {
    return `clothdesign://demo-pay/wechat/${orderId}`;
  }
  const payload = {
    appid: env("WECHAT_APP_ID"),
    mchid: env("WECHAT_MCH_ID"),
    description: subject,
    out_trade_no: orderId,
    notify_url: env("WECHAT_NOTIFY_URL"),
    amount: { total: amountCents, currency: "CNY" },
  };
  const data = await wechatRequest("POST", "/v3/pay/transactions/native", payload);
  if (!data.code_url) {
    throw new Error("微信支付未返回 code_url。");
  }
  return data.code_url;
}

export async function createPaymentOrder({ userId, packageId, provider }) {
  if (!["alipay", "wechat"].includes(provider)) {
    throw new Error("不支持的支付方式。");
  }
  const pkg = sqlite.prepare("SELECT * FROM recharge_package WHERE id = ? AND enabled = 1").get(packageId);
  if (!pkg) {
    throw new Error("充值套餐不存在或已下架。");
  }

  const orderId = nextOrderId();
  const subject = `ClothDesign AI ${pkg.title}`;
  const expiresAt = new Date(Date.now() + orderTtlMs).toISOString();
  const qrCodeUrl =
    provider === "alipay"
      ? await createAlipayOrder({ orderId, amountCents: pkg.amount_cents, subject })
      : await createWechatOrder({ orderId, amountCents: pkg.amount_cents, subject });
  const qrCodeDataUrl = await qrDataUrl(qrCodeUrl);
  const timestamp = nowIso();

  sqlite
    .prepare(
      `INSERT INTO payment_order
        (id, user_id, package_id, provider, status, amount_cents, credits, subject, qr_code_url, qr_code_data_url, expires_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(orderId, userId, packageId, provider, pkg.amount_cents, pkg.credits, subject, qrCodeUrl, qrCodeDataUrl, expiresAt, timestamp, timestamp);

  return getPaymentOrder(orderId);
}

export function getPaymentOrder(orderId) {
  return sqlite.prepare("SELECT * FROM payment_order WHERE id = ?").get(orderId);
}

export function serializeOrder(row) {
  if (!row) return null;
  return {
    id: row.id,
    packageId: row.package_id,
    provider: row.provider,
    status: row.status,
    amountCents: row.amount_cents,
    credits: row.credits,
    subject: row.subject,
    qrCodeUrl: row.qr_code_url,
    qrCodeDataUrl: row.qr_code_data_url,
    expiresAt: row.expires_at,
    paidAt: row.paid_at,
    createdAt: row.created_at,
  };
}

export function serializeLedger(row) {
  return {
    id: row.id,
    userId: row.user_id,
    orderId: row.order_id,
    taskId: row.task_id,
    kind: row.kind,
    amount: row.amount,
    balanceAfter: row.balance_after,
    reason: row.reason,
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}

function insertPaymentEvent({ provider, eventKey, orderId, transactionId, payload, processed }) {
  const timestamp = nowIso();
  sqlite
    .prepare(
      `INSERT OR IGNORE INTO payment_event
        (id, provider, event_key, order_id, transaction_id, processed, payload, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(randomUUID(), provider, eventKey, orderId, transactionId || null, processed ? 1 : 0, JSON.stringify(payload), timestamp);
  return sqlite.prepare("SELECT changes() AS changes").get().changes > 0;
}

function addCreditLedger({ userId, orderId, taskId = null, kind, amount, reason, createdBy = null }) {
  const profile = sqlite.prepare("SELECT credits FROM user_profile WHERE user_id = ?").get(userId);
  if (!profile) throw new Error("用户不存在。");
  const balanceAfter = profile.credits + amount;
  if (balanceAfter < 0) throw new Error("积分余额不足。");
  const timestamp = nowIso();

  sqlite.prepare("UPDATE user_profile SET credits = ?, monthly_used = monthly_used + ?, updated_at = ? WHERE user_id = ?").run(
    balanceAfter,
    kind === "consume" ? Math.abs(amount) : 0,
    timestamp,
    userId,
  );
  sqlite
    .prepare(
      `INSERT INTO credit_ledger
        (id, user_id, order_id, task_id, kind, amount, balance_after, reason, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(randomUUID(), userId, orderId, taskId, kind, amount, balanceAfter, reason, createdBy, timestamp);
  return balanceAfter;
}

export function adjustCredits({ userId, amount, reason, actorUserId }) {
  return runTransaction(() => {
    const balanceAfter = addCreditLedger({
      userId,
      kind: "admin_adjust",
      amount,
      reason,
      createdBy: actorUserId,
    });
    sqlite
      .prepare(
        `INSERT INTO audit_log (id, actor_user_id, action, target_type, target_id, detail_json, created_at)
         VALUES (?, ?, 'credits.adjust', 'user', ?, ?, ?)`,
      )
      .run(randomUUID(), actorUserId, userId, JSON.stringify({ amount, reason, balanceAfter }), nowIso());
    return balanceAfter;
  });
}

export function consumeCredits({ userId, taskId, amount, reason }) {
  return runTransaction(() =>
    addCreditLedger({
      userId,
      taskId,
      kind: "consume",
      amount: -Math.abs(amount),
      reason,
    }),
  );
}

export function refundCredits({ userId, taskId, amount, reason }) {
  return runTransaction(() =>
    addCreditLedger({
      userId,
      taskId,
      kind: "refund",
      amount: Math.abs(amount),
      reason,
    }),
  );
}

export function markOrderPaid({ orderId, provider, transactionId, amountCents, payload }) {
  return runTransaction(() => {
    const order = sqlite.prepare("SELECT * FROM payment_order WHERE id = ?").get(orderId);
    const eventKey = `${orderId}:${transactionId || "unknown"}`;
    if (!order) throw new Error("订单不存在。");
    if (order.provider !== provider) throw new Error("支付渠道不匹配。");
    if (order.amount_cents !== amountCents) throw new Error("支付金额不匹配。");

    const inserted = insertPaymentEvent({
      provider,
      eventKey,
      orderId,
      transactionId,
      payload,
      processed: order.status === "paid",
    });
    if (!inserted) return { duplicate: true, order };
    if (order.status === "paid") return { duplicate: true, order };
    if (order.status !== "pending") throw new Error(`订单状态不可入账: ${order.status}`);

    const timestamp = nowIso();
    sqlite
      .prepare(
        `UPDATE payment_order
         SET status = 'paid', provider_transaction_id = ?, paid_at = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(transactionId || null, timestamp, timestamp, orderId);
    const balanceAfter = addCreditLedger({
      userId: order.user_id,
      orderId,
      kind: "recharge",
      amount: order.credits,
      reason: `${order.subject} 支付成功`,
    });
    sqlite.prepare("UPDATE payment_event SET processed = 1 WHERE provider = ? AND event_key = ?").run(provider, eventKey);
    return { duplicate: false, order: getPaymentOrder(orderId), balanceAfter };
  });
}

export function markExpiredOrdersClosed() {
  sqlite
    .prepare("UPDATE payment_order SET status = 'closed', closed_at = ?, updated_at = ? WHERE status = 'pending' AND expires_at < ?")
    .run(nowIso(), nowIso(), nowIso());
}

export async function handleAlipayNotify(body) {
  if (!isPaymentDemoMode("alipay")) {
    const ok = alipaySdk().checkNotifySignV2(body);
    if (!ok) throw new Error("支付宝通知验签失败。");
  }
  if (!["TRADE_SUCCESS", "TRADE_FINISHED"].includes(body.trade_status)) {
    insertPaymentEvent({
      provider: "alipay",
      eventKey: `${body.out_trade_no || "unknown"}:${body.trade_no || body.trade_status || randomUUID()}`,
      orderId: body.out_trade_no || null,
      transactionId: body.trade_no || null,
      payload: body,
      processed: false,
    });
    return { ignored: true };
  }
  return markOrderPaid({
    orderId: body.out_trade_no,
    provider: "alipay",
    transactionId: body.trade_no,
    amountCents: Math.round(Number(body.total_amount) * 100),
    payload: body,
  });
}

function decryptWechatResource(resource) {
  const key = Buffer.from(env("WECHAT_API_V3_KEY"), "utf8");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, resource.nonce);
  decipher.setAuthTag(Buffer.from(resource.ciphertext, "base64").subarray(-16));
  decipher.setAAD(Buffer.from(resource.associated_data || "", "utf8"));
  const ciphertext = Buffer.from(resource.ciphertext, "base64").subarray(0, -16);
  const decoded = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  return JSON.parse(decoded);
}

export function verifyWechatNotify(headers, rawBody) {
  if (isPaymentDemoMode("wechat")) return true;
  const timestamp = headers["wechatpay-timestamp"];
  const nonce = headers["wechatpay-nonce"];
  const signature = headers["wechatpay-signature"];
  if (!timestamp || !nonce || !signature) return false;
  const message = `${timestamp}\n${nonce}\n${rawBody}\n`;
  return verifyWechatMessage(message, signature);
}

export async function handleWechatNotify(headers, rawBody) {
  if (!verifyWechatNotify(headers, rawBody)) {
    throw new Error("微信支付通知验签失败。");
  }
  const body = JSON.parse(rawBody);
  const data = isPaymentDemoMode("wechat") ? body.resource : decryptWechatResource(body.resource);
  if (data.trade_state !== "SUCCESS") {
    insertPaymentEvent({
      provider: "wechat",
      eventKey: `${data.out_trade_no || "unknown"}:${data.transaction_id || data.trade_state || randomUUID()}`,
      orderId: data.out_trade_no || null,
      transactionId: data.transaction_id || null,
      payload: body,
      processed: false,
    });
    return { ignored: true };
  }
  return markOrderPaid({
    orderId: data.out_trade_no,
    provider: "wechat",
    transactionId: data.transaction_id,
    amountCents: Number(data.amount?.total || 0),
    payload: body,
  });
}

export async function completeDemoOrder(orderId, actorUserId) {
  const order = getPaymentOrder(orderId);
  if (!order) throw new Error("订单不存在。");
  if (order.user_id !== actorUserId) throw new Error("只能完成自己的模拟订单。");
  if (!isPaymentDemoMode(order.provider)) throw new Error("真实支付模式下不能使用模拟支付。");
  if (process.env.NODE_ENV === "production" && process.env.ALLOW_PAYMENT_DEMO_API !== "true") {
    throw new Error("生产环境禁止使用模拟支付接口。");
  }
  return markOrderPaid({
    orderId,
    provider: order.provider,
    transactionId: `demo-${orderId}`,
    amountCents: order.amount_cents,
    payload: { demo: true, orderId, provider: order.provider },
  });
}
