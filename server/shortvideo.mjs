import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import multer from "multer";
import { isAdminRole, requireAccount, requireAdmin } from "./auth.mjs";
import { nowIso, sqlite } from "./db.mjs";
import {
  ENGINE_STATE,
  EngineError,
  createEngineVideoTask,
  deleteEngineTask,
  downloadEngineFile,
  engineConfigured,
  engineDisplayUrl,
  engineFileExists,
  engineFileUrl,
  getEngineTask,
  listEngineMaterials,
  listEngineMusics,
  pingEngine,
  safeEngineFileName,
  uploadEngineMaterial,
  uploadEngineMusic,
} from "./shortvideo-engine.mjs";
import { ENGINE_CONFIG_FIELDS, engineConfigEditable, engineRestartAvailable, readEngineConfig, restartEngine, writeEngineConfig } from "./shortvideo-engine-config.mjs";
import { saveShortVideoSettings, shortVideoSettings, shortVideoSettingsView } from "./shortvideo-settings.mjs";
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
import {
  MAX_SCRIPT_CHARS,
  generateShortVideoMetadata,
  generateShortVideoScript,
  generateShortVideoTerms,
  normalizeSubject,
  normalizeTerms,
  shortVideoLlmStatus,
  testShortVideoLlm,
} from "./shortvideo-llm.mjs";

/**
 * 短视频模块：MoneyPrinterTurbo 只当渲染引擎，账号、权限、任务表、文件、轮询、界面都在本站。
 * 设计说明见 docs/shortvideo-module.md。
 *
 * 权限：默认只有 admin（owner）能用；后台可以按账号打开 user_profile.shortvideo_enabled。
 * 前端只在 account.features.shortVideo 为 true 时渲染入口，服务端每个路由再各自把关。
 */

/* ── 选项目录 ─────────────────────────────────────────────────────────────── */

export const SHORTVIDEO_ASPECTS = Object.freeze([
  { id: "9:16", label: "竖屏 9:16", hint: "抖音 / 视频号 / Shorts", width: 1080, height: 1920 },
  { id: "16:9", label: "横屏 16:9", hint: "B 站 / YouTube", width: 1920, height: 1080 },
  { id: "1:1", label: "方形 1:1", hint: "信息流 / 小红书", width: 1080, height: 1080 },
]);

export const SHORTVIDEO_LANGUAGES = Object.freeze([
  { id: "", label: "跟随主题" },
  { id: "zh-CN", label: "简体中文" },
  { id: "zh-TW", label: "繁体中文" },
  { id: "en-US", label: "English" },
  { id: "ja-JP", label: "日本語" },
  { id: "ko-KR", label: "한국어" },
]);

// Edge TTS 的音色：MPT 用「<Neural 名>-<性别>」这种写法（性别后缀会在它那边剥掉）。
// 只挑常用的一批，太长的列表在下拉框里反而没法选。
export const SHORTVIDEO_VOICES = Object.freeze([
  { id: "zh-CN-XiaoxiaoNeural-Female", label: "晓晓 · 女 · 温暖", locale: "zh-CN" },
  { id: "zh-CN-XiaoyiNeural-Female", label: "晓伊 · 女 · 活泼", locale: "zh-CN" },
  { id: "zh-CN-YunxiNeural-Male", label: "云希 · 男 · 阳光", locale: "zh-CN" },
  { id: "zh-CN-YunjianNeural-Male", label: "云健 · 男 · 沉稳", locale: "zh-CN" },
  { id: "zh-CN-YunyangNeural-Male", label: "云扬 · 男 · 新闻", locale: "zh-CN" },
  { id: "zh-CN-YunxiaNeural-Male", label: "云夏 · 男 · 少年", locale: "zh-CN" },
  { id: "zh-CN-liaoning-XiaobeiNeural-Female", label: "晓北 · 女 · 东北话", locale: "zh-CN" },
  { id: "zh-CN-shaanxi-XiaoniNeural-Female", label: "晓妮 · 女 · 陕西话", locale: "zh-CN" },
  { id: "zh-TW-HsiaoChenNeural-Female", label: "曉臻 · 女 · 台灣", locale: "zh-TW" },
  { id: "zh-TW-YunJheNeural-Male", label: "雲哲 · 男 · 台灣", locale: "zh-TW" },
  { id: "zh-HK-HiuMaanNeural-Female", label: "曉曼 · 女 · 粵語", locale: "zh-HK" },
  { id: "zh-HK-WanLungNeural-Male", label: "雲龍 · 男 · 粵語", locale: "zh-HK" },
  { id: "en-US-JennyNeural-Female", label: "Jenny · Female · US", locale: "en-US" },
  { id: "en-US-AriaNeural-Female", label: "Aria · Female · US", locale: "en-US" },
  { id: "en-US-GuyNeural-Male", label: "Guy · Male · US", locale: "en-US" },
  { id: "en-US-ChristopherNeural-Male", label: "Christopher · Male · US", locale: "en-US" },
  { id: "en-GB-SoniaNeural-Female", label: "Sonia · Female · UK", locale: "en-GB" },
  { id: "en-GB-RyanNeural-Male", label: "Ryan · Male · UK", locale: "en-GB" },
  { id: "ja-JP-NanamiNeural-Female", label: "七海 · 女 · 日本語", locale: "ja-JP" },
  { id: "ja-JP-KeitaNeural-Male", label: "圭太 · 男 · 日本語", locale: "ja-JP" },
  { id: "ko-KR-SunHiNeural-Female", label: "선히 · 여 · 한국어", locale: "ko-KR" },
  { id: "ko-KR-InJoonNeural-Male", label: "인준 · 남 · 한국어", locale: "ko-KR" },
]);

// MPT 仓库 resource/fonts 自带的字体文件。
export const SHORTVIDEO_FONTS = Object.freeze([
  { id: "STHeitiMedium.ttc", label: "黑体 · 中" },
  { id: "STHeitiLight.ttc", label: "黑体 · 细" },
  { id: "MicrosoftYaHeiBold.ttc", label: "微软雅黑 · 粗" },
  { id: "MicrosoftYaHeiNormal.ttc", label: "微软雅黑 · 常规" },
  { id: "BeVietnamPro-Bold.ttf", label: "Be Vietnam Pro · Bold" },
  { id: "BeVietnamPro-Medium.ttf", label: "Be Vietnam Pro · Medium" },
  { id: "Charm-Bold.ttf", label: "Charm · Bold" },
  { id: "Charm-Regular.ttf", label: "Charm · Regular" },
  { id: "UTM Kabel KT.ttf", label: "UTM Kabel KT" },
]);

export const SHORTVIDEO_SUBTITLE_POSITIONS = Object.freeze([
  { id: "bottom", label: "底部" },
  { id: "center", label: "居中" },
  { id: "top", label: "顶部" },
  // 竖屏底部会被平台的按钮挡住，自定义高度就是为这个准备的。
  { id: "custom", label: "自定义高度" },
]);

export const SHORTVIDEO_CONCAT_MODES = Object.freeze([
  { id: "random", label: "随机拼接", hint: "素材顺序打乱" },
  { id: "sequential", label: "顺序拼接", hint: "按关键词 / 上传顺序" },
]);

export const SHORTVIDEO_TRANSITIONS = Object.freeze([
  { id: "", label: "无转场" },
  { id: "Shuffle", label: "随机转场" },
  { id: "FadeIn", label: "淡入" },
  { id: "FadeOut", label: "淡出" },
  { id: "SlideIn", label: "滑入" },
  { id: "SlideOut", label: "滑出" },
  { id: "ZoomIn", label: "推近" },
  { id: "ZoomOut", label: "拉远" },
]);

