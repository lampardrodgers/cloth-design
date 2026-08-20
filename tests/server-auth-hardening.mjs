import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "clothdesign-auth-hardening-"));
const port = 23500 + Math.floor(Math.random() * 500);
const baseUrl = `http://127.0.0.1:${port}`;

function waitForOutput(child, pattern) {
  return new Promise((resolve, reject) => {
    let stderr = "";
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${pattern}\n${stderr}`)), 20_000);
    const onData = (chunk) => {
      if (!pattern.test(String(chunk))) return;
      clearTimeout(timer);
      child.stdout.off("data", onData);
      resolve();
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", (chunk) => (stderr += String(chunk)));
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

async function request(jar, pathname, init = {}) {
  const headers = new Headers(init.headers || {});
  headers.set("Origin", baseUrl);
  if (jar.size) headers.set("Cookie", [...jar.values()].join("; "));
  const response = await fetch(`${baseUrl}${pathname}`, { ...init, headers });
  appendCookies(jar, response);
  return response;
}

const jsonBody = (value) => ({ headers: { "Content-Type": "application/json" }, body: JSON.stringify(value) });
async function jsonOk(response, expected = 200) {
  const body = await response.json();
  assert.equal(response.status, expected, JSON.stringify(body));
  return body;
}

const app = spawn(process.execPath, ["server/index.mjs"], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    NODE_ENV: "test",
    HOST: "127.0.0.1",
    PORT: String(port),
    PUBLIC_APP_URL: baseUrl,
    DATABASE_URL: `file:${path.join(tmpDir, "app.db")}`,
    IMAGE_ASSET_DIR: path.join(tmpDir, "images"),
    VIDEO_ASSET_DIR: path.join(tmpDir, "videos"),
    AUTH_SECRET: "test-auth-hardening-secret-1234567890",
    DEBUG_UNLIMITED: "false",
    ALLOW_SELF_SIGNUP: "true",
    SIGNUP_APPROVAL: "false",
    OPENAI_DEMO_MODE: "true",
    PAYMENT_DEMO_MODE: "true",
    ALLOW_PAYMENT_DEMO_API: "true",
  },
});

try {
  await waitForOutput(app, /ClothDesign AI running/);

  // 未登录时先返回 401；大 JSON 和 multipart 解析器都不应获得请求体。
  let response = await request(new Map(), "/api/admin/users", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{",
  });
  assert.equal(response.status, 401);
  response = await request(new Map(), "/api/generate", {
    method: "POST",
    headers: { "Content-Type": "multipart/form-data; boundary=malformed" },
    body: "not-a-valid-multipart-body",
  });
  assert.equal(response.status, 401);

  const admin = new Map();
  await jsonOk(
    await request(admin, "/api/auth/sign-up/email", {
      method: "POST",
      ...jsonBody({ name: "Owner", email: "owner@example.test", password: "clothdesign123" }),
    }),
  );
  assert.equal((await jsonOk(await request(admin, "/api/me"))).account.role, "owner");

  // 登录后的坏 JSON 仍由解析器正常拒绝，证明合法链路没有被移除。
  response = await request(admin, "/api/admin/users", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{",
  });
  assert.equal(response.status, 400);

  const created = await jsonOk(
    await request(admin, "/api/admin/users", {
      method: "POST",
      ...jsonBody({ username: "session-user", password: "clothdesign123" }),
    }),
    201,
  );
  const userId = created.user.id;
  const user = new Map();
  await jsonOk(
    await request(user, "/api/auth/sign-in/email", {
      method: "POST",
      ...jsonBody({ email: "session-user@clothdesign.local", password: "clothdesign123" }),
    }),
  );
  assert.equal((await jsonOk(await request(user, "/api/me"))).account.id, userId);

  await jsonOk(
    await request(admin, `/api/admin/users/${userId}/password`, {
      method: "POST",
      ...jsonBody({ password: "new-password-123" }),
    }),
  );
  assert.equal((await request(user, "/api/me")).status, 401, "改密码后旧 Session 必须失效");

  const relogged = new Map();
  await jsonOk(
    await request(relogged, "/api/auth/sign-in/email", {
      method: "POST",
      ...jsonBody({ email: "session-user@clothdesign.local", password: "new-password-123" }),
    }),
  );
  assert.equal((await jsonOk(await request(relogged, "/api/me"))).account.id, userId, "新密码仍可正常登录");

  await jsonOk(
    await request(admin, `/api/admin/users/${userId}`, {
      method: "PATCH",
      ...jsonBody({ status: "locked" }),
    }),
  );
  assert.equal((await request(relogged, "/api/me")).status, 401, "锁定账号后旧 Session 必须失效");
} finally {
  app.kill("SIGTERM");
  await new Promise((resolve) => app.once("exit", resolve));
  await fs.rm(tmpDir, { recursive: true, force: true });
}

console.log(JSON.stringify({ checks: "passed" }, null, 2));
