import type { RatioOption } from "../types";

export interface OutputSize {
  width?: number;
  height?: number;
  /** 能直接显示给用户的像素文案。 */
  label: string;
  /** true 表示尺寸由图像接口决定，点生成前算不出来。 */
  auto: boolean;
}

/**
 * 成片真实交付的像素。
 *
 * 注意这里只看 `ratio.apiSize`：服务端把返回图统一归一到这个尺寸（只缩不放），
 * 「清晰度」目前只参与计费，不改变输出像素，所以不能拿它来算。
 */
export function outputSizeForRatio(ratio: RatioOption | undefined): OutputSize {
  if (!ratio || ratio.apiSize === "auto") {
    return { label: "由图像接口决定", auto: true };
  }
  const [width, height] = ratio.apiSize.split("x").map(Number);
  if (!Number.isFinite(width) || !Number.isFinite(height)) {
    return { label: "由图像接口决定", auto: true };
  }
  return { width, height, label: `${width} × ${height} px`, auto: false };
}

/** 选中的比例和实际交付比例不一致时给一句实话（例如 9:16 实际按 2:3 出图）。 */
export function outputSizeMismatch(ratio: RatioOption | undefined): string {
  const size = outputSizeForRatio(ratio);
  if (!ratio || size.auto || !size.width || !size.height) return "";
  const requested = ratio.width / ratio.height;
  const delivered = size.width / size.height;
  if (Math.abs(requested - delivered) < 0.02) return "";
  return `接口只支持 ${size.width}×${size.height}，实际按这个尺寸交付`;
}
