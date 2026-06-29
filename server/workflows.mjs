import { randomUUID } from "node:crypto";
import { requireAccount } from "./auth.mjs";
import { nowIso, runTransaction, sqlite } from "./db.mjs";
import {
  generatedImageStaticMount,
  analyzeFabricImageBuffer,
  persistGeneratedImage,
  readManagedGeneratedImage,
  repairCheckerboardTransparency,
  validateImageBuffer,
} from "./image-provider.mjs";
import { imageProviderHealth, summarizeProviderErrorText } from "./provider-health.mjs";
import { createMotionPreviewMp4, persistGeneratedVideo } from "./video-provider.mjs";
import { fetchWithTimeout, timeoutMsFromEnv } from "./timeouts.mjs";

export const WORKFLOW_DEFINITIONS = [
  {
    id: "fabric-to-style",
    title: "面料到款式",
    inputTypes: ["fabricImage", "textDescription", "sketch"],
    outputTypes: ["fabricAnalysis", "styleRecommendation", "styleVariant"],
    capabilities: ["vision.analyze", "style.recommend", "image.generate", "image.edit"],
    capabilityStatus: [
      { id: "vision.analyze", label: "面料解析", status: "live", note: "已从面料图片提取颜色、图案、纹理，并结合文字和草图生成解析证据。" },
      { id: "style.recommend", label: "款式匹配", status: "live", note: "已根据面料解析、服装品类和编辑控制生成推荐版型、配色与匹配理由。" },
      { id: "image.generate", label: "款式裂变", status: "live", note: "已接入图像模型生成款式变体。" },
      { id: "image.edit", label: "素材驱动编辑", status: "live", note: "有图片素材时走 image edit，并记录素材约束质量门槛。" },
    ],
  },
  {
    id: "virtual-model-showcase",
    title: "虚拟模特",
    inputTypes: ["flatLay", "mannequin", "designSketch"],
    outputTypes: ["tryOnImage", "sceneImage", "motionStoryboard"],
    capabilities: ["image.edit", "model.select", "scene.render", "video.storyboard", "video.previewMp4"],
    capabilityStatus: [
      { id: "image.edit", label: "服装参考上身", status: "live", note: "已接入 image edit，使用服装素材作为视觉参考。" },
      { id: "model.select", label: "虚拟模特库", status: "live", note: "已内置可商用虚拟模特画像，覆盖多人种、儿童、大码、熟龄与不同性别，并写入真实上身图 prompt。" },
      { id: "scene.render", label: "场景动作", status: "live", note: "已通过图像模型生成场景化静态图。" },
      { id: "video.storyboard", label: "短视频分镜", status: "preview", note: "当前生成分镜和封面。" },
      { id: "video.previewMp4", label: "MP4 动效预览", status: "live", note: "已使用上身图生成可播放 MP4 预览，不替代 AI 行走视频。" },
      { id: "video.mp4", label: "真实 MP4 视频", status: "requires_service", note: "需要接入视频生成服务后才算完整视频能力。" },
    ],
  },
  {
    id: "postprocess-suite",
    title: "后期处理",
    inputTypes: ["generatedImage", "modelImage", "garmentImage"],
    outputTypes: ["cutout", "enhancedImage", "repairedImage", "recoloredImage", "batch"],
    capabilities: ["image.segment", "image.enhance", "image.inpaint", "image.recolor", "image.resize", "batch"],
    capabilityStatus: [
      { id: "image.edit", label: "通用后期编辑", status: "live", note: "已接入 image edit，保留主体并修改背景、光线、颜色和画幅。" },
      { id: "image.segment", label: "基础智能抠图", status: "live", note: "已接入 image edit 透明 alpha 输出校验，并在白底/棋盘格背景时执行本地 alpha 修复。" },
      { id: "image.enhance", label: "图片美化增强", status: "live", note: "已将补光强度、美体强度和画质增强要求写入 image edit 后期 prompt。" },
      { id: "image.inpaint", label: "细节修复擦除", status: "live", note: "已支持手部/身形/服装细节修复和对象擦除目标，并写入批量后期 prompt。" },
      { id: "image.recolor", label: "智能重色", status: "live", note: "已支持目标颜色控制，批量后期会按象牙白、鼠尾草绿或原色保留执行重色。" },
      { id: "image.resize", label: "比例调整", status: "live", note: "已支持 4:5、3:4、1:1 输出比例控制，并写入每张批量结果元数据。" },
      { id: "image.segment.precise", label: "像素级精准抠图", status: "requires_service", note: "需要接入专用分割/抠图服务。" },
      { id: "batch", label: "批量处理", status: "live", note: "后端会为每张输入图生成独立结果。" },
    ],
  },
  {
    id: "trend-brand-lab",
    title: "趋势与品牌",
    inputTypes: ["trendKeywords", "brandImages", "marketVariants"],
    outputTypes: ["trendAnalysis", "marketTest", "brandProfile"],
    capabilities: ["trendAnalysis", "marketTesting", "brandTraining", "brandDNA"],
    capabilityStatus: [
      { id: "trendAnalysis", label: "趋势分析", status: "preview", note: "当前使用输入关键词和规则生成趋势信号，未接入实时市场数据。" },
      { id: "marketTesting", label: "测款视觉", status: "live", note: "已接入 image edit/generate 生成测款图片。" },
      { id: "brandDNA", label: "品牌 DNA 配置", status: "preview", note: "当前生成可复用品牌提示词配置。" },
      { id: "brandTraining", label: "专属模型训练", status: "preview", note: "当前不是 LoRA/微调训练，后续需要训练服务闭环。" },
      { id: "brandTraining.model", label: "真实专属模型", status: "requires_service", note: "需要接入模型训练/托管服务。" },
    ],
  },
];

const commercialModels = [
  {
    id: "adult-east-asian-01",
    name: "东亚成年女模特",
    ethnicity: "east-asian",
    ageGroup: "adult",
    bodyType: "standard",
    gender: "female",
    commercialUse: true,
    poses: ["standing", "walking", "turnaround"],
  },
  {
    id: "black-adult-01",
    name: "黑人成年女模特",
    ethnicity: "black",
    ageGroup: "adult",
    bodyType: "standard",
    gender: "female",
    commercialUse: true,
    poses: ["standing", "walking", "turnaround"],
  },
  {
    id: "south-asian-adult-01",
    name: "南亚成年女模特",
    ethnicity: "south-asian",
    ageGroup: "adult",
    bodyType: "standard",
    gender: "female",
    commercialUse: true,
    poses: ["standing", "walking"],
  },
  {
    id: "latinx-adult-01",
    name: "拉美女模特",
    ethnicity: "latinx",
    ageGroup: "adult",
    bodyType: "standard",
    gender: "female",
    commercialUse: true,
    poses: ["standing", "walking", "turnaround"],
  },
  {
    id: "middle-eastern-adult-01",
    name: "中东男模特",
    ethnicity: "middle-eastern",
    ageGroup: "adult",
    bodyType: "standard",
    gender: "male",
    commercialUse: true,
    poses: ["standing", "walking"],
  },
  {
    id: "child-east-asian-01",
    name: "儿童模特",
    ethnicity: "east-asian",
    ageGroup: "child",
    bodyType: "standard",
    gender: "female",
    commercialUse: true,
    poses: ["standing", "walking"],
  },
  {
    id: "child-black-01",
    name: "黑人儿童模特",
    ethnicity: "black",
    ageGroup: "child",
    bodyType: "standard",
    gender: "female",
    commercialUse: true,
    poses: ["standing", "walking"],
  },
  {
    id: "child-latinx-01",
    name: "拉美儿童模特",
    ethnicity: "latinx",
    ageGroup: "child",
    bodyType: "standard",
    gender: "male",
    commercialUse: true,
    poses: ["standing", "walking"],
  },
  {
    id: "senior-global-01",
    name: "熟龄模特",
    ethnicity: "global",
    ageGroup: "senior",
    bodyType: "standard",
    gender: "female",
    commercialUse: true,
    poses: ["standing", "turnaround"],
  },
  {
    id: "senior-east-asian-male-01",
    name: "东亚熟龄男模特",
    ethnicity: "east-asian",
    ageGroup: "senior",
    bodyType: "standard",
    gender: "male",
    commercialUse: true,
    poses: ["standing", "turnaround"],
  },
  {
    id: "senior-black-female-01",
    name: "黑人熟龄女模特",
    ethnicity: "black",
    ageGroup: "senior",
    bodyType: "standard",
    gender: "female",
    commercialUse: true,
    poses: ["standing", "turnaround"],
  },
  {
    id: "plus-global-01",
    name: "大码模特",
    ethnicity: "global",
    ageGroup: "adult",
    bodyType: "plus",
    gender: "female",
    commercialUse: true,
    poses: ["standing", "seated", "turnaround"],
  },
  {
    id: "plus-male-global-01",
    name: "大码男模特",
    ethnicity: "global",
    ageGroup: "adult",
    bodyType: "plus",
    gender: "male",
    commercialUse: true,
    poses: ["standing", "walking"],
  },
  {
    id: "plus-south-asian-01",
    name: "南亚大码女模特",
    ethnicity: "south-asian",
    ageGroup: "adult",
    bodyType: "plus",
    gender: "female",
    commercialUse: true,
    poses: ["standing", "walking", "turnaround"],
  },
  {
    id: "plus-black-male-01",
    name: "黑人大码男模特",
    ethnicity: "black",
    ageGroup: "adult",
    bodyType: "plus",
    gender: "male",
    commercialUse: true,
    poses: ["standing", "walking"],
  },
  {
    id: "menswear-global-01",
    name: "男装模特",
    ethnicity: "global",
    ageGroup: "adult",
    bodyType: "standard",
    gender: "male",
    commercialUse: true,
    poses: ["standing", "walking"],
  },
  {
    id: "south-asian-male-01",
    name: "南亚男装模特",
    ethnicity: "south-asian",
    ageGroup: "adult",
    bodyType: "standard",
    gender: "male",
    commercialUse: true,
    poses: ["standing", "walking"],
  },
  {
    id: "latinx-male-01",
    name: "拉美男装模特",
    ethnicity: "latinx",
    ageGroup: "adult",
    bodyType: "standard",
    gender: "male",
    commercialUse: true,
    poses: ["standing", "walking", "turnaround"],
  },
  {
    id: "middle-eastern-female-01",
    name: "中东女模特",
    ethnicity: "middle-eastern",
    ageGroup: "adult",
    bodyType: "standard",
    gender: "female",
    commercialUse: true,
    poses: ["standing", "walking", "turnaround"],
  },
  {
    id: "senior-male-global-01",
    name: "熟龄男模特",
    ethnicity: "global",
    ageGroup: "senior",
    bodyType: "standard",
    gender: "male",
    commercialUse: true,
    poses: ["standing", "turnaround"],
  },
];

const sceneLabels = {
  studio: "棚拍",
  city: "城市街景",
  forest: "森林",
  grassland: "草地",
  showroom: "展厅",
};

const tryOnSourceLabels = {
  garment: "平铺图",
  mannequin: "人台图",
  designSketch: "设计图",
};

const poseLabels = {
  walking: "行走",
  standing: "站立",
  turnaround: "转身",
  seated: "坐姿",
};

