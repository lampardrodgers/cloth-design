import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import sharp from "sharp";

const onePixelPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=",
  "base64",
);
const validReferencePng = await sharp({
  create: {
    width: 512,
    height: 512,
    channels: 3,
    background: { r: 102, g: 132, b: 92 },
  },
})
  .png()
  .toBuffer();

function listen(server, port = 0) {
  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () => resolve(server.address().port));
  });
}

function waitForOutput(child, pattern) {
  return new Promise((resolve, reject) => {
    let stderr = "";
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${pattern}\n${stderr}`)), 20000);
    const onData = (chunk) => {
      const text = String(chunk);
      if (pattern.test(text)) {
        clearTimeout(timer);
        child.stdout.off("data", onData);
        resolve();
      }
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
  const setCookies = response.headers.getSetCookie?.() || [];
  for (const item of setCookies) {
    const cookie = item.split(";", 1)[0];
    if (!cookie) continue;
    const name = cookie.split("=", 1)[0];
    jar.set(name, cookie);
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

function jsonBody(value) {
  return {
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(value),
  };
}

async function assertResponse(response, predicate, expected) {
  if (predicate(response) === expected) return;
  throw new Error(await response.text());
}

const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "clothdesign-generate-reference-"));
const imageDir = path.join(tmpDir, "generated-images");
await fs.mkdir(imageDir, { recursive: true });
const managedFile = "11111111-1111-4111-8111-111111111111.png";
await fs.writeFile(path.join(imageDir, managedFile), validReferencePng);

function generatedResultCount(id) {
  const db = new Database(path.join(tmpDir, "app.db"), { readonly: true });
  try {
    return db.prepare("SELECT COUNT(*) AS count FROM generated_result WHERE id = ?").get(id).count;
  } finally {
    db.close();
  }
}

const imageRequests = [];
const fakeImagesApi = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = Buffer.concat(chunks).toString("latin1");
  imageRequests.push({ url: req.url, method: req.method, headers: req.headers, body });
  res.setHeader("content-type", "application/json");
  if (req.url !== "/v1/images/edits") {
    res.statusCode = 500;
    res.end(JSON.stringify({ error: { message: `unexpected endpoint ${req.url}` } }));
    return;
  }
  res.end(JSON.stringify({ data: [{ b64_json: onePixelPng.toString("base64") }] }));
});
const fakeImagesPort = await listen(fakeImagesApi);

const appPort = 19000 + Math.floor(Math.random() * 1000);
const app = spawn(process.execPath, ["server/index.mjs"], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    HOST: "127.0.0.1",
    PORT: String(appPort),
    DATABASE_URL: `file:${path.join(tmpDir, "app.db")}`,
    IMAGE_ASSET_DIR: imageDir,
    IMAGE_ASSET_PUBLIC_PATH: "/generated-images",
    VIDEO_ASSET_DIR: path.join(tmpDir, "generated-videos"),
    VIDEO_ASSET_PUBLIC_PATH: "/generated-videos",
    AUTH_SECRET: "test-generate-reference-secret-1234567890",
    // 这里要验证的是「别人的成片碰不到」，第二个账号得能登录，先关掉注册审批。
    SIGNUP_APPROVAL: "false",
    PUBLIC_APP_URL: `http://127.0.0.1:${appPort}`,
    NODE_ENV: "test",
    PAYMENT_DEMO_MODE: "true",
    ALLOW_PAYMENT_DEMO_API: "true",
    OPENAI_DEMO_MODE: "false",
    OPENAI_API_KEY: "sk-test-generate-reference-key-0000000000",
    OPENAI_BASE_URL: `http://127.0.0.1:${fakeImagesPort}`,
    OPENAI_IMAGE_MODEL: "gpt-image-2",
  },
});

