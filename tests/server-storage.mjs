import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import sharp from "sharp";

/**
 * 文件管理三件事的服务端验证：
 *   1. 成片落库即「服务器暂存」，带 3 天到期时间；
 *   2. 账号自己的 WebDAV：保存配置（密码只存密文、不回传）、测试连接、手动归档、自动归档，
 *      对着一个假的 WebDAV 服务核对 MKCOL / PUT 的路径、鉴权和字节；
 *   3. 巡检：过期的成片删文件、标 expired，云盘备份路径还在。
 */

const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "clothdesign-storage-"));
process.env.DATABASE_URL = `file:${path.join(tmpDir, "unit.db")}`;
process.env.AUTH_SECRET = "storage-unit-secret-1234567890";
const { normalizeWebdavUrl, normalizeWebdavDirectory, archiveRemotePath, resultExpiresAt, SERVER_RETENTION_DAYS } = await import(
  "../server/storage.mjs"
);

// ---------- 纯函数 ----------
assert.equal(SERVER_RETENTION_DAYS, 3, "服务器暂存写死 3 天");
assert.equal(resultExpiresAt("2026-08-17T00:00:00.000Z"), "2026-08-20T00:00:00.000Z");
assert.equal(normalizeWebdavUrl(" https://dav.jianguoyun.com/dav/ ").value, "https://dav.jianguoyun.com/dav");
assert.match(normalizeWebdavUrl("ftp://x").error, /http/);
assert.match(normalizeWebdavUrl("not a url").error, /合法/);
assert.equal(normalizeWebdavUrl("").value, "", "空地址允许（表示没配）");
assert.equal(normalizeWebdavDirectory("").value, "ClothDesign");
assert.equal(normalizeWebdavDirectory("/我的设计/成片/").value, "我的设计/成片");
assert.match(normalizeWebdavDirectory("a/../b").error, /\.\./);
assert.equal(
  archiveRemotePath({ id: "result-abc123-0", title: "text-1530-1", created_at: "2026-08-17T07:30:00.000Z" }, "ClothDesign", "png"),
  "ClothDesign/2026-08-17/text-1530-1-bc1230.png",
);
assert.equal(
  archiveRemotePath({ id: "result-x", title: 'bad/name:*?"<>|', created_at: "2026-08-17T07:30:00.000Z" }, "dir", "jpg"),
  "dir/2026-08-17/bad-name-esultx.jpg",
);

// ---------- 起真实服务 + 假图像接口 + 假 WebDAV ----------
const validPng = await sharp({ create: { width: 512, height: 512, channels: 3, background: { r: 120, g: 90, b: 60 } } })
  .png()
  .toBuffer();

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
}

