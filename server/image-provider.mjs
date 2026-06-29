import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { deflateSync, inflateSync } from "node:zlib";
import sharp from "sharp";
import { fetchWithTimeout, timeoutMsFromEnv } from "./timeouts.mjs";

function normalizedImageMime(mimeType) {
  return String(mimeType || "image/png").split(";")[0].trim() || "image/png";
}

function imageDownloadTimeoutMs() {
  return timeoutMsFromEnv(["IMAGE_DOWNLOAD_TIMEOUT_MS", "OPENAI_IMAGE_TIMEOUT_MS"], 120000);
}

async function fetchImageWithTimeout(url) {
  return fetchWithTimeout(url, {}, { timeoutMs: imageDownloadTimeoutMs(), timeoutMessage: "生成图片下载超时。" });
}

function sniffImageMime(buffer) {
  if (buffer.length >= 8 && buffer.subarray(0, 8).toString("hex") === "89504e470d0a1a0a") return "image/png";
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "image/jpeg";
  if (buffer.length >= 12 && buffer.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WEBP") {
    return "image/webp";
  }
  return "";
}

function imageAssetDir() {
  return path.resolve(process.env.IMAGE_ASSET_DIR || "./data/generated-images");
}

function imageAssetPublicPath() {
  const configured = String(process.env.IMAGE_ASSET_PUBLIC_PATH || "/generated-images").trim() || "/generated-images";
  return `/${configured.replace(/^\/+|\/+$/g, "")}`;
}

function extensionForMime(mimeType) {
  if (mimeType === "image/jpeg") return "jpg";
  if (mimeType === "image/webp") return "webp";
  return "png";
}

function mimeForExtension(fileName) {
  const extension = path.extname(fileName).toLowerCase();
  if (extension === ".jpg" || extension === ".jpeg") return "image/jpeg";
  if (extension === ".webp") return "image/webp";
  return "image/png";
}

function publicUrlForFile(fileName) {
  return `${imageAssetPublicPath()}/${fileName}`;
}

function isManagedImageFile(fileName) {
  return /^[a-f0-9-]+\.(png|jpg|jpeg|webp)$/i.test(fileName);
}

function managedImageFileNameFromUrl(publicUrl) {
  const publicPath = imageAssetPublicPath();
  if (!String(publicUrl || "").startsWith(`${publicPath}/`)) {
    throw new Error("不合法的图片路径。");
  }
  const fileName = decodeURIComponent(String(publicUrl).slice(publicPath.length + 1));
  if (!isManagedImageFile(fileName) || fileName.includes("..") || path.basename(fileName) !== fileName) {
    throw new Error("不合法的图片路径。");
  }
  return fileName;
}

function paethPredictor(left, above, upperLeft) {
  const p = left + above - upperLeft;
  const pa = Math.abs(p - left);
  const pb = Math.abs(p - above);
  const pc = Math.abs(p - upperLeft);
  if (pa <= pb && pa <= pc) return left;
  if (pb <= pc) return above;
  return upperLeft;
}

function unfilterPngScanline(filter, current, previous, bytesPerPixel) {
  const output = Buffer.from(current);
  for (let index = 0; index < output.length; index += 1) {
    const left = index >= bytesPerPixel ? output[index - bytesPerPixel] : 0;
    const above = previous?.[index] || 0;
    const upperLeft = index >= bytesPerPixel ? previous?.[index - bytesPerPixel] || 0 : 0;
    if (filter === 1) output[index] = (output[index] + left) & 0xff;
    else if (filter === 2) output[index] = (output[index] + above) & 0xff;
    else if (filter === 3) output[index] = (output[index] + Math.floor((left + above) / 2)) & 0xff;
    else if (filter === 4) output[index] = (output[index] + paethPredictor(left, above, upperLeft)) & 0xff;
  }
  return output;
}

function parsePng(buffer) {
  if (buffer.length < 33 || buffer.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") return null;
  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  const idatChunks = [];
  while (offset + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.subarray(offset + 4, offset + 8).toString("ascii");
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    if (dataEnd + 4 > buffer.length) break;
    const data = buffer.subarray(dataStart, dataEnd);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === "IDAT") {
      idatChunks.push(data);
    } else if (type === "IEND") {
      break;
    }
    offset = dataEnd + 4;
  }
  return { width, height, bitDepth, colorType, interlace, idatChunks };
}

