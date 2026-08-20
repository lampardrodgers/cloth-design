import { createHash, randomBytes, randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import multer from "multer";
import sharp from "sharp";
import { isAdminRole, requireAccount, requireAdmin } from "./auth.mjs";
import { nowIso, sqlite } from "./db.mjs";
import { ArkError, arkConfigured, createArkTask, deleteArkTask, downloadArkFile, getArkTask, listArkVideoModels, pingArk, probeArkModelAccess } from "./seedance-ark.mjs";
import { saveSeedanceSettings, seedanceSettings, seedanceSettingsView } from "./seedance-settings.mjs";
import { canUseShortVideo } from "./shortvideo.mjs";
import {
  SERVER_RETENTION_DAYS,
  SERVER_RETENTION_MS,
  UPLOAD_RETENTION_HOURS,
  UPLOAD_RETENTION_MS,
  archiveFileToUserWebdav,
  registerStorageMaintenanceHook,
  resultExpiresAt,
  userAutoArchiveEnabled,
} from "./storage.mjs";

/**
 * Seedance 模块：直接调火山方舟的视频生成模型出片（文生 / 图生 / 全模态参考），
 * 和「文案成片」（MoneyPrinterTurbo 拼素材）并列放在「短视频」入口下。
 *
 * 本站负责：账号与权限（和短视频共用一把开关）、参数校验（按模型能力表）、参考素材上传与公网暴露、
 * 任务表、轮询、把成片从方舟的 24 小时临时 URL 拉回本地、后台配置。
 * 方舟那边只是一个异步任务接口，见 server/seedance-ark.mjs。
 *
 * 参数来自官方文档「创建视频生成任务」（2026-08 版），按模型列了能力矩阵；不支持的参数不会发过去，
 * 免得方舟的强校验直接报错。
 */

/* ── 目录：模式 / 画幅 / 分辨率 / 模型能力 ───────────────────────────────── */

export const SEEDANCE_MODES = Object.freeze([
  { id: "text", label: "文生视频", hint: "只给提示词，模型从零出画面" },
  { id: "image", label: "图生视频", hint: "给首帧（可再给中间帧、尾帧），让图动起来" },
  { id: "omni", label: "多模态参考", hint: "给参考图 / 参考视频 / 参考音频，提示词里用 @图像1 @视频1 @音频1 引用；也能编辑、延长已有视频（仅 2.x）" },
]);

export const SEEDANCE_RATIOS = Object.freeze([
  { id: "9:16", label: "竖屏 9:16", hint: "抖音 / 视频号 / Shorts", w: 9, h: 16 },
  { id: "16:9", label: "横屏 16:9", hint: "B 站 / YouTube", w: 16, h: 9 },
  { id: "1:1", label: "方形 1:1", hint: "信息流", w: 1, h: 1 },
  { id: "3:4", label: "竖幅 3:4", hint: "小红书", w: 3, h: 4 },
  { id: "4:3", label: "横幅 4:3", hint: "", w: 4, h: 3 },
  { id: "21:9", label: "超宽 21:9", hint: "电影感", w: 21, h: 9 },
  { id: "adaptive", label: "自动", hint: "跟随首帧 / 参考素材，或由模型按提示词定", w: 0, h: 0 },
]);

export const SEEDANCE_RESOLUTIONS = Object.freeze([
  { id: "480p", label: "480p", hint: "最便宜，适合试镜头" },
  { id: "720p", label: "720p", hint: "默认" },
  { id: "1080p", label: "1080p", hint: "2.5 为 10bit H.265" },
  { id: "4k", label: "4K", hint: "仅 Seedance 2.0，10bit H.265" },
]);

export const SEEDANCE_OUTPUT_FORMATS = Object.freeze([
  { id: "mp4", label: "MP4", hint: "通用" },
  { id: "mov", label: "MOV", hint: "高色彩精度，给后期用；仅 2.5" },
]);

export const SEEDANCE_SERVICE_TIERS = Object.freeze([
  { id: "default", label: "在线", hint: "正常排队" },
  { id: "flex", label: "离线（半价）", hint: "不急的任务，价格是在线的 50%；仅 1.x" },
]);

export const SEEDANCE_OMNI_TASK_TYPES = Object.freeze([
  { id: "auto", label: "自动判定", hint: "模型按素材和提示词决定是参考生成、编辑还是延长" },
  { id: "reference", label: "参考生成", hint: "基于参考素材生成全新视频" },
  { id: "edit", label: "编辑视频", hint: "改已有视频的画面或声音；画幅、时长跟随原视频" },
  { id: "extend", label: "延长视频", hint: "把已有视频往前或往后接；画幅跟随原视频" },
]);

const RATIO_IDS = SEEDANCE_RATIOS.map((item) => item.id).filter((id) => id !== "adaptive");

/**
 * 模型能力矩阵。字段含义：
 * - resolutions / defaultResolution：可选分辨率
 * - duration: { min, max, smart }：秒数范围；smart = 支持 -1 让模型自己定
 * - frames：是否支持按帧数指定（1.0 系列，29–289 且满足 25+4n）
 * - audio：能否出有声视频；seed / cameraFixed / draft / priority / webSearch / omniTaskType：同名参数是否可用
 * - serviceTiers：default / flex；outputFormats：mp4 / mov
 * - modes：支持的生成方式；lastFrame：图生视频能否给尾帧
 * - textAdaptive：文生视频能否用 adaptive；imageAdaptiveOnly：首帧 / 首尾帧是否只能 adaptive
 * - omni：全模态参考的上限（null = 不支持）
 */
export const SEEDANCE_MODELS = Object.freeze([
  {
    id: "doubao-seedance-2-5-260628",
    name: "Seedance 2.5",
    family: "2.5",
    status: "active",
    blurb: "最新一代：全模态参考（图 30 / 视频 10 / 音频 10）、编辑与延长视频、最长 30 秒直出，1080p 为 10bit H.265。",
    priceHint: "1080p 活动价约 2.7 元/秒（至 9 月 17 日），480p / 720p 按刊例价",
    resolutions: ["480p", "720p", "1080p"],
    defaultResolution: "720p",
    duration: { min: 4, max: 30, smart: true },
    frames: false,
    audio: true,
    seed: false,
    cameraFixed: false,
    draft: false,
    serviceTiers: ["default"],
    priority: true,
    outputFormats: ["mp4", "mov"],
    webSearch: true,
    omniTaskType: true,
    modes: ["text", "image", "omni"],
    lastFrame: true,
    textAdaptive: true,
    imageAdaptiveOnly: true,
    omni: { images: 30, videos: 10, audios: 10, audioOnly: true, videoSeconds: 30, audioSeconds: 30, clipSeconds: [2, 30] },
  },
  {
    id: "doubao-seedance-2-0-260128",
    name: "Seedance 2.0",
    family: "2.0",
    status: "active",
    blurb: "全模态参考（图 9 / 视频 3 / 音频 3），唯一能出 4K 的版本，4–15 秒。",
    priceHint: "按刊例价计费",
    resolutions: ["480p", "720p", "1080p", "4k"],
    defaultResolution: "720p",
    duration: { min: 4, max: 15, smart: true },
    frames: false,
    audio: true,
    seed: false,
    cameraFixed: false,
    draft: false,
    serviceTiers: ["default"],
    priority: true,
    outputFormats: ["mp4"],
    webSearch: true,
    omniTaskType: false,
    modes: ["text", "image", "omni"],
    lastFrame: true,
    textAdaptive: true,
    imageAdaptiveOnly: false,
    omni: { images: 9, videos: 3, audios: 3, audioOnly: false, videoSeconds: 15, audioSeconds: 15, clipSeconds: [2, 15] },
  },
  {
    id: "doubao-seedance-2-0-fast-260128",
    name: "Seedance 2.0 fast",
    family: "2.0",
    status: "active",
    blurb: "2.0 的快速版：出片快、便宜，最高 720p，能力和 2.0 一样。",
    priceHint: "720p 活动价约 0.6 元/秒（至 9 月 7 日）",
    resolutions: ["480p", "720p"],
    defaultResolution: "720p",
    duration: { min: 4, max: 15, smart: true },
    frames: false,
    audio: true,
    seed: false,
    cameraFixed: false,
    draft: false,
    serviceTiers: ["default"],
    priority: true,
    outputFormats: ["mp4"],
    webSearch: true,
    omniTaskType: false,
    modes: ["text", "image", "omni"],
    lastFrame: true,
    textAdaptive: true,
    imageAdaptiveOnly: false,
    omni: { images: 9, videos: 3, audios: 3, audioOnly: false, videoSeconds: 15, audioSeconds: 15, clipSeconds: [2, 15] },
  },
  {
    id: "doubao-seedance-2-0-mini-260615",
    name: "Seedance 2.0 mini",
    family: "2.0",
    status: "active",
    blurb: "2.0 的迷你版：最便宜，最高 720p，适合大批量试。",
    priceHint: "720p 活动价约 0.2 元/秒（至 9 月 7 日）",
    resolutions: ["480p", "720p"],
    defaultResolution: "720p",
    duration: { min: 4, max: 15, smart: true },
    frames: false,
    audio: true,
    seed: false,
    cameraFixed: false,
    draft: false,
    serviceTiers: ["default"],
    priority: true,
    outputFormats: ["mp4"],
    webSearch: true,
    omniTaskType: false,
    modes: ["text", "image", "omni"],
    lastFrame: true,
    textAdaptive: true,
    imageAdaptiveOnly: false,
    omni: { images: 9, videos: 3, audios: 3, audioOnly: false, videoSeconds: 15, audioSeconds: 15, clipSeconds: [2, 15] },
  },
  {
    id: "doubao-seedance-1-5-pro-251215",
    name: "Seedance 1.5 pro",
    family: "1.5",
    status: "retiring",
    blurb: "上一代旗舰（退役中）：有声视频、固定镜头、种子、样片模式、离线半价。",
    priceHint: "按刊例价计费；离线模式半价",
    resolutions: ["480p", "720p", "1080p"],
    defaultResolution: "720p",
    duration: { min: 4, max: 12, smart: true },
    frames: false,
    audio: true,
    seed: true,
    cameraFixed: true,
    draft: true,
    serviceTiers: ["default", "flex"],
    priority: false,
    outputFormats: ["mp4"],
    webSearch: false,
    omniTaskType: false,
    modes: ["text", "image"],
    lastFrame: true,
    textAdaptive: true,
    imageAdaptiveOnly: false,
    omni: null,
  },
  {
    id: "doubao-seedance-1-0-pro-250528",
    name: "Seedance 1.0 pro",
    family: "1.0",
    status: "active",
    blurb: "老将：无声，2–12 秒，能按帧数出小数秒，默认 1080p。",
    priceHint: "按刊例价计费；离线模式半价",
    resolutions: ["480p", "720p", "1080p"],
    defaultResolution: "1080p",
    duration: { min: 2, max: 12, smart: false },
    frames: true,
    audio: false,
    seed: true,
    cameraFixed: true,
    draft: false,
    serviceTiers: ["default", "flex"],
    priority: false,
    outputFormats: ["mp4"],
    webSearch: false,
    omniTaskType: false,
    modes: ["text", "image"],
    lastFrame: true,
    textAdaptive: false,
    imageAdaptiveOnly: false,
    omni: null,
  },
  {
    id: "doubao-seedance-1-0-pro-fast-251015",
    name: "Seedance 1.0 pro fast",
    family: "1.0",
    status: "active",
    blurb: "1.0 pro 的快速版：无声，只支持首帧（不支持尾帧）。",
    priceHint: "按刊例价计费；离线模式半价",
    resolutions: ["480p", "720p", "1080p"],
    defaultResolution: "1080p",
    duration: { min: 2, max: 12, smart: false },
    frames: true,
    audio: false,
    seed: true,
    cameraFixed: true,
    draft: false,
    serviceTiers: ["default", "flex"],
    priority: false,
    outputFormats: ["mp4"],
    webSearch: false,
    omniTaskType: false,
    modes: ["text", "image"],
    lastFrame: false,
    textAdaptive: false,
    imageAdaptiveOnly: false,
    omni: null,
  },
]);

export const SEEDANCE_STATUS_LABELS = Object.freeze({
  queued: "排队中",
  running: "生成中",
  completed: "已完成",
  failed: "失败",
  cancelled: "已取消",
  expired: "已超时",
});

export const SEEDANCE_REF_KINDS = Object.freeze({
  image: { label: "图片", maxBytes: 30 * 1024 * 1024, exts: ["jpg", "jpeg", "png", "webp", "bmp", "tiff", "tif", "gif", "heic", "heif"] },
  video: { label: "视频", maxBytes: 200 * 1024 * 1024, exts: ["mp4", "mov"] },
  audio: { label: "音频", maxBytes: 15 * 1024 * 1024, exts: ["mp3", "wav"] },
});

const MAX_PROMPT_CHARS = 3000;
const MAX_COUNT = 4;
// 关键帧（首帧 + 中间帧 + 尾帧）最多几张：分段接力时 N 张 = N-1 段，再多一次就太贵也太慢。
const MAX_KEYFRAMES = 9;
const RECENT_TASK_LIMIT = 20;
// 图片这么大以内就直接 base64 塞进请求体（方舟限请求体 64 MB、建议大文件别用 base64）；再大就走公网 URL。
const INLINE_IMAGE_MAX_BYTES = 8 * 1024 * 1024;
const EXPIRES_RANGE = [3600, 259200];
const FRAMES_RANGE = [29, 289];
const SEED_MAX = 2147483647;

function limits() {
  return {
    maxActivePerUser: seedanceSettings().maxActivePerUser,
    maxPromptChars: MAX_PROMPT_CHARS,
    maxCount: MAX_COUNT,
    expiresAfter: EXPIRES_RANGE,
    frames: FRAMES_RANGE,
    seedMax: SEED_MAX,
    priority: [0, 9],
    refMaxBytes: Object.fromEntries(Object.entries(SEEDANCE_REF_KINDS).map(([kind, spec]) => [kind, spec.maxBytes])),
    refExts: Object.fromEntries(Object.entries(SEEDANCE_REF_KINDS).map(([kind, spec]) => [kind, spec.exts])),
    imagePx: [300, 6000],
    imageRatio: [0.4, 2.5],
    maxKeyframes: MAX_KEYFRAMES,
    // 服务器上的保留期：上传的素材 24 小时，成片和生成图一样 3 天（到期删文件、记录标过期）。
    retention: { uploadHours: UPLOAD_RETENTION_HOURS, outputDays: SERVER_RETENTION_DAYS },
  };
}

/** 中间帧有两种落地法；哪种可用取决于模型。 */
export const SEEDANCE_KEYFRAME_STRATEGIES = Object.freeze([
  { id: "reference", label: "一镜到底（参考）", hint: "把所有关键帧当参考图交给 2.x，一条任务出一段连续视频；首尾帧大体一致、中间帧是「经过」的画面，严格程度不如分段" },
  { id: "segments", label: "分段接力（严格）", hint: "相邻两张关键帧各出一段首尾帧视频，全部完成后自动拼成一条；每段严格以指定图开头结尾，任何模型都行，按段数计费" },
]);

export function seedanceModelById(id) {
  return SEEDANCE_MODELS.find((model) => model.id === id) || null;
}

/** 用户可选的模型：后台勾过就按勾的来，没勾就全部。 */
export function seedanceEnabledModels() {
  const { enabledModels } = seedanceSettings();
  if (!enabledModels.length) return SEEDANCE_MODELS;
  const filtered = SEEDANCE_MODELS.filter((model) => enabledModels.includes(model.id));
  return filtered.length ? filtered : SEEDANCE_MODELS;
}

export function seedanceOptions() {
  const settings = seedanceSettings();
  const enabled = seedanceEnabledModels();
  const defaultModel = enabled.some((model) => model.id === settings.defaultModel) ? settings.defaultModel : enabled[0].id;
  return {
    modes: SEEDANCE_MODES,
    models: enabled,
    defaultModel,
    ratios: SEEDANCE_RATIOS,
    resolutions: SEEDANCE_RESOLUTIONS,
    outputFormats: SEEDANCE_OUTPUT_FORMATS,
    serviceTiers: SEEDANCE_SERVICE_TIERS,
    omniTaskTypes: SEEDANCE_OMNI_TASK_TYPES,
    keyframeStrategies: SEEDANCE_KEYFRAME_STRATEGIES,
    statusLabels: SEEDANCE_STATUS_LABELS,
    limits: limits(),
  };
}

/* ── 权限与状态 ───────────────────────────────────────────────────────────── */

async function requireSeedanceAccount(req, res) {
  const account = await requireAccount(req, res);
  if (!account) return null;
  if (!canUseShortVideo(account.profile)) {
    res.status(403).json({ error: "短视频功能暂未对这个账号开放。" });
    return null;
  }
  return account;
}

/** 参考视频 / 音频要靠公网 URL 给方舟；本地或内网地址方舟取不到。 */
export function publicMediaBaseUrl() {
  const base = seedanceSettings().publicBaseUrl;
  if (!base) return "";
  try {
    const host = new URL(base).hostname;
    if (host === "localhost" || host === "127.0.0.1" || host === "0.0.0.0" || host.endsWith(".local") || /^10\.|^192\.168\.|^172\.(1[6-9]|2\d|3[01])\./.test(host)) return "";
  } catch {
    return "";
  }
  return base;
}

let statusCache = null;
let statusCacheAt = 0;
const STATUS_CACHE_MS = 60000;

/** 给页面看的方舟连接状态。探活只列一页任务，不花钱。 */
export async function seedanceStatus({ force = false } = {}) {
  const settings = seedanceSettings();
  if (!settings.apiKey) {
    statusCache = null;
    return { configured: false, online: false, error: "还没配置 API Key", baseUrl: settings.baseUrl, keySource: settings.apiKeySource, publicMediaReady: Boolean(publicMediaBaseUrl()) };
  }
  if (!force && statusCache && Date.now() - statusCacheAt < STATUS_CACHE_MS) return statusCache;
  let result;
  try {
    const ping = await pingArk({ withModels: false });
    result = { configured: true, online: true, latencyMs: ping.latencyMs, error: "", baseUrl: settings.baseUrl, keySource: settings.apiKeySource, publicMediaReady: Boolean(publicMediaBaseUrl()) };
  } catch (error) {
    result = { configured: true, online: false, error: error instanceof Error ? error.message : String(error), baseUrl: settings.baseUrl, keySource: settings.apiKeySource, publicMediaReady: Boolean(publicMediaBaseUrl()) };
  }
  statusCache = result;
  statusCacheAt = Date.now();
  return result;
}

/* ── 存储与表 ─────────────────────────────────────────────────────────────── */

export function seedanceAssetDir() {
  return path.resolve(process.env.SEEDANCE_ASSET_DIR || "./data/seedance");
}

function taskAssetDir(taskId) {
  return path.join(seedanceAssetDir(), "tasks", taskId);
}

function refsDir() {
  return path.join(seedanceAssetDir(), "refs");
}

function refFilePath(ref) {
  return path.join(refsDir(), `${ref.id}.${ref.ext}`);
}

export function migrateSeedanceDatabase() {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS seedance_task (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      ark_task_id TEXT,
      model TEXT NOT NULL,
      mode TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed', 'cancelled', 'expired')),
      prompt TEXT NOT NULL DEFAULT '',
      params_json TEXT NOT NULL DEFAULT '{}',
      content_json TEXT NOT NULL DEFAULT '[]',
      result_json TEXT NOT NULL DEFAULT '{}',
      error TEXT,
      error_code TEXT,
      credits INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      finished_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_seedance_task_user ON seedance_task(user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_seedance_task_status ON seedance_task(status);
    CREATE TABLE IF NOT EXISTS seedance_ref (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('image', 'video', 'audio')),
      ext TEXT NOT NULL,
      mime TEXT NOT NULL DEFAULT '',
      original_name TEXT NOT NULL DEFAULT '',
      bytes INTEGER NOT NULL DEFAULT 0,
      width INTEGER,
      height INTEGER,
      duration_seconds REAL,
      source TEXT NOT NULL DEFAULT 'upload',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_seedance_ref_user ON seedance_ref(user_id, created_at DESC);
    CREATE TABLE IF NOT EXISTS seedance_group (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      strategy TEXT NOT NULL DEFAULT 'segments',
      total INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'merging', 'merged', 'failed', 'partial')),
      merged_json TEXT NOT NULL DEFAULT '{}',
      error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_seedance_group_user ON seedance_group(user_id, created_at DESC);
  `);
  // 老表补列：成片的保留 / 归档状态（和 generated_result 一个路子）、分段接力的分组、本地排队（还没交给方舟）的标记。
  const columns = new Set(sqlite.prepare("PRAGMA table_info(seedance_task)").all().map((column) => column.name));
  const add = (name, ddl) => {
    if (!columns.has(name)) sqlite.exec(`ALTER TABLE seedance_task ADD COLUMN ${name} ${ddl}`);
  };
  add("storage_status", "TEXT NOT NULL DEFAULT 'cloud-temp'");
  add("archived_at", "TEXT");
  add("archive_path", "TEXT");
  add("expired_at", "TEXT");
  add("group_id", "TEXT");
  add("group_index", "INTEGER");
  add("submitted_at", "TEXT");
  sqlite.exec("CREATE INDEX IF NOT EXISTS idx_seedance_task_group ON seedance_task(group_id)");
  sqlite.exec("UPDATE seedance_task SET submitted_at = COALESCE(submitted_at, created_at) WHERE ark_task_id IS NOT NULL AND submitted_at IS NULL");
}

function parseJson(text, fallback) {
  try {
    const value = JSON.parse(text);
    return value ?? fallback;
  } catch {
    return fallback;
  }
}

/* ── 参考素材 ─────────────────────────────────────────────────────────────── */

function refPublicFileName(ref) {
  return `${ref.id}.${ref.ext}`;
}

/** 本站内部（带登录态）看素材用的地址。 */
function refPrivateUrl(ref) {
  return `/api/seedance/refs/${encodeURIComponent(ref.id)}/file`;
}

/** 给方舟取文件用的公网地址；没公网地址就返回空。 */
function refPublicUrl(ref) {
  const base = publicMediaBaseUrl();
  if (!base) return "";
  return `${base}/api/seedance/refs/public/${refPublicFileName(ref)}`;
}

export function serializeSeedanceRef(row) {
  if (!row) return null;
  return {
    id: row.id,
    kind: row.kind,
    ext: row.ext,
    mime: row.mime,
    name: row.original_name,
    bytes: Number(row.bytes || 0),
    width: row.width ?? null,
    height: row.height ?? null,
    durationSeconds: row.duration_seconds ?? null,
    source: row.source,
    url: refPrivateUrl(row),
    createdAt: row.created_at,
  };
}

function getRefRow(id) {
  return sqlite.prepare("SELECT * FROM seedance_ref WHERE id = ?").get(String(id || ""));
}

export function listSeedanceRefs(userId, { limit = 60 } = {}) {
  return sqlite
    .prepare("SELECT * FROM seedance_ref WHERE user_id = ? ORDER BY created_at DESC LIMIT ?")
    .all(userId, Math.min(Math.max(Number(limit) || 60, 1), 200))
    .map(serializeSeedanceRef);
}

const EXT_BY_MIME = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/bmp": "bmp",
  "image/tiff": "tiff",
  "image/gif": "gif",
  "image/heic": "heic",
  "image/heif": "heif",
  "video/mp4": "mp4",
  "video/quicktime": "mov",
  "audio/mpeg": "mp3",
  "audio/mp3": "mp3",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/wave": "wav",
};

function kindForExt(ext) {
  for (const [kind, spec] of Object.entries(SEEDANCE_REF_KINDS)) {
    if (spec.exts.includes(ext)) return kind;
  }
  return "";
}

/** 按扩展名和 MIME 定素材类型；都认不出就拒。 */
export function classifyRefFile(originalName, mimeType) {
  const extFromName = path.extname(String(originalName || "")).slice(1).toLowerCase();
  const extFromMime = EXT_BY_MIME[String(mimeType || "").split(";")[0].trim().toLowerCase()] || "";
  const ext = (kindForExt(extFromName) ? extFromName : extFromMime) || "";
  const kind = kindForExt(ext);
  if (!kind) return null;
  return { kind, ext: ext === "jpeg" ? "jpg" : ext === "tif" ? "tiff" : ext };
}

let ffprobeAvailable = null;

/** 有 ffprobe 就量一下视频 / 音频的时长和尺寸，没有就算了（方舟那边会再校验一次）。 */
function probeMedia(filePath) {
  if (ffprobeAvailable === false) return null;
  const bin = process.env.FFPROBE_BIN || "ffprobe";
  const probe = spawnSync(bin, ["-v", "error", "-print_format", "json", "-show_streams", "-show_format", filePath], { encoding: "utf8", timeout: 20000 });
  if (probe.error || probe.status !== 0) {
    if (probe.error && probe.error.code === "ENOENT") ffprobeAvailable = false;
    return null;
  }
  ffprobeAvailable = true;
  try {
    const info = JSON.parse(probe.stdout);
    const video = (info.streams || []).find((stream) => stream.codec_type === "video");
    const audio = (info.streams || []).find((stream) => stream.codec_type === "audio");
    const duration = Number(info.format?.duration || video?.duration || audio?.duration || 0) || null;
    let fps = null;
    if (video?.r_frame_rate) {
      const [num, den] = String(video.r_frame_rate).split("/").map(Number);
      if (num && den) fps = num / den;
    }
    return { duration, width: video?.width ?? null, height: video?.height ?? null, fps, videoCodec: video?.codec_name ?? null, audioCodec: audio?.codec_name ?? null };
  } catch {
    return null;
  }
}

class ValidationError extends Error {}

/**
 * 收一个上传好的临时文件：辨类型、量尺寸、按方舟的硬限制挡掉明显不合格的，再挪进素材目录、登记到表。
 * 图片的尺寸规则（300–6000 px、宽高比 0.4–2.5）在这里就拦，省得交到方舟才异步报错。
 */
export async function registerSeedanceRef({ userId, tempPath, originalName, mimeType, source = "upload" }) {
  const classified = classifyRefFile(originalName, mimeType);
  if (!classified) {
    throw new ValidationError("只支持 jpg / png / webp / bmp / tiff / gif / heic 图片、mp4 / mov 视频、mp3 / wav 音频。");
  }
  const { kind, ext } = classified;
  const spec = SEEDANCE_REF_KINDS[kind];
  const stats = await fs.stat(tempPath);
  if (stats.size > spec.maxBytes) {
    throw new ValidationError(`${spec.label}最大 ${Math.round(spec.maxBytes / 1024 / 1024)} MB（方舟的限制）。`);
  }
  let width = null;
  let height = null;
  let durationSeconds = null;
  if (kind === "image" && !["heic", "heif"].includes(ext)) {
    try {
      const meta = await sharp(tempPath).metadata();
      width = meta.width ?? null;
      height = meta.height ?? null;
    } catch {
      throw new ValidationError("这张图片读不出来，可能已损坏。");
    }
    if (width && height) {
      const [minPx, maxPx] = limits().imagePx;
      if (width < minPx || height < minPx || width > maxPx || height > maxPx) {
        throw new ValidationError(`图片宽高要在 ${minPx}–${maxPx} px 之间（现在 ${width}×${height}）。`);
      }
      const ratio = width / height;
      if (ratio < 0.4 || ratio > 2.5) throw new ValidationError(`图片宽高比要在 0.4–2.5 之间（现在 ${ratio.toFixed(2)}）。`);
    }
  } else if (kind === "video" || kind === "audio") {
    const probe = probeMedia(tempPath);
    if (probe) {
      durationSeconds = probe.duration;
      width = probe.width;
      height = probe.height;
      if (kind === "video") {
        if (durationSeconds && (durationSeconds < 2 || durationSeconds > 30)) {
          throw new ValidationError(`参考视频要在 2–30 秒之间（现在 ${durationSeconds.toFixed(1)} 秒）。`);
        }
        if (probe.fps && probe.fps < 24) throw new ValidationError(`参考视频帧率要 ≥ 24（现在 ${probe.fps.toFixed(1)}）。`);
        if (width && height && (width < 300 || height < 300 || width > 6000 || height > 6000)) {
          throw new ValidationError(`参考视频宽高要在 300–6000 px 之间（现在 ${width}×${height}）。`);
        }
      }
      if (kind === "audio" && durationSeconds && (durationSeconds < 2 || durationSeconds > 30)) {
        throw new ValidationError(`参考音频要在 2–30 秒之间（现在 ${durationSeconds.toFixed(1)} 秒）。`);
      }
    }
  }
  const id = randomBytes(16).toString("hex");
  await fs.mkdir(refsDir(), { recursive: true });
  const destination = path.join(refsDir(), `${id}.${ext}`);
  await fs.rename(tempPath, destination);
  const row = {
    id,
    user_id: userId,
    kind,
    ext,
    mime: String(mimeType || "").split(";")[0].trim() || "",
    original_name: String(originalName || "").slice(0, 200) || `${kind}.${ext}`,
    bytes: stats.size,
    width,
    height,
    duration_seconds: durationSeconds,
    source,
    created_at: nowIso(),
  };
  sqlite
    .prepare(
      `INSERT INTO seedance_ref (id, user_id, kind, ext, mime, original_name, bytes, width, height, duration_seconds, source, created_at)
       VALUES (@id, @user_id, @kind, @ext, @mime, @original_name, @bytes, @width, @height, @duration_seconds, @source, @created_at)`,
    )
    .run(row);
  return serializeSeedanceRef(row);
}

export async function deleteSeedanceRef(row) {
  await fs.rm(refFilePath(row), { force: true });
  sqlite.prepare("DELETE FROM seedance_ref WHERE id = ?").run(row.id);
}

/* ── 任务表 ───────────────────────────────────────────────────────────────── */

function fileUrl(taskId, name) {
  return `/api/seedance/tasks/${encodeURIComponent(taskId)}/files/${encodeURIComponent(name)}`;
}

function groupDir(groupId) {
  return path.join(seedanceAssetDir(), "groups", groupId);
}

function getGroupRow(groupId) {
  return groupId ? sqlite.prepare("SELECT * FROM seedance_group WHERE id = ?").get(groupId) : null;
}

/** 分段接力组在任务卡上的样子：第几段 / 共几段、合并成片到哪一步了。 */
export function serializeSeedanceGroup(group, { row = null } = {}) {
  if (!group) return null;
  const merged = parseJson(group.merged_json, {});
  const counts = sqlite
    .prepare(
      `SELECT
         SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed,
         SUM(CASE WHEN status IN ('failed', 'cancelled', 'expired') THEN 1 ELSE 0 END) AS failed,
         COUNT(*) AS present
       FROM seedance_task WHERE group_id = ?`,
    )
    .get(group.id);
  const expired = group.status === "merged" && merged.expiredAt;
  return {
    id: group.id,
    strategy: group.strategy,
    total: Number(group.total || 0),
    index: row ? Number(row.group_index || 0) : null,
    completed: Number(counts?.completed || 0),
    failed: Number(counts?.failed || 0),
    present: Number(counts?.present || 0),
    status: group.status,
    error: group.error || null,
    merged:
      group.status === "merged" && merged.name && !expired
        ? { name: merged.name, bytes: Number(merged.bytes || 0), url: `/api/seedance/groups/${encodeURIComponent(group.id)}/files/${encodeURIComponent(merged.name)}`, durationSeconds: merged.durationSeconds ?? null }
        : null,
    mergedExpiredAt: merged.expiredAt || null,
    createdAt: group.created_at,
    updatedAt: group.updated_at,
  };
}

/** 成片在服务器上的去留，和生成图一套词：cloud-temp（暂存 3 天）/ webdav（已推云盘）/ expired（已到期清理）。 */
function storageInfo(row) {
  return {
    status: row.storage_status || "cloud-temp",
    expiresAt: row.status === "completed" && row.finished_at ? resultExpiresAt(row.finished_at) : null,
    archivedAt: row.archived_at || null,
    archivePath: row.archive_path || null,
    expiredAt: row.expired_at || null,
    retentionDays: SERVER_RETENTION_DAYS,
  };
}

export function serializeSeedanceTask(row) {
  if (!row) return null;
  const result = parseJson(row.result_json, {});
  const model = seedanceModelById(row.model);
  const filesGone = Boolean(row.expired_at);
  return {
    id: row.id,
    arkTaskId: row.ark_task_id || null,
    // 还没交给方舟、在本站排队（等前面的段 / 条完成腾出并发）。
    pendingSubmit: row.status === "queued" && !row.ark_task_id,
    model: row.model,
    modelName: model?.name || row.model,
    mode: row.mode,
    status: row.status,
    statusLabel: row.status === "queued" && !row.ark_task_id ? "本站排队" : SEEDANCE_STATUS_LABELS[row.status] || row.status,
    prompt: row.prompt,
    params: parseJson(row.params_json, {}),
    content: parseJson(row.content_json, []),
    group: row.group_id ? serializeSeedanceGroup(getGroupRow(row.group_id), { row }) : null,
    storage: storageInfo(row),
    result: {
      video: result.video && !filesGone ? { name: result.video.name, bytes: Number(result.video.bytes || 0), url: fileUrl(row.id, result.video.name), format: result.video.format || "mp4" } : null,
      lastFrame: result.lastFrame && !filesGone ? { name: result.lastFrame.name, bytes: Number(result.lastFrame.bytes || 0), url: fileUrl(row.id, result.lastFrame.name) } : null,
      remoteVideoUrl: result.remoteVideoUrl || null,
      duration: result.duration ?? null,
      frames: result.frames ?? null,
      fps: result.fps ?? null,
      resolution: result.resolution ?? null,
      ratio: result.ratio ?? null,
      seed: result.seed ?? null,
      generateAudio: result.generateAudio ?? null,
      outputFormat: result.outputFormat ?? null,
      draft: result.draft ?? null,
      usage: result.usage ?? null,
      arkModel: result.arkModel ?? null,
    },
    error: row.error || null,
    errorCode: row.error_code || null,
    credits: Number(row.credits || 0),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    finishedAt: row.finished_at || null,
  };
}

function getTaskRow(taskId) {
  return sqlite.prepare("SELECT * FROM seedance_task WHERE id = ?").get(taskId);
}

export function listSeedanceTaskPage(userId, { page = 1, pageSize = RECENT_TASK_LIMIT } = {}) {
  const size = Math.min(Math.max(Number(pageSize) || RECENT_TASK_LIMIT, 1), 100);
  const total = Number(sqlite.prepare("SELECT COUNT(*) AS count FROM seedance_task WHERE user_id = ?").get(userId)?.count || 0);
  const pageCount = Math.max(1, Math.ceil(total / size));
  const safePage = Math.min(Math.max(Number(page) || 1, 1), pageCount);
  const items = total
    ? sqlite
        .prepare("SELECT * FROM seedance_task WHERE user_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?")
        .all(userId, size, (safePage - 1) * size)
        .map(serializeSeedanceTask)
    : [];
  return { items, total, page: safePage, pageSize: size, pageCount };
}

function activeTaskCount(userId) {
  const row = sqlite.prepare("SELECT COUNT(*) AS count FROM seedance_task WHERE user_id = ? AND status IN ('queued', 'running')").get(userId);
  return Number(row?.count || 0);
}

/** 真正在方舟那边排队 / 生成的条数（本站排队的不算）——并发上限管的是这个。 */
function arkActiveCount(userId) {
  const row = sqlite.prepare("SELECT COUNT(*) AS count FROM seedance_task WHERE user_id = ? AND status IN ('queued', 'running') AND ark_task_id IS NOT NULL").get(userId);
  return Number(row?.count || 0);
}

function updateTask(taskId, fields) {
  const keys = Object.keys(fields);
  if (!keys.length) return;
  const assignments = keys.map((key) => `${key} = ?`).join(", ");
  sqlite.prepare(`UPDATE seedance_task SET ${assignments}, updated_at = ? WHERE id = ?`).run(...keys.map((key) => fields[key]), nowIso(), taskId);
}

function markTaskEnded(taskId, status, message, code = "") {
  updateTask(taskId, {
    status,
    error: message ? String(message).slice(0, 600) : null,
    error_code: code ? String(code).slice(0, 80) : null,
    finished_at: nowIso(),
  });
  const row = getTaskRow(taskId);
  if (row?.group_id) void settleGroup(row.group_id);
}

/* ── 参数规范化 ───────────────────────────────────────────────────────────── */

function pickOption(list, raw, fallback, label) {
  const value = String(raw ?? "").trim();
  if (!value) return fallback;
  if (!list.includes(value)) throw new ValidationError(`${label}不支持「${value}」。`);
  return value;
}

function intIn(raw, { min, max, fallback, label }) {
  if (raw === undefined || raw === null || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || !Number.isInteger(value)) throw new ValidationError(`${label}要是整数。`);
  if (value < min || value > max) throw new ValidationError(`${label}要在 ${min}–${max} 之间。`);
  return value;
}

function boolOr(raw, fallback) {
  if (raw === undefined || raw === null || raw === "") return fallback;
  return raw === true || raw === "true" || raw === 1 || raw === "1";
}

function normalizeMediaSlot(raw, { label, kind, userId, required = false }) {
  if (!raw || typeof raw !== "object") {
    if (required) throw new ValidationError(`${label}还没选。`);
    return null;
  }
  const refId = String(raw.refId || "").trim();
  const url = String(raw.url || "").trim();
  if (refId) {
    if (!/^[a-f0-9]{32}$/.test(refId)) throw new ValidationError(`${label}的素材编号不合法。`);
    const row = getRefRow(refId);
    if (!row || row.user_id !== userId) throw new ValidationError(`${label}用的素材不存在或不是你的。`);
    if (row.kind !== kind) throw new ValidationError(`${label}要用${SEEDANCE_REF_KINDS[kind].label}，选的却是${SEEDANCE_REF_KINDS[row.kind].label}。`);
    return { refId, kind, name: row.original_name };
  }
  if (url) {
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      throw new ValidationError(`${label}的链接不合法。`);
    }
    if (!["http:", "https:"].includes(parsed.protocol) && !url.startsWith("asset://")) throw new ValidationError(`${label}的链接要是 http(s) 公网地址或 asset:// 素材 ID。`);
    if (url.length > 2000) throw new ValidationError(`${label}的链接太长。`);
    return { url, kind };
  }
  if (required) throw new ValidationError(`${label}还没选。`);
  return null;
}

/**
 * 把前端的请求收拾成一份干净的参数；所有按模型能力的取舍都在这里。
 * 返回值同时记录 `sent`（真正发给方舟的字段），方便在任务详情里照实展示。
 */
export function normalizeSeedanceRequest(body = {}, { userId = "" } = {}) {
  const enabled = seedanceEnabledModels();
  const modelId = String(body.model || "").trim() || seedanceOptions().defaultModel;
  const model = enabled.find((item) => item.id === modelId);
  if (!model) throw new ValidationError("这个模型不在可选范围里。");

  const draftTaskId = String(body.draftTaskId || "").trim();
  const mode = pickOption(model.modes, body.mode, model.modes[0], "生成方式");

  const prompt = String(body.prompt || "").replace(/\r\n/g, "\n").trim();
  if (prompt.length > MAX_PROMPT_CHARS) throw new ValidationError(`提示词最多 ${MAX_PROMPT_CHARS} 字。`);

  let firstFrame = null;
  let lastFrame = null;
  let middleFrames = [];
  let keyframeStrategy = null;
  const references = { images: [], videos: [], audios: [] };

  if (draftTaskId) {
    if (!model.draft) throw new ValidationError(`${model.name} 没有样片模式，不能基于样片出正式版。`);
    if (!/^[\w-]{4,120}$/.test(draftTaskId)) throw new ValidationError("样片任务号不合法。");
  } else if (mode === "text") {
    if (!prompt) throw new ValidationError("文生视频得先写提示词。");
  } else if (mode === "image") {
    firstFrame = normalizeMediaSlot(body.firstFrame, { label: "首帧", kind: "image", userId, required: true });
    if (body.lastFrame && (body.lastFrame.refId || body.lastFrame.url)) {
      if (!model.lastFrame) throw new ValidationError(`${model.name} 不支持尾帧，只能给首帧。`);
      lastFrame = normalizeMediaSlot(body.lastFrame, { label: "尾帧", kind: "image", userId });
    }
    // 中间帧：方舟本身只认首帧 / 尾帧，中间的画面要么当参考图交给 2.x 一条出（reference），要么拆成首尾帧分段出再拼（segments）。
    const rawMiddle = Array.isArray(body.middleFrames) ? body.middleFrames.filter((item) => item && (item.refId || item.url)) : [];
    if (rawMiddle.length) {
      if (rawMiddle.length > MAX_KEYFRAMES - 2) throw new ValidationError(`中间帧最多 ${MAX_KEYFRAMES - 2} 张。`);
      middleFrames = rawMiddle.map((item, index) => normalizeMediaSlot(item, { label: `中间帧 ${index + 1}`, kind: "image", userId, required: true }));
      const strategies = SEEDANCE_KEYFRAME_STRATEGIES.map((item) => item.id);
      keyframeStrategy = pickOption(strategies, body.keyframeStrategy, model.omni ? "reference" : "segments", "中间帧方式");
      if (keyframeStrategy === "reference" && !model.omni) throw new ValidationError(`${model.name} 不支持参考图，中间帧只能用「分段接力」（或换 Seedance 2.x）。`);
      if (keyframeStrategy === "segments" && !model.lastFrame) throw new ValidationError(`${model.name} 不支持尾帧，没法分段接力（换个模型）。`);
      if (keyframeStrategy === "reference" && middleFrames.length + 2 > model.omni.images) throw new ValidationError(`${model.name} 最多 ${model.omni.images} 张参考图。`);
    }
  } else if (mode === "omni") {
    if (!model.omni) throw new ValidationError(`${model.name} 不支持多模态参考，换 Seedance 2.x。`);
    const raw = Array.isArray(body.references) ? body.references : [];
    if (raw.length > model.omni.images + model.omni.videos + model.omni.audios) throw new ValidationError("参考素材太多了。");
    for (const item of raw) {
      const kind = String(item?.kind || "").trim();
      if (!["image", "video", "audio"].includes(kind)) throw new ValidationError("参考素材类型只能是图片 / 视频 / 音频。");
      const slot = normalizeMediaSlot(item, { label: `参考${SEEDANCE_REF_KINDS[kind].label}`, kind, userId, required: true });
      references[`${kind}s`].push(slot);
    }
    if (references.images.length > model.omni.images) throw new ValidationError(`${model.name} 最多 ${model.omni.images} 张参考图。`);
    if (references.videos.length > model.omni.videos) throw new ValidationError(`${model.name} 最多 ${model.omni.videos} 个参考视频。`);
    if (references.audios.length > model.omni.audios) throw new ValidationError(`${model.name} 最多 ${model.omni.audios} 段参考音频。`);
    const total = references.images.length + references.videos.length + references.audios.length;
    if (!total) throw new ValidationError("多模态参考至少要给一个参考图 / 视频 / 音频。");
    if (!references.images.length && !references.videos.length && !model.omni.audioOnly) {
      throw new ValidationError(`${model.name} 不能只给音频，至少搭一张参考图或一个参考视频。`);
    }
  }

  // 全模态子任务类型：只有 2.5 能显式指定；编辑 / 延长必须带参考视频。
  let omniTaskType = "auto";
  if (mode === "omni" && model.omniTaskType) {
    omniTaskType = pickOption(SEEDANCE_OMNI_TASK_TYPES.map((item) => item.id), body.omniTaskType, "auto", "任务类型");
    if ((omniTaskType === "edit" || omniTaskType === "extend") && !references.videos.length) {
      throw new ValidationError("编辑 / 延长视频至少要给一个参考视频。");
    }
  }

  // 画幅
  const ratioChoices = [...RATIO_IDS];
  const allowAdaptive = mode === "text" ? model.textAdaptive : true;
  if (allowAdaptive) ratioChoices.push("adaptive");
  let ratio = pickOption(ratioChoices, body.ratio, mode === "text" && !model.textAdaptive ? "16:9" : mode === "text" ? "9:16" : "adaptive", "画幅");
  let ratioLocked = false;
  if (mode === "image" && model.imageAdaptiveOnly) {
    ratio = "adaptive";
    ratioLocked = true;
  }
  if (mode === "omni" && model.omniTaskType && (omniTaskType === "edit" || omniTaskType === "extend")) {
    ratio = "adaptive";
    ratioLocked = true;
  }

  // 样片模式只能 480p；分辨率按模型可选
  const draft = model.draft ? boolOr(body.draft, false) && !draftTaskId : false;
  let resolution = pickOption(model.resolutions, body.resolution, model.defaultResolution, "分辨率");
  if (draft) resolution = "480p";

  // 时长 / 帧数
  let duration = null;
  let frames = null;
  if (model.frames && body.frames !== undefined && body.frames !== null && body.frames !== "") {
    frames = intIn(body.frames, { min: FRAMES_RANGE[0], max: FRAMES_RANGE[1], fallback: null, label: "帧数" });
    if ((frames - 25) % 4 !== 0) throw new ValidationError("帧数要满足 25 + 4n（如 29、33、…、289）。");
  } else {
    const rawDuration = body.duration === undefined || body.duration === null || body.duration === "" ? null : Number(body.duration);
    if (rawDuration === -1) {
      if (!model.duration.smart) throw new ValidationError(`${model.name} 不支持智能时长，请指定秒数。`);
      duration = -1;
    } else {
      duration = intIn(rawDuration, { min: model.duration.min, max: model.duration.max, fallback: Math.min(Math.max(5, model.duration.min), model.duration.max), label: "时长" });
    }
  }
  if (mode === "omni" && model.omniTaskType && omniTaskType === "edit") duration = -1;

  const generateAudio = model.audio ? boolOr(body.generateAudio, true) : false;
  const watermark = boolOr(body.watermark, false);
  const seed = model.seed ? intIn(body.seed, { min: -1, max: SEED_MAX, fallback: -1, label: "随机种子" }) : -1;
  const cameraFixed = model.cameraFixed && mode !== "omni" ? boolOr(body.cameraFixed, false) : false;
  const returnLastFrame = draft ? false : boolOr(body.returnLastFrame, false);
  const outputFormat = pickOption(model.outputFormats, body.outputFormat, "mp4", "输出格式");
  const serviceTier = pickOption(model.serviceTiers, body.serviceTier, "default", "服务等级");
  const priority = model.priority && serviceTier === "default" ? intIn(body.priority, { min: 0, max: 9, fallback: 0, label: "优先级" }) : 0;
  const webSearch = model.webSearch ? boolOr(body.webSearch, false) : false;
  const expiresAfter = intIn(body.expiresAfter, { min: EXPIRES_RANGE[0], max: EXPIRES_RANGE[1], fallback: 172800, label: "任务超时" });
  // 分段接力本身就是一组多条，不再乘 count。
  const count = keyframeStrategy === "segments" ? 1 : intIn(body.count, { min: 1, max: MAX_COUNT, fallback: 1, label: "条数" });

  return {
    model: model.id,
    modelName: model.name,
    mode,
    prompt,
    draftTaskId: draftTaskId || null,
    firstFrame,
    lastFrame,
    middleFrames,
    keyframeStrategy,
    references,
    omniTaskType: mode === "omni" && model.omniTaskType ? omniTaskType : null,
    ratio,
    ratioLocked,
    resolution,
    duration,
    frames,
    generateAudio,
    watermark,
    seed,
    cameraFixed,
    returnLastFrame,
    outputFormat,
    serviceTier,
    priority,
    draft,
    webSearch,
    expiresAfter,
    count,
  };
}

/* ── 组装方舟请求 ─────────────────────────────────────────────────────────── */

/** 把一个素材槽位变成方舟能取到的地址：小图直接 base64，视频 / 音频 / 大图走公网 URL。 */
async function resolveMediaUrl(slot) {
  if (slot.url) return slot.url;
  const row = getRefRow(slot.refId);
  if (!row) throw new ValidationError("参考素材已经不在了。");
  if (row.kind === "image" && Number(row.bytes) <= INLINE_IMAGE_MAX_BYTES && !["heic", "heif"].includes(row.ext)) {
    const buffer = await fs.readFile(refFilePath(row));
    const mime = row.mime || (row.ext === "jpg" ? "image/jpeg" : `image/${row.ext}`);
    return `data:${mime};base64,${buffer.toString("base64")}`;
  }
  const url = refPublicUrl(row);
  if (!url) {
    throw new ValidationError(
      `参考${SEEDANCE_REF_KINDS[row.kind].label}要以公网地址交给方舟，但本站还没配置公网地址（后台 → Seedance → 公网地址，或 .env 的 PUBLIC_APP_URL）。`,
    );
  }
  return url;
}

/** 记到任务里的内容清单：只留素材编号 / 链接 / 用途，不存 base64。 */
function contentSummary(params) {
  const items = [];
  if (params.draftTaskId) items.push({ type: "draft_task", id: params.draftTaskId });
  if (params.prompt) items.push({ type: "text", text: params.prompt });
  const push = (slot, role) => {
    if (!slot) return;
    items.push({ type: `${slot.kind}_url`, role, refId: slot.refId || null, url: slot.url || null, name: slot.name || null });
  };
  push(params.firstFrame, "first_frame");
  for (const frame of params.middleFrames || []) push(frame, "middle_frame");
  push(params.lastFrame, "last_frame");
  for (const image of params.references.images) push(image, "reference_image");
  for (const video of params.references.videos) push(video, "reference_video");
  for (const audio of params.references.audios) push(audio, "reference_audio");
  return items;
}

/**
 * 「一镜到底」的提示词：告诉模型 @图像1 是开头、@图像N 是结尾（若给了尾帧）、中间的依次经过。
 * 方舟文档说全模态参考可以「通过提示词指定参考图片作为首帧 / 尾帧」，就是靠这段话。
 */
export function keyframePrompt(total, hasLast, userPrompt = "") {
  const ordinals = Array.from({ length: total }, (_, index) => `@图像${index + 1}`);
  const parts = [`${ordinals[0]} 是视频的第一帧画面`];
  const middle = hasLast ? ordinals.slice(1, -1) : ordinals.slice(1);
  if (middle.length) parts.push(`随后依次经过 ${middle.join("、")} 的画面`);
  if (hasLast) parts.push(`${ordinals[ordinals.length - 1]} 是视频的最后一帧画面`);
  const lead = `${parts.join("；")}。各画面之间用连贯的运镜自然过渡，保持同一主体与场景。`;
  const body = String(userPrompt || "").trim();
  return body ? `${lead}\n${body}` : lead;
}

export async function arkPayloadFor(params, { userId = "" } = {}) {
  const model = seedanceModelById(params.model);
  const content = [];
  if (params.draftTaskId) {
    content.push({ type: "draft_task", draft_task: { id: params.draftTaskId } });
  } else if (params.keyframeStrategy === "reference" && params.middleFrames?.length) {
    // 一镜到底：首帧 / 中间帧 / 尾帧全当参考图，顺序即时间顺序；提示词前面加一段说明谁是开头、谁是经过、谁是结尾。
    const frames = [params.firstFrame, ...params.middleFrames, params.lastFrame].filter(Boolean);
    content.push({ type: "text", text: keyframePrompt(frames.length, Boolean(params.lastFrame), params.prompt) });
    for (const frame of frames) content.push({ type: "image_url", image_url: { url: await resolveMediaUrl(frame) }, role: "reference_image" });
  } else {
    if (params.prompt) content.push({ type: "text", text: params.prompt });
    if (params.firstFrame) content.push({ type: "image_url", image_url: { url: await resolveMediaUrl(params.firstFrame) }, role: "first_frame" });
    if (params.lastFrame) content.push({ type: "image_url", image_url: { url: await resolveMediaUrl(params.lastFrame) }, role: "last_frame" });
    for (const image of params.references.images) content.push({ type: "image_url", image_url: { url: await resolveMediaUrl(image) }, role: "reference_image" });
    for (const video of params.references.videos) content.push({ type: "video_url", video_url: { url: await resolveMediaUrl(video) }, role: "reference_video" });
    for (const audio of params.references.audios) content.push({ type: "audio_url", audio_url: { url: await resolveMediaUrl(audio) }, role: "reference_audio" });
  }

  const payload = {
    model: params.model,
    content,
    ratio: params.ratio,
    resolution: params.resolution,
    watermark: params.watermark,
    return_last_frame: params.returnLastFrame,
    execution_expires_after: params.expiresAfter,
    // 用账号 ID 的哈希当终端用户标识：方舟拿它做风控归因，又不泄露账号。
    safety_identifier: createHash("sha256").update(`clothdesign-seedance:${userId}`).digest("hex").slice(0, 48),
  };
  if (params.frames !== null && params.frames !== undefined) payload.frames = params.frames;
  else if (params.duration !== null && params.duration !== undefined) payload.duration = params.duration;
  if (model?.audio) payload.generate_audio = params.generateAudio;
  if (model?.seed && params.seed !== -1) payload.seed = params.seed;
  if (model?.cameraFixed && params.cameraFixed) payload.camera_fixed = true;
  if (model?.outputFormats.length > 1 && params.outputFormat !== "mp4") payload.output_format = params.outputFormat;
  if (model?.serviceTiers.includes("flex") && params.serviceTier === "flex") payload.service_tier = "flex";
  if (model?.priority && params.priority > 0) payload.priority = params.priority;
  if (model?.draft && params.draft) payload.draft = true;
  if (params.omniTaskType && params.omniTaskType !== "auto") payload.omni_reference_task_type = params.omniTaskType;
  if (model?.webSearch && params.webSearch) payload.tools = [{ type: "web_search" }];
  // 样片出正式版：方舟会复用样片那次的 model / 文案 / 图 / 音频 / seed / 画幅 / 时长，这里别再传会冲突的字段。
  if (params.draftTaskId) {
    delete payload.ratio;
    delete payload.duration;
    delete payload.frames;
    delete payload.generate_audio;
    delete payload.seed;
    delete payload.camera_fixed;
  }
  return payload;
}

/* ── 创建 / 轮询 / 回传 ───────────────────────────────────────────────────── */

function pollIntervalMs() {
  const value = Number(process.env.SEEDANCE_POLL_INTERVAL_MS || 8000);
  return Number.isFinite(value) && value >= 100 ? value : 8000;
}

let pollTimer = null;
let polling = false;
const downloadAttempts = new Map();

function activeTaskRows() {
  return sqlite.prepare("SELECT * FROM seedance_task WHERE status IN ('queued', 'running') ORDER BY created_at ASC").all();
}

export function ensureSeedancePolling() {
  if (pollTimer) return;
  pollTimer = setInterval(() => {
    void pollActiveTasks();
  }, pollIntervalMs());
  if (typeof pollTimer.unref === "function") pollTimer.unref();
}

function stopPollingIfIdle() {
  if (!pollTimer) return;
  if (activeTaskRows().length > 0) return;
  clearInterval(pollTimer);
  pollTimer = null;
}

/** 服务重启后把库里没跑完的任务重新纳入轮询——方舟那边多半还在排队 / 生成。 */
export function resumeSeedancePolling() {
  if (activeTaskRows().length > 0) ensureSeedancePolling();
}

async function pollActiveTasks() {
  if (polling) return;
  polling = true;
  try {
    try {
      await submitPendingTasks();
    } catch (error) {
      console.error("[seedance] 补交排队任务失败：", error);
    }
    const rows = activeTaskRows().filter((row) => row.ark_task_id);
    if (!rows.length) {
      stopPollingIfIdle();
      return;
    }
    for (const row of rows) {
      try {
        await syncTaskFromArk(row);
      } catch (error) {
        console.error(`[seedance] 同步任务 ${row.id} 失败：`, error);
      }
    }
    stopPollingIfIdle();
  } finally {
    polling = false;
  }
}

/** 真正去方舟查一次；暴露出来是为了测试能不等定时器直接推一步。 */
export async function syncTaskFromArk(row) {
  if (!row.ark_task_id) {
    // 本站排队中，还没交给方舟；轮到它时 submitPendingTasks 会补交。
    if (row.status === "queued") return;
    markTaskEnded(row.id, "failed", "任务没有方舟侧编号。", "system");
    return;
  }
  let arkTask;
  try {
    arkTask = await getArkTask(row.ark_task_id);
  } catch (error) {
    // Key 失效这种要立刻停；网络抖动就下一轮再试。
    if (error instanceof ArkError && (error.status === 401 || error.code === "not_configured")) {
      markTaskEnded(row.id, "failed", error.message, error.code);
    }
    return;
  }
  if (!arkTask) {
    markTaskEnded(row.id, "failed", "这条任务在火山方舟那边找不到了（任务记录只保留 7 天，或已被删除）。", "not_found");
    return;
  }
  const status = String(arkTask.status || "").toLowerCase();
  if (status === "queued" || status === "running") {
    if (row.status !== status) updateTask(row.id, { status });
    return;
  }
  if (status === "succeeded") {
    await importFinishedTask(row, arkTask);
    return;
  }
  if (status === "cancelled" || status === "canceled") {
    markTaskEnded(row.id, "cancelled", "任务已在方舟侧取消。", "cancelled");
    return;
  }
  if (status === "expired") {
    markTaskEnded(row.id, "expired", "任务在方舟排队 / 生成超过了超时阈值，已被方舟终止。", "expired");
    return;
  }
  // failed 或未知状态
  const arkError = arkTask.error && typeof arkTask.error === "object" ? arkTask.error : null;
  const message = arkError?.message || arkTask.error || `方舟返回状态 ${status || "未知"}`;
  markTaskEnded(row.id, "failed", friendlyArkFailure(arkError?.code, message), arkError?.code || status || "failed");
}

function friendlyArkFailure(code, message) {
  const text = String(message || "").trim();
  const key = `${code || ""} ${text}`;
  if (/Sensitive|sensitive|ContentFilter/i.test(key)) return `内容没过方舟的安全审核：${text}`;
  if (/TaskTypeConstraint|TaskTypeMismatch/i.test(key)) return `方舟判定的任务类型和参数不匹配：${text}（换「自动判定」或调整提示词再试）`;
  if (/InvalidParameter/i.test(key)) return `方舟说参数不对：${text}`;
  return text || "生成失败。";
}

async function importFinishedTask(row, arkTask) {
  const videoUrl = String(arkTask?.content?.video_url || "").trim();
  const lastFrameUrl = String(arkTask?.content?.last_frame_url || "").trim();
  if (!videoUrl) {
    markTaskEnded(row.id, "failed", "方舟说成功了，却没给视频地址。", "bad_response");
    return;
  }
  const previous = parseJson(row.result_json, {});
  const outputFormat = String(arkTask.output_format || parseJson(row.params_json, {}).outputFormat || "mp4").toLowerCase() === "mov" ? "mov" : "mp4";
  const result = {
    ...previous,
    remoteVideoUrl: videoUrl,
    duration: arkTask.duration ?? null,
    frames: arkTask.frames ?? null,
    fps: arkTask.framespersecond ?? null,
    resolution: arkTask.resolution ?? null,
    ratio: arkTask.ratio ?? null,
    seed: arkTask.seed ?? null,
    generateAudio: arkTask.generate_audio ?? null,
    outputFormat,
    draft: arkTask.draft ?? null,
    arkModel: arkTask.model ?? null,
    usage: arkTask.usage
      ? {
          completionTokens: Number(arkTask.usage.completion_tokens || 0),
          totalTokens: Number(arkTask.usage.total_tokens || 0),
          webSearch: Number(arkTask.usage.tool_usage?.web_search || 0) || null,
        }
      : null,
  };
  const dir = taskAssetDir(row.id);
  const videoName = `video.${outputFormat}`;
  try {
    const bytes = await downloadArkFile(videoUrl, path.join(dir, videoName));
    result.video = { name: videoName, bytes, format: outputFormat };
    if (lastFrameUrl) {
      try {
        const frameBytes = await downloadArkFile(lastFrameUrl, path.join(dir, "last-frame.png"));
        result.lastFrame = { name: "last-frame.png", bytes: frameBytes };
      } catch (error) {
        console.warn(`[seedance] 任务 ${row.id} 尾帧拉取失败：`, error?.message || error);
      }
    }
  } catch (error) {
    // 拉不下来先记着远端地址（24 小时有效），下一轮再试；试几次还不行就按失败处理，但把地址留给用户。
    const attempts = (downloadAttempts.get(row.id) || 0) + 1;
    downloadAttempts.set(row.id, attempts);
    updateTask(row.id, { status: "running", result_json: JSON.stringify(result) });
    if (attempts >= 5) {
      downloadAttempts.delete(row.id);
      updateTask(row.id, { status: "failed", error: `成片已生成，但回传到本站失败：${error?.message || error}。可在 24 小时内用远端地址下载。`, error_code: "download", finished_at: nowIso() });
    }
    return;
  }
  downloadAttempts.delete(row.id);
  updateTask(row.id, { status: "completed", result_json: JSON.stringify(result), error: null, error_code: null, finished_at: nowIso() });
  // 生成完的钩子：开了自动归档就推云盘（失败只记日志）；分段接力看看这组是不是齐了。
  void autoArchiveSeedanceTask(getTaskRow(row.id)).catch((error) => console.warn(`[seedance] 自动归档 ${row.id} 失败：`, error?.message || error));
  if (row.group_id) void settleGroup(row.group_id);
}

/* ── 成片归档 / 到期清理（和生成图同一套规则：服务器暂存 3 天，可推 WebDAV） ── */

/** 把一条成片推到账号的 WebDAV；成功后状态记 webdav。服务器上的文件照旧 3 天到期。 */
export async function archiveSeedanceTask(row) {
  if (!row || row.status !== "completed") return { error: "只有完成的成片能归档。", status: 400 };
  if (row.expired_at) return { error: "服务器上的文件已经过期清理，没法再归档。", status: 409 };
  const result = parseJson(row.result_json, {});
  if (!result.video?.name) return { error: "这条任务没有成片文件。", status: 400 };
  const params = parseJson(row.params_json, {});
  const outcome = await archiveFileToUserWebdav(row.user_id, {
    filePath: path.join(taskAssetDir(row.id), result.video.name),
    title: `seedance-${String(row.prompt || params.modelName || "video").slice(0, 40) || "video"}`,
    id: row.id,
    createdAt: row.created_at,
    extension: result.video.format || "mp4",
    mimeType: result.video.format === "mov" ? "video/quicktime" : "video/mp4",
    subdirectory: "短视频",
  });
  if (outcome.error) return outcome;
  updateTask(row.id, { storage_status: "webdav", archived_at: outcome.archivedAt, archive_path: outcome.archivePath });
  return outcome;
}

async function autoArchiveSeedanceTask(row) {
  if (!row || !userAutoArchiveEnabled(row.user_id)) return { skipped: true };
  const outcome = await archiveSeedanceTask(row);
  if (outcome.error) console.warn(`[seedance] auto archive failed for ${row.id}: ${outcome.error}`);
  return outcome;
}

/**
 * 每小时跟成片图一起巡检：
 *   - 完成超过 3 天的成片：删本地视频 / 尾帧（合并成片也一样），记录标 expired（记录留着，能看到参数和云盘路径）；
 *   - 上传超过 24 小时的参考素材：删文件和记录（还被排队 / 生成中的任务引用的先留着）；
 *   - tmp 目录里超过 24 小时的残留。
 */
export async function runSeedanceMaintenance({ now = Date.now(), dryRun = false } = {}) {
  const summary = { expiredTasks: 0, expiredGroups: 0, refsDeleted: 0, tmpDeleted: 0, bytesFreed: 0, dryRun };
  const outputCutoff = new Date(now - SERVER_RETENTION_MS).toISOString();
  const rows = sqlite
    .prepare("SELECT * FROM seedance_task WHERE expired_at IS NULL AND status IN ('completed', 'failed', 'cancelled', 'expired') AND COALESCE(finished_at, updated_at) < ? ORDER BY finished_at ASC LIMIT 500")
    .all(outputCutoff);
  for (const row of rows) {
    const dir = taskAssetDir(row.id);
    summary.bytesFreed += await directoryBytes(dir);
    if (!dryRun) {
      await fs.rm(dir, { recursive: true, force: true });
      updateTask(row.id, { storage_status: "expired", expired_at: new Date(now).toISOString() });
    }
    summary.expiredTasks += 1;
  }
  const groups = sqlite.prepare("SELECT * FROM seedance_group WHERE status = 'merged' AND updated_at < ?").all(outputCutoff);
  for (const group of groups) {
    const merged = parseJson(group.merged_json, {});
    if (merged.expiredAt) continue;
    const dir = groupDir(group.id);
    summary.bytesFreed += await directoryBytes(dir);
    if (!dryRun) {
      await fs.rm(dir, { recursive: true, force: true });
      sqlite.prepare("UPDATE seedance_group SET merged_json = ?, updated_at = ? WHERE id = ?").run(JSON.stringify({ ...merged, expiredAt: new Date(now).toISOString() }), nowIso(), group.id);
    }
    summary.expiredGroups += 1;
  }
  const uploadCutoff = new Date(now - UPLOAD_RETENTION_MS).toISOString();
  const refs = sqlite.prepare("SELECT * FROM seedance_ref WHERE created_at < ? ORDER BY created_at ASC LIMIT 500").all(uploadCutoff);
  const busyRefIds = new Set();
  for (const task of activeTaskRows()) {
    for (const item of parseJson(task.content_json, [])) if (item?.refId) busyRefIds.add(item.refId);
  }
  for (const ref of refs) {
    if (busyRefIds.has(ref.id)) continue;
    summary.bytesFreed += Number(ref.bytes || 0);
    if (!dryRun) await deleteSeedanceRef(ref);
    summary.refsDeleted += 1;
  }
  const tmp = path.join(seedanceAssetDir(), "tmp");
  const entries = await fs.readdir(tmp, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const file = path.join(tmp, entry.name);
    const stats = await fs.stat(file).catch(() => null);
    if (!stats || now - stats.mtimeMs < UPLOAD_RETENTION_MS) continue;
    if (!dryRun) await fs.rm(file, { force: true });
    summary.tmpDeleted += 1;
    summary.bytesFreed += stats.size;
  }
  return summary;
}

async function directoryBytes(dir) {
  let total = 0;
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const stats = await fs.stat(path.join(dir, entry.name)).catch(() => null);
    if (stats) total += stats.size;
  }
  return total;
}