function waitForOutput(child, pattern) {
  return new Promise((resolve, reject) => {
    let stderr = "";
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${pattern}\n${stderr}`)), 20000);
    const onData = (chunk) => {
      if (pattern.test(String(chunk))) {
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

const jsonBody = (value) => ({ headers: { "Content-Type": "application/json" }, body: JSON.stringify(value) });

async function expectOk(response) {
  if (response.ok) return response.json();
  throw new Error(`${response.status} ${await response.text()}`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const imageDir = path.join(tmpDir, "generated-images");
await fs.mkdir(imageDir, { recursive: true });

const fakeImagesApi = http.createServer(async (req, res) => {
  for await (const _ of req) void _;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ data: [{ b64_json: validPng.toString("base64") }] }));
});
const fakeImagesPort = await listen(fakeImagesApi);

// 假 WebDAV：要求 Basic 鉴权 dav-user / app-password；记录每个请求
const davRequests = [];
const davFiles = new Map();
const davDirs = new Set(["/dav"]);
const goodAuth = `Basic ${Buffer.from("dav-user:app-password").toString("base64")}`;
const fakeDav = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = Buffer.concat(chunks);
  davRequests.push({ method: req.method, url: decodeURIComponent(req.url), auth: req.headers.authorization, bytes: body.length });
  if (req.headers.authorization !== goodAuth) {
    res.statusCode = 401;
    res.end();
    return;
  }
  const url = decodeURIComponent(req.url).replace(/\/+$/, "");
  if (req.method === "PROPFIND") {
    res.statusCode = davDirs.has(url) || davFiles.has(url) ? 207 : 404;
    res.end();
    return;
  }
  if (req.method === "MKCOL") {
    if (davDirs.has(url)) {
      res.statusCode = 405;
    } else if (!davDirs.has(path.posix.dirname(url))) {
      res.statusCode = 409;
    } else {
      davDirs.add(url);
      res.statusCode = 201;
    }
    res.end();
    return;
  }
  if (req.method === "PUT") {
    if (!davDirs.has(path.posix.dirname(url))) {
      res.statusCode = 409;
      res.end();
      return;
    }
    davFiles.set(url, body);
    res.statusCode = 201;
    res.end();
    return;
  }
  res.statusCode = 405;
  res.end();
});
const fakeDavPort = await listen(fakeDav);
const davBase = `http://127.0.0.1:${fakeDavPort}/dav`;

const appPort = 21000 + Math.floor(Math.random() * 1000);
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
    AUTH_SECRET: "test-storage-secret-1234567890",
    SIGNUP_APPROVAL: "false",
    PUBLIC_APP_URL: `http://127.0.0.1:${appPort}`,
    NODE_ENV: "test",
    PAYMENT_DEMO_MODE: "true",
    ALLOW_PAYMENT_DEMO_API: "true",
    OPENAI_DEMO_MODE: "false",
    OPENAI_API_KEY: "sk-test-storage-key-0000000000",
    OPENAI_BASE_URL: `http://127.0.0.1:${fakeImagesPort}`,
    OPENAI_IMAGE_MODEL: "gpt-image-2",
    WEBDAV_TIMEOUT_MS: "5000",
    ALLOW_PRIVATE_OUTBOUND_URLS: "true",
  },
});

const payload = {
  mode: "text",
  action: "generate",
  prompt: "storage test",
  ratioLabel: "1:1",
  apiSize: "1024x1024",
  settings: { quantity: 1, quality: "auto", background: "auto", moderation: "auto", outputFormat: "png", compression: 100, inputFidelity: "high", resolution: "native" },
  references: [],
};

async function generateOnce(baseUrl, jar) {
  const form = new FormData();
  form.append("payload", JSON.stringify(payload));
  const generated = await expectOk(await request(baseUrl, jar, "/api/generate", { method: "POST", body: form }));
  return { taskId: generated.taskId, resultId: `result-${generated.taskId}-0`, imageUrl: generated.results[0].imageUrl };
}