function decodePngRgba(buffer) {
  const parsed = parsePng(buffer);
  if (!parsed || parsed.bitDepth !== 8 || parsed.interlace !== 0 || parsed.width <= 0 || parsed.height <= 0 || parsed.idatChunks.length === 0) return null;
  const channelsByColorType = { 2: 3, 6: 4 };
  const channels = channelsByColorType[parsed.colorType];
  if (!channels) return null;
  const rowLength = parsed.width * channels;
  const inflated = inflateSync(Buffer.concat(parsed.idatChunks));
  const rgba = Buffer.alloc(parsed.width * parsed.height * 4);
  let cursor = 0;
  let previous = Buffer.alloc(rowLength);
  for (let y = 0; y < parsed.height; y += 1) {
    const filter = inflated[cursor];
    const current = inflated.subarray(cursor + 1, cursor + 1 + rowLength);
    const row = unfilterPngScanline(filter, current, previous, channels);
    for (let x = 0; x < parsed.width; x += 1) {
      const src = x * channels;
      const dest = (y * parsed.width + x) * 4;
      rgba[dest] = row[src];
      rgba[dest + 1] = row[src + 1];
      rgba[dest + 2] = row[src + 2];
      rgba[dest + 3] = channels === 4 ? row[src + 3] : 255;
    }
    previous = row;
    cursor += 1 + rowLength;
  }
  return { width: parsed.width, height: parsed.height, rgba };
}

function fabricColorLabel({ r, g, b }) {
  if (r >= 220 && g >= 205 && b >= 180) return "ivory";
  if (g >= 80 && g >= r * 1.25 && g >= b * 0.95 && r <= 120) return "moss green";
  if (r >= 190 && g >= 150 && b <= 120) return "butter yellow";
  if (r >= 160 && b >= 130 && g <= 165) return "soft pink";
  if (r <= 70 && g <= 70 && b <= 70) return "black";
  return "";
}

function sampledFabricBuckets(decoded) {
  const buckets = new Map();
  const grid = Math.max(8, Math.min(64, Math.floor(Math.sqrt(decoded.width * decoded.height))));
  for (let gy = 0; gy < grid; gy += 1) {
    for (let gx = 0; gx < grid; gx += 1) {
      const x = Math.min(decoded.width - 1, Math.floor(((gx + 0.5) / grid) * decoded.width));
      const y = Math.min(decoded.height - 1, Math.floor(((gy + 0.5) / grid) * decoded.height));
      const offset = (y * decoded.width + x) * 4;
      const a = decoded.rgba[offset + 3];
      if (a < 16) continue;
      const r = decoded.rgba[offset];
      const g = decoded.rgba[offset + 1];
      const b = decoded.rgba[offset + 2];
      const key = `${Math.round(r / 24)},${Math.round(g / 24)},${Math.round(b / 24)}`;
      const current = buckets.get(key) || { count: 0, r: 0, g: 0, b: 0 };
      current.count += 1;
      current.r += r;
      current.g += g;
      current.b += b;
      buckets.set(key, current);
    }
  }
  return [...buckets.values()]
    .sort((a, b) => b.count - a.count)
    .map((bucket) => ({
      count: bucket.count,
      r: bucket.r / bucket.count,
      g: bucket.g / bucket.count,
      b: bucket.b / bucket.count,
    }));
}

function fabricStripeTransitions(decoded) {
  const sampleLine = (horizontal) => {
    const steps = 64;
    let previous = "";
    let transitions = 0;
    for (let index = 0; index < steps; index += 1) {
      const x = horizontal ? Math.floor((index / (steps - 1)) * (decoded.width - 1)) : Math.floor(decoded.width / 2);
      const y = horizontal ? Math.floor(decoded.height / 2) : Math.floor((index / (steps - 1)) * (decoded.height - 1));
      const offset = (y * decoded.width + x) * 4;
      const key = colorKey(decoded.rgba[offset], decoded.rgba[offset + 1], decoded.rgba[offset + 2], decoded.rgba[offset + 3]);
      if (previous && key !== previous) transitions += 1;
      previous = key;
    }
    return transitions;
  };
  return Math.max(sampleLine(true), sampleLine(false));
}

