import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "clothdesign-image-cleanup-"));
const assetDir = path.join(tmpDir, "generated-images");
process.env.DATABASE_URL = `file:${path.join(tmpDir, "test.db")}`;
process.env.IMAGE_ASSET_DIR = assetDir;
process.env.IMAGE_ASSET_PUBLIC_PATH = "/generated-images";
process.env.PAYMENT_DEMO_MODE = "true";

const { migrateBusinessDatabase, nowIso, sqlite } = await import("../server/db.mjs");
const { migrateWorkflowDatabase } = await import("../server/workflows.mjs");
const { cleanupUnreferencedGeneratedImages, referencedGeneratedImageUrls } = await import("../server/image-cleanup.mjs");

migrateBusinessDatabase();
migrateWorkflowDatabase();

const timestamp = nowIso();
const userId = "u-image-cleanup";
sqlite
  .prepare(
    `INSERT INTO user_profile
      (user_id, display_name, role, plan, credits, monthly_used, status, created_at, updated_at)
     VALUES (?, '图片清理用户', 'owner', '测试版', 5000, 0, 'active', ?, ?)`,
  )
  .run(userId, timestamp, timestamp);

sqlite
  .prepare(
    `INSERT INTO generation_task
      (id, user_id, mode, prompt, status, credits, message, created_at, updated_at)
     VALUES ('task-cleanup', ?, 'text', 'keep generated result', 'success', 1, 'ok', ?, ?)`,
  )
  .run(userId, timestamp, timestamp);

sqlite
  .prepare(
    `INSERT INTO generated_result
      (id, task_id, user_id, title, mode, ratio_label, storage_status, credits, image_url, created_at)
     VALUES ('result-cleanup', 'task-cleanup', ?, 'keep main', 'text', '1:1', 'local-cache', 1, ?, ?)`,
  )
  .run(userId, "/generated-images/11111111-1111-4111-8111-111111111111.png", timestamp);

sqlite
  .prepare(
    `INSERT INTO workflow_job
      (id, user_id, type, title, prompt, status, progress, credits, message, options_json, created_at, updated_at)
     VALUES ('wf-cleanup', ?, 'fabric-to-style', 'keep workflow', 'prompt', 'success', 100, 1, 'ok', '{}', ?, ?)`,
  )
  .run(userId, timestamp, timestamp);

sqlite
  .prepare(
    `INSERT INTO workflow_result
      (id, job_id, asset_id, title, version_type, media_type, image_url, metadata_json, created_at)
     VALUES ('workflow-result-cleanup', 'wf-cleanup', NULL, 'keep workflow result', 'variant', 'image', ?, '{}', ?)`,
  )
  .run("/generated-images/22222222-2222-4222-8222-222222222222.png", timestamp);

sqlite
  .prepare(
    `INSERT INTO workflow_result
      (id, job_id, asset_id, title, version_type, media_type, image_url, metadata_json, created_at)
     VALUES ('workflow-result-data-url', 'wf-cleanup', NULL, 'ignore inline result', 'variant', 'image', ?, '{}', ?)`,
  )
  .run("data:image/png;base64,abc", timestamp);

sqlite
  .prepare(
    `INSERT INTO workflow_asset
      (id, user_id, job_id, kind, name, mime_type, source_url, note, metadata_json, created_at)
     VALUES ('workflow-asset-cleanup', ?, 'wf-cleanup', 'result', 'asset source', 'image/png', ?, 'referenced generated source', '{}', ?)`,
  )
  .run(userId, "/generated-images/44444444-4444-4444-8444-444444444444.png", timestamp);

await fs.mkdir(assetDir, { recursive: true });
await fs.writeFile(path.join(assetDir, "11111111-1111-4111-8111-111111111111.png"), "main");
await fs.writeFile(path.join(assetDir, "22222222-2222-4222-8222-222222222222.png"), "workflow");
await fs.writeFile(path.join(assetDir, "33333333-3333-4333-8333-333333333333.png"), "orphan");
await fs.writeFile(path.join(assetDir, "44444444-4444-4444-8444-444444444444.png"), "workflow-asset");
const oldDate = new Date(Date.now() - 24 * 60 * 60 * 1000);
await fs.utimes(path.join(assetDir, "33333333-3333-4333-8333-333333333333.png"), oldDate, oldDate);
await fs.utimes(path.join(assetDir, "44444444-4444-4444-8444-444444444444.png"), oldDate, oldDate);

assert.deepEqual(referencedGeneratedImageUrls().sort(), [
  "/generated-images/11111111-1111-4111-8111-111111111111.png",
  "/generated-images/22222222-2222-4222-8222-222222222222.png",
  "/generated-images/44444444-4444-4444-8444-444444444444.png",
]);

const cleanup = await cleanupUnreferencedGeneratedImages({ maxAgeMs: 60 * 60 * 1000 });
assert.deepEqual(
  cleanup.deleted.map((item) => item.fileName),
  ["33333333-3333-4333-8333-333333333333.png"],
);
await fs.access(path.join(assetDir, "11111111-1111-4111-8111-111111111111.png"));
await fs.access(path.join(assetDir, "22222222-2222-4222-8222-222222222222.png"));
await fs.access(path.join(assetDir, "44444444-4444-4444-8444-444444444444.png"));
await assert.rejects(() => fs.access(path.join(assetDir, "33333333-3333-4333-8333-333333333333.png")), /ENOENT/);

console.log(JSON.stringify({ checks: "passed" }, null, 2));
