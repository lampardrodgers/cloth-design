import type { ProviderProtocol, RatioOption, ResolutionKey } from "../types";

const apimartOutputSizes: Record<string, Record<ResolutionKey, [number, number]>> = {
  "1:1": { native: [1024, 1024], hd: [2048, 2048], fourK: [2880, 2880] },
  "3:2": { native: [1536, 1024], hd: [2048, 1360], fourK: [3520, 2336] },
  "2:3": { native: [1024, 1536], hd: [1360, 2048], fourK: [2336, 3520] },
  "4:3": { native: [1024, 768], hd: [2048, 1536], fourK: [3312, 2480] },
  "3:4": { native: [768, 1024], hd: [1536, 2048], fourK: [2480, 3312] },
  "5:4": { native: [1280, 1024], hd: [2560, 2048], fourK: [3216, 2576] },
  "4:5": { native: [1024, 1280], hd: [2048, 2560], fourK: [2576, 3216] },
  "16:9": { native: [1536, 864], hd: [2048, 1152], fourK: [3840, 2160] },
  "9:16": { native: [864, 1536], hd: [1152, 2048], fourK: [2160, 3840] },
  "2:1": { native: [2048, 1024], hd: [2688, 1344], fourK: [3840, 1920] },
  "1:2": { native: [1024, 2048], hd: [1344, 2688], fourK: [1920, 3840] },
  "3:1": { native: [1536, 512], hd: [3072, 1024], fourK: [3840, 1280] },
  "1:3": { native: [512, 1536], hd: [1024, 3072], fourK: [1280, 3840] },
  "21:9": { native: [2016, 864], hd: [2688, 1152], fourK: [3840, 1648] },
  "9:21": { native: [864, 2016], hd: [1152, 2688], fourK: [1648, 3840] },
};

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
 * 分两条线算：APIMart 认 resolution（1k/2k/4k），每个比例都有自己的一张尺寸表；
 * OpenAI 兼容线路没有这个参数，出图就是 `ratio.apiSize` 那一档，服务端再归一到它
 * （只缩不放）。所以不知道走哪条线时，按更保守的 apiSize 算，别报一个出不来的像素。
 */
export function outputSizeForRatio(
  ratio: RatioOption | undefined,
  resolution?: ResolutionKey,
  protocol: ProviderProtocol = "openai",
): OutputSize {
  if (ratio?.id === "auto") return { label: "由图像接口决定", auto: true };
  if (protocol === "apimart" && ratio && resolution && apimartOutputSizes[ratio.label]?.[resolution]) {
    const [width, height] = apimartOutputSizes[ratio.label][resolution];
    return { width, height, label: `${width} × ${height} px`, auto: false };
  }
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
