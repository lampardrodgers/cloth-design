/**
 * 分辨率上限：线路能出到几 K，账号就只能开到几 K。
 *
 * Packy / OpenAI 兼容线路没有 resolution 这个参数，出图恒定是 1024/1536 那一档，
 * 以前界面照样让人点 4K，还按 1.9 倍收积分——图没变清楚，钱多扣了。
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const onePixelPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=",
  "base64",
);

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

function waitForOutput(child, pattern) {
  return new Promise((resolve, reject) => {
    let stderr = "";
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${pattern}\n${stderr}`)), 20000);
    const onData = (chunk) => {
      if (!pattern.test(String(chunk))) return;
      clearTimeout(timer);
      child.stdout.off("data", onData);
      resolve();
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`App exited before startup: ${code}\n${stderr}`));
    });
  });
}

function appendCookies(jar, response) {
  for (const item of response.headers.getSetCookie?.() || []) {
    const cookie = item.split(";", 1)[0];
    if (cookie) jar.set(cookie.split("=", 1)[0], cookie);
  }
}

async function request(baseUrl, jar, pathname, init = {}) {
  const headers = new Headers(init.headers || {});
  headers.set("Origin", baseUrl);
  if (jar.size) headers.set("Cookie", [...jar.values()].join("; "));
  const response = await fetch(`${baseUrl}${pathname}`, { ...init, headers });
  appendCookies(jar, response);
  return response;
}

/** 只在失败时才读 body：成功路径要把 body 留给后面的 json()。 */
async function assertOk(response, expectedStatus = 200) {
  if (response.status === expectedStatus) return response;
  throw new Error(`${response.status}: ${await response.text()}`);
}

function jsonBody(value) {
  return { headers: { "Content-Type": "application/json" }, body: JSON.stringify(value) };
}

function generatePayload(resolution) {
  return {
    mode: "text",
    action: "generate",
    prompt: `分辨率上限测试 ${resolution}`,
    ratioLabel: "1:1",
    apiSize: "1024x1024",
    settings: {
      quantity: 1,
      quality: "auto",
      background: "auto",
      moderation: "auto",
      outputFormat: "png",
      compression: 100,
      inputFidelity: "low",
      resolution,
    },
    references: [],
  };
}

const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "clothdesign-resolution-"));
const imageRequests = [];
const fakeImagesApi = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  imageRequests.push({ url: req.url, body: Buffer.concat(chunks).toString("latin1") });
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ data: [{ b64_json: onePixelPng.toString("base64") }] }));
});
const fakeImagesPort = await listen(fakeImagesApi);

const appPort = 21950 + Math.floor(Math.random() * 500);
const app = spawn(process.execPath, ["server/index.mjs"], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    HOST: "127.0.0.1",
    PORT: String(appPort),
    DATABASE_URL: `file:${path.join(tmpDir, "app.db")}`,
    IMAGE_ASSET_DIR: path.join(tmpDir, "generated-images"),
    IMAGE_ASSET_PUBLIC_PATH: "/generated-images",
    VIDEO_ASSET_DIR: path.join(tmpDir, "generated-videos"),
    VIDEO_ASSET_PUBLIC_PATH: "/generated-videos",
    AUTH_SECRET: "test-resolution-limits-secret-1234567890",
    PUBLIC_APP_URL: `http://127.0.0.1:${appPort}`,
    NODE_ENV: "test",
    PAYMENT_DEMO_MODE: "true",
    ALLOW_PAYMENT_DEMO_API: "true",
    OPENAI_DEMO_MODE: "false",
    OPENAI_API_KEY: "sk-test-resolution-limits-0000000000",
    OPENAI_BASE_URL: `http://127.0.0.1:${fakeImagesPort}`,
    OPENAI_IMAGE_MODEL: "gpt-image-2",
    APIMART_BASE_URL: `http://127.0.0.1:${fakeImagesPort}`,
    APIMART_IMAGE_MODEL: "gpt-image-2",
  },
});

