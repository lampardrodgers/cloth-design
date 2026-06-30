import type { CommercialModel, WorkflowAsset, WorkflowAssetKind, WorkflowType } from "../types";

export interface FabricControls {
  pattern: string;
  color: string;
  fissionDimension: string;
  hemLength: string;
  hemLengthPercent: number;
  sleeveLength: string;
  sleeveLengthPercent: number;
  neckline: string;
  necklineDepthPercent: number;
  variants: number;
}

export interface FabricInputs {
  textDescription: string;
  garmentCategory: string;
  assets: WorkflowAsset[];
}

export interface VirtualModelControls {
  modelId: string;
  sceneId: string;
  poseId: string;
  motionPreview: boolean;
}

export interface VirtualModelInputs {
  sourceType: "garment" | "mannequin" | "designSketch";
  description: string;
  assets: WorkflowAsset[];
}

export interface PostprocessControls {
  actions: string[];
  targetColor: string;
  targetRatio: string;
  targetScenes: string[];
  eraseTarget: string;
  lightStrength: number;
  beautyLevel: number;
  repairFocus: string;
}

export interface PostprocessInputs {
  assets: WorkflowAsset[];
}

interface OptionItem {
  id: string;
  label: string;
  prompt: string;
}

export interface ModelOptionItem extends OptionItem {
  ethnicity: string;
  ageGroup: string;
  bodyType: string;
  gender: string;
  commercialUse: boolean;
  poses: string[];
}

export type ModelCollectionFilter = "all" | "child" | "plus" | "senior" | "menswear" | "womenswear" | "diverse";

export type DemoAssetFactory = (kind: WorkflowAssetKind, name: string, note?: string) => WorkflowAsset;

export const fabricPatternOptions: OptionItem[] = [
  { id: "jacquard", label: "提花", prompt: "丝感提花" },
  { id: "stripe", label: "条纹", prompt: "细条纹" },
  { id: "floral", label: "碎花", prompt: "碎花印花" },
  { id: "solid", label: "净色", prompt: "净色斜纹" },
  { id: "check", label: "格纹", prompt: "经典格纹" },
  { id: "geometric", label: "几何", prompt: "几何印花" },
  { id: "animal", label: "动物纹", prompt: "动物纹理" },
  { id: "tie-dye", label: "扎染", prompt: "扎染渐变" },
  { id: "polka", label: "波点", prompt: "波点印花" },
];

export const fabricColorOptions: OptionItem[] = [
  { id: "moss", label: "苔绿", prompt: "苔绿色" },
  { id: "ivory", label: "象牙白", prompt: "象牙白" },
  { id: "butter", label: "黄油黄", prompt: "黄油黄" },
  { id: "soft-pink", label: "藕粉", prompt: "藕粉色" },
  { id: "mist-blue", label: "雾霾蓝", prompt: "雾霾蓝" },
  { id: "wine", label: "酒红", prompt: "酒红色" },
  { id: "navy", label: "藏青", prompt: "藏青色" },
  { id: "charcoal", label: "炭灰", prompt: "炭灰色" },
  { id: "khaki", label: "卡其", prompt: "卡其色" },
  { id: "black", label: "经典黑", prompt: "纯黑色" },
];

/**
 * 裂变维度：模块一"款式裂变"按哪个方向生成多个变体。
 * 默认配色裂变（最适合测款）。
 */
export const fissionDimensionOptions: OptionItem[] = [
  { id: "color", label: "配色裂变", prompt: "按配色裂变，每个变体换主色调" },
  { id: "pattern", label: "印花裂变", prompt: "按印花裂变，每个变体换花型" },
  { id: "silhouette", label: "版型裂变", prompt: "按版型细节裂变，调整衣长/袖长/领口比例" },
  { id: "mix", label: "综合裂变", prompt: "综合配色与版型细节裂变" },
];

export const hemLengthOptions: OptionItem[] = [
  { id: "mini", label: "短裙摆", prompt: "短裙摆" },
  { id: "midi", label: "中长裙摆", prompt: "中长裙摆" },
  { id: "maxi", label: "长裙摆", prompt: "长裙摆" },
];

