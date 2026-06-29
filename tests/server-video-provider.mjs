import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "clothdesign-video-provider-"));
const imageDir = path.join(tmpDir, "generated-images");
const videoDir = path.join(tmpDir, "generated-videos");
process.env.IMAGE_ASSET_DIR = imageDir;
process.env.IMAGE_ASSET_PUBLIC_PATH = "/generated-images";
process.env.VIDEO_ASSET_DIR = videoDir;
process.env.VIDEO_ASSET_PUBLIC_PATH = "/generated-videos";

const { createMotionPreviewMp4, generatedVideoStaticMount, persistGeneratedVideo, videoEncodingStatus } = await import("../server/video-provider.mjs");

const onePixelPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=",
  "base64",
);
await fs.mkdir(imageDir, { recursive: true });
await fs.writeFile(path.join(imageDir, "source.png"), onePixelPng);

assert.equal(generatedVideoStaticMount().publicPath, "/generated-videos");
assert.equal(generatedVideoStaticMount().directory, videoDir);
assert.equal(videoEncodingStatus().available, true);

const generated = await createMotionPreviewMp4({
  sourceImageUrl: "/generated-images/source.png",
  durationSeconds: 1,
  size: "320x320",
});

assert.match(generated.videoUrl, /^\/generated-videos\/[a-f0-9-]+\.mp4$/);
assert.equal(generated.videoInspection.storage, "local_file");
assert.equal(generated.videoInspection.mimeType, "video/mp4");
assert.equal(generated.videoInspection.mode, "local_motion_preview");
assert.equal(generated.videoInspection.durationSeconds, 1);
assert.equal(generated.videoInspection.publicUrl, generated.videoUrl);
const mp4 = await fs.readFile(path.join(videoDir, generated.videoInspection.fileName));
assert(mp4.length > 1000, "MP4 output is unexpectedly small");
assert.equal(mp4.subarray(4, 8).toString("utf8"), "ftyp");

const persistedBase64Video = await persistGeneratedVideo({ b64_video: mp4.toString("base64") });
assert.match(persistedBase64Video.videoUrl, /^\/generated-videos\/[a-f0-9-]+\.mp4$/);
assert.equal(persistedBase64Video.videoInspection.mode, "external_video_service");
assert.equal(persistedBase64Video.videoInspection.sourceType, "b64_video");
assert.equal(persistedBase64Video.videoInspection.mimeType, "video/mp4");
assert.equal(persistedBase64Video.videoInspection.publicUrl, persistedBase64Video.videoUrl);
assert.equal(await fs.readFile(path.join(videoDir, persistedBase64Video.videoInspection.fileName), "base64"), mp4.toString("base64"));

await assert.rejects(
  () => persistGeneratedVideo({ b64_video: Buffer.from("not an mp4").toString("base64") }),
  /生成视频不是 MP4 文件/,
);

const originalFetch = globalThis.fetch;
globalThis.fetch = async (url) => {
  assert.equal(String(url), "https://video.example.test/output.mp4");
  return new Response(mp4, { status: 200, headers: { "content-type": "video/mp4" } });
};
const persistedUrlVideo = await persistGeneratedVideo({ url: "https://video.example.test/output.mp4" });
assert.match(persistedUrlVideo.videoUrl, /^\/generated-videos\/[a-f0-9-]+\.mp4$/);
assert.equal(persistedUrlVideo.videoInspection.sourceType, "url");
assert.equal(await fs.readFile(path.join(videoDir, persistedUrlVideo.videoInspection.fileName), "base64"), mp4.toString("base64"));
globalThis.fetch = originalFetch;

globalThis.fetch = async (url) => {
  assert.equal(String(url), "https://video.example.test/output.webm");
  return new Response(Buffer.from("webm bytes"), { status: 200, headers: { "content-type": "video/webm" } });
};
await assert.rejects(() => persistGeneratedVideo({ url: "https://video.example.test/output.webm" }), /生成视频不是 MP4 格式/);
globalThis.fetch = originalFetch;

process.env.VIDEO_DOWNLOAD_TIMEOUT_MS = "100";
globalThis.fetch = async (url, init = {}) => {
  assert.equal(String(url), "https://video.example.test/hangs.mp4");
  return new Promise((_, reject) => {
    init.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
  });
};
await assert.rejects(() => persistGeneratedVideo({ url: "https://video.example.test/hangs.mp4" }), /生成视频下载超时/);
globalThis.fetch = originalFetch;
delete process.env.VIDEO_DOWNLOAD_TIMEOUT_MS;

await assert.rejects(
  () => createMotionPreviewMp4({ sourceImageUrl: "/generated-images/../secret.png", durationSeconds: 1 }),
  /不合法的图片路径/,
);

console.log(JSON.stringify({ checks: "passed" }, null, 2));