const modelProfileLabels = {
  ethnicity: {
    "east-asian": "东亚",
    black: "黑人",
    "south-asian": "南亚",
    latinx: "拉美",
    "middle-eastern": "中东",
    global: "全球",
  },
  ageGroup: {
    child: "儿童",
    adult: "成年",
    senior: "熟龄",
  },
  bodyType: {
    standard: "标准",
    plus: "大码",
  },
  gender: {
    female: "女",
    male: "男",
  },
};

const serviceRequirementsByCapabilityId = {
  "video.mp4": {
    service: "AI 视频生成服务",
    requiredEnv: ["AI_VIDEO_API_URL", "AI_VIDEO_API_KEY"],
    nextAction: "可选增强：配置 AI_VIDEO_API_URL 和 AI_VIDEO_API_KEY 后，将 motion_storyboard 接入真实行走/转身视频生成。",
    optional: true,
  },
  "image.segment.precise": {
    service: "专用分割/抠图服务",
    requiredEnv: ["SEGMENTATION_API_URL", "SEGMENTATION_API_KEY"],
    nextAction: "可选增强：配置 SEGMENTATION_API_URL 和 SEGMENTATION_API_KEY 后，用专用分割结果替代通用图像编辑抠图。",
    optional: true,
  },
  "brandTraining.model": {
    service: "品牌模型训练服务",
    requiredEnv: ["BRAND_TRAINING_API_URL", "BRAND_TRAINING_API_KEY"],
    nextAction: "可选增强：配置 BRAND_TRAINING_API_URL 和 BRAND_TRAINING_API_KEY 后，把品牌 DNA 配置升级为真实训练任务。",
    optional: true,
  },
};

function serviceRequirementConfigured(serviceRequirement) {
  return (
    serviceRequirement.requiredEnv.length > 0 &&
    serviceRequirement.requiredEnv.every((name) => Boolean(process.env[name] && String(process.env[name]).trim().length > 0))
  );
}

function runtimeWorkflowDefinitions() {
  return WORKFLOW_DEFINITIONS.map((workflow) => ({
    ...workflow,
    capabilityStatus: workflow.capabilityStatus.map((capability) => {
      if (capability.status !== "requires_service") return capability;
      const serviceRequirement = serviceRequirementsByCapabilityId[capability.id];
      if (!serviceRequirement) return capability;
      if (!serviceRequirementConfigured(serviceRequirement)) {
        return serviceRequirement.optional ? { ...capability, blocking: false, note: `${capability.note} ${serviceRequirement.nextAction}` } : capability;
      }
      return {
        ...capability,
        status: "live",
        blocking: false,
        note: `已配置 ${serviceRequirement.requiredEnv.join(" / ")}，live 工作流会调用${serviceRequirement.service}；最终效果取决于外部服务质量。`,
      };
    }),
  }));
}

function json(value) {
  return JSON.stringify(value ?? {});
}

function parseJson(value, fallback = {}) {
  try {
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
}

function slugText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

function clampInteger(value, { min, max, fallback }) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(Math.max(Math.trunc(number), min), max);
}

