import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { deflateSync } from "node:zlib";
import sharp from "sharp";

const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "clothdesign-image-provider-"));
process.env.IMAGE_ASSET_DIR = tmpDir;
process.env.IMAGE_ASSET_PUBLIC_PATH = "/generated-images";

const onePixelPng =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";
const onePixelBytes = Buffer.from(onePixelPng, "base64");

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const typeBuffer = Buffer.from(type);
  const chunk = Buffer.alloc(12 + data.length);
  chunk.writeUInt32BE(data.length, 0);
  typeBuffer.copy(chunk, 4);
  data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 8 + data.length);
  return chunk;
}

function rgbaPngBase64(alpha) {
  const signature = Buffer.from("89504e470d0a1a0a", "hex");
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0);
  ihdr.writeUInt32BE(1, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const raw = Buffer.from([0, 24, 160, 96, alpha]);
  return Buffer.concat([signature, pngChunk("IHDR", ihdr), pngChunk("IDAT", deflateSync(raw)), pngChunk("IEND", Buffer.alloc(0))]).toString("base64");
}

function rgbPngBase64(width, height, pixelAt) {
  const signature = Buffer.from("89504e470d0a1a0a", "hex");
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const rows = [];
  for (let y = 0; y < height; y += 1) {
    const row = [0];
    for (let x = 0; x < width; x += 1) {
      row.push(...pixelAt(x, y));
    }
    rows.push(Buffer.from(row));
  }
  return Buffer.concat([signature, pngChunk("IHDR", ihdr), pngChunk("IDAT", deflateSync(Buffer.concat(rows))), pngChunk("IEND", Buffer.alloc(0))]).toString("base64");
}

function minimalJpegBase64(width, height) {
  const sof = Buffer.from([
    0xff,
    0xc0,
    0x00,
    0x11,
    0x08,
    (height >> 8) & 0xff,
    height & 0xff,
    (width >> 8) & 0xff,
    width & 0xff,
    0x03,
    0x01,
    0x11,
    0x00,
    0x02,
    0x11,
    0x00,
    0x03,
    0x11,
    0x00,
  ]);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), sof, Buffer.from([0xff, 0xd9])]).toString("base64");
}

function minimalWebpVp8xBase64(width, height) {
  const payload = Buffer.alloc(10);
  const widthMinusOne = width - 1;
  const heightMinusOne = height - 1;
  payload[4] = widthMinusOne & 0xff;
  payload[5] = (widthMinusOne >> 8) & 0xff;
  payload[6] = (widthMinusOne >> 16) & 0xff;
  payload[7] = heightMinusOne & 0xff;
  payload[8] = (heightMinusOne >> 8) & 0xff;
  payload[9] = (heightMinusOne >> 16) & 0xff;
  const chunkSize = Buffer.alloc(4);
  chunkSize.writeUInt32LE(payload.length, 0);
  const riffSize = Buffer.alloc(4);
  riffSize.writeUInt32LE(4 + 8 + payload.length, 0);
  return Buffer.concat([Buffer.from("RIFF"), riffSize, Buffer.from("WEBPVP8X"), chunkSize, payload]).toString("base64");
}

const imageProvider = await import("../server/image-provider.mjs");
const { cleanupGeneratedImages, persistGeneratedImage, repairCheckerboardTransparency } = imageProvider;

const originalFetch = globalThis.fetch;
const fetchCalls = [];
globalThis.fetch = async (url) => {
  fetchCalls.push(String(url));
  return new Response(onePixelBytes, {
    status: 200,
    headers: { "content-type": "image/png; charset=utf-8" },
  });
};

const persistedUrlImage = await persistGeneratedImage({ url: "https://example.test/result.png" });
assert.equal(fetchCalls.length, 1);
assert.match(persistedUrlImage.imageUrl, /^\/generated-images\/[a-f0-9-]+\.png$/);
assert.equal(persistedUrlImage.imageInspection.sourceType, "url");
assert.equal(persistedUrlImage.imageInspection.mimeType, "image/png");
assert.equal(persistedUrlImage.imageInspection.bytes, onePixelBytes.length);
assert.equal(persistedUrlImage.imageInspection.storage, "local_file");
assert.equal(persistedUrlImage.imageInspection.publicUrl, persistedUrlImage.imageUrl);
assert.deepEqual(persistedUrlImage.imageInspection.dimensions, { width: 1, height: 1 });
assert.equal(await fs.readFile(path.join(tmpDir, persistedUrlImage.imageInspection.fileName), "base64"), onePixelPng);
assert.equal(typeof imageProvider.readManagedGeneratedImage, "function");
const managedReference = await imageProvider.readManagedGeneratedImage(persistedUrlImage.imageUrl, "continued-reference.png");
assert.equal(managedReference.mimetype, "image/png");
assert.equal(managedReference.originalname, "continued-reference.png");
assert.equal(managedReference.buffer.toString("base64"), onePixelPng);
await assert.rejects(() => imageProvider.readManagedGeneratedImage("/generated-images/../secret.png"), /不合法的图片路径/);

