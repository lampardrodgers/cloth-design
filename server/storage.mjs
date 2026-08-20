import fs from "node:fs/promises";
import path from "node:path";
import { nowIso, sqlite } from "./db.mjs";
import {
  deleteManagedGeneratedImage,
  generatedImageStaticMount,
  isManagedGeneratedImageUrl,
  readManagedGeneratedImage,
} from "./image-provider.mjs";
import { referencedGeneratedImageUrls } from "./image-cleanup.mjs";
import { decryptApiKey, encryptApiKey } from "./user-keys.mjs";
import { fetchWithTimeout, timeoutMsFromEnv } from "./timeouts.mjs";

/**
 * 成片文件的生命周期，三层各管各的：
 *   1. 服务器（VPS）暂存：固定 3 天，写死不给改。生成完文件落在服务器上，
 *      到期由 runStorageMaintenance 删文件、把记录标成 expired（记录本身留着，能看到是否有云盘备份）。
 *   2. 本地文件夹：浏览器端 File System Access API 直接写到用户电脑上，服务端不参与。
 *   3. WebDAV 云盘：每个账号自己配（坚果云等），密码加密落库；自动归档开着就生成完立刻推上去，
 *      也可以在文件管理里手动推。
 */

export const SERVER_RETENTION_DAYS = 3;
export const SERVER_RETENTION_MS = SERVER_RETENTION_DAYS * 24 * 60 * 60 * 1000;
/**
 * 用户上传到服务器上的东西（参考图 / 素材 / 音乐）最多留这么久：
 * 上传的是用户自己的文件，本站只是代传给模型 / 引擎，用完就该清，不能在服务器上越积越多。
 * 各模块（Seedance 参考素材、文案成片的本地素材 / 音乐）都按这一个数来，别各写各的。
 */
export const UPLOAD_RETENTION_HOURS = 24;
export const UPLOAD_RETENTION_MS = UPLOAD_RETENTION_HOURS * 60 * 60 * 1000;
/** 数据库里已经没人引用的孤儿文件，超过这个时长就清掉。 */
const ORPHAN_FILE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * 其他模块（Seedance 成片 / 文案成片 / 各自的上传）把自己的到期清理挂进来，
 * 跟成片图一起每小时跑一次，后台也只看一份巡检结果。
 * 钩子签名：async ({ now, dryRun }) => summary（随便什么对象，会原样放进 summary.modules[name]）。
 */
const maintenanceHooks = new Map();

export function registerStorageMaintenanceHook(name, hook) {
  if (typeof hook !== "function") throw new TypeError("storage maintenance hook must be a function");
  maintenanceHooks.set(String(name), hook);
  return () => maintenanceHooks.delete(String(name));
}
const WEBDAV_TIMEOUT_MS = timeoutMsFromEnv("WEBDAV_TIMEOUT_MS", 30_000);
const DEFAULT_DIRECTORY = "ClothDesign";

let lastMaintenance = null;

export function resultExpiresAt(createdAt) {
  const created = Date.parse(createdAt);
  if (!Number.isFinite(created)) return null;
  return new Date(created + SERVER_RETENTION_MS).toISOString();
}

// ---------- 账号级 WebDAV 配置 ----------

export function normalizeWebdavUrl(raw) {
  const value = String(raw ?? "").trim();
  if (!value) return { value: "" };
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return { error: "WebDAV 地址不是合法的 URL，要带 http:// 或 https://。" };
  }
  if (!["http:", "https:"].includes(parsed.protocol)) return { error: "WebDAV 地址只支持 http 或 https。" };
  if (!parsed.hostname) return { error: "WebDAV 地址缺少域名。" };
  return { value: `${parsed.origin}${parsed.pathname}`.replace(/\/+$/, "") };
}