export const SHORTVIDEO_SOURCES = Object.freeze([
  { id: "pexels", label: "Pexels", hint: "免费实拍库，引擎需配 Key" },
  { id: "pixabay", label: "Pixabay", hint: "免费实拍库，引擎需配 Key" },
  { id: "coverr", label: "Coverr", hint: "偏氛围感的免费实拍库，引擎需配 Key；素材多为横屏" },
  { id: "local", label: "本地素材", hint: "自己上传的视频 / 图片（图片会自动做缓慢推近）" },
]);

export const SHORTVIDEO_BGM_TYPES = Object.freeze([
  { id: "random", label: "随机" },
  { id: "none", label: "无" },
  { id: "file", label: "指定文件" },
]);

export const SHORTVIDEO_STAGES = Object.freeze({
  queued: "排队中",
  script: "写文案",
  terms: "抽关键词",
  audio: "配音",
  subtitle: "排字幕",
  materials: "找素材",
  render: "合成视频",
  import: "回传成片",
  done: "完成",
  failed: "失败",
});

// 发布文案（标题 / 简介 / 话题标签）按平台的口味写，长度上限也不一样。
export const SHORTVIDEO_PLATFORMS = Object.freeze([
  { id: "douyin", label: "抖音" },
  { id: "xiaohongshu", label: "小红书" },
  { id: "bilibili", label: "B 站" },
  { id: "tiktok", label: "TikTok" },
  { id: "youtube", label: "YouTube Shorts" },
  { id: "instagram", label: "Instagram Reels" },
]);

const MATERIAL_EXTENSIONS = new Set(["mp4", "mov", "avi", "flv", "mkv", "jpg", "jpeg", "png"]);
// 引擎那边 /musics 的白名单和 30 MB 上限，这里先挡一道，报中文。
const MUSIC_EXTENSIONS = new Set(["mp3", "m4a", "aac", "wav", "flac", "ogg", "opus", "wma"]);
const MUSIC_MAX_BYTES = 30 * 1024 * 1024;
const MATERIAL_MAX_BYTES = 100 * 1024 * 1024;
// 任务列表一页多少条（前端可以用 pageSize 覆盖，上限 100）。
const RECENT_TASK_LIMIT = 30;
const ENGINE_STATUS_TTL_MS = 30000;
// 引擎连续失联多久算任务没救了。
const ENGINE_LOST_MS = 10 * 60 * 1000;

function limits() {
  return {
    maxActivePerUser: shortVideoSettings().maxActivePerUser,
    maxScriptChars: MAX_SCRIPT_CHARS,
    maxCount: 3,
    clipDuration: [2, 10],
    clipSpeed: [0.5, 2],
    paragraphs: [1, 10],
    customPosition: [0, 100],
    materialMaxBytes: MATERIAL_MAX_BYTES,
    musicMaxBytes: MUSIC_MAX_BYTES,
    maxScriptPromptChars: 500,
    // 服务器上的保留期：上传的素材 / 音乐 24 小时，成片和生成图一样 3 天。
    retention: { uploadHours: UPLOAD_RETENTION_HOURS, outputDays: SERVER_RETENTION_DAYS },
  };
}

export function shortVideoOptions() {
  return {
    aspects: SHORTVIDEO_ASPECTS,
    languages: SHORTVIDEO_LANGUAGES,
    voices: SHORTVIDEO_VOICES,
    fonts: SHORTVIDEO_FONTS,
    subtitlePositions: SHORTVIDEO_SUBTITLE_POSITIONS,
    concatModes: SHORTVIDEO_CONCAT_MODES,
    transitions: SHORTVIDEO_TRANSITIONS,
    sources: SHORTVIDEO_SOURCES,
    bgm: SHORTVIDEO_BGM_TYPES,
    stages: SHORTVIDEO_STAGES,
    platforms: SHORTVIDEO_PLATFORMS,
    limits: limits(),
  };
}

/* ── 权限 ─────────────────────────────────────────────────────────────────── */

export function canUseShortVideo(profile) {
  if (!profile) return false;
  return isAdminRole(profile.role) || Number(profile.shortvideo_enabled ?? 0) === 1;
}

/** 账号信息里给前端的开关：只在为 true 时渲染入口和视图。 */
export function shortVideoFeatureFor(profile) {
  return { shortVideo: canUseShortVideo(profile) };
}

async function requireShortVideoAccount(req, res) {
  const account = await requireAccount(req, res);
  if (!account) return null;
  if (!canUseShortVideo(account.profile)) {
    res.status(403).json({ error: "短视频功能暂未对这个账号开放。" });
    return null;
  }
  return account;
}

/* ── 存储 ─────────────────────────────────────────────────────────────────── */

export function shortVideoAssetDir() {
  return path.resolve(process.env.SHORTVIDEO_ASSET_DIR || "./data/shortvideo");
}

function taskAssetDir(taskId) {
  return path.join(shortVideoAssetDir(), taskId);
}

