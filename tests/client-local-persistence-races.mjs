import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";

function waitForOutput(child, pattern) {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${pattern}\n${stdout}\n${stderr}`)), 30000);
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
      if (pattern.test(stdout)) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`App exited before startup: ${code}\n${stdout}\n${stderr}`));
    });
  });
}

const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "clothdesign-local-races-"));
const port = 20100 + Math.floor(Math.random() * 80);
const appProcess = spawn(process.execPath, ["server/index.mjs"], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    HOST: "127.0.0.1",
    PORT: String(port),
    DATABASE_URL: `file:${path.join(tmpDir, "app.db")}`,
    IMAGE_ASSET_DIR: path.join(tmpDir, "generated-images"),
    VIDEO_ASSET_DIR: path.join(tmpDir, "generated-videos"),
    AUTH_SECRET: "local-races-secret-12345678901234567890",
    PUBLIC_APP_URL: `http://127.0.0.1:${port}`,
    NODE_ENV: "test",
    OPENAI_DEMO_MODE: "true",
  },
});

let browser;
try {
  await waitForOutput(appProcess, /ClothDesign AI running/);
  const baseUrl = `http://127.0.0.1:${port}`;
  browser = await chromium.launch();
  const context = await browser.newContext();
  const pageA = await context.newPage();
  const pageB = await context.newPage();
  await Promise.all([pageA.goto(baseUrl, { waitUntil: "networkidle" }), pageB.goto(baseUrl, { waitUntil: "networkidle" })]);

  const legacyCanvasDb = "TLDRAW_DOCUMENT_v2clothdesign-free-canvas";
  const canvasDbName = (accountId) => `${legacyCanvasDb}:${encodeURIComponent(accountId)}`;
  const listDbs = () => pageA.evaluate(() => indexedDB.databases().then((items) => items.map((item) => item.name)));
  const deleteDb = (page, name) =>
    page.evaluate(
      (name) =>
        new Promise((resolve, reject) => {
          const request = indexedDB.deleteDatabase(name);
          request.onsuccess = () => resolve();
          request.onerror = () => reject(request.error);
        }),
      name,
    );
  const seedCanvas = (page, key, value) =>
    page.evaluate(
      async ({ name, key, value }) => {
        const db = await new Promise((resolve, reject) => {
          const request = indexedDB.open(name, 4);
          request.onupgradeneeded = () => {
            for (const table of ["records", "schema", "session_state", "assets"]) {
              if (!request.result.objectStoreNames.contains(table)) request.result.createObjectStore(table);
            }
          };
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
        await new Promise((resolve, reject) => {
          const tx = db.transaction("session_state", "readwrite");
          tx.objectStore("session_state").put(value, key);
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
        });
        db.close();
      },
      { name: legacyCanvasDb, key, value },
    );
  const writeCanvasControl = (page, value) =>
    page.evaluate(async (value) => {
      const db = await new Promise((resolve, reject) => {
        const request = indexedDB.open("clothdesign-canvas-control", 1);
        request.onupgradeneeded = () => request.result.createObjectStore("state");
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      await new Promise((resolve, reject) => {
        const tx = db.transaction("state", "readwrite");
        if (value === null) tx.objectStore("state").delete("legacy-migration");
        else tx.objectStore("state").put(value, "legacy-migration");
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
      db.close();
    }, value);
  const readCanvasControl = (page) =>
    page.evaluate(async () => {
      const db = await new Promise((resolve, reject) => {
        const request = indexedDB.open("clothdesign-canvas-control", 1);
        request.onupgradeneeded = () => request.result.createObjectStore("state");
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const value = await new Promise((resolve, reject) => {
        const request = db.transaction("state", "readonly").objectStore("state").get("legacy-migration");
        request.onsuccess = () => resolve(request.result ?? null);
        request.onerror = () => reject(request.error);
      });
      db.close();
      return value;
    });

  // 1) 两个标签页都通过存在性检查后再竞争 claim；只能有一个账号收到旧画布。
  await seedCanvas(pageA, "race-proof", { private: "one-owner-only" });
  for (const page of [pageA, pageB]) {
    await page.evaluate(() => {
      const real = indexedDB.databases.bind(indexedDB);
      window.__realDatabases = real;
      let release;
      window.__releaseDatabases = () => release?.();
      indexedDB.databases = async () => {
        await new Promise((resolve) => {
          release = resolve;
        });
        return real();
      };
    });
  }
  const adoptA = pageA.evaluate(async () => (await import("/src/lib/canvasStore.ts")).adoptLegacyCanvasStore("race-A"));
  const adoptB = pageB.evaluate(async () => (await import("/src/lib/canvasStore.ts")).adoptLegacyCanvasStore("race-B"));
  await pageA.waitForTimeout(300);
  await Promise.all([pageA.evaluate(() => window.__releaseDatabases()), pageB.evaluate(() => window.__releaseDatabases())]);
  const adoptionResults = await Promise.all([adoptA, adoptB]);
  assert.equal(adoptionResults.filter(Boolean).length, 1, `只能一个账号接管，实际 ${JSON.stringify(adoptionResults)}`);
  const raceDbs = await pageA.evaluate(() => window.__realDatabases().then((items) => items.map((item) => item.name)));
  assert.equal([canvasDbName("race-A"), canvasDbName("race-B")].filter((name) => raceDbs.includes(name)).length, 1, `只能生成一座账号库，实际 ${JSON.stringify(raceDbs)}`);

  // 恢复 databases()，清掉本段目标库。
  for (const page of [pageA, pageB]) await page.evaluate(() => Object.defineProperty(indexedDB, "databases", { value: window.__realDatabases, configurable: true }));
  await Promise.all([deleteDb(pageA, canvasDbName("race-A")), deleteDb(pageA, canvasDbName("race-B"))]);

  // 2) reset 必须尊重 owner：B 不能删 A stage=copy 的恢复源，A 自己可以。
  await seedCanvas(pageA, "reset-proof", { private: "owned-by-A" });
  await writeCanvasControl(pageA, { accountId: "owner-A", stage: "copy" });
  await pageB.evaluate(async () => (await import("/src/lib/canvasStore.ts")).resetCanvasStore("owner-B"));
  assert((await listDbs()).includes(legacyCanvasDb), "B reset 不能删除 A 认领的旧库");
  assert.deepEqual(await readCanvasControl(pageA), { accountId: "owner-A", stage: "copy" }, "B reset 不能清 A 的 owner");
  await pageA.evaluate(async () => (await import("/src/lib/canvasStore.ts")).resetCanvasStore("owner-A"));
  assert(!(await listDbs()).includes(legacyCanvasDb), "A 自己 reset 可以删除自己的旧库");
  assert.equal(await readCanvasControl(pageA), null, "A 自己 reset 后清 owner");

  // 3) fallback 不再信任 tldraw localStorage 索引；真实 DB 存在时保留 A owner，C 接不走。
  await seedCanvas(pageA, "fallback-proof", { private: "owned-by-A" });
  await writeCanvasControl(pageA, { accountId: "fallback-A", stage: "copy" });
  await pageB.evaluate(() => {
    Object.defineProperty(indexedDB, "databases", { value: undefined, configurable: true });
    localStorage.removeItem("TLDRAW_DB_NAME_INDEX_v2");
  });
  const fallbackAdopted = await pageB.evaluate(async () => (await import("/src/lib/canvasStore.ts")).adoptLegacyCanvasStore("fallback-C"));
  assert.equal(fallbackAdopted, false, "C 不能靠缺失索引接走 A 的旧库");
  assert.deepEqual(await readCanvasControl(pageA), { accountId: "fallback-A", stage: "copy" }, "fallback 假阴性不能清 owner");
  assert(!(await listDbs()).includes(canvasDbName("fallback-C")), "C 不能得到账号库");
  await pageB.evaluate(() => Object.defineProperty(indexedDB, "databases", { value: window.__realDatabases, configurable: true }));
  await pageA.evaluate(async () => (await import("/src/lib/canvasStore.ts")).resetCanvasStore("fallback-A"));

  // 4) 待清记录按账号独立 key：并发 mark 不会丢；localStorage 镜像写失败后关闭页面，另一页仍看得到 IDB marker。
  await Promise.all([
    pageA.evaluate(async () => (await import("/src/lib/canvasStore.ts")).markCanvasPurgePending("purge-A")),
    pageB.evaluate(async () => (await import("/src/lib/canvasStore.ts")).markCanvasPurgePending("purge-B")),
  ]);
  assert.deepEqual((await pageA.evaluate(async () => (await import("/src/lib/canvasStore.ts")).pendingCanvasPurges())).sort(), ["purge-A", "purge-B"]);
  await pageA.evaluate(() => {
    const real = Storage.prototype.setItem;
    window.__realStorageSetItem = real;
    Storage.prototype.setItem = function(key, value) {
      if (key === "clothdesign:pending-canvas-purge") throw new DOMException("quota", "QuotaExceededError");
      return real.call(this, key, value);
    };
  });
  assert.equal(await pageA.evaluate(async () => (await import("/src/lib/canvasStore.ts")).markCanvasPurgePending("purge-fallback")), true, "控制库成功时不依赖 localStorage 镜像");
  await pageA.close();
  assert((await pageB.evaluate(async () => (await import("/src/lib/canvasStore.ts")).pendingCanvasPurges())).includes("purge-fallback"), "关掉写入页后 IDB marker 仍在");
  assert.equal(await pageB.evaluate(async () => (await import("/src/lib/canvasStore.ts")).purgePendingCanvasStores()), true);
  assert.deepEqual(await pageB.evaluate(async () => (await import("/src/lib/canvasStore.ts")).pendingCanvasPurges()), []);

  // 5) 文件夹 legacy owner 永久、跨标签原子：A 先认领，即使 legacy 稍后才出现，B 也接不走。
  await pageB.evaluate(() => {
    window.showDirectoryPicker = async () => null;
  });
  const pageC = await context.newPage();
  await pageC.goto(baseUrl, { waitUntil: "networkidle" });
  await pageC.evaluate(() => {
    window.showDirectoryPicker = async () => null;
  });
  assert.equal(await pageB.evaluate(async () => (await import("/src/lib/localFolder.ts")).loadSavedFolder("folder-A")), null);
  await pageB.evaluate(async () => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open("clothdesign-local-folder", 2);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains("handles")) request.result.createObjectStore("handles");
        if (!request.result.objectStoreNames.contains("control")) request.result.createObjectStore("control");
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise((resolve, reject) => {
      const tx = db.transaction("handles", "readwrite");
      tx.objectStore("handles").put({ kind: "directory", name: "legacy-folder-A" }, "folder");
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  });
  assert.equal(await pageC.evaluate(async () => (await import("/src/lib/localFolder.ts")).loadSavedFolder("folder-B")), null, "B 不能接 A 已认领的 legacy 句柄");
  const adoptedFolder = await pageB.evaluate(async () => (await import("/src/lib/localFolder.ts")).loadSavedFolder("folder-A"));
  assert.equal(adoptedFolder?.name, "legacy-folder-A", "A 能继续完成自己的迁移");

  // 6) 文件夹 pending marker 能在启动式补清中同时删账号句柄、owner 账号的 legacy 和 marker。
  await pageB.evaluate(async () => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open("clothdesign-local-folder", 2);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise((resolve, reject) => {
      const tx = db.transaction(["handles", "control"], "readwrite");
      tx.objectStore("handles").put({ kind: "directory", name: "late-legacy" }, "folder");
      tx.objectStore("control").put(true, "purge:folder:folder-A");
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  });
  assert.equal(await pageB.evaluate(async () => (await import("/src/lib/localFolder.ts")).purgePendingLocalFolders()), true);
  const folderState = await pageB.evaluate(async () => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open("clothdesign-local-folder", 2);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const [handleKeys, controlKeys] = await Promise.all(
      ["handles", "control"].map(
        (store) =>
          new Promise((resolve, reject) => {
            const request = db.transaction(store, "readonly").objectStore(store).getAllKeys();
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
          }),
      ),
    );
    db.close();
    return { handleKeys, controlKeys };
  });
  assert(!folderState.handleKeys.includes("folder:folder-A") && !folderState.handleKeys.includes("folder"), `补清后不留账号/legacy 句柄：${JSON.stringify(folderState)}`);
  assert(!folderState.controlKeys.includes("purge:folder:folder-A"), "补清成功才移除 pending marker");

  console.log(JSON.stringify({
    checks: "passed",
    canvasClaimWinners: adoptionResults.filter(Boolean).length,
    ownerAwareReset: true,
    authoritativeFallbackProbe: true,
    durablePerAccountPurges: true,
    permanentFolderOwner: true,
    folderCleanupReplay: true,
  }, null, 2));
} finally {
  await browser?.close();
  appProcess.kill("SIGTERM");
  await fs.rm(tmpDir, { recursive: true, force: true });
}
