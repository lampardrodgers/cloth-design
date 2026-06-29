import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const userProfile = sqliteTable("user_profile", {
  userId: text("user_id").primaryKey(),
  displayName: text("display_name").notNull(),
  role: text("role").notNull(),
  plan: text("plan").notNull(),
  credits: integer("credits").notNull(),
  monthlyUsed: integer("monthly_used").notNull(),
  status: text("status").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const rechargePackage = sqliteTable("recharge_package", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  credits: integer("credits").notNull(),
  amountCents: integer("amount_cents").notNull(),
  badge: text("badge").notNull(),
  enabled: integer("enabled", { mode: "boolean" }).notNull(),
  sortOrder: integer("sort_order").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const paymentOrder = sqliteTable("payment_order", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  packageId: text("package_id").notNull(),
  provider: text("provider").notNull(),
  status: text("status").notNull(),
  amountCents: integer("amount_cents").notNull(),
  credits: integer("credits").notNull(),
  subject: text("subject").notNull(),
  providerTransactionId: text("provider_transaction_id"),
  qrCodeUrl: text("qr_code_url").notNull(),
  qrCodeDataUrl: text("qr_code_data_url").notNull(),
  expiresAt: text("expires_at").notNull(),
  paidAt: text("paid_at"),
  closedAt: text("closed_at"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const paymentEvent = sqliteTable("payment_event", {
  id: text("id").primaryKey(),
  provider: text("provider").notNull(),
  eventKey: text("event_key").notNull(),
  orderId: text("order_id"),
  transactionId: text("transaction_id"),
  processed: integer("processed", { mode: "boolean" }).notNull(),
  payload: text("payload").notNull(),
  createdAt: text("created_at").notNull(),
});

export const creditLedger = sqliteTable("credit_ledger", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  orderId: text("order_id"),
  taskId: text("task_id"),
  kind: text("kind").notNull(),
  amount: integer("amount").notNull(),
  balanceAfter: integer("balance_after").notNull(),
  reason: text("reason").notNull(),
  createdBy: text("created_by"),
  createdAt: text("created_at").notNull(),
});

export const generationTask = sqliteTable("generation_task", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  mode: text("mode").notNull(),
  prompt: text("prompt").notNull(),
  status: text("status").notNull(),
  credits: integer("credits").notNull(),
  message: text("message").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const generatedResult = sqliteTable("generated_result", {
  id: text("id").primaryKey(),
  taskId: text("task_id").notNull(),
  userId: text("user_id").notNull(),
  title: text("title").notNull(),
  mode: text("mode").notNull(),
  ratioLabel: text("ratio_label").notNull(),
  storageStatus: text("storage_status").notNull(),
  credits: integer("credits").notNull(),
  imageUrl: text("image_url").notNull(),
  metadataJson: text("metadata_json").notNull(),
  createdAt: text("created_at").notNull(),
});

export const appConfig = sqliteTable("app_config", {
  key: text("key").primaryKey(),
  valueJson: text("value_json").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const auditLog = sqliteTable("audit_log", {
  id: text("id").primaryKey(),
  actorUserId: text("actor_user_id"),
  action: text("action").notNull(),
  targetType: text("target_type").notNull(),
  targetId: text("target_id"),
  detailJson: text("detail_json").notNull(),
  createdAt: text("created_at").notNull(),
});