export function analyzeFabricImageBuffer(buffer) {
  const decoded = decodePngRgba(buffer);
  if (!decoded) return null;
  const buckets = sampledFabricBuckets(decoded);
  if (buckets.length === 0) return null;
  const colors = [];
  for (const bucket of buckets.slice(0, 6)) {
    const label = fabricColorLabel(bucket);
    if (label && !colors.includes(label)) colors.push(label);
  }
  const transitions = fabricStripeTransitions(decoded);
  const pattern = transitions >= 8 ? "stripe" : colors.length >= 3 || buckets.length >= 24 ? "printed pattern" : "solid";
  const texture = transitions >= 8 ? "woven stripe" : buckets.length >= 24 ? "textured woven" : "smooth woven";
  return {
    colors: colors.length ? colors : ["soft neutral"],
    pattern,
    texture,
    weight: "light-medium",
    inferredUse: "womenswear",
    analysisSource: "image",
    confidence: buckets.length >= 2 ? "medium" : "low",
  };
}

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

function encodeRgbaPng({ width, height, rgba }) {
  const signature = Buffer.from("89504e470d0a1a0a", "hex");
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const rows = [];
  for (let y = 0; y < height; y += 1) {
    const start = y * width * 4;
    rows.push(Buffer.concat([Buffer.from([0]), rgba.subarray(start, start + width * 4)]));
  }
  return Buffer.concat([signature, pngChunk("IHDR", ihdr), pngChunk("IDAT", deflateSync(Buffer.concat(rows))), pngChunk("IEND", Buffer.alloc(0))]);
}

function parseTargetSize(targetSize) {
  const match = String(targetSize || "").match(/^(\d+)x(\d+)$/);
  if (!match) return null;
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) return null;
  return { width, height, requestedSize: `${width}x${height}` };
}

function safeImageQuality(value, fallback = 92) {
  const quality = Number(value);
  if (!Number.isFinite(quality)) return fallback;
  return Math.min(Math.max(Math.round(quality), 1), 100);
}

function cropRgba(decoded, offsetX, offsetY, width, height) {
  const rgba = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    const sourceStart = ((offsetY + y) * decoded.width + offsetX) * 4;
    const targetStart = y * width * 4;
    decoded.rgba.copy(rgba, targetStart, sourceStart, sourceStart + width * 4);
  }
  return { width, height, rgba };
}

function resizeRgba(decoded, width, height) {
  if (decoded.width === width && decoded.height === height) return decoded;
  const rgba = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    const sourceY = height === 1 ? 0 : (y * (decoded.height - 1)) / (height - 1);
    const y0 = Math.floor(sourceY);
    const y1 = Math.min(decoded.height - 1, y0 + 1);
    const wy = sourceY - y0;
    for (let x = 0; x < width; x += 1) {
      const sourceX = width === 1 ? 0 : (x * (decoded.width - 1)) / (width - 1);
      const x0 = Math.floor(sourceX);
      const x1 = Math.min(decoded.width - 1, x0 + 1);
      const wx = sourceX - x0;
      const target = (y * width + x) * 4;
      for (let channel = 0; channel < 4; channel += 1) {
        const topLeft = decoded.rgba[(y0 * decoded.width + x0) * 4 + channel];
        const topRight = decoded.rgba[(y0 * decoded.width + x1) * 4 + channel];
        const bottomLeft = decoded.rgba[(y1 * decoded.width + x0) * 4 + channel];
        const bottomRight = decoded.rgba[(y1 * decoded.width + x1) * 4 + channel];
        const top = topLeft + (topRight - topLeft) * wx;
        const bottom = bottomLeft + (bottomRight - bottomLeft) * wx;
        rgba[target + channel] = Math.round(top + (bottom - top) * wy);
      }
    }
  }
  return { width, height, rgba };
}

function centerCropRegion(sourceWidth, sourceHeight, targetWidth, targetHeight) {
  const sourceAspect = sourceWidth / sourceHeight;
  const targetAspect = targetWidth / targetHeight;
  let cropWidth = sourceWidth;
  let cropHeight = sourceHeight;
  if (sourceAspect > targetAspect) {
    cropWidth = Math.max(1, Math.floor(sourceHeight * targetAspect));
  } else if (sourceAspect < targetAspect) {
    cropHeight = Math.max(1, Math.floor(sourceWidth / targetAspect));
  }
  if (cropWidth < targetWidth || cropHeight < targetHeight) return null;
  return {
    x: Math.floor((sourceWidth - cropWidth) / 2),
    y: Math.floor((sourceHeight - cropHeight) / 2),
    width: cropWidth,
    height: cropHeight,
  };
}