export const sleeveLengthOptions: OptionItem[] = [
  { id: "sleeveless", label: "无袖", prompt: "无袖" },
  { id: "short", label: "短袖", prompt: "短袖" },
  { id: "three-quarter", label: "七分袖", prompt: "七分袖" },
  { id: "long", label: "长袖", prompt: "长袖" },
];

export const necklineOptions: OptionItem[] = [
  { id: "square", label: "方领", prompt: "方领" },
  { id: "v-neck", label: "V领", prompt: "V领" },
  { id: "crew", label: "圆领", prompt: "圆领" },
  { id: "shirt", label: "衬衫领", prompt: "衬衫领" },
  { id: "one-shoulder", label: "一字领", prompt: "一字领" },
  { id: "ruffle", label: "荷叶领", prompt: "荷叶领" },
  { id: "stand", label: "立领", prompt: "立领" },
];

export const modelControlOptions: ModelOptionItem[] = [
  { id: "child-east-asian-01", label: "儿童模特", prompt: "儿童模特", ethnicity: "east-asian", ageGroup: "child", bodyType: "standard", gender: "female", commercialUse: true, poses: ["standing", "walking"] },
  { id: "adult-east-asian-01", label: "东亚成年女模特", prompt: "东亚成年女模特", ethnicity: "east-asian", ageGroup: "adult", bodyType: "standard", gender: "female", commercialUse: true, poses: ["standing", "walking", "turnaround"] },
  { id: "black-adult-01", label: "黑人成年女模特", prompt: "黑人成年女模特", ethnicity: "black", ageGroup: "adult", bodyType: "standard", gender: "female", commercialUse: true, poses: ["standing", "walking", "turnaround"] },
  { id: "south-asian-adult-01", label: "南亚成年女模特", prompt: "南亚成年女模特", ethnicity: "south-asian", ageGroup: "adult", bodyType: "standard", gender: "female", commercialUse: true, poses: ["standing", "walking"] },
  { id: "latinx-adult-01", label: "拉美女模特", prompt: "拉美女模特", ethnicity: "latinx", ageGroup: "adult", bodyType: "standard", gender: "female", commercialUse: true, poses: ["standing", "walking", "turnaround"] },
  { id: "middle-eastern-adult-01", label: "中东男模特", prompt: "中东男模特", ethnicity: "middle-eastern", ageGroup: "adult", bodyType: "standard", gender: "male", commercialUse: true, poses: ["standing", "walking"] },
  { id: "plus-global-01", label: "大码模特", prompt: "大码模特", ethnicity: "global", ageGroup: "adult", bodyType: "plus", gender: "female", commercialUse: true, poses: ["standing", "seated", "turnaround"] },
  { id: "plus-male-global-01", label: "大码男模特", prompt: "大码男模特", ethnicity: "global", ageGroup: "adult", bodyType: "plus", gender: "male", commercialUse: true, poses: ["standing", "walking"] },
  { id: "plus-south-asian-01", label: "南亚大码女模特", prompt: "南亚大码女模特", ethnicity: "south-asian", ageGroup: "adult", bodyType: "plus", gender: "female", commercialUse: true, poses: ["standing", "walking", "turnaround"] },
  { id: "plus-black-male-01", label: "黑人大码男模特", prompt: "黑人大码男模特", ethnicity: "black", ageGroup: "adult", bodyType: "plus", gender: "male", commercialUse: true, poses: ["standing", "walking"] },
  { id: "menswear-global-01", label: "男装模特", prompt: "男装模特", ethnicity: "global", ageGroup: "adult", bodyType: "standard", gender: "male", commercialUse: true, poses: ["standing", "walking"] },
  { id: "south-asian-male-01", label: "南亚男装模特", prompt: "南亚男装模特", ethnicity: "south-asian", ageGroup: "adult", bodyType: "standard", gender: "male", commercialUse: true, poses: ["standing", "walking"] },
  { id: "latinx-male-01", label: "拉美男装模特", prompt: "拉美男装模特", ethnicity: "latinx", ageGroup: "adult", bodyType: "standard", gender: "male", commercialUse: true, poses: ["standing", "walking", "turnaround"] },
  { id: "middle-eastern-female-01", label: "中东女模特", prompt: "中东女模特", ethnicity: "middle-eastern", ageGroup: "adult", bodyType: "standard", gender: "female", commercialUse: true, poses: ["standing", "walking", "turnaround"] },
  { id: "child-black-01", label: "黑人儿童模特", prompt: "黑人儿童模特", ethnicity: "black", ageGroup: "child", bodyType: "standard", gender: "female", commercialUse: true, poses: ["standing", "walking"] },
  { id: "child-latinx-01", label: "拉美儿童模特", prompt: "拉美儿童模特", ethnicity: "latinx", ageGroup: "child", bodyType: "standard", gender: "male", commercialUse: true, poses: ["standing", "walking"] },
  { id: "senior-global-01", label: "熟龄模特", prompt: "熟龄模特", ethnicity: "global", ageGroup: "senior", bodyType: "standard", gender: "female", commercialUse: true, poses: ["standing", "turnaround"] },
  { id: "senior-male-global-01", label: "熟龄男模特", prompt: "熟龄男模特", ethnicity: "global", ageGroup: "senior", bodyType: "standard", gender: "male", commercialUse: true, poses: ["standing", "turnaround"] },
  { id: "senior-east-asian-male-01", label: "东亚熟龄男模特", prompt: "东亚熟龄男模特", ethnicity: "east-asian", ageGroup: "senior", bodyType: "standard", gender: "male", commercialUse: true, poses: ["standing", "turnaround"] },
  { id: "senior-black-female-01", label: "黑人熟龄女模特", prompt: "黑人熟龄女模特", ethnicity: "black", ageGroup: "senior", bodyType: "standard", gender: "female", commercialUse: true, poses: ["standing", "turnaround"] },
];

