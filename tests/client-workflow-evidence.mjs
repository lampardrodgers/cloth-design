import assert from "node:assert/strict";
import fs from "node:fs/promises";
import ts from "typescript";

const source = await fs.readFile("src/lib/workflowEvidence.ts", "utf8");
const transpiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.ES2022,
    target: ts.ScriptTarget.ES2022,
  },
});
const workflowEvidence = await import(`data:text/javascript;base64,${Buffer.from(transpiled.outputText).toString("base64")}`);

const failedResultEvidence = workflowEvidence.workflowResultEvidence({
  mediaType: "image",
  imageUrl: "/generated-images/fallback.png",
  metadata: {
    deliveryStatus: "failed",
    failureEvidence: {
      reason: "分割服务请求超时。",
      nextActions: ["检查专用分割服务地址、密钥和额度。"],
    },
  },
});

assert.equal(failedResultEvidence.label, "生成失败");
assert.match(failedResultEvidence.detail, /分割服务请求超时/);

const failedNotice = workflowEvidence.workflowJobFailureNotice({
  status: "failed",
  message: "真实图像生成失败：分割服务请求超时。",
  steps: [
    {
      status: "failed",
      metadata: {
        failureEvidence: {
          reason: "分割服务请求超时。",
          nextActions: ["检查专用分割服务地址、密钥和额度。"],
        },
      },
    },
  ],
});

assert.equal(failedNotice.reason, "分割服务请求超时。");
assert(failedNotice.nextActions.includes("检查专用分割服务地址、密钥和额度。"));

const liveImageEvidence = workflowEvidence.workflowResultEvidence({
  mediaType: "image",
  imageUrl: "/generated-images/live.png",
  metadata: {
    liveGenerated: true,
    generationMode: "image_edit",
    imageModel: "gpt-image-2",
    assetInputCount: 2,
  },
});
assert.equal(liveImageEvidence.label, "真实 image edit");
assert.equal(liveImageEvidence.detail, "gpt-image-2 · 输入 2");

const fabricAnalysisText = workflowEvidence.workflowFabricAnalysisText({
  metadata: {
    fabricAnalysis: {
      colors: ["moss green", "ivory"],
      pattern: "stripe",
      texture: "woven stripe",
      analysisSource: "image",
    },
  },
});
assert.equal(fabricAnalysisText, "来源 图片解析 · 颜色 moss green / ivory · 图案 stripe · 纹理 woven stripe");

const fabricInputText = workflowEvidence.workflowFabricInputText({
  metadata: {
    multimodalInput: {
      inputModes: ["面料图片", "设计草图", "文字描述"],
      assetNames: ["uploaded-floral-fabric.png", "uploaded-shirt-sketch.png"],
      textDescription: "廓形偏A字，颜色保留暖白和鼠尾草绿",
    },
  },
});
assert.equal(fabricInputText, "输入 面料图片/设计草图/文字描述 · uploaded-floral-fabric.png / uploaded-shirt-sketch.png · 廓形偏A字，颜色保留暖白和鼠尾草绿");

const styleRecommendationText = workflowEvidence.workflowStyleRecommendationText({
  metadata: {
    styleRecommendation: {
      silhouette: "soft A-line dress",
      rationale: "stripe 与 woven stripe 更适合 soft A-line dress",
    },
    variation: {
      focus: "换色方案",
      detail: "保留图案结构，调整主辅色占比",
    },
  },
});
assert.equal(styleRecommendationText, "推荐 soft A-line dress · 换色方案：保留图案结构，调整主辅色占比");

const styleMatchText = workflowEvidence.workflowStyleMatchText({
  metadata: {
    styleRecommendation: {
      recommendedCategory: "dress",
      silhouette: "soft A-line dress",
      palette: ["moss green", "ivory"],
      rationale: "stripe 与 woven stripe 更适合 soft A-line dress",
    },
  },
});
assert.equal(styleMatchText, "匹配 dress · soft A-line dress · moss green / ivory · stripe 与 woven stripe 更适合 soft A-line dress");

const editControlText = workflowEvidence.workflowEditControlText({
  metadata: {
    precisionEdit: {
      hemLengthPercent: 82,
      sleeveLengthPercent: 35,
      necklineDepthPercent: 46,
    },
  },
});
assert.equal(editControlText, "细节控制 衣长82% · 袖长35% · 领口开度46%");

const patternEditControlText = workflowEvidence.workflowEditControlText({
  metadata: {
    precisionEdit: {
      patternLabel: "条纹",
      hemLengthPercent: 82,
      sleeveLengthPercent: 35,
      necklineDepthPercent: 46,
    },
  },
});
assert.equal(patternEditControlText, "细节控制 面料图案条纹 · 衣长82% · 袖长35% · 领口开度46%");

