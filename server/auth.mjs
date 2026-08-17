import { betterAuth } from "better-auth";
import { fromNodeHeaders, toNodeHandler } from "better-auth/node";
import { admin } from "better-auth/plugins";
import { sqlite, nowIso } from "./db.mjs";
import { DEBUG_USER_PREFIX, debugAccount, debugUserIdFromRequest } from "./debug.mjs";

const port = Number(process.env.PORT || 8888);
const host = process.env.HOST || "127.0.0.1";
const fallbackBaseUrl = `http://${host}:${port}`;
const fallbackSecret = "dev-only-change-me-clothdesign-auth-secret-2026";

function normalizeOrigin(value) {
  try {
    return new URL(value).origin;
  } catch {
    return "";
  }
}

function authSecret() {
  if (process.env.AUTH_SECRET) return process.env.AUTH_SECRET;
  if (process.env.NODE_ENV === "production") {
    throw new Error("AUTH_SECRET is required in production.");
  }
  return fallbackSecret;
}

function adminEmails() {
  return new Set(
    String(process.env.ADMIN_EMAILS || "")
      .split(",")
      .map((item) => item.trim().toLowerCase())
      .filter(Boolean),
  );
}

/** 新注册的账号默认要等管理员开通；SIGNUP_APPROVAL=false 可放开为注册即用。 */
export function signupApprovalRequired() {
  return String(process.env.SIGNUP_APPROVAL ?? "true").toLowerCase() !== "false";
}

export function authTrustedOrigins() {
  const origins = [process.env.PUBLIC_APP_URL, fallbackBaseUrl];
  if (["127.0.0.1", "localhost", "0.0.0.0"].includes(host)) {
    origins.push(`http://127.0.0.1:${port}`, `http://localhost:${port}`);
  }
  return [...new Set(origins.map(normalizeOrigin).filter(Boolean))];
}

export const auth = betterAuth({
  database: sqlite,
  baseURL: process.env.PUBLIC_APP_URL || fallbackBaseUrl,
  trustedOrigins: authTrustedOrigins,
  secret: authSecret(),
  emailAndPassword: {
    enabled: true,
    autoSignIn: true,
    minPasswordLength: 8,
  },
  plugins: [admin()],
});

export const authHandler = toNodeHandler(auth);

export async function runAuthMigrations() {
  const context = await auth.$context;
  await context.runMigrations();
}

export async function getAuthSession(req) {
  return auth.api.getSession({
    headers: fromNodeHeaders(req.headers),
  });
}

export function ensureUserProfile(user) {
  const existing = sqlite.prepare("SELECT * FROM user_profile WHERE user_id = ?").get(user.id);
  const emails = adminEmails();
  const timestamp = nowIso();

  if (existing) {
    if (emails.has(String(user.email || "").toLowerCase()) && existing.role !== "owner") {
      sqlite
        .prepare("UPDATE user_profile SET role = 'owner', updated_at = ? WHERE user_id = ?")
        .run(timestamp, user.id);
      return sqlite.prepare("SELECT * FROM user_profile WHERE user_id = ?").get(user.id);
    }
    return existing;
  }

  // 调试座位也是 user_profile，但不能算「真实账号」——否则先有人点过「开发调试」，
  // 第一个注册的人就当不上 owner 了。
  const profileCount = sqlite
    .prepare("SELECT COUNT(*) AS count FROM user_profile WHERE user_id NOT LIKE ?")
    .get(`${DEBUG_USER_PREFIX}%`);
  const role = emails.has(String(user.email || "").toLowerCase()) || profileCount.count === 0 ? "owner" : "user";
  // owner 不用等人开通；普通账号按 SIGNUP_APPROVAL 决定是否先挂起。
  const approved = role === "owner" || !signupApprovalRequired() ? 1 : 0;
  sqlite
    .prepare(
      `INSERT INTO user_profile
        (user_id, display_name, role, plan, credits, monthly_used, status, approved, created_at, updated_at)
       VALUES (?, ?, ?, '基础版', 0, 0, 'active', ?, ?, ?)`,
    )
    .run(user.id, user.name || user.email || "未命名用户", role, approved, timestamp, timestamp);
  return sqlite.prepare("SELECT * FROM user_profile WHERE user_id = ?").get(user.id);
}

export const PENDING_APPROVAL_MESSAGE = "账号已创建，等管理员在后台开通后就能使用。";

export async function requireAccount(req, res) {
  // 每个调试座位是独立账号，成片和用量按座位隔离。
  const debugUserId = debugUserIdFromRequest(req);
  if (debugUserId) return debugAccount(debugUserId);

  const session = await getAuthSession(req);
  if (!session?.user) {
    res.status(401).json({ error: "请先登录。" });
    return null;
  }
  const profile = ensureUserProfile(session.user);
  if (profile.status !== "active") {
    res.status(403).json({ error: "账号已被锁定，请联系管理员。" });
    return null;
  }
  if (Number(profile.approved ?? 1) === 0 && !["owner", "admin"].includes(profile.role)) {
    res.status(403).json({ error: PENDING_APPROVAL_MESSAGE, pendingApproval: true });
    return null;
  }
  return { session, user: session.user, profile };
}

export async function requireAdmin(req, res) {
  const account = await requireAccount(req, res);
  if (!account) return null;
  if (!["owner", "admin"].includes(account.profile.role)) {
    res.status(403).json({ error: "需要管理员权限。" });
    return null;
  }
  return account;
}