const variedRgbImage = await persistGeneratedImage(
  {
    b64_json: rgbPngBase64(16, 16, (x, y) => [(x * 17) % 256, (y * 23) % 256, ((x + y) * 11) % 256]),
  },
  { fallbackMimeType: "image/png" },
);
assert.deepEqual(variedRgbImage.imageInspection.dimensions, { width: 16, height: 16 });
assert.equal(variedRgbImage.imageInspection.content.inspected, true);
assert(variedRgbImage.imageInspection.content.uniqueSampledColors > 32);
assert.equal(variedRgbImage.imageInspection.content.lowInformation, false);

const sparseSubjectImage = await persistGeneratedImage(
  {
    b64_json: rgbPngBase64(512, 512, (x, y) => {
      if (x >= 246 && x < 266 && y >= 246 && y < 266) return [28, 118, 72];
      return [246, 246, 246];
    }),
  },
  { fallbackMimeType: "image/png" },
);
assert.equal(sparseSubjectImage.imageInspection.content.backgroundDominance > 0.96, true);
assert.equal(sparseSubjectImage.imageInspection.content.foregroundCoverage < 0.02, true);
assert.equal(sparseSubjectImage.imageInspection.content.subjectTooSparse, true);

const dressSubjectImage = await persistGeneratedImage(
  {
    b64_json: rgbPngBase64(512, 512, (x, y) => {
      const centerDistance = Math.abs(x - 256);
      const bodyWidth = 72 + Math.max(0, y - 120) * 0.22;
      if (y >= 92 && y <= 456 && centerDistance < bodyWidth) return [31, 112, 71];
      if (y >= 106 && y <= 210 && centerDistance < 150) return [31, 112, 71];
      return [246, 246, 246];
    }),
  },
  { fallbackMimeType: "image/png" },
);
assert.equal(dressSubjectImage.imageInspection.content.backgroundDominance > 0.35, true);
assert.equal(dressSubjectImage.imageInspection.content.foregroundCoverage > 0.18, true);
assert.equal(dressSubjectImage.imageInspection.content.subjectTooSparse, false);

const persistedBase64Image = await persistGeneratedImage({ b64_json: onePixelPng }, { fallbackMimeType: "image/webp" });
assert.match(persistedBase64Image.imageUrl, /^\/generated-images\/[a-f0-9-]+\.png$/);
assert.equal(persistedBase64Image.imageInspection.sourceType, "b64_json");
assert.equal(persistedBase64Image.imageInspection.mimeType, "image/png");
assert.equal(persistedBase64Image.imageInspection.bytes, onePixelBytes.length);
assert.equal(persistedBase64Image.imageInspection.storage, "local_file");
assert.equal(await fs.readFile(path.join(tmpDir, persistedBase64Image.imageInspection.fileName), "base64"), onePixelPng);

const jpegImage = await persistGeneratedImage({ b64_json: minimalJpegBase64(640, 480) }, { fallbackMimeType: "image/png" });
assert.match(jpegImage.imageUrl, /^\/generated-images\/[a-f0-9-]+\.jpg$/);
assert.equal(jpegImage.imageInspection.mimeType, "image/jpeg");
assert.deepEqual(jpegImage.imageInspection.dimensions, { width: 640, height: 480 });

const webpImage = await persistGeneratedImage({ b64_json: minimalWebpVp8xBase64(320, 240) }, { fallbackMimeType: "image/png" });
assert.match(webpImage.imageUrl, /^\/generated-images\/[a-f0-9-]+\.webp$/);
assert.equal(webpImage.imageInspection.mimeType, "image/webp");
assert.deepEqual(webpImage.imageInspection.dimensions, { width: 320, height: 240 });

const solidPngBuffer = Buffer.from(rgbPngBase64(64, 64, () => [246, 246, 246]), "base64");
const solidWebpImage = await persistGeneratedImage(
  { b64_json: (await sharp(solidPngBuffer).webp().toBuffer()).toString("base64") },
  { fallbackMimeType: "image/webp" },
);
assert.equal(solidWebpImage.imageInspection.content.inspected, true);
assert.equal(solidWebpImage.imageInspection.content.lowInformation, true);