export function normalizeWebdavDirectory(raw) {
  const value = String(raw ?? "")
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\/+|\/+$/g, "");
  if (!value) return { value: DEFAULT_DIRECTORY };
  const segments = value.split("/").filter(Boolean);
  if (segments.some((segment) => segment === "." || segment === "..")) return { error: "目录里不能有 . 或 .. 这样的片段。" };
  if (value.length > 200) return { error: "目录太长了。" };
  return { value: segments.join("/") };
}

function readStorageRow(userId) {
  return sqlite.prepare("SELECT * FROM user_storage WHERE user_id = ?").get(userId) || null;
}

function decryptPassword(row) {
  if (!row?.webdav_password_encrypted) return "";
  try {
    return decryptApiKey(row.webdav_password_encrypted);
  } catch {
    return "";
  }
}

/** 给前端看的配置：密码永远不回传，只说有没有。 */
export function userStorageSettings(userId) {
  const row = readStorageRow(userId);
  return {
    webdavUrl: row?.webdav_url || "",
    webdavUsername: row?.webdav_username || "",
    webdavDirectory: row?.webdav_directory || DEFAULT_DIRECTORY,
    webdavEnabled: Number(row?.webdav_enabled ?? 0) === 1,
    autoArchive: Number(row?.auto_archive ?? 0) === 1,
    hasPassword: Boolean(row?.webdav_password_encrypted),
    lastError: row?.last_error || null,
    lastErrorAt: row?.last_error_at || null,
    lastArchivedAt: row?.last_archived_at || null,
    updatedAt: row?.updated_at || null,
  };
}

/** 服务端内部用：带明文密码，只在真正连云盘的一刻解开。 */
export function userWebdavCredentials(userId) {
  const row = readStorageRow(userId);
  if (!row) return null;
  return {
    url: row.webdav_url,
    username: row.webdav_username,
    password: decryptPassword(row),
    directory: row.webdav_directory || DEFAULT_DIRECTORY,
    enabled: Number(row.webdav_enabled) === 1,
    autoArchive: Number(row.auto_archive) === 1,
  };
}

/**
 * 保存账号的 WebDAV 配置。password 传 undefined 表示不动原密码，传空串表示清掉。
 * 开启「启用」时地址和账号必须齐。
 */
export function saveUserStorageSettings(userId, input = {}) {
  const current = readStorageRow(userId);
  const url = normalizeWebdavUrl(input.webdavUrl ?? current?.webdav_url ?? "");
  if (url.error) return { error: url.error };
  const directory = normalizeWebdavDirectory(input.webdavDirectory ?? current?.webdav_directory ?? DEFAULT_DIRECTORY);
  if (directory.error) return { error: directory.error };
  const username = String(input.webdavUsername ?? current?.webdav_username ?? "").trim();
  if (username.length > 200) return { error: "账号太长了。" };

  let passwordEncrypted = current?.webdav_password_encrypted || null;
  if (typeof input.webdavPassword === "string") {
    const password = input.webdavPassword;
    if (password.length > 400) return { error: "密码太长了。" };
    passwordEncrypted = password ? encryptApiKey(password) : null;
  }

  const enabled = typeof input.webdavEnabled === "boolean" ? input.webdavEnabled : Number(current?.webdav_enabled ?? 0) === 1;
  const autoArchive = typeof input.autoArchive === "boolean" ? input.autoArchive : Number(current?.auto_archive ?? 0) === 1;
  if (enabled && !url.value) return { error: "启用 WebDAV 前先填远程地址。" };
  if (enabled && !username) return { error: "启用 WebDAV 前先填账号。" };
  if (enabled && !passwordEncrypted) return { error: "启用 WebDAV 前先填密码（坚果云等网盘要用「应用密码」，不是登录密码）。" };

  const timestamp = nowIso();
  sqlite
    .prepare(
      `INSERT INTO user_storage
         (user_id, webdav_url, webdav_username, webdav_password_encrypted, webdav_directory, webdav_enabled, auto_archive, last_error, last_error_at, last_archived_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET
         webdav_url = excluded.webdav_url,
         webdav_username = excluded.webdav_username,
         webdav_password_encrypted = excluded.webdav_password_encrypted,
         webdav_directory = excluded.webdav_directory,
         webdav_enabled = excluded.webdav_enabled,
         auto_archive = excluded.auto_archive,
         last_error = NULL,
         last_error_at = NULL,
         updated_at = excluded.updated_at`,
    )
    .run(
      userId,
      url.value,
      username,
      passwordEncrypted,
      directory.value,
      enabled ? 1 : 0,
      autoArchive && enabled ? 1 : 0,
      current?.last_archived_at || null,
      timestamp,
    );
  return { settings: userStorageSettings(userId) };
}

