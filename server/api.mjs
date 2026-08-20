import { randomUUID } from "node:crypto";
import { auth, ensureUserProfile, getAuthSession, isAdminRole, requireAccount, requireAdmin, selfSignupAllowed } from "./auth.mjs";
import { emailToUsername, normalizeUsername, usernameToEmail } from "./accounts.mjs";
import {
  RESOLUTION_KEYS,
  imageProviderSettings,
  imageProviderSettingsList,
  isValidProviderId,
  normalizeResolution,
  resetImageProviderSettings,
  saveImageProviderSettings,
} from "./provider-config.mjs";
import { testProviderConnectivity } from "./provider-connectivity.mjs";
import { canUseShortVideo, shortVideoFeatureFor } from "./shortvideo.mjs";
import { nowIso, sqlite } from "./db.mjs";
import {
  creditPolicySettings,
  mergeUserPreferences,
  readUserPreferences,
  saveCreditPolicy,
  saveSystemPrompts,
  systemPromptOverrides,
} from "./app-settings.mjs";
import {
  DEBUG_UNLIMITED_CREDITS,
  DEBUG_USER_ID,
  debugCookieHeader,
  debugSeatFromRequest,
  debugUnlimitedAvailable,
  debugUserIdFromSeat,
  ensureDebugUserProfile,
  isDebugUserId,
  newDebugSeat,
} from "./debug.mjs";
import { deleteManagedGeneratedImage } from "./image-provider.mjs";
import {
  clearSharedProviderApiKey,
  clearUserApiKey,
  normalizeApiKey,
  resolutionPolicyFor,
  resolveProviderApiKey,
  serverApiKey,
  setSharedProviderApiKey,
  setUserApiKey,
  setUserApiProvider,
  sharedProviderApiKeyStatus,
} from "./user-keys.mjs";
import {
  archivePendingResults,
  archiveResultToWebdav,
  resultExpiresAt,
  runStorageMaintenance,
  saveUserStorageSettings,
  storageAdminOverview,
  storageOverviewForUser,
  testWebdavConnection,
} from "./storage.mjs";
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
  const safeProfile = profile || {
    display_name: user.name || user.email || "未命名用户",
    role: "user",
    plan: "基础版",
    credits: 0,
    monthly_used: 0,
    status: "active",
  };
  const debugUser = isDebugUserId(user.id);
  // 管理员开过「无限额度」的账号，和调试座位一样不受积分限制。
  const unlimited = debugUser || Number(safeProfile.unlimited ?? 0) === 1;
  const apiProviderId = isValidProviderId(safeProfile.api_provider_id) ? safeProfile.api_provider_id : "default";
  return {
    id: user.id,
    email: user.email,
    username: emailToUsername(user.email),
    // 调试座位各有各的名字（开发调试 · a1b2c3），顶栏和后台才分得清是谁。
    name: safeProfile.display_name || (debugUser ? "开发调试" : user.name || user.email),
    role: safeProfile.role,
    plan: debugUser ? "无限调试" : safeProfile.plan,
    credits: unlimited ? DEBUG_UNLIMITED_CREDITS : safeProfile.credits,
    unlimited,
    monthlyUsed: debugUser ? 0 : safeProfile.monthly_used,
    status: safeProfile.status,
    approved: Number(safeProfile.approved ?? 1) === 1,
    // 自备 Key 只回传脱敏提示，原文永远不出服务端。
    hasOwnApiKey: Boolean(safeProfile.api_key_encrypted),
    apiKeyHint: safeProfile.api_key_hint || null,
    apiKeyUpdatedAt: safeProfile.api_key_updated_at || null,
    apiProviderId,
    apiProviderName: imageProviderSettings(apiProviderId).name,
    apiProviderProtocol: imageProviderSettings(apiProviderId).protocol,
    // 1K/2K/4K 哪些能点：前端照这个渲染，服务端出图前还会再裁一次。
    ...resolutionPolicyFor(apiProviderId, safeProfile.max_resolution),
    serverKeyConfigured: Boolean(serverApiKey(apiProviderId)),
    // 按账号开的功能开关：前端只在为 true 时渲染对应入口（短视频默认只有 admin）。
    features: shortVideoFeatureFor(safeProfile),
  };
}

function publicImageProviders() {
  return imageProviderSettingsList().map((provider) => ({
    ...provider,
    ...sharedProviderApiKeyStatus(provider.id),
  }));
}

/**
 * 后台看用量：按账号汇总任务数、成片数、积分消耗（扣除退款）和最近活跃时间。
 * 自备 Key 的任务单独计数——那部分没扣积分，但接口费用是他们自己的。
 *
 * `userIds` 传了就只统计这几个账号。后台用户列表分页之后，一页只有几十个人，
 * 没必要为了这几行去把 generation_task / generated_result / credit_ledger 整表扫一遍。
 */