registerStorageMaintenanceHook("seedance", runSeedanceMaintenance);

/* ── 分段接力：齐了就用 ffmpeg 拼成一条 ─────────────────────────────────── */

let ffmpegAvailable = null;
const mergingGroups = new Set();

function ffmpegBin() {
  return process.env.FFMPEG_BIN || "ffmpeg";
}

function runFfmpeg(args, { timeoutMs = 10 * 60 * 1000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegBin(), args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("ffmpeg 合并超时。"));
    }, timeoutMs);
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
      if (stderr.length > 20000) stderr = stderr.slice(-10000);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      if (error?.code === "ENOENT") ffmpegAvailable = false;
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        ffmpegAvailable = true;
        resolve();
      } else reject(new Error(`ffmpeg 退出码 ${code}：${stderr.trim().split("\n").slice(-3).join(" / ")}`));
    });
  });
}

/**
 * 组里的段都有结果了就结算：全完成 → 合并；有失败 → 标 partial（各段照样能单独看）。
 * 合并用 concat demuxer 流拷贝（同模型同参数出来的段编码一致，不重编码、几秒钟就好）；失败再退回重编码一次。
 */
export async function settleGroup(groupId) {
  const group = getGroupRow(groupId);
  if (!group || group.status === "merged" || group.status === "merging") return group;
  const rows = sqlite.prepare("SELECT * FROM seedance_task WHERE group_id = ? ORDER BY group_index ASC").all(groupId);
  if (!rows.length) return group;
  const done = rows.filter((row) => row.status === "completed");
  const ended = rows.filter((row) => ["failed", "cancelled", "expired"].includes(row.status));
  if (done.length + ended.length < Number(group.total)) return group; // 还有段没跑完
  if (ended.length) {
    sqlite.prepare("UPDATE seedance_group SET status = 'partial', error = ?, updated_at = ? WHERE id = ?").run(`有 ${ended.length} 段没成功，没法拼成完整一条；成功的段可以单独下载。`, nowIso(), groupId);
    return getGroupRow(groupId);
  }
  if (mergingGroups.has(groupId)) return group;
  mergingGroups.add(groupId);
  sqlite.prepare("UPDATE seedance_group SET status = 'merging', updated_at = ? WHERE id = ?").run(nowIso(), groupId);
  try {
    const files = done.map((row) => {
      const result = parseJson(row.result_json, {});
      return path.join(taskAssetDir(row.id), result.video.name);
    });
    const format = parseJson(done[0].result_json, {}).video?.format === "mov" ? "mov" : "mp4";
    const dir = groupDir(groupId);
    await fs.mkdir(dir, { recursive: true });
    const listFile = path.join(dir, "segments.txt");
    await fs.writeFile(listFile, files.map((file) => `file '${file.replace(/'/g, "'\\''")}'`).join("\n"), "utf8");
    const output = path.join(dir, `merged.${format}`);
    const partial = `${output}.part.${format}`;
    try {
      await runFfmpeg(["-y", "-hide_banner", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", listFile, "-c", "copy", "-movflags", "+faststart", partial]);
    } catch (error) {
      if (ffmpegAvailable === false) throw new Error("服务器没装 ffmpeg，合并不了；各段可以分别下载。");
      // 段之间编码参数不完全一致时流拷贝会失败，退回重编码。
      await runFfmpeg(["-y", "-hide_banner", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", listFile, "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", partial]);
    }
    await fs.rename(partial, output);
    const stats = await fs.stat(output);
    const probe = probeMedia(output);
    const merged = { name: path.basename(output), bytes: stats.size, format, durationSeconds: probe?.duration ?? null, segments: done.length, mergedAt: nowIso() };
    sqlite.prepare("UPDATE seedance_group SET status = 'merged', merged_json = ?, error = NULL, updated_at = ? WHERE id = ?").run(JSON.stringify(merged), nowIso(), groupId);
  } catch (error) {
    sqlite.prepare("UPDATE seedance_group SET status = 'failed', error = ?, updated_at = ? WHERE id = ?").run(`合并失败：${error?.message || error}`, nowIso(), groupId);
  } finally {
    mergingGroups.delete(groupId);
  }
  return getGroupRow(groupId);
}

function insertTaskRow({ userId, arkTaskId = null, params, content, groupId = null, groupIndex = null }) {
  const id = `sd-${Date.now()}-${randomUUID().slice(0, 6)}`;
  const timestamp = nowIso();
  sqlite
    .prepare(
      `INSERT INTO seedance_task (id, user_id, ark_task_id, model, mode, status, prompt, params_json, content_json, result_json, credits, created_at, updated_at, group_id, group_index, submitted_at)
       VALUES (?, ?, ?, ?, ?, 'queued', ?, ?, ?, '{}', 0, ?, ?, ?, ?, ?)`,
    )
    .run(id, userId, arkTaskId, params.model, params.mode, params.prompt, JSON.stringify({ ...params, count: 1 }), JSON.stringify(content), timestamp, timestamp, groupId, groupIndex, arkTaskId ? timestamp : null);
  return id;
}

/** 分段接力：N 张关键帧拆成 N-1 份首尾帧参数，每份提示词相同。 */
function splitIntoSegments(params) {
  const frames = [params.firstFrame, ...params.middleFrames, params.lastFrame].filter(Boolean);
  const segments = [];
  for (let index = 0; index < frames.length - 1; index += 1) {
    segments.push({ ...params, firstFrame: frames[index], lastFrame: frames[index + 1], middleFrames: [], keyframeStrategy: null, count: 1, segment: { index: index + 1, total: frames.length - 1 } });
  }
  // 没给尾帧：最后一张中间帧之后还有一段只给首帧的。
  if (!params.lastFrame) segments.push({ ...params, firstFrame: frames[frames.length - 1], lastFrame: null, middleFrames: [], keyframeStrategy: null, count: 1, segment: { index: frames.length, total: frames.length } });
  segments.forEach((segment) => {
    segment.segment.total = segments.length;
  });
  return segments;
}

export async function createSeedanceTasks({ userId, body }) {
  const params = normalizeSeedanceRequest(body, { userId });
  const caps = limits();
  const active = arkActiveCount(userId);
  const segments = params.keyframeStrategy === "segments" ? splitIntoSegments(params) : null;
  const wanted = segments ? segments.length : params.count;
  // 分段接力允许超出并发：先交并发允许的几段，剩下的在本站排队，轮询时依次补交。单条 / 多条照旧按并发卡。
  if (!segments && active + wanted > caps.maxActivePerUser) {
    const error = new Error(
      active >= caps.maxActivePerUser
        ? `同时最多跑 ${caps.maxActivePerUser} 条，等前面的完成再来。`
        : `同时最多跑 ${caps.maxActivePerUser} 条，现在还能再提 ${caps.maxActivePerUser - active} 条。`,
    );
    error.status = 429;
    throw error;
  }
  if (segments && active >= caps.maxActivePerUser) {
    const error = new Error(`同时最多跑 ${caps.maxActivePerUser} 条，等前面的完成再提分段接力。`);
    error.status = 429;
    throw error;
  }
  if (!arkConfigured()) throw new ArkError("还没配置 Seedance 的 API Key（后台 → 短视频接口 → Seedance）。", { status: 503, code: "not_configured" });

  if (segments) {
    const groupId = `sg-${Date.now()}-${randomUUID().slice(0, 6)}`;
    const timestamp = nowIso();
    sqlite
      .prepare("INSERT INTO seedance_group (id, user_id, strategy, total, status, merged_json, created_at, updated_at) VALUES (?, ?, 'segments', ?, 'pending', '{}', ?, ?)")
      .run(groupId, userId, segments.length, timestamp, timestamp);
    const created = [];
    let failure = null;
    let slots = Math.max(0, caps.maxActivePerUser - active);
    for (const segment of segments) {
      const content = contentSummary(segment);
      let arkTaskId = null;
      if (slots > 0 && !failure) {
        try {
          arkTaskId = await createArkTask(await arkPayloadFor(segment, { userId }));
          slots -= 1;
        } catch (error) {
          // 第一段就交不出去（Key 没权限 / 参数被拒）：整组都别建了，直接把错误抛给用户。
          if (!created.length) {
            sqlite.prepare("DELETE FROM seedance_group WHERE id = ?").run(groupId);
            throw error;
          }
          failure = error;
        }
      }
      const id = insertTaskRow({ userId, arkTaskId, params: segment, content, groupId, groupIndex: segment.segment.index });
      if (failure && !arkTaskId) markTaskEnded(id, "failed", `前一段提交失败，这一段没有提交：${failure.message}`, "group_abort");
      created.push(serializeSeedanceTask(getTaskRow(id)));
    }
    ensureSeedancePolling();
    return {
      tasks: created,
      group: serializeSeedanceGroup(getGroupRow(groupId)),
      warning: failure ? `分段接力只提交成功前面几段：${failure.message}` : null,
    };
  }

  const payload = await arkPayloadFor(params, { userId });
  const content = contentSummary(params);
  const created = [];
  let failure = null;
  for (let index = 0; index < params.count; index += 1) {
    let arkTaskId;
    try {
      arkTaskId = await createArkTask(payload);
    } catch (error) {
      failure = error;
      break;
    }
    const id = insertTaskRow({ userId, arkTaskId, params, content });
    created.push(serializeSeedanceTask(getTaskRow(id)));
  }
  if (!created.length && failure) throw failure;
  ensureSeedancePolling();
  return { tasks: created, warning: failure ? `只提交成功 ${created.length} 条：${failure.message}` : null };
}

/**
 * 本站排队的任务（ark_task_id 为空）：按创建顺序，谁的并发有空位就把谁交给方舟。
 * 每轮轮询先跑这个；交失败就标失败（后面的段也一并标掉，免得拼不出完整的一条）。
 */
export async function submitPendingTasks() {
  const pending = sqlite.prepare("SELECT * FROM seedance_task WHERE status = 'queued' AND ark_task_id IS NULL ORDER BY created_at ASC, group_index ASC").all();
  if (!pending.length) return 0;
  if (!arkConfigured()) return 0;
  const max = limits().maxActivePerUser;
  const used = new Map();
  let submitted = 0;
  for (const row of pending) {
    const current = used.has(row.user_id) ? used.get(row.user_id) : arkActiveCount(row.user_id);
    if (current >= max) {
      used.set(row.user_id, current);
      continue;
    }
    const params = parseJson(row.params_json, {});
    try {
      const arkTaskId = await createArkTask(await arkPayloadFor(params, { userId: row.user_id }));
      updateTask(row.id, { ark_task_id: arkTaskId, submitted_at: nowIso() });
      used.set(row.user_id, current + 1);
      submitted += 1;
    } catch (error) {
      markTaskEnded(row.id, "failed", error?.message || String(error), error instanceof ArkError ? error.code : "submit");
      if (row.group_id) {
        // 同组后面还没交的段一起放弃：少一段就拼不成。
        sqlite
          .prepare("UPDATE seedance_task SET status = 'failed', error = ?, error_code = 'group_abort', finished_at = ?, updated_at = ? WHERE group_id = ? AND status = 'queued' AND ark_task_id IS NULL")
          .run(`前一段提交失败，这一段没有提交：${error?.message || error}`, nowIso(), nowIso(), row.group_id);
        void settleGroup(row.group_id);
      }
      if (error instanceof ArkError && error.code === "unreachable") break;
    }
  }
  return submitted;
}

/* ── 取消 / 删除 ──────────────────────────────────────────────────────────── */

/**
 * 排队中：去方舟取消，再删本地记录。
 * 生成中：方舟不支持中途取消，删了本地也还会计费，所以默认拦下（force 才只删本地）。
 * 跑完的：删本地文件和记录，方舟那边的记录顺手删，删不掉不影响。
 */
export async function deleteSeedanceTask(row, { force = false } = {}) {
  if (row.status === "queued" && !row.ark_task_id) {
    // 还在本站排队，方舟那边没有它：直接删。
    sqlite.prepare("DELETE FROM seedance_task WHERE id = ?").run(row.id);
    await fs.rm(taskAssetDir(row.id), { recursive: true, force: true });
    await cleanupGroupAfterDelete(row.group_id);
    return;
  }
  if (row.status === "running" && !force) {
    const error = new Error("这条已经在生成了，火山方舟不支持中途取消（照样计费）。等它完成，或者勾「强制删除」只删本站记录。");
    error.status = 409;
    throw error;
  }
  if (row.ark_task_id && arkConfigured()) {
    if (row.status === "queued") {
      try {
        await deleteArkTask(row.ark_task_id);
      } catch (error) {
        // 可能已经从排队变成生成中了：刷一下状态再说。
        if (error instanceof ArkError && error.status !== 404) {
          const fresh = await getArkTask(row.ark_task_id).catch(() => null);
          if (fresh && String(fresh.status) === "running" && !force) {
            updateTask(row.id, { status: "running" });
            const conflict = new Error("刚好开始生成了，已经取消不了。等它完成，或者勾「强制删除」只删本站记录。");
            conflict.status = 409;
            throw conflict;
          }
        }
      }
    } else if (row.status !== "running") {
      void deleteArkTask(row.ark_task_id).catch((error) => console.warn(`[seedance] 清理方舟任务 ${row.ark_task_id} 失败：`, error?.message || error));
    }
  }
  await fs.rm(taskAssetDir(row.id), { recursive: true, force: true });
  sqlite.prepare("DELETE FROM seedance_task WHERE id = ?").run(row.id);
  downloadAttempts.delete(row.id);
  await cleanupGroupAfterDelete(row.group_id);
}

/** 组里最后一段也删了就把组（和合并成片）一起清掉；还有段在就只是重新结算。 */
async function cleanupGroupAfterDelete(groupId) {
  if (!groupId) return;
  const remaining = Number(sqlite.prepare("SELECT COUNT(*) AS count FROM seedance_task WHERE group_id = ?").get(groupId)?.count || 0);
  if (remaining > 0) return;
  await fs.rm(groupDir(groupId), { recursive: true, force: true });
  sqlite.prepare("DELETE FROM seedance_group WHERE id = ?").run(groupId);
}

/* ── 路由 ─────────────────────────────────────────────────────────────────── */

function sendError(res, error, fallback = "Seedance 服务出错了。") {
  if (error instanceof ValidationError) {
    res.status(400).json({ error: error.message });
    return;
  }
  if (error instanceof ArkError) {
    // 方舟那边的 401 / 403 是「Key 或权限」问题，不是浏览器这边没登录——别原样回 401 把前端当成掉线。
    const upstreamAuth = error.status === 401 || error.status === 403;
    const status = error.code === "not_configured" ? 503 : error.code === "unreachable" || upstreamAuth ? 502 : error.status >= 400 && error.status < 600 ? error.status : 502;
    res.status(status).json({ error: error.message, arkCode: error.code, arkStatus: error.status || undefined, requestId: error.requestId || undefined });
    return;
  }
  if (error && error.code === "LIMIT_FILE_SIZE") {
    res.status(413).json({ error: "文件太大了：图片最大 30 MB、音频 15 MB、视频 200 MB。" });
    return;
  }
  const status = Number(error?.status);
  if (Number.isFinite(status) && status >= 400 && status < 600) {
    res.status(status).json({ error: error.message });
    return;
  }
  console.error("[seedance]", error);
  res.status(500).json({ error: error instanceof Error ? error.message : fallback });
}

function ownedTaskOr404(req, res, account) {
  const row = getTaskRow(String(req.params.id || ""));
  if (!row || (row.user_id !== account.user.id && !isAdminRole(account.profile.role))) {
    res.status(404).json({ error: "任务不存在。" });
    return null;
  }
  return row;
}

function ownedRefOr404(req, res, account) {
  const row = getRefRow(String(req.params.id || ""));
  if (!row || (row.user_id !== account.user.id && !isAdminRole(account.profile.role))) {
    res.status(404).json({ error: "素材不存在。" });
    return null;
  }
  return row;
}

const MIME_BY_EXT = {
  jpg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  bmp: "image/bmp",
  tiff: "image/tiff",
  gif: "image/gif",
  heic: "image/heic",
  heif: "image/heif",
  mp4: "video/mp4",
  mov: "video/quicktime",
  mp3: "audio/mpeg",
  wav: "audio/wav",
};

async function sendRefFile(res, row, { download = false } = {}) {
  const filePath = refFilePath(row);
  try {
    await fs.access(filePath);
  } catch {
    res.status(404).json({ error: "文件已被清理。" });
    return;
  }
  res.sendFile(filePath, {
    headers: {
      "Content-Type": MIME_BY_EXT[row.ext] || "application/octet-stream",
      "Cache-Control": "private, max-age=3600",
      "Content-Disposition": download ? `attachment; filename="${row.original_name || row.id}"` : "inline",
    },
  });
}

const refUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, callback) => {
      const dir = path.join(seedanceAssetDir(), "tmp");
      fs.mkdir(dir, { recursive: true }).then(() => callback(null, dir), callback);
    },
    filename: (req, file, callback) => callback(null, `${randomUUID()}.upload`),
  }),
  // 先按最大的那类（视频 200 MB）收，分类后再按各自上限拦。
  limits: { fileSize: SEEDANCE_REF_KINDS.video.maxBytes, files: 1 },
});