export function recordWebdavError(userId, message) {
  const timestamp = nowIso();
  sqlite
    .prepare("UPDATE user_storage SET last_error = ?, last_error_at = ?, updated_at = updated_at WHERE user_id = ?")
    .run(String(message || "").slice(0, 300), timestamp, userId);
}

// ---------- WebDAV 客户端（只用到 MKCOL / PUT / PROPFIND，原生 fetch 就够） ----------

function encodeRemotePath(remotePath) {
  return String(remotePath)
    .split("/")
    .filter(Boolean)
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

function davUrl(credentials, remotePath = "") {
  const base = credentials.url.replace(/\/+$/, "");
  const encoded = encodeRemotePath(remotePath);
  return encoded ? `${base}/${encoded}` : base;
}

function davHeaders(credentials, extra = {}) {
  const token = Buffer.from(`${credentials.username}:${credentials.password}`, "utf8").toString("base64");
  return { Authorization: `Basic ${token}`, ...extra };
}

async function davRequest(credentials, method, remotePath, { body, headers } = {}) {
  return fetchWithTimeout(
    davUrl(credentials, remotePath),
    { method, headers: davHeaders(credentials, headers), body },
    { timeoutMs: WEBDAV_TIMEOUT_MS, timeoutMessage: "连接 WebDAV 超时。" },
  );
}

function describeDavFailure(status, action) {
  if (status === 401 || status === 403) return `WebDAV 拒绝了${action}（${status}）：账号或密码不对。坚果云等网盘要用「应用密码」。`;
  if (status === 404) return `WebDAV ${action}失败（404）：远程地址不存在，检查地址是否填对。`;
  if (status === 507) return `WebDAV ${action}失败（507）：云盘空间不够了。`;
  return `WebDAV ${action}失败（${status}）。`;
}

/** 逐级 MKCOL：201 新建、405 已存在都算成功；其余当错误。 */
export async function ensureRemoteDirectory(credentials, directory) {
  const segments = String(directory).split("/").filter(Boolean);
  let current = "";
  for (const segment of segments) {
    current = current ? `${current}/${segment}` : segment;
    const response = await davRequest(credentials, "MKCOL", current);
    if ([201, 405, 200, 204, 301, 302].includes(response.status)) continue;
    // 有的服务对已存在的目录返回 409/412，再用 PROPFIND 确认一次
    const probe = await davRequest(credentials, "PROPFIND", current, { headers: { Depth: "0" } });
    if (probe.status === 207 || probe.status === 200) continue;
    throw new Error(describeDavFailure(response.status, `建目录 ${current}`));
  }
}

export async function putRemoteFile(credentials, remotePath, buffer, mimeType) {
  const response = await davRequest(credentials, "PUT", remotePath, {
    body: buffer,
    headers: { "Content-Type": mimeType || "application/octet-stream", "Content-Length": String(buffer.length) },
  });
  if (![200, 201, 204].includes(response.status)) {
    throw new Error(describeDavFailure(response.status, `上传 ${path.posix.basename(remotePath)}`));
  }
}

/** 测试连接：能读到根目录 + 能在目标目录里建目录，就算通。 */
export async function testWebdavConnection(userId, override = {}) {
  const stored = userWebdavCredentials(userId) || {};
  const url = normalizeWebdavUrl(override.webdavUrl ?? stored.url ?? "");
  if (url.error) return { ok: false, message: url.error };
  if (!url.value) return { ok: false, message: "先填远程地址。" };
  const directory = normalizeWebdavDirectory(override.webdavDirectory ?? stored.directory ?? DEFAULT_DIRECTORY);
  if (directory.error) return { ok: false, message: directory.error };
  const credentials = {
    url: url.value,
    username: String(override.webdavUsername ?? stored.username ?? "").trim(),
    password: typeof override.webdavPassword === "string" && override.webdavPassword ? override.webdavPassword : stored.password || "",
    directory: directory.value,
  };
  if (!credentials.username || !credentials.password) return { ok: false, message: "先填账号和密码再测试。" };
  try {
    const probe = await davRequest(credentials, "PROPFIND", "", { headers: { Depth: "0" } });
    if (![207, 200].includes(probe.status)) return { ok: false, message: describeDavFailure(probe.status, "读取根目录") };
    await ensureRemoteDirectory(credentials, credentials.directory);
    return { ok: true, message: `连接成功，成片会归档到 ${credentials.directory}/ 下按日期分的目录里。` };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : "连接失败。" };
  }
}

