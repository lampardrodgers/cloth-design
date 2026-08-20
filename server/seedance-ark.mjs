import fs from "node:fs/promises";
import { createWriteStream } from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { seedanceSettings } from "./seedance-settings.mjs";
import { fetchWithTimeout, timeoutMsFromEnv } from "./timeouts.mjs";

/**
 * 火山方舟（Ark）视频生成 API 的 HTTP 客户端。
 *
 * 接口是异步任务式的：
 *   POST /contents/generations/tasks            → { id }
 *   GET  /contents/generations/tasks/{id}       → { status: queued|running|succeeded|failed|cancelled|expired, content: { video_url, last_frame_url }, ... }
 *   GET  /contents/generations/tasks?page_num=  → { total, items }
 *   DELETE /contents/generations/tasks/{id}     → 排队中的取消；跑完的删记录
 *   GET  /models                                → 平台模型列表（含 Seedance 各版本与状态）
 *
 * 成片 URL 只保 24 小时（2.5 还限 100 次下载），所以成功后立刻拉回本地。
 * 鉴权：Authorization: Bearer <API Key>。这里所有请求都从服务端出去，浏览器永远碰不到 Key。
 */

export class ArkError extends Error {
  constructor(message, { status = 0, code = "ark", requestId = "" } = {}) {
    super(message);
    this.name = "ArkError";
    this.status = status;
    this.code = code;
    this.requestId = requestId;
  }
}

export function arkConfigured() {
  return Boolean(seedanceSettings().apiKey);
}

function arkTimeoutMs() {
  return timeoutMsFromEnv("SEEDANCE_TIMEOUT_MS", 30000);
}

function arkDownloadTimeoutMs() {
  return timeoutMsFromEnv(["SEEDANCE_DOWNLOAD_TIMEOUT_MS", "VIDEO_DOWNLOAD_TIMEOUT_MS"], 300000);
}

function arkUrl(pathname) {
  const { baseUrl } = seedanceSettings();
  return `${baseUrl}/${String(pathname).replace(/^\/+/, "")}`;
}

function arkHeaders(extra = {}) {
  const { apiKey } = seedanceSettings();
  if (!apiKey) throw new ArkError("还没配置 Seedance 的 API Key。", { status: 503, code: "not_configured" });
  return { Authorization: `Bearer ${apiKey}`, ...extra };
}

/**
 * 把方舟的错误体翻成一句能看懂的话。常见：AuthenticationError / ModelNotOpen / InvalidParameter / RateLimitExceeded。
 *
 * 401 要分两种：
 *   - 账号级的只读接口（列任务 / 列模型）都过不了 → Key 本身不对；
 *   - 只读接口能过、带着 model 去建任务却 401 → Key 是真的，但它的权限范围里没有这个模型
 *     （方舟的 API Key 可以限定「全部资源 / 自定义资源」、IP 白名单、所属资源项目；越界时方舟也回 AuthenticationError，不会说 ModelNotOpen）。
 */
