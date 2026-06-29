import type { FabricControls } from "./workflowPayload";

export type FabricPreviewHandle = "hemLengthPercent" | "sleeveLengthPercent" | "necklineDepthPercent";

export interface FabricPreviewPoint {
  x: number;
  y: number;
}

export interface FabricPreviewLayoutInput {
  hemLengthPercent: number;
  sleeveLengthPercent: number;
  necklineDepthPercent: number;
}

function clampPercent(value: number) {
  if (!Number.isFinite(value)) return 0;
  return Math.min(Math.max(Math.round(value), 0), 100);
}

function scale(value: number, min: number, max: number) {
  return min + (max - min) * (clampPercent(value) / 100);
}

function percentFromScale(value: number, min: number, max: number) {
  if (min === max) return 0;
  return clampPercent(((value - min) / (max - min)) * 100);
}

export function fabricPreviewLayout(input: FabricPreviewLayoutInput) {
  const normalized = {
    hemLengthPercent: clampPercent(input.hemLengthPercent),
    sleeveLengthPercent: clampPercent(input.sleeveLengthPercent),
    necklineDepthPercent: clampPercent(input.necklineDepthPercent),
  };
  const handles = {
    hem: {
      x: 50,
      y: Math.round(scale(normalized.hemLengthPercent, 16, 91)),
    },
    sleeve: {
      x: Math.round(scale(normalized.sleeveLengthPercent, 34, 4)),
      y: 41,
    },
    neckline: {
      x: 50,
      y: Math.round(scale(normalized.necklineDepthPercent, 14, 64)),
    },
  };
  const leftSleeve = Math.max(5, handles.sleeve.x - 3);
  const rightSleeve = Math.min(95, 100 - handles.sleeve.x + 3);
  const path = [
    `M ${leftSleeve} 38`,
    `L 34 ${handles.neckline.y}`,
    `Q 50 ${Math.max(12, handles.neckline.y - 8)} 66 ${handles.neckline.y}`,
    `L ${rightSleeve} 38`,
    `L 70 ${handles.hem.y}`,
    `Q 50 ${Math.min(96, handles.hem.y + 6)} 30 ${handles.hem.y}`,
    "Z",
  ].join(" ");
  return {
    normalized,
    handles,
    path,
    summary: `衣长${normalized.hemLengthPercent}% · 袖长${normalized.sleeveLengthPercent}% · 领口开度${normalized.necklineDepthPercent}%`,
  };
}

export function fabricControlsFromPreviewPoint(handle: FabricPreviewHandle, point: FabricPreviewPoint): Partial<FabricControls> {
  if (handle === "hemLengthPercent") {
    return { hemLengthPercent: percentFromScale(point.y, 16, 91) };
  }
  if (handle === "sleeveLengthPercent") {
    return { sleeveLengthPercent: percentFromScale(point.x, 34, 4) };
  }
  return { necklineDepthPercent: percentFromScale(point.y, 14, 64) };
}