export const modelCollectionFilterOptions: Array<{ id: ModelCollectionFilter; label: string }> = [
  { id: "all", label: "全部模特" },
  { id: "child", label: "儿童" },
  { id: "plus", label: "大码" },
  { id: "senior", label: "熟龄" },
  { id: "menswear", label: "男装" },
  { id: "womenswear", label: "女装" },
  { id: "diverse", label: "多元人种" },
];

export const sceneControlOptions: OptionItem[] = [
  { id: "studio", label: "棚拍", prompt: "干净棚拍纯色背景" },
  { id: "city", label: "城市街拍", prompt: "城市街景" },
  { id: "forest", label: "森林", prompt: "森林场景" },
  { id: "grassland", label: "草地", prompt: "草地场景" },
  { id: "beach", label: "海滩", prompt: "海滩场景" },
  { id: "indoor", label: "室内", prompt: "室内家居场景" },
  { id: "cafe", label: "咖啡馆", prompt: "咖啡馆场景" },
  { id: "minimal-white", label: "极简白底", prompt: "极简纯白背景" },
];

export const poseControlOptions: OptionItem[] = [
  { id: "walking", label: "行走", prompt: "行走姿势" },
  { id: "standing", label: "站立", prompt: "站立姿势" },
  { id: "turnaround", label: "转身", prompt: "转身姿势" },
];

export const virtualSourceOptions: Array<OptionItem & { kind: VirtualModelInputs["sourceType"] }> = [
  { id: "garment", kind: "garment", label: "平铺图", prompt: "平铺服装图" },
  { id: "mannequin", kind: "mannequin", label: "人台图", prompt: "人台图" },
  { id: "designSketch", kind: "designSketch", label: "设计图", prompt: "设计图" },
];

export const postprocessActionOptions: OptionItem[] = [
  { id: "cutout", label: "智能抠图", prompt: "智能抠图" },
  { id: "enhance", label: "补光增强", prompt: "补光增强" },
  { id: "repair", label: "手部修复", prompt: "手部修复" },
  { id: "erase", label: "对象擦除", prompt: "对象擦除" },
  { id: "recolor", label: "智能重色", prompt: "智能重色" },
  { id: "resize", label: "比例调整", prompt: "调整比例" },
];

