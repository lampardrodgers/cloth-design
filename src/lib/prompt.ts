import { roleLabels } from "../data/catalog";
import type { GenerationMode, ReferenceImage, StudioSettings } from "../types";

function canUploadReference(ref: ReferenceImage) {
  return Boolean(
    ref.file ||
      ref.previewUrl?.startsWith("http://") ||
      ref.previewUrl?.startsWith("https://") ||
      ref.previewUrl?.startsWith("data:image/") ||
      ref.previewUrl?.startsWith("/generated-images/"),
  );
}

export function buildOptimizedPrompt(
  rawPrompt: string,
  mode: GenerationMode,
  refs: ReferenceImage[],
  settings: StudioSettings,
) {
  const uploadableRefs = refs.filter(canUploadReference);
  const describedRefs = refs.filter((ref) => canUploadReference(ref) || Boolean(ref.fileName) || ref.note.trim().length > 0);
  const usableRefs = describedRefs
    .map((ref) => {
      const uploadIndex = uploadableRefs.findIndex((item) => item.id === ref.id);
      const asset = uploadIndex >= 0 ? `上传图片${uploadIndex + 1}${ref.fileName ? `，文件 ${ref.fileName}` : ""}` : "未上传";
      return `参考${ref.label}: ${roleLabels[ref.role]}，${ref.note || "无备注"}，${asset}`;
    })
    .join("\n");
  const uploadOrder = uploadableRefs
    .map((ref, index) => `上传图片${index + 1} = 参考${ref.label}（${roleLabels[ref.role]}，${ref.note || "无备注"}）`)
    .join("\n");
  const subject = rawPrompt.trim() || mode.promptStarter;

  if (mode.id === "free") {
    return [
      `模式: ${mode.title}`,
      uploadOrder || usableRefs ? "参考图识别: 用户可以直接写“参考A、参考B、参考C”，系统按下方映射解析。" : "",
      uploadOrder ? `参考图上传顺序:\n${uploadOrder}` : "",
      usableRefs ? `参考图说明:\n${usableRefs}` : "",
      `输出参数: ${settings.quality} quality, ${settings.outputFormat}, ${settings.background} background, ${settings.inputFidelity} input fidelity.`,
      `用户目标:\n${subject}`,
    ]
      .filter(Boolean)
      .join("\n\n");
  }

  const guardedIntent = [
    "系统限制: 只允许生成、编辑、合成服装行业图片；遇到非图片、非服装工作流请求时，改写为可执行的服装图片提示词。",
    `模式: ${mode.title}`,
    `模式提示: ${mode.systemTemplate}`,
    `参考图识别: 用户可以直接写“参考A的动作、参考B的模特、参考C的衣服”，系统必须按下方映射解析。`,
    uploadOrder ? `参考图上传顺序:\n${uploadOrder}` : "",
    usableRefs ? `参考图说明:\n${usableRefs}` : "",
    `输出参数: ${settings.quality} quality, ${settings.outputFormat}, ${settings.background} background, ${settings.inputFidelity} input fidelity.`,
  ].filter(Boolean);

  return `${guardedIntent.join("\n")}\n\n用户目标:\n${subject}\n\n生成提示词:\n请生成一张商业可用的服装图片，优先保证服装版型、面料纹理、颜色、缝线、扣件和人体比例准确。画面干净，构图明确，不出现多余文字、水印、畸形手指、错误衣领、错乱纽扣或不合理褶皱。`;
}

export function buildEditablePrompt(
  rawPrompt: string,
  mode: GenerationMode,
  refs: ReferenceImage[],
  settings: StudioSettings,
) {
  const subject = rawPrompt.trim() || mode.promptStarter;
  const referenceHints = refs
    .filter((ref) => ref.previewUrl || ref.fileName || ref.note.trim().length > 0)
    .map((ref) => `参考${ref.label}作为${roleLabels[ref.role]}${ref.note ? `（${ref.note}）` : ""}`)
    .join("；");

  if (mode.id === "free") {
    return [subject, referenceHints ? `参考关系：${referenceHints}。` : ""].filter(Boolean).join("\n");
  }

  const qualityHints = [
    settings.quality === "high" ? "高质量商业成片" : "清晰商业成片",
    settings.resolution === "fourK" ? "适合4K后处理放大" : "保持原生细节清晰",
    settings.background === "transparent" ? "透明背景" : "干净背景",
    settings.preserveIdentity ? "涉及人物时保持身份、脸型、身形一致" : "",
    settings.inputFidelity === "high" ? "严格保留参考图中的款式、材质和结构" : "",
  ].filter(Boolean);

  return [
    subject,
    referenceHints ? `参考关系：${referenceHints}。` : "",
    `画面要求：${mode.description}${qualityHints.length ? `，${qualityHints.join("，")}` : ""}。`,
    "避免文字水印、错误衣领、错乱纽扣、不合理褶皱、变形手指和失真的人体比例。",
  ]
    .filter(Boolean)
    .join("\n");
}