function normalizePngToTargetSize(buffer, targetSize) {
  const target = parseTargetSize(targetSize);
  if (!target) return { buffer };
  const decoded = decodePngRgba(buffer);
  if (!decoded) return { buffer };
  if (decoded.width === target.width && decoded.height === target.height) return { buffer };
  if (decoded.width < target.width || decoded.height < target.height) return { buffer };

  const crop = centerCropRegion(decoded.width, decoded.height, target.width, target.height);
  if (!crop) return { buffer };
  const cropped = cropRgba(decoded, crop.x, crop.y, crop.width, crop.height);
  const resized = resizeRgba(cropped, target.width, target.height);
  return {
    buffer: encodeRgbaPng(resized),
    mimeType: "image/png",
    normalization: {
      method: "center_crop_resize",
      requestedSize: target.requestedSize,
      sourceDimensions: { width: decoded.width, height: decoded.height },
      crop,
      outputDimensions: { width: target.width, height: target.height },
    },
  };
}

async function normalizeEncodedImageToTargetSize(buffer, mimeType, { targetSize, outputCompression } = {}) {
  const target = parseTargetSize(targetSize);
  if (!target) return { buffer };
  const dimensions = inspectImageDimensions(buffer);
  if (!dimensions) return { buffer };
  if (dimensions.width === target.width && dimensions.height === target.height) return { buffer };
  if (dimensions.width < target.width || dimensions.height < target.height) return { buffer };
  if (mimeType === "image/png") return normalizePngToTargetSize(buffer, target.requestedSize);
  if (mimeType !== "image/jpeg" && mimeType !== "image/webp") return { buffer };

  const crop = centerCropRegion(dimensions.width, dimensions.height, target.width, target.height);
  if (!crop) return { buffer };
  const quality = safeImageQuality(outputCompression);
  let pipeline = sharp(buffer, { failOn: "none" }).resize({
    width: target.width,
    height: target.height,
    fit: "cover",
    position: "centre",
  });
  pipeline = mimeType === "image/webp" ? pipeline.webp({ quality }) : pipeline.jpeg({ quality });
  return {
    buffer: await pipeline.toBuffer(),
    mimeType,
    normalization: {
      method: "center_crop_resize",
      requestedSize: target.requestedSize,
      sourceDimensions: dimensions,
      crop,
      outputDimensions: { width: target.width, height: target.height },
      outputCompression: quality,
    },
  };
}

function inspectPngAlpha(buffer) {
  const parsed = parsePng(buffer);
  if (!parsed) return null;
  const alphaOffsetByColorType = { 4: 1, 6: 3 };
  const channelsByColorType = { 4: 2, 6: 4 };
  const channels = channelsByColorType[parsed.colorType];
  if (!channels || parsed.bitDepth !== 8 || parsed.width <= 0 || parsed.height <= 0 || parsed.idatChunks.length === 0) {
    return { hasAlphaChannel: parsed.colorType === 4 || parsed.colorType === 6, transparentPixels: null, opaquePixels: null, inspected: false };
  }
  const bytesPerPixel = channels;
  const rowLength = parsed.width * bytesPerPixel;
  const inflated = inflateSync(Buffer.concat(parsed.idatChunks));
  let cursor = 0;
  let previous = Buffer.alloc(rowLength);
  let transparentPixels = 0;
  let opaquePixels = 0;
  const visibleBounds = { minX: parsed.width, minY: parsed.height, maxX: -1, maxY: -1 };
  for (let y = 0; y < parsed.height; y += 1) {
    const filter = inflated[cursor];
    const current = inflated.subarray(cursor + 1, cursor + 1 + rowLength);
    const row = unfilterPngScanline(filter, current, previous, bytesPerPixel);
    for (let x = alphaOffsetByColorType[parsed.colorType], pixelX = 0; x < row.length; x += bytesPerPixel, pixelX += 1) {
      if (row[x] < 255) transparentPixels += 1;
      else opaquePixels += 1;
      if (row[x] > 0) {
        visibleBounds.minX = Math.min(visibleBounds.minX, pixelX);
        visibleBounds.minY = Math.min(visibleBounds.minY, y);
        visibleBounds.maxX = Math.max(visibleBounds.maxX, pixelX);
        visibleBounds.maxY = Math.max(visibleBounds.maxY, y);
      }
    }
    previous = row;
    cursor += 1 + rowLength;
  }
  return {
    hasAlphaChannel: true,
    transparentPixels,
    opaquePixels,
    inspected: true,
    visibleBounds: visibleBounds.maxX >= 0 ? alphaVisibleBoundsSummary(visibleBounds, parsed.width, parsed.height) : null,
  };
}