// ---------- 归档 ----------

export function safeFileStem(title) {
  const cleaned = String(title || "image")
    .replace(/[\\/:*?"<>|\u0000-\u001f ]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80);
  return cleaned || "image";
}

/** 云盘上的路径：<目录>/<YYYY-MM-DD>/<标题>-<结果id尾6位>.<ext> */
export function archiveRemotePath(row, directory, extension) {
  const day = String(row.created_at || nowIso()).slice(0, 10);
  const suffix = String(row.id).replace(/[^a-z0-9]/gi, "").slice(-6) || "0";
  return `${directory}/${day}/${safeFileStem(row.title)}-${suffix}.${extension}`;
}

async function loadResultFile(row) {
  if (!isManagedGeneratedImageUrl(row.image_url)) {
    // 演示模式的占位图是内嵌 SVG，没有实际文件；外链图片这里也不代传。
    throw new Error("这张成片没有服务器上的原文件（演示占位图或外链），不能归档。");
  }
  const file = await readManagedGeneratedImage(row.image_url);
  const extension = path.extname(row.image_url).replace(/^\./, "").toLowerCase() || "png";
  return { ...file, extension };
}

/**
 * 给其他模块用的通用归档：把一个本地文件推到该账号的云盘，路径规则和成片图一致
 * （<目录>/<YYYY-MM-DD>/<标题>-<id 尾 6 位>.<ext>）。成功返回 { archivedAt, archivePath }，失败返回 { error, status }。
 * 不碰调用方自己的表——状态怎么记由调用方决定。
 */
export async function archiveFileToUserWebdav(userId, { filePath, title, id, createdAt, extension, mimeType, subdirectory = "" }) {
  const credentials = userWebdavCredentials(userId);
  if (!credentials?.enabled) return { error: "还没有启用 WebDAV，先到文件管理里填好云盘再试。", status: 400 };
  if (!credentials.password) return { error: "WebDAV 密码读不出来（可能是服务端密钥换过），请重新保存一次。", status: 400 };
  let buffer;
  try {
    buffer = await fs.readFile(filePath);
  } catch {
    return { error: "服务器上的文件已经不在了，没法归档。", status: 409 };
  }
  const directory = subdirectory ? `${credentials.directory}/${String(subdirectory).replace(/^\/+|\/+$/g, "")}` : credentials.directory;
  const remotePath = archiveRemotePath({ id, title, created_at: createdAt }, directory, String(extension || "bin").replace(/^\./, ""));
  try {
    await ensureRemoteDirectory(credentials, path.posix.dirname(remotePath));
    await putRemoteFile(credentials, remotePath, buffer, mimeType);
  } catch (error) {
    const message = error instanceof Error ? error.message : "归档失败。";
    recordWebdavError(userId, message);
    return { error: message, status: 502 };
  }
  const timestamp = nowIso();
  sqlite
    .prepare("UPDATE user_storage SET last_archived_at = ?, last_error = NULL, last_error_at = NULL WHERE user_id = ?")
    .run(timestamp, userId);
  return { archivedAt: timestamp, archivePath: remotePath };
}

/** 这个账号开了「生成完自动归档」吗（云盘启用 + 自动归档勾上）。 */
export function userAutoArchiveEnabled(userId) {
  const credentials = userWebdavCredentials(userId);
  return Boolean(credentials?.enabled && credentials.autoArchive && credentials.password);
}

/**
 * 把一条成片推到该账号的 WebDAV。成功后记录 archived_at / archive_path，状态改成 webdav。
 * 服务器上的文件不动——3 天到期照常清，那之后状态是 expired 但 archive_path 还在。
 */
export async function archiveResultToWebdav(userId, resultId) {
  const row = sqlite.prepare("SELECT * FROM generated_result WHERE id = ? AND user_id = ?").get(resultId, userId);
  if (!row) return { error: "生成结果不存在。", status: 404 };
  if (row.expired_at || row.storage_status === "expired") return { error: "服务器上的文件已经过期清理，没法再归档。", status: 409 };
  const credentials = userWebdavCredentials(userId);
  if (!credentials?.enabled) return { error: "还没有启用 WebDAV，先到文件管理里填好云盘再试。", status: 400 };
  if (!credentials.password) return { error: "WebDAV 密码读不出来（可能是服务端密钥换过），请重新保存一次。", status: 400 };

  let file;
  try {
    file = await loadResultFile(row);
  } catch (error) {
    return { error: error instanceof Error ? error.message : "读取文件失败。", status: 400 };
  }
  const remotePath = archiveRemotePath(row, credentials.directory, file.extension);
  try {
    await ensureRemoteDirectory(credentials, path.posix.dirname(remotePath));
    await putRemoteFile(credentials, remotePath, file.buffer, file.mimetype);
  } catch (error) {
    const message = error instanceof Error ? error.message : "归档失败。";
    recordWebdavError(userId, message);
    return { error: message, status: 502 };
  }
  const timestamp = nowIso();
  sqlite
    .prepare("UPDATE generated_result SET storage_status = 'webdav', archived_at = ?, archive_path = ? WHERE id = ?")
    .run(timestamp, remotePath, row.id);
  sqlite
    .prepare("UPDATE user_storage SET last_archived_at = ?, last_error = NULL, last_error_at = NULL WHERE user_id = ?")
    .run(timestamp, userId);
  return { archivedAt: timestamp, archivePath: remotePath };
}

/** 把该账号所有还在服务器上、又没推过云盘的成片一口气归档。 */
export async function archivePendingResults(userId, { limit = 200 } = {}) {
  const rows = sqlite
    .prepare(
      `SELECT id FROM generated_result
       WHERE user_id = ? AND storage_status = 'cloud-temp' AND expired_at IS NULL
       ORDER BY created_at DESC LIMIT ?`,
    )
    .all(userId, limit);
  const summary = { attempted: rows.length, archived: 0, failed: 0, errors: [] };
  for (const row of rows) {
    const outcome = await archiveResultToWebdav(userId, row.id);
    if (outcome.error) {
      summary.failed += 1;
      if (summary.errors.length < 3) summary.errors.push(outcome.error);
      // 连不上就别一条条重试了，浪费时间
      if (outcome.status === 502 || outcome.status === 400) break;
    } else {
      summary.archived += 1;
    }
  }
  return summary;
}

/** 生成完成后的钩子：开了自动归档就把这批成片推上去。失败只记日志，不影响出图。 */
export async function autoArchiveTaskResults(userId, taskId) {
  const credentials = userWebdavCredentials(userId);
  if (!credentials?.enabled || !credentials.autoArchive) return { skipped: true };
  const rows = sqlite
    .prepare("SELECT id FROM generated_result WHERE user_id = ? AND task_id = ? AND storage_status = 'cloud-temp'")
    .all(userId, taskId);
  const summary = { attempted: rows.length, archived: 0, failed: 0 };
  for (const row of rows) {
    const outcome = await archiveResultToWebdav(userId, row.id);
    if (outcome.error) {
      summary.failed += 1;
      console.warn(`[storage] auto archive failed for ${row.id}: ${outcome.error}`);
      if (outcome.status === 502) break;
    } else {
      summary.archived += 1;
    }
  }
  return summary;
}

// ---------- 巡检：到期清理 ----------

function otherReferenceCount(imageUrl, excludeResultId) {
  const generated = sqlite
    .prepare("SELECT COUNT(*) AS count FROM generated_result WHERE image_url = ? AND id != ? AND expired_at IS NULL")
    .get(imageUrl, excludeResultId).count;
  const workflow = sqlite.prepare("SELECT COUNT(*) AS count FROM workflow_result WHERE image_url = ?").get(imageUrl).count;
  const assets = sqlite.prepare("SELECT COUNT(*) AS count FROM workflow_asset WHERE source_url = ?").get(imageUrl).count;
  return generated + workflow + assets;
}

/**
 * 每小时跑一次：
 *   - 超过 3 天的成片：删服务器上的文件（还被别处引用的不删），记录标 expired；
 *   - 数据库里没人引用、且放了一天以上的孤儿文件：直接删。
 */
export async function runStorageMaintenance({ now = Date.now(), dryRun = false } = {}) {
  const cutoff = new Date(now - SERVER_RETENTION_MS).toISOString();
  const rows = sqlite
    .prepare("SELECT * FROM generated_result WHERE expired_at IS NULL AND created_at < ? ORDER BY created_at ASC LIMIT 500")
    .all(cutoff);
  const summary = {
    ranAt: new Date(now).toISOString(),
    retentionDays: SERVER_RETENTION_DAYS,
    expired: 0,
    filesDeleted: 0,
    bytesFreed: 0,
    keptReferenced: 0,
    orphansDeleted: 0,
    dryRun,
  };
  const timestamp = new Date(now).toISOString();
  const markExpired = sqlite.prepare("UPDATE generated_result SET storage_status = 'expired', expired_at = ? WHERE id = ?");
  for (const row of rows) {
    if (isManagedGeneratedImageUrl(row.image_url)) {
      if (otherReferenceCount(row.image_url, row.id) > 0) {
        summary.keptReferenced += 1;
      } else if (!dryRun) {
        const file = await deleteManagedGeneratedImage(row.image_url);
        if (file.deleted) {
          summary.filesDeleted += 1;
          summary.bytesFreed += file.bytes || 0;
        }
      }
    }
    if (!dryRun) markExpired.run(timestamp, row.id);
    summary.expired += 1;
  }

  // 孤儿文件：磁盘上有、数据库里没人引用
  const { directory, publicPath } = generatedImageStaticMount();
  const referenced = new Set(referencedGeneratedImageUrls());
  let entries = [];
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const publicUrl = `${publicPath}/${entry.name}`;
    if (!isManagedGeneratedImageUrl(publicUrl) || referenced.has(publicUrl)) continue;
    const filePath = path.join(directory, entry.name);
    const stats = await fs.stat(filePath).catch(() => null);
    if (!stats || now - stats.mtimeMs < ORPHAN_FILE_MAX_AGE_MS) continue;
    if (!dryRun) await fs.unlink(filePath).catch(() => undefined);
    summary.orphansDeleted += 1;
    summary.bytesFreed += stats.size;
  }

  // 其他模块的到期清理：一个挂钩出错不影响别的，错误记进 summary 里。
  summary.modules = {};
  for (const [name, hook] of maintenanceHooks) {
    try {
      summary.modules[name] = (await hook({ now, dryRun })) ?? {};
    } catch (error) {
      summary.modules[name] = { error: error instanceof Error ? error.message : String(error) };
      console.error(`[storage] maintenance hook ${name} failed`, error);
    }
  }

  lastMaintenance = summary;
  return summary;
}

export function lastMaintenanceSummary() {
  return lastMaintenance;
}

/** 后台看的存储概况：磁盘上有多少文件、多大，各状态多少条。 */
export async function storageAdminOverview() {
  const { directory } = generatedImageStaticMount();
  let fileCount = 0;
  let diskBytes = 0;
  try {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const stats = await fs.stat(path.join(directory, entry.name)).catch(() => null);
      if (!stats) continue;
      fileCount += 1;
      diskBytes += stats.size;
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const counts = sqlite
    .prepare(
      `SELECT
         SUM(CASE WHEN storage_status = 'cloud-temp' THEN 1 ELSE 0 END) AS active,
         SUM(CASE WHEN storage_status = 'webdav' THEN 1 ELSE 0 END) AS archived,
         SUM(CASE WHEN storage_status = 'expired' THEN 1 ELSE 0 END) AS expired,
         SUM(CASE WHEN archive_path IS NOT NULL THEN 1 ELSE 0 END) AS backedUp
       FROM generated_result`,
    )
    .get();
  const webdavUsers = sqlite.prepare("SELECT COUNT(*) AS count FROM user_storage WHERE webdav_enabled = 1").get().count;
  return {
    retentionDays: SERVER_RETENTION_DAYS,
    uploadRetentionHours: UPLOAD_RETENTION_HOURS,
    directory,
    fileCount,
    diskBytes,
    active: Number(counts?.active || 0),
    archived: Number(counts?.archived || 0),
    expired: Number(counts?.expired || 0),
    backedUp: Number(counts?.backedUp || 0),
    webdavUsers,
    lastMaintenance,
  };
}

/** 单个账号在文件管理页看到的概况。 */
export function storageOverviewForUser(userId) {
  const counts = sqlite
    .prepare(
      `SELECT
         SUM(CASE WHEN storage_status = 'cloud-temp' THEN 1 ELSE 0 END) AS active,
         SUM(CASE WHEN storage_status = 'webdav' THEN 1 ELSE 0 END) AS archived,
         SUM(CASE WHEN storage_status = 'expired' THEN 1 ELSE 0 END) AS expired,
         SUM(CASE WHEN storage_status = 'expired' AND archive_path IS NOT NULL THEN 1 ELSE 0 END) AS expiredBackedUp
       FROM generated_result WHERE user_id = ?`,
    )
    .get(userId);
  return {
    retentionDays: SERVER_RETENTION_DAYS,
    uploadRetentionHours: UPLOAD_RETENTION_HOURS,
    active: Number(counts?.active || 0),
    archived: Number(counts?.archived || 0),
    expired: Number(counts?.expired || 0),
    expiredBackedUp: Number(counts?.expiredBackedUp || 0),
    settings: userStorageSettings(userId),
  };
}

/** 启动定时巡检：先等一会儿再跑第一次（让服务先起来），之后每小时一次。 */
export function scheduleStorageMaintenance({ intervalMs = 60 * 60 * 1000, initialDelayMs = 30_000 } = {}) {
  const run = () =>
    runStorageMaintenance()
      .then((summary) => {
        if (summary.expired || summary.orphansDeleted) {
          console.log(`[storage] maintenance: expired ${summary.expired}, files ${summary.filesDeleted}, orphans ${summary.orphansDeleted}`);
        }
        for (const [name, detail] of Object.entries(summary.modules || {})) {
          const touched = Object.values(detail || {}).some((value) => typeof value === "number" && value > 0) || detail?.error;
          if (touched) console.log(`[storage] maintenance ${name}: ${JSON.stringify(detail)}`);
        }
      })
      .catch((error) => console.error("[storage] maintenance failed", error));
  const first = setTimeout(run, initialDelayMs);
  const timer = setInterval(run, intervalMs);
  first.unref?.();
  timer.unref?.();
  return () => {
    clearTimeout(first);
    clearInterval(timer);
  };
}
