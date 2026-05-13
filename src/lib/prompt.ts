import { roleLabels } from "../data/catalog";
import type { GenerationMode, ReferenceImage, StudioSettings } from "../types";

export function buildOptimizedPrompt(
  rawPrompt: string,
  mode: GenerationMode,
  refs: ReferenceImage[],
  settings: StudioSettings,
) {
  const usableRefs = refs
    .map((ref) => {
      const asset = ref.fileName ? `文件 ${ref.fileName}` : "未上传";
      return `参考${ref.label}: ${roleLabels[ref.role]}，${ref.note || "无备注"}，${asset}`;
    })
    .join("\n");

  const guardedIntent = [
    "系统限制: 只允许生成、编辑、合成服装行业图片；遇到非图片、非服装工作流请求时，改写为可执行的服装图片提示词。",
    `模式: ${mode.title}`,
    `模式提示: ${mode.systemTemplate}`,
    `参考图识别: 用户可以直接写“参考A的动作、参考B的模特、参考C的衣服”，系统必须按下方映射解析。`,
    usableRefs,
    `输出参数: ${settings.quality} quality, ${settings.outputFormat}, ${settings.background} background, ${settings.inputFidelity} input fidelity.`,
  ];

  const subject = rawPrompt.trim() || mode.promptStarter;

  return `${guardedIntent.join("\n")}\n\n用户目标:\n${subject}\n\n生成提示词:\n请生成一张商业可用的服装图片，优先保证服装版型、面料纹理、颜色、缝线、扣件和人体比例准确。画面干净，构图明确，不出现多余文字、水印、畸形手指、错误衣领、错乱纽扣或不合理褶皱。`;
}