export function migrateShortVideoDatabase() {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS shortvideo_task (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      engine_task_id TEXT,
      status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed', 'cancelled')),
      progress INTEGER NOT NULL DEFAULT 0,
      stage TEXT NOT NULL DEFAULT 'queued',
      subject TEXT NOT NULL DEFAULT '',
      script TEXT NOT NULL DEFAULT '',
      terms_json TEXT NOT NULL DEFAULT '[]',
      params_json TEXT NOT NULL DEFAULT '{}',
      result_json TEXT NOT NULL DEFAULT '{}',
      error TEXT,
      failure_source TEXT,
      credits INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      finished_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_shortvideo_task_user ON shortvideo_task(user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_shortvideo_task_status ON shortvideo_task(status);
    CREATE TABLE IF NOT EXISTS shortvideo_upload (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('material', 'music')),
      file TEXT NOT NULL,
      original_name TEXT NOT NULL DEFAULT '',
      bytes INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_shortvideo_upload_created ON shortvideo_upload(created_at);
  `);
  // 老表补列：成片的保留 / 归档状态，和 generated_result 一个路子。
  const columns = new Set(sqlite.prepare("PRAGMA table_info(shortvideo_task)").all().map((column) => column.name));
  const add = (name, ddl) => {
    if (!columns.has(name)) sqlite.exec(`ALTER TABLE shortvideo_task ADD COLUMN ${name} ${ddl}`);
  };
  add("storage_status", "TEXT NOT NULL DEFAULT 'cloud-temp'");
  add("archived_at", "TEXT");
  add("archive_path", "TEXT");
  add("expired_at", "TEXT");
}

function parseJson(text, fallback) {
  try {
    const value = JSON.parse(text);
    return value ?? fallback;
  } catch {
    return fallback;
  }
}

function fileUrl(taskId, name) {
  return `/api/shortvideo/tasks/${encodeURIComponent(taskId)}/files/${encodeURIComponent(name)}`;
}

export function serializeShortVideoTask(row) {
  if (!row) return null;
  const result = parseJson(row.result_json, {});
  const filesGone = Boolean(row.expired_at);
  const videos =
    Array.isArray(result.videos) && !filesGone
      ? result.videos.map((video) => ({ name: video.name, bytes: Number(video.bytes || 0), url: fileUrl(row.id, video.name) }))
      : [];
  return {
    id: row.id,
    storage: {
      status: row.storage_status || "cloud-temp",
      expiresAt: row.status === "completed" && row.finished_at ? resultExpiresAt(row.finished_at) : null,
      archivedAt: row.archived_at || null,
      archivePath: row.archive_path || null,
      expiredAt: row.expired_at || null,
      retentionDays: SERVER_RETENTION_DAYS,
    },
    status: row.status,
    progress: Number(row.progress || 0),
    stage: row.stage,
    stageLabel: SHORTVIDEO_STAGES[row.stage] || row.stage,
    subject: row.subject,
    script: row.script,
    terms: parseJson(row.terms_json, []),
    params: parseJson(row.params_json, {}),
    result: {
      videos,
      subtitle: result.subtitle && !filesGone ? fileUrl(row.id, result.subtitle) : null,
      audioDuration: result.audioDuration ?? null,
      warnings: result.warnings ?? null,
    },
    error: row.error || null,
    failureSource: row.failure_source || null,
    credits: Number(row.credits || 0),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    finishedAt: row.finished_at || null,
  };
}

function getTaskRow(taskId) {
  return sqlite.prepare("SELECT * FROM shortvideo_task WHERE id = ?").get(taskId);
}

/**
 * 分页版：任务攒多了要能往回翻，不能只给最近 30 条。
 * 页码超出范围就夹回最后一页，删任务之后不会停在空白页。
 */
export function listShortVideoTaskPage(userId, { page = 1, pageSize = RECENT_TASK_LIMIT } = {}) {
  const size = Math.min(Math.max(Number(pageSize) || RECENT_TASK_LIMIT, 1), 100);
  const total = Number(sqlite.prepare("SELECT COUNT(*) AS count FROM shortvideo_task WHERE user_id = ?").get(userId)?.count || 0);
  const pageCount = Math.max(1, Math.ceil(total / size));
  const safePage = Math.min(Math.max(Number(page) || 1, 1), pageCount);
  const items = total
    ? sqlite
        .prepare("SELECT * FROM shortvideo_task WHERE user_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?")
        .all(userId, size, (safePage - 1) * size)
        .map(serializeShortVideoTask)
    : [];
  return { items, total, page: safePage, pageSize: size, pageCount };
}

function activeTaskCount(userId) {
  const row = sqlite
    .prepare("SELECT COUNT(*) AS count FROM shortvideo_task WHERE user_id = ? AND status IN ('queued', 'running')")
    .get(userId);
  return Number(row?.count || 0);
}

/**
 * 写任务字段；onlyActive 时只改还在 queued / running 的行，返回实际改到的行数。
 * 轮询是先读行、再等引擎、再写回——中间用户可能已经点了取消，不加这个条件，
 * 引擎那边的回包会把 cancelled 又改回 running / completed / failed。
 */
function updateTask(taskId, fields, { onlyActive = false } = {}) {
  const keys = Object.keys(fields);
  if (!keys.length) return 0;
  const assignments = keys.map((key) => `${key} = ?`).join(", ");
  const guard = onlyActive ? " AND status IN ('queued', 'running')" : "";
  const info = sqlite
    .prepare(`UPDATE shortvideo_task SET ${assignments}, updated_at = ? WHERE id = ?${guard}`)
    .run(...keys.map((key) => fields[key]), nowIso(), taskId);
  return Number(info?.changes || 0);
}

/** 标失败只对还在跑的任务有意义：已经取消 / 完成的不动。 */
function markTaskFailed(taskId, message, source = "engine") {
  return updateTask(
    taskId,
    {
      status: "failed",
      stage: "failed",
      error: String(message || "生成失败。").slice(0, 600),
      failure_source: source,
      finished_at: nowIso(),
    },
    { onlyActive: true },
  );
}

/* ── 参数规范化 ───────────────────────────────────────────────────────────── */

class ValidationError extends Error {}

function pickOption(list, raw, fallback, label) {
  if (raw === undefined || raw === null) return fallback;
  const value = String(raw).trim();
  if (list.some((item) => item.id === value)) return value;
  throw new ValidationError(`${label}不在可选范围内。`);
}

function numberIn(raw, { min, max, fallback, label, integer = false }) {
  if (raw === undefined || raw === null || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new ValidationError(`${label}要是数字。`);
  if (value < min || value > max) throw new ValidationError(`${label}要在 ${min}–${max} 之间。`);
  return integer ? Math.round(value) : value;
}

function colorOrThrow(raw, fallback, label) {
  if (raw === undefined || raw === null || raw === "") return fallback;
  const value = String(raw).trim();
  if (!/^#[0-9a-fA-F]{6}$/.test(value)) throw new ValidationError(`${label}要写成 #RRGGBB。`);
  return value.toUpperCase();
}

/** 把前端 / 第三方发来的请求体收成本站的规范参数；越界一律 400 报中文。 */
export function normalizeShortVideoRequest(body = {}) {
  const input = body && typeof body === "object" ? body : {};
  const subject = normalizeSubject(input.subject);
  const script = String(input.script ?? "").replace(/\r\n?/g, "\n").trim();
  if (!subject && !script) throw new ValidationError("主题和文案至少填一个。");
  if (script.length > MAX_SCRIPT_CHARS) throw new ValidationError(`文案太长了，最多 ${MAX_SCRIPT_CHARS} 字。`);
  const terms = normalizeTerms(input.terms, 10);
  const source = pickOption(SHORTVIDEO_SOURCES, input.source, "pexels", "素材来源");
  const materials = Array.isArray(input.materials)
    ? input.materials.map((item) => safeEngineFileName(item)).filter(Boolean).slice(0, 30)
    : [];
  if (source === "local" && !materials.length) throw new ValidationError("选了本地素材就至少要挑一个文件。");
  const bgmInput = input.bgm && typeof input.bgm === "object" ? input.bgm : {};
  const subtitleInput = input.subtitle && typeof input.subtitle === "object" ? input.subtitle : {};
  const bgmType = pickOption(SHORTVIDEO_BGM_TYPES, bgmInput.type, "random", "背景音乐");
  const bgmFile = bgmType === "file" ? safeEngineFileName(bgmInput.file) : "";
  if (bgmType === "file" && !bgmFile) throw new ValidationError("指定背景音乐时要选一个文件。");
  const caps = limits();
  const subtitlePosition = pickOption(SHORTVIDEO_SUBTITLE_POSITIONS, subtitleInput.position, "bottom", "字幕位置");
  const backgroundInput = subtitleInput.background && typeof subtitleInput.background === "object" ? subtitleInput.background : {};
  return {
    subject,
    script,
    terms,
    language: pickOption(SHORTVIDEO_LANGUAGES, input.language, "", "文案语言"),
    aspect: pickOption(SHORTVIDEO_ASPECTS, input.aspect, "9:16", "画幅"),
    clipDuration: numberIn(input.clipDuration, { min: caps.clipDuration[0], max: caps.clipDuration[1], fallback: 5, label: "单段时长", integer: true }),
    // 片段倍速：素材偏慢的时候提一点节奏；引擎自己也会夹到 0.5–2。
    clipSpeed: numberIn(input.clipSpeed, { min: caps.clipSpeed[0], max: caps.clipSpeed[1], fallback: 1, label: "片段倍速" }),
    // 素材按文案顺序匹配：开了之后引擎会逐段找素材并强制顺序拼接。
    matchScript: Boolean(input.matchScript),
    // 让 AI 写几段；段落多了适合长一点的口播。
    paragraphs: numberIn(input.paragraphs, { min: caps.paragraphs[0], max: caps.paragraphs[1], fallback: 1, label: "段落数", integer: true }),
    // 写文案时的额外要求（只影响本站这边的模型，引擎收到的是写好的文案）。
    scriptPrompt: String(input.scriptPrompt ?? "").trim().slice(0, caps.maxScriptPromptChars),
    concatMode: pickOption(SHORTVIDEO_CONCAT_MODES, input.concatMode, "random", "拼接方式"),
    transition: pickOption(SHORTVIDEO_TRANSITIONS, input.transition, "", "转场"),
    count: numberIn(input.count, { min: 1, max: caps.maxCount, fallback: 1, label: "生成条数", integer: true }),
    source,
    materials,
    voice: pickOption(SHORTVIDEO_VOICES, input.voice, "zh-CN-XiaoxiaoNeural-Female", "配音音色"),
    voiceRate: numberIn(input.voiceRate, { min: 0.5, max: 2, fallback: 1, label: "语速" }),
    voiceVolume: numberIn(input.voiceVolume, { min: 0, max: 2, fallback: 1, label: "配音音量" }),
    bgm: {
      type: bgmType,
      file: bgmFile,
      volume: numberIn(bgmInput.volume, { min: 0, max: 1, fallback: 0.2, label: "背景音乐音量" }),
    },
    subtitle: {
      enabled: subtitleInput.enabled === undefined ? true : Boolean(subtitleInput.enabled),
      position: subtitlePosition,
      // 距顶部百分比，只有位置选「自定义高度」时才用得上。
      customPosition: numberIn(subtitleInput.customPosition, { min: caps.customPosition[0], max: caps.customPosition[1], fallback: 70, label: "字幕高度" }),
      font: pickOption(SHORTVIDEO_FONTS, subtitleInput.font, "STHeitiMedium.ttc", "字幕字体"),
      size: numberIn(subtitleInput.size, { min: 24, max: 120, fallback: 60, label: "字幕字号", integer: true }),
      color: colorOrThrow(subtitleInput.color, "#FFFFFF", "字幕颜色"),
      strokeColor: colorOrThrow(subtitleInput.strokeColor, "#000000", "描边颜色"),
      strokeWidth: numberIn(subtitleInput.strokeWidth, { min: 0, max: 6, fallback: 1.5, label: "描边宽度" }),
      // 亮素材上白字看不清，给字幕加一条底色（可圆角）。
      background: {
        enabled: Boolean(backgroundInput.enabled),
        color: colorOrThrow(backgroundInput.color, "#000000", "字幕底色"),
        rounded: backgroundInput.rounded === undefined ? true : Boolean(backgroundInput.rounded),
      },
    },
  };
}

/** 本站参数 → MPT 的 TaskVideoRequest。 */
export function engineRequestFor(params, { script, terms }) {
  const bgmType = params.bgm.type === "none" ? "" : params.bgm.type === "file" ? "custom" : "random";
  return {
    video_subject: params.subject || script.slice(0, 60),
    video_script: script,
    video_terms: params.source === "local" ? [] : terms,
    video_aspect: params.aspect,
    video_concat_mode: params.concatMode,
    video_transition_mode: params.transition || null,
    video_clip_duration: params.clipDuration,
    video_clip_speed: params.clipSpeed,
    match_materials_to_script: params.matchScript,
    video_count: params.count,
    video_source: params.source,
    video_materials: params.source === "local" ? params.materials.map((name) => ({ provider: "local", url: name, duration: 0 })) : null,
    video_language: params.language,
    voice_name: params.voice,
    voice_volume: params.voiceVolume,
    voice_rate: params.voiceRate,
    bgm_type: bgmType,
    bgm_file: params.bgm.type === "file" ? params.bgm.file : "",
    bgm_volume: params.bgm.volume,
    subtitle_enabled: params.subtitle.enabled,
    subtitle_position: params.subtitle.position,
    custom_position: params.subtitle.customPosition,
    font_name: params.subtitle.font,
    text_fore_color: params.subtitle.color,
    font_size: params.subtitle.size,
    stroke_color: params.subtitle.strokeColor,
    stroke_width: params.subtitle.strokeWidth,
    // 引擎那边是「false 关 / 颜色字符串开」这一种写法。
    text_background_color: params.subtitle.background.enabled ? params.subtitle.background.color : false,
    rounded_subtitle_background: params.subtitle.background.enabled ? params.subtitle.background.rounded : false,
    n_threads: shortVideoSettings().renderThreads,
    paragraph_number: params.paragraphs,
  };
}

/** 第一版不扣费：admin 自己用。将来收费从这里给数，创建时 consumeCredits、失败时 refundCredits。 */
export function estimateShortVideoCredits() {
  return 0;
}

/* ── 引擎状态（带缓存） ───────────────────────────────────────────────────── */

let engineStatusCache = { checkedAt: 0, value: null };

export async function shortVideoEngineStatus({ force = false } = {}) {
  const configured = engineConfigured();
  if (!configured) {
    return { configured: false, online: false, url: "", checkedAt: nowIso(), latencyMs: null, error: "没有配置 SHORTVIDEO_ENGINE_URL。" };
  }
  if (!force && engineStatusCache.value && Date.now() - engineStatusCache.checkedAt < ENGINE_STATUS_TTL_MS) {
    return engineStatusCache.value;
  }
  let value;
  try {
    const ping = await pingEngine();
    value = { configured: true, online: true, url: engineDisplayUrl(), checkedAt: nowIso(), latencyMs: ping.latencyMs, error: null };
  } catch (error) {
    value = {
      configured: true,
      online: false,
      url: engineDisplayUrl(),
      checkedAt: nowIso(),
      latencyMs: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
  engineStatusCache = { checkedAt: Date.now(), value };
  return value;
}

/* ── 轮询 ─────────────────────────────────────────────────────────────────── */

function pollIntervalMs() {
  const value = Number(process.env.SHORTVIDEO_POLL_INTERVAL_MS || 3000);
  return Number.isFinite(value) && value >= 100 ? value : 3000;
}

let pollTimer = null;
let polling = false;
// 引擎失联的起点，按任务记；恢复后清掉。
const engineLostSince = new Map();

function stageForProgress(progress) {
  if (progress < 10) return "script";
  if (progress < 20) return "terms";
  if (progress < 30) return "audio";
  if (progress < 40) return "subtitle";
  if (progress < 50) return "materials";
  return "render";
}

function activeTaskRows() {
  return sqlite.prepare("SELECT * FROM shortvideo_task WHERE status IN ('queued', 'running') ORDER BY created_at ASC").all();
}

export function ensureShortVideoPolling() {
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

/** 服务重启后把库里没跑完的任务重新纳入轮询——引擎那边多半还在跑。 */
export function resumeShortVideoPolling() {
  if (activeTaskRows().length > 0) ensureShortVideoPolling();
}

async function pollActiveTasks() {
  if (polling) return;
  polling = true;
  try {
    const rows = activeTaskRows();
    if (!rows.length) {
      stopPollingIfIdle();
      return;
    }
    for (const row of rows) {
      try {
        await syncTaskFromEngine(row);
      } catch (error) {
        console.error(`[shortvideo] 同步任务 ${row.id} 失败：`, error);
      }
    }
    stopPollingIfIdle();
  } finally {
    polling = false;
  }
}

async function syncTaskFromEngine(row) {
  if (!row.engine_task_id) {
    markTaskFailed(row.id, "任务没有引擎侧编号。", "system");
    return;
  }
  let engineTask;
  try {
    engineTask = await getEngineTask(row.engine_task_id);
  } catch (error) {
    // 引擎暂时打不通：先记着，超过阈值才判失败。
    const since = engineLostSince.get(row.id) || Date.now();
    engineLostSince.set(row.id, since);
    if (Date.now() - since > ENGINE_LOST_MS) {
      engineLostSince.delete(row.id);
      markTaskFailed(row.id, `短视频引擎失联超过 ${Math.round(ENGINE_LOST_MS / 60000)} 分钟：${error instanceof Error ? error.message : String(error)}`, "system");
    }
    return;
  }
  engineLostSince.delete(row.id);

  if (!engineTask) {
    // MPT 重启后内存里的任务没了；成片如果已经落盘，照常收工。
    const guessUrl = engineFileUrl(`/tasks/${row.engine_task_id}/final-1.mp4`, row.engine_task_id);
    if (guessUrl && (await engineFileExists(guessUrl))) {
      const params = parseJson(row.params_json, {});
      const count = Math.max(1, Number(params.count || 1));
      const videos = Array.from({ length: count }, (_, index) => `/tasks/${row.engine_task_id}/final-${index + 1}.mp4`);
      await importFinishedTask(row, { videos, subtitle_path: `/tasks/${row.engine_task_id}/subtitle.srt` });
      return;
    }
    markTaskFailed(row.id, "短视频引擎重启，任务状态丢失，请重新生成。", "system");
    return;
  }

  const state = Number(engineTask.state);
  const progress = Math.min(Math.max(Number(engineTask.progress || 0), 0), 100);
  if (state === ENGINE_STATE.FAILED) {
    const stage = String(engineTask.failed_stage || "").trim();
    const detail = String(engineTask.error || "").trim();
    const stageLabel = SHORTVIDEO_STAGES[stage] || stage;
    markTaskFailed(row.id, [stageLabel ? `${stageLabel}阶段失败` : "生成失败", detail].filter(Boolean).join("：") || "生成失败。", "engine");
    return;
  }
  if (state === ENGINE_STATE.COMPLETE) {
    await importFinishedTask(row, engineTask);
    return;
  }
  const stage = stageForProgress(progress);
  if (row.status !== "running" || row.progress !== progress || row.stage !== stage) {
    updateTask(row.id, { status: "running", progress, stage }, { onlyActive: true });
  }
}

/** 引擎说完成了：把成片和字幕拉回本站目录，再标完成。等引擎回包的这段时间里任务可能已被取消，每次落库都只认还在跑的行。 */
async function importFinishedTask(row, engineTask) {
  // 改不到行 = 这条任务在等引擎的时候被取消了：成片不要了，也别再往下拉文件。
  if (!updateTask(row.id, { status: "running", progress: 100, stage: "import" }, { onlyActive: true })) return;
  const engineVideos = Array.isArray(engineTask.videos) ? engineTask.videos : [];
  if (!engineVideos.length) {
    markTaskFailed(row.id, "引擎报告完成，但没有给出成片文件。", "engine");
    return;
  }
  const directory = taskAssetDir(row.id);
  const videos = [];
  try {
    for (const ref of engineVideos) {
      const name = safeEngineFileName(ref);
      const url = engineFileUrl(ref, row.engine_task_id);
      if (!name || !url) continue;
      const bytes = await downloadEngineFile(url, path.join(directory, name));
      videos.push({ name, bytes });
    }
  } catch (error) {
    markTaskFailed(row.id, error instanceof Error ? error.message : String(error), "system");
    return;
  }
  if (!videos.length) {
    markTaskFailed(row.id, "成片路径无法解析，回传失败。", "system");
    return;
  }
  let subtitle = null;
  const subtitleUrl = engineTask.subtitle_path ? engineFileUrl(engineTask.subtitle_path, row.engine_task_id) : "";
  if (subtitleUrl) {
    try {
      await downloadEngineFile(subtitleUrl, path.join(directory, "subtitle.srt"));
      subtitle = "subtitle.srt";
    } catch {
      subtitle = null; // 字幕拉不回来不算失败。
    }
  }
  const result = {
    videos,
    subtitle,
    audioDuration: Number.isFinite(Number(engineTask.audio_duration)) ? Number(engineTask.audio_duration) : null,
    warnings: Array.isArray(engineTask.warnings) && engineTask.warnings.length ? engineTask.warnings.map(String).slice(0, 10) : null,
    engineTaskId: row.engine_task_id,
  };
  const scriptText = String(engineTask.script || row.script || "");
  const completed = updateTask(
    row.id,
    {
      status: "completed",
      progress: 100,
      stage: "done",
      script: scriptText.slice(0, MAX_SCRIPT_CHARS),
      result_json: JSON.stringify(result),
      error: null,
      failure_source: null,
      finished_at: nowIso(),
    },
    { onlyActive: true },
  );
  if (!completed) {
    // 拉文件这几秒里用户取消了：cancelled 为准，刚落盘的成片清掉，取消那边已经删过引擎任务。
    await fs.rm(directory, { recursive: true, force: true }).catch(() => undefined);
    return;
  }
  // 成片已经拉回本站，引擎那边的整个任务目录（下载的素材、配音、字幕、成片副本）就是多余的，顺手清掉。
  if (row.engine_task_id && engineConfigured()) {
    void deleteEngineTask(row.engine_task_id).catch((error) => console.warn(`[shortvideo] 清理引擎任务 ${row.engine_task_id} 失败：`, error?.message || error));
  }
  void autoArchiveShortVideoTask(getTaskRow(row.id)).catch((error) => console.warn(`[shortvideo] 自动归档 ${row.id} 失败：`, error?.message || error));
}

/* ── 成片归档 / 到期清理（和生成图同一套规则：服务器暂存 3 天，可推 WebDAV） ── */

export async function archiveShortVideoTask(row) {
  if (!row || row.status !== "completed") return { error: "只有完成的成片能归档。", status: 400 };
  if (row.expired_at) return { error: "服务器上的文件已经过期清理，没法再归档。", status: 409 };
  const result = parseJson(row.result_json, {});
  const videos = Array.isArray(result.videos) ? result.videos : [];
  if (!videos.length) return { error: "这条任务没有成片文件。", status: 400 };
  let last = null;
  for (const [index, video] of videos.entries()) {
    const outcome = await archiveFileToUserWebdav(row.user_id, {
      filePath: path.join(taskAssetDir(row.id), video.name),
      title: `shortvideo-${String(row.subject || "video").slice(0, 40) || "video"}${videos.length > 1 ? `-${index + 1}` : ""}`,
      id: row.id,
      createdAt: row.created_at,
      extension: "mp4",
      mimeType: "video/mp4",
      subdirectory: "短视频",
    });
    if (outcome.error) return outcome;
    last = outcome;
  }
  updateTask(row.id, { storage_status: "webdav", archived_at: last.archivedAt, archive_path: last.archivePath });
  return last;
}

async function autoArchiveShortVideoTask(row) {
  if (!row || !userAutoArchiveEnabled(row.user_id)) return { skipped: true };
  const outcome = await archiveShortVideoTask(row);
  if (outcome.error) console.warn(`[shortvideo] auto archive failed for ${row.id}: ${outcome.error}`);
  return outcome;
}

/** 引擎装在本机时它的根目录（上传的素材 / 音乐就落在这里面）；不在本机就返回空，清理只能靠引擎自己。 */
export function engineLocalDir() {
  const explicit = String(process.env.SHORTVIDEO_ENGINE_DIR || "").trim();
  if (explicit) return path.resolve(explicit);
  const config = String(process.env.SHORTVIDEO_ENGINE_CONFIG || "").trim();
  return config ? path.dirname(path.resolve(config)) : "";
}

function recordUpload({ userId, kind, file, originalName, bytes }) {
  sqlite
    .prepare("INSERT INTO shortvideo_upload (id, user_id, kind, file, original_name, bytes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(randomUUID(), userId, kind, file, String(originalName || "").slice(0, 200), Number(bytes || 0), nowIso());
}

/** 上传记录按文件名查：列素材 / 音乐时标出「这是谁什么时候传的、几点会清」。 */
function uploadIndex() {
  const rows = sqlite.prepare("SELECT kind, file, user_id, original_name, created_at FROM shortvideo_upload").all();
  const index = new Map();
  for (const row of rows) {
    index.set(`${row.kind}:${row.file}`, { userId: row.user_id, originalName: row.original_name, createdAt: row.created_at, expiresAt: new Date(Date.parse(row.created_at) + UPLOAD_RETENTION_MS).toISOString() });
  }
  return index;
}

function annotateFiles(files, kind, userId) {
  const index = uploadIndex();
  return files.map((file) => {
    const upload = index.get(`${kind}:${file.name}`);
    return upload ? { ...file, uploadedAt: upload.createdAt, expiresAt: upload.expiresAt, mine: upload.userId === userId, originalName: upload.originalName || undefined } : file;
  });
}

/**
 * 每小时跟成片图一起巡检：
 *   - 完成 / 失败超过 3 天的任务：删本站的成片目录，记录标 expired；
 *   - 上传超过 24 小时的素材 / 音乐：引擎在本机就直接删文件（素材在 storage/local_videos，音乐在 resource/songs 里只删我们登记过的那些——自带歌曲不动），然后删登记；
 *   - 引擎 storage/local_videos 里没登记、放了超过 24 小时的文件（只会是上传进去的）一并清；
 *   - 引擎 storage/tasks 里超过 24 小时、又不属于任何在跑任务的目录（成片早已拉回本站）。
 */
export async function runShortVideoMaintenance({ now = Date.now(), dryRun = false } = {}) {
  const summary = { expiredTasks: 0, uploadsDeleted: 0, uploadsUntracked: 0, engineTaskDirsDeleted: 0, bytesFreed: 0, engineLocal: Boolean(engineLocalDir()), dryRun };
  const outputCutoff = new Date(now - SERVER_RETENTION_MS).toISOString();
  const rows = sqlite
    .prepare("SELECT * FROM shortvideo_task WHERE expired_at IS NULL AND status IN ('completed', 'failed', 'cancelled') AND COALESCE(finished_at, updated_at) < ? ORDER BY finished_at ASC LIMIT 500")
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

  const uploadCutoff = new Date(now - UPLOAD_RETENTION_MS).toISOString();
  const root = engineLocalDir();
  const uploads = sqlite.prepare("SELECT * FROM shortvideo_upload WHERE created_at < ? ORDER BY created_at ASC LIMIT 500").all(uploadCutoff);
  for (const upload of uploads) {
    if (root) {
      const file = path.join(root, upload.kind === "music" ? "resource/songs" : "storage/local_videos", path.basename(upload.file));
      const stats = await fs.stat(file).catch(() => null);
      if (stats) {
        summary.bytesFreed += stats.size;
        if (!dryRun) await fs.rm(file, { force: true });
      }
    }
    if (!dryRun) sqlite.prepare("DELETE FROM shortvideo_upload WHERE id = ?").run(upload.id);
    summary.uploadsDeleted += 1;
  }
  if (root) {
    const tracked = new Set(sqlite.prepare("SELECT file FROM shortvideo_upload WHERE kind = 'material'").all().map((row) => row.file));
    const materialsDir = path.join(root, "storage", "local_videos");
    for (const entry of await fs.readdir(materialsDir, { withFileTypes: true }).catch(() => [])) {
      if (!entry.isFile() || tracked.has(entry.name)) continue;
      const file = path.join(materialsDir, entry.name);
      const stats = await fs.stat(file).catch(() => null);
      if (!stats || now - stats.mtimeMs < UPLOAD_RETENTION_MS) continue;
      if (!dryRun) await fs.rm(file, { force: true });
      summary.uploadsUntracked += 1;
      summary.bytesFreed += stats.size;
    }
    const busy = new Set(activeTaskRows().map((row) => row.engine_task_id).filter(Boolean));
    const tasksDir = path.join(root, "storage", "tasks");
    for (const entry of await fs.readdir(tasksDir, { withFileTypes: true }).catch(() => [])) {
      if (!entry.isDirectory() || busy.has(entry.name)) continue;
      const dir = path.join(tasksDir, entry.name);
      const stats = await fs.stat(dir).catch(() => null);
      if (!stats || now - stats.mtimeMs < UPLOAD_RETENTION_MS) continue;
      summary.bytesFreed += await directoryBytes(dir);
      if (!dryRun) await fs.rm(dir, { recursive: true, force: true });
      summary.engineTaskDirsDeleted += 1;
    }
  }
  return summary;
}

async function directoryBytes(dir) {
  let total = 0;
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) total += await directoryBytes(file);
    else if (entry.isFile()) {
      const stats = await fs.stat(file).catch(() => null);
      if (stats) total += stats.size;
    }
  }
  return total;
}

registerStorageMaintenanceHook("shortvideo", runShortVideoMaintenance);

/* ── 创建任务 ─────────────────────────────────────────────────────────────── */

export async function createShortVideoTask({ userId, body }) {
  const params = normalizeShortVideoRequest(body);
  const caps = limits();
  if (activeTaskCount(userId) >= caps.maxActivePerUser) {
    const error = new Error(`同时最多跑 ${caps.maxActivePerUser} 条短视频，等前面的完成再来。`);
    error.status = 429;
    throw error;
  }
  if (!engineConfigured()) {
    const error = new EngineError("短视频引擎未接入。", { status: 503, code: "not_configured" });
    throw error;
  }
  let script = params.script;
  if (!script) {
    script = await generateShortVideoScript({
      subject: params.subject,
      language: params.language,
      paragraphs: params.paragraphs,
      prompt: params.scriptPrompt,
    });
  }
  let terms = params.terms;
  if (params.source !== "local" && !terms.length) terms = await generateShortVideoTerms({ subject: params.subject, script, amount: 5 });

  const engineTaskId = await createEngineVideoTask(engineRequestFor(params, { script, terms }));
  const id = `sv-${Date.now()}-${randomUUID().slice(0, 6)}`;
  const timestamp = nowIso();
  sqlite
    .prepare(
      `INSERT INTO shortvideo_task (id, user_id, engine_task_id, status, progress, stage, subject, script, terms_json, params_json, result_json, credits, created_at, updated_at)
       VALUES (?, ?, ?, 'queued', 0, 'queued', ?, ?, ?, ?, '{}', ?, ?, ?)`,
    )
    .run(id, userId, engineTaskId, params.subject || script.slice(0, 60), script, JSON.stringify(terms), JSON.stringify(params), estimateShortVideoCredits(), timestamp, timestamp);
  ensureShortVideoPolling();
  return serializeShortVideoTask(getTaskRow(id));
}

/* ── 删除 ─────────────────────────────────────────────────────────────────── */

export async function deleteShortVideoTask(row) {
  await fs.rm(taskAssetDir(row.id), { recursive: true, force: true });
  sqlite.prepare("DELETE FROM shortvideo_task WHERE id = ?").run(row.id);
  if (row.engine_task_id && engineConfigured()) {
    // 引擎那边的目录顺手清掉；清不掉不影响本站。
    void deleteEngineTask(row.engine_task_id).catch((error) => console.warn(`[shortvideo] 清理引擎任务 ${row.engine_task_id} 失败：`, error?.message || error));
  }
}

/* ── 路由 ─────────────────────────────────────────────────────────────────── */

const materialUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MATERIAL_MAX_BYTES, files: 1 } });
const musicUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MUSIC_MAX_BYTES, files: 1 } });

