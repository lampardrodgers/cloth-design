import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=",
  "base64",
);

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
}

function waitForOutput(child, pattern) {
  return new Promise((resolve, reject) => {
    let stderr = "";
    const timer = setTimeout(() => reject(new Error(`startup timeout\n${stderr}`)), 20000);
    const onData = (chunk) => {
      if (!pattern.test(String(chunk))) return;
      clearTimeout(timer);
      child.stdout.off("data", onData);
      resolve();
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.once("exit", (code) => reject(new Error(`app exited ${code}\n${stderr}`)));
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

function jsonBody(value) {
  return { headers: { "Content-Type": "application/json" }, body: JSON.stringify(value) };
}

const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "clothdesign-apimart-"));
let generationBody = null;
let statusChecks = 0;
let fakePort = 0;
const fakeApi = http.createServer(async (req, res) => {
  if (req.url === "/result.png") {
    res.setHeader("content-type", "image/png");
    res.end(png);
    return;
  }
  res.setHeader("content-type", "application/json");
  if (req.method === "POST" && req.url === "/v1/images/generations") {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    generationBody = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    res.end(JSON.stringify({ code: 200, data: [{ status: "submitted", task_id: "task-apimart-1" }] }));
    return;
  }
  if (req.method === "GET" && req.url === "/v1/tasks/task-apimart-1?language=zh") {
    statusChecks += 1;
    if (statusChecks === 1) {
      res.end(JSON.stringify({ code: 200, data: { id: "task-apimart-1", status: "processing", progress: 50 } }));
      return;
    }
    res.end(JSON.stringify({
      code: 200,
      data: {
        id: "task-apimart-1",
        status: "completed",
        progress: 100,
        result: { images: [{ url: [`http://127.0.0.1:${fakePort}/result.png`] }] },
      },
    }));
    return;
  }
  if (req.method === "GET" && req.url === "/v1/models") {
    res.end(JSON.stringify({ data: [{ id: "gpt-image-2" }] }));
    return;
  }
  res.statusCode = 404;
  res.end(JSON.stringify({ error: { message: "not found" } }));
});
fakePort = await listen(fakeApi);

const appPort = 22150 + Math.floor(Math.random() * 1000);
const app = spawn(process.execPath, ["server/index.mjs"], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    HOST: "127.0.0.1",
    PORT: String(appPort),
    DATABASE_URL: `file:${path.join(tmpDir, "app.db")}`,
    IMAGE_ASSET_DIR: path.join(tmpDir, "generated-images"),
    AUTH_SECRET: "test-apimart-secret-1234567890",
    PUBLIC_APP_URL: `http://127.0.0.1:${appPort}`,
    NODE_ENV: "test",
    PAYMENT_DEMO_MODE: "true",
    ALLOW_PAYMENT_DEMO_API: "true",
    OPENAI_DEMO_MODE: "false",
    OPENAI_API_KEY: "",
    APIMART_API_KEY: "sk-test-apimart-key-0000000000",
    APIMART_BASE_URL: `http://127.0.0.1:${fakePort}/v1`,
    APIMART_IMAGE_MODEL: "gpt-image-2",
  },
});

try {
  await waitForOutput(app, /ClothDesign AI running/);
  const baseUrl = `http://127.0.0.1:${appPort}`;
  const jar = new Map();
  let response = await request(baseUrl, jar, "/api/auth/sign-up/email", {
    method: "POST",
    ...jsonBody({ name: "APIMart Tester", email: "apimart@example.test", password: "clothdesign123" }),
  });
  assert(response.ok);

  response = await request(baseUrl, jar, "/api/payments/orders", {
    method: "POST",
    ...jsonBody({ packageId: "pkg-1", provider: "alipay" }),
  });
  assert.equal(response.status, 201);
  const order = (await response.json()).order;
  response = await request(baseUrl, jar, `/api/test/payments/${order.id}/complete`, { method: "POST" });
  assert(response.ok);

  response = await request(baseUrl, jar, "/api/me/image-provider", {
    method: "PUT",
    ...jsonBody({ providerId: "apimart" }),
  });
  assert(response.ok);
  assert.equal((await response.json()).account.apiProviderId, "apimart");

  const form = new FormData();
  form.append("payload", JSON.stringify({
    mode: "free",
    action: "generate",
    prompt: "APIMart async adapter test",
    ratioLabel: "21:9",
    apiSize: "1536x1024",
    settings: {
      quantity: 1,
      quality: "auto",
      background: "auto",
      moderation: "auto",
      outputFormat: "png",
      compression: 100,
      inputFidelity: "low",
      resolution: "fourK",
    },
    references: [],
  }));
  response = await request(baseUrl, jar, "/api/generate", { method: "POST", body: form });
  assert.equal(response.status, 200);
  const generated = await response.json();
  assert.equal(generated.mode, "live");
  assert.equal(generated.results.length, 1);
  assert.equal(generationBody.model, "gpt-image-2");
  assert.equal(generationBody.size, "21:9");
  assert.equal(generationBody.resolution, "4k");
  assert(statusChecks >= 2, "异步任务应轮询到 completed");
} finally {
  app.kill("SIGTERM");
  fakeApi.close();
  await fs.rm(tmpDir, { recursive: true, force: true });
}

console.log(JSON.stringify({ apimartProvider: "passed" }, null, 2));