function alphaVisibleBoundsSummary(bounds, width, height) {
  const touches = {
    left: bounds.minX <= 0,
    top: bounds.minY <= 0,
    right: bounds.maxX >= width - 1,
    bottom: bounds.maxY >= height - 1,
  };
  return {
    ...bounds,
    touches,
    touchesAllEdges: touches.left && touches.top && touches.right && touches.bottom,
  };
}

function inspectImageDimensions(buffer) {
  const parsed = parsePng(buffer);
  if (parsed?.width > 0 && parsed?.height > 0) return { width: parsed.width, height: parsed.height };
  return inspectJpegDimensions(buffer) || inspectWebpDimensions(buffer);
}

function inspectJpegDimensions(buffer) {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 9 < buffer.length) {
    if (buffer[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    let marker = buffer[offset + 1];
    offset += 2;
    while (marker === 0xff && offset < buffer.length) {
      marker = buffer[offset];
      offset += 1;
    }
    if (marker === 0xd9 || marker === 0xda) break;
    if (marker >= 0xd0 && marker <= 0xd7) continue;
    if (offset + 2 > buffer.length) break;
    const length = buffer.readUInt16BE(offset);
    if (length < 2 || offset + length > buffer.length) break;
    const isStartOfFrame = (marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7) || (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf);
    if (isStartOfFrame && length >= 7) {
      const height = buffer.readUInt16BE(offset + 3);
      const width = buffer.readUInt16BE(offset + 5);
      return width > 0 && height > 0 ? { width, height } : null;
    }
    offset += length;
  }
  return null;
}

function readUint24LE(buffer, offset) {
  return buffer[offset] + (buffer[offset + 1] << 8) + (buffer[offset + 2] << 16);
}

function inspectWebpDimensions(buffer) {
  if (buffer.length < 20 || buffer.subarray(0, 4).toString("ascii") !== "RIFF" || buffer.subarray(8, 12).toString("ascii") !== "WEBP") {
    return null;
  }
  let offset = 12;
  while (offset + 8 <= buffer.length) {
    const type = buffer.subarray(offset, offset + 4).toString("ascii");
    const length = buffer.readUInt32LE(offset + 4);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    if (dataEnd > buffer.length) return null;
    if (type === "VP8X" && length >= 10) {
      const width = readUint24LE(buffer, dataStart + 4) + 1;
      const height = readUint24LE(buffer, dataStart + 7) + 1;
      return { width, height };
    }
    if (type === "VP8 " && length >= 10 && buffer[dataStart + 3] === 0x9d && buffer[dataStart + 4] === 0x01 && buffer[dataStart + 5] === 0x2a) {
      return {
        width: buffer.readUInt16LE(dataStart + 6) & 0x3fff,
        height: buffer.readUInt16LE(dataStart + 8) & 0x3fff,
      };
    }
    if (type === "VP8L" && length >= 5 && buffer[dataStart] === 0x2f) {
      const byte1 = buffer[dataStart + 1];
      const byte2 = buffer[dataStart + 2];
      const byte3 = buffer[dataStart + 3];
      const byte4 = buffer[dataStart + 4];
      return {
        width: 1 + byte1 + ((byte2 & 0x3f) << 8),
        height: 1 + ((byte2 & 0xc0) >> 6) + (byte3 << 2) + ((byte4 & 0x0f) << 10),
      };
    }
    offset = dataEnd + (length % 2);
  }
  return null;
}

function colorKey(r, g, b, a) {
  if (a < 16) return "transparent";
  return `${Math.round(r / 16)},${Math.round(g / 16)},${Math.round(b / 16)}`;
}

function colorDistance(a, b) {
  return Math.abs(a.r - b.r) + Math.abs(a.g - b.g) + Math.abs(a.b - b.b) + Math.abs(a.a - b.a) * 0.35;
}

function dominantBorderColor(decoded) {
  const { width, height, rgba } = decoded;
  const step = Math.max(1, Math.floor(Math.max(width, height) / 128));
  const buckets = new Map();
  const sample = (x, y) => {
    const offset = (y * width + x) * 4;
    const key = colorKey(rgba[offset], rgba[offset + 1], rgba[offset + 2], rgba[offset + 3]);
    const current = buckets.get(key) || { count: 0, r: 0, g: 0, b: 0, a: 0 };
    current.count += 1;
    current.r += rgba[offset];
    current.g += rgba[offset + 1];
    current.b += rgba[offset + 2];
    current.a += rgba[offset + 3];
    buckets.set(key, current);
  };
  for (let x = 0; x < width; x += step) {
    sample(x, 0);
    sample(x, height - 1);
  }
  for (let y = 0; y < height; y += step) {
    sample(0, y);
    sample(width - 1, y);
  }
  let dominant = null;
  for (const bucket of buckets.values()) {
    if (!dominant || bucket.count > dominant.count) dominant = bucket;
  }
  if (!dominant) return null;
  return {
    r: dominant.r / dominant.count,
    g: dominant.g / dominant.count,
    b: dominant.b / dominant.count,
    a: dominant.a / dominant.count,
  };
}

async function decodeSharpRgba(buffer) {
  try {
    const { data, info } = await sharp(buffer, { failOn: "none" }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    if (!info.width || !info.height || info.channels !== 4) return null;
    return { width: info.width, height: info.height, rgba: Buffer.from(data) };
  } catch {
    return null;
  }
}

function inspectDecodedImageContent(decoded) {
  const pixelCount = decoded.width * decoded.height;
  if (pixelCount === 0) return { inspected: false };
  const maxSamples = 4096;
  const stride = Math.max(1, Math.floor(pixelCount / maxSamples));
  const colors = new Set();
  const backgroundColor = dominantBorderColor(decoded);
  let backgroundLikePixels = 0;
  let sampledPixels = 0;
  for (let pixel = 0; pixel < pixelCount; pixel += stride) {
    const offset = pixel * 4;
    colors.add(`${decoded.rgba[offset]},${decoded.rgba[offset + 1]},${decoded.rgba[offset + 2]},${decoded.rgba[offset + 3]}`);
    if (
      backgroundColor &&
      colorDistance(
        { r: decoded.rgba[offset], g: decoded.rgba[offset + 1], b: decoded.rgba[offset + 2], a: decoded.rgba[offset + 3] },
        backgroundColor,
      ) <= 36
    ) {
      backgroundLikePixels += 1;
    }
    sampledPixels += 1;
  }
  const backgroundDominance = sampledPixels > 0 && backgroundColor ? backgroundLikePixels / sampledPixels : null;
  const foregroundCoverage = backgroundDominance === null ? null : 1 - backgroundDominance;
  return {
    inspected: true,
    sampledPixels,
    uniqueSampledColors: colors.size,
    backgroundDominance,
    foregroundCoverage,
    subjectTooSparse: Boolean(sampledPixels >= 64 && backgroundDominance !== null && backgroundDominance >= 0.82 && foregroundCoverage < 0.03),
    lowInformation: sampledPixels >= 16 && colors.size <= 1,
  };
}

async function inspectImageContentBuffer(buffer) {
  const decoded = decodePngRgba(buffer) || (await decodeSharpRgba(buffer));
  if (!decoded) return { inspected: false };
  return inspectDecodedImageContent(decoded);
}

async function inspectImageAlphaBuffer(buffer) {
  const pngAlpha = inspectPngAlpha(buffer);
  if (pngAlpha) return pngAlpha;
  let metadata;
  try {
    metadata = await sharp(buffer, { failOn: "none" }).metadata();
  } catch {
    return null;
  }
  if (!metadata?.hasAlpha) {
    return { hasAlphaChannel: false, transparentPixels: null, opaquePixels: null, inspected: false };
  }
  const decoded = await decodeSharpRgba(buffer);
  if (!decoded) {
    return { hasAlphaChannel: true, transparentPixels: null, opaquePixels: null, inspected: false };
  }
  let transparentPixels = 0;
  let opaquePixels = 0;
  const visibleBounds = { minX: decoded.width, minY: decoded.height, maxX: -1, maxY: -1 };
  for (let y = 0; y < decoded.height; y += 1) {
    for (let x = 0; x < decoded.width; x += 1) {
      const alpha = decoded.rgba[(y * decoded.width + x) * 4 + 3];
      if (alpha < 255) transparentPixels += 1;
      else opaquePixels += 1;
      if (alpha > 0) {
        visibleBounds.minX = Math.min(visibleBounds.minX, x);
        visibleBounds.minY = Math.min(visibleBounds.minY, y);
        visibleBounds.maxX = Math.max(visibleBounds.maxX, x);
        visibleBounds.maxY = Math.max(visibleBounds.maxY, y);
      }
    }
  }
  return {
    hasAlphaChannel: true,
    transparentPixels,
    opaquePixels,
    inspected: true,
    visibleBounds: visibleBounds.maxX >= 0 ? alphaVisibleBoundsSummary(visibleBounds, decoded.width, decoded.height) : null,
  };
}

function isLightCheckerPixel(r, g, b) {
  const spread = Math.max(r, g, b) - Math.min(r, g, b);
  return spread <= 18 && r >= 200 && g >= 200 && b >= 200;
}

function checkerboardAlphaRepair(decoded) {
  const { width, height, rgba } = decoded;
  const pixelCount = width * height;
  const transparent = new Uint8Array(pixelCount);
  const queue = [];
  const enqueue = (index) => {
    if (transparent[index]) return;
    const offset = index * 4;
    if (!isLightCheckerPixel(rgba[offset], rgba[offset + 1], rgba[offset + 2])) return;
    transparent[index] = 1;
    queue.push(index);
  };
  for (let x = 0; x < width; x += 1) {
    enqueue(x);
    enqueue((height - 1) * width + x);
  }
  for (let y = 0; y < height; y += 1) {
    enqueue(y * width);
    enqueue(y * width + width - 1);
  }
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const index = queue[cursor];
    const x = index % width;
    const y = Math.floor(index / width);
    if (x > 0) enqueue(index - 1);
    if (x < width - 1) enqueue(index + 1);
    if (y > 0) enqueue(index - width);
    if (y < height - 1) enqueue(index + width);
  }
  let transparentPixels = 0;
  let opaquePixels = 0;
  const transparentColorKeys = new Set();
  const repaired = Buffer.from(rgba);
  for (let index = 0; index < pixelCount; index += 1) {
    if (transparent[index]) {
      const offset = index * 4;
      transparentColorKeys.add(`${rgba[offset]},${rgba[offset + 1]},${rgba[offset + 2]}`);
      repaired[offset + 3] = 0;
      transparentPixels += 1;
    } else {
      repaired[index * 4 + 3] = 255;
      opaquePixels += 1;
    }
  }
  if (transparentPixels === 0 || opaquePixels === 0) return null;
  return {
    width,
    height,
    rgba: repaired,
    transparentPixels,
    opaquePixels,
    method: transparentColorKeys.size > 1 ? "checkerboard_background" : "solid_background",
  };
}

export function generatedImageStaticMount() {
  return {
    publicPath: imageAssetPublicPath(),
    directory: imageAssetDir(),
  };
}

export async function readManagedGeneratedImage(publicUrl, originalname = "generated-reference.png") {
  const fileName = managedImageFileNameFromUrl(publicUrl);
  return {
    buffer: await fs.readFile(path.join(imageAssetDir(), fileName)),
    mimetype: mimeForExtension(fileName),
    originalname,
  };
}

export function validateImageBuffer(buffer, mimeType = "image/png", label = "生成图片") {
  const normalizedMime = normalizedImageMime(mimeType);
  if (!buffer || buffer.length === 0) {
    throw new Error(`${label}为空。`);
  }
  const sniffedMime = sniffImageMime(buffer);
  if (!normalizedMime.startsWith("image/") && !sniffedMime) {
    throw new Error(`${label}不是图片格式：${normalizedMime}`);
  }
  if (!sniffedMime) {
    throw new Error(`${label}不是有效图片文件。`);
  }
  const dimensions = inspectImageDimensions(buffer);
  if (!dimensions) {
    throw new Error(`${label}不是有效图片文件。`);
  }
  return { mimeType: sniffedMime, dimensions };
}

async function persistImageBuffer(buffer, mimeType, sourceType, { targetSize, outputCompression } = {}) {
  let normalizedMime = normalizedImageMime(mimeType);
  normalizedMime = validateImageBuffer(buffer, normalizedMime, "生成图片").mimeType;
  let imageBuffer = buffer;
  let normalization = null;
  const normalized = await normalizeEncodedImageToTargetSize(buffer, normalizedMime, { targetSize, outputCompression });
  imageBuffer = normalized.buffer;
  normalizedMime = normalized.mimeType || normalizedMime;
  normalization = normalized.normalization || null;
  const { dimensions } = validateImageBuffer(imageBuffer, normalizedMime, "生成图片");
  const filename = `${randomUUID()}.${extensionForMime(normalizedMime)}`;
  const directory = imageAssetDir();
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, filename), imageBuffer);
  const [content, alpha] = await Promise.all([inspectImageContentBuffer(imageBuffer), inspectImageAlphaBuffer(imageBuffer)]);
  const publicUrl = publicUrlForFile(filename);
  return {
    imageUrl: publicUrl,
    imageInspection: {
      sourceType,
      mimeType: normalizedMime,
      bytes: imageBuffer.length,
      storage: "local_file",
      fileName: filename,
      publicUrl,
      dimensions,
      content,
      alpha,
      ...(normalization ? { normalization } : {}),
    },
  };
}