export const targetColorOptions: OptionItem[] = [
  { id: "ivory", label: "象牙白", prompt: "象牙白" },
  { id: "sage", label: "鼠尾草绿", prompt: "鼠尾草绿" },
  { id: "butter", label: "黄油黄", prompt: "黄油黄" },
  { id: "soft-pink", label: "藕粉", prompt: "藕粉色" },
  { id: "mist-blue", label: "雾霾蓝", prompt: "雾霾蓝" },
  { id: "wine", label: "酒红", prompt: "酒红色" },
  { id: "navy", label: "藏青", prompt: "藏青色" },
  { id: "charcoal", label: "炭灰", prompt: "炭灰色" },
  { id: "black", label: "经典黑", prompt: "纯黑色" },
  { id: "original", label: "保留原色", prompt: "保留原色" },
];

export const targetRatioOptions: OptionItem[] = [
  { id: "1:1", label: "1:1", prompt: "1:1" },
  { id: "4:5", label: "4:5", prompt: "4:5" },
  { id: "3:4", label: "3:4", prompt: "3:4" },
  { id: "2:3", label: "2:3", prompt: "2:3" },
  { id: "3:2", label: "3:2", prompt: "3:2" },
  { id: "16:9", label: "16:9", prompt: "16:9" },
  { id: "9:16", label: "9:16", prompt: "9:16" },
];

export const postprocessSceneOptions: OptionItem[] = [
  { id: "studio", label: "棚拍", prompt: "棚拍场景" },
  { id: "city", label: "城市", prompt: "城市街景" },
  { id: "grassland", label: "草地", prompt: "草地场景" },
  { id: "beach", label: "海滩", prompt: "海滩场景" },
  { id: "indoor", label: "室内", prompt: "室内家居场景" },
  { id: "cafe", label: "咖啡馆", prompt: "咖啡馆场景" },
  { id: "minimal-white", label: "极简白底", prompt: "极简纯白背景" },
];

export const postprocessRepairFocusOptions: OptionItem[] = [
  { id: "hands", label: "手部", prompt: "手部修复" },
  { id: "body", label: "身形", prompt: "美体修正" },
  { id: "garment", label: "服装细节", prompt: "服装细节修复" },
];

export const defaultFabricControls: FabricControls = {
  pattern: "jacquard",
  color: "moss",
  fissionDimension: "color",
  hemLength: "midi",
  hemLengthPercent: 68,
  sleeveLength: "short",
  sleeveLengthPercent: 35,
  neckline: "square",
  necklineDepthPercent: 24,
  variants: 2,
};

export const defaultFabricInputs: FabricInputs = {
  textDescription: "",
  garmentCategory: "dress",
  assets: [],
};

export const defaultVirtualModelControls: VirtualModelControls = {
  modelId: "child-east-asian-01",
  sceneId: "studio",
  poseId: "walking",
  motionPreview: true,
};

export const defaultVirtualModelInputs: VirtualModelInputs = {
  sourceType: "garment",
  description: "",
  assets: [],
};

export const defaultPostprocessControls: PostprocessControls = {
  actions: ["cutout", "enhance", "repair", "erase", "recolor", "resize"],
  targetColor: "ivory",
  targetRatio: "4:5",
  targetScenes: ["studio"],
  eraseTarget: "画面杂物",
  lightStrength: 60,
  beautyLevel: 35,
  repairFocus: "hands",
};

export const defaultPostprocessInputs: PostprocessInputs = {
  assets: [],
};

function findOption(options: OptionItem[], id: string, fallbackId = options[0]?.id) {
  return options.find((item) => item.id === id) ?? options.find((item) => item.id === fallbackId) ?? options[0];
}

/**
 * 解析"可自定义"字段：ComboBox 允许用户输入候选项之外的值。
 * 命中候选项时返回该候选项；未命中时保留用户原文（构造为 OptionItem），
 * 确保自定义值（如场景"海边"、模特自定义关键词）能进入 prompt，而不是被静默丢弃。
 */
function resolveOptionOrCustom(options: OptionItem[], idOrText: string): OptionItem {
  const matched = options.find((item) => item.id === idOrText || item.label === idOrText);
  if (matched) return matched;
  const trimmed = String(idOrText ?? "").trim();
  if (trimmed.length === 0) return options[0];
  return { id: trimmed, label: trimmed, prompt: trimmed };
}

