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

/**
 * 成片时间戳的显示文案。
 * 本次会话里新生成的是「14:32」，从服务端取回的历史是完整 ISO 串——后者直接摆出来太难看。
 */
export function formatResultTime(createdAt: string) {
  const raw = String(createdAt || "").trim();
  if (!raw) return "";
  if (!/\d{4}-\d{2}-\d{2}/.test(raw)) return raw;
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return raw;
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(parsed);
}

export function resultFileName(result: { title: string; imageUrl: string }) {
  const extension = extensionFromDataUrl(result.imageUrl) || extensionFromUrl(result.imageUrl) || "png";
  return `${safeBaseName(result.title)}.${extension}`;
}