export async function persistGeneratedImage(item, { fallbackMimeType = "image/png", targetSize, outputCompression } = {}) {
  if (item?.b64_json) {
    return persistImageBuffer(Buffer.from(item.b64_json, "base64"), fallbackMimeType, "b64_json", { targetSize, outputCompression });
  }
  if (!item?.url) {
    throw new Error("图像引擎没有返回图片。");
  }
  const response = await fetchImageWithTimeout(item.url);
  if (!response.ok) {
    throw new Error(`生成图片下载失败 (${response.status})。`);
  }
  const mimeType = response.headers.get("content-type") || fallbackMimeType;
  const buffer = Buffer.from(await response.arrayBuffer());
  return persistImageBuffer(buffer, mimeType, "url", { targetSize, outputCompression });
}

export async function repairCheckerboardTransparency(publicUrl) {
  const fileName = managedImageFileNameFromUrl(publicUrl);
  const sourcePath = path.join(imageAssetDir(), fileName);
  const buffer = await fs.readFile(sourcePath);
  const decoded = decodePngRgba(buffer);
  if (!decoded) {
    throw new Error("暂不支持修复该图片格式。");
  }
  const repaired = checkerboardAlphaRepair(decoded);
  if (!repaired) {
    throw new Error("未检测到可修复的棋盘格背景。");
  }
  const persisted = await persistImageBuffer(encodeRgbaPng(repaired), "image/png", "checkerboard_repair");
  return {
    ...persisted,
    imageInspection: {
      ...persisted.imageInspection,
      repair: {
        method: repaired.method,
        sourceImageUrl: publicUrl,
        transparentPixels: repaired.transparentPixels,
        opaquePixels: repaired.opaquePixels,
      },
    },
  };
}

