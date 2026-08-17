import { randomUUID } from "node:crypto";
import { nowIso, sqlite } from "./db.mjs";

export const DEBUG_USER_PREFIX = "__clothdesign_debug__";
/** 早期版本所有调试会话共用的那一个账号；现在只为兼容还没换过的旧 cookie 保留。 */
export const DEBUG_USER_ID = DEBUG_USER_PREFIX;
export const DEBUG_UNLIMITED_CREDITS = 999_999_999;
const DEBUG_COOKIE = "clothdesign_debug";
const LEGACY_SEAT = "1";
// 内部长期使用，cookie 一天就过期的话每天都会换一个新身份、看不到昨天的成片。
const DEBUG_COOKIE_MAX_AGE = 180 * 24 * 60 * 60;
const SEAT_PATTERN = /^[a-f0-9]{12}$/;

/**
 * 调试账号默认只在非生产环境可用。
 * `DEBUG_UNLIMITED=true` 是显式开关：内部部署（NODE_ENV=production）也照样放开；
 * `DEBUG_UNLIMITED=false` 永远关闭，优先级最高。
 */
export function debugUnlimitedAvailable() {
  const flag = String(process.env.DEBUG_UNLIMITED || "").trim().toLowerCase();
  if (flag === "false") return false;
  if (flag === "true") return true;
  return process.env.NODE_ENV !== "production";
}

export function isDebugUserId(userId) {
  return String(userId || "").startsWith(DEBUG_USER_PREFIX);
}

export function newDebugSeat() {
  return randomUUID().replace(/-/g, "").slice(0, 12);
}

export function debugUserIdFromSeat(seat) {
  if (!seat) return "";
  if (seat === LEGACY_SEAT) return DEBUG_USER_ID;
  return SEAT_PATTERN.test(seat) ? `${DEBUG_USER_PREFIX}${seat}` : "";
}

/** 读 cookie 里的座位号。只认自己发出去的格式，别人手搓一个也进不来别人的账号。 */
export function debugSeatFromRequest(req) {
  if (!debugUnlimitedAvailable()) return "";
  const raw = String(req.headers?.cookie || "")
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${DEBUG_COOKIE}=`));
  if (!raw) return "";
  const seat = raw.slice(DEBUG_COOKIE.length + 1);
  if (seat === LEGACY_SEAT) return LEGACY_SEAT;
  return SEAT_PATTERN.test(seat) ? seat : "";
}

export function debugUserIdFromRequest(req) {
  return debugUserIdFromSeat(debugSeatFromRequest(req));
}

export function hasDebugCookie(req) {
  return Boolean(debugUserIdFromRequest(req));
}

export function debugCookieHeader({ clear = false, seat = LEGACY_SEAT } = {}) {
  return clear
    ? `${DEBUG_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`
    : `${DEBUG_COOKIE}=${seat}; Path=/; Max-Age=${DEBUG_COOKIE_MAX_AGE}; HttpOnly; SameSite=Lax`;
}

function debugDisplayName(userId) {
  if (userId === DEBUG_USER_ID) return "开发调试";
  return `开发调试 · ${userId.slice(DEBUG_USER_PREFIX.length, DEBUG_USER_PREFIX.length + 6)}`;
}

/**
 * 每个调试座位是一条真实的 user_profile，所以成片、任务、用量都按座位隔离，
 * 后台「用户与用量」里也能一行一行看到各自用了多少。
 */
export function ensureDebugUserProfile(userId = DEBUG_USER_ID) {
  const timestamp = nowIso();
  const displayName = debugDisplayName(userId);
  const existing = sqlite.prepare("SELECT * FROM user_profile WHERE user_id = ?").get(userId);
  if (existing) {
    sqlite
      .prepare(
        `UPDATE user_profile
         SET display_name = ?, plan = ?, credits = ?, monthly_used = 0, status = 'active', approved = 1, updated_at = ?
         WHERE user_id = ?`,
      )
      .run(displayName, "无限调试", DEBUG_UNLIMITED_CREDITS, timestamp, userId);
    return sqlite.prepare("SELECT * FROM user_profile WHERE user_id = ?").get(userId);
  }

  sqlite
    .prepare(
      `INSERT INTO user_profile
        (user_id, display_name, role, plan, credits, monthly_used, status, approved, created_at, updated_at)
       VALUES (?, ?, 'user', ?, ?, 0, 'active', 1, ?, ?)`,
    )
    .run(userId, displayName, "无限调试", DEBUG_UNLIMITED_CREDITS, timestamp, timestamp);
  return sqlite.prepare("SELECT * FROM user_profile WHERE user_id = ?").get(userId);
}

export function debugAccount(userId = DEBUG_USER_ID) {
  const id = isDebugUserId(userId) ? userId : DEBUG_USER_ID;
  return {
    session: null,
    user: {
      id,
      email: `${id === DEBUG_USER_ID ? "debug" : id.slice(DEBUG_USER_PREFIX.length)}@clothdesign.local`,
      name: debugDisplayName(id),
    },
    profile: ensureDebugUserProfile(id),
  };
}