function sendError(res, error, fallback = "短视频服务出错了。") {
  if (error instanceof ValidationError) {
    res.status(400).json({ error: error.message });
    return;
  }
  if (error instanceof EngineError) {
    const status = error.code === "not_configured" ? 503 : error.status >= 500 || error.code === "unreachable" ? 502 : error.status || 502;
    res.status(status).json({ error: error.message, engineCode: error.code });
    return;
  }
  const status = Number(error?.status);
  if (Number.isFinite(status) && status >= 400 && status < 600) {
    res.status(status).json({ error: error.message });
    return;
  }
  console.error("[shortvideo]", error);
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

export function registerShortVideoRoutes(app) {
  app.get("/api/shortvideo/overview", async (req, res) => {
    const account = await requireShortVideoAccount(req, res);
    if (!account) return;
    const engine = await shortVideoEngineStatus();
    let musics = [];
    let materials = [];
    if (engine.online) {
      [musics, materials] = await Promise.all([
        listEngineMusics().catch(() => []),
        listEngineMaterials().catch(() => []),
      ]);
    }
    musics = annotateFiles(musics, "music", account.user.id);
    materials = annotateFiles(materials, "material", account.user.id);
    const taskPage = listShortVideoTaskPage(account.user.id, { page: 1 });
    res.json({
      engine,
      llm: shortVideoLlmStatus(),
      options: shortVideoOptions(),
      musics,
      materials,
      tasks: taskPage.items,
      tasksPagination: {
        total: taskPage.total,
        page: taskPage.page,
        pageSize: taskPage.pageSize,
        pageCount: taskPage.pageCount,
      },
      // 在跑的条数按整个账号算，不是当前这一页——并发上限是账号级的。
      activeCount: activeTaskCount(account.user.id),
    });
  });

  app.post("/api/shortvideo/engine/test", async (req, res) => {
    const account = await requireShortVideoAccount(req, res);
    if (!account) return;
    res.json({ engine: await shortVideoEngineStatus({ force: true }) });
  });

  app.post("/api/shortvideo/script", async (req, res) => {
    const account = await requireShortVideoAccount(req, res);
    if (!account) return;
    try {
      const language = pickOption(SHORTVIDEO_LANGUAGES, req.body?.language, "", "文案语言");
      const script = await generateShortVideoScript({
        subject: req.body?.subject,
        language,
        paragraphs: numberIn(req.body?.paragraphs, { min: 1, max: 6, fallback: 1, label: "段落数", integer: true }),
        prompt: String(req.body?.prompt ?? "").trim(),
      });
      res.json({ script });
    } catch (error) {
      sendError(res, error, "文案生成失败。");
    }
  });

  app.post("/api/shortvideo/terms", async (req, res) => {
    const account = await requireShortVideoAccount(req, res);
    if (!account) return;
    try {
      const terms = await generateShortVideoTerms({
        subject: req.body?.subject,
        script: req.body?.script,
        amount: numberIn(req.body?.amount, { min: 1, max: 10, fallback: 5, label: "关键词个数", integer: true }),
      });
      res.json({ terms });
    } catch (error) {
      sendError(res, error, "关键词生成失败。");
    }
  });

  app.get("/api/shortvideo/tasks", async (req, res) => {
    const account = await requireShortVideoAccount(req, res);
    if (!account) return;
    const page = listShortVideoTaskPage(account.user.id, {
      page: req.query.page,
      pageSize: req.query.pageSize ?? req.query.limit,
    });
    res.json({
      tasks: page.items,
      pagination: { total: page.total, page: page.page, pageSize: page.pageSize, pageCount: page.pageCount },
      activeCount: activeTaskCount(account.user.id),
    });
  });

  app.post("/api/shortvideo/tasks", async (req, res) => {
    const account = await requireShortVideoAccount(req, res);
    if (!account) return;
    try {
      const task = await createShortVideoTask({ userId: account.user.id, body: req.body });
      res.status(202).json({ task });
    } catch (error) {
      sendError(res, error, "创建短视频任务失败。");
    }
  });

  app.get("/api/shortvideo/tasks/:id", async (req, res) => {
    const account = await requireShortVideoAccount(req, res);
    if (!account) return;
    const row = ownedTaskOr404(req, res, account);
    if (!row) return;
    res.json({ task: serializeShortVideoTask(row) });
  });

  /**
   * 取消排队中 / 生成中的任务：本站标成 cancelled、不再轮询；引擎那边的任务顺手删掉
   * （MPT 没有「暂停」，删任务就是它的取消）。已经结束的任务走 DELETE。
   */
  app.post("/api/shortvideo/tasks/:id/cancel", async (req, res) => {
    const account = await requireShortVideoAccount(req, res);
    if (!account) return;
    const row = ownedTaskOr404(req, res, account);
    if (!row) return;
    if (row.status !== "queued" && row.status !== "running") {
      res.status(409).json({ error: "任务已经结束，不用取消；要清掉请直接删除。" });
      return;
    }
    updateTask(row.id, { status: "cancelled", stage: "cancelled", error: "已手动取消。", finished_at: nowIso() });
    engineLostSince.delete(row.id);
    if (row.engine_task_id && engineConfigured()) {
      void deleteEngineTask(row.engine_task_id).catch((error) => console.warn(`[shortvideo] 取消引擎任务 ${row.engine_task_id} 失败：`, error?.message || error));
    }
    stopPollingIfIdle();
    res.json({ task: serializeShortVideoTask(getTaskRow(row.id)), activeCount: activeTaskCount(account.user.id) });
  });

  app.delete("/api/shortvideo/tasks/:id", async (req, res) => {
    const account = await requireShortVideoAccount(req, res);
    if (!account) return;
    const row = ownedTaskOr404(req, res, account);
    if (!row) return;
    if (row.status === "queued" || row.status === "running") {
      res.status(409).json({ error: "任务还在跑，等它结束再删。" });
      return;
    }
    try {
      await deleteShortVideoTask(row);
      res.json({ ok: true });
    } catch (error) {
      sendError(res, error, "删除失败。");
    }
  });

  // 成片 / 字幕：只认结果里登记过的文件名；sendFile 自带 Range 支持，<video> 拖进度条靠它。
  app.get("/api/shortvideo/tasks/:id/files/:name", async (req, res) => {
    const account = await requireShortVideoAccount(req, res);
    if (!account) return;
    const row = ownedTaskOr404(req, res, account);
    if (!row) return;
    const name = safeEngineFileName(req.params.name);
    const result = parseJson(row.result_json, {});
    const known = new Set([...(Array.isArray(result.videos) ? result.videos.map((video) => video.name) : []), result.subtitle].filter(Boolean));
    if (!name || !known.has(name)) {
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
    const isVideo = name.endsWith(".mp4");
    res.sendFile(filePath, {
      headers: {
        "Content-Type": isVideo ? "video/mp4" : "text/plain; charset=utf-8",
        "Cache-Control": "private, max-age=3600",
        "Content-Disposition": req.query.download !== undefined ? `attachment; filename="${row.id}-${name}"` : `inline; filename="${name}"`,
      },
    });
  });

  // 手动推云盘（和成片图的「归档」一个意思）。
  app.post("/api/shortvideo/tasks/:id/archive", async (req, res) => {
    const account = await requireShortVideoAccount(req, res);
    if (!account) return;
    const row = ownedTaskOr404(req, res, account);
    if (!row) return;
    const outcome = await archiveShortVideoTask(row);
    if (outcome.error) {
      res.status(outcome.status || 400).json({ error: outcome.error });
      return;
    }
    res.json({ ok: true, task: serializeShortVideoTask(getTaskRow(row.id)) });
  });

  app.get("/api/shortvideo/materials", async (req, res) => {
    const account = await requireShortVideoAccount(req, res);
    if (!account) return;
    try {
      res.json({ files: annotateFiles(await listEngineMaterials(), "material", account.user.id) });
    } catch (error) {
      sendError(res, error, "读取素材列表失败。");
    }
  });

  app.post("/api/shortvideo/materials", materialUpload.single("file"), async (req, res) => {
    const account = await requireShortVideoAccount(req, res);
    if (!account) return;
    const file = req.file;
    if (!file) {
      res.status(400).json({ error: "请选择要上传的素材文件。" });
      return;
    }
    // multer 把文件名按 latin1 解码，中文名会变成乱码；这里按 UTF-8 转回来（纯 ASCII 名字不受影响）。
    const rawName = String(file.originalname || "");
    const decodedName = /[^\u0000-\u007f]/.test(rawName) ? Buffer.from(rawName, "latin1").toString("utf8") : rawName;
    const original = path.basename(decodedName.replace(/\\/g, "/"));
    const extension = original.split(".").pop()?.toLowerCase() || "";
    if (!MATERIAL_EXTENSIONS.has(extension)) {
      res.status(400).json({ error: `只支持 ${[...MATERIAL_EXTENSIONS].join(" / ")} 格式的素材。` });
      return;
    }
    // 文件名重新起：避免中文 / 空格在引擎那边出问题，也避免覆盖别人的素材。
    const stored = `${Date.now().toString(36)}-${randomUUID().slice(0, 6)}.${extension}`;
    try {
      const name = await uploadEngineMaterial({ buffer: file.buffer, fileName: stored, mimeType: file.mimetype });
      recordUpload({ userId: account.user.id, kind: "material", file: name, originalName: original, bytes: file.size });
      res.json({ file: name, originalName: original, size: file.size, expiresAt: new Date(Date.now() + UPLOAD_RETENTION_MS).toISOString() });
    } catch (error) {
      sendError(res, error, "上传素材失败。");
    }
  });

  // 发布文案：标题 / 简介 / 话题标签。成片能直接发出去才算做完。
  app.post("/api/shortvideo/metadata", async (req, res) => {
    const account = await requireShortVideoAccount(req, res);
    if (!account) return;
    try {
      const platform = pickOption(SHORTVIDEO_PLATFORMS, req.body?.platform, "douyin", "发布平台");
      const language = pickOption(SHORTVIDEO_LANGUAGES, req.body?.language, "", "文案语言");
      const metadata = await generateShortVideoMetadata({ subject: req.body?.subject, script: req.body?.script, platform, language });
      res.json({ metadata, platform });
    } catch (error) {
      sendError(res, error, "发布文案生成失败。");
    }
  });

  app.post("/api/shortvideo/musics", musicUpload.single("file"), async (req, res) => {
    const account = await requireShortVideoAccount(req, res);
    if (!account) return;
    const file = req.file;
    if (!file) {
      res.status(400).json({ error: "请选择要上传的音乐文件。" });
      return;
    }
    const rawName = String(file.originalname || "");
    const decodedName = /[^\u0000-\u007f]/.test(rawName) ? Buffer.from(rawName, "latin1").toString("utf8") : rawName;
    const original = path.basename(decodedName.replace(/\\/g, "/"));
    const extension = original.split(".").pop()?.toLowerCase() || "";
    if (!MUSIC_EXTENSIONS.has(extension)) {
      res.status(400).json({ error: `只支持 ${[...MUSIC_EXTENSIONS].join(" / ")} 格式的音乐。` });
      return;
    }
    try {
      // 引擎那边会把文件名换成 UUID，这里只要保证扩展名对得上。
      const name = await uploadEngineMusic({ buffer: file.buffer, fileName: `${Date.now().toString(36)}.${extension}`, mimeType: file.mimetype });
      recordUpload({ userId: account.user.id, kind: "music", file: name, originalName: original, bytes: file.size });
      res.json({ file: name, originalName: original, size: file.size, expiresAt: new Date(Date.now() + UPLOAD_RETENTION_MS).toISOString() });
    } catch (error) {
      sendError(res, error, "上传音乐失败。");
    }
  });

  app.get("/api/shortvideo/musics", async (req, res) => {
    const account = await requireShortVideoAccount(req, res);
    if (!account) return;
    try {
      res.json({ files: annotateFiles(await listEngineMusics(), "music", account.user.id) });
    } catch (error) {
      sendError(res, error, "读取音乐列表失败。");
    }
  });

  // 后台：按账号打开 / 关闭短视频功能。放在这里而不是 PATCH /api/admin/users/:id，避免那条路由再长一截。
  app.put("/api/admin/users/:id/shortvideo", async (req, res) => {
    const account = await requireAdmin(req, res);
    if (!account) return;
    const enabled = req.body?.enabled;
    if (typeof enabled !== "boolean") {
      res.status(400).json({ error: "enabled 要是布尔值。" });
      return;
    }
    const target = sqlite.prepare("SELECT user_id, role FROM user_profile WHERE user_id = ?").get(String(req.params.id || ""));
    if (!target) {
      res.status(404).json({ error: "用户不存在。" });
      return;
    }
    sqlite
      .prepare("UPDATE user_profile SET shortvideo_enabled = ?, updated_at = ? WHERE user_id = ?")
      .run(enabled ? 1 : 0, nowIso(), target.user_id);
    sqlite
      .prepare(
        `INSERT INTO audit_log (id, actor_user_id, action, target_type, target_id, detail_json, created_at)
         VALUES (?, ?, 'user.shortvideo', 'user', ?, ?, ?)`,
      )
      .run(randomUUID(), account.user.id, target.user_id, JSON.stringify({ enabled }), nowIso());
    res.json({ shortVideoEnabled: enabled, canUseShortVideo: canUseShortVideo({ role: target.role, shortvideo_enabled: enabled ? 1 : 0 }) });
  });

  /* ── 后台：短视频接口配置 ──────────────────────────────────────────────── */

  // 引擎侧（素材库 Key、字幕方案、并发）改的是引擎的 config.toml，本站侧（文案模型、每人并发）存 app_config。
  app.get("/api/admin/shortvideo", async (req, res) => {
    const account = await requireAdmin(req, res);
    if (!account) return;
    res.json({
      engine: await shortVideoEngineStatus(),
      llm: shortVideoLlmStatus(),
      settings: shortVideoSettingsView(),
      engineConfig: await readEngineConfig(),
      activeTasks: Number(sqlite.prepare("SELECT COUNT(*) AS count FROM shortvideo_task WHERE status IN ('queued', 'running')").get()?.count || 0),
    });
  });

  app.put("/api/admin/shortvideo/settings", async (req, res) => {
    const account = await requireAdmin(req, res);
    if (!account) return;
    const result = saveShortVideoSettings(req.body || {});
    if (result.error) {
      res.status(400).json({ error: result.error });
      return;
    }
    insertShortVideoAudit(account.user.id, "shortvideo.settings", {
      // 只记改了哪些项，不记值——里面可能有 Key。
      fields: Object.keys(req.body || {}),
    });
    res.json({ settings: result.settings, llm: shortVideoLlmStatus() });
  });

  app.post("/api/admin/shortvideo/llm/test", async (req, res) => {
    const account = await requireAdmin(req, res);
    if (!account) return;
    res.json({ result: await testShortVideoLlm() });
  });

  app.put("/api/admin/shortvideo/engine-config", async (req, res) => {
    const account = await requireAdmin(req, res);
    if (!account) return;
    if (!engineConfigEditable()) {
      res.status(503).json({ error: "这台机器上改不了引擎配置（没有配 SHORTVIDEO_ENGINE_CONFIG）。" });
      return;
    }
    try {
      const result = await writeEngineConfig(req.body || {});
      insertShortVideoAudit(account.user.id, "shortvideo.engine-config", { fields: result.changed });
      res.json({
        changed: result.changed,
        // 引擎启动时才读配置，所以改完必须重启才生效。
        needsRestart: result.changed.length > 0,
        restartAvailable: engineRestartAvailable(),
        engineConfig: await readEngineConfig(),
      });
    } catch (error) {
      sendError(res, error, "保存引擎配置失败。");
    }
  });

  app.post("/api/admin/shortvideo/engine/restart", async (req, res) => {
    const account = await requireAdmin(req, res);
    if (!account) return;
    const active = Number(sqlite.prepare("SELECT COUNT(*) AS count FROM shortvideo_task WHERE status IN ('queued', 'running')").get()?.count || 0);
    // 重启会把引擎正在渲染的任务打断（它的任务状态只在内存里），所以默认拦一下。
    if (active > 0 && req.body?.force !== true) {
      res.status(409).json({ error: `还有 ${active} 条任务在跑，重启会把它们打断。等跑完，或者传 force 强制重启。`, activeTasks: active });
      return;
    }
    try {
      await restartEngine();
      insertShortVideoAudit(account.user.id, "shortvideo.engine-restart", { force: req.body?.force === true, activeTasks: active });
      // 重启要几秒才起来，这里等一下再探，免得前端立刻看到「离线」。
      await new Promise((resolve) => setTimeout(resolve, 3000));
      res.json({ engine: await shortVideoEngineStatus({ force: true }) });
    } catch (error) {
      sendError(res, error, "重启引擎失败。");
    }
  });
}

function insertShortVideoAudit(actorUserId, action, detail) {
  sqlite
    .prepare(
      `INSERT INTO audit_log (id, actor_user_id, action, target_type, target_id, detail_json, created_at)
       VALUES (?, ?, ?, 'shortvideo', 'shortvideo', ?, ?)`,
    )
    .run(randomUUID(), actorUserId, action, JSON.stringify(detail || {}), nowIso());
}

export { ENGINE_CONFIG_FIELDS };
