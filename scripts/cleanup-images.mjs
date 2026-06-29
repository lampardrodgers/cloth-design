import "dotenv/config";
import { migrateBusinessDatabase } from "../server/db.mjs";
import { cleanupUnreferencedGeneratedImages } from "../server/image-cleanup.mjs";
import { migrateWorkflowDatabase } from "../server/workflows.mjs";

function booleanEnv(value) {
  return ["1", "true", "yes"].includes(String(value || "").toLowerCase());
}

const maxAgeDays = Number(process.env.IMAGE_CLEANUP_MAX_AGE_DAYS || 30);
if (!Number.isFinite(maxAgeDays) || maxAgeDays < 0) {
  throw new Error("IMAGE_CLEANUP_MAX_AGE_DAYS must be a non-negative number.");
}

migrateBusinessDatabase();
migrateWorkflowDatabase();

const summary = await cleanupUnreferencedGeneratedImages({
  maxAgeMs: maxAgeDays * 24 * 60 * 60 * 1000,
  dryRun: booleanEnv(process.env.IMAGE_CLEANUP_DRY_RUN),
});

console.log(JSON.stringify({ ...summary, maxAgeDays, checks: "passed" }, null, 2));
