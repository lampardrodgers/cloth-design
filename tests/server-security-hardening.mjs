import assert from "node:assert/strict";
import http from "node:http";
import { deflateSync } from "node:zlib";

process.env.NODE_ENV = "test";
process.env.IMAGE_MAX_BYTES = "1024";
process.env.IMAGE_MAX_PIXELS = "100";
delete process.env.ALLOW_PRIVATE_OUTBOUND_URLS;

const { assertSafeOutboundUrl, readResponseBufferLimited, safeOutboundFetch } = await import("../server/safe-outbound.mjs");
const { analyzeFabricImageBuffer, validateImageBuffer } = await import("../server/image-provider.mjs");

for (const blocked of [
  "http://localhost/admin",
  "http://127.0.0.1/admin",
  "http://169.254.169.254/latest/meta-data",
  "http://10.1.2.3/internal",
  "http://[::1]/internal",
  "http://[::ffff:127.0.0.1]/internal",
  "http://[fc00::1]/internal",
]) {
  await assert.rejects(() => assertSafeOutboundUrl(blocked), /不能指向本机或内网地址/, blocked);
}
assert.equal((await assertSafeOutboundUrl("https://8.8.8.8/image.png")).hostname, "8.8.8.8", "公网地址仍可使用");
await assert.rejects(() => assertSafeOutboundUrl("file:///etc/passwd"), /只支持 http 或 https/);
await assert.rejects(() => assertSafeOutboundUrl("https://user:pass@example.com/file"), /账号或密码/);

const localControl = http.createServer((_req, res) => res.end("legitimate-control"));
await new Promise((resolve) => localControl.listen(0, "127.0.0.1", resolve));
process.env.ALLOW_PRIVATE_OUTBOUND_URLS = "true";
const controlResponse = await safeOutboundFetch(`http://localhost:${localControl.address().port}/image`);
assert.equal(await controlResponse.text(), "legitimate-control", "开发环境显式许可时，正常外部下载链路保持可用");
await new Promise((resolve) => localControl.close(resolve));

let redirectedAuthorization = "not-called";
const redirectTarget = http.createServer((req, res) => {
  redirectedAuthorization = req.headers.authorization;
  res.end("redirected");
});
await new Promise((resolve) => redirectTarget.listen(0, "127.0.0.1", resolve));
const redirectSource = http.createServer((_req, res) => {
  res.writeHead(302, { location: `http://127.0.0.1:${redirectTarget.address().port}/target` });
  res.end();
});
await new Promise((resolve) => redirectSource.listen(0, "127.0.0.1", resolve));
const redirected = await safeOutboundFetch(`http://127.0.0.1:${redirectSource.address().port}/start`, {
  headers: { Authorization: "Basic must-not-leak" },
});
assert.equal(await redirected.text(), "redirected");
assert.equal(redirectedAuthorization, undefined, "跨域重定向不能泄漏 WebDAV 等认证信息");
await Promise.all([
  new Promise((resolve) => redirectSource.close(resolve)),
  new Promise((resolve) => redirectTarget.close(resolve)),
]);
delete process.env.ALLOW_PRIVATE_OUTBOUND_URLS;
process.env.NODE_ENV = "production";
process.env.ALLOW_PRIVATE_OUTBOUND_URLS = "true";
await assert.rejects(
  () => assertSafeOutboundUrl("http://127.0.0.1/internal"),
  /不能指向本机或内网地址/,
  "生产环境不能用开发开关绕过 SSRF 防护",
);
process.env.NODE_ENV = "test";
delete process.env.ALLOW_PRIVATE_OUTBOUND_URLS;

await assert.rejects(
  () => readResponseBufferLimited(new Response("small", { headers: { "content-length": "100" } }), { maxBytes: 5 }),
  /超过/,
  "声明长度超限时不能开始缓存",
);
await assert.rejects(
  () => readResponseBufferLimited(new Response("123456"), { maxBytes: 5 }),
  /超过/,
  "流式读取也必须执行硬上限",
);
assert.equal((await readResponseBufferLimited(new Response("12345"), { maxBytes: 5 })).toString(), "12345", "上限内下载保持可用");

const onePixel = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=", "base64");
assert.deepEqual(validateImageBuffer(onePixel, "image/png").dimensions, { width: 1, height: 1 });

const oversizedDimensions = Buffer.from(onePixel);
oversizedDimensions.writeUInt32BE(1000, 16);
oversizedDimensions.writeUInt32BE(1000, 20);
assert.throws(() => validateImageBuffer(oversizedDimensions, "image/png"), /像素过大/);
assert.throws(() => validateImageBuffer(Buffer.concat([onePixel, Buffer.alloc(1024)]), "image/png"), /超过 1MB 上限/);

// 1x1 PNG 声称很小，但 IDAT 解压后远大于预期；分析应安全降级，不能展开整块数据。
function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const name = Buffer.from(type);
  const output = Buffer.alloc(data.length + 12);
  output.writeUInt32BE(data.length, 0);
  name.copy(output, 4);
  data.copy(output, 8);
  output.writeUInt32BE(crc32(Buffer.concat([name, data])), data.length + 8);
  return output;
}
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(1, 0);
ihdr.writeUInt32BE(1, 4);
ihdr[8] = 8;
ihdr[9] = 6;
const compressedBomb = Buffer.concat([
  Buffer.from("89504e470d0a1a0a", "hex"),
  chunk("IHDR", ihdr),
  chunk("IDAT", deflateSync(Buffer.alloc(100_000))),
  chunk("IEND", Buffer.alloc(0)),
]);
assert.doesNotThrow(() => analyzeFabricImageBuffer(compressedBomb));

console.log(JSON.stringify({ checks: "passed" }, null, 2));
