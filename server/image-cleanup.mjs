import { sqlite } from "./db.mjs";
import { cleanupGeneratedImages, generatedImageStaticMount } from "./image-provider.mjs";

export function referencedGeneratedImageUrls() {
  const { publicPath } = generatedImageStaticMount();
  const urls = new Set();
  const collect = (rows) => {
    for (const row of rows) {
      const url = row.image_url || row.source_url;
      if (typeof url === "string" && url.startsWith(`${publicPath}/`)) {
        urls.add(url);
      }
    }
  };
  collect(sqlite.prepare("SELECT image_url FROM generated_result WHERE image_url LIKE ?").all(`${publicPath}/%`));
  collect(sqlite.prepare("SELECT image_url FROM workflow_result WHERE image_url LIKE ?").all(`${publicPath}/%`));
  collect(sqlite.prepare("SELECT source_url FROM workflow_asset WHERE source_url LIKE ?").all(`${publicPath}/%`));
  return [...urls];
}

export async function cleanupUnreferencedGeneratedImages(options = {}) {
  return cleanupGeneratedImages({
    ...options,
    referencedUrls: referencedGeneratedImageUrls(),
  });
}
