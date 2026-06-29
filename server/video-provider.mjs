import { randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { generatedImageStaticMount } from "./image-provider.mjs";
import { fetchWithTimeout, timeoutMsFromEnv } from "./timeouts.mjs";

function videoAssetDir() {
  return path.resolve(process.env.VIDEO_ASSET_DIR || "./data/generated-videos");
}

function videoAssetPublicPath() {
  const configured = String(process.env.VIDEO_ASSET_PUBLIC_PATH || "/generated-videos").trim() || "/generated-videos";
  return `/${configured.replace(/^\/+|\/+$/g, "")}`;
}

function videoDownloadTimeoutMs() {
  return timeoutMsFromEnv(["VIDEO_DOWNLOAD_TIMEOUT_MS", "AI_VIDEO_TIMEOUT_MS"], 120000);
}

export function generatedVideoStaticMount() {
  return {
    publicPath: videoAssetPublicPath(),
    directory: videoAssetDir(),
  };
}

export function videoEncodingStatus() {
  const ffmpegBin = process.env.FFMPEG_BIN || "ffmpeg";
  const probe = spawnSync(ffmpegBin, ["-version"], { encoding: "utf8" });
  return {
    available: probe.status === 0,
    ffmpegBin,
  };
}

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.env.FFMPEG_BIN || "ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] });
    const stderr = [];
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg 生成 MP4 失败 (${code})：${Buffer.concat(stderr).toString("utf8").slice(0, 600)}`));
    });
  });
}

function fileNameFromPublicImageUrl(sourceImageUrl) {
  const { publicPath } = generatedImageStaticMount();
  if (!String(sourceImageUrl || "").startsWith(`${publicPath}/`)) {
    throw new Error("不合法的图片路径。");
  }
  const fileName = decodeURIComponent(String(sourceImageUrl).slice(publicPath.length + 1));
  if (!/^[\w.-]+\.(png|jpg|jpeg|webp)$/i.test(fileName) || fileName.includes("..") || path.basename(fileName) !== fileName) {
    throw new Error("不合法的图片路径。");
  }
  return fileName;
}

async function resolveSourceImagePath(sourceImageUrl) {
  const { directory } = generatedImageStaticMount();
  const fileName = fileNameFromPublicImageUrl(sourceImageUrl);
  const sourcePath = path.join(directory, fileName);
  await fs.access(sourcePath);
  return sourcePath;
}

function safeDuration(value) {
  const duration = Number(value || 2.4);
  if (!Number.isFinite(duration)) return 2.4;
  return Math.min(Math.max(duration, 1), 8);
}

function safeSize(value) {
  if (typeof value === "string" && /^\d{3,4}x\d{3,4}$/.test(value)) return value;
  return "720x960";
}

function isMp4Buffer(buffer) {
  return buffer.length >= 12 && buffer.subarray(4, 8).toString("ascii") === "ftyp";
}

async function persistVideoBuffer(buffer, mimeType = "video/mp4", sourceType = "buffer") {
  const normalizedMime = String(mimeType || "video/mp4").split(";")[0].trim() || "video/mp4";
  if (normalizedMime !== "video/mp4") {
    throw new Error(`生成视频不是 MP4 格式：${normalizedMime}`);
  }
  if (!buffer || buffer.length === 0) {
    throw new Error("生成视频为空。");
  }
  if (!isMp4Buffer(buffer)) {
    throw new Error("生成视频不是 MP4 文件。");
  }
  const directory = videoAssetDir();
  await fs.mkdir(directory, { recursive: true });
  const fileName = `${randomUUID()}.mp4`;
  await fs.writeFile(path.join(directory, fileName), buffer);
  const publicUrl = `${videoAssetPublicPath()}/${fileName}`;
  return {
    videoUrl: publicUrl,
    videoInspection: {
      storage: "local_file",
      mimeType: normalizedMime,
      mode: "external_video_service",
      sourceType,
      fileName,
      publicUrl,
      bytes: buffer.length,
    },
  };
}

export async function persistGeneratedVideo(item, { fallbackMimeType = "video/mp4" } = {}) {
  if (item?.b64_video) {
    return persistVideoBuffer(Buffer.from(item.b64_video, "base64"), fallbackMimeType, "b64_video");
  }
  if (!item?.url) {
    throw new Error("视频服务没有返回视频。");
  }
  const response = await fetchWithTimeout(item.url, {}, { timeoutMs: videoDownloadTimeoutMs(), timeoutMessage: "生成视频下载超时。" });
  if (!response.ok) {
    throw new Error(`生成视频下载失败 (${response.status})。`);
  }
  const mimeType = response.headers.get("content-type") || fallbackMimeType;
  return persistVideoBuffer(Buffer.from(await response.arrayBuffer()), mimeType, "url");
}

export async function createMotionPreviewMp4({ sourceImageUrl, durationSeconds = 2.4, size = "720x960" }) {
  const sourcePath = await resolveSourceImagePath(sourceImageUrl);
  const directory = videoAssetDir();
  await fs.mkdir(directory, { recursive: true });
  const fileName = `${randomUUID()}.mp4`;
  const outputPath = path.join(directory, fileName);
  const duration = safeDuration(durationSeconds);
  const outputSize = safeSize(size);
  const [width, height] = outputSize.split("x");

  await runFfmpeg([
    "-y",
    "-loop",
    "1",
    "-framerate",
    "30",
    "-i",
    sourcePath,
    "-t",
    String(duration),
    "-vf",
    `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,format=yuv420p`,
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-movflags",
    "+faststart",
    outputPath,
  ]);

  const stats = await fs.stat(outputPath);
  const publicUrl = `${videoAssetPublicPath()}/${fileName}`;
  return {
    videoUrl: publicUrl,
    videoInspection: {
      storage: "local_file",
      mimeType: "video/mp4",
      mode: "local_motion_preview",
      fileName,
      publicUrl,
      bytes: stats.size,
      durationSeconds: duration,
      sourceImageUrl,
    },
  };
}