export function findModelOption(id: string) {
  return findModelOptionFrom(modelControlOptions, id);
}

function findModelOptionFrom(options: ModelOptionItem[], id: string) {
  return options.find((item) => item.id === id) ?? options.find((item) => item.id === defaultVirtualModelControls.modelId) ?? options[0] ?? modelControlOptions[0];
}

export function commercialModelsToModelOptions(models: CommercialModel[] = []): ModelOptionItem[] {
  return models
    .filter((model) => model.id && model.name && model.commercialUse)
    .map((model) => ({
      id: model.id,
      label: model.name,
      prompt: model.name,
      ethnicity: model.ethnicity,
      ageGroup: model.ageGroup,
      bodyType: model.bodyType,
      gender: model.gender,
      commercialUse: model.commercialUse,
      poses: Array.isArray(model.poses) ? model.poses : [],
    }));
}

export function modelCollectionFilterLabel(filterId: string) {
  return modelCollectionFilterOptions.find((option) => option.id === filterId)?.label ?? modelCollectionFilterOptions[0].label;
}

export function filteredModelOptions(filterId: string, options: ModelOptionItem[] = modelControlOptions) {
  const filter = modelCollectionFilterOptions.some((option) => option.id === filterId) ? filterId : "all";
  const source = options.length > 0 ? options : modelControlOptions;
  if (filter === "child") return source.filter((model) => model.ageGroup === "child");
  if (filter === "plus") return source.filter((model) => model.bodyType === "plus");
  if (filter === "senior") return source.filter((model) => model.ageGroup === "senior");
  if (filter === "menswear") return source.filter((model) => model.gender === "male");
  if (filter === "womenswear") return source.filter((model) => model.gender === "female");
  if (filter === "diverse") return source.filter((model) => !["east-asian", "global"].includes(model.ethnicity));
  return source;
}

export function compatiblePoseOptions(modelId: string, options: ModelOptionItem[] = modelControlOptions) {
  const model = findModelOptionFrom(options.length > 0 ? options : modelControlOptions, modelId);
  const poseOptions = (model?.poses ?? [])
    .map((poseId) => poseControlOptions.find((pose) => pose.id === poseId))
    .filter((pose): pose is OptionItem => Boolean(pose));
  return poseOptions.length > 0 ? poseOptions : poseControlOptions.slice(0, 1);
}

export function modelProfileText(modelId: string, options: ModelOptionItem[] = modelControlOptions) {
  const model = findModelOptionFrom(options.length > 0 ? options : modelControlOptions, modelId);
  const ethnicityLabels: Record<string, string> = {
    "east-asian": "东亚",
    black: "黑人",
    "south-asian": "南亚",
    latinx: "拉美",
    "middle-eastern": "中东",
    global: "全球",
  };
  const ageLabels: Record<string, string> = {
    child: "儿童",
    adult: "成年",
    senior: "熟龄",
  };
  const bodyLabels: Record<string, string> = {
    standard: "标准",
    plus: "大码",
  };
  const genderLabels: Record<string, string> = {
    female: "女",
    male: "男",
  };
  const profile = [ethnicityLabels[model.ethnicity] ?? model.ethnicity, ageLabels[model.ageGroup] ?? model.ageGroup, bodyLabels[model.bodyType] ?? model.bodyType, genderLabels[model.gender] ?? model.gender].join("/");
  return `${model.label} · ${profile}${model.commercialUse ? " · 可商用" : ""}`;
}

function clampVariants(value: number) {
  if (!Number.isFinite(value)) return defaultFabricControls.variants;
  return Math.min(Math.max(Math.trunc(value), 1), 8);
}

/**
 * 统一商业出图质量约束（喂给 gpt-image-2），与 src/lib/prompt.ts 口径一致。
 * 保证版型/缝线/扣件/人体比例准确，避免水印文字、畸形手指等常见缺陷，
 * 输出可直接用于电商主图。三个工作流共用，提升真实出图质量。
 */
