import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "clothdesign-auth-"));
process.env.DATABASE_URL = `file:${path.join(tmpDir, "test.db")}`;
process.env.PORT = "8891";
process.env.HOST = "127.0.0.1";
process.env.PUBLIC_APP_URL = "http://127.0.0.1:8888";
process.env.AUTH_SECRET = "test-auth-secret-for-origin-coverage-1234567890";

const { authTrustedOrigins } = await import("../server/auth.mjs");

assert.deepEqual(authTrustedOrigins(), ["http://127.0.0.1:8888", "http://127.0.0.1:8891", "http://localhost:8891"]);

await fs.rm(tmpDir, { recursive: true, force: true });

console.log(JSON.stringify({ checks: "passed" }, null, 2));
