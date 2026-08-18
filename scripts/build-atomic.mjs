import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const releasesDirectory = path.join(root, ".dist-releases");
const releaseName = `release-${Date.now()}-${process.pid}`;
const releaseDirectory = path.join(releasesDirectory, releaseName);
const distPath = path.join(root, "dist");
const temporaryLink = path.join(root, `.dist-link-${process.pid}`);

await fs.mkdir(releaseDirectory, { recursive: true });

try {
  await build({
    root,
    build: {
      outDir: releaseDirectory,
      emptyOutDir: true,
    },
  });

  // dist 永远指向一份已经完整生成的 release。后续构建只替换这个符号链接，
  // 浏览器不会再遇到 index.html 已更新、对应 CSS/JS 还没写完的半成品窗口。
  await fs.symlink(path.relative(root, releaseDirectory), temporaryLink, "dir");

  let current;
  try {
    current = await fs.lstat(distPath);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }

  if (current?.isSymbolicLink()) {
    await fs.rename(temporaryLink, distPath);
  } else if (current) {
    const legacyDirectory = path.join(releasesDirectory, `legacy-${Date.now()}`);
    await fs.rename(distPath, legacyDirectory);
    try {
      await fs.rename(temporaryLink, distPath);
    } catch (error) {
      await fs.rename(legacyDirectory, distPath);
      throw error;
    }
  } else {
    await fs.rename(temporaryLink, distPath);
  }

  console.log(`Atomic frontend release active: ${releaseName}`);
} catch (error) {
  await fs.rm(temporaryLink, { force: true }).catch(() => {});
  await fs.rm(releaseDirectory, { recursive: true, force: true }).catch(() => {});
  throw error;
}