export function usageByUser(userIds) {
  const scope = Array.isArray(userIds) ? userIds.filter(Boolean) : null;
  if (scope && scope.length === 0) return new Map();
  const filter = scope ? ` AND user_id IN (${scope.map(() => "?").join(", ")})` : "";
  const monthAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const scoped = scope || [];
  const rows = sqlite
    .prepare(
      `SELECT user_id,
              COUNT(*) AS task_count,
              SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) AS success_count,
              SUM(CASE WHEN key_source = 'user' THEN 1 ELSE 0 END) AS own_key_task_count,
              SUM(CASE WHEN created_at >= ? THEN 1 ELSE 0 END) AS task_count_30d,
              MAX(created_at) AS last_task_at
       FROM generation_task
       WHERE 1 = 1${filter}
       GROUP BY user_id`,
    )
    .all(monthAgo, ...scoped);
  const images = sqlite
    .prepare(`SELECT user_id, COUNT(*) AS image_count FROM generated_result WHERE 1 = 1${filter} GROUP BY user_id`)
    .all(...scoped);
  const credits = sqlite
    .prepare(
      `SELECT user_id,
              SUM(CASE WHEN kind IN ('consume', 'refund') THEN -amount ELSE 0 END) AS credits_spent,
              SUM(CASE WHEN kind IN ('consume', 'refund') AND created_at >= ? THEN -amount ELSE 0 END) AS credits_spent_30d
       FROM credit_ledger
       WHERE 1 = 1${filter}
       GROUP BY user_id`,
    )
    .all(monthAgo, ...scoped);
  const usage = new Map();
  const ensure = (userId) => {
    if (!usage.has(userId)) {
      usage.set(userId, {
        taskCount: 0,
        successCount: 0,
        ownKeyTaskCount: 0,
        taskCount30d: 0,
        imageCount: 0,
        creditsSpent: 0,
        creditsSpent30d: 0,
        lastActiveAt: null,
      });
    }
    return usage.get(userId);
  };
  for (const row of rows) {
    Object.assign(ensure(row.user_id), {
      taskCount: row.task_count,
      successCount: row.success_count,
      ownKeyTaskCount: row.own_key_task_count,
      taskCount30d: row.task_count_30d,
      lastActiveAt: row.last_task_at,
    });
  }
  for (const row of images) ensure(row.user_id).imageCount = row.image_count;
  for (const row of credits) {
    Object.assign(ensure(row.user_id), {
      creditsSpent: Math.max(0, row.credits_spent || 0),
      creditsSpent30d: Math.max(0, row.credits_spent_30d || 0),
    });
  }
  return usage;
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
    prompt: metadata.prompt || null,
    imageInspection: metadata.imageInspection || null,
    qualityGate: metadata.qualityGate || null,
    revisedPrompt: metadata.revisedPrompt || null,
    metadata,
    createdAt: row.created_at,
    // 服务器暂存到期时间；已经过期的就不再给时间了
    expiresAt: row.expired_at ? null : resultExpiresAt(row.created_at),
    expiredAt: row.expired_at || null,
    archivedAt: row.archived_at || null,
    archivePath: row.archive_path || null,
  };
}

/**
 * 文件管理页用：该账号的成片（含过期的），按页给。
 * 原来是一次性取 300 条整页渲染，出图上千之后首屏能卡好几秒——每条都带一个 <img>。
 */
function storageResultsPageForUser(userId, { page, pageSize }) {
  return adminPage({
    page,
    pageSize,
    count: () => sqlite.prepare("SELECT COUNT(*) AS count FROM generated_result WHERE user_id = ?").get(userId)?.count,
    rows: (limit, offset) =>
      sqlite
        .prepare("SELECT * FROM generated_result WHERE user_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?")
        .all(userId, limit, offset),
    map: (list) => list.map(serializeGeneratedResult),
  });
}

function recentGeneratedResultsForUser(userId) {
  return sqlite
    .prepare("SELECT * FROM generated_result WHERE user_id = ? ORDER BY created_at DESC LIMIT 20")
    .all(userId)
    .map(serializeGeneratedResult);
}

/**
 * 后台列表统一分页。
 * 之前 overview 是把订单/流水/生成记录各拉 80 条一次性塞进同一个响应里，前端再 slice 出 8~12 条渲染：
 * 拉回来的大半是白拉的，而第 13 条往后永远看不到。数据涨到成百上千之后这套就彻底不能用了。
 */
const ADMIN_PAGE_SIZE = 20;
// 文件管理是缩略图网格，一页给多一点更顺手。
const STORAGE_PAGE_SIZE = 24;
// 生成审计排成 3 列，一页正好 5 行。
const ADMIN_RESULT_PAGE_SIZE = 15;
const ADMIN_PAGE_SIZE_MAX = 100;

function parsePaging(query, fallbackSize = ADMIN_PAGE_SIZE) {
  const rawSize = Number.parseInt(query?.pageSize, 10);
  const rawPage = Number.parseInt(query?.page, 10);
  const pageSize = Math.min(Math.max(Number.isFinite(rawSize) ? rawSize : fallbackSize, 1), ADMIN_PAGE_SIZE_MAX);
  const page = Math.max(Number.isFinite(rawPage) ? rawPage : 1, 1);
  return { page, pageSize };
}

/**
 * 取一页：先数总数，页码超出范围就夹回最后一页。
 * 不夹的话，删掉几条之后停在原来的末页就是一片空白，看着像数据没了。
 */
function adminPage({ count, rows, page, pageSize, map = (list) => list }) {
  const total = Number(count() || 0);
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(page, pageCount);
  const items = total === 0 ? [] : map(rows(pageSize, (safePage - 1) * pageSize));
  return { items, total, page: safePage, pageSize, pageCount };
}

/** 只要游标，不要数据体——overview 里 items 已经单独给过了。 */
function pageMeta({ total, page, pageSize, pageCount }) {
  return { total, page, pageSize, pageCount };
}

// 用 Map 而不是普通对象：filter 是 query 里来的，普通对象查 "toString" / "constructor"
// 会摸到原型上的东西，那玩意儿一旦被拼进 SQL 就是一条语法错误的语句。
const USER_FILTERS = new Map([
  ["all", ""],
  ["pending", "p.approved = 0"],
  ["locked", "p.status = 'locked'"],
  ["unlimited", "p.unlimited = 1"],
  ["own-key", "p.api_key_encrypted IS NOT NULL"],
]);

