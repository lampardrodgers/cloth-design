import type { ModeKey } from "../types";

const modePalette: Record<ModeKey, [string, string, string]> = {
  text: ["#e9d7c3", "#2f6f61", "#c24e32"],
  free: ["#e5e7eb", "#4f46e5", "#0f766e"],
  tryon: ["#dbe8e4", "#1f5c68", "#d77047"],
  fusion: ["#ebe4d7", "#5d5a95", "#2c8c7d"],
  campaign: ["#f0d5ce", "#b83534", "#2e624c"],
  product: ["#f2f3f0", "#34302d", "#a7b6a4"],
  fabric: ["#e7e1f0", "#7e3f8f", "#2e8d73"],
  lookbook: ["#dde5d6", "#4b6d3a", "#c15f3d"],
};

export function createMockFashionImage(mode: ModeKey, label: string, ratioLabel: string, index: number) {
  const [bg, primary, accent] = modePalette[mode];
  const width = ratioLabel === "16:9" ? 1280 : ratioLabel === "9:16" ? 900 : ratioLabel === "1:1" ? 1080 : 960;
  const height = ratioLabel === "16:9" ? 720 : ratioLabel === "9:16" ? 1600 : ratioLabel === "1:1" ? 1080 : 1280;
  const cx = width / 2;
  const garmentTop = height * 0.3;
  const garmentBottom = height * 0.72;
  const svg = `
  <svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
    <defs>
      <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="${bg}"/>
        <stop offset="1" stop-color="#ffffff"/>
      </linearGradient>
      <pattern id="pin" width="38" height="38" patternUnits="userSpaceOnUse">
        <path d="M0 38 L38 0" stroke="${accent}" stroke-opacity="0.15" stroke-width="3"/>
      </pattern>
      <filter id="shadow" x="-20%" y="-20%" width="140%" height="140%">
        <feDropShadow dx="0" dy="24" stdDeviation="28" flood-color="#000000" flood-opacity="0.18"/>
      </filter>
    </defs>
    <rect width="100%" height="100%" fill="url(#bg)"/>
    <rect x="${width * 0.08}" y="${height * 0.08}" width="${width * 0.84}" height="${height * 0.84}" rx="28" fill="url(#pin)" opacity="0.75"/>
    <circle cx="${cx}" cy="${height * 0.2}" r="${Math.min(width, height) * 0.075}" fill="${primary}" opacity="0.9"/>
    <path filter="url(#shadow)" d="M${cx - width * 0.12} ${garmentTop} C${cx - width * 0.22} ${height * 0.42} ${cx - width * 0.25} ${height * 0.58} ${cx - width * 0.2} ${garmentBottom} L${cx + width * 0.2} ${garmentBottom} C${cx + width * 0.25} ${height * 0.58} ${cx + width * 0.22} ${height * 0.42} ${cx + width * 0.12} ${garmentTop} C${cx + width * 0.06} ${garmentTop + 40} ${cx - width * 0.06} ${garmentTop + 40} ${cx - width * 0.12} ${garmentTop} Z" fill="${primary}"/>
    <path d="M${cx - width * 0.06} ${garmentTop + 18} C${cx - width * 0.02} ${garmentTop + 76} ${cx + width * 0.02} ${garmentTop + 76} ${cx + width * 0.06} ${garmentTop + 18}" fill="none" stroke="#ffffff" stroke-opacity="0.72" stroke-width="10"/>
    <path d="M${cx - width * 0.16} ${height * 0.46} C${cx - width * 0.05} ${height * 0.5} ${cx + width * 0.05} ${height * 0.5} ${cx + width * 0.16} ${height * 0.46}" fill="none" stroke="${accent}" stroke-width="12" stroke-linecap="round"/>
    <text x="${width * 0.08}" y="${height * 0.9}" fill="#282522" font-family="Arial, sans-serif" font-size="${Math.max(30, width * 0.045)}" font-weight="700">${label}</text>
    <text x="${width * 0.08}" y="${height * 0.94}" fill="#5d625f" font-family="Arial, sans-serif" font-size="${Math.max(18, width * 0.024)}">Cloth AI ${index.toString().padStart(2, "0")}</text>
  </svg>`;

  return `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`;
}
