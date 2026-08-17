import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as schema from "./schema.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

function resolveDatabasePath(databaseUrl = process.env.DATABASE_URL || "file:./data/clothdesign.db") {
  if (!databaseUrl.startsWith("file:")) {
    throw new Error("Only file: SQLite DATABASE_URL values are supported by this build.");
  }
  const rawPath = databaseUrl.slice("file:".length);
  return path.isAbsolute(rawPath) ? rawPath : path.resolve(root, rawPath);
}

export const databasePath = resolveDatabasePath();
fs.mkdirSync(path.dirname(databasePath), { recursive: true });

export const sqlite = new Database(databasePath);
sqlite.pragma("journal_mode = WAL");
sqlite.pragma("foreign_keys = ON");
sqlite.pragma("busy_timeout = 5000");

export const orm = drizzle(sqlite, { schema });

export function nowIso() {
  return new Date().toISOString();
}

export function toBooleanInt(value) {
  return value ? 1 : 0;
}

function createBusinessTables() {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS user_profile (
      user_id TEXT PRIMARY KEY,
      display_name TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'user')),
      plan TEXT NOT NULL,
      credits INTEGER NOT NULL DEFAULT 0 CHECK (credits >= 0),
      monthly_used INTEGER NOT NULL DEFAULT 0 CHECK (monthly_used >= 0),
      status TEXT NOT NULL CHECK (status IN ('active', 'locked')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS recharge_package (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      credits INTEGER NOT NULL CHECK (credits > 0),
      amount_cents INTEGER NOT NULL CHECK (amount_cents >= 1),
      badge TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS payment_order (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      package_id TEXT NOT NULL,
      provider TEXT NOT NULL CHECK (provider IN ('alipay', 'wechat')),
      status TEXT NOT NULL CHECK (status IN ('pending', 'paid', 'closed', 'failed', 'refunded')),
      amount_cents INTEGER NOT NULL CHECK (amount_cents >= 1),
      credits INTEGER NOT NULL CHECK (credits > 0),
      subject TEXT NOT NULL,
      provider_transaction_id TEXT,
      qr_code_url TEXT NOT NULL,
      qr_code_data_url TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      paid_at TEXT,
      closed_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES user_profile(user_id),
      FOREIGN KEY (package_id) REFERENCES recharge_package(id)
    );

    CREATE INDEX IF NOT EXISTS idx_payment_order_user_created ON payment_order(user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_payment_order_status_expires ON payment_order(status, expires_at);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_payment_order_provider_txn
      ON payment_order(provider, provider_transaction_id)
      WHERE provider_transaction_id IS NOT NULL;

    CREATE TABLE IF NOT EXISTS payment_event (
      id TEXT PRIMARY KEY,
      provider TEXT NOT NULL CHECK (provider IN ('alipay', 'wechat')),
      event_key TEXT NOT NULL,
      order_id TEXT,
      transaction_id TEXT,
      processed INTEGER NOT NULL DEFAULT 0 CHECK (processed IN (0, 1)),
      payload TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE (provider, event_key)
    );

    CREATE INDEX IF NOT EXISTS idx_payment_event_order ON payment_event(order_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS credit_ledger (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      order_id TEXT,
      task_id TEXT,
      kind TEXT NOT NULL CHECK (kind IN ('recharge', 'consume', 'refund', 'admin_adjust')),
      amount INTEGER NOT NULL,
      balance_after INTEGER NOT NULL CHECK (balance_after >= 0),
      reason TEXT NOT NULL,
      created_by TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES user_profile(user_id),
      UNIQUE (order_id, kind)
    );

    CREATE INDEX IF NOT EXISTS idx_credit_ledger_user_created ON credit_ledger(user_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS generation_task (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      mode TEXT NOT NULL,
      prompt TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('running', 'success', 'failed')),
      credits INTEGER NOT NULL,
      message TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES user_profile(user_id)
    );

    CREATE INDEX IF NOT EXISTS idx_generation_task_user_created ON generation_task(user_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS generated_result (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      title TEXT NOT NULL,
      mode TEXT NOT NULL,
      ratio_label TEXT NOT NULL,
      storage_status TEXT NOT NULL,
      credits INTEGER NOT NULL,
      image_url TEXT NOT NULL,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      FOREIGN KEY (task_id) REFERENCES generation_task(id),
      FOREIGN KEY (user_id) REFERENCES user_profile(user_id)
    );

    CREATE INDEX IF NOT EXISTS idx_generated_result_user_created ON generated_result(user_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS app_config (
      key TEXT PRIMARY KEY,
      value_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS audit_log (
      id TEXT PRIMARY KEY,
      actor_user_id TEXT,
      action TEXT NOT NULL,
      target_type TEXT NOT NULL,
      target_id TEXT,
      detail_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_audit_log_created ON audit_log(created_at DESC);
  `);

  const generatedResultColumns = new Set(
    sqlite
      .prepare("PRAGMA table_info(generated_result)")
      .all()
      .map((row) => row.name),
  );
  if (!generatedResultColumns.has("metadata_json")) {
    sqlite.exec("ALTER TABLE generated_result ADD COLUMN metadata_json TEXT NOT NULL DEFAULT '{}'");
  }

  // 多人使用：账号要先由管理员开通；每个账号可以自备图像接口 Key（加密落库）。
  const profileColumns = new Set(
    sqlite
      .prepare("PRAGMA table_info(user_profile)")
      .all()
      .map((row) => row.name),
  );
  if (!profileColumns.has("approved")) {
    // 老账号默认视为已开通，不然升级一发所有人都被拦在门外。
    sqlite.exec("ALTER TABLE user_profile ADD COLUMN approved INTEGER NOT NULL DEFAULT 1 CHECK (approved IN (0, 1))");
  }
  if (!profileColumns.has("unlimited")) {
    // 管理员给某个账号开「无限额度」：生成不扣积分，顶栏显示 ∞。
    sqlite.exec("ALTER TABLE user_profile ADD COLUMN unlimited INTEGER NOT NULL DEFAULT 0 CHECK (unlimited IN (0, 1))");
  }
  if (!profileColumns.has("api_key_encrypted")) {
    sqlite.exec("ALTER TABLE user_profile ADD COLUMN api_key_encrypted TEXT");
    sqlite.exec("ALTER TABLE user_profile ADD COLUMN api_key_hint TEXT");
    sqlite.exec("ALTER TABLE user_profile ADD COLUMN api_key_updated_at TEXT");
  }

  const taskColumns = new Set(
    sqlite
      .prepare("PRAGMA table_info(generation_task)")
      .all()
      .map((row) => row.name),
  );
  if (!taskColumns.has("key_source")) {
    // 记下这次生成走的是服务端 Key 还是账号自备 Key，后台看用量要分开算。
    sqlite.exec("ALTER TABLE generation_task ADD COLUMN key_source TEXT NOT NULL DEFAULT 'server'");
  }
}

function seedRechargePackages() {
  const existing = sqlite.prepare("SELECT COUNT(*) AS count FROM recharge_package").get();
  if (existing.count > 0) return;

  const timestamp = nowIso();
  const insert = sqlite.prepare(`
    INSERT INTO recharge_package (id, title, credits, amount_cents, badge, enabled, sort_order, created_at, updated_at)
    VALUES (@id, @title, @credits, @amountCents, @badge, 1, @sortOrder, @createdAt, @updatedAt)
  `);

  [
    { id: "pkg-1", title: "试用包", credits: 300, amountCents: 9900, badge: "个人", sortOrder: 10 },
    { id: "pkg-2", title: "工作室包", credits: 1200, amountCents: 34900, badge: "常用", sortOrder: 20 },
    { id: "pkg-3", title: "团队包", credits: 4200, amountCents: 99900, badge: "批量", sortOrder: 30 },
  ].forEach((item) => insert.run({ ...item, createdAt: timestamp, updatedAt: timestamp }));
}

export function migrateBusinessDatabase() {
  createBusinessTables();
  seedRechargePackages();
}

export function runTransaction(fn) {
  return sqlite.transaction(fn)();
}