function describeArkError(status, body, text, { action = "read", model = "" } = {}) {
  const error = body?.error && typeof body.error === "object" ? body.error : null;
  const code = String(error?.code || body?.code || "").trim();
  const message = String(error?.message || body?.message || text || "").trim().replace(/\s*Request id:.*$/i, "");
  const requestId = String(error?.request_id || body?.request_id || (text.match(/Request id:\s*([\w-]+)/i) || [])[1] || "");
  let friendly = message || `HTTP ${status}`;
  if (status === 401 || /AuthenticationError/i.test(code)) {
    friendly =
      action === "create"
        ? `方舟拒绝了这次调用：这把 Key 能查账号、却没有调用${model ? `模型 ${model} ` : "这个模型"}的权限（${message || "AuthenticationError"}）。请到火山方舟控制台「API Key 管理」检查这把 Key：权限范围要是「全部资源」（或把 Seedance 模型加进自定义资源）、没有挡住本站的 IP 白名单、且建在开通了 Seedance 的那个资源项目下；再到「开通管理」确认模型已开通。`
        : `方舟不认这把 Key（${message || "401"}）。请到火山方舟控制台「API Key 管理」重新复制 API Key Secret。`;
  }
  else if (/ModelNotOpen|NotActivated|not been activated|未开通/i.test(`${code} ${message}`)) friendly = `这个模型还没在火山方舟开通（${message}）。去控制台「开通管理」开通后再试。`;
  else if (/AccountOverdue|InsufficientBalance|Arrear|余额/i.test(`${code} ${message}`)) friendly = `火山方舟账户余额不足或欠费（${message}）。`;
  else if (/RateLimit|QuotaExceeded|Too Many/i.test(`${code} ${message}`) || status === 429) friendly = `方舟限流了（${message}），稍后再试。`;
  else if (/SensitiveContent|ContentFilter|OutputTextSensitive|InputTextSensitive|sensitive/i.test(`${code} ${message}`)) friendly = `内容被方舟的安全审核拦下了（${message}）。换个写法再试。`;
  else if (/InvalidParameter/i.test(code)) friendly = `方舟说参数不对：${message}`;
  return { friendly, code: code || `http_${status}`, requestId };
}

async function arkJson(pathname, init = {}, { timeoutMs = arkTimeoutMs(), action = "read", model = "" } = {}) {
  const url = arkUrl(pathname);
  let response;
  try {
    response = await fetchWithTimeout(url, { ...init, headers: arkHeaders(init.headers) }, { timeoutMs, timeoutMessage: "火山方舟响应超时。" });
  } catch (error) {
    if (error instanceof ArkError) throw error;
    console.warn(`[seedance] ark ${init.method || "GET"} ${pathname} unreachable: ${error instanceof Error ? error.message : String(error)}`);
    throw new ArkError(`连不上火山方舟：${error instanceof Error ? error.message : String(error)}`, { status: 502, code: "unreachable" });
  }
  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  if (!response.ok) {
    const { friendly, code, requestId } = describeArkError(response.status, body, text.slice(0, 300), { action, model });
    // 只记状态 / 错误码 / 请求号，方便对着方舟控制台查；Key 永远不进日志。
    console.warn(`[seedance] ark ${init.method || "GET"} ${pathname.split("?")[0]} -> ${response.status} ${code}${requestId ? ` req=${requestId}` : ""}${model ? ` model=${model}` : ""}`);
    throw new ArkError(friendly, { status: response.status, code, requestId });
  }
  return body;
}

/**
 * 模型调用权限自检：对每个模型发一个注定被参数校验拦下的建任务请求（content 为空、分辨率非法），
 * 方舟会先鉴权再校验参数，所以：
 *   401 AuthenticationError → Key 没有这个模型的调用权限；
 *   ModelNotOpen           → 模型还没开通；
 *   400 参数错             → 鉴权过了、模型可用（参数错是我们故意的）；
 * 永远不会真的建出任务、不会产生费用。
 */
export async function probeArkModelAccess(modelIds = []) {
  const results = [];
  for (const modelId of modelIds) {
    const startedAt = Date.now();
    let outcome;
    try {
      await arkJson(
        "/contents/generations/tasks",
        { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model: modelId, content: [], resolution: "0p" }) },
        { action: "create", model: modelId },
      );
      // 理论上到不了这里（参数非法一定 400）；万一方舟放行了也只能算「可用」。
      outcome = { access: "ok", detail: "" };
    } catch (error) {
      const status = error instanceof ArkError ? error.status : 0;
      const code = error instanceof ArkError ? error.code : "";
      const key = `${code} ${error?.message || ""}`;
      if (status === 401 || /AuthenticationError/i.test(code)) outcome = { access: "unauthorized", detail: "Key 没有这个模型的调用权限（检查 Key 的权限范围 / IP 白名单 / 所属项目）" };
      else if (/ModelNotOpen|NotActivated|not been activated/i.test(key)) outcome = { access: "not_open", detail: "模型还没在方舟「开通管理」里开通" };
      else if (status === 404 || /ModelNotFound|NotFound/i.test(code)) outcome = { access: "unknown", detail: "方舟不认识这个模型 ID" };
      else if (status === 400 || status === 429 || /InvalidParameter|MissingParameter|RateLimit/i.test(code)) outcome = { access: "ok", detail: "" };
      else if (code === "unreachable" || status === 502) outcome = { access: "error", detail: error.message };
      else outcome = { access: "error", detail: error.message };
    }
    results.push({ model: modelId, ...outcome, latencyMs: Date.now() - startedAt });
  }
  return results;
}