export async function cleanupGeneratedImages({ referencedUrls = [], maxAgeMs = 7 * 24 * 60 * 60 * 1000, dryRun = false, now = Date.now() } = {}) {
  const directory = imageAssetDir();
  const referenced = new Set(referencedUrls);
  const summary = {
    directory,
    publicPath: imageAssetPublicPath(),
    scanned: 0,
    deleted: [],
    keptReferenced: 0,
    keptFresh: 0,
    skipped: 0,
    dryRun,
  };

  let entries;
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return summary;
    throw error;
  }

  for (const entry of entries) {
    if (!entry.isFile() || !isManagedImageFile(entry.name)) {
      summary.skipped += 1;
      continue;
    }
    summary.scanned += 1;
    const publicUrl = publicUrlForFile(entry.name);
    if (referenced.has(publicUrl)) {
      summary.keptReferenced += 1;
      continue;
    }
    const filePath = path.join(directory, entry.name);
    const stats = await fs.stat(filePath);
    if (now - stats.mtimeMs < maxAgeMs) {
      summary.keptFresh += 1;
      continue;
    }
    if (!dryRun) {
      await fs.unlink(filePath);
    }
    summary.deleted.push({ fileName: entry.name, publicUrl, bytes: stats.size, ageMs: Math.max(0, Math.round(now - stats.mtimeMs)) });
  }

  return summary;
}

export async function deleteManagedGeneratedImage(publicUrl) {
  let fileName;
  try {
    fileName = managedImageFileNameFromUrl(publicUrl);
  } catch {
    return { deleted: false, publicUrl, reason: "unmanaged" };
  }
  const filePath = path.join(imageAssetDir(), fileName);
  try {
    const stats = await fs.stat(filePath);
    await fs.unlink(filePath);
    return { deleted: true, publicUrl, fileName, bytes: stats.size };
  } catch (error) {
    if (error?.code === "ENOENT") {
      return { deleted: false, publicUrl, fileName, reason: "missing" };
    }
    throw error;
  }
}