const COMMERCIAL_QUALITY_PROMPT =
  "画面干净、构图明确、电商主图质感；优先保证服装版型、面料纹理、颜色、缝线、扣件、领口和人体比例准确；避免多余文字、水印、水印、畸形手指、错误衣领、错乱纽扣或不合理褶皱。";

function clampPercent(value: number, fallback: number) {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(Math.max(Math.round(value), 0), 100);
}

function selectedActions(actions: string[]) {
  const selected = postprocessActionOptions.filter((option) => actions.includes(option.id)).map((option) => option.id);
  return selected.length > 0 ? selected : ["cutout"];
}

function selectedScenes(scenes: string[] = defaultPostprocessControls.targetScenes) {
  const selected = postprocessSceneOptions.filter((option) => scenes.includes(option.id)).map((option) => option.id);
  return selected.length > 0 ? selected : defaultPostprocessControls.targetScenes;
}

export function postprocessBatchPreviewText(
  controls: Pick<PostprocessControls, "actions" | "targetScenes">,
  inputCount: number,
) {
  const actions = selectedActions(controls.actions);
  const scenes = selectedScenes(controls.targetScenes);
  const safeInputCount = Math.max(1, Math.trunc(Number.isFinite(inputCount) ? inputCount : 1));
  const actionLabels = postprocessActionOptions.filter((option) => actions.includes(option.id)).map((option) => option.label);
  return `预计输出 ${safeInputCount * scenes.length} 张 · 输入${safeInputCount} · 场景${scenes.length} · ${actionLabels.join("/")}`;
}

export function virtualSourceFallbackLabel(sourceType: VirtualModelInputs["sourceType"]) {
  const source = virtualSourceOptions.find((option) => option.kind === sourceType) ?? virtualSourceOptions[0];
  return `默认${source.label}素材`;
}

function defaultVirtualSourceAsset(sourceType: OptionItem & { kind: VirtualModelInputs["sourceType"] }, createDemoAsset: DemoAssetFactory) {
  if (sourceType.kind === "mannequin") return createDemoAsset("mannequin", "mannequin-source.png", "人台图 garment mannequin reference");
  if (sourceType.kind === "designSketch") return createDemoAsset("designSketch", "design-sketch-source.png", "设计图 garment design sketch");
  return createDemoAsset("garment", "kids-dress-flatlay.png", "kids dress flat lay");
}

function cleanText(value: string, max = 280) {
  return String(value || "").trim().replace(/\s+/g, " ").slice(0, max);
}

function fabricInputSummary(assets: WorkflowAsset[], textDescription: string) {
  const hasFabric = assets.some((asset) => asset.kind === "fabric");
  const hasSketch = assets.some((asset) => asset.kind === "sketch");
  const inputModes = [
    hasFabric ? "面料图片" : "",
    hasSketch ? "设计草图" : "",
    textDescription ? "文字描述" : "",
  ].filter(Boolean);
  return {
    textDescription,
    assetNames: assets.map((asset) => asset.name),
    assetKinds: ["fabric", "sketch"].filter((kind) => assets.some((asset) => asset.kind === kind)),
    inputModes,
  };
}

