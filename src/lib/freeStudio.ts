import type {
  AttachmentUsage,
  FreeAttachment,
  RatioOption,
  ReferenceImage,
  StudioSettings,
  SubmissionRecord,
} from "../types";

/** 附件最长边，避免把原始大图整张塞进 localStorage 和请求体。 */
export const ATTACHMENT_MAX_EDGE = 1280;
/** 图像引擎要求参考图最小 256x256，低于这个尺寸直接在前端拦下。 */
export const ATTACHMENT_MIN_EDGE = 256;
export const MAX_ATTACHMENTS = 10;

export const attachmentUsageLabels: Record<AttachmentUsage, string> = {
  reference: "参考",
  merge: "入画",
};

export const attachmentUsageHints: Record<AttachmentUsage, string> = {
  reference: "只借鉴风格、构图、配色和质感",
  merge: "图中主体必须出现在最终成片里",
};

function randomId(prefix: string) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

/* ────────────────────────────────────────────────────────────────────────────
 * 附件读取
 * ──────────────────────────────────────────────────────────────────────────── */

function loadImageElement(src: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("图片无法解码"));
    image.src = src;
  });
}

function readFileAsDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error("图片读取失败"));
    reader.readAsDataURL(file);
  });
}

/**
 * 把本地文件转成可持久化、可直接回传给图像引擎的附件。
 * 统一落成 data URL：画布刷新后依然可用，也能原样作为参考图再次上传。
 */
