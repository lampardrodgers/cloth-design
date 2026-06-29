import { randomUUID } from "node:crypto";
import { requireAccount, requireAdmin } from "./auth.mjs";
import { nowIso, sqlite } from "./db.mjs";
import { deleteManagedGeneratedImage } from "./image-provider.mjs";
import {
  adjustCredits,
  completeDemoOrder,
  createPaymentOrder,
  getPaymentOrder,
  markExpiredOrdersClosed,
  paymentCapabilities,
  paymentConfigStatus,
  serializeLedger,
  serializeOrder,
} from "./payments.mjs";

export function serializeAccount(user, profile) {
  return {
    id: user.id,
    email: user.email,
    name: profile.display_name || user.name || user.email,
    role: profile.role,
    plan: profile.plan,
    credits: profile.credits,
    monthlyUsed: profile.monthly_used,
    status: profile.status,
  };
}

function serializePackage(row) {
  return {
    id: row.id,
    title: row.title,
    credits: row.credits,
    price: row.amount_cents / 100,
    amountCents: row.amount_cents,
    badge: row.badge,
    enabled: Boolean(row.enabled),
    sortOrder: row.sort_order,
  };
}

function recentOrdersForUser(userId) {
  return sqlite
    .prepare("SELECT * FROM payment_order WHERE user_id = ? ORDER BY created_at DESC LIMIT 12")
    .all(userId)
    .map(serializeOrder);
}

function recentLedgerForUser(userId) {
  return sqlite
    .prepare("SELECT * FROM credit_ledger WHERE user_id = ? ORDER BY created_at DESC LIMIT 20")
    .all(userId)
    .map(serializeLedger);
}

function parseJson(value) {
  try {
    return JSON.parse(value || "{}");
  } catch {
    return {};
  }
}

function serializeGeneratedResult(row) {
  const metadata = parseJson(row.metadata_json);
  return {
    id: row.id,
    taskId: row.task_id,
    userId: row.user_id,
    userEmail: row.user_email,
    userName: row.user_name,
    title: row.title,
    mode: row.mode,
    ratioLabel: row.ratio_label,
    storageStatus: row.storage_status,
    credits: row.credits,
    imageUrl: row.image_url,
    imageInspection: metadata.imageInspection || null,
    qualityGate: metadata.qualityGate || null,
    revisedPrompt: metadata.revisedPrompt || null,
    metadata,
    createdAt: row.created_at,
  };
}

function recentGeneratedResultsForUser(userId) {
  return sqlite
    .prepare("SELECT * FROM generated_result WHERE user_id = ? ORDER BY created_at DESC LIMIT 20")
    .all(userId)
    .map(serializeGeneratedResult);
}

function recentGeneratedResultsForAdmin() {
  return sqlite
    .prepare(
      `SELECT r.*, u.email AS user_email, p.display_name AS user_name
       FROM generated_result r
       LEFT JOIN "user" u ON u.id = r.user_id
       LEFT JOIN user_profile p ON p.user_id = r.user_id
       ORDER BY r.created_at DESC
       LIMIT 80`,
    )
    .all()
    .map(serializeGeneratedResult);
}

function generatedImageReferenceCount(imageUrl) {
  const generated = sqlite
    .prepare("SELECT COUNT(*) AS count FROM generated_result WHERE image_url = ?")
    .get(imageUrl).count;
  const workflow = sqlite
    .prepare("SELECT COUNT(*) AS count FROM workflow_result WHERE image_url = ?")
    .get(imageUrl).count;
  const workflowAssets = sqlite
    .prepare("SELECT COUNT(*) AS count FROM workflow_asset WHERE source_url = ?")
    .get(imageUrl).count;
  return generated + workflow + workflowAssets;
}

function getEnabledPackages() {
  return sqlite
    .prepare("SELECT * FROM recharge_package WHERE enabled = 1 ORDER BY sort_order ASC, amount_cents ASC")
    .all()
    .map(serializePackage);
}

function getAllPackages() {
  return sqlite
    .prepare("SELECT * FROM recharge_package ORDER BY sort_order ASC, amount_cents ASC")
    .all()
    .map(serializePackage);
}

function getProfileWithUser(userId) {
  return sqlite
    .prepare(
      `SELECT p.*, u.email, u.name
       FROM user_profile p
       LEFT JOIN "user" u ON u.id = p.user_id
       WHERE p.user_id = ?`,
    )
    .get(userId);
}

function serializeAdminUser(row) {
  return {
    id: row.user_id,
    email: row.email,
    name: row.display_name || row.name || row.email,
    role: row.role,
    plan: row.plan,
    credits: row.credits,
    monthlyUsed: row.monthly_used,
    status: row.status,
    createdAt: row.created_at,
  };
}