const solidJpegImage = await persistGeneratedImage(
  { b64_json: (await sharp(solidPngBuffer).jpeg().toBuffer()).toString("base64") },
  { fallbackMimeType: "image/jpeg" },
);
assert.equal(solidJpegImage.imageInspection.content.inspected, true);
assert.equal(solidJpegImage.imageInspection.content.lowInformation, true);

const opaquePng = await persistGeneratedImage({ b64_json: rgbaPngBase64(255) }, { fallbackMimeType: "image/png" });
assert.equal(opaquePng.imageInspection.alpha.hasAlphaChannel, true);
assert.equal(opaquePng.imageInspection.alpha.transparentPixels, 0);
assert.equal(opaquePng.imageInspection.alpha.opaquePixels, 1);

const transparentPng = await persistGeneratedImage({ b64_json: rgbaPngBase64(0) }, { fallbackMimeType: "image/png" });
assert.equal(transparentPng.imageInspection.alpha.hasAlphaChannel, true);
assert.equal(transparentPng.imageInspection.alpha.transparentPixels, 1);
assert.equal(transparentPng.imageInspection.alpha.opaquePixels, 0);

const checkerboardPng = await persistGeneratedImage(
  {
    b64_json: rgbPngBase64(8, 8, (x, y) => {
      if (x >= 2 && x <= 5 && y >= 2 && y <= 5) return [30, 120, 74];
      return (x + y) % 2 === 0 ? [242, 242, 242] : [225, 225, 225];
    }),
  },
  { fallbackMimeType: "image/png" },
);
assert.equal(checkerboardPng.imageInspection.alpha.hasAlphaChannel, false);
const repairedCheckerboard = await repairCheckerboardTransparency(checkerboardPng.imageUrl);
assert.match(repairedCheckerboard.imageUrl, /^\/generated-images\/[a-f0-9-]+\.png$/);
assert.equal(repairedCheckerboard.imageInspection.alpha.hasAlphaChannel, true);
assert.equal(repairedCheckerboard.imageInspection.alpha.transparentPixels, 48);
assert.equal(repairedCheckerboard.imageInspection.alpha.opaquePixels, 16);
assert.equal(repairedCheckerboard.imageInspection.repair.method, "checkerboard_background");

const ratioNormalizedImage = await persistGeneratedImage(
  {
    b64_json: rgbPngBase64(16, 8, (x, y) => [x * 12, y * 24, 96]),
  },
  { fallbackMimeType: "image/png", targetSize: "8x8" },
);
assert.deepEqual(ratioNormalizedImage.imageInspection.dimensions, { width: 8, height: 8 });
assert.equal(ratioNormalizedImage.imageInspection.normalization.method, "center_crop_resize");
assert.deepEqual(ratioNormalizedImage.imageInspection.normalization.sourceDimensions, { width: 16, height: 8 });
assert.equal(ratioNormalizedImage.imageInspection.normalization.requestedSize, "8x8");

const sourceWidePngBuffer = Buffer.from(rgbPngBase64(16, 8, (x, y) => [x * 12, y * 24, 96]), "base64");
const sourceWideWebpBuffer = await sharp(sourceWidePngBuffer).webp().toBuffer();
const webpNormalizedImage = await persistGeneratedImage(
  {
    b64_json: sourceWideWebpBuffer.toString("base64"),
  },
  { fallbackMimeType: "image/webp", targetSize: "8x8" },
);
assert.match(webpNormalizedImage.imageUrl, /^\/generated-images\/[a-f0-9-]+\.webp$/);
assert.equal(webpNormalizedImage.imageInspection.mimeType, "image/webp");
assert.deepEqual(webpNormalizedImage.imageInspection.dimensions, { width: 8, height: 8 });
assert.equal(webpNormalizedImage.imageInspection.normalization.method, "center_crop_resize");
assert.deepEqual(webpNormalizedImage.imageInspection.normalization.sourceDimensions, { width: 16, height: 8 });
assert.equal(webpNormalizedImage.imageInspection.normalization.requestedSize, "8x8");

const sourceWideJpegBuffer = await sharp(sourceWidePngBuffer).jpeg().toBuffer();
const jpegNormalizedImage = await persistGeneratedImage(
  {
    b64_json: sourceWideJpegBuffer.toString("base64"),
  },
  { fallbackMimeType: "image/jpeg", targetSize: "8x8" },
);
assert.match(jpegNormalizedImage.imageUrl, /^\/generated-images\/[a-f0-9-]+\.jpg$/);
assert.equal(jpegNormalizedImage.imageInspection.mimeType, "image/jpeg");
assert.deepEqual(jpegNormalizedImage.imageInspection.dimensions, { width: 8, height: 8 });
assert.equal(jpegNormalizedImage.imageInspection.normalization.method, "center_crop_resize");
assert.deepEqual(jpegNormalizedImage.imageInspection.normalization.sourceDimensions, { width: 16, height: 8 });
assert.equal(jpegNormalizedImage.imageInspection.normalization.requestedSize, "8x8");