const virtualModelText = workflowEvidence.workflowVirtualModelText({
  metadata: {
    virtualModelSelection: {
      modelName: "儿童模特",
      sceneLabel: "森林",
      poseId: "walking",
      poseLabel: "行走",
      ageGroup: "child",
      ageGroupLabel: "儿童",
      bodyType: "standard",
      bodyTypeLabel: "标准",
      gender: "female",
      genderLabel: "女",
      commercialUse: true,
    },
  },
});
assert.equal(virtualModelText, "儿童模特 · 森林 · 行走 · 儿童/标准/女 · 可商用");

const tryOnSourceText = workflowEvidence.workflowTryOnSourceText({
  metadata: {
    tryOnSource: {
      sourceLabel: "平铺图",
      inputName: "kids-dress-flatlay.png",
    },
  },
});
assert.equal(tryOnSourceText, "来源 平铺图 · kids-dress-flatlay.png");

const batchPostprocessText = workflowEvidence.workflowPostprocessBatchText({
  metadata: {
    batchOperation: {
      inputName: "look-2.png",
      batchIndex: 4,
      batchTotal: 6,
      sceneLabel: "城市街景",
      targetRatio: "1:1",
      targetColor: "sage",
      targetColorLabel: "鼠尾草绿",
      actionLabels: ["智能抠图", "调整图片比例"],
    },
  },
});
assert.equal(batchPostprocessText, "批量 4/6 · look-2.png · 城市街景 · 1:1 · 鼠尾草绿 · 智能抠图/调整图片比例");

const postprocessTuningText = workflowEvidence.workflowPostprocessTuningText({
  metadata: {
    postprocessTuning: {
      eraseTarget: "衣服旁边的多余衣架",
      lightStrength: 72,
      beautyLevel: 38,
      repairFocusLabel: "手部",
    },
  },
});
assert.equal(postprocessTuningText, "精修 擦除衣服旁边的多余衣架 · 补光72% · 美体38% · 修复重点手部");

const segmentedCutoutQualityText = workflowEvidence.workflowCutoutQualityText({
  metadata: {
    actions: ["cutout"],
    generationMode: "segmentation_service",
    segmentationServiceUsed: true,
    imageInspection: {
      alpha: {
        transparentPixels: 196608,
        opaquePixels: 65536,
      },
    },
    qualityGate: {
      status: "passed",
      checks: ["transparent_alpha"],
    },
  },
});
assert.equal(segmentedCutoutQualityText, "抠图 alpha 已验证 · 透明像素196608 · 主体65536 · 分割服务");

const repairedCutoutQualityText = workflowEvidence.workflowCutoutQualityText({
  metadata: {
    actions: ["cutout"],
    generationMode: "image_edit",
    imageRepairSucceeded: true,
    imageInspection: {
      alpha: {
        transparentPixels: 196608,
        opaquePixels: 65536,
      },
    },
    qualityGate: {
      status: "passed",
      checks: ["transparent_alpha"],
    },
  },
});
assert.equal(repairedCutoutQualityText, "抠图 alpha 已验证 · 透明像素196608 · 主体65536 · 棋盘格修复");

const localBackgroundCutoutQualityText = workflowEvidence.workflowCutoutQualityText({
  metadata: {
    actions: ["cutout"],
    generationMode: "image_edit",
    imageRepairSucceeded: true,
    imageInspection: {
      repair: {
        method: "solid_background",
      },
      alpha: {
        transparentPixels: 196608,
        opaquePixels: 65536,
      },
    },
    qualityGate: {
      status: "passed",
      checks: ["transparent_alpha"],
    },
  },
});
assert.equal(localBackgroundCutoutQualityText, "抠图 alpha 已验证 · 透明像素196608 · 主体65536 · 本地背景抠图");

const missingAlphaCutoutQualityText = workflowEvidence.workflowCutoutQualityText({
  metadata: {
    actions: ["cutout"],
    qualityGate: {
      status: "rework",
      warnings: ["cutout_alpha_missing"],
    },
  },
});
assert.equal(missingAlphaCutoutQualityText, "抠图待返工 未检测到透明 alpha");

const backgroundNotRemovedCutoutQualityText = workflowEvidence.workflowCutoutQualityText({
  metadata: {
    actions: ["cutout"],
    qualityGate: {
      status: "rework",
      warnings: ["cutout_background_not_removed"],
    },
  },
});
assert.equal(backgroundNotRemovedCutoutQualityText, "抠图待返工 背景未去净");

console.log(JSON.stringify({ checks: "passed" }, null, 2));