export function buildWorkflowPayload(
  type: WorkflowType,
  {
    createDemoAsset,
    reusablePostprocessAssets = [],
    fabricControls = defaultFabricControls,
    fabricInputs = defaultFabricInputs,
    virtualModelControls = defaultVirtualModelControls,
    virtualModelInputs = defaultVirtualModelInputs,
    modelOptions = modelControlOptions,
    postprocessControls = defaultPostprocessControls,
    postprocessInputs = defaultPostprocessInputs,
  }: {
    createDemoAsset: DemoAssetFactory;
    reusablePostprocessAssets?: WorkflowAsset[];
    fabricControls?: FabricControls;
    fabricInputs?: FabricInputs;
    virtualModelControls?: VirtualModelControls;
    virtualModelInputs?: VirtualModelInputs;
    modelOptions?: ModelOptionItem[];
    postprocessControls?: PostprocessControls;
    postprocessInputs?: PostprocessInputs;
  },
) {
  if (type === "fabric-to-style") {
    const pattern = findOption(fabricPatternOptions, fabricControls.pattern, defaultFabricControls.pattern);
    const color = resolveOptionOrCustom(fabricColorOptions, fabricControls.color);
    const fission = findOption(fissionDimensionOptions, fabricControls.fissionDimension, defaultFabricControls.fissionDimension);
    const hemLength = findOption(hemLengthOptions, fabricControls.hemLength, defaultFabricControls.hemLength);
    const sleeveLength = findOption(sleeveLengthOptions, fabricControls.sleeveLength, defaultFabricControls.sleeveLength);
    const neckline = findOption(necklineOptions, fabricControls.neckline, defaultFabricControls.neckline);
    const variants = clampVariants(fabricControls.variants);
    const hemLengthPercent = clampPercent(fabricControls.hemLengthPercent, defaultFabricControls.hemLengthPercent);
    const sleeveLengthPercent = clampPercent(fabricControls.sleeveLengthPercent, defaultFabricControls.sleeveLengthPercent);
    const necklineDepthPercent = clampPercent(fabricControls.necklineDepthPercent, defaultFabricControls.necklineDepthPercent);
    const textDescription = cleanText(fabricInputs.textDescription);
    const garmentCategory = cleanText(fabricInputs.garmentCategory, 40) || "dress";
    const assets =
      fabricInputs.assets.length > 0
        ? fabricInputs.assets
        : [
            createDemoAsset("fabric", `${color.id}-${pattern.id}.png`, `${color.prompt} ${pattern.prompt} fabric`),
            createDemoAsset("sketch", `${neckline.id}-sketch.png`, `${neckline.prompt} ${hemLength.prompt} ${sleeveLength.prompt} ${garmentCategory} sketch`),
          ];
    const inputSummary = fabricInputSummary(assets, textDescription);
    const inputModeText = inputSummary.inputModes.length ? `多模态输入：${inputSummary.inputModes.join("、")}。` : "";
    return {
      type,
      title: "面料到款式智能生成",
      prompt: `${inputModeText}${color.prompt}${pattern.prompt}面料，生成${garmentCategory === "dress" ? "春夏通勤连衣裙" : garmentCategory}，支持${neckline.prompt}、${hemLength.prompt}和${sleeveLength.prompt}细节，精细控制衣长${hemLengthPercent}%、袖长${sleeveLengthPercent}%、领口开度${necklineDepthPercent}%。${fission.prompt}，输出 ${variants} 个可比较变体。${textDescription ? `补充需求：${textDescription}。` : ""}${COMMERCIAL_QUALITY_PROMPT}`,
      assets,
      options: {
        garmentCategory,
        variants,
        fissionDimension: fission.id,
        editControls: {
          hemLength: hemLength.id,
          hemLengthPercent,
          sleeveLength: sleeveLength.id,
          sleeveLengthPercent,
          neckline: neckline.id,
          necklineDepthPercent,
          pattern: pattern.id,
          color: color.id,
        },
        inputSummary,
      },
    };
  }

  if (type === "virtual-model-showcase") {
    const availableModels = modelOptions.length > 0 ? modelOptions : modelControlOptions;
    const model = findModelOptionFrom(availableModels, virtualModelControls.modelId);
    // 展示场景无模型依赖：用 resolveOptionOrCustom 保留自定义场景文本（如"海边"），而非丢弃。
    const scene = resolveOptionOrCustom(sceneControlOptions, virtualModelControls.sceneId);
    // 模特姿势与所选模特绑定：若用户值是该模特支持的姿势则直接用；
    // 若是"已知但与此模特不兼容"的姿势（如转身 vs 不支持转身的中东模特），回退到该模特支持的姿势（安全网）；
    // 若是用户真正自定义的姿势文本（非任何已知姿势），则保留并注入 prompt。
    const poseOptions = compatiblePoseOptions(model.id, availableModels);
    const knownPoseIds = new Set(poseControlOptions.map((option) => option.id));
    const pose =
      poseOptions.some((option) => option.id === virtualModelControls.poseId)
        ? findOption(poseOptions, virtualModelControls.poseId, poseOptions[0]?.id)
        : knownPoseIds.has(virtualModelControls.poseId)
          ? poseOptions[0]
          : resolveOptionOrCustom(poseOptions.length > 0 ? poseOptions : poseControlOptions, virtualModelControls.poseId);
    const sourceType = virtualSourceOptions.find((option) => option.kind === virtualModelInputs.sourceType) ?? virtualSourceOptions[0];
    const description = cleanText(virtualModelInputs.description);
    const assets = virtualModelInputs.assets.length > 0 ? virtualModelInputs.assets : [defaultVirtualSourceAsset(sourceType, createDemoAsset)];
    const motionPreview = virtualModelControls.motionPreview !== false;
    return {
      type,
      title: "虚拟模特智能展示",
      prompt: `上传${sourceType.prompt}，穿到${model.prompt}身上，${scene.prompt}，切换为${pose.prompt}，输出逼真的上身展示图。${motionPreview ? "并生成该姿势的动效预览。" : ""}${description ? `服装要求：${description}。` : ""}${COMMERCIAL_QUALITY_PROMPT}`,
      assets,
      options: {
        modelId: model.id,
        sceneId: scene.id,
        poseId: pose.id,
        sourceType: sourceType.id,
        makeVideo: motionPreview,
        motionPreview,
      },
    };
  }

  if (type === "postprocess-suite") {
    const actions = selectedActions(postprocessControls.actions);
    const actionText = postprocessActionOptions.filter((option) => actions.includes(option.id)).map((option) => option.prompt).join("、");
    const targetColor = findOption(targetColorOptions, postprocessControls.targetColor, defaultPostprocessControls.targetColor);
    const targetRatio = findOption(targetRatioOptions, postprocessControls.targetRatio, defaultPostprocessControls.targetRatio);
    const scenes = selectedScenes(postprocessControls.targetScenes);
    const sceneText = postprocessSceneOptions.filter((option) => scenes.includes(option.id)).map((option) => option.prompt).join("、");
    const repairFocus = findOption(postprocessRepairFocusOptions, postprocessControls.repairFocus, defaultPostprocessControls.repairFocus);
    const postprocessTuning = {
      eraseTarget: cleanText(postprocessControls.eraseTarget, 80) || defaultPostprocessControls.eraseTarget,
      lightStrength: clampPercent(postprocessControls.lightStrength, defaultPostprocessControls.lightStrength),
      beautyLevel: clampPercent(postprocessControls.beautyLevel, defaultPostprocessControls.beautyLevel),
      repairFocus: repairFocus.id,
      repairFocusLabel: repairFocus.label,
    };
    const assets =
      postprocessInputs.assets.length > 0
        ? postprocessInputs.assets
        : reusablePostprocessAssets.length > 0
        ? reusablePostprocessAssets
        : [createDemoAsset("result", "look-1.png", "product model image one"), createDemoAsset("result", "look-2.png", "product model image two")];
    return {
      type,
      title: "图像后期批量处理",
      prompt: `${reusablePostprocessAssets.length > 0 && postprocessInputs.assets.length === 0 ? "基于前面真实生成的商品图" : "商品图"}批量执行${actionText}，目标颜色${targetColor.prompt}，输出比例${targetRatio.prompt}，场景输出${sceneText}。擦除目标${postprocessTuning.eraseTarget}，补光${postprocessTuning.lightStrength}%，美体${postprocessTuning.beautyLevel}%，修复重点${postprocessTuning.repairFocusLabel}。${COMMERCIAL_QUALITY_PROMPT}`,
      assets,
      options: {
        actions,
        targetColor: targetColor.id,
        targetRatio: targetRatio.id,
        targetScenes: scenes,
        postprocessTuning,
      },
    };
  }

  return {
    type,
    title: "趋势测款与品牌专属模型",
    prompt: "分析春夏女装趋势，生成 3 个测款版本，并基于品牌历史图形成品牌 DNA。",
    assets: [createDemoAsset("brand", "brand-look-1.png", "clean tailoring brand look"), createDemoAsset("brand", "brand-look-2.png", "soft utility brand look")],
    options: {
      trendKeywords: ["butter yellow", "utility skirt", "lightweight linen"],
      marketVariants: 3,
      trainBrandProfile: true,
    },
  };
}