const noisyWidePngBuffer = Buffer.from(
  rgbPngBase64(128, 64, (x, y) => [
    (x * 37 + y * 13) % 256,
    (x * 19 + y * 29) % 256,
    (x * y + x * 11 + y * 7) % 256,
  ]),
  "base64",
);
const noisyWideWebpBuffer = await sharp(noisyWidePngBuffer).webp({ quality: 95 }).toBuffer();
const lowCompressionWebp = await persistGeneratedImage(
  { b64_json: noisyWideWebpBuffer.toString("base64") },
  { fallbackMimeType: "image/webp", targetSize: "64x64", outputCompression: 25 },
);
const highCompressionWebp = await persistGeneratedImage(
  { b64_json: noisyWideWebpBuffer.toString("base64") },
  { fallbackMimeType: "image/webp", targetSize: "64x64", outputCompression: 95 },
);
assert.equal(lowCompressionWebp.imageInspection.normalization.outputCompression, 25);
assert.equal(highCompressionWebp.imageInspection.normalization.outputCompression, 95);
assert(lowCompressionWebp.imageInspection.bytes < highCompressionWebp.imageInspection.bytes * 0.75);

const freshOrphan = await persistGeneratedImage({ b64_json: onePixelPng }, { fallbackMimeType: "image/png" });
const oldTimestamp = new Date(Date.now() - 3 * 60 * 60 * 1000);
await fs.utimes(path.join(tmpDir, persistedBase64Image.imageInspection.fileName), oldTimestamp, oldTimestamp);
const cleanup = await cleanupGeneratedImages({
  referencedUrls: [persistedUrlImage.imageUrl],
  maxAgeMs: 60 * 60 * 1000,
});
assert.deepEqual(
  cleanup.deleted.map((item) => item.fileName),
  [persistedBase64Image.imageInspection.fileName],
);
assert.equal(cleanup.scanned, 19);
assert.equal(cleanup.keptReferenced, 1);
assert.equal(cleanup.keptFresh, 17);
await fs.access(path.join(tmpDir, persistedUrlImage.imageInspection.fileName));
await fs.access(path.join(tmpDir, freshOrphan.imageInspection.fileName));
await assert.rejects(() => fs.access(path.join(tmpDir, persistedBase64Image.imageInspection.fileName)), /ENOENT/);

globalThis.fetch = async () => new Response("not an image", { status: 200, headers: { "content-type": "text/plain" } });
await assert.rejects(() => persistGeneratedImage({ url: "https://example.test/not-image.txt" }), /生成图片不是图片格式/);

globalThis.fetch = async () => new Response("not an image", { status: 200, headers: { "content-type": "image/png" } });
await assert.rejects(() => persistGeneratedImage({ url: "https://example.test/fake.png" }), /生成图片不是有效图片文件/);

await assert.rejects(
  () => persistGeneratedImage({ b64_json: Buffer.from("not an image").toString("base64") }, { fallbackMimeType: "image/png" }),
  /生成图片不是有效图片文件/,
);

await assert.rejects(
  () => persistGeneratedImage({ b64_json: Buffer.from("89504e470d0a1a0a", "hex").toString("base64") }, { fallbackMimeType: "image/png" }),
  /生成图片不是有效图片文件/,
);

process.env.IMAGE_DOWNLOAD_TIMEOUT_MS = "100";
globalThis.fetch = async (_url, init = {}) =>
  new Promise((_, reject) => {
    init.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
  });
await assert.rejects(
  () =>
    Promise.race([
      persistGeneratedImage({ url: "https://example.test/hangs.png" }),
      new Promise((_, reject) => setTimeout(() => reject(new Error("测试等待图片下载超时")), 800)),
    ]),
  /生成图片下载超时/,
);
delete process.env.IMAGE_DOWNLOAD_TIMEOUT_MS;

globalThis.fetch = async () => new Response("", { status: 404, headers: { "content-type": "text/plain" } });
await assert.rejects(() => persistGeneratedImage({ url: "https://example.test/missing.png" }), /生成图片下载失败 \(404\)/);

globalThis.fetch = originalFetch;

console.log(JSON.stringify({ checks: "passed" }, null, 2));
