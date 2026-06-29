import "dotenv/config";
import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

function resolveDatabasePath(databaseUrl = process.env.DATABASE_URL || "file:./data/clothdesign.db") {
  if (!databaseUrl.startsWith("file:")) {
    throw new Error("Only file: SQLite DATABASE_URL values can be backed up by this script.");
  }
  const rawPath = databaseUrl.slice("file:".length);
  return path.isAbsolute(rawPath) ? rawPath : path.resolve(root, rawPath);
}

function timestampLabel(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, "-");
}

const sourcePath = resolveDatabasePath();
const backupDir = path.resolve(root, process.env.DB_BACKUP_DIR || "backups");
const backupPath = path.join(backupDir, `clothdesign-${timestampLabel()}.db`);

if (!fs.existsSync(sourcePath)) {
  throw new Error(`Database file does not exist: ${sourcePath}`);
}

fs.mkdirSync(backupDir, { recursive: true });

const db = new Database(sourcePath, { readonly: true });
try {
  await db.backup(backupPath);
} finally {
  db.close();
}

const stats = fs.statSync(backupPath);
console.log(
  JSON.stringify(
    {
      sourcePath,
      backupPath,
      bytes: stats.size,
      checks: "passed",
    },
    null,
    2,
  ),
);