/** 探活：只列一页任务，不生成任何东西。顺带把能看到的 Seedance 模型列出来。 */
export async function pingArk({ withModels = true } = {}) {
  const startedAt = Date.now();
  const list = await arkJson("/contents/generations/tasks?page_num=1&page_size=1");
  const result = { latencyMs: Date.now() - startedAt, total: Number(list?.total ?? 0), models: [] };
  if (withModels) {
    try {
      result.models = await listArkVideoModels();
    } catch {
      result.models = [];
    }
  }
  return result;
}

/** 平台上全部视频生成模型（含状态 Retiring / Shutdown），给后台对照目录用。 */
export async function listArkVideoModels() {
  const body = await arkJson("/models");
  const items = Array.isArray(body?.data) ? body.data : [];
  return items
    .filter((item) => {
      const outputs = item?.modalities?.output_modalities;
      return (Array.isArray(outputs) && outputs.includes("video")) || String(item?.domain || "") === "VideoGeneration";
    })
    .map((item) => ({
      id: String(item.id || ""),
      name: String(item.name || item.id || ""),
      status: String(item.status || "active"),
      version: String(item.version || ""),
      taskTypes: Array.isArray(item.task_type) ? item.task_type.map(String) : [],
      inputs: Array.isArray(item?.modalities?.input_modalities) ? item.modalities.input_modalities.map(String) : [],
    }))
    .filter((item) => item.id);
}

export async function createArkTask(payload) {
  const body = await arkJson(
    "/contents/generations/tasks",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    },
    { action: "create", model: String(payload?.model || "") },
  );
  const taskId = String(body?.id || "").trim();
  if (!taskId) throw new ArkError("火山方舟没有返回任务号。", { status: 502, code: "bad_response" });
  return taskId;
}

/** 查任务；方舟那边 404（7 天后自动清除、或被删了）返回 null。 */
export async function getArkTask(arkTaskId) {
  try {
    const body = await arkJson(`/contents/generations/tasks/${encodeURIComponent(arkTaskId)}`);
    return body && typeof body === "object" ? body : null;
  } catch (error) {
    if (error instanceof ArkError && error.status === 404) return null;
    throw error;
  }
}

/** 排队中的任务取消；跑完的删记录。404 当成功。 */
export async function deleteArkTask(arkTaskId) {
  try {
    await arkJson(`/contents/generations/tasks/${encodeURIComponent(arkTaskId)}`, { method: "DELETE" });
    return true;
  } catch (error) {
    if (error instanceof ArkError && error.status === 404) return true;
    throw error;
  }
}

/** 把方舟给的成片 / 尾帧 URL 拉到本地；返回字节数。URL 自带签名，不用再带 Key。 */
export async function downloadArkFile(url, destination) {
  let response;
  try {
    response = await fetchWithTimeout(url, {}, { timeoutMs: arkDownloadTimeoutMs(), timeoutMessage: "从火山方舟拉成片超时。" });
  } catch (error) {
    throw new ArkError(`拉成片失败：${error instanceof Error ? error.message : String(error)}`, { status: 502, code: "download" });
  }
  if (!response.ok || !response.body) {
    throw new ArkError(`拉成片失败（${response.status}）。`, { status: response.status || 502, code: "download" });
  }
  await fs.mkdir(path.dirname(destination), { recursive: true });
  const temp = `${destination}.part`;
  await pipeline(Readable.fromWeb(response.body), createWriteStream(temp));
  await fs.rename(temp, destination);
  const stats = await fs.stat(destination);
  return stats.size;
}
