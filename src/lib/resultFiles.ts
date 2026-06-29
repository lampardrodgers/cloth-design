const extensionByMime: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/webp": "webp",
};

function extensionFromUrl(imageUrl: string) {
  const withoutQuery = imageUrl.split(/[?#]/, 1)[0] || "";
  const match = withoutQuery.match(/\.(png|jpe?g|webp)$/i);
  if (!match) return "";
  return match[1].toLowerCase() === "jpeg" ? "jpg" : match[1].toLowerCase();
}

function extensionFromDataUrl(imageUrl: string) {
  const match = imageUrl.match(/^data:([^;,]+)[;,]/i);
  return match ? extensionByMime[match[1].toLowerCase()] || "" : "";
}

function safeBaseName(title: string) {
  return (
    String(title || "clothdesign-result")
      .trim()
      .replace(/[\\/:*?"<>|]+/g, "-")
      .replace(/\s+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 120) || "clothdesign-result"
  );
}

export function resultFileName(result: { title: string; imageUrl: string }) {
  const extension = extensionFromDataUrl(result.imageUrl) || extensionFromUrl(result.imageUrl) || "png";
  return `${safeBaseName(result.title)}.${extension}`;
}
