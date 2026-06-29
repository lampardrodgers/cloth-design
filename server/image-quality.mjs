export function imageQualityGate(imageInspection = {}) {
  const checks = [];
  const warnings = [];
  const issues = [];
  const nextActions = ["可继续编辑、下载或进入人工审片。"];
  if (imageInspection.bytes > 0) checks.push("image_persisted");
  if (imageInspection.dimensions?.width > 0 && imageInspection.dimensions?.height > 0) checks.push("image_dimensions");
  if (imageInspection.content?.inspected) checks.push("image_content_signal");
  if (imageInspection.normalization) checks.push("normalized_to_request");

  let status = "passed";
  const width = Number(imageInspection.dimensions?.width || 0);
  const height = Number(imageInspection.dimensions?.height || 0);
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
    normalization: imageInspection.normalization || null,
  };
}