function decodedUploadName(rawName) {
  const name = String(rawName || "");
  // multer 按 latin1 解文件名，中文会变乱码：看见非 ASCII 就按 UTF-8 重解一遍。
  return /[^\u0000-\u007f]/.test(name) ? Buffer.from(name, "latin1").toString("utf8") : name;
}

function pageOf(req, account) {
  const page = Number(req.query.page) || 1;
  const pageSize = Number(req.query.pageSize) || RECENT_TASK_LIMIT;
  const result = listSeedanceTaskPage(account.user.id, { page, pageSize });
  return {
    tasks: result.items,
    pagination: { page: result.page, pageSize: result.pageSize, pageCount: result.pageCount, total: result.total },
    activeCount: activeTaskCount(account.user.id),
    // 占并发的只有真在方舟那边跑的；本站排队的不算。
    arkActiveCount: arkActiveCount(account.user.id),
  };
}

export function registerSeedanceRoutes(app) {
  app.get("/api/seedance/overview", async (req, res) => {
    const account = await requireSeedanceAccount(req, res);
    if (!account) return;
    const status = await seedanceStatus();
    res.json({
      status,
      options: seedanceOptions(),
      refs: listSeedanceRefs(account.user.id),
      ...pageOf(req, account),
    });
  });

  app.post("/api/seedance/test", async (req, res) => {
    const account = await requireSeedanceAccount(req, res);
    if (!account) return;
    res.json({ status: await seedanceStatus({ force: true }) });
  });

  /* 参考素材 */
  app.get("/api/seedance/refs", async (req, res) => {
    const account = await requireSeedanceAccount(req, res);
    if (!account) return;
    res.json({ refs: listSeedanceRefs(account.user.id) });
  });

  app.post("/api/seedance/refs", (req, res) => {
    refUpload.single("file")(req, res, async (uploadError) => {
      if (uploadError) {
        sendError(res, uploadError, "上传失败。");
        return;
      }
      const account = await requireSeedanceAccount(req, res);
      if (!account) {
        if (req.file?.path) await fs.rm(req.file.path, { force: true });
        return;
      }
      if (!req.file) {
        res.status(400).json({ error: "没有收到文件。" });
        return;
      }
      try {
        const ref = await registerSeedanceRef({
          userId: account.user.id,
          tempPath: req.file.path,
          originalName: decodedUploadName(req.file.originalname),
          mimeType: req.file.mimetype,
        });
        res.json({ ref });
      } catch (error) {
        await fs.rm(req.file.path, { force: true });
        sendError(res, error, "上传失败。");
      }
    });
  });

  // 本站内部看素材（带登录态）。
  app.get("/api/seedance/refs/:id/file", async (req, res) => {
    const account = await requireSeedanceAccount(req, res);
    if (!account) return;
    const row = ownedRefOr404(req, res, account);
    if (!row) return;
    await sendRefFile(res, row, { download: req.query.download !== undefined });
  });

  // 给方舟取文件的公网地址：不带登录态，靠 32 位随机编号当口令。只认表里登记过的文件名。
  app.get("/api/seedance/refs/public/:file", async (req, res) => {
    const match = /^([a-f0-9]{32})\.([a-z0-9]{2,5})$/.exec(String(req.params.file || ""));
    if (!match) {
      res.status(404).json({ error: "文件不存在。" });
      return;
    }
    const row = getRefRow(match[1]);
    if (!row || row.ext !== match[2]) {
      res.status(404).json({ error: "文件不存在。" });
      return;
    }
    await sendRefFile(res, row);
  });

  app.delete("/api/seedance/refs/:id", async (req, res) => {
    const account = await requireSeedanceAccount(req, res);
    if (!account) return;
    const row = ownedRefOr404(req, res, account);
    if (!row) return;
    try {
      await deleteSeedanceRef(row);
      res.json({ ok: true });
    } catch (error) {
      sendError(res, error, "删除素材失败。");
    }
  });

  /* 任务 */
  app.get("/api/seedance/tasks", async (req, res) => {
    const account = await requireSeedanceAccount(req, res);
    if (!account) return;
    res.json(pageOf(req, account));
  });

  app.post("/api/seedance/tasks", async (req, res) => {
    const account = await requireSeedanceAccount(req, res);
    if (!account) return;
    try {
      const result = await createSeedanceTasks({ userId: account.user.id, body: req.body || {} });
      res.status(201).json({ ...result, activeCount: activeTaskCount(account.user.id), arkActiveCount: arkActiveCount(account.user.id) });
    } catch (error) {
      sendError(res, error, "提交失败。");
    }
  });

  app.get("/api/seedance/tasks/:id", async (req, res) => {
    const account = await requireSeedanceAccount(req, res);
    if (!account) return;
    const row = ownedTaskOr404(req, res, account);
    if (!row) return;
    res.json({ task: serializeSeedanceTask(row) });
  });

  app.delete("/api/seedance/tasks/:id", async (req, res) => {
    const account = await requireSeedanceAccount(req, res);
    if (!account) return;
    const row = ownedTaskOr404(req, res, account);
    if (!row) return;
    try {
      await deleteSeedanceTask(row, { force: req.query.force !== undefined || req.body?.force === true });
      res.json({ ok: true, activeCount: activeTaskCount(account.user.id), arkActiveCount: arkActiveCount(account.user.id) });
    } catch (error) {
      sendError(res, error, "删除失败。");
    }
  });

  // 成片 / 尾帧：只认结果里登记过的文件名；sendFile 自带 Range 支持，<video> 拖进度条靠它。
  app.get("/api/seedance/tasks/:id/files/:name", async (req, res) => {
    const account = await requireSeedanceAccount(req, res);
    if (!account) return;
    const row = ownedTaskOr404(req, res, account);
    if (!row) return;
    const name = path.basename(String(req.params.name || ""));
    const result = parseJson(row.result_json, {});
    const known = new Set([result.video?.name, result.lastFrame?.name].filter(Boolean));
    if (!name || !known.has(name) || !/^[\w.-]+$/.test(name)) {
      res.status(404).json({ error: "文件不存在。" });
      return;
    }
    if (row.expired_at) {
      res.status(410).json({ error: `成片在服务器上只保留 ${SERVER_RETENTION_DAYS} 天，已经清理${row.archive_path ? `；云盘里还有一份：${row.archive_path}` : ""}。` });
      return;
    }
    const filePath = path.join(taskAssetDir(row.id), name);
    try {
      await fs.access(filePath);
    } catch {
      res.status(404).json({ error: "文件已被清理。" });
      return;
    }
    const ext = path.extname(name).slice(1).toLowerCase();
    res.sendFile(filePath, {
      headers: {
        "Content-Type": MIME_BY_EXT[ext] || "application/octet-stream",
        "Cache-Control": "private, max-age=3600",
        "Content-Disposition": req.query.download !== undefined ? `attachment; filename="${row.id}-${name}"` : `inline; filename="${name}"`,
      },
    });
  });

  // 手动推云盘（和成片图的「归档」一个意思）。
  app.post("/api/seedance/tasks/:id/archive", async (req, res) => {
    const account = await requireSeedanceAccount(req, res);
    if (!account) return;
    const row = ownedTaskOr404(req, res, account);
    if (!row) return;
    const outcome = await archiveSeedanceTask(row);
    if (outcome.error) {
      res.status(outcome.status || 400).json({ error: outcome.error });
      return;
    }
    res.json({ ok: true, task: serializeSeedanceTask(getTaskRow(row.id)) });
  });

  /* 分段接力组 */
  const ownedGroupOr404 = (req, res, account) => {
    const group = getGroupRow(String(req.params.id || ""));
    if (!group || group.user_id !== account.user.id) {
      res.status(404).json({ error: "接力组不存在。" });
      return null;
    }
    return group;
  };

  app.get("/api/seedance/groups/:id", async (req, res) => {
    const account = await requireSeedanceAccount(req, res);
    if (!account) return;
    const group = ownedGroupOr404(req, res, account);
    if (!group) return;
    res.json({
      group: serializeSeedanceGroup(group),
      tasks: sqlite.prepare("SELECT * FROM seedance_task WHERE group_id = ? ORDER BY group_index ASC").all(group.id).map(serializeSeedanceTask),
    });
  });

  // 合并失败（比如当时 ffmpeg 忙）可以再试一次；partial 的组不行。
  app.post("/api/seedance/groups/:id/merge", async (req, res) => {
    const account = await requireSeedanceAccount(req, res);
    if (!account) return;
    const group = ownedGroupOr404(req, res, account);
    if (!group) return;
    if (group.status === "merged") {
      res.json({ group: serializeSeedanceGroup(group) });
      return;
    }
    if (group.status !== "failed" && group.status !== "pending") {
      res.status(409).json({ error: group.status === "partial" ? "有段没成功，拼不成完整一条。" : "正在合并中。" });
      return;
    }
    sqlite.prepare("UPDATE seedance_group SET status = 'pending', error = NULL, updated_at = ? WHERE id = ?").run(nowIso(), group.id);
    const settled = await settleGroup(group.id);
    res.json({ group: serializeSeedanceGroup(settled) });
  });

  app.get("/api/seedance/groups/:id/files/:name", async (req, res) => {
    const account = await requireSeedanceAccount(req, res);
    if (!account) return;
    const group = ownedGroupOr404(req, res, account);
    if (!group) return;
    const merged = parseJson(group.merged_json, {});
    const name = path.basename(String(req.params.name || ""));
    if (!merged.name || name !== merged.name || !/^[\w.-]+$/.test(name)) {
      res.status(404).json({ error: "文件不存在。" });
      return;
    }
    if (merged.expiredAt) {
      res.status(410).json({ error: `合并成片在服务器上只保留 ${SERVER_RETENTION_DAYS} 天，已经清理。` });
      return;
    }
    const filePath = path.join(groupDir(group.id), name);
    try {
      await fs.access(filePath);
    } catch {
      res.status(404).json({ error: "文件已被清理。" });
      return;
    }
    const ext = path.extname(name).slice(1).toLowerCase();
    res.sendFile(filePath, {
      headers: {
        "Content-Type": MIME_BY_EXT[ext] || "application/octet-stream",
        "Cache-Control": "private, max-age=3600",
        "Content-Disposition": req.query.download !== undefined ? `attachment; filename="${group.id}-${name}"` : `inline; filename="${name}"`,
      },
    });
  });

  // 把成片的尾帧登记成一张参考图，下一条直接当首帧用——连续镜头就是这么接出来的。
  app.post("/api/seedance/tasks/:id/last-frame-ref", async (req, res) => {
    const account = await requireSeedanceAccount(req, res);
    if (!account) return;
    const row = ownedTaskOr404(req, res, account);
    if (!row) return;
    const result = parseJson(row.result_json, {});
    if (!result.lastFrame?.name) {
      res.status(400).json({ error: "这条任务没有尾帧（提交时要勾「返回尾帧」）。" });
      return;
    }
    try {
      const source = path.join(taskAssetDir(row.id), result.lastFrame.name);
      const temp = path.join(seedanceAssetDir(), "tmp", `${randomUUID()}.upload`);
      await fs.mkdir(path.dirname(temp), { recursive: true });
      await fs.copyFile(source, temp);
      const ref = await registerSeedanceRef({ userId: account.user.id, tempPath: temp, originalName: `${row.id}-尾帧.png`, mimeType: "image/png", source: "last_frame" });
      res.json({ ref });
    } catch (error) {
      sendError(res, error, "登记尾帧失败。");
    }
  });

  /* 后台 */
  app.get("/api/admin/seedance", async (req, res) => {
    const account = await requireAdmin(req, res);
    if (!account) return;
    res.json({
      status: await seedanceStatus(),
      settings: seedanceSettingsView(),
      models: SEEDANCE_MODELS,
      activeTasks: Number(sqlite.prepare("SELECT COUNT(*) AS count FROM seedance_task WHERE status IN ('queued', 'running')").get()?.count || 0),
    });
  });

  app.put("/api/admin/seedance/settings", async (req, res) => {
    const account = await requireAdmin(req, res);
    if (!account) return;
    const result = saveSeedanceSettings(req.body || {}, { knownModels: SEEDANCE_MODELS.map((model) => model.id) });
    if (result.error) {
      res.status(400).json({ error: result.error });
      return;
    }
    statusCache = null;
    insertSeedanceAudit(account.user.id, "seedance.settings", { fields: Object.keys(req.body || {}) });
    res.json({ settings: result.settings, status: await seedanceStatus({ force: true }) });
  });

  // 「测一下」：列一页任务 + 拉模型列表。只读，不会生成任何视频、不产生费用。
  app.post("/api/admin/seedance/test", async (req, res) => {
    const account = await requireAdmin(req, res);
    if (!account) return;
    try {
      const ping = await pingArk({ withModels: false });
      let models = [];
      let modelsError = "";
      try {
        models = await listArkVideoModels();
      } catch (error) {
        modelsError = error instanceof Error ? error.message : String(error);
      }
      const known = new Set(SEEDANCE_MODELS.map((model) => model.id));
      // 模型调用权限自检：对目录里每个模型发一个注定被参数校验拦下的请求，看鉴权过不过。不会建任务、不花钱。
      let modelAccess = [];
      if (req.body?.probeModels !== false) {
        try {
          modelAccess = await probeArkModelAccess(seedanceEnabledModels().map((model) => model.id));
        } catch (error) {
          modelAccess = [];
          modelsError = modelsError || (error instanceof Error ? error.message : String(error));
        }
      }
      res.json({
        ok: true,
        latencyMs: ping.latencyMs,
        total: ping.total,
        models: models.map((model) => ({ ...model, inCatalog: known.has(model.id) })),
        modelsError: modelsError || undefined,
        modelAccess,
        status: await seedanceStatus({ force: true }),
      });
    } catch (error) {
      sendError(res, error, "连不上火山方舟。");
    }
  });
}

function insertSeedanceAudit(actorUserId, action, detail) {
  sqlite
    .prepare(
      `INSERT INTO audit_log (id, actor_user_id, action, target_type, target_id, detail_json, created_at)
       VALUES (?, ?, ?, 'seedance', 'seedance', ?, ?)`,
    )
    .run(randomUUID(), actorUserId, action, JSON.stringify(detail || {}), nowIso());
}

export { ValidationError as SeedanceValidationError };
