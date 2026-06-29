export interface ImageInspection {
  bytes?: number;
  dimensions?: { width?: number; height?: number };
  normalization?: {
    method?: string;
    requestedSize?: string;
    sourceDimensions?: { width?: number; height?: number };
    outputCompression?: number;
  } | null;
  content?: {
    inspected?: boolean;
    lowInformation?: boolean;
    subjectTooSparse?: boolean;
  };
}

export interface ImageQualityGate {
  status: "passed" | "rework";
  score: number;
  checks: string[];
  warnings: string[];
  issues: string[];
  nextActions: string[];
  normalization?: ImageInspection["normalization"];
}

export function imageQualityGate(imageInspection: ImageInspection = {}): ImageQualityGate {
  const checks: string[] = [];
  const warnings: string[] = [];
  const issues: string[] = [];
  const nextActions = ["可继续编辑、下载或进入人工审片。"];
  if ((imageInspection.bytes ?? 0) > 0) checks.push("image_persisted");
  if ((imageInspection.dimensions?.width ?? 0) > 0 && (imageInspection.dimensions?.height ?? 0) > 0) checks.push("image_dimensions");
  if (imageInspection.content?.inspected) checks.push("image_content_signal");
  if (imageInspection.normalization) checks.push("normalized_to_request");

  let status: ImageQualityGate["status"] = "passed";
  const width = Number(imageInspection.dimensions?.width ?? 0);
  const height = Number(imageInspection.dimensions?.height ?? 0);
  if ((width > 0 && width < 256) || (height > 0 && height < 256)) {
    warnings.push("image_too_small");
    issues.push("生成图片尺寸过小，疑似上游坏图或占位图。");
    nextActions.unshift("重新生成并确认返回原始分辨率图片。");
    status = "rework";
  }
  if (imageInspection.content?.lowInformation) {
    warnings.push("image_low_information");
    issues.push("生成图片内容信息量过低，可能是纯色图或异常占位图。");
    nextActions.unshift("重新生成并检查主体、面料纹理和服装结构是否可见。");
    status = "rework";
  }
  if (imageInspection.content?.subjectTooSparse) {
    warnings.push("subject_too_sparse");
    issues.push("生成图片主体占比过低，疑似空白图或主体未生成。");
    nextActions.unshift("重新生成并确认服装主体占据画面主要区域。");
    status = "rework";
  }

  return {
    status,
    score: status === "passed" ? 92 : 54,
    checks,
    warnings,
    issues,
    nextActions,
    normalization: imageInspection.normalization ?? null,
  };
}

export function imageQualityLabel(qualityGate?: { status?: ImageQualityGate["status"] } | null) {
  if (!qualityGate?.status) return "待验收";
  return qualityGate.status === "passed" ? "质量通过" : "需返工";
}

export function imageQualitySummary({
  qualityGate,
  imageInspection,
}: {
  qualityGate?: Partial<ImageQualityGate> | null;
  imageInspection?: ImageInspection | null;
}) {
  if (qualityGate?.issues?.[0]) return qualityGate.issues[0];
  const normalization = imageInspection?.normalization || qualityGate?.normalization;
  if (normalization?.requestedSize) return `已按 ${normalization.requestedSize} 归一化，可继续审片。`;
  if (qualityGate?.status === "passed") return "尺寸、内容信号和落盘检查已通过。";
  return "等待质量检查结果。";
}