function createWorkflowSvg({ title, subtitle, tone = "#2f6f61", accent = "#d77047", label = "AI" }) {
  const safeTitle = String(title || "ClothDesign AI").replace(/[<>&]/g, "");
  const safeSubtitle = String(subtitle || "workflow result").replace(/[<>&]/g, "");
  const safeLabel = String(label || "AI").replace(/[<>&]/g, "");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="1500" viewBox="0 0 1200 1500">
    <defs>
      <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="#f7f5ef"/>
        <stop offset="1" stop-color="#e4ece4"/>
      </linearGradient>
      <pattern id="texture" width="54" height="54" patternUnits="userSpaceOnUse">
        <path d="M0 54 L54 0" stroke="${accent}" stroke-width="5" stroke-opacity="0.12"/>
        <circle cx="12" cy="12" r="4" fill="${tone}" fill-opacity="0.12"/>
      </pattern>
      <filter id="shadow"><feDropShadow dx="0" dy="24" stdDeviation="24" flood-color="#000" flood-opacity="0.16"/></filter>
    </defs>
    <rect width="1200" height="1500" fill="url(#bg)"/>
    <rect x="86" y="90" width="1028" height="1320" rx="46" fill="url(#texture)"/>
    <path filter="url(#shadow)" d="M410 430 C330 540 318 790 378 1036 L822 1036 C884 790 870 540 790 430 C742 470 660 488 600 488 C540 488 458 470 410 430 Z" fill="${tone}"/>
    <path d="M430 704 C520 758 682 758 770 704" fill="none" stroke="${accent}" stroke-width="22" stroke-linecap="round"/>
    <circle cx="600" cy="326" r="82" fill="${tone}" opacity="0.88"/>
    <text x="116" y="1210" font-family="Arial, sans-serif" font-size="58" font-weight="700" fill="#242722">${safeTitle}</text>
    <text x="118" y="1276" font-family="Arial, sans-serif" font-size="31" fill="#53605a">${safeSubtitle}</text>
    <text x="118" y="172" font-family="Arial, sans-serif" font-size="32" font-weight="700" fill="${accent}">${safeLabel}</text>
  </svg>`;
  return `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`;
}

function configuredImageApiBaseUrl() {
  const configuredUrl =
    process.env.OPENAI_BASE_URL || process.env.OPENAI_API_BASE_URL || process.env.PACKY_API_BASE_URL || "https://api.openai.com";
  const trimmed = configuredUrl.trim().replace(/\/+$/, "");
  return trimmed.endsWith("/v1") ? trimmed : `${trimmed}/v1`;
}

function imageApiUrl(pathname) {
  return `${configuredImageApiBaseUrl()}/${pathname.replace(/^\/+/, "")}`;
}

function workflowImageTimeoutMs() {
  return timeoutMsFromEnv(["WORKFLOW_IMAGE_TIMEOUT_MS", "OPENAI_IMAGE_TIMEOUT_MS"], 180000);
}

function workflowAssetDownloadTimeoutMs() {
  return timeoutMsFromEnv(["WORKFLOW_ASSET_DOWNLOAD_TIMEOUT_MS", "IMAGE_DOWNLOAD_TIMEOUT_MS", "OPENAI_IMAGE_TIMEOUT_MS"], 120000);
}

function segmentationTimeoutMs() {
  return timeoutMsFromEnv("SEGMENTATION_TIMEOUT_MS", 120000);
}

function videoServiceTimeoutMs() {
  return timeoutMsFromEnv("AI_VIDEO_TIMEOUT_MS", 120000);
}

function brandTrainingTimeoutMs() {
  return timeoutMsFromEnv("BRAND_TRAINING_TIMEOUT_MS", 120000);
}

function segmentationProviderStatus() {
  const endpoint = String(process.env.SEGMENTATION_API_URL || "").trim();
  const apiKey = String(process.env.SEGMENTATION_API_KEY || "").trim();
  return {
    ready: Boolean(endpoint && apiKey),
    endpoint,
    apiKey,
  };
}

function videoProviderStatus() {
  const endpoint = String(process.env.AI_VIDEO_API_URL || "").trim();
  const apiKey = String(process.env.AI_VIDEO_API_KEY || "").trim();
  return {
    ready: Boolean(endpoint && apiKey),
    endpoint,
    apiKey,
  };
}

function brandTrainingProviderStatus() {
  const endpoint = String(process.env.BRAND_TRAINING_API_URL || "").trim();
  const apiKey = String(process.env.BRAND_TRAINING_API_KEY || "").trim();
  return {
    ready: Boolean(endpoint && apiKey),
    endpoint,
    apiKey,
  };
}

export function workflowImageProviderStatus() {
  const providerReady = Boolean(process.env.OPENAI_API_KEY && process.env.OPENAI_API_KEY.trim().length > 0);
  return {
    mode: process.env.OPENAI_DEMO_MODE === "true" || !providerReady ? "demo" : "live",
    providerReady,
    baseUrl: configuredImageApiBaseUrl(),
    model: process.env.OPENAI_IMAGE_MODEL || "gpt-image-2",
  };
}

function productionReadinessSummary() {
  const provider = workflowImageProviderStatus();
  const providerHealth = imageProviderHealth(provider);
  const capabilityCounts = { live: 0, preview: 0, requiresService: 0 };
  const blockers = [];
  const optionalServices = [];
  for (const workflow of runtimeWorkflowDefinitions()) {
    for (const capability of workflow.capabilityStatus || []) {
      const serviceRequirement = serviceRequirementsByCapabilityId[capability.id];
      const configured = serviceRequirement ? serviceRequirementConfigured(serviceRequirement) : false;
      if (serviceRequirement?.optional) {
        optionalServices.push({
          workflowId: workflow.id,
          workflowTitle: workflow.title,
          capabilityId: capability.id,
          label: capability.label,
          note: capability.note,
          service: serviceRequirement.service,
          requiredEnv: serviceRequirement.requiredEnv,
          configured,
          nextAction: serviceRequirement.nextAction,
        });
      }
      if (capability.status === "live") capabilityCounts.live += 1;
      else if (capability.status === "preview") capabilityCounts.preview += 1;
      else if (capability.status === "requires_service") {
        if (serviceRequirement?.optional) continue;
        const blockingRequirement = serviceRequirement || { service: "外部服务", requiredEnv: [], nextAction: capability.note };
        capabilityCounts.requiresService += 1;
        blockers.push({
          workflowId: workflow.id,
          workflowTitle: workflow.title,
          capabilityId: capability.id,
          label: capability.label,
          note: capability.note,
          service: blockingRequirement.service,
          requiredEnv: blockingRequirement.requiredEnv,
          configured,
          nextAction: blockingRequirement.nextAction,
        });
      }
    }
  }
  return {
    provider: {
      ...provider,
      health: providerHealth,
    },
    runtime: {
      liveImageRequests: provider.mode === "live",
      label: provider.mode === "live" ? providerHealth.label : "当前会话仅演示",
    },
    capabilityCounts,
    blockers,
    optionalServices,
  };
}

function summarizeProviderError(status, text) {
  return summarizeProviderErrorText(text, 360);
}

function parseDataImage(sourceUrl) {
  const match = String(sourceUrl || "").match(/^data:(image\/[^;,]+)(;base64)?,(.*)$/);
  if (!match) return null;
  const [, mimeType, base64Flag, payload] = match;
  const buffer = base64Flag ? Buffer.from(payload, "base64") : Buffer.from(decodeURIComponent(payload));
  if (buffer.length === 0) return null;
  return { buffer, mimeType };
}

function safeAssetName(asset, index) {
  const fallback = `${asset.kind || "reference"}-${index + 1}.png`;
  return String(asset.name || fallback)
    .replace(/[^\w.\-\u4e00-\u9fa5]+/g, "-")
    .slice(0, 120);
}

function isManagedGeneratedImageSource(sourceUrl) {
  const publicPath = generatedImageStaticMount().publicPath.replace(/\/+$/, "");
  return Boolean(publicPath && String(sourceUrl || "").startsWith(`${publicPath}/`));
}

function isWorkflowImageSource(sourceUrl) {
  const value = String(sourceUrl || "");
  return value.startsWith("data:image/") || /^https?:\/\//.test(value) || isManagedGeneratedImageSource(value);
}

async function workflowAssetToBlob(asset, index) {
  const sourceUrl = String(asset.sourceUrl || "");
  let image;
  if (sourceUrl.startsWith("data:image/")) {
    image = parseDataImage(sourceUrl);
  } else if (isManagedGeneratedImageSource(sourceUrl)) {
    const managed = await readManagedGeneratedImage(sourceUrl, safeAssetName(asset, index));
    image = { buffer: managed.buffer, mimeType: managed.mimetype };
  } else if (/^https?:\/\//.test(sourceUrl)) {
    const response = await fetchWithTimeout(sourceUrl, {}, {
      timeoutMs: workflowAssetDownloadTimeoutMs(),
      timeoutMessage: `素材图片下载超时：${asset.name || sourceUrl}`,
    });
    if (!response.ok) {
      throw new Error(`素材图片下载失败 (${response.status})：${asset.name || sourceUrl}`);
    }
    const mimeType = response.headers.get("content-type") || asset.mimeType || "image/png";
    if (!mimeType.startsWith("image/")) {
      throw new Error(`素材不是图片格式：${asset.name || sourceUrl}`);
    }
    image = { buffer: Buffer.from(await response.arrayBuffer()), mimeType };
  }
  if (!image) return null;
  const validation = validateImageBuffer(image.buffer, image.mimeType || asset.mimeType || "image/png", "素材");
  assertWorkflowAssetUsable(validation, asset);
  return {
    blob: new Blob([image.buffer], { type: validation.mimeType }),
    filename: safeAssetName(asset, index),
  };
}

function assertWorkflowAssetUsable(validation, asset) {
  const width = Number(validation.dimensions?.width || 0);
  const height = Number(validation.dimensions?.height || 0);
  if (width < 256 || height < 256) {
    throw new Error(`素材尺寸过小，最小需要 256x256：${asset.name || asset.sourceUrl || "未命名素材"}`);
  }
}

function assetsForResult(job, result) {
  const imageAssets = job.assets.filter((asset) => isWorkflowImageSource(asset.sourceUrl));
  if (job.type === "postprocess-suite" && result.assetId) {
    return imageAssets.filter((asset) => asset.id === result.assetId);
  }
  if (job.type === "fabric-to-style") {
    const prioritized = imageAssets.filter((asset) => ["fabric", "sketch"].includes(asset.kind));
    return prioritized.length ? prioritized : imageAssets;
  }
  if (job.type === "virtual-model-showcase") {
    const prioritized = imageAssets.filter((asset) => ["garment", "mannequin", "designSketch"].includes(asset.kind));
    return prioritized.length ? prioritized : imageAssets;
  }
  if (job.type === "trend-brand-lab") {
    const prioritized = imageAssets.filter((asset) => asset.kind === "brand");
    return prioritized.length ? prioritized : imageAssets;
  }
  return imageAssets;
}

function shouldRetryImagesRequest(status) {
  return status === 408 || status === 409 || status === 429 || status >= 500;
}

async function parseImagesApiResult(response, label) {
  if (!response.ok) {
    const text = await response.text();
    const error = new Error(`${label} (${response.status})：${summarizeProviderError(response.status, text)}`);
    error.status = response.status;
    throw error;
  }
  const data = await response.json();
  const item = data?.data?.[0];
  if (!item?.url && !item?.b64_json) {
    throw new Error(`${label}没有返回图片。`);
  }
  return item;
}

async function withImageRetry(operation) {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return { ...(await operation()), retryCount: attempt };
    } catch (error) {
      lastError = error;
      if (!shouldRetryImagesRequest(error.status) || attempt === 2) break;
    }
  }
  throw lastError;
}

function qualityGateForResult({ generationMode, assetInputCount, imageInspection, result }) {
  const checks = ["provider_response", "no_watermark_prompt", "commercial_prompt"];
  if (imageInspection?.bytes > 0) checks.push("image_persisted");
  if (imageInspection?.dimensions?.width > 0 && imageInspection?.dimensions?.height > 0) checks.push("image_dimensions");
  if (imageInspection?.content?.inspected) checks.push("image_content_signal");
  if (generationMode === "image_edit" || generationMode === "segmentation_service") checks.push("asset_grounding");
  if (result.mediaType === "image") checks.push("image_result");
  const warnings = [];
  const issues = [];
  const nextActions = ["可进入人工审片或继续细节编辑。"];
  let status = "passed";
  if (generationMode === "text_generate") {
    warnings.push("no_asset_input");
    issues.push("未使用素材输入，品牌一致性需要人工复核。");
    nextActions.unshift("补充面料、服装或品牌参考图后重新生成。");
    status = "review";
  }
  const width = Number(imageInspection?.dimensions?.width || 0);
  const height = Number(imageInspection?.dimensions?.height || 0);
  if ((width > 0 && width < 256) || (height > 0 && height < 256)) {
    warnings.push("image_too_small");
    issues.push("生成图片尺寸过小，疑似上游坏图或占位图。");
    nextActions.unshift("重新请求图像引擎，确认返回原始分辨率图片后再验收。");
    status = "rework";
  }
  if (imageInspection?.content?.lowInformation) {
    warnings.push("image_low_information");
    issues.push("生成图片内容信息量过低，可能是纯色图或异常占位图。");
    nextActions.unshift("重新生成并检查主体、面料纹理和服装结构是否可见。");
    status = "rework";
  }
  if (imageInspection?.content?.subjectTooSparse) {
    warnings.push("subject_too_sparse");
    issues.push("生成图片主体占比过低，疑似空白图或主体未生成。");
    nextActions.unshift("重新生成并确认服装主体占据画面主要区域。");
    status = "rework";
  }
  const actions = Array.isArray(result.metadata?.actions) ? result.metadata.actions : [];
  if (result.versionType === "postprocess_batch" && actions.includes("cutout")) {
    if (imageInspection?.alpha?.transparentPixels > 0) {
      const totalPixels = width > 0 && height > 0 ? width * height : 0;
      const transparentCoverage = totalPixels > 0 ? Number(imageInspection.alpha.transparentPixels || 0) / totalPixels : 0;
      const visibleBounds = imageInspection.alpha.visibleBounds || {};
      if (transparentCoverage < 0.25 || visibleBounds.touchesAllEdges) {
        warnings.push("cutout_background_not_removed");
        issues.push("抠图结果仍有不透明背景铺满画面边界，不能视为可交付抠图。");
        nextActions.unshift("重新生成透明背景 PNG，或接入专用分割/抠图服务后再验收。");
        status = "rework";
      } else {
        checks.push("transparent_alpha");
      }
    } else {
      warnings.push("cutout_alpha_missing");
      issues.push("抠图结果未检测到透明 alpha，不能视为像素级精准抠图。");
      nextActions.unshift("接入专用分割/抠图服务或重新生成透明 PNG 后再验收。");
      status = "rework";
    }
  }
  if (result.versionType === "postprocess_batch") {
    nextActions.push("重点复核边缘抠图、手部细节和主体是否被重新设计。");
  }
  if (result.versionType === "try_on_image") {
    nextActions.push("重点复核服装廓形是否贴近原始平铺图。");
  }
  return {
    status,
    score: status === "passed" ? 92 : status === "review" ? 72 : 54,
    checks,
    warnings,
    issues,
    nextActions,
    assetInputCount,
  };
}

function needsCutoutAlphaRepair(result, imageInspection) {
  const actions = Array.isArray(result.metadata?.actions) ? result.metadata.actions : [];
  return result.versionType === "postprocess_batch" && actions.includes("cutout") && !(imageInspection?.alpha?.transparentPixels > 0);
}

function canUseSegmentationService(result) {
  const actions = Array.isArray(result.metadata?.actions) ? result.metadata.actions : [];
  return result.versionType === "postprocess_batch" && actions.includes("cutout") && segmentationProviderStatus().ready;
}

async function generateLiveWorkflowImage(prompt) {
  const provider = workflowImageProviderStatus();
  if (provider.mode !== "live") return null;
  return withImageRetry(async () => {
    const response = await fetchWithTimeout(
      imageApiUrl("/images/generations"),
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: provider.model,
          prompt,
          n: 1,
          size: "1024x1024",
          quality: "auto",
          response_format: "url",
          output_format: "png",
        }),
      },
      { timeoutMs: workflowImageTimeoutMs(), timeoutMessage: "图像引擎请求超时。" },
    );
    const item = await parseImagesApiResult(response, "图像引擎请求失败");
    return persistGeneratedImage(item);
  });
}

async function parseSegmentationResult(response) {
  if (!response.ok) {
    const text = await response.text();
    const error = new Error(`分割服务请求失败 (${response.status})：${summarizeProviderError(response.status, text)}`);
    error.status = response.status;
    throw error;
  }
  const mimeType = response.headers.get("content-type") || "";
  if (mimeType.startsWith("image/")) {
    return { b64_json: Buffer.from(await response.arrayBuffer()).toString("base64") };
  }
  const data = await response.json();
  const item = data?.data?.[0] || data?.image || data;
  if (!item?.url && !item?.b64_json) {
    throw new Error("分割服务没有返回图片。");
  }
  return item;
}

async function segmentLiveWorkflowImage(prompt, assets) {
  const segmentation = segmentationProviderStatus();
  if (!segmentation.ready) return null;
  const form = new FormData();
  form.append("prompt", prompt);
  form.append("output_format", "png");

  let imageCount = 0;
  for (const [index, asset] of assets.entries()) {
    const image = await workflowAssetToBlob(asset, index);
    if (!image) continue;
    form.append("image", image.blob, image.filename);
    imageCount += 1;
  }
  if (imageCount === 0) {
    throw new Error("没有可用于图像分割的有效素材。");
  }

  return withImageRetry(async () => {
    const response = await fetchWithTimeout(
      segmentation.endpoint,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${segmentation.apiKey}`,
        },
        body: form,
      },
      { timeoutMs: segmentationTimeoutMs(), timeoutMessage: "分割服务请求超时。" },
    );
    const item = await parseSegmentationResult(response);
    const persisted = await persistGeneratedImage(item, { fallbackMimeType: "image/png" });
    return {
      ...persisted,
      imageCount,
    };
  });
}

async function editLiveWorkflowImage(prompt, assets) {
  const provider = workflowImageProviderStatus();
  if (provider.mode !== "live") return null;
  const form = new FormData();
  form.append("model", provider.model);
  form.append("prompt", prompt);
  form.append("n", "1");
  form.append("size", "1024x1024");
  form.append("quality", "auto");
  form.append("response_format", "url");
  form.append("output_format", "png");

  let imageCount = 0;
  for (const [index, asset] of assets.entries()) {
    const image = await workflowAssetToBlob(asset, index);
    if (!image) continue;
    form.append("image", image.blob, image.filename);
    imageCount += 1;
  }
  if (imageCount === 0) {
    throw new Error("没有可用于图像编辑的有效素材。");
  }

  return withImageRetry(async () => {
    const response = await fetchWithTimeout(
      imageApiUrl("/images/edits"),
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        },
        body: form,
      },
      { timeoutMs: workflowImageTimeoutMs(), timeoutMessage: "图像编辑请求超时。" },
    );
    const item = await parseImagesApiResult(response, "图像编辑请求失败");
    const persisted = await persistGeneratedImage(item);
    return {
      ...persisted,
      imageCount,
    };
  });
}