function insertAudit({ actorUserId, action, targetType, targetId, detail }) {
  sqlite
    .prepare(
      `INSERT INTO audit_log (id, actor_user_id, action, target_type, target_id, detail_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(randomUUID(), actorUserId, action, targetType, targetId, JSON.stringify(detail || {}), nowIso());
}

export function registerBusinessRoutes(app) {
  app.get("/api/me", async (req, res) => {
    const account = await requireAccount(req, res);
    if (!account) return;
    markExpiredOrdersClosed();
    const profile = getProfileWithUser(account.user.id);
    res.json({
      account: serializeAccount(account.user, profile),
      packages: getEnabledPackages(),
      orders: recentOrdersForUser(account.user.id),
      ledger: recentLedgerForUser(account.user.id),
      generationResults: recentGeneratedResultsForUser(account.user.id),
      paymentCapabilities: paymentCapabilities(),
      paymentConfig: paymentConfigStatus(),
    });
  });

  app.get("/api/admin/payment-config", async (req, res) => {
    const account = await requireAdmin(req, res);
    if (!account) return;
    res.json({ paymentCapabilities: paymentCapabilities(), paymentConfig: paymentConfigStatus() });
  });

  app.get("/api/packages", (_req, res) => {
    res.json({ packages: getEnabledPackages(), paymentCapabilities: paymentCapabilities() });
  });

  app.patch("/api/generation-results/:id/storage-status", async (req, res) => {
    try {
      const account = await requireAccount(req, res);
      if (!account) return;
      const allowedStatuses = new Set(["local-cache", "cloud-temp", "webdav", "expired"]);
      const storageStatus = String(req.body.storageStatus || "");
      if (!allowedStatuses.has(storageStatus)) {
        res.status(400).json({ error: "不支持的存储状态。" });
        return;
      }
      const result = sqlite.prepare("SELECT * FROM generated_result WHERE id = ?").get(req.params.id);
      const canUpdate = result && (result.user_id === account.user.id || ["owner", "admin"].includes(account.profile.role));
      if (!canUpdate) {
        res.status(404).json({ error: "生成结果不存在。" });
        return;
      }
      sqlite.prepare("UPDATE generated_result SET storage_status = ? WHERE id = ?").run(storageStatus, result.id);
      insertAudit({
        actorUserId: account.user.id,
        action: "generation_result.storage_status",
        targetType: "generated_result",
        targetId: result.id,
        detail: { from: result.storage_status, to: storageStatus },
      });
      res.json({
        result: serializeGeneratedResult(sqlite.prepare("SELECT * FROM generated_result WHERE id = ?").get(result.id)),
      });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : "更新生成结果存储状态失败。" });
    }
  });

  app.delete("/api/generation-results/:id", async (req, res) => {
    try {
      const account = await requireAccount(req, res);
      if (!account) return;
      const result = sqlite.prepare("SELECT * FROM generated_result WHERE id = ?").get(req.params.id);
      const canDelete = result && (result.user_id === account.user.id || ["owner", "admin"].includes(account.profile.role));
      if (!canDelete) {
        res.status(404).json({ error: "生成结果不存在。" });
        return;
      }
      sqlite.prepare("DELETE FROM generated_result WHERE id = ?").run(result.id);
      const file = generatedImageReferenceCount(result.image_url) === 0 ? await deleteManagedGeneratedImage(result.image_url) : null;
      insertAudit({
        actorUserId: account.user.id,
        action: "generation_result.delete",
        targetType: "generated_result",
        targetId: result.id,
        detail: { imageUrl: result.image_url, file },
      });
      res.json({ deleted: true, id: result.id, file });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : "删除生成结果失败。" });
    }
  });

  app.post("/api/payments/orders", async (req, res) => {
    try {
      const account = await requireAccount(req, res);
      if (!account) return;
      const order = await createPaymentOrder({
        userId: account.user.id,
        packageId: String(req.body.packageId || ""),
        provider: String(req.body.provider || ""),
      });
      res.status(201).json({ order: serializeOrder(order), paymentCapabilities: paymentCapabilities() });
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : "创建支付订单失败。" });
    }
  });

  app.get("/api/payments/orders/:id", async (req, res) => {
    const account = await requireAccount(req, res);
    if (!account) return;
    markExpiredOrdersClosed();
    const order = getPaymentOrder(req.params.id);
    if (!order) {
      res.status(404).json({ error: "订单不存在。" });
      return;
    }
    if (order.user_id !== account.user.id && !["owner", "admin"].includes(account.profile.role)) {
      res.status(403).json({ error: "不能查看该订单。" });
      return;
    }
    const profile = getProfileWithUser(account.user.id);
    res.json({
      order: serializeOrder(order),
      account: serializeAccount(account.user, profile),
      ledger: recentLedgerForUser(account.user.id),
    });
  });

  app.post("/api/test/payments/:id/complete", async (req, res) => {
    try {
      const account = await requireAccount(req, res);
      if (!account) return;
      const result = await completeDemoOrder(req.params.id, account.user.id);
      const profile = getProfileWithUser(account.user.id);
      res.json({
        order: serializeOrder(result.order),
        account: serializeAccount(account.user, profile),
        ledger: recentLedgerForUser(account.user.id),
      });
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : "模拟支付失败。" });
    }
  });

  app.get("/api/admin/overview", async (req, res) => {
    const account = await requireAdmin(req, res);
    if (!account) return;
    markExpiredOrdersClosed();
    const users = sqlite
      .prepare(
        `SELECT p.*, u.email, u.name
         FROM user_profile p
         LEFT JOIN "user" u ON u.id = p.user_id
         ORDER BY p.created_at ASC`,
      )
      .all()
      .map(serializeAdminUser);
    const orders = sqlite.prepare("SELECT * FROM payment_order ORDER BY created_at DESC LIMIT 80").all().map(serializeOrder);
    const paymentEvents = sqlite
      .prepare("SELECT * FROM payment_event ORDER BY created_at DESC LIMIT 80")
      .all()
      .map((row) => ({
        id: row.id,
        provider: row.provider,
        eventKey: row.event_key,
        orderId: row.order_id,
        transactionId: row.transaction_id,
        processed: Boolean(row.processed),
        createdAt: row.created_at,
      }));
    const ledger = sqlite.prepare("SELECT * FROM credit_ledger ORDER BY created_at DESC LIMIT 80").all().map(serializeLedger);
    res.json({
      users,
      packages: getAllPackages(),
      orders,
      paymentEvents,
      ledger,
      generationResults: recentGeneratedResultsForAdmin(),
      paymentCapabilities: paymentCapabilities(),
      paymentConfig: paymentConfigStatus(),
    });
  });

  app.patch("/api/admin/users/:id", async (req, res) => {
    const account = await requireAdmin(req, res);
    if (!account) return;
    const allowedRoles = new Set(["owner", "admin", "user"]);
    const allowedStatus = new Set(["active", "locked"]);
    const current = getProfileWithUser(req.params.id);
    if (!current) {
      res.status(404).json({ error: "用户不存在。" });
      return;
    }
    const nextRole = req.body.role && allowedRoles.has(req.body.role) ? req.body.role : current.role;
    const nextStatus = req.body.status && allowedStatus.has(req.body.status) ? req.body.status : current.status;
    const nextPlan = typeof req.body.plan === "string" && req.body.plan.trim() ? req.body.plan.trim().slice(0, 40) : current.plan;
    const nextName =
      typeof req.body.name === "string" && req.body.name.trim() ? req.body.name.trim().slice(0, 80) : current.display_name;
    sqlite
      .prepare("UPDATE user_profile SET display_name = ?, role = ?, plan = ?, status = ?, updated_at = ? WHERE user_id = ?")
      .run(nextName, nextRole, nextPlan, nextStatus, nowIso(), req.params.id);
    insertAudit({
      actorUserId: account.user.id,
      action: "user.update",
      targetType: "user",
      targetId: req.params.id,
      detail: { role: nextRole, status: nextStatus, plan: nextPlan, name: nextName },
    });
    res.json({ user: serializeAdminUser(getProfileWithUser(req.params.id)) });
  });

  app.patch("/api/admin/packages/:id", async (req, res) => {
    const account = await requireAdmin(req, res);
    if (!account) return;
    const current = sqlite.prepare("SELECT * FROM recharge_package WHERE id = ?").get(req.params.id);
    if (!current) {
      res.status(404).json({ error: "套餐不存在。" });
      return;
    }
    const patch = {
      title: typeof req.body.title === "string" && req.body.title.trim() ? req.body.title.trim().slice(0, 40) : current.title,
      credits: Number.isFinite(Number(req.body.credits)) ? Math.max(1, Math.floor(Number(req.body.credits))) : current.credits,
      amountCents: Number.isFinite(Number(req.body.amountCents))
        ? Math.max(1, Math.floor(Number(req.body.amountCents)))
        : current.amount_cents,
      badge: typeof req.body.badge === "string" && req.body.badge.trim() ? req.body.badge.trim().slice(0, 20) : current.badge,
      enabled: typeof req.body.enabled === "boolean" ? (req.body.enabled ? 1 : 0) : current.enabled,
    };
    sqlite
      .prepare(
        `UPDATE recharge_package
         SET title = ?, credits = ?, amount_cents = ?, badge = ?, enabled = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(patch.title, patch.credits, patch.amountCents, patch.badge, patch.enabled, nowIso(), req.params.id);
    insertAudit({
      actorUserId: account.user.id,
      action: "package.update",
      targetType: "package",
      targetId: req.params.id,
      detail: patch,
    });
    res.json({ package: serializePackage(sqlite.prepare("SELECT * FROM recharge_package WHERE id = ?").get(req.params.id)) });
  });

  app.post("/api/admin/credits/adjust", async (req, res) => {
    try {
      const account = await requireAdmin(req, res);
      if (!account) return;
      const userId = String(req.body.userId || "");
      const amount = Math.trunc(Number(req.body.amount));
      const reason = String(req.body.reason || "").trim().slice(0, 160);
      if (!userId || !Number.isFinite(amount) || amount === 0 || !reason) {
        res.status(400).json({ error: "需要用户、非零积分数量和调分原因。" });
        return;
      }
      const balanceAfter = adjustCredits({ userId, amount, reason, actorUserId: account.user.id });
      res.json({ user: serializeAdminUser(getProfileWithUser(userId)), balanceAfter });
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : "人工调分失败。" });
    }
  });
}