try {
  await waitForOutput(app, /ClothDesign AI running/);
  const baseUrl = `http://127.0.0.1:${appPort}`;
  const jar = new Map();
  let response = await request(baseUrl, jar, "/api/auth/sign-up/email", {
    method: "POST",
    ...jsonBody({ name: "Reference Tester", email: "reference@example.test", password: "clothdesign123" }),
  });
  await assertResponse(response, (item) => item.ok, true);

  response = await request(baseUrl, jar, "/api/payments/orders", {
    method: "POST",
    ...jsonBody({ packageId: "pkg-1", provider: "alipay" }),
  });
  await assertResponse(response, (item) => item.status, 201);
  const order = (await response.json()).order;

  response = await request(baseUrl, jar, `/api/test/payments/${order.id}/complete`, { method: "POST" });
  await assertResponse(response, (item) => item.ok, true);

  const payload = {
    mode: "text",
    action: "generate",
    prompt: "Use the continued reference garment.",
    ratioLabel: "1:1",
    apiSize: "1024x1024",
    settings: {
      quantity: 1,
      quality: "auto",
      background: "auto",
      moderation: "auto",
      outputFormat: "png",
      compression: 100,
      inputFidelity: "high",
      resolution: "native",
    },
    references: [
      {
        id: "ref-managed",
        label: "A",
        role: "style",
        note: "continued result",
        hasFile: false,
        sourceUrl: `/generated-images/${managedFile}`,
      },
    ],
  };
  const form = new FormData();
  form.append("payload", JSON.stringify(payload));
  response = await request(baseUrl, jar, "/api/generate", { method: "POST", body: form });
  await assertResponse(response, (item) => item.ok, true);
  const generated = await response.json();
  assert.equal(generated.credits, 19);
  assert.equal(generated.results[0].qualityGate.status, "rework");
  assert(generated.results[0].qualityGate.warnings.includes("image_too_small"));
  assert(generated.results[0].qualityGate.issues.includes("生成图片尺寸过小，疑似上游坏图或占位图。"));
  assert.equal(generated.results[0].imageInspection.dimensions.width, 1);
  assert.equal(generated.results[0].imageInspection.dimensions.height, 1);
  const db = new Database(path.join(tmpDir, "app.db"), { readonly: true });
  const persistedResult = db
    .prepare("SELECT metadata_json FROM generated_result WHERE task_id = ?")
    .get(generated.taskId);
  db.close();
  const persistedMetadata = JSON.parse(persistedResult.metadata_json);
  assert.equal(persistedMetadata.qualityGate.status, "rework");
  assert.equal(persistedMetadata.imageInspection.dimensions.width, 1);
  assert.equal(persistedMetadata.imageInspection.dimensions.height, 1);
  response = await request(baseUrl, jar, "/api/me");
  await assertResponse(response, (item) => item.ok, true);
  const meAfterGeneration = await response.json();
  assert.equal(meAfterGeneration.generationResults[0].taskId, generated.taskId);
  assert.equal(meAfterGeneration.generationResults[0].qualityGate.status, "rework");
  assert.equal(meAfterGeneration.generationResults[0].imageInspection.dimensions.width, 1);
  response = await request(baseUrl, jar, "/api/admin/overview");
  await assertResponse(response, (item) => item.ok, true);
  const adminOverview = await response.json();
  assert.equal(adminOverview.generationResults[0].taskId, generated.taskId);
  assert.equal(adminOverview.generationResults[0].qualityGate.status, "rework");
  assert.equal(adminOverview.generationResults[0].userId, meAfterGeneration.account.id);
  assert.equal(imageRequests.length, 1);
  assert.equal(imageRequests[0].url, "/v1/images/edits");
  assert.match(imageRequests[0].body, /name="image"/);
  assert.match(imageRequests[0].body, /filename="A\.png"/);
  assert.match(imageRequests[0].body, /Use the continued reference garment/);
  const creditsAfterValidGeneration = generated.account.credits;

  const tinyReferencePayload = {
    ...payload,
    prompt: "This tiny reference must be rejected before image edit.",
    references: [
      {
        id: "ref-tiny",
        label: "C",
        role: "style",
        note: "tiny reference",
        hasFile: false,
        sourceUrl: `data:image/png;base64,${onePixelPng.toString("base64")}`,
      },
    ],
  };
  const tinyForm = new FormData();
  tinyForm.append("payload", JSON.stringify(tinyReferencePayload));
  response = await request(baseUrl, jar, "/api/generate", { method: "POST", body: tinyForm });
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /参考图C尺寸过小/);
  assert.equal(imageRequests.length, 1);

  response = await request(baseUrl, jar, "/api/me");
  await assertResponse(response, (item) => item.ok, true);
  assert.equal((await response.json()).account.credits, creditsAfterValidGeneration);

  const corruptReferencePayload = {
    ...payload,
    prompt: "This corrupt reference must be rejected before image edit.",
    references: [
      {
        id: "ref-corrupt",
        label: "B",
        role: "style",
        note: "corrupt reference",
        hasFile: false,
        sourceUrl: `data:image/png;base64,${Buffer.from("not an image").toString("base64")}`,
      },
    ],
  };
  const corruptForm = new FormData();
  corruptForm.append("payload", JSON.stringify(corruptReferencePayload));
  response = await request(baseUrl, jar, "/api/generate", { method: "POST", body: corruptForm });
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /参考图B不是有效图片文件/);
  assert.equal(imageRequests.length, 1);

  response = await request(baseUrl, jar, "/api/me");
  await assertResponse(response, (item) => item.ok, true);
  assert.equal((await response.json()).account.credits, creditsAfterValidGeneration);

  const generatedResultId = `result-${generated.taskId}-0`;
  response = await request(baseUrl, jar, `/api/generation-results/${generatedResultId}/storage-status`, {
    method: "PATCH",
    ...jsonBody({ storageStatus: "webdav" }),
  });
  await assertResponse(response, (item) => item.ok, true);
  assert.equal((await response.json()).result.storageStatus, "webdav");
  response = await request(baseUrl, jar, "/api/me");
  await assertResponse(response, (item) => item.ok, true);
  assert.equal((await response.json()).generationResults[0].storageStatus, "webdav");

  const generatedFileName = generated.results[0].imageInspection.fileName;
  const generatedFilePath = path.join(imageDir, generatedFileName);
  await fs.access(generatedFilePath);
  const dbForAsset = new Database(path.join(tmpDir, "app.db"));
  dbForAsset
    .prepare(
      `INSERT INTO workflow_asset
        (id, user_id, job_id, kind, name, mime_type, source_url, note, metadata_json, created_at)
       VALUES ('workflow-asset-for-generated-result', ?, NULL, 'result', 'generated reference', 'image/png', ?, 'protect source file', '{}', datetime('now'))`,
    )
    .run(meAfterGeneration.account.id, generated.results[0].imageUrl);
  dbForAsset.close();

  const otherJar = new Map();
  response = await request(baseUrl, otherJar, "/api/auth/sign-up/email", {
    method: "POST",
    ...jsonBody({ name: "Other User", email: "other-reference@example.test", password: "clothdesign123" }),
  });
  await assertResponse(response, (item) => item.ok, true);
  response = await request(baseUrl, otherJar, `/api/generation-results/${generatedResultId}/storage-status`, {
    method: "PATCH",
    ...jsonBody({ storageStatus: "expired" }),
  });
  assert.equal(response.status, 404);
  response = await request(baseUrl, otherJar, `/api/generation-results/${generatedResultId}`, { method: "DELETE" });
  assert.equal(response.status, 404);
  assert.equal(generatedResultCount(generatedResultId), 1);
  await fs.access(generatedFilePath);

  response = await request(baseUrl, jar, `/api/generation-results/${generatedResultId}`, { method: "DELETE" });
  await assertResponse(response, (item) => item.ok, true);
  assert.equal(generatedResultCount(generatedResultId), 0);
  await fs.access(generatedFilePath);
  response = await request(baseUrl, jar, "/api/me");
  await assertResponse(response, (item) => item.ok, true);
  assert.equal((await response.json()).generationResults.length, 0);
} finally {
  app.kill("SIGTERM");
  fakeImagesApi.close();
  await fs.rm(tmpDir, { recursive: true, force: true });
}

console.log(JSON.stringify({ checks: "passed" }, null, 2));
