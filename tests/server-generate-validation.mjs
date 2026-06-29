import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";

const onePixelPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=",
  "base64",
);

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
    jar.set(cookie.split("=", 1)[0], cookie);
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

async function waitForWorkflowJob(baseUrl, jar, id) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const response = await request(baseUrl, jar, `/api/workflows/jobs/${encodeURIComponent(id)}`);
    assert.equal(response.status, 200);
    const { job } = await response.json();
    if (job.status !== "running") return job;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Workflow job did not finish: ${id}`);
}

const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "clothdesign-generate-validation-"));
const largeWorkflowPng = await sharp({
  create: {
    width: 900,
    height: 900,
    channels: 4,
    background: { r: 238, g: 225, b: 206, alpha: 1 },
  },
})
  .png({ compressionLevel: 0, adaptiveFiltering: false })
  .toBuffer();
assert(largeWorkflowPng.length > 2 * 1024 * 1024);
const imageRequests = [];
const fakeImagesApi = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = Buffer.concat(chunks).toString("latin1");
  imageRequests.push({ url: req.url, method: req.method, body });
  res.setHeader("content-type", "application/json");
  if (body.includes("Return empty image result")) {
    res.end(JSON.stringify({ data: [] }));
    return;
  }
  if (body.includes("Return usage limit")) {
    res.statusCode = 429;
    res.end(
      JSON.stringify({
        error: {
          type: "usage_limit_reached",
          message: "The usage limit has been reached",
          resets_at: 1782721841,
        },
      }),
    );
    return;
  }
  res.end(JSON.stringify({ data: [{ b64_json: onePixelPng.toString("base64") }] }));
});
const fakeImagesPort = await listen(fakeImagesApi);

const appPort = 21150 + Math.floor(Math.random() * 1000);
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
    AUTH_SECRET: "test-generate-validation-secret-1234567890",
    PUBLIC_APP_URL: `http://127.0.0.1:${appPort}`,
    NODE_ENV: "test",
    PAYMENT_DEMO_MODE: "true",
    ALLOW_PAYMENT_DEMO_API: "true",
    OPENAI_DEMO_MODE: "false",
    OPENAI_API_KEY: "sk-test-generate-validation-key-0000000000",
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
    ...jsonBody({ name: "Validation Tester", email: "validation@example.test", password: "clothdesign123" }),
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
  assert.equal((await response.json()).account.credits, 300);

  const payload = {
    mode: "text",
    action: "generate",
    prompt: "   \n\t  ",
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
      resolution: "native",
    },
    references: [],
  };
  const form = new FormData();
  form.append("payload", JSON.stringify(payload));
  response = await request(baseUrl, jar, "/api/generate", { method: "POST", body: form });
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /提示词/);
  assert.equal(imageRequests.length, 0);

  response = await request(baseUrl, jar, "/api/me");
  await assertResponse(response, (item) => item.ok, true);
  assert.equal((await response.json()).account.credits, 300);

  const emptyResultPayload = {
    ...payload,
    prompt: "Return empty image result",
  };
  const emptyResultForm = new FormData();
  emptyResultForm.append("payload", JSON.stringify(emptyResultPayload));
  response = await request(baseUrl, jar, "/api/generate", { method: "POST", body: emptyResultForm });
  assert.equal(response.status, 500);
  assert.match((await response.json()).error, /图像引擎没有返回图片/);
  assert.equal(imageRequests.length, 1);

  response = await request(baseUrl, jar, "/api/me");
  await assertResponse(response, (item) => item.ok, true);
  assert.equal((await response.json()).account.credits, 300);

  response = await request(baseUrl, jar, "/api/workflows/jobs", {
    method: "POST",
    ...jsonBody({
      type: "fabric-to-style",
      title: "Large fabric asset",
      prompt: "大尺寸面料图应该能进入真实 image edit 工作流。",
      assets: [
        {
          kind: "fabric",
          name: "large-fabric.png",
          mimeType: "image/png",
          sourceUrl: `data:image/png;base64,${largeWorkflowPng.toString("base64")}`,
          note: "large valid fabric source",
        },
      ],
      options: { variants: 1, garmentCategory: "dress" },
    }),
  });
  assert.equal(response.status, 201);
  const createdLargeWorkflowJob = (await response.json()).job;
  assert.equal(createdLargeWorkflowJob.status, "running");
  const largeWorkflowJob = await waitForWorkflowJob(baseUrl, jar, createdLargeWorkflowJob.id);
  assert.equal(largeWorkflowJob.status, "success");
  assert.equal(largeWorkflowJob.results[0].metadata.generationMode, "image_edit");
  assert.equal(largeWorkflowJob.results[0].metadata.assetInputNames[0], "large-fabric.png");
  assert.equal(imageRequests.length, 2);

  const usageLimitPayload = {
    ...payload,
    prompt: "Return usage limit",
  };
  const usageLimitForm = new FormData();
  usageLimitForm.append("payload", JSON.stringify(usageLimitPayload));
  response = await request(baseUrl, jar, "/api/generate", { method: "POST", body: usageLimitForm });
  assert.equal(response.status, 500);
  const usageLimitError = (await response.json()).error;
  assert.match(usageLimitError, /usage_limit_reached/);
  assert.match(usageLimitError, /resets_at=1782721841/);
  assert.equal(imageRequests.length, 3);

  response = await request(baseUrl, jar, "/api/config");
  await assertResponse(response, (item) => item.ok, true);
  const config = await response.json();
  assert.equal(config.providerHealth.status, "usage_limited");
  assert.equal(config.providerHealth.resetAt, "2026-06-29T08:30:41.000Z");

  response = await request(baseUrl, jar, "/api/me");
  await assertResponse(response, (item) => item.ok, true);
  assert.equal((await response.json()).account.credits, 300);
} finally {
  app.kill("SIGTERM");
  fakeImagesApi.close();
  await fs.rm(tmpDir, { recursive: true, force: true });
}

console.log(JSON.stringify({ checks: "passed" }, null, 2));