export async function fileToAttachment(file: File, usage: AttachmentUsage = "reference"): Promise<FreeAttachment> {
  if (!file.type.startsWith("image/")) {
    throw new Error(`${file.name} 不是图片文件`);
  }
  const originalDataUrl = await readFileAsDataUrl(file);
  const image = await loadImageElement(originalDataUrl);
  const naturalWidth = image.naturalWidth || 1;
  const naturalHeight = image.naturalHeight || 1;

  if (Math.min(naturalWidth, naturalHeight) < ATTACHMENT_MIN_EDGE) {
    throw new Error(`${file.name} 尺寸过小（${naturalWidth}×${naturalHeight}），最小需要 ${ATTACHMENT_MIN_EDGE}×${ATTACHMENT_MIN_EDGE}`);
  }

  const scale = Math.min(1, ATTACHMENT_MAX_EDGE / Math.max(naturalWidth, naturalHeight));
  let previewUrl = originalDataUrl;
  let width = naturalWidth;
  let height = naturalHeight;

  if (scale < 1) {
    width = Math.max(ATTACHMENT_MIN_EDGE, Math.round(naturalWidth * scale));
    height = Math.max(ATTACHMENT_MIN_EDGE, Math.round(naturalHeight * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (context) {
      context.drawImage(image, 0, 0, width, height);
      // PNG 保留透明通道（抠好的服装图常见），其余统一压成 JPEG 控制体积。
      previewUrl =
        file.type === "image/png" ? canvas.toDataURL("image/png") : canvas.toDataURL("image/jpeg", 0.92);
    }
  }

  return {
    id: randomId("att"),
    name: file.name,
    previewUrl,
    usage,
    width,
    height,
  };
}

export async function filesToAttachments(files: File[], usage: AttachmentUsage = "reference") {
  const attachments: FreeAttachment[] = [];
  const errors: string[] = [];
  for (const file of files) {
    try {
      attachments.push(await fileToAttachment(file, usage));
    } catch (error) {
      errors.push(error instanceof Error ? error.message : `${file.name} 读取失败`);
    }
  }
  return { attachments, errors };
}

/**
 * 生成时把附件还原成可上传的文件。data URL 走 multipart 上传，
 * 服务端已托管的 /generated-images/ 地址直接交给服务端自己读取。
 */
export async function attachmentToUploadFile(attachment: FreeAttachment): Promise<File | undefined> {
  if (attachment.file) return attachment.file;
  if (!attachment.previewUrl.startsWith("data:")) return undefined;
  const response = await fetch(attachment.previewUrl);
  const blob = await response.blob();
  const type = blob.type || "image/png";
  const extension = type.includes("jpeg") ? "jpg" : type.includes("webp") ? "webp" : "png";
  const name = /\.(png|jpe?g|webp)$/i.test(attachment.name) ? attachment.name : `${attachment.name || "reference"}.${extension}`;
  return new File([blob], name, { type });
}

export async function attachmentsToReferences(attachments: FreeAttachment[]): Promise<ReferenceImage[]> {
  const references: ReferenceImage[] = [];
  for (const [index, attachment] of attachments.entries()) {
    const file = await attachmentToUploadFile(attachment);
    references.push({
      id: attachment.id,
      label: String(index + 1),
      role: "style",
      note: attachment.annotated
        ? `带标注：图上的箭头和文字是修改指令，成片里不保留`
        : `${attachmentUsageLabels[attachment.usage]}：${attachmentUsageHints[attachment.usage]}`,
      fileName: attachment.name,
      previewUrl: attachment.previewUrl,
      file,
    });
  }
  return references;
}

/* ────────────────────────────────────────────────────────────────────────────
 * 提交存档
 * ──────────────────────────────────────────────────────────────────────────── */

/** 存档缩略图的长边。够认出是哪张图，又不至于把 localStorage 撑爆。 */
export const SUBMISSION_THUMB_EDGE = 128;
/** 最多留多少次提交记录（连着缩略图存的，不能无限涨）。 */
export const MAX_SUBMISSION_RECORDS = 20;

async function thumbnailDataUrl(previewUrl: string, edge = SUBMISSION_THUMB_EDGE) {
  try {
    const image = await loadImageElement(previewUrl);
    const naturalWidth = image.naturalWidth || edge;
    const naturalHeight = image.naturalHeight || edge;
    const scale = Math.min(1, edge / Math.max(naturalWidth, naturalHeight));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(naturalHeight * scale));
    const context = canvas.getContext("2d");
    if (!context) return "";
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/jpeg", 0.72);
  } catch {
    // 缩略图失败不该拦住生成，回看时显示成一个空位就好。
    return "";
  }
}

/**
 * 把这次提交的现场存下来：描述、参考图缩略图、参数。
 * 简易模式提交完就清空输入框，全靠这份存档回答「我刚才提交的是什么」。
 */
export async function buildSubmissionRecord(input: {
  taskId: string;
  prompt: string;
  attachments: FreeAttachment[];
  ratioLabel: string;
  sizeLabel: string;
  quantity: number;
  settings: FreePromptSettings;
  createdAt: string;
}): Promise<SubmissionRecord> {
  const references = await Promise.all(
    input.attachments.map(async (attachment) => ({
      name: attachment.name,
      usage: attachment.usage,
      thumbUrl: await thumbnailDataUrl(attachment.previewUrl),
    })),
  );
  return {
    taskId: input.taskId,
    prompt: input.prompt,
    references,
    ratioLabel: input.ratioLabel,
    sizeLabel: input.sizeLabel,
    quantity: input.quantity,
    quality: input.settings.quality,
    outputFormat: input.settings.outputFormat,
    background: input.settings.background,
    inputFidelity: input.settings.inputFidelity,
    createdAt: input.createdAt,
  };
}

/* ────────────────────────────────────────────────────────────────────────────
 * 提示词
 * ──────────────────────────────────────────────────────────────────────────── */

export type FreePromptSettings = Pick<
  StudioSettings,
  "quality" | "outputFormat" | "background" | "inputFidelity"
>;

/**
 * 自由创作的提示词：不加服装行业的系统约束，只把「哪张图是参考、哪张图必须入画」
 * 说清楚，其余完全交给用户描述。
 */
export function buildFreePrompt(
  rawPrompt: string,
  attachments: FreeAttachment[],
  settings: FreePromptSettings,
) {
  const subject = rawPrompt.trim();
  const uploadOrder = attachments
    .map((attachment, index) => {
      const usage = attachmentUsageLabels[attachment.usage];
      const name = attachment.name ? `（${attachment.name}）` : "";
      const mark = attachment.annotated ? " · 带人工标注" : "";
      const note = attachment.note?.trim() ? ` · ${attachment.note.trim()}` : "";
      return `上传图片${index + 1} = ${usage}${name}${mark}${note}`;
    })
    .join("\n");

  const hasMerge = attachments.some((attachment) => attachment.usage === "merge");
  const hasReference = attachments.some((attachment) => attachment.usage === "reference");
  const hasAnnotated = attachments.some((attachment) => attachment.annotated);

  return [
    "模式: 自由生成（不限题材，按用户描述直接出图）",
    uploadOrder ? `上传图片顺序:\n${uploadOrder}` : "",
    hasMerge
      ? "入画图片要求: 图中主体必须真实出现在最终成片里，保持款式、颜色、材质、细节和比例一致，只允许调整光线、角度和构图让它自然融入画面。"
      : "",
    hasReference ? "参考图片要求: 只借鉴风格、构图、配色和质感，不要求原样复制其中的具体元素。" : "",
    hasAnnotated
      ? "带标注图片要求: 标注图上的箭头、线条、圈选和文字是人工写下的修改指令，不是画面内容。箭头指向哪里，修改就发生在哪里；成片里不得保留任何标注箭头、线条、圈选、文字、选中框或界面元素。"
      : "",
    `输出参数: ${settings.quality} quality, ${settings.outputFormat}, ${settings.background} background, ${settings.inputFidelity} input fidelity.`,
    `用户描述:\n${subject}`,
  ]
    .filter(Boolean)
    .join("\n\n");
}


/**
 * 按标注改图：把「原图 + 红色批注」的截图当成修改需求书交给图像引擎，
 * 要求它执行标注里的修改，并且输出里不能残留任何标注痕迹。
 */
export function buildAnnotationEditPrompt(userNote: string, settings: FreePromptSettings) {
  return [
    "模式: 自由生成（按标注改图）",
    "上传图片1 = 带人工标注的原图",
    "改图要求: 上传图片1 是一张被人工标注过的图。请把图中的箭头、线条、圈选和文字批注理解成修改指令，对底图执行这些修改。箭头指向哪里，修改就发生在哪里。",
    "输出要求: 只输出修改后的干净成片。不得保留任何标注箭头、线条、圈选、文字、选中框、控制点或界面元素。除标注明确要求改动的部分外，保持原图的主体、构图、比例、光线和风格不变。",
    userNote.trim() ? `补充说明:\n${userNote.trim()}` : "",
    `输出参数: ${settings.quality} quality, ${settings.outputFormat}, ${settings.background} background, ${settings.inputFidelity} input fidelity.`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

/* ────────────────────────────────────────────────────────────────────────────
 * 画布尺寸
 * ──────────────────────────────────────────────────────────────────────────── */

export function frameSizeForRatio(ratio: RatioOption | undefined, longEdge = 460) {
  const width = ratio?.width || 1;
  const height = ratio?.height || 1;
  if (width >= height) {
    return { w: longEdge, h: Math.round((longEdge * height) / width) };
  }
  return { w: Math.round((longEdge * width) / height), h: longEdge };
}

/** 从任意宽高找出最接近的可用出图比例，用于「按标注改图」保持原图比例。 */
export function nearestRatioId(width: number, height: number, ratios: RatioOption[]) {
  const target = width / Math.max(1, height);
  const usable = ratios.filter((ratio) => ratio.native && ratio.id !== "auto");
  if (!usable.length) return "1-1";
  return usable.reduce((best, ratio) => {
    const bestDelta = Math.abs(best.width / best.height - target);
    const delta = Math.abs(ratio.width / ratio.height - target);
    return delta < bestDelta ? ratio : best;
  }).id;
}

/**
 * 按草图生成：画布上手绘的线稿、方框和文字就是需求本身，
 * 让图像引擎照着它的构图和标注出一张成品，且不能把草稿痕迹画进结果。
 */
export function buildSketchPrompt(userNote: string, settings: FreePromptSettings) {
  return [
    "模式: 自由生成（按画布草图生成）",
    "上传图片1 = 画布上的手绘草图",
    "草图要求: 上传图片1 是一张手绘草图或示意图。请按它的构图、比例、位置关系和图中文字标注，生成一张完整的成品图片。图里的文字是对画面的描述，不是要画进图里的字。",
    "输出要求: 只输出成品图。不得保留任何草稿线条、参考线、网格、箭头、标注文字、选中框或界面元素。",
    userNote.trim() ? `补充说明:\n${userNote.trim()}` : "",
    `输出参数: ${settings.quality} quality, ${settings.outputFormat}, ${settings.background} background, ${settings.inputFidelity} input fidelity.`,
  ]
    .filter(Boolean)
    .join("\n\n");
}
