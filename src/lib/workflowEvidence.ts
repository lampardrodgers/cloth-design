import type { WorkflowJob, WorkflowResult } from "../types";

interface FailureEvidence {
  reason?: string;
  nextActions?: string[];
}

function failureEvidenceFrom(value: unknown): FailureEvidence | undefined {
  if (!value || typeof value !== "object") return undefined;
  return value as FailureEvidence;
}

export function workflowResultEvidence(result: Pick<WorkflowResult, "mediaType" | "imageUrl" | "metadata">) {
  const failureEvidence = failureEvidenceFrom(result.metadata.failureEvidence);
  if (result.metadata.deliveryStatus === "failed" || failureEvidence) {
    return { label: "生成失败", detail: failureEvidence?.reason || "外部服务未返回可交付结果" };
  }
  if (result.mediaType === "video" && result.metadata.videoServiceUsed) {
    return { label: "真实视频服务", detail: "外部视频模型 · MP4" };
  }
  if (result.mediaType === "video" && result.metadata.motionPreviewGenerated) {
    return { label: "MP4 预览", detail: "本地动效 · AI 行走需视频模型" };
  }
  if (result.mediaType === "video" && result.metadata.requiresVideoModelForMp4) {
    return { label: "需视频服务", detail: "当前为分镜封面" };
  }
  if (result.mediaType === "profile") {
    const training = result.metadata.training as { status?: string; trainingJobId?: string; modelId?: string } | undefined;
    if (training?.trainingJobId) {
      return { label: "真实训练任务", detail: `${training.modelId || "模型训练中"} · ${training.status || "training"}` };
    }
    return { label: "品牌配置", detail: "非真实模型训练" };
  }
  if (result.metadata.liveGenerated) {
    const generationMode = result.metadata.generationMode === "image_edit" ? "真实 image edit" : "真实文生图";
    const imageModel = typeof result.metadata.imageModel === "string" ? result.metadata.imageModel : "图像模型";
    const assetInputCount = Number(result.metadata.assetInputCount ?? 0);
    return { label: generationMode, detail: `${imageModel} · 输入 ${assetInputCount}` };
  }
  return { label: "演示占位", detail: "未调用真实图像接口" };
}

export function workflowFabricAnalysisText(result: Pick<WorkflowResult, "metadata">) {
  const analysis = result.metadata.fabricAnalysis as { colors?: unknown; pattern?: unknown; texture?: unknown; analysisSource?: unknown } | undefined;
  if (!analysis || typeof analysis !== "object") return "";
  const parts = [];
  if (analysis.analysisSource === "image") parts.push("来源 图片解析");
  else if (analysis.analysisSource === "text") parts.push("来源 文本推断");
  if (Array.isArray(analysis.colors) && analysis.colors.length > 0) {
    parts.push(`颜色 ${analysis.colors.map((item) => String(item)).join(" / ")}`);
  }
  if (typeof analysis.pattern === "string" && analysis.pattern.trim()) {
    parts.push(`图案 ${analysis.pattern.trim()}`);
  }
  if (typeof analysis.texture === "string" && analysis.texture.trim()) {
    parts.push(`纹理 ${analysis.texture.trim()}`);
  }
  return parts.join(" · ");
}

export function workflowFabricInputText(result: Pick<WorkflowResult, "metadata">) {
  const input = result.metadata.multimodalInput as
    | {
        inputModes?: unknown;
        assetNames?: unknown;
        textDescription?: unknown;
      }
    | undefined;
  if (!input || typeof input !== "object") return "";
  const parts = [];
  if (Array.isArray(input.inputModes) && input.inputModes.length > 0) {
    parts.push(input.inputModes.map((item) => String(item)).filter(Boolean).join("/"));
  }
  if (Array.isArray(input.assetNames) && input.assetNames.length > 0) {
    parts.push(input.assetNames.map((item) => String(item)).filter(Boolean).join(" / "));
  }
  if (typeof input.textDescription === "string" && input.textDescription.trim()) {
    parts.push(input.textDescription.trim());
  }
  return parts.length ? `输入 ${parts.join(" · ")}` : "";
}

export function workflowStyleRecommendationText(result: Pick<WorkflowResult, "metadata">) {
  const recommendation = result.metadata.styleRecommendation as { silhouette?: unknown; rationale?: unknown } | undefined;
  const variation = result.metadata.variation as { focus?: unknown; detail?: unknown } | undefined;
  const parts = [];
  if (typeof recommendation?.silhouette === "string" && recommendation.silhouette.trim()) {
    parts.push(`推荐 ${recommendation.silhouette.trim()}`);
  }
  if (typeof variation?.focus === "string" && variation.focus.trim()) {
    const detail = typeof variation.detail === "string" && variation.detail.trim() ? `：${variation.detail.trim()}` : "";
    parts.push(`${variation.focus.trim()}${detail}`);
  }
  return parts.join(" · ");
}

