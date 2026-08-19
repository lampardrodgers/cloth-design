import fs from "node:fs/promises";
import { createWriteStream } from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { fetchWithTimeout, timeoutMsFromEnv } from "./timeouts.mjs";

/**
 * MoneyPrinterTurbo（MPT）的 HTTP 客户端。
 *
 * MPT 只是渲染引擎：本站把写好的文案、关键词和一堆参数交给它，它负责配音、字幕、找素材、
 * moviepy 合成，成片放在它自己的 storage/tasks/<id>/ 下并通过 /tasks/<id>/final-1.mp4 静态提供。
 * 它只监听回环地址，所有请求都从这里出去，浏览器永远碰不到它。
 *
 * MPT 的响应统一是 { status, message, data }；HTTP 状态和 body.status 都可能带错误，两边都看。
 */

export const ENGINE_STATE = Object.freeze({ FAILED: -1, COMPLETE: 1, PROCESSING: 4 });

export function engineBaseUrl() {
  const raw = String(process.env.SHORTVIDEO_ENGINE_URL || "").trim();
  if (!raw) return "";
  return raw.replace(/\/+$/, "");
}

export function engineConfigured() {
  return Boolean(engineBaseUrl());
}

/** 给界面看的地址：只留主机和端口，别把内网拓扑整段吐出去。 */
export function engineDisplayUrl() {
  const base = engineBaseUrl();
  if (!base) return "";
  try {
    const parsed = new URL(base);
    return parsed.host + (parsed.pathname && parsed.pathname !== "/" ? parsed.pathname : "");
  } catch {
    return base;
  }
}

function engineTimeoutMs() {
  return timeoutMsFromEnv("SHORTVIDEO_ENGINE_TIMEOUT_MS", 20000);
}

function engineDownloadTimeoutMs() {
  return timeoutMsFromEnv(["SHORTVIDEO_DOWNLOAD_TIMEOUT_MS", "VIDEO_DOWNLOAD_TIMEOUT_MS"], 300000);
}

function engineHeaders(extra = {}) {
  const headers = { ...extra };
  const apiKey = String(process.env.SHORTVIDEO_ENGINE_API_KEY || "").trim();
  if (apiKey) headers["x-api-key"] = apiKey;
  return headers;
}

export class EngineError extends Error {
  constructor(message, { status = 0, code = "engine" } = {}) {
    super(message);
    this.name = "EngineError";
    this.status = status;
    this.code = code;
  }
}

function engineUrl(pathname) {
  const base = engineBaseUrl();
  if (!base) throw new EngineError("短视频引擎未接入。", { status: 503, code: "not_configured" });
  return `${base}/${String(pathname).replace(/^\/+/, "")}`;
}

async function engineJson(pathname, init = {}, { timeoutMs = engineTimeoutMs() } = {}) {
  const url = engineUrl(pathname);
  let response;
  try {
    response = await fetchWithTimeout(
      url,
      { ...init, headers: engineHeaders(init.headers) },
      { timeoutMs, timeoutMessage: "短视频引擎响应超时。" },
    );
  } catch (error) {
    throw new EngineError(`连不上短视频引擎：${error instanceof Error ? error.message : String(error)}`, { status: 502, code: "unreachable" });
  }
  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  if (!response.ok) {
    const message = body?.message || text.slice(0, 200) || `HTTP ${response.status}`;
    throw new EngineError(`短视频引擎返回 ${response.status}：${message}`, { status: response.status, code: "http" });
  }
  if (body && typeof body === "object" && "status" in body && Number(body.status) >= 400) {
    throw new EngineError(`短视频引擎报错：${body.message || body.status}`, { status: Number(body.status), code: "engine" });
  }
  return body;
}

/** 探活：只列一页任务，不生成任何东西。 */
export async function pingEngine() {
  const startedAt = Date.now();
  const body = await engineJson("/api/v1/tasks?page=1&page_size=1");
  return { latencyMs: Date.now() - startedAt, total: Number(body?.data?.total ?? 0) };
}