async function parseVideoServiceResult(response) {
  if (!response.ok) {
    const text = await response.text();
    const error = new Error(`视频服务请求失败 (${response.status})：${summarizeProviderError(response.status, text)}`);
    error.status = response.status;
    throw error;
  }
  const mimeType = response.headers.get("content-type") || "";
  if (mimeType.startsWith("video/")) {
    return { b64_video: Buffer.from(await response.arrayBuffer()).toString("base64") };
  }
  const data = await response.json();
  const item = data?.data?.[0] || data?.video || data;
  if (!item?.url && !item?.b64_video) {
    throw new Error("视频服务没有返回视频。");
  }
  return item;
}

async function generateLiveWorkflowVideo({ prompt, cover, result }) {
  const videoProvider = videoProviderStatus();
  if (!videoProvider.ready || !cover?.imageUrl) return null;
  const form = new FormData();
  const sourceImage = await readManagedGeneratedImage(cover.imageUrl, "motion-cover.png");
  const sourceMetadata = cover.metadata || {};
  form.append("prompt", prompt);
  form.append("source_image_url", cover.imageUrl);
  form.append("image", new Blob([sourceImage.buffer], { type: sourceImage.mimetype }), sourceImage.originalname);
  form.append("pose", String(result.metadata?.pose || sourceMetadata.pose || ""));
  form.append("scene", String(result.metadata?.scene || sourceMetadata.scene || ""));
  form.append("model", String(result.metadata?.model?.name || sourceMetadata.model?.name || ""));
  form.append("output_format", "mp4");

  return withImageRetry(async () => {
    const response = await fetchWithTimeout(
      videoProvider.endpoint,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${videoProvider.apiKey}`,
        },
        body: form,
      },
      { timeoutMs: videoServiceTimeoutMs(), timeoutMessage: "视频服务请求超时。" },
    );
    const item = await parseVideoServiceResult(response);
    return persistGeneratedVideo(item);
  });
}

async function parseBrandTrainingResult(response) {
  if (!response.ok) {
    const text = await response.text();
    const error = new Error(`品牌训练服务请求失败 (${response.status})：${summarizeProviderError(response.status, text)}`);
    error.status = response.status;
    throw error;
  }
  const data = await response.json();
  const trainingJobId = data?.training_job_id || data?.trainingJobId || data?.job_id || data?.id || "";
  const modelId = data?.model_id || data?.modelId || data?.model || "";
  const status = String(data?.status || "training");
  if (/^(failed|failure|error|errored|canceled|cancelled|rejected)$/i.test(status)) {
    const detail = data?.error?.message || data?.error || data?.message || data?.reason || "";
    throw new Error(`品牌训练服务返回失败状态：${status}${detail ? `：${String(detail).slice(0, 240)}` : ""}`);
  }
  if (!trainingJobId && !modelId) {
    throw new Error("品牌训练服务没有返回训练任务或模型 ID。");
  }
  return {
    trainingJobId,
    modelId,
    status,
    dashboardUrl: data?.dashboard_url || data?.dashboardUrl || "",
    raw: data,
  };
}

async function submitBrandTrainingJob({ job, profile }) {
  const brandTraining = brandTrainingProviderStatus();
  if (!brandTraining.ready || !profile) return null;
  const brandAssets = job.assets.filter((asset) => asset.kind === "brand");
  if (brandAssets.length === 0) return null;

  const form = new FormData();
  form.append("profile_title", profile.title);
  form.append("job_title", job.title);
  form.append("prompt", job.prompt);
  form.append("dna_json", json(profile.dna));

  let imageCount = 0;
  for (const [index, asset] of brandAssets.entries()) {
    const image = await workflowAssetToBlob(asset, index);
    if (!image) continue;
    form.append("image", image.blob, image.filename);
    imageCount += 1;
  }
  if (imageCount === 0) {
    throw new Error("没有可用于品牌训练的有效素材。");
  }

  const response = await fetchWithTimeout(
    brandTraining.endpoint,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${brandTraining.apiKey}`,
      },
      body: form,
    },
    { timeoutMs: brandTrainingTimeoutMs(), timeoutMessage: "品牌训练服务请求超时。" },
  );
  return {
    ...(await parseBrandTrainingResult(response)),
    imageCount,
  };
}

function livePromptForResult(job, result) {
  const common =
    "商业可用服装行业图片，服装结构清晰，面料纹理真实，构图干净，不包含文字、水印、畸形手指或错误衣领。";
  if (job.type === "fabric-to-style") {
    const recommendation = result.metadata?.styleRecommendation || {};
    const variation = result.metadata?.variation || {};
    const precisionEdit = result.metadata?.precisionEdit || {};
    const recommendationText = recommendation.silhouette ? `推荐版型：${recommendation.silhouette}；推荐理由：${recommendation.rationale || "根据面料解析匹配款式"}。` : "";
    const variationText = variation.focus ? `变体方向：${variation.focus}，${variation.detail || ""}，印花比例 ${variation.printScale || "standard"}。` : "";
    const precisionText = precisionEdit.summary ? `精细调整：${precisionEdit.summary}。` : "";
    return `${common} 使用上传面料图作为真实材质参考，使用草图作为版型结构参考，不要只凭空想象；${recommendationText}${variationText}${precisionText}根据以下需求生成款式设计图：${job.prompt}。结果名称：${result.title}。`;
  }
  if (job.type === "virtual-model-showcase") {
    const selection = result.metadata?.virtualModelSelection || {};
    const source = result.metadata?.tryOnSource || {};
    const selectionText = selection.modelName
      ? `虚拟模特：${selection.modelName}，人种 ${selection.ethnicityLabel || modelProfileLabels.ethnicity[selection.ethnicity] || selection.ethnicity || "未知"}，年龄 ${selection.ageGroupLabel || modelProfileLabels.ageGroup[selection.ageGroup] || selection.ageGroup || "成年"}，体型 ${selection.bodyTypeLabel || modelProfileLabels.bodyType[selection.bodyType] || selection.bodyType || "标准"}，性别 ${selection.genderLabel || modelProfileLabels.gender[selection.gender] || selection.gender || "未知"}，商业授权 ${selection.commercialUse ? "可商用" : "未确认"}；场景：${selection.sceneLabel || "棚拍"}；姿势：${selection.poseLabel || poseLabels[selection.poseId] || selection.poseId || "站立"}。`
      : "";
    const sourceText = source.inputName ? `试穿来源：${source.sourceLabel || "上传图"} ${source.inputName}。` : "";
    return `${common} 使用上传服装图片作为服装主体参考，生成虚拟模特上身效果图；${selectionText}${sourceText}保留服装廓形、颜色和细节，人体比例自然：${job.prompt}。`;
  }
  if (job.type === "postprocess-suite") {
    const actions = Array.isArray(result.metadata?.actions) ? result.metadata.actions : [];
    const alphaCutout = actions.includes("cutout") ? "包含抠图时必须输出带透明 alpha 通道的 PNG，不要只生成白底图。" : "";
    const batch = result.metadata?.batchOperation || {};
    const tuning = result.metadata?.postprocessTuning || {};
    const actionText = Array.isArray(batch.actionLabels) && batch.actionLabels.length ? batch.actionLabels.join("、") : actions.join("、");
    const batchText = batch.batchIndex
      ? `批量后期：第${batch.batchIndex}/${batch.batchTotal || "?"}张，来源 ${batch.inputName || "上传图片"}，目标场景 ${batch.sceneLabel || result.metadata?.targetSceneLabel || "棚拍场景"}。处理动作：${actionText}。目标颜色 ${batch.targetColorLabel || result.metadata?.targetColorLabel || batch.targetColor || result.metadata?.targetColor || "保留原色"}，目标比例 ${batch.targetRatio || result.metadata?.targetRatio || "auto"}。`
      : "";
    const tuningText = tuning.summary ? `精修控制：${tuning.summary}。` : "";
    return `${common} 对上传商品图进行后期编辑，必须保留原图主体、姿态、服装轮廓、模特/人台比例和主要细节；只修改背景、光线、瑕疵、颜色和画幅。不要重新设计一件新衣服，不要把模特改成无关假人。${alphaCutout}${batchText}${tuningText} 输出处理完成的电商商品图，体现智能抠图、补光增强、修复、重色和比例整理：${job.prompt}。`;
  }
  return `${common} 使用上传品牌图片作为品牌 DNA 参考，根据趋势生成测款视觉版本：${job.prompt}。结果名称：${result.title}。`;
}

function brandProfileForJob(jobId) {
  const row = sqlite.prepare("SELECT * FROM brand_profile WHERE job_id = ?").get(jobId);
  if (!row) return null;
  return {
    id: row.id,
    userId: row.user_id,
    jobId: row.job_id,
    title: row.title,
    status: row.status,
    dna: parseJson(row.dna_json),
    createdAt: row.created_at,
  };
}

async function materializeBrandTraining(job) {
  if (job.type !== "trend-brand-lab") return;
  const profile = brandProfileForJob(job.id);
  const training = await submitBrandTrainingJob({ job, profile });
  if (!training) return;

  const status = String(training.status || "training").slice(0, 80);
  const trainingMetadata = {
    provider: "Brand Training API",
    status,
    trainingJobId: String(training.trainingJobId || ""),
    modelId: String(training.modelId || ""),
    dashboardUrl: String(training.dashboardUrl || ""),
    imageCount: training.imageCount,
    submittedAt: nowIso(),
  };
  const dna = { ...profile.dna, training: trainingMetadata };
  sqlite.prepare("UPDATE brand_profile SET status = ?, dna_json = ? WHERE id = ?").run(status, json(dna), profile.id);

  const profileResult = sqlite.prepare("SELECT * FROM workflow_result WHERE job_id = ? AND version_type = 'brand_profile'").get(job.id);
  if (profileResult) {
    sqlite
      .prepare("UPDATE workflow_result SET metadata_json = ? WHERE id = ?")
      .run(json({ ...parseJson(profileResult.metadata_json), training: trainingMetadata, trainingProvider: "Brand Training API" }), profileResult.id);
  }

  sqlite
    .prepare("UPDATE workflow_step SET message = ?, metadata_json = ? WHERE job_id = ? AND capability = 'brandTraining'")
    .run("已提交真实品牌训练任务。", json({ training: trainingMetadata }), job.id);
}

function workflowCompletionMessage(jobId) {
  const statuses = sqlite
    .prepare("SELECT metadata_json FROM workflow_result WHERE job_id = ?")
    .all(jobId)
    .map((row) => parseJson(row.metadata_json)?.qualityGate?.status)
    .filter(Boolean);
  if (statuses.includes("rework")) {
    return "工作流已完成，部分图片需返工，请按质量门建议重新生成或接入专用服务。";
  }
  if (statuses.includes("review")) {
    return "工作流已完成，部分结果需人工复核后再用于投放或生产。";
  }
  return "工作流已完成，图片结果已通过图像引擎生成。";
}