try {
  await waitForOutput(app, /ClothDesign AI running/);
  const baseUrl = `http://127.0.0.1:${appPort}`;
  const jar = new Map();
  await expectOk(
    await request(baseUrl, jar, "/api/auth/sign-up/email", {
      method: "POST",
      ...jsonBody({ name: "Storage Tester", email: "storage@example.test", password: "clothdesign123" }),
    }),
  );
  // 第一个真实账号是 owner，能调后台巡检接口
  const me = await expectOk(await request(baseUrl, jar, "/api/me"));
  assert.equal(me.account.role, "owner");
  const order = (await expectOk(await request(baseUrl, jar, "/api/payments/orders", { method: "POST", ...jsonBody({ packageId: "pkg-2", provider: "alipay" }) }))).order;
  await expectOk(await request(baseUrl, jar, `/api/test/payments/${order.id}/complete`, { method: "POST" }));

  const config = await expectOk(await request(baseUrl, jar, "/api/config"));
  assert.equal(config.storageRetentionDays, 3, "/api/config 要告诉前端服务器保留天数");

  // 1) 生成一张：服务器暂存 + 到期时间
  const first = await generateOnce(baseUrl, jar);
  let storage = await expectOk(await request(baseUrl, jar, "/api/me/storage"));
  assert.equal(storage.overview.active, 1);
  assert.equal(storage.overview.settings.webdavEnabled, false);
  assert.equal(storage.results[0].storageStatus, "cloud-temp");
  assert.equal(Date.parse(storage.results[0].expiresAt) - Date.parse(storage.results[0].createdAt), 3 * 24 * 60 * 60 * 1000);

  // 2) 配 WebDAV：先错密码测连接失败，再对
  let test = await expectOk(
    await request(baseUrl, jar, "/api/me/storage/webdav/test", {
      method: "POST",
      ...jsonBody({ webdavUrl: davBase, webdavUsername: "dav-user", webdavPassword: "wrong", webdavDirectory: "Cloth/成片" }),
    }),
  );
  assert.equal(test.ok, false);
  assert.match(test.message, /账号或密码不对/);
  test = await expectOk(
    await request(baseUrl, jar, "/api/me/storage/webdav/test", {
      method: "POST",
      ...jsonBody({ webdavUrl: davBase, webdavUsername: "dav-user", webdavPassword: "app-password", webdavDirectory: "Cloth/成片" }),
    }),
  );
  assert.equal(test.ok, true, test.message);
  assert(davDirs.has("/dav/Cloth/成片"), "测试连接要把目标目录建出来");

  // 启用时缺密码要被拦
  let response = await request(baseUrl, jar, "/api/me/storage/webdav", {
    method: "PUT",
    ...jsonBody({ webdavUrl: davBase, webdavUsername: "dav-user", webdavDirectory: "Cloth/成片", webdavEnabled: true }),
  });
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /密码/);

  const saved = await expectOk(
    await request(baseUrl, jar, "/api/me/storage/webdav", {
      method: "PUT",
      ...jsonBody({ webdavUrl: davBase, webdavUsername: "dav-user", webdavPassword: "app-password", webdavDirectory: "Cloth/成片", webdavEnabled: true, autoArchive: false }),
    }),
  );
  assert.equal(saved.overview.settings.webdavEnabled, true);
  assert.equal(saved.overview.settings.hasPassword, true);
  assert.equal(saved.overview.settings.autoArchive, false);
  assert.equal(JSON.stringify(saved).includes("app-password"), false, "密码不能回传");
  {
    const db = new Database(path.join(tmpDir, "app.db"), { readonly: true });
    const row = db.prepare("SELECT webdav_password_encrypted FROM user_storage WHERE user_id = ?").get(me.account.id);
    db.close();
    assert.match(row.webdav_password_encrypted, /^v1:/, "密码要加密落库");
    assert(!row.webdav_password_encrypted.includes("app-password"));
  }

  // 3) 手动归档：MKCOL 到日期目录 + PUT 原文件字节
  davRequests.length = 0;
  const archived = await expectOk(await request(baseUrl, jar, `/api/generation-results/${first.resultId}/archive`, { method: "POST" }));
  assert.equal(archived.result.storageStatus, "webdav");
  assert.match(archived.result.archivePath, /^Cloth\/成片\/\d{4}-\d{2}-\d{2}\/text-\d{4}-1-[a-z0-9]+\.png$/);
  const put = davRequests.find((item) => item.method === "PUT");
  assert(put, "要真的 PUT 到 WebDAV");
  assert.equal(put.url, `/dav/${archived.result.archivePath}`);
  assert.equal(put.auth, goodAuth);
  const localBytes = await fs.readFile(path.join(imageDir, path.basename(first.imageUrl)));
  assert.equal(put.bytes, localBytes.length, "上传的字节数要和服务器上的原文件一致");
  assert(davRequests.some((item) => item.method === "MKCOL" && item.url === `/dav/${path.posix.dirname(archived.result.archivePath)}`), "要先建日期目录");
  storage = await expectOk(await request(baseUrl, jar, "/api/me/storage"));
  assert.equal(storage.overview.archived, 1);
  assert.equal(storage.overview.settings.lastError, null);

  // 4) 自动归档：开关打开后，生成完成片自动推上去
  await expectOk(await request(baseUrl, jar, "/api/me/storage/webdav", { method: "PUT", ...jsonBody({ autoArchive: true }) }));
  const putBefore = davRequests.filter((item) => item.method === "PUT").length;
  const second = await generateOnce(baseUrl, jar);
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (davRequests.filter((item) => item.method === "PUT").length > putBefore) break;
    await sleep(100);
  }
  assert.equal(davRequests.filter((item) => item.method === "PUT").length, putBefore + 1, "自动归档要在生成后触发一次 PUT");
  storage = await expectOk(await request(baseUrl, jar, "/api/me/storage"));
  assert.equal(storage.results.find((item) => item.id === second.resultId).storageStatus, "webdav");
  assert.equal(storage.overview.archived, 2);

  // 5) 云盘挂了：手动归档报错，last_error 记下来，成片状态不变
  fakeDav.removeAllListeners("request");
  fakeDav.on("request", (_req, res) => {
    res.statusCode = 507;
    res.end();
  });
  await expectOk(await request(baseUrl, jar, "/api/me/storage/webdav", { method: "PUT", ...jsonBody({ autoArchive: false }) }));
  const third = await generateOnce(baseUrl, jar);
  response = await request(baseUrl, jar, `/api/generation-results/${third.resultId}/archive`, { method: "POST" });
  assert.equal(response.status, 502);
  assert.match((await response.json()).error, /空间不够/);
  storage = await expectOk(await request(baseUrl, jar, "/api/me/storage"));
  assert.match(storage.overview.settings.lastError, /空间不够/);
  assert.equal(storage.results.find((item) => item.id === third.resultId).storageStatus, "cloud-temp");

  // 6) 巡检：把前两张改成 4 天前，跑一次 → 文件删了、标 expired、备份路径还在；第三张不动
  {
    const db = new Database(path.join(tmpDir, "app.db"));
    const old = new Date(Date.now() - 4 * 24 * 60 * 60 * 1000).toISOString();
    db.prepare("UPDATE generated_result SET created_at = ? WHERE id IN (?, ?)").run(old, first.resultId, second.resultId);
    db.close();
  }
  await fs.access(path.join(imageDir, path.basename(first.imageUrl)));
  const maintenance = await expectOk(await request(baseUrl, jar, "/api/admin/storage/maintenance", { method: "POST" }));
  assert.equal(maintenance.summary.expired, 2);
  assert.equal(maintenance.summary.filesDeleted, 2);
  assert(maintenance.summary.bytesFreed > 0);
  await assert.rejects(fs.access(path.join(imageDir, path.basename(first.imageUrl))), "过期文件要被删掉");
  await fs.access(path.join(imageDir, path.basename(third.imageUrl)));
  storage = await expectOk(await request(baseUrl, jar, "/api/me/storage"));
  const expiredFirst = storage.results.find((item) => item.id === first.resultId);
  assert.equal(expiredFirst.storageStatus, "expired");
  assert.equal(expiredFirst.expiresAt, null);
  assert.match(expiredFirst.archivePath, /^Cloth\/成片\//, "过期后仍要知道云盘备份在哪");
  assert.equal(storage.overview.expired, 2);
  assert.equal(storage.overview.expiredBackedUp, 2);
  assert.equal(storage.overview.active, 1);
  assert.equal(maintenance.storage.retentionDays, 3);
  assert.equal(maintenance.storage.fileCount, 1);
  // 过期的不能再归档
  response = await request(baseUrl, jar, `/api/generation-results/${first.resultId}/archive`, { method: "POST" });
  assert.equal(response.status, 409);

  // 7) 普通用户碰不到后台存储接口；也不能改角色
  const otherJar = new Map();
  await expectOk(
    await request(baseUrl, otherJar, "/api/auth/sign-up/email", {
      method: "POST",
      ...jsonBody({ name: "Other", email: "other-storage@example.test", password: "clothdesign123" }),
    }),
  );
  response = await request(baseUrl, otherJar, "/api/admin/storage");
  assert.equal(response.status, 403);
  const otherMe = await expectOk(await request(baseUrl, otherJar, "/api/me"));
  response = await request(baseUrl, jar, `/api/admin/users/${otherMe.account.id}`, { method: "PATCH", ...jsonBody({ role: "admin" }) });
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /角色不能改/);
  response = await request(baseUrl, jar, `/api/admin/users/${otherMe.account.id}`, { method: "PATCH", ...jsonBody({ role: "user", name: "改名" }) });
  await expectOk(response);
} finally {
  app.kill("SIGTERM");
  fakeImagesApi.close();
  fakeDav.close();
  await fs.rm(tmpDir, { recursive: true, force: true });
}

console.log(JSON.stringify({ checks: "passed" }, null, 2));