try {
  await waitForOutput(app, /ClothDesign AI running/);
  const baseUrl = `http://127.0.0.1:${appPort}`;
  const jar = new Map();

  let response = await request(baseUrl, jar, "/api/auth/sign-up/email", {
    method: "POST",
    ...jsonBody({ name: "Resolution Tester", email: "resolution@example.test", password: "clothdesign123" }),
  });
  await assertOk(response);

  response = await request(baseUrl, jar, "/api/payments/orders", { method: "POST", ...jsonBody({ packageId: "pkg-1", provider: "alipay" }) });
  await assertOk(response, 201);
  const order = (await response.json()).order;
  response = await request(baseUrl, jar, `/api/test/payments/${order.id}/complete`, { method: "POST" });
  await assertOk(response);
  const account = (await response.json()).account;
  assert.equal(account.credits, 300);
  const userId = account.id;

  /* ── 账号能力随线路下发 ─────────────────────────────────────────────────── */
  response = await request(baseUrl, jar, "/api/me");
  let me = (await response.json()).account;
  assert.equal(me.apiProviderProtocol, "openai");
  assert.equal(me.maxResolution, "native", "Packy 线路只出 1K");
  assert.equal(me.maxResolutionSource, "provider", "上限来自线路本身，不是后台压的");
  assert.equal(me.maxResolutionSetting, "", "后台没设过就该是空");

  /* ── 4K 请求在这条线路上被裁回 1K，也不能按 4K 计费 ─────────────────────── */
  const nativeForm = new FormData();
  nativeForm.append("payload", JSON.stringify(generatePayload("native")));
  response = await request(baseUrl, jar, "/api/generate", { method: "POST", body: nativeForm });
  await assertOk(response);
  const nativeCost = (await response.json()).credits;
  assert(nativeCost > 0);

  const fourKForm = new FormData();
  fourKForm.append("payload", JSON.stringify(generatePayload("fourK")));
  response = await request(baseUrl, jar, "/api/generate", { method: "POST", body: fourKForm });
  await assertOk(response);
  const fourKBody = await response.json();
  assert.equal(fourKBody.credits, nativeCost, "线路出不了 4K，就不能按 4K 的倍率扣积分");
  assert.equal(fourKBody.account.credits, 300 - nativeCost * 2);
  assert.equal(imageRequests.length, 2);

  /* ── 换成 APIMart：2K / 4K 才真的开放 ───────────────────────────────────── */
  response = await request(baseUrl, jar, "/api/me/image-provider", { method: "PUT", ...jsonBody({ providerId: "apimart" }) });
  await assertOk(response);
  response = await request(baseUrl, jar, "/api/me");
  me = (await response.json()).account;
  assert.equal(me.apiProviderProtocol, "apimart");
  assert.equal(me.maxResolution, "fourK");

  /* ── 后台按账号往下压 ───────────────────────────────────────────────────── */
  response = await request(baseUrl, jar, `/api/admin/users/${userId}`, { method: "PATCH", ...jsonBody({ maxResolutionSetting: "hd" }) });
  await assertOk(response);
  const patched = (await response.json()).user;
  assert.equal(patched.maxResolution, "hd");
  assert.equal(patched.maxResolutionSetting, "hd");
  assert.equal(patched.maxResolutionSource, "account");

  response = await request(baseUrl, jar, "/api/me");
  me = (await response.json()).account;
  assert.equal(me.maxResolution, "hd", "后台设了 2K，账户侧要立刻跟上");
  assert.equal(me.maxResolutionSource, "account");

  response = await request(baseUrl, jar, `/api/admin/users/${userId}`, { method: "PATCH", ...jsonBody({ maxResolutionSetting: "8k" }) });
  assert.equal(response.status, 400, "没有的档位要挡住");

  /* ── 账号上限只能压低，不能把线路顶不动的档位顶上去 ─────────────────────── */
  response = await request(baseUrl, jar, `/api/admin/users/${userId}`, { method: "PATCH", ...jsonBody({ maxResolutionSetting: "fourK", apiProviderId: "default" }) });
  await assertOk(response);
  const raised = (await response.json()).user;
  assert.equal(raised.maxResolution, "native", "回到 Packy 线路，后台设了 4K 也只能出 1K");
  assert.equal(raised.maxResolutionSource, "provider");

  /* ── 清空恢复成「跟随线路」 ─────────────────────────────────────────────── */
  response = await request(baseUrl, jar, `/api/admin/users/${userId}`, { method: "PATCH", ...jsonBody({ maxResolutionSetting: "" }) });
  await assertOk(response);
  assert.equal((await response.json()).user.maxResolutionSetting, "");
} finally {
  app.kill("SIGTERM");
  fakeImagesApi.close();
  await fs.rm(tmpDir, { recursive: true, force: true });
}

console.log(JSON.stringify({ resolutionLimits: "passed" }, null, 2));