export async function createEngineVideoTask(payload) {
  const body = await engineJson("/api/v1/videos", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const taskId = String(body?.data?.task_id || "").trim();
  if (!taskId) throw new EngineError("短视频引擎没有返回任务号。", { status: 502, code: "bad_response" });
  return taskId;
}

/** 查任务；不存在时返回 null（MPT 重启后内存态会丢，这不算异常）。 */
export async function getEngineTask(engineTaskId) {
  try {
    const body = await engineJson(`/api/v1/tasks/${encodeURIComponent(engineTaskId)}`);
    return body?.data && typeof body.data === "object" ? body.data : null;
  } catch (error) {
    if (error instanceof EngineError && error.status === 404) return null;
    throw error;
  }
}

export async function deleteEngineTask(engineTaskId) {
  try {
    await engineJson(`/api/v1/tasks/${encodeURIComponent(engineTaskId)}`, { method: "DELETE" });
    return true;
  } catch (error) {
    if (error instanceof EngineError && error.status === 404) return true;
    throw error;
  }
}

export async function listEngineMaterials() {
  const body = await engineJson("/api/v1/video_materials");
  return normalizeFileList(body?.data?.files);
}

export async function listEngineMusics() {
  const body = await engineJson("/api/v1/musics");
  return normalizeFileList(body?.data?.files);
}

function normalizeFileList(files) {
  if (!Array.isArray(files)) return [];
  return files
    .map((file) => ({ name: String(file?.name || file?.file || "").trim(), size: Number(file?.size || 0) }))
    .filter((file) => file.name);
}

export async function uploadEngineMusic({ buffer, fileName, mimeType }) {
  const form = new FormData();
  form.append("file", new Blob([buffer], { type: mimeType || "audio/mpeg" }), fileName);
  // 引擎会用 ffmpeg 完整解一遍码，大文件慢，超时按下载那档给。
  const body = await engineJson("/api/v1/musics", { method: "POST", body: form }, { timeoutMs: engineDownloadTimeoutMs() });
  const stored = String(body?.data?.file || "").trim();
  if (!stored) throw new EngineError("短视频引擎没有返回音乐文件名。", { status: 502, code: "bad_response" });
  return path.basename(stored);
}

export async function uploadEngineMaterial({ buffer, fileName, mimeType }) {
  const form = new FormData();
  form.append("file", new Blob([buffer], { type: mimeType || "application/octet-stream" }), fileName);
  const body = await engineJson("/api/v1/video_materials", { method: "POST", body: form }, { timeoutMs: engineDownloadTimeoutMs() });
  const stored = String(body?.data?.file || "").trim();
  if (!stored) throw new EngineError("短视频引擎没有返回素材文件名。", { status: 502, code: "bad_response" });
  return path.basename(stored);
}

/**
 * MPT 回的成片路径有三种写法：`/tasks/<id>/final-1.mp4`（相对）、带 endpoint 的绝对 URL、
 * 或者历史脏数据里的本机绝对路径。这里统一转成能从引擎拉到的 URL，拼不出来就返回空。
 */
export function engineFileUrl(fileRef, engineTaskId) {
  const value = String(fileRef || "").trim();
  if (!value) return "";
  if (/^https?:\/\//i.test(value)) return value;
  const base = engineBaseUrl();
  if (!base) return "";
  if (value.startsWith("/tasks/") || value.startsWith("tasks/")) return `${base}/${value.replace(/^\/+/, "")}`;
  // 本机绝对路径：只认落在这个任务目录里的文件名。
  const marker = `/tasks/${engineTaskId}/`;
  const index = value.indexOf(marker);
  if (index >= 0) return `${base}/tasks/${engineTaskId}/${value.slice(index + marker.length)}`;
  return "";
}

/** 只留文件名，路径穿越、目录分隔符一律不认。 */
export function safeEngineFileName(fileRef) {
  const name = path.basename(String(fileRef || "").replace(/\\/g, "/"));
  if (!name || name === "." || name === ".." || !/^[\w.-]+$/.test(name)) return "";
  return name;
}

/** 从引擎把一个文件拉到本地；返回字节数。 */
export async function downloadEngineFile(url, destination) {
  let response;
  try {
    response = await fetchWithTimeout(url, { headers: engineHeaders() }, { timeoutMs: engineDownloadTimeoutMs(), timeoutMessage: "从短视频引擎回传成片超时。" });
  } catch (error) {
    throw new EngineError(`回传成片失败：${error instanceof Error ? error.message : String(error)}`, { status: 502, code: "download" });
  }
  if (!response.ok || !response.body) {
    throw new EngineError(`回传成片失败（${response.status}）。`, { status: response.status || 502, code: "download" });
  }
  await fs.mkdir(path.dirname(destination), { recursive: true });
  const temp = `${destination}.part`;
  await pipeline(Readable.fromWeb(response.body), createWriteStream(temp));
  await fs.rename(temp, destination);
  const stats = await fs.stat(destination);
  return stats.size;
}

/** 引擎那边任务查不到时，看成片是不是其实已经落盘了（HEAD 静态文件）。 */
export async function engineFileExists(url) {
  try {
    const response = await fetchWithTimeout(url, { method: "HEAD", headers: engineHeaders() }, { timeoutMs: engineTimeoutMs(), timeoutMessage: "短视频引擎响应超时。" });
    return response.ok;
  } catch {
    return false;
  }
}