export async function materializeLiveImages(job) {
  const provider = workflowImageProviderStatus();
  if (provider.mode !== "live") return job;
  const imageResults = job.results.filter((result) => result.mediaType === "image");
  for (const result of imageResults) {
    const inputAssets = assetsForResult(job, result);
    const prompt = livePromptForResult(job, result);
    const segmented = canUseSegmentationService(result) ? await segmentLiveWorkflowImage(prompt, inputAssets) : null;
    const edited = !segmented && inputAssets.length > 0 ? await editLiveWorkflowImage(prompt, inputAssets) : null;
    const generated = segmented || edited || (await generateLiveWorkflowImage(prompt));
    let imageUrl = generated?.imageUrl;
    if (!imageUrl) continue;
    let imageInspection = generated.imageInspection;
    const repairMetadata = {};
    if (needsCutoutAlphaRepair(result, imageInspection)) {
      repairMetadata.imageRepairAttempted = true;
      try {
        const repaired = await repairCheckerboardTransparency(imageUrl);
        imageUrl = repaired.imageUrl;
        imageInspection = repaired.imageInspection;
        repairMetadata.imageRepairSucceeded = true;
      } catch (error) {
        repairMetadata.imageRepairSucceeded = false;
        repairMetadata.imageRepairError = error instanceof Error ? error.message : String(error);
      }
    }
    const generationMode = segmented ? "segmentation_service" : edited ? "image_edit" : "text_generate";
    const assetInputCount = segmented?.imageCount || edited?.imageCount || 0;
    const metadata = {
      ...result.metadata,
      provider: segmented ? "Segmentation API" : "PackyAPI",
      imageModel: segmented ? "external-segmentation" : provider.model,
      liveGenerated: true,
      generationMode,
      assetInputCount,
      assetInputNames: segmented || edited ? inputAssets.map((asset) => asset.name).filter(Boolean) : [],
      segmentationServiceUsed: Boolean(segmented),
      retryCount: generated.retryCount || 0,
      imageInspection,
      ...repairMetadata,
      qualityGate: qualityGateForResult({ generationMode, assetInputCount, imageInspection, result }),
    };
    sqlite
      .prepare("UPDATE workflow_result SET image_url = ?, metadata_json = ? WHERE id = ?")
      .run(imageUrl, json(metadata), result.id);
  }
  const latestJob = getWorkflowJob(job.userId, job.id) || job;
  if (job.type === "virtual-model-showcase") {
    const cover = latestJob.results.find((result) => result.versionType === "try_on_image" && result.mediaType === "image");
    const videoResults = latestJob.results.filter((result) => result.mediaType === "video");
    for (const result of videoResults) {
      if (!cover?.imageUrl || result.metadata.motionPreviewGenerated || result.metadata.videoServiceUsed) continue;
      const videoFromService = await generateLiveWorkflowVideo({ prompt: livePromptForResult(job, result), cover, result });
      const video =
        videoFromService ||
        (await createMotionPreviewMp4({
          sourceImageUrl: cover.imageUrl,
          durationSeconds: 2.4,
          size: "720x960",
        }));
      const metadata = {
        ...result.metadata,
        motionPreviewGenerated: !videoFromService,
        requiresVideoModelForMp4: false,
        requiresAiVideoModelForMotion: !videoFromService,
        videoProvider: videoFromService ? "external-video-service" : "local-ffmpeg",
        videoServiceUsed: Boolean(videoFromService),
        videoInspection: video.videoInspection,
      };
      sqlite
        .prepare("UPDATE workflow_result SET image_url = ?, metadata_json = ? WHERE id = ?")
        .run(video.videoUrl, json(metadata), result.id);
    }
  }
  await materializeBrandTraining(latestJob);
  sqlite
    .prepare("UPDATE workflow_job SET status = 'success', progress = 100, message = ?, updated_at = ? WHERE id = ?")
    .run(workflowCompletionMessage(job.id), nowIso(), job.id);
  return getWorkflowJob(job.userId, job.id) || job;
}

const liveMaterializationJobs = new Set();

function startLiveMaterialization(job) {
  if (workflowImageProviderStatus().mode !== "live" || liveMaterializationJobs.has(job.id)) return;
  liveMaterializationJobs.add(job.id);
  void materializeLiveImages(job)
    .catch((error) => {
      markWorkflowJobFailed(job.userId, job.id, error);
    })
    .finally(() => {
      liveMaterializationJobs.delete(job.id);
    });
}

function analyzeAsset(asset) {
  const text = `${asset.name || ""} ${asset.note || ""}`.toLowerCase();
  const imageData = asset.kind === "fabric" ? parseDataImage(asset.sourceUrl) : null;
  const imageAnalysis = imageData ? analyzeFabricImageBuffer(imageData.buffer) : null;
  const textColors = [];
  if (/moss|苔|green|绿/.test(text)) textColors.push("moss green");
  if (/ivory|cream|米|象牙/.test(text)) textColors.push("ivory");
  if (/yellow|黄/.test(text)) textColors.push("butter yellow");
  if (/black|黑/.test(text)) textColors.push("black");
  const colors = uniqueList([...(imageAnalysis?.colors || []), ...textColors]);
  if (colors.length === 0) colors.push("soft neutral");

  let pattern = imageAnalysis?.pattern || "solid";
  if (/jacquard|提花/.test(text)) pattern = "jacquard floral";
  else if (/stripe|条纹/.test(text)) pattern = "stripe";
  else if (/floral|碎花|花/.test(text)) pattern = "floral";

  let texture = imageAnalysis?.texture || "smooth woven";
  if (/silk|丝|satin/.test(text)) texture = "silk sheen";
  if (/linen|麻/.test(text)) texture = "linen slub";
  if (/knit|针织/.test(text)) texture = "soft knit";

  return {
    colors,
    pattern,
    texture,
    weight: /winter|厚|wool/.test(text) ? "heavy" : imageAnalysis?.weight || "light-medium",
    inferredUse: /child|童/.test(text) ? "kidswear" : imageAnalysis?.inferredUse || "womenswear",
    analysisSource: imageAnalysis ? "image" : "text",
    confidence: imageAnalysis?.confidence || (text.trim() ? "medium" : "low"),
  };
}