export function workflowStyleMatchText(result: Pick<WorkflowResult, "metadata">) {
  const recommendation = result.metadata.styleRecommendation as
    | {
        recommendedCategory?: unknown;
        silhouette?: unknown;
        palette?: unknown;
        rationale?: unknown;
      }
    | undefined;
  if (!recommendation || typeof recommendation !== "object") return "";
  const parts = [];
  if (typeof recommendation.recommendedCategory === "string" && recommendation.recommendedCategory.trim()) parts.push(recommendation.recommendedCategory.trim());
  if (typeof recommendation.silhouette === "string" && recommendation.silhouette.trim()) parts.push(recommendation.silhouette.trim());
  if (Array.isArray(recommendation.palette) && recommendation.palette.length > 0) {
    parts.push(recommendation.palette.map((item) => String(item)).filter(Boolean).join(" / "));
  }
  if (typeof recommendation.rationale === "string" && recommendation.rationale.trim()) parts.push(recommendation.rationale.trim());
  return parts.length ? `匹配 ${parts.join(" · ")}` : "";
}

export function workflowEditControlText(result: Pick<WorkflowResult, "metadata">) {
  const precisionEdit = result.metadata.precisionEdit as
    | {
        patternLabel?: unknown;
        hemLengthPercent?: unknown;
        sleeveLengthPercent?: unknown;
        necklineDepthPercent?: unknown;
        summary?: unknown;
      }
    | undefined;
  if (!precisionEdit || typeof precisionEdit !== "object") return "";
  if (typeof precisionEdit.summary === "string" && precisionEdit.summary.trim()) {
    return `细节控制 ${precisionEdit.summary.trim()}`;
  }
  const hem = Number(precisionEdit.hemLengthPercent);
  const sleeve = Number(precisionEdit.sleeveLengthPercent);
  const neckline = Number(precisionEdit.necklineDepthPercent);
  if (![hem, sleeve, neckline].every(Number.isFinite)) return "";
  const patternLabel = typeof precisionEdit.patternLabel === "string" && precisionEdit.patternLabel.trim() ? `面料图案${precisionEdit.patternLabel.trim()} · ` : "";
  return `细节控制 ${patternLabel}衣长${Math.round(hem)}% · 袖长${Math.round(sleeve)}% · 领口开度${Math.round(neckline)}%`;
}

export function workflowVirtualModelText(result: Pick<WorkflowResult, "metadata">) {
  const selection = result.metadata.virtualModelSelection as
    | {
        modelName?: unknown;
        sceneLabel?: unknown;
        poseId?: unknown;
        poseLabel?: unknown;
        ageGroup?: unknown;
        ageGroupLabel?: unknown;
        bodyType?: unknown;
        bodyTypeLabel?: unknown;
        gender?: unknown;
        genderLabel?: unknown;
        commercialUse?: unknown;
      }
    | undefined;
  if (!selection || typeof selection !== "object") return "";
  const parts = [];
  if (typeof selection.modelName === "string" && selection.modelName.trim()) parts.push(selection.modelName.trim());
  if (typeof selection.sceneLabel === "string" && selection.sceneLabel.trim()) parts.push(selection.sceneLabel.trim());
  const poseText =
    typeof selection.poseLabel === "string" && selection.poseLabel.trim()
      ? selection.poseLabel.trim()
      : typeof selection.poseId === "string" && selection.poseId.trim()
        ? selection.poseId.trim()
        : "";
  if (poseText) parts.push(poseText);
  const profile = [
    selection.ageGroupLabel || selection.ageGroup,
    selection.bodyTypeLabel || selection.bodyType,
    selection.genderLabel || selection.gender,
  ].map((item) => (typeof item === "string" ? item.trim() : "")).filter(Boolean).join("/");
  if (profile) parts.push(profile);
  if (selection.commercialUse === true) parts.push("可商用");
  return parts.join(" · ");
}

export function workflowTryOnSourceText(result: Pick<WorkflowResult, "metadata">) {
  const source = result.metadata.tryOnSource as { sourceLabel?: unknown; inputName?: unknown } | undefined;
  if (!source || typeof source !== "object") return "";
  const parts = [];
  if (typeof source.sourceLabel === "string" && source.sourceLabel.trim()) parts.push(source.sourceLabel.trim());
  if (typeof source.inputName === "string" && source.inputName.trim()) parts.push(source.inputName.trim());
  return parts.length ? `来源 ${parts.join(" · ")}` : "";
}

