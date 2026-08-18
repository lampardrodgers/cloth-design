import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";

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

const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "clothdesign-generate-timeout-"));
const imageRequests = [];
const fakeImagesApi = http.createServer(async (req) => {
  imageRequests.push({ url: req.url, method: req.method });
  for await (const _chunk of req) {
    // Drain the request body, then intentionally never respond.
  }
});
const fakeImagesPort = await listen(fakeImagesApi);

const appPort = 22200 + Math.floor(Math.random() * 1000);
const appEnv = {
    ...process.env,
    HOST: "127.0.0.1",
    PORT: String(appPort),
    DATABASE_URL: `file:${path.join(tmpDir, "app.db")}`,
    IMAGE_ASSET_DIR: path.join(tmpDir, "generated-images"),
    IMAGE_ASSET_PUBLIC_PATH: "/generated-images",
    VIDEO_ASSET_DIR: path.join(tmpDir, "generated-videos"),
    VIDEO_ASSET_PUBLIC_PATH: "/generated-videos",
    AUTH_SECRET: "test-generate-timeout-secret-1234567890",
    PUBLIC_APP_URL: `http://127.0.0.1:${appPort}`,
    NODE_ENV: "test",
    PAYMENT_DEMO_MODE: "true",
    ALLOW_PAYMENT_DEMO_API: "true",
    OPENAI_DEMO_MODE: "false",
    OPENAI_API_KEY: "sk-test-generate-timeout-key-0000000000",
    OPENAI_BASE_URL: `http://127.0.0.1:${fakeImagesPort}`,
    OPENAI_IMAGE_MODEL: "gpt-image-2",
    OPENAI_IMAGE_TIMEOUT_MS: "100",
};

const dbPath = path.join(tmpDir, "app.db");
const readTask = (id) => {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db.prepare("SELECT id, status, message, credits FROM generation_task WHERE id = ?").get(id);
  } finally {
    db.close();
  }
};
const latestTask = () => {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db.prepare("SELECT id, status, message, credits, key_source FROM generation_task ORDER BY created_at DESC LIMIT 1").get();
  } finally {
    db.close();
  }
};

let app = spawn(process.execPath, ["server/index.mjs"], { cwd: process.cwd(), env: { ...process.env, ...appEnv } });

try {
  await waitForOutput(app, /ClothDesign AI running/);
  const baseUrl = `http://127.0.0.1:${appPort}`;
  const jar = new Map();

  let response = await request(baseUrl, jar, "/api/auth/sign-up/email", {
    method: "POST",
    ...jsonBody({ name: "Timeout Tester", email: "timeout@example.test", password: "clothdesign123" }),
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
    prompt: "A timeout test garment image.",
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
  response = await request(baseUrl, jar, "/api/generate", {
    method: "POST",
    body: form,
    signal: AbortSignal.timeout(1500),
  });
  assert.equal(response.status, 500);
  assert.match((await response.json()).error, /超时/);
  assert.equal(imageRequests.length, 1);

  response = await request(baseUrl, jar, "/api/me");
  await assertResponse(response, (item) => item.ok, true);
  assert.equal((await response.json()).account.credits, 300);

  // 失败必须落到任务记录上，否则后台永远显示「运行中」，看着像还在跑。
  const serverKeyTask = latestTask();
  assert.equal(serverKeyTask.status, "failed", `扣了积分的任务失败后要标记失败：${JSON.stringify(serverKeyTask)}`);
  assert.match(serverKeyTask.message, /超时/);
  assert.match(serverKeyTask.message, /积分已退回/);

  // 自备 Key 的账号 cost 恒为 0：以前退款和状态落库写在一起，这类任务失败后永远停在「运行中」。
  response = await request(baseUrl, jar, "/api/me/api-key", {
    method: "PUT",
    ...jsonBody({ apiKey: "sk-user-own-key-000000000000000000" }),
  });
  await assertResponse(response, (item) => item.ok, true);

  const ownKeyForm = new FormData();
  ownKeyForm.append("payload", JSON.stringify(payload));
  response = await request(baseUrl, jar, "/api/generate", {
    method: "POST",
    body: ownKeyForm,
    signal: AbortSignal.timeout(1500),
  });
  assert.equal(response.status, 500);
  const ownKeyTask = latestTask();
  assert.equal(ownKeyTask.key_source, "user");
  assert.equal(ownKeyTask.credits, 0);
  assert.equal(ownKeyTask.status, "failed", `自备 Key 的任务失败后也要标记失败：${JSON.stringify(ownKeyTask)}`);
  assert.match(ownKeyTask.message, /超时/);
  assert.doesNotMatch(ownKeyTask.message, /积分/, "没扣积分就别说退款");

  // 进程重启会把手上正在跑的请求一起带走：启动时要把残留的「运行中」收口成失败。
  app.kill("SIGTERM");
  await new Promise((resolve) => app.once("exit", resolve));
  const stuckId = ownKeyTask.id;
  const writable = new Database(dbPath);
  writable.prepare("UPDATE generation_task SET status = 'running', message = '生成中' WHERE id = ?").run(stuckId);
  writable.close();
  assert.equal(readTask(stuckId).status, "running");

  app = spawn(process.execPath, ["server/index.mjs"], { cwd: process.cwd(), env: { ...process.env, ...appEnv } });
  await waitForOutput(app, /ClothDesign AI running/);
  const revived = readTask(stuckId);
  assert.equal(revived.status, "failed", "重启后残留的运行中任务要收口成失败");
  assert.match(revived.message, /重启/);
} finally {
  app.kill("SIGTERM");
  fakeImagesApi.closeAllConnections?.();
  fakeImagesApi.close();
  await fs.rm(tmpDir, { recursive: true, force: true });
}

console.log(JSON.stringify({ checks: "passed" }, null, 2));