function insertAsset(userId, jobId, asset) {
  const id = randomUUID();
  const timestamp = nowIso();
  const metadata = {
    ...analyzeAsset(asset),
    ...(asset.metadata || {}),
  };
  sqlite
    .prepare(
      `INSERT INTO workflow_asset
        (id, user_id, job_id, kind, name, mime_type, source_url, note, metadata_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      userId,
      jobId,
      asset.kind || "reference",
      String(asset.name || "未命名素材").slice(0, 120),
      String(asset.mimeType || "application/octet-stream").slice(0, 80),
      String(asset.sourceUrl || "").slice(0, 200000),
      String(asset.note || "").slice(0, 500),
      json(metadata),
      timestamp,
    );
  return { id, ...asset, metadata, createdAt: timestamp };
}

function insertStep(jobId, position, title, capability, message, metadata = {}) {
  const id = randomUUID();
  sqlite
    .prepare(
      `INSERT INTO workflow_step
        (id, job_id, position, title, capability, status, message, metadata_json)
       VALUES (?, ?, ?, ?, ?, 'success', ?, ?)`,
    )
    .run(id, jobId, position, title, capability, message, json(metadata));
  return { id, jobId, position, title, capability, status: "success", message, metadata };
}

function insertResult(jobId, assetId, title, versionType, mediaType, imageUrl, metadata = {}) {
  const id = randomUUID();
  const timestamp = nowIso();
  sqlite
    .prepare(
      `INSERT INTO workflow_result
        (id, job_id, asset_id, title, version_type, media_type, image_url, metadata_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(id, jobId, assetId || null, title, versionType, mediaType, imageUrl, json(metadata), timestamp);
  return { id, jobId, assetId: assetId || null, title, versionType, mediaType, imageUrl, metadata, createdAt: timestamp };
}

function insertTrendSignal(userId, jobId, keyword, index) {
  const id = randomUUID();
  const score = Math.max(62, 94 - index * 8);
  sqlite
    .prepare(
      `INSERT INTO trend_signal (id, user_id, job_id, keyword, score, detail, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(id, userId, jobId, keyword, score, `${keyword} 适合做快速测款和主图 A/B 版本。`, nowIso());
  return { id, keyword, score, detail: `${keyword} 适合做快速测款和主图 A/B 版本。` };
}

function uniqueList(values, fallback = []) {
  const seen = new Set();
  const output = [];
  for (const value of [...values, ...fallback]) {
    const item = String(value || "").trim();
    if (!item || seen.has(item)) continue;
    seen.add(item);
    output.push(item);
  }
  return output;
}

function normalizeTexture(value) {
  const text = String(value || "").toLowerCase();
  if (/linen|麻/.test(text)) return "linen slub";
  if (/silk|丝|satin/.test(text)) return "silk sheen";
  if (/knit|针织/.test(text)) return "soft knit";
  return value;
}

function insertBrandProfile(userId, jobId, title, assets, trendKeywords = []) {
  const id = randomUUID();
  const assetColors = assets.flatMap((asset) => (Array.isArray(asset.metadata.colors) ? asset.metadata.colors : []));
  const palette = uniqueList(
    [...trendKeywords.filter((keyword) => /yellow|green|black|ivory|cream|黄|绿|黑|米/.test(String(keyword).toLowerCase())), ...assetColors],
    ["moss green", "ivory", "ink black"],
  ).slice(0, 5);
  const texture = uniqueList(
    [
      ...assets.map((asset) => asset.metadata.texture),
      ...trendKeywords
        .filter((keyword) => /linen|silk|knit|麻|丝|针织/.test(String(keyword).toLowerCase()))
        .map(normalizeTexture),
    ],
    ["smooth woven"],
  ).slice(0, 5);
  const silhouette = uniqueList(
    [...trendKeywords.filter((keyword) => /skirt|dress|utility|tailor|裙|连衣裙|通勤/.test(String(keyword).toLowerCase())), "clean tailoring", "commercial wearable"],
    ["soft utility"],
  ).slice(0, 5);
  const dna = {
    palette,
    silhouette,
    texture,
    promptPrefix: `保持品牌 DNA：${palette.slice(0, 3).join("、")}，${silhouette.slice(0, 3).join("、")}，面料重点 ${texture.slice(0, 2).join("、")}，克制高级、结构清晰、商业可投放。`,
  };
  sqlite
    .prepare(
      `INSERT INTO brand_profile (id, user_id, job_id, title, status, dna_json, created_at)
       VALUES (?, ?, ?, ?, 'ready', ?, ?)`,
    )
    .run(id, userId, jobId, title, json(dna), nowIso());
  return { id, userId, jobId, title, status: "ready", dna };
}

function styleRecommendationForFabric({ fabricAnalysis, garmentCategory, controls }) {
  const category = String(garmentCategory || "dress").trim() || "dress";
  const pattern = String(fabricAnalysis?.pattern || "solid");
  const texture = String(fabricAnalysis?.texture || "smooth woven");
  const colors = Array.isArray(fabricAnalysis?.colors) ? fabricAnalysis.colors : ["soft neutral"];
  let silhouette = category === "skirt" ? "clean A-line skirt" : "clean column dress";
  if (/floral|jacquard|printed|stripe/.test(pattern)) {
    silhouette = category === "skirt" ? "soft A-line skirt" : "soft A-line dress";
  }
  if (/silk|chiffon|woven stripe/.test(texture) && category === "dress") {
    silhouette = "soft A-line dress";
  }
  return {
    recommendedCategory: category,
    silhouette,
    palette: colors.slice(0, 3),
    rationale: `${pattern} 与 ${texture} 更适合 ${silhouette}，能保留面料视觉节奏并兼容 ${controls?.neckline || "clean"} 领口和 ${controls?.hemLength || "balanced"} 衣长。`,
  };
}

function fabricVariantPlan(index, fabricAnalysis, styleRecommendation) {
  const palette = styleRecommendation?.palette?.length ? styleRecommendation.palette : fabricAnalysis?.colors || ["soft neutral"];
  const plans = [
    { focus: "主推版型", palette, printScale: "standard", detail: "保持推荐版型和原始面料节奏" },
    { focus: "换色方案", palette: [...palette].reverse(), printScale: "standard", detail: "保留图案结构，调整主辅色占比" },
    { focus: "印花比例", palette, printScale: "larger motif", detail: "放大印花或纹理比例，增强电商主图识别" },
    { focus: "细节裂变", palette, printScale: "standard", detail: "调整领口、腰节、裙摆或门襟细节" },
    { focus: "领型变化", palette, printScale: "standard", detail: "在方领、V领、圆领或衬衫领之间做结构变化" },
    { focus: "袖型变化", palette, printScale: "standard", detail: "调整无袖、短袖、长袖或袖口量感，验证不同季节适配" },
    { focus: "长度层次", palette, printScale: "standard", detail: "扩展短款、中长款和长款比例，形成不同穿着场景" },
    { focus: "商业搭配", palette, printScale: "small repeat", detail: "生成适合主图、搭配图或系列陈列的商品化版本" },
  ];
  return plans[index % plans.length];
}

function precisionEditForControls(controls = {}) {
  const patternLabels = {
    jacquard: "提花",
    stripe: "条纹",
    floral: "小花",
    solid: "净色",
  };
  const pattern = String(controls.pattern || "").trim();
  const patternLabel = pattern ? patternLabels[pattern] || pattern : "";
  const hemLengthPercent = clampInteger(controls.hemLengthPercent, { min: 0, max: 100, fallback: 68 });
  const sleeveLengthPercent = clampInteger(controls.sleeveLengthPercent, { min: 0, max: 100, fallback: 35 });
  const necklineDepthPercent = clampInteger(controls.necklineDepthPercent, { min: 0, max: 100, fallback: 24 });
  const precisionEdit = {
    hemLengthPercent,
    sleeveLengthPercent,
    necklineDepthPercent,
  };
  if (pattern) {
    precisionEdit.pattern = pattern;
    precisionEdit.patternLabel = patternLabel;
  }
  precisionEdit.summary = `${patternLabel ? `面料图案${patternLabel} · ` : ""}衣长${hemLengthPercent}% · 袖长${sleeveLengthPercent}% · 领口开度${necklineDepthPercent}%`;
  return precisionEdit;
}

function multimodalInputForFabric({ assets, prompt, inputSummary = {} }) {
  const assetKinds = ["fabric", "sketch"].filter((kind) => assets.some((asset) => asset.kind === kind));
  const inputModes = [
    assetKinds.includes("fabric") ? "面料图片" : "",
    assetKinds.includes("sketch") ? "设计草图" : "",
    String(inputSummary.textDescription || prompt || "").trim() ? "文字描述" : "",
  ].filter(Boolean);
  return {
    inputModes,
    assetKinds,
    assetNames: assets.filter((asset) => assetKinds.includes(asset.kind)).map((asset) => asset.name || "未命名素材"),
    textDescription: String(inputSummary.textDescription || prompt || "").trim().replace(/\s+/g, " ").slice(0, 180),
  };
}

function buildFabricWorkflow({ jobId, userId, title, prompt, assets, options }) {
  const variantCount = clampInteger(options.variants, { min: 1, max: 8, fallback: 4 });
  const baseAsset = assets.find((asset) => asset.kind === "fabric") || assets[0];
  const controls = options.editControls || {};
  const precisionEdit = precisionEditForControls(controls);
  const multimodalInput = multimodalInputForFabric({ assets, prompt, inputSummary: options.inputSummary || {} });
  const fabricAnalysis = baseAsset?.metadata
    ? {
        colors: baseAsset.metadata.colors || ["soft neutral"],
        pattern: baseAsset.metadata.pattern || "solid",
        texture: baseAsset.metadata.texture || "smooth woven",
        weight: baseAsset.metadata.weight || "light-medium",
        inferredUse: baseAsset.metadata.inferredUse || "womenswear",
        analysisSource: baseAsset.metadata.analysisSource || "text",
        confidence: baseAsset.metadata.confidence || "low",
      }
    : null;
  const styleRecommendation = styleRecommendationForFabric({
    fabricAnalysis,
    garmentCategory: options.garmentCategory || "dress",
    controls,
  });
  const steps = [
    insertStep(jobId, 1, "面料解析", "vision.analyze", "已提取颜色、图案、纹理和适用品类。", {
      inputTypes: ["fabricImage", "textDescription", "sketch"],
      multimodalInput,
      fabricAnalysis: baseAsset?.metadata || null,
    }),
    insertStep(jobId, 2, "款式匹配", "style.recommend", "已根据面料属性匹配服装品类和版型。", {
      garmentCategory: options.garmentCategory || "dress",
      styleRecommendation,
    }),
    insertStep(jobId, 3, "可控编辑", "image.edit", "已应用衣长、袖长、领口和面料替换控制。", {
      editControls: options.editControls || {},
      precisionEdit,
    }),
    insertStep(jobId, 4, "款式裂变", "image.generate", `已生成 ${variantCount} 个配色、印花和细节变体。`, {
      variants: variantCount,
    }),
  ];
  const results = Array.from({ length: variantCount }, (_, index) => {
    const variation = fabricVariantPlan(index, fabricAnalysis, styleRecommendation);
    return insertResult(
      jobId,
      baseAsset?.id,
      `款式变体 ${index + 1}`,
      "style_variant",
      "image",
      createWorkflowSvg({
        title: `款式变体 ${index + 1}`,
        subtitle: `${controls.neckline || "clean"} neckline · ${controls.hemLength || "balanced"} length`,
        tone: index % 2 === 0 ? "#2f6f61" : "#75543f",
        accent: index % 2 === 0 ? "#d77047" : "#b7a36a",
        label: "FABRIC TO STYLE",
      }),
      {
        prompt,
        garmentCategory: options.garmentCategory || "dress",
        colors: fabricAnalysis?.colors || ["soft neutral"],
        fabricAnalysis,
        multimodalInput,
        styleRecommendation,
        variation,
        editControls: controls,
        precisionEdit,
      },
    );
  });
  return { steps, results };
}

function buildVirtualModelWorkflow({ jobId, prompt, assets, options }) {
  const model = commercialModels.find((item) => item.id === options.modelId) || commercialModels[0];
  const sceneId = sceneLabels[options.sceneId] ? options.sceneId : "studio";
  const scene = sceneLabels[sceneId] || sceneLabels.studio;
  const poseId = model.poses.includes(options.poseId) ? options.poseId : model.poses[0] || "standing";
  const poseLabel = poseLabels[poseId] || poseId;
  const requestedSourceType = tryOnSourceLabels[options.sourceType] ? options.sourceType : "";
  const baseAsset =
    (requestedSourceType ? assets.find((asset) => asset.kind === requestedSourceType) : null) ||
    assets.find((asset) => asset.kind === "garment") ||
    assets.find((asset) => tryOnSourceLabels[asset.kind]) ||
    assets[0];
  const sourceType = requestedSourceType || (baseAsset?.kind && tryOnSourceLabels[baseAsset.kind] ? baseAsset.kind : "garment");
  const tryOnSource = {
    sourceType,
    sourceLabel: tryOnSourceLabels[sourceType] || "平铺图",
    inputName: baseAsset?.name || "默认平铺服装素材",
    assetKind: baseAsset?.kind || sourceType,
  };
  const virtualModelSelection = {
    modelId: model.id,
    modelName: model.name,
    ethnicity: model.ethnicity,
    ageGroup: model.ageGroup,
    bodyType: model.bodyType,
    gender: model.gender,
    ethnicityLabel: modelProfileLabels.ethnicity[model.ethnicity] || model.ethnicity,
    ageGroupLabel: modelProfileLabels.ageGroup[model.ageGroup] || model.ageGroup,
    bodyTypeLabel: modelProfileLabels.bodyType[model.bodyType] || model.bodyType,
    genderLabel: modelProfileLabels.gender[model.gender] || model.gender,
    commercialUse: model.commercialUse,
    sceneId,
    sceneLabel: scene,
    poseId,
    poseLabel,
    sourceType,
    sourceLabel: tryOnSource.sourceLabel,
  };
  const steps = [
    insertStep(jobId, 1, "款式识别", "vision.analyze", "已从平铺图、人台图或设计图识别服装主体。", {
      sourceType: virtualModelSelection.sourceType,
      tryOnSource,
    }),
    insertStep(jobId, 2, "模特匹配", "model.select", `已选择可商用${model.name}。`, { model, virtualModelSelection }),
    insertStep(jobId, 3, "场景动作", "scene.render", `已切换到${scene}和${poseLabel}动作。`, {
      sceneId,
      sceneLabel: scene,
      poseId,
      poseLabel,
    }),
  ];
  const results = [
    insertResult(
      jobId,
      baseAsset?.id,
      "虚拟模特上身图",
      "try_on_image",
      "image",
      createWorkflowSvg({
        title: "虚拟模特上身图",
        subtitle: `${model.name} · ${scene} · ${poseLabel}`,
        tone: "#335f6b",
        accent: "#d78345",
        label: "VIRTUAL MODEL",
      }),
      { prompt, model, scene, pose: poseId, virtualModelSelection, tryOnSource },
    ),
  ];
  if (options.makeVideo !== false) {
    steps.push(insertStep(jobId, 4, "短视频分镜", "video.storyboard", "已生成行走、转身短视频分镜；live 模式会补充本地 MP4 动效预览，真实 AI 行走视频仍需接入视频模型。"));
    results.push(
      insertResult(
        jobId,
        baseAsset?.id,
        "动态短视频分镜",
        "motion_storyboard",
        "video",
        createWorkflowSvg({
          title: "动态短视频分镜",
          subtitle: "walking loop · turn around · cover frame",
          tone: "#4d4c91",
          accent: "#2c8c7d",
          label: "MOTION VIDEO",
        }),
        { frames: ["front", "walk", "turn", "back"], requiresVideoModelForMp4: true, status: "storyboard_only" },
      ),
    );
  }
  return { steps, results };
}

function postprocessTuningForOptions(options = {}) {
  const source = options.postprocessTuning && typeof options.postprocessTuning === "object" ? options.postprocessTuning : {};
  const repairFocusLabels = {
    hands: "手部",
    body: "身形",
    garment: "服装细节",
  };
  const repairFocus = repairFocusLabels[source.repairFocus] ? source.repairFocus : "hands";
  const eraseTarget = String(source.eraseTarget || "画面杂物").trim().replace(/\s+/g, " ").slice(0, 80) || "画面杂物";
  const lightStrength = clampInteger(source.lightStrength, { min: 0, max: 100, fallback: 60 });
  const beautyLevel = clampInteger(source.beautyLevel, { min: 0, max: 100, fallback: 35 });
  const repairFocusLabel = repairFocusLabels[repairFocus];
  return {
    eraseTarget,
    lightStrength,
    beautyLevel,
    repairFocus,
    repairFocusLabel,
    summary: `擦除${eraseTarget} · 补光${lightStrength}% · 美体${beautyLevel}% · 修复重点${repairFocusLabel}`,
  };
}

function buildPostprocessWorkflow({ jobId, prompt, assets, options }) {
  const supportedActions = new Set(["cutout", "enhance", "repair", "erase", "recolor", "resize"]);
  const requestedActions = Array.isArray(options.actions) ? options.actions : [];
  const actions = requestedActions.filter((action) => supportedActions.has(action));
  const safeActions = actions.length > 0 ? actions : ["cutout", "enhance", "repair", "erase", "recolor", "resize"];
  const supportedScenes = new Set(["studio", "city", "grassland"]);
  const requestedScenes = Array.isArray(options.targetScenes) ? options.targetScenes : [];
  const targetScenes = requestedScenes.filter((scene) => supportedScenes.has(scene));
  const safeScenes = targetScenes.length > 0 ? targetScenes : ["studio"];
  const sceneLabelsById = {
    studio: "棚拍场景",
    city: "城市街景",
    grassland: "草地场景",
  };
  const targetColorLabels = {
    ivory: "象牙白",
    sage: "鼠尾草绿",
    original: "保留原色",
  };
  const actionLabels = {
    cutout: "智能抠图",
    enhance: "图片美化与增强",
    repair: "手部修复",
    erase: "对象擦除",
    recolor: "智能重色",
    resize: "调整图片比例",
  };
  const capabilityByAction = {
    cutout: "image.segment",
    enhance: "image.enhance",
    repair: "image.inpaint",
    erase: "image.inpaint",
    recolor: "image.recolor",
    resize: "image.resize",
  };
  const steps = safeActions.map((action, index) =>
    insertStep(jobId, index + 1, actionLabels[action] || action, capabilityByAction[action] || "image.edit", `已执行${actionLabels[action] || action}。`, {
      action,
    }),
  );
  const postprocessTuning = postprocessTuningForOptions(options);
  steps.push(
    insertStep(jobId, steps.length + 1, "批量处理", "batch", `已处理 ${Math.max(assets.length, 1) * safeScenes.length} 张图片。`, {
      count: assets.length,
      targetScenes: safeScenes,
      postprocessTuning,
    }),
  );
  const inputAssets = assets.length ? assets : [{ id: null, name: "演示图片" }];
  const batchTotal = inputAssets.length * safeScenes.length;
  const results = inputAssets.flatMap((asset, assetIndex) =>
    safeScenes.map((scene, sceneIndex) => {
      const batchIndex = assetIndex * safeScenes.length + sceneIndex + 1;
      const batchOperation = {
        inputName: asset.name || "演示图片",
        inputIndex: assetIndex + 1,
        inputTotal: inputAssets.length,
        sceneIndex: sceneIndex + 1,
        sceneTotal: safeScenes.length,
        batchIndex,
        batchTotal,
        sceneId: scene,
        sceneLabel: sceneLabelsById[scene],
        targetColor: options.targetColor || "original",
        targetColorLabel: targetColorLabels[options.targetColor] || targetColorLabels.original,
        targetRatio: options.targetRatio || "auto",
        actionLabels: safeActions.map((action) => actionLabels[action] || action),
      };
      return insertResult(
        jobId,
        asset.id,
        `批量后期 ${batchIndex}`,
        "postprocess_batch",
        "image",
        createWorkflowSvg({
          title: `批量后期 ${batchIndex}`,
          subtitle: `${sceneLabelsById[scene]} · ${safeActions.map((action) => actionLabels[action] || action).join(" · ")}`,
          tone: "#34302d",
          accent: "#a7b6a4",
          label: "POSTPROCESS",
        }),
        {
          prompt,
          actions: safeActions,
          targetColor: options.targetColor || "original",
          targetColorLabel: targetColorLabels[options.targetColor] || targetColorLabels.original,
          targetRatio: options.targetRatio || "auto",
          targetScene: scene,
          targetSceneLabel: sceneLabelsById[scene],
          batchOperation,
          postprocessTuning,
        },
      );
    }),
  );
  return { steps, results };
}

function buildTrendBrandWorkflow({ jobId, userId, title, prompt, assets, options }) {
  const trendKeywords =
    Array.isArray(options.trendKeywords) && options.trendKeywords.length > 0
      ? options.trendKeywords
      : ["butter yellow", "utility skirt", "lightweight linen"];
  const variantCount = clampInteger(options.marketVariants, { min: 1, max: 8, fallback: 3 });
  const steps = [
    insertStep(jobId, 1, "趋势分析", "trendAnalysis", "已分析流行色、面料和款式方向。", { trendKeywords }),
    insertStep(jobId, 2, "市场测款", "marketTesting", `已生成 ${variantCount} 个测款版本。`, { variantCount }),
  ];
  const trendSignals = trendKeywords.map((keyword, index) => insertTrendSignal(userId, jobId, keyword, index));
  const results = Array.from({ length: variantCount }, (_, index) =>
    insertResult(
      jobId,
      null,
      `测款版本 ${index + 1}`,
      "market_test_variant",
      "image",
      createWorkflowSvg({
        title: `测款版本 ${index + 1}`,
        subtitle: `${trendKeywords[index % trendKeywords.length]} · market test`,
        tone: index % 2 === 0 ? "#c2a04b" : "#496852",
        accent: index % 2 === 0 ? "#2e624c" : "#d77047",
        label: "TREND TEST",
      }),
      { prompt, keyword: trendKeywords[index % trendKeywords.length], testMetric: "click intent" },
    ),
  );
  let brandProfile = null;
  if (options.trainBrandProfile !== false) {
    steps.push(insertStep(jobId, 3, "品牌专属模型训练", "brandTraining", "已基于品牌素材形成可复用品牌 DNA 配置。"));
    brandProfile = insertBrandProfile(userId, jobId, `${title} 品牌 DNA`, assets, trendKeywords);
    results.push(
      insertResult(
        jobId,
        null,
        "品牌 DNA",
        "brand_profile",
        "profile",
        createWorkflowSvg({
          title: "品牌 DNA",
          subtitle: brandProfile.dna.promptPrefix,
          tone: "#2e624c",
          accent: "#b83534",
          label: "BRAND DNA",
        }),
        brandProfile.dna,
      ),
    );
  }
  return { steps, results, trendSignals, brandProfile };
}

function serializeJob(row) {
  return {
    id: row.id,
    userId: row.user_id,
    type: row.type,
    title: row.title,
    prompt: row.prompt,
    status: row.status,
    progress: row.progress,
    credits: row.credits,
    message: row.message,
    options: parseJson(row.options_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowsForJob(jobId) {
  const steps = sqlite
    .prepare("SELECT * FROM workflow_step WHERE job_id = ? ORDER BY position ASC")
    .all(jobId)
    .map((row) => ({
      id: row.id,
      jobId: row.job_id,
      position: row.position,
      title: row.title,
      capability: row.capability,
      status: row.status,
      message: row.message,
      metadata: parseJson(row.metadata_json),
    }));
  const assets = sqlite
    .prepare("SELECT * FROM workflow_asset WHERE job_id = ? ORDER BY created_at ASC")
    .all(jobId)
    .map(serializeAsset);
  const results = sqlite
    .prepare("SELECT * FROM workflow_result WHERE job_id = ? ORDER BY created_at ASC")
    .all(jobId)
    .map(serializeResult);
  return { steps, assets, results };
}

function serializeAsset(row) {
  return {
    id: row.id,
    userId: row.user_id,
    jobId: row.job_id,
    kind: row.kind,
    name: row.name,
    mimeType: row.mime_type,
    sourceUrl: row.source_url,
    note: row.note,
    metadata: parseJson(row.metadata_json),
    createdAt: row.created_at,
  };
}

function serializeResult(row) {
  return {
    id: row.id,
    jobId: row.job_id,
    assetId: row.asset_id,
    title: row.title,
    versionType: row.version_type,
    mediaType: row.media_type,
    imageUrl: row.image_url,
    metadata: parseJson(row.metadata_json),
    createdAt: row.created_at,
  };
}

function assertWorkflowType(type) {
  if (!WORKFLOW_DEFINITIONS.some((workflow) => workflow.id === type)) {
    throw new Error("未知工作流类型。");
  }
}

export function migrateWorkflowDatabase() {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS workflow_job (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      type TEXT NOT NULL,
      title TEXT NOT NULL,
      prompt TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('running', 'success', 'failed')),
      progress INTEGER NOT NULL,
      credits INTEGER NOT NULL,
      message TEXT NOT NULL,
      options_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES user_profile(user_id)
    );
    CREATE INDEX IF NOT EXISTS idx_workflow_job_user_created ON workflow_job(user_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS workflow_asset (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      job_id TEXT,
      kind TEXT NOT NULL,
      name TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      source_url TEXT NOT NULL,
      note TEXT NOT NULL,
      metadata_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES user_profile(user_id),
      FOREIGN KEY (job_id) REFERENCES workflow_job(id)
    );
    CREATE INDEX IF NOT EXISTS idx_workflow_asset_user_created ON workflow_asset(user_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS workflow_step (
      id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL,
      position INTEGER NOT NULL,
      title TEXT NOT NULL,
      capability TEXT NOT NULL,
      status TEXT NOT NULL,
      message TEXT NOT NULL,
      metadata_json TEXT NOT NULL,
      FOREIGN KEY (job_id) REFERENCES workflow_job(id)
    );
    CREATE INDEX IF NOT EXISTS idx_workflow_step_job_position ON workflow_step(job_id, position ASC);

    CREATE TABLE IF NOT EXISTS workflow_result (
      id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL,
      asset_id TEXT,
      title TEXT NOT NULL,
      version_type TEXT NOT NULL,
      media_type TEXT NOT NULL,
      image_url TEXT NOT NULL,
      metadata_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (job_id) REFERENCES workflow_job(id),
      FOREIGN KEY (asset_id) REFERENCES workflow_asset(id)
    );
    CREATE INDEX IF NOT EXISTS idx_workflow_result_job_created ON workflow_result(job_id, created_at ASC);

    CREATE TABLE IF NOT EXISTS trend_signal (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      job_id TEXT NOT NULL,
      keyword TEXT NOT NULL,
      score INTEGER NOT NULL,
      detail TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES user_profile(user_id),
      FOREIGN KEY (job_id) REFERENCES workflow_job(id)
    );
    CREATE INDEX IF NOT EXISTS idx_trend_signal_user_score ON trend_signal(user_id, score DESC);

    CREATE TABLE IF NOT EXISTS brand_profile (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      job_id TEXT NOT NULL,
      title TEXT NOT NULL,
      status TEXT NOT NULL,
      dna_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES user_profile(user_id),
      FOREIGN KEY (job_id) REFERENCES workflow_job(id)
    );
    CREATE INDEX IF NOT EXISTS idx_brand_profile_user_created ON brand_profile(user_id, created_at DESC);
  `);
}

export function listCommercialModels() {
  return commercialModels;
}

export function createWorkflowJob({ userId, type, title, prompt, assets = [], options = {} }) {
  assertWorkflowType(type);
  return runTransaction(() => {
    const id = `wf-${Date.now()}-${slugText(type)}-${randomUUID().slice(0, 8)}`;
    const timestamp = nowIso();
    const creditByType = {
      "fabric-to-style": 42,
      "virtual-model-showcase": 58,
      "postprocess-suite": 24,
      "trend-brand-lab": 36,
    };
    sqlite
      .prepare(
        `INSERT INTO workflow_job
          (id, user_id, type, title, prompt, status, progress, credits, message, options_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'running', 12, ?, '工作流已创建', ?, ?, ?)`,
      )
      .run(
        id,
        userId,
        type,
        String(title || WORKFLOW_DEFINITIONS.find((workflow) => workflow.id === type)?.title || "AI 工作流").slice(0, 120),
        String(prompt || "").slice(0, 4000),
        creditByType[type] || 20,
        json(options),
        timestamp,
        timestamp,
      );

    const insertedAssets = assets.map((asset) => insertAsset(userId, id, asset));
    let built;
    if (type === "fabric-to-style") {
      built = buildFabricWorkflow({ jobId: id, userId, title, prompt, assets: insertedAssets, options });
    } else if (type === "virtual-model-showcase") {
      built = buildVirtualModelWorkflow({ jobId: id, userId, title, prompt, assets: insertedAssets, options });
    } else if (type === "postprocess-suite") {
      built = buildPostprocessWorkflow({ jobId: id, userId, title, prompt, assets: insertedAssets, options });
    } else {
      built = buildTrendBrandWorkflow({ jobId: id, userId, title, prompt, assets: insertedAssets, options });
    }

    if (workflowImageProviderStatus().mode !== "live") {
      sqlite
        .prepare("UPDATE workflow_job SET status = 'success', progress = 100, message = ?, updated_at = ? WHERE id = ?")
        .run("工作流已完成，结果可继续编辑、批量处理或加入品牌资产库。", nowIso(), id);
    }

    return {
      ...serializeJob(sqlite.prepare("SELECT * FROM workflow_job WHERE id = ?").get(id)),
      assets: insertedAssets,
      steps: built.steps,
      results: built.results,
      trendSignals: built.trendSignals || [],
      brandProfile: built.brandProfile || null,
    };
  });
}

export function listWorkflowAssets(userId) {
  return sqlite
    .prepare("SELECT * FROM workflow_asset WHERE user_id = ? ORDER BY created_at DESC LIMIT 200")
    .all(userId)
    .map(serializeAsset);
}

export function getWorkflowJob(userId, id) {
  const row = sqlite.prepare("SELECT * FROM workflow_job WHERE id = ? AND user_id = ?").get(id, userId);
  if (!row) return null;
  return { ...serializeJob(row), ...rowsForJob(id) };
}

function workflowFailureEvidence(reason) {
  return {
    status: "failed",
    reason,
    nextActions: [
      "检查图像生成服务配置、额度和返回格式。",
      "查看服务响应日志、超时设置和返回格式。",
      "不要交付当前占位结果，修复外部服务后重新运行工作流。",
    ],
  };
}

export function markWorkflowJobFailed(userId, id, error) {
  const reason = error instanceof Error ? error.message : String(error || "未知错误");
  const message = `真实图像生成失败：${reason}`.slice(0, 500);
  const failureEvidence = workflowFailureEvidence(reason);
  const timestamp = nowIso();
  sqlite
    .prepare("UPDATE workflow_job SET status = 'failed', progress = 100, message = ?, updated_at = ? WHERE id = ? AND user_id = ?")
    .run(message, timestamp, id, userId);

  const existingFailureStep = sqlite.prepare("SELECT id FROM workflow_step WHERE job_id = ? AND capability = 'delivery.failure'").get(id);
  if (existingFailureStep) {
    sqlite
      .prepare("UPDATE workflow_step SET status = 'failed', message = ?, metadata_json = ? WHERE id = ?")
      .run(message, json({ failureEvidence }), existingFailureStep.id);
  } else {
    const nextPosition =
      Number(sqlite.prepare("SELECT COALESCE(MAX(position), 0) + 1 AS position FROM workflow_step WHERE job_id = ?").get(id)?.position || 1) || 1;
    sqlite
      .prepare(
        `INSERT INTO workflow_step
          (id, job_id, position, title, capability, status, message, metadata_json)
         VALUES (?, ?, ?, '真实生成失败', 'delivery.failure', 'failed', ?, ?)`,
      )
      .run(randomUUID(), id, nextPosition, message, json({ failureEvidence }));
  }

  const results = sqlite.prepare("SELECT id, metadata_json FROM workflow_result WHERE job_id = ?").all(id);
  const updateResult = sqlite.prepare("UPDATE workflow_result SET metadata_json = ? WHERE id = ?");
  for (const result of results) {
    const metadata = parseJson(result.metadata_json);
    const alreadyMaterialized = metadata.liveGenerated || metadata.videoInspection || metadata.training;
    const nextMetadata = {
      ...metadata,
      workflowFailureEvidence: failureEvidence,
      ...(alreadyMaterialized
        ? {}
        : {
            deliveryStatus: "failed",
            failureEvidence,
          }),
    };
    updateResult.run(json(nextMetadata), result.id);
  }
  const profiles = sqlite.prepare("SELECT id, dna_json FROM brand_profile WHERE job_id = ?").all(id);
  const updateProfile = sqlite.prepare("UPDATE brand_profile SET status = 'failed', dna_json = ? WHERE id = ?");
  for (const profile of profiles) {
    updateProfile.run(json({ ...parseJson(profile.dna_json), failureEvidence }), profile.id);
  }
  return getWorkflowJob(userId, id);
}

export function getWorkflowDashboard(userId) {
  const jobs = sqlite
    .prepare("SELECT * FROM workflow_job WHERE user_id = ? ORDER BY created_at DESC LIMIT 40")
    .all(userId)
    .map((row) => ({ ...serializeJob(row), ...rowsForJob(row.id) }));
  const assets = listWorkflowAssets(userId);
  const trendSignals = sqlite
    .prepare("SELECT * FROM trend_signal WHERE user_id = ? ORDER BY score DESC, created_at DESC LIMIT 20")
    .all(userId)
    .map((row) => ({
      id: row.id,
      jobId: row.job_id,
      keyword: row.keyword,
      score: row.score,
      detail: row.detail,
      createdAt: row.created_at,
    }));
  const brandProfiles = sqlite
    .prepare("SELECT * FROM brand_profile WHERE user_id = ? ORDER BY created_at DESC LIMIT 20")
    .all(userId)
    .map((row) => ({
      id: row.id,
      jobId: row.job_id,
      title: row.title,
      status: row.status,
      dna: parseJson(row.dna_json),
      createdAt: row.created_at,
    }));
  const totalJobs = sqlite.prepare("SELECT COUNT(*) AS count FROM workflow_job WHERE user_id = ?").get(userId).count;
  const totalAssets = sqlite.prepare("SELECT COUNT(*) AS count FROM workflow_asset WHERE user_id = ?").get(userId).count;
  const readyResults = sqlite
    .prepare(
      `SELECT COUNT(*) AS count
       FROM workflow_result result
       INNER JOIN workflow_job job ON job.id = result.job_id
       WHERE job.user_id = ?`,
    )
    .get(userId).count;
  const activeBrandProfiles = sqlite
    .prepare("SELECT COUNT(*) AS count FROM brand_profile WHERE user_id = ? AND status != 'failed'")
    .get(userId).count;
  const quality = sqlite
    .prepare(
      `SELECT result.metadata_json
       FROM workflow_result result
       INNER JOIN workflow_job job ON job.id = result.job_id
       WHERE job.user_id = ?`,
    )
    .all(userId)
    .map((row) => ({ metadata: parseJson(row.metadata_json) }))
    .reduce(
      (summary, result) => {
        const status = result.metadata?.qualityGate?.status;
        if (status === "passed") summary.passed += 1;
        else if (status === "review") summary.review += 1;
        else if (status === "rework") summary.rework += 1;
        else summary.unchecked += 1;
        return summary;
      },
      { passed: 0, review: 0, rework: 0, unchecked: 0 },
    );
  return {
    definitions: runtimeWorkflowDefinitions(),
    commercialModels,
    jobs,
    assets,
    trendSignals,
    brandProfiles,
    summary: {
      totalJobs,
      totalAssets,
      readyResults,
      activeBrandProfiles,
      quality,
      productionReadiness: productionReadinessSummary(),
    },
  };
}

export function registerWorkflowRoutes(app) {
  app.get("/api/workflows/definitions", async (req, res) => {
    const account = await requireAccount(req, res);
    if (!account) return;
    res.json({ definitions: runtimeWorkflowDefinitions(), commercialModels });
  });

  app.get("/api/workflows/dashboard", async (req, res) => {
    const account = await requireAccount(req, res);
    if (!account) return;
    res.json(getWorkflowDashboard(account.user.id));
  });

  app.get("/api/workflows/assets", async (req, res) => {
    const account = await requireAccount(req, res);
    if (!account) return;
    res.json({ assets: listWorkflowAssets(account.user.id) });
  });

  app.get("/api/workflows/models", async (req, res) => {
    const account = await requireAccount(req, res);
    if (!account) return;
    res.json({ models: commercialModels });
  });

  app.get("/api/workflows/jobs/:id", async (req, res) => {
    const account = await requireAccount(req, res);
    if (!account) return;
    const job = getWorkflowJob(account.user.id, req.params.id);
    if (!job) {
      res.status(404).json({ error: "工作流任务不存在。" });
      return;
    }
    res.json({ job });
  });

  app.post("/api/workflows/jobs", async (req, res) => {
    let account = null;
    let job = null;
    try {
      account = await requireAccount(req, res);
      if (!account) return;
      job = createWorkflowJob({
        userId: account.user.id,
        type: String(req.body.type || ""),
        title: String(req.body.title || ""),
        prompt: String(req.body.prompt || ""),
        assets: Array.isArray(req.body.assets) ? req.body.assets : [],
        options: req.body.options && typeof req.body.options === "object" ? req.body.options : {},
      });
      startLiveMaterialization(job);
      res.status(201).json({ job: getWorkflowJob(account.user.id, job.id) || job, dashboard: getWorkflowDashboard(account.user.id) });
    } catch (error) {
      const message = error instanceof Error ? error.message : "工作流创建失败。";
      if (account && job) {
        const failedJob = markWorkflowJobFailed(account.user.id, job.id, error);
        res.status(400).json({ error: message, job: failedJob, dashboard: getWorkflowDashboard(account.user.id) });
        return;
      }
      res.status(400).json({ error: message });
    }
  });
}