function adminUsersPage({ page, pageSize, keyword = "", filter = "all" }) {
  const clauses = [];
  const params = [];
  const term = String(keyword || "").trim().slice(0, 80);
  if (term) {
    // LIKE 里的 % 和 _ 是通配符，用户搜的是字面量，转义掉。
    const like = `%${term.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
    clauses.push(`(u.email LIKE ? ESCAPE '\\' OR p.display_name LIKE ? ESCAPE '\\')`);
    params.push(like, like);
  }
  const filterClause = USER_FILTERS.get(String(filter)) ?? "";
  if (filterClause) clauses.push(filterClause);
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const from = `FROM user_profile p LEFT JOIN "user" u ON u.id = p.user_id ${where}`;
  return adminPage({
    page,
    pageSize,
    count: () => sqlite.prepare(`SELECT COUNT(*) AS count ${from}`).get(...params)?.count,
    rows: (limit, offset) =>
      sqlite.prepare(`SELECT p.*, u.email, u.name ${from} ORDER BY p.created_at ASC LIMIT ? OFFSET ?`).all(...params, limit, offset),
    // 用量只统计当页这几十个账号，别为了一页表格去扫三张全表。
    map: (list) => {
      const usage = usageByUser(list.map((row) => row.user_id));
      return list.map((row) => serializeAdminUser(row, usage.get(row.user_id)));
    },
  });
}

function adminOrdersPage({ page, pageSize }) {
  return adminPage({
    page,
    pageSize,
    count: () => sqlite.prepare("SELECT COUNT(*) AS count FROM payment_order").get()?.count,
    rows: (limit, offset) =>
      sqlite.prepare("SELECT * FROM payment_order ORDER BY created_at DESC LIMIT ? OFFSET ?").all(limit, offset),
    map: (list) => list.map(serializeOrder),
  });
}

function serializePaymentEvent(row) {
  return {
    id: row.id,
    provider: row.provider,
    eventKey: row.event_key,
    orderId: row.order_id,
    transactionId: row.transaction_id,
    processed: Boolean(row.processed),
    createdAt: row.created_at,
  };
}

function adminPaymentEventsPage({ page, pageSize }) {
  return adminPage({
    page,
    pageSize,
    count: () => sqlite.prepare("SELECT COUNT(*) AS count FROM payment_event").get()?.count,
    rows: (limit, offset) =>
      sqlite.prepare("SELECT * FROM payment_event ORDER BY created_at DESC LIMIT ? OFFSET ?").all(limit, offset),
    map: (list) => list.map(serializePaymentEvent),
  });
}

function adminLedgerPage({ page, pageSize }) {
  return adminPage({
    page,
    pageSize,
    count: () => sqlite.prepare("SELECT COUNT(*) AS count FROM credit_ledger").get()?.count,
    rows: (limit, offset) =>
      sqlite.prepare("SELECT * FROM credit_ledger ORDER BY created_at DESC LIMIT ? OFFSET ?").all(limit, offset),
    map: (list) => list.map(serializeLedger),
  });
}

function adminGenerationResultsPage({ page, pageSize }) {
  return adminPage({
    page,
    pageSize,
    count: () => sqlite.prepare("SELECT COUNT(*) AS count FROM generated_result").get()?.count,
    rows: (limit, offset) =>
      sqlite
        .prepare(
          `SELECT r.*, u.email AS user_email, p.display_name AS user_name
           FROM generated_result r
           LEFT JOIN "user" u ON u.id = r.user_id
           LEFT JOIN user_profile p ON p.user_id = r.user_id
           ORDER BY r.created_at DESC
           LIMIT ? OFFSET ?`,
        )
        .all(limit, offset),
    map: (list) => list.map(serializeGeneratedResult),
  });
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

/** 后台首屏的一眼概览：账号、待办、今天/本月的实际用量。 */
export function adminSummary() {
  const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const monthAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const profiles = sqlite
    .prepare(
      `SELECT
         COUNT(*) AS total,
         SUM(CASE WHEN approved = 0 THEN 1 ELSE 0 END) AS pending,
         SUM(CASE WHEN status = 'locked' THEN 1 ELSE 0 END) AS locked,
         SUM(CASE WHEN unlimited = 1 THEN 1 ELSE 0 END) AS unlimited,
         SUM(CASE WHEN api_key_encrypted IS NOT NULL THEN 1 ELSE 0 END) AS with_own_key
       FROM user_profile`,
    )
    .get();
  const tasks = sqlite
    .prepare(
      `SELECT
         COUNT(*) AS total,
         SUM(CASE WHEN created_at >= ? THEN 1 ELSE 0 END) AS last_24h,
         SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
         SUM(CASE WHEN status = 'failed' AND created_at >= ? THEN 1 ELSE 0 END) AS failed_24h
       FROM generation_task`,
    )
    .get(dayAgo, dayAgo);
  const images = sqlite
    .prepare("SELECT COUNT(*) AS total, SUM(CASE WHEN created_at >= ? THEN 1 ELSE 0 END) AS last_24h FROM generated_result")
    .get(dayAgo);
  const credits = sqlite
    .prepare(
      `SELECT SUM(CASE WHEN kind IN ('consume', 'refund') THEN -amount ELSE 0 END) AS spent_30d
       FROM credit_ledger WHERE created_at >= ?`,
    )
    .get(monthAgo);
  const activeUsers = sqlite
    .prepare("SELECT COUNT(DISTINCT user_id) AS count FROM generation_task WHERE created_at >= ?")
    .get(dayAgo);
  return {
    users: {
      total: profiles.total || 0,
      pending: profiles.pending || 0,
      locked: profiles.locked || 0,
      unlimited: profiles.unlimited || 0,
      withOwnKey: profiles.with_own_key || 0,
      active24h: activeUsers.count || 0,
    },
    tasks: {
      total: tasks.total || 0,
      last24h: tasks.last_24h || 0,
      failed: tasks.failed || 0,
      failed24h: tasks.failed_24h || 0,
    },
    images: { total: images.total || 0, last24h: images.last_24h || 0 },
    creditsSpent30d: Math.max(0, credits.spent_30d || 0),
    selfSignupAllowed: selfSignupAllowed(),
  };
}

function serializeAdminUser(row, usage = usageByUser([row.user_id]).get(row.user_id)) {
  return {
    id: row.user_id,
    email: row.email,
    username: emailToUsername(row.email),
    name: row.display_name || row.name || emailToUsername(row.email),
    role: row.role,
    plan: row.plan,
    credits: row.credits,
    monthlyUsed: row.monthly_used,
    status: row.status,
    approved: Number(row.approved ?? 1) === 1,
    unlimited: Number(row.unlimited ?? 0) === 1,
    hasOwnApiKey: Boolean(row.api_key_encrypted),
    apiKeyHint: row.api_key_hint || null,
    apiProviderId: isValidProviderId(row.api_provider_id) ? row.api_provider_id : "default",
    ...resolutionPolicyFor(row.api_provider_id, row.max_resolution),
    // 短视频：admin 天然可用；别的账号看后台有没有单独打开。
    shortVideoEnabled: Number(row.shortvideo_enabled ?? 0) === 1,
    canUseShortVideo: canUseShortVideo(row),
    createdAt: row.created_at,
    usage: usage || {
      taskCount: 0,
      successCount: 0,
      ownKeyTaskCount: 0,
      taskCount30d: 0,
      imageCount: 0,
      creditsSpent: 0,
      creditsSpent30d: 0,
      lastActiveAt: null,
    },
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

// 最近的前端异常，只留在内存里（重启就清空）。真正的存档是服务日志。
const CLIENT_ERROR_LIMIT = 50;
const clientErrors = [];

function recordClientError(entry) {
  clientErrors.unshift(entry);
  if (clientErrors.length > CLIENT_ERROR_LIMIT) clientErrors.length = CLIENT_ERROR_LIMIT;
}

function recentClientErrors() {
  return clientErrors.slice(0, CLIENT_ERROR_LIMIT);
}

// 这个接口不需要登录（崩在登录页也得能报），所以按 IP 限一下速，别被人当日志水管用。
const CLIENT_ERROR_WINDOW_MS = 60000;
const CLIENT_ERROR_PER_WINDOW = 30;
const clientErrorHits = new Map();

function clientErrorRateLimited(ip) {
  const now = Date.now();
  const hit = clientErrorHits.get(ip);
  if (!hit || now - hit.since > CLIENT_ERROR_WINDOW_MS) {
    clientErrorHits.set(ip, { since: now, count: 1 });
    // 顺手清掉过期的，别让 Map 一直长
    if (clientErrorHits.size > 500) {
      for (const [key, value] of clientErrorHits) {
        if (now - value.since > CLIENT_ERROR_WINDOW_MS) clientErrorHits.delete(key);
      }
    }
    return false;
  }
  hit.count += 1;
  return hit.count > CLIENT_ERROR_PER_WINDOW;
}

export function registerBusinessRoutes(app) {
  app.get("/api/debug/config", (_req, res) => {
    res.json({ available: debugUnlimitedAvailable() });
  });

  app.post("/api/debug/session", (req, res) => {
    if (!debugUnlimitedAvailable()) {
      res.status(404).json({ error: "开发调试模式未开启。" });
      return;
    }
    // 已经有座位就沿用，刷新或重新点按钮不该换一个新身份、把之前的成片甩掉。
    const seat = debugSeatFromRequest(req) || newDebugSeat();
    ensureDebugUserProfile(debugUserIdFromSeat(seat));
    res.setHeader("Set-Cookie", debugCookieHeader({ seat }));
    res.json({ debugUnlimited: true });
  });

  app.delete("/api/debug/session", (_req, res) => {
    res.setHeader("Set-Cookie", debugCookieHeader({ clear: true }));
    res.json({ debugUnlimited: false });
  });

  app.get("/api/me", async (req, res) => {
    const account = await requireAccount(req, res);
    if (!account) return;
    markExpiredOrdersClosed();
    const profile = getProfileWithUser(account.user.id) || account.profile;
    res.json({
      account: serializeAccount(account.user, profile),
      packages: getEnabledPackages(),
      orders: recentOrdersForUser(account.user.id),
      ledger: recentLedgerForUser(account.user.id),
      generationResults: recentGeneratedResultsForUser(account.user.id),
      imageProviders: publicImageProviders(),
      debugUnlimited: isDebugUserId(account.user.id),
      paymentCapabilities: paymentCapabilities(),
      paymentConfig: paymentConfigStatus(),
      // 后台改过、对所有人生效的规则：报价和服务端扣费用同一份；提示词模板也不再只在管理员本机。
      creditPolicy: creditPolicySettings(),
      systemPrompts: systemPromptOverrides(),
      // 这个账号在别的设备上留下的偏好（提示词库 / 设置 / 草稿），登录即拉回来。
      preferences: readUserPreferences(account.user.id),
    });
  });

  /**
   * 对所有人生效的那两份规则单独一个轻接口：页面开着的时候管理员改了报价 / 模板，
   * 客户端回到前台、或定时拉一次，就不会拿旧报价、旧模板出图。
   */
  app.get("/api/app-settings", async (req, res) => {
    const account = await requireAccount(req, res);
    if (!account) return;
    res.json({ creditPolicy: creditPolicySettings(), systemPrompts: systemPromptOverrides() });
  });

  /** 账号偏好合并写入：键为 null 表示删除。客户端防抖写，这里只认 clothdesign: 前缀的键。 */
  app.put("/api/me/preferences", async (req, res) => {
    const account = await requireAccount(req, res);
    if (!account) return;
    const result = mergeUserPreferences(account.user.id, req.body?.preferences);
    if (result.error) {
      res.status(400).json({ error: result.error });
      return;
    }
    res.json({ preferences: result.value });
  });

  // 自备图像接口 Key：只存加密后的，回传脱敏提示。
  app.put("/api/me/api-key", async (req, res) => {
    const account = await requireAccount(req, res);
    if (!account) return;
    // 每个调试座位是独立账号，可以自备 Key；只有早期那个共用账号不行。
    if (account.user.id === DEBUG_USER_ID) {
      res.status(400).json({ error: "这是早期的共用调试账号，请重新点一次「开发调试」换成独立座位后再保存 Key。" });
      return;
    }
    const normalized = normalizeApiKey(req.body?.apiKey);
    if (normalized.error) {
      res.status(400).json({ error: normalized.error });
      return;
    }
    const providerId = req.body?.providerId ?? account.profile.api_provider_id ?? "default";
    if (!isValidProviderId(providerId)) {
      res.status(400).json({ error: "图像供应商不存在。" });
      return;
    }
    const saved = setUserApiKey(account.user.id, normalized.value, providerId);
    insertAudit({ actorUserId: account.user.id, action: "user.api_key.set", targetType: "user", targetId: account.user.id, detail: { hint: saved.apiKeyHint } });
    res.json({ account: serializeAccount(account.user, getProfileWithUser(account.user.id)) });
  });

  app.delete("/api/me/api-key", async (req, res) => {
    const account = await requireAccount(req, res);
    if (!account) return;
    if (account.user.id === DEBUG_USER_ID) {
      res.status(400).json({ error: "这是早期的共用调试账号，没有单独的 Key。" });
      return;
    }
    clearUserApiKey(account.user.id);
    insertAudit({ actorUserId: account.user.id, action: "user.api_key.clear", targetType: "user", targetId: account.user.id, detail: {} });
    res.json({ account: serializeAccount(account.user, getProfileWithUser(account.user.id)) });
  });

  /** 账号选择自己的 Key / 站点共享 Key 应该配对哪一个 URL Base。 */
  app.put("/api/me/image-provider", async (req, res) => {
    const account = await requireAccount(req, res);
    if (!account) return;
    const result = setUserApiProvider(account.user.id, req.body?.providerId);
    if (result.error) {
      res.status(400).json({ error: result.error });
      return;
    }
    insertAudit({
      actorUserId: account.user.id,
      action: "user.image_provider.set",
      targetType: "user",
      targetId: account.user.id,
      detail: { providerId: result.apiProviderId },
    });
    res.json({ account: serializeAccount(account.user, getProfileWithUser(account.user.id)) });
  });

  /** 普通账号自己的连通性测试：只请求 /models，不生成图片。 */
  app.post("/api/me/image-provider/test", async (req, res) => {
    const account = await requireAccount(req, res);
    if (!account) return;
    const providerKey = resolveProviderApiKey(account.user.id);
    const result = await testProviderConnectivity({
      baseUrl: providerKey.provider.baseUrl,
      model: providerKey.provider.model,
      apiKey: providerKey.apiKey,
    });
    res.json({ ...result, providerId: providerKey.providerId, keySource: providerKey.source || null });
  });

  app.get("/api/admin/payment-config", async (req, res) => {
    const account = await requireAdmin(req, res);
    if (!account) return;
    res.json({ paymentCapabilities: paymentCapabilities(), paymentConfig: paymentConfigStatus() });
  });

  app.get("/api/packages", (_req, res) => {
    res.json({ packages: getEnabledPackages(), paymentCapabilities: paymentCapabilities() });
  });

  // ---------- 文件管理：服务器 3 天暂存 + 账号自己的 WebDAV 云盘 ----------

  app.get("/api/me/storage", async (req, res) => {
    const account = await requireAccount(req, res);
    if (!account) return;
    const results = storageResultsPageForUser(account.user.id, parsePaging(req.query, STORAGE_PAGE_SIZE));
    res.json({
      overview: storageOverviewForUser(account.user.id),
      results: results.items,
      resultsPagination: pageMeta(results),
    });
  });

  app.put("/api/me/storage/webdav", async (req, res) => {
    const account = await requireAccount(req, res);
    if (!account) return;
    const body = req.body || {};
    const saved = saveUserStorageSettings(account.user.id, {
      webdavUrl: typeof body.webdavUrl === "string" ? body.webdavUrl : undefined,
      webdavUsername: typeof body.webdavUsername === "string" ? body.webdavUsername : undefined,
      webdavPassword: typeof body.webdavPassword === "string" ? body.webdavPassword : undefined,
      webdavDirectory: typeof body.webdavDirectory === "string" ? body.webdavDirectory : undefined,
      webdavEnabled: typeof body.webdavEnabled === "boolean" ? body.webdavEnabled : undefined,
      autoArchive: typeof body.autoArchive === "boolean" ? body.autoArchive : undefined,
    });
    if (saved.error) {
      res.status(400).json({ error: saved.error });
      return;
    }
    insertAudit({
      actorUserId: account.user.id,
      action: "user.storage.webdav",
      targetType: "user",
      targetId: account.user.id,
      detail: { enabled: saved.settings.webdavEnabled, autoArchive: saved.settings.autoArchive, host: saved.settings.webdavUrl },
    });
    res.json({ overview: storageOverviewForUser(account.user.id) });
  });

  app.post("/api/me/storage/webdav/test", async (req, res) => {
    const account = await requireAccount(req, res);
    if (!account) return;
    const body = req.body || {};
    res.json(
      await testWebdavConnection(account.user.id, {
        webdavUrl: typeof body.webdavUrl === "string" ? body.webdavUrl : undefined,
        webdavUsername: typeof body.webdavUsername === "string" ? body.webdavUsername : undefined,
        webdavPassword: typeof body.webdavPassword === "string" ? body.webdavPassword : undefined,
        webdavDirectory: typeof body.webdavDirectory === "string" ? body.webdavDirectory : undefined,
      }),
    );
  });

  app.post("/api/generation-results/:id/archive", async (req, res) => {
    try {
      const account = await requireAccount(req, res);
      if (!account) return;
      const outcome = await archiveResultToWebdav(account.user.id, req.params.id);
      if (outcome.error) {
        res.status(outcome.status || 400).json({ error: outcome.error });
        return;
      }
      insertAudit({
        actorUserId: account.user.id,
        action: "generation_result.archive",
        targetType: "generated_result",
        targetId: req.params.id,
        detail: { archivePath: outcome.archivePath },
      });
      res.json({ result: serializeGeneratedResult(sqlite.prepare("SELECT * FROM generated_result WHERE id = ?").get(req.params.id)) });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : "归档失败。" });
    }
  });

  app.post("/api/me/storage/archive-all", async (req, res) => {
    try {
      const account = await requireAccount(req, res);
      if (!account) return;
      const summary = await archivePendingResults(account.user.id);
      const results = storageResultsPageForUser(account.user.id, parsePaging(req.query, STORAGE_PAGE_SIZE));
      res.json({
        summary,
        overview: storageOverviewForUser(account.user.id),
        results: results.items,
        resultsPagination: pageMeta(results),
      });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : "批量归档失败。" });
    }
  });

  app.get("/api/admin/storage", async (req, res) => {
    const account = await requireAdmin(req, res);
    if (!account) return;
    res.json({ storage: await storageAdminOverview() });
  });

  app.post("/api/admin/storage/maintenance", async (req, res) => {
    try {
      const account = await requireAdmin(req, res);
      if (!account) return;
      const summary = await runStorageMaintenance();
      insertAudit({ actorUserId: account.user.id, action: "storage.maintenance", targetType: "system", targetId: null, detail: summary });
      res.json({ summary, storage: await storageAdminOverview() });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : "清理失败。" });
    }
  });

  app.delete("/api/generation-results/:id", async (req, res) => {
    try {
      const account = await requireAccount(req, res);
      if (!account) return;
      const result = sqlite.prepare("SELECT * FROM generated_result WHERE id = ?").get(req.params.id);
      const canDelete = result && (result.user_id === account.user.id || isAdminRole(account.profile.role));
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
    if (order.user_id !== account.user.id && !isAdminRole(account.profile.role)) {
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

  // ---------- 前端异常上报 ----------
  //
  // 白屏、崩溃这类问题的现场在用户浏览器里，服务端日志一点痕迹都没有。
  // 这里收一份最简信息：一句话 + 调用栈 + 页面地址，写进服务日志（journalctl -u clothdesign），
  // 顺带在内存里留最近 50 条给后台看。不入库、不落盘，重启就没了，够定位就行。

  app.post("/api/client-errors", async (req, res) => {
    const body = req.body || {};
    const message = String(body.message ?? "").slice(0, 500).trim();
    if (!message) {
      res.status(400).json({ error: "缺少错误信息。" });
      return;
    }
    if (clientErrorRateLimited(req.ip || req.socket?.remoteAddress || "unknown")) {
      res.status(429).end();
      return;
    }
    // 谁报的能拿到就记，拿不到（比如没登录）也照收。
    let userId = null;
    try {
      const session = await getAuthSession(req);
      userId = session?.user?.id ?? null;
    } catch {
      userId = null;
    }
    const entry = {
      at: nowIso(),
      scope: String(body.scope ?? "unknown").slice(0, 40),
      message,
      stack: body.stack ? String(body.stack).slice(0, 2000) : null,
      url: String(body.url ?? "").slice(0, 300),
      detail: body.detail && typeof body.detail === "object" ? body.detail : null,
      userId,
      userAgent: String(req.headers["user-agent"] ?? "").slice(0, 300),
    };
    recordClientError(entry);
    console.warn(`[client-error] ${entry.at} | ${entry.scope} | ${entry.message} | ${entry.url} | user=${entry.userId ?? "-"}`);
    if (entry.detail) console.warn(`[client-error] detail ${JSON.stringify(entry.detail)}`);
    res.status(204).end();
  });

  app.get("/api/admin/client-errors", async (req, res) => {
    const account = await requireAdmin(req, res);
    if (!account) return;
    res.json({ errors: recentClientErrors() });
  });

  app.get("/api/admin/overview", async (req, res) => {
    const account = await requireAdmin(req, res);
    if (!account) return;
    markExpiredOrdersClosed();
    // 首屏只给每个列表的第一页 + 总数，后面的页由各自的分页接口按需拉。
    const paging = parsePaging(req.query);
    const users = adminUsersPage(paging);
    const orders = adminOrdersPage(paging);
    const paymentEvents = adminPaymentEventsPage(paging);
    const ledger = adminLedgerPage(paging);
    const generationResults = adminGenerationResultsPage(parsePaging(req.query, ADMIN_RESULT_PAGE_SIZE));
    res.json({
      summary: adminSummary(),
      imageProvider: imageProviderSettings(),
      imageProviders: publicImageProviders(),
      users: users.items,
      packages: getAllPackages(),
      orders: orders.items,
      paymentEvents: paymentEvents.items,
      ledger: ledger.items,
      generationResults: generationResults.items,
      // 每个列表的分页游标，前端据此画页码；items 已经在上面单独给了，这里不重复带。
      pagination: {
        users: pageMeta(users),
        orders: pageMeta(orders),
        paymentEvents: pageMeta(paymentEvents),
        ledger: pageMeta(ledger),
        generationResults: pageMeta(generationResults),
      },
      paymentCapabilities: paymentCapabilities(),
      paymentConfig: paymentConfigStatus(),
      storage: await storageAdminOverview(),
    });
  });

  app.get("/api/admin/users", async (req, res) => {
    const account = await requireAdmin(req, res);
    if (!account) return;
    res.json(
      adminUsersPage({
        ...parsePaging(req.query),
        keyword: req.query?.q,
        filter: typeof req.query?.filter === "string" ? req.query.filter : "all",
      }),
    );
  });

  app.get("/api/admin/orders", async (req, res) => {
    const account = await requireAdmin(req, res);
    if (!account) return;
    markExpiredOrdersClosed();
    res.json(adminOrdersPage(parsePaging(req.query)));
  });

  app.get("/api/admin/payment-events", async (req, res) => {
    const account = await requireAdmin(req, res);
    if (!account) return;
    res.json(adminPaymentEventsPage(parsePaging(req.query)));
  });

  app.get("/api/admin/ledger", async (req, res) => {
    const account = await requireAdmin(req, res);
    if (!account) return;
    res.json(adminLedgerPage(parsePaging(req.query)));
  });

  app.get("/api/admin/generation-results", async (req, res) => {
    const account = await requireAdmin(req, res);
    if (!account) return;
    res.json(adminGenerationResultsPage(parsePaging(req.query, ADMIN_RESULT_PAGE_SIZE)));
  });

  app.patch("/api/admin/users/:id", async (req, res) => {
    const account = await requireAdmin(req, res);
    if (!account) return;
    const allowedStatus = new Set(["active", "locked"]);
    const current = getProfileWithUser(req.params.id);
    if (!current) {
      res.status(404).json({ error: "用户不存在。" });
      return;
    }
    // 角色不开放修改：后台只有 admin 这一个账号能进，别的账号一律普通用户。
    // 之前下拉框误点一下就把人提成管理员/把自己降成普通用户，两头都出过事。
    if (typeof req.body.role === "string" && req.body.role !== current.role) {
      res.status(400).json({ error: "账号角色不能改：后台只允许 admin 这一个账号进入。" });
      return;
    }
    const nextRole = current.role;
    const nextStatus = req.body.status && allowedStatus.has(req.body.status) ? req.body.status : current.status;
    const isSelf = req.params.id === account.user.id;
    if (isSelf && nextStatus === "locked") {
      res.status(400).json({ error: "不能锁定自己的账号。" });
      return;
    }
    const nextPlan = typeof req.body.plan === "string" && req.body.plan.trim() ? req.body.plan.trim().slice(0, 40) : current.plan;
    const nextName =
      typeof req.body.name === "string" && req.body.name.trim() ? req.body.name.trim().slice(0, 80) : current.display_name;
    const nextApproved = typeof req.body.approved === "boolean" ? (req.body.approved ? 1 : 0) : Number(current.approved ?? 1);
    const nextUnlimited = typeof req.body.unlimited === "boolean" ? (req.body.unlimited ? 1 : 0) : Number(current.unlimited ?? 0);
    const nextApiProviderId =
      req.body.apiProviderId === undefined
        ? (isValidProviderId(current.api_provider_id) ? current.api_provider_id : "default")
        : (isValidProviderId(req.body.apiProviderId) ? req.body.apiProviderId : "");
    if (!nextApiProviderId) {
      res.status(400).json({ error: "图像供应商不存在。" });
      return;
    }
    // 分辨率上限：空串 = 跟随线路自己的能力，不写死在账号上。
    let nextMaxResolution = normalizeResolution(current.max_resolution, "") || null;
    if (req.body.maxResolutionSetting !== undefined) {
      const raw = String(req.body.maxResolutionSetting ?? "").trim();
      if (raw && !RESOLUTION_KEYS.includes(raw)) {
        res.status(400).json({ error: "分辨率上限只能是 1K / 2K / 4K，或留空跟随线路。" });
        return;
      }
      nextMaxResolution = raw || null;
    }
    // 先撤销会话再落锁；即使后续数据库写入失败，也不能让已要求锁定的账号继续保持登录。
    if (nextStatus === "locked") {
      const ctx = await auth.$context;
      await ctx.internalAdapter.deleteSessions(req.params.id);
    }
    sqlite
      .prepare(
        "UPDATE user_profile SET display_name = ?, role = ?, plan = ?, status = ?, approved = ?, unlimited = ?, api_provider_id = ?, max_resolution = ?, updated_at = ? WHERE user_id = ?",
      )
      .run(
        nextName,
        nextRole,
        nextPlan,
        nextStatus,
        nextApproved,
        nextUnlimited,
        nextApiProviderId,
        nextMaxResolution,
        nowIso(),
        req.params.id,
      );
    insertAudit({
      actorUserId: account.user.id,
      action: "user.update",
      targetType: "user",
      targetId: req.params.id,
      detail: {
        role: nextRole,
        status: nextStatus,
        plan: nextPlan,
        name: nextName,
        approved: Boolean(nextApproved),
        unlimited: Boolean(nextUnlimited),
        apiProviderId: nextApiProviderId,
        maxResolution: nextMaxResolution || "跟随线路",
      },
    });
    res.json({ user: serializeAdminUser(getProfileWithUser(req.params.id)) });
  });

  /**
   * 后台建号：不走自助注册端点，所以关掉 ALLOW_SELF_SIGNUP 之后这条路依然可用。
   * signUpEmail 只负责建 better-auth 的用户和密码，业务侧的角色/开通/额度在这里补齐。
   */
  app.post("/api/admin/users", async (req, res) => {
    const account = await requireAdmin(req, res);
    if (!account) return;
    const normalized = normalizeUsername(req.body?.username ?? req.body?.email);
    if (normalized.error) {
      res.status(400).json({ error: normalized.error });
      return;
    }
    const username = normalized.value;
    const email = usernameToEmail(username);
    const password = String(req.body?.password || "");
    const name = String(req.body?.name || "").trim().slice(0, 80) || username;
    if (password.length < 8) {
      res.status(400).json({ error: "密码至少 8 位。" });
      return;
    }
    // 管理员可以在建号时就把这个账号要用的图像接口 Key 配好，对方登录即可用。
    let presetKey = "";
    const apiProviderId = isValidProviderId(req.body?.apiProviderId) ? req.body.apiProviderId : "default";
    if (String(req.body?.apiKey || "").trim()) {
      const key = normalizeApiKey(req.body.apiKey);
      if (key.error) {
        res.status(400).json({ error: key.error });
        return;
      }
      presetKey = key.value;
    }
    const exists = sqlite.prepare('SELECT id FROM "user" WHERE lower(email) = ?').get(email);
    if (exists) {
      res.status(409).json({ error: "这个账号名已经被占用了。" });
      return;
    }
    try {
      const created = await auth.api.signUpEmail({ body: { name, email, password } });
      const userId = created?.user?.id;
      if (!userId) throw new Error("创建账号失败。");
      // signUpEmail 只建 better-auth 的用户；业务档案是首次登录时才补的，
      // 这里先手动建出来，否则下面的 UPDATE 命中 0 行、新号还得等自己开通。
      ensureUserProfile({ id: userId, email, name });
      // 后台发的号一律是普通用户，保证只有管理员账号能进 /admin。
      const role = "user";
      const unlimited = req.body?.unlimited === true ? 1 : 0;
      const credits = Number.isFinite(Number(req.body?.credits)) ? Math.max(0, Math.floor(Number(req.body.credits))) : 0;
      // 后台建的号默认直接可用，不用再点一次开通。
      sqlite
        .prepare(
          `UPDATE user_profile
           SET display_name = ?, role = ?, approved = 1, unlimited = ?, credits = ?, updated_at = ?
           WHERE user_id = ?`,
        )
        .run(name, role, unlimited, credits, nowIso(), userId);
      setUserApiProvider(userId, apiProviderId);
      if (presetKey) setUserApiKey(userId, presetKey, apiProviderId);
      insertAudit({
        actorUserId: account.user.id,
        action: "user.create",
        targetType: "user",
        targetId: userId,
        detail: { username, role, unlimited: Boolean(unlimited), credits, apiKey: presetKey ? "preset" : "none", apiProviderId },
      });
      res.status(201).json({ user: serializeAdminUser(getProfileWithUser(userId)) });
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : "创建账号失败。" });
    }
  });

  /** 给某个账号配 / 清图像接口 Key。配好之后对方登录就能直接用，不用自己填。 */
  app.put("/api/admin/users/:id/api-key", async (req, res) => {
    const account = await requireAdmin(req, res);
    if (!account) return;
    const target = getProfileWithUser(req.params.id);
    if (!target) {
      res.status(404).json({ error: "用户不存在。" });
      return;
    }
    const raw = String(req.body?.apiKey ?? "").trim();
    if (!raw) {
      clearUserApiKey(req.params.id);
      insertAudit({ actorUserId: account.user.id, action: "user.api_key.clear", targetType: "user", targetId: req.params.id, detail: {} });
      res.json({ user: serializeAdminUser(getProfileWithUser(req.params.id)) });
      return;
    }
    const key = normalizeApiKey(raw);
    if (key.error) {
      res.status(400).json({ error: key.error });
      return;
    }
    const providerId = req.body?.providerId ?? target.api_provider_id ?? "default";
    if (!isValidProviderId(providerId)) {
      res.status(400).json({ error: "图像供应商不存在。" });
      return;
    }
    const saved = setUserApiKey(req.params.id, key.value, providerId);
    insertAudit({ actorUserId: account.user.id, action: "user.api_key.set", targetType: "user", targetId: req.params.id, detail: { hint: saved.apiKeyHint } });
    res.json({ user: serializeAdminUser(getProfileWithUser(req.params.id)) });
  });

  /** 重置某个账号的密码。没有配邮件服务，忘密码只能由管理员在这里改。 */
  app.post("/api/admin/users/:id/password", async (req, res) => {
    const account = await requireAdmin(req, res);
    if (!account) return;
    const password = String(req.body?.password || "");
    if (password.length < 8) {
      res.status(400).json({ error: "密码至少 8 位。" });
      return;
    }
    const target = getProfileWithUser(req.params.id);
    if (!target) {
      res.status(404).json({ error: "用户不存在。" });
      return;
    }
    try {
      const ctx = await auth.$context;
      await ctx.internalAdapter.deleteSessions(req.params.id);
      await ctx.internalAdapter.updatePassword(req.params.id, await ctx.password.hash(password));
      insertAudit({
        actorUserId: account.user.id,
        action: "user.password_reset",
        targetType: "user",
        targetId: req.params.id,
        detail: {},
      });
      res.json({ ok: true });
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : "重置密码失败。" });
    }
  });

  /** 图像接口地址 / 模型名。留空某一项 = 恢复 .env 里的默认值。改完立刻生效，不用重启。 */
  app.get("/api/admin/image-provider", async (req, res) => {
    const account = await requireAdmin(req, res);
    if (!account) return;
    res.json({ imageProvider: { ...imageProviderSettings(), ...sharedProviderApiKeyStatus() } });
  });

  app.put("/api/admin/image-provider", async (req, res) => {
    const account = await requireAdmin(req, res);
    if (!account) return;
    const apiKey = String(req.body?.apiKey ?? "").trim();
    if (apiKey) {
      const normalizedKey = normalizeApiKey(apiKey);
      if (normalizedKey.error) {
        res.status(400).json({ error: normalizedKey.error });
        return;
      }
    }
    const result = saveImageProviderSettings({ providerId: req.body?.providerId, baseUrl: req.body?.baseUrl, model: req.body?.model });
    if (result.error) {
      res.status(400).json({ error: result.error });
      return;
    }
    const keyStatus = apiKey
      ? setSharedProviderApiKey(result.settings.id, apiKey)
      : sharedProviderApiKeyStatus(result.settings.id);
    insertAudit({
      actorUserId: account.user.id,
      action: "image_provider.update",
      targetType: "app_config",
      targetId: result.settings.id,
      detail: {
        providerId: result.settings.id,
        baseUrl: result.settings.baseUrl,
        model: result.settings.model,
        apiKey: apiKey ? "updated" : "unchanged",
      },
    });
    res.json({ imageProvider: { ...result.settings, ...keyStatus } });
  });

  /** 积分规则：后台改一次，所有人的报价和服务端扣费都按新规则来。 */
  app.put("/api/admin/credit-policy", async (req, res) => {
    const account = await requireAdmin(req, res);
    if (!account) return;
    const result = saveCreditPolicy(req.body?.creditPolicy ?? req.body ?? {});
    if (result.error) {
      res.status(400).json({ error: result.error });
      return;
    }
    insertAudit({ actorUserId: account.user.id, action: "credit_policy.update", targetType: "app_config", targetId: "credit_policy", detail: result.value });
    res.json({ creditPolicy: result.value });
  });

  /** 系统提示词模板：按模式覆盖内置模板；传 null 恢复默认。 */
  app.put("/api/admin/system-prompts", async (req, res) => {
    const account = await requireAdmin(req, res);
    if (!account) return;
    const result = saveSystemPrompts(req.body?.systemPrompts ?? {});
    if (result.error) {
      res.status(400).json({ error: result.error });
      return;
    }
    insertAudit({
      actorUserId: account.user.id,
      action: "system_prompts.update",
      targetType: "app_config",
      targetId: "system_prompts",
      detail: { modes: Object.keys(req.body?.systemPrompts ?? {}) },
    });
    res.json({ systemPrompts: result.value });
  });

  app.delete("/api/admin/image-provider", async (req, res) => {
    const account = await requireAdmin(req, res);
    if (!account) return;
    const settings = resetImageProviderSettings(req.body?.providerId);
    if (!settings) {
      res.status(400).json({ error: "图像供应商不存在。" });
      return;
    }
    insertAudit({
      actorUserId: account.user.id,
      action: "image_provider.reset",
      targetType: "app_config",
      targetId: settings.id,
      detail: { providerId: settings.id },
    });
    res.json({ imageProvider: { ...settings, ...sharedProviderApiKeyStatus(settings.id) } });
  });

  app.delete("/api/admin/image-provider/key", async (req, res) => {
    const account = await requireAdmin(req, res);
    if (!account) return;
    const providerId = req.body?.providerId ?? "default";
    const status = clearSharedProviderApiKey(providerId);
    if (status.error) {
      res.status(400).json({ error: status.error });
      return;
    }
    const settings = imageProviderSettings(providerId);
    insertAudit({
      actorUserId: account.user.id,
      action: "image_provider.api_key.clear",
      targetType: "app_config",
      targetId: settings.id,
      detail: { providerId: settings.id },
    });
    res.json({ imageProvider: { ...settings, ...status } });
  });

  /**
   * 连通性自检：拿当前地址 + Key 打一下 /models。
   * 用 GET /models 是因为它不产图、不花钱，只验证地址和 Key 对不对。
   */
  app.post("/api/admin/image-provider/test", async (req, res) => {
    const account = await requireAdmin(req, res);
    if (!account) return;
    const providerId = req.body?.providerId ?? "default";
    if (!isValidProviderId(providerId)) {
      res.status(400).json({ error: "图像供应商不存在。" });
      return;
    }
    const settings = imageProviderSettings(providerId);
    const apiKey = serverApiKey(providerId);
    const result = await testProviderConnectivity({ baseUrl: settings.baseUrl, model: settings.model, apiKey });
    res.json(result);
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