export function workflowPostprocessBatchText(result: Pick<WorkflowResult, "metadata">) {
  const batch = result.metadata.batchOperation as
    | {
        inputName?: unknown;
        batchIndex?: unknown;
        batchTotal?: unknown;
        sceneLabel?: unknown;
        targetRatio?: unknown;
        targetColor?: unknown;
        targetColorLabel?: unknown;
        actionLabels?: unknown;
      }
    | undefined;
  if (!batch || typeof batch !== "object") return "";
  const index = Number(batch.batchIndex);
  const total = Number(batch.batchTotal);
  const parts = [];
  if (Number.isFinite(index) && Number.isFinite(total) && total > 0) parts.push(`批量 ${index}/${total}`);
  if (typeof batch.inputName === "string" && batch.inputName.trim()) parts.push(batch.inputName.trim());
  if (typeof batch.sceneLabel === "string" && batch.sceneLabel.trim()) parts.push(batch.sceneLabel.trim());
  if (typeof batch.targetRatio === "string" && batch.targetRatio.trim()) parts.push(batch.targetRatio.trim());
  if (typeof batch.targetColorLabel === "string" && batch.targetColorLabel.trim()) parts.push(batch.targetColorLabel.trim());
  else if (typeof batch.targetColor === "string" && batch.targetColor.trim()) parts.push(batch.targetColor.trim());
  if (Array.isArray(batch.actionLabels) && batch.actionLabels.length > 0) {
    parts.push(batch.actionLabels.map((item) => String(item)).filter(Boolean).join("/"));
  }
  return parts.join(" · ");
}

export function workflowPostprocessTuningText(result: Pick<WorkflowResult, "metadata">) {
  const tuning = result.metadata.postprocessTuning as
    | {
        eraseTarget?: unknown;
        lightStrength?: unknown;
        beautyLevel?: unknown;
        repairFocusLabel?: unknown;
        summary?: unknown;
      }
    | undefined;
  if (!tuning || typeof tuning !== "object") return "";
  if (typeof tuning.summary === "string" && tuning.summary.trim()) return `精修 ${tuning.summary.trim()}`;
  const parts = [];
  if (typeof tuning.eraseTarget === "string" && tuning.eraseTarget.trim()) parts.push(`擦除${tuning.eraseTarget.trim()}`);
  const light = Number(tuning.lightStrength);
  if (Number.isFinite(light)) parts.push(`补光${Math.round(light)}%`);
  const beauty = Number(tuning.beautyLevel);
  if (Number.isFinite(beauty)) parts.push(`美体${Math.round(beauty)}%`);
  if (typeof tuning.repairFocusLabel === "string" && tuning.repairFocusLabel.trim()) parts.push(`修复重点${tuning.repairFocusLabel.trim()}`);
  return parts.length ? `精修 ${parts.join(" · ")}` : "";
}

export function workflowCutoutQualityText(result: Pick<WorkflowResult, "metadata">) {
  const actions = Array.isArray(result.metadata.actions) ? result.metadata.actions.map((item) => String(item)) : [];
  const qualityGate = result.metadata.qualityGate as { checks?: unknown; warnings?: unknown; status?: unknown } | undefined;
  const imageInspection = result.metadata.imageInspection as
    | {
        repair?: {
          method?: unknown;
        };
        alpha?: {
          transparentPixels?: unknown;
          opaquePixels?: unknown;
        };
      }
    | undefined;
  const checks = Array.isArray(qualityGate?.checks) ? qualityGate.checks.map((item) => String(item)) : [];
  const warnings = Array.isArray(qualityGate?.warnings) ? qualityGate.warnings.map((item) => String(item)) : [];
  if (!actions.includes("cutout") && !checks.includes("transparent_alpha") && !warnings.includes("cutout_alpha_missing") && !warnings.includes("cutout_background_not_removed")) return "";
  if (warnings.includes("cutout_alpha_missing")) return "抠图待返工 未检测到透明 alpha";
  if (warnings.includes("cutout_background_not_removed")) return "抠图待返工 背景未去净";
  if (!checks.includes("transparent_alpha")) return "";
  const transparentPixels = Number(imageInspection?.alpha?.transparentPixels);
  const opaquePixels = Number(imageInspection?.alpha?.opaquePixels);
  const parts = ["抠图 alpha 已验证"];
  if (Number.isFinite(transparentPixels) && transparentPixels > 0) parts.push(`透明像素${Math.round(transparentPixels)}`);
  if (Number.isFinite(opaquePixels) && opaquePixels > 0) parts.push(`主体${Math.round(opaquePixels)}`);
  if (result.metadata.segmentationServiceUsed === true) parts.push("分割服务");
  else if (result.metadata.imageRepairSucceeded === true) {
    parts.push(imageInspection?.repair?.method === "solid_background" ? "本地背景抠图" : "棋盘格修复");
  }
  else if (result.metadata.generationMode === "image_edit") parts.push("图像编辑");
  return parts.join(" · ");
}

export function workflowJobFailureNotice(job?: Pick<WorkflowJob, "status" | "message" | "steps"> | null) {
  if (!job || job.status !== "failed") return null;
  const failedStep = job.steps?.find((step) => step.status === "failed");
  const failureEvidence = failureEvidenceFrom(failedStep?.metadata?.failureEvidence);
  const reason = failureEvidence?.reason || job.message.replace(/^真实图像生成失败：/, "") || "外部服务未返回可交付结果";
  return {
    reason,
    nextActions: failureEvidence?.nextActions?.length ? failureEvidence.nextActions : ["检查外部服务配置、额度和返回格式后重新运行工作流。"],
  };
}
