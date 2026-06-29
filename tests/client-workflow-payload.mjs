import assert from "node:assert/strict";
import fs from "node:fs/promises";
import ts from "typescript";

let source = await fs.readFile("src/lib/workflowPayload.ts", "utf8");
source = source.replace(/import type .*?;\n/s, "");
const transpiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.ES2022,
    target: ts.ScriptTarget.ES2022,
  },
});
const workflowPayload = await import(`data:text/javascript;base64,${Buffer.from(transpiled.outputText).toString("base64")}`);

const createdAssets = [];
const createDemoAsset = (kind, name, note = "") => {
  createdAssets.push({ kind, name, note });
  return { kind, name, mimeType: "image/png", sourceUrl: `data:image/png;base64,${kind}`, note };
};

const fabricPayload = workflowPayload.buildWorkflowPayload("fabric-to-style", {
  createDemoAsset,
  fabricControls: {
    pattern: "stripe",
    hemLength: "maxi",
    sleeveLength: "sleeveless",
    neckline: "v-neck",
    hemLengthPercent: 112,
    sleeveLengthPercent: -10,
    necklineDepthPercent: 47.7,
    variants: 6,
  },
});
assert.equal(fabricPayload.options.variants, 6);
assert.deepEqual(fabricPayload.options.editControls, {
  hemLength: "maxi",
  hemLengthPercent: 100,
  sleeveLength: "sleeveless",
  sleeveLengthPercent: 0,
  neckline: "v-neck",
  necklineDepthPercent: 48,
  pattern: "stripe",
});
assert(fabricPayload.prompt.includes("条纹"));
assert(fabricPayload.prompt.includes("V领"));
assert(fabricPayload.prompt.includes("长裙摆"));
assert(fabricPayload.prompt.includes("无袖"));
assert(fabricPayload.prompt.includes("衣长100%"));
assert(fabricPayload.prompt.includes("袖长0%"));
assert(fabricPayload.prompt.includes("领口开度48%"));
assert.equal(fabricPayload.assets[0].name, "moss-stripe.png");
assert(createdAssets.some((asset) => asset.note.includes("stripe pattern")));

const virtualPayload = workflowPayload.buildWorkflowPayload("virtual-model-showcase", {
  createDemoAsset,
  virtualModelControls: {
    modelId: "plus-global-01",
    sceneId: "city",
    poseId: "turnaround",
  },
});
assert.equal(virtualPayload.options.modelId, "plus-global-01");
assert.equal(virtualPayload.options.sceneId, "city");
assert.equal(virtualPayload.options.poseId, "turnaround");
assert(virtualPayload.prompt.includes("大码模特"));
assert(virtualPayload.prompt.includes("城市街景"));
assert(virtualPayload.prompt.includes("转身"));

const defaultSketchVirtualPayload = workflowPayload.buildWorkflowPayload("virtual-model-showcase", {
  createDemoAsset,
  virtualModelInputs: {
    sourceType: "designSketch",
    description: "",
    assets: [],
  },
});
assert.equal(defaultSketchVirtualPayload.assets[0].kind, "designSketch");
assert.equal(defaultSketchVirtualPayload.assets[0].name, "design-sketch-source.png");
assert(defaultSketchVirtualPayload.prompt.includes("上传设计图"));
assert.equal(workflowPayload.virtualSourceFallbackLabel("designSketch"), "默认设计图素材");

const postprocessPayload = workflowPayload.buildWorkflowPayload("postprocess-suite", {
  createDemoAsset,
  reusablePostprocessAssets: [
    { kind: "result", name: "text-1200-1.png", mimeType: "image/png", sourceUrl: "/generated-images/11111111-1111-4111-8111-111111111111.png", note: "real" },
  ],
  postprocessControls: {
    actions: ["cutout", "enhance", "erase"],
    targetColor: "sage",
    targetRatio: "3:4",
    targetScenes: ["studio"],
    eraseTarget: "衣服旁边的多余衣架",
    lightStrength: 72.4,
    beautyLevel: 38.2,
    repairFocus: "hands",
  },
});
assert.equal(postprocessPayload.assets[0].name, "text-1200-1.png");
assert.deepEqual(postprocessPayload.options.actions, ["cutout", "enhance", "erase"]);
assert.equal(postprocessPayload.options.targetColor, "sage");
assert.equal(postprocessPayload.options.targetRatio, "3:4");
assert.deepEqual(postprocessPayload.options.postprocessTuning, {
  eraseTarget: "衣服旁边的多余衣架",
  lightStrength: 72,
  beautyLevel: 38,
  repairFocus: "hands",
  repairFocusLabel: "手部",
});
assert(postprocessPayload.prompt.includes("前面真实生成的商品图"));
assert(postprocessPayload.prompt.includes("对象擦除"));
assert(postprocessPayload.prompt.includes("擦除目标衣服旁边的多余衣架"));
assert(postprocessPayload.prompt.includes("补光72%"));
assert(postprocessPayload.prompt.includes("美体38%"));
assert(postprocessPayload.prompt.includes("修复重点手部"));
assert(!postprocessPayload.prompt.includes("手部修复"));

const defaultPostprocessPayload = workflowPayload.buildWorkflowPayload("postprocess-suite", { createDemoAsset });
assert(defaultPostprocessPayload.options.actions.includes("erase"));
assert(defaultPostprocessPayload.prompt.includes("对象擦除"));

const userFabricPayload = workflowPayload.buildWorkflowPayload("fabric-to-style", {
  createDemoAsset,
  fabricControls: {
    pattern: "floral",
    hemLength: "mini",
    sleeveLength: "long",
    neckline: "shirt",
    variants: 2,
  },
  fabricInputs: {
    textDescription: "廓形偏A字，颜色保留暖白和鼠尾草绿，适合度假系列。",
    garmentCategory: "skirt",
    assets: [
      { kind: "fabric", name: "uploaded-floral-fabric.png", mimeType: "image/png", sourceUrl: "data:image/png;base64,fabric", note: "用户上传面料" },
      { kind: "sketch", name: "uploaded-shirt-sketch.png", mimeType: "image/png", sourceUrl: "data:image/png;base64,sketch", note: "用户上传草图" },
    ],
  },
});
assert.deepEqual(userFabricPayload.assets.map((asset) => asset.name), ["uploaded-floral-fabric.png", "uploaded-shirt-sketch.png"]);
assert.equal(userFabricPayload.options.garmentCategory, "skirt");
assert(userFabricPayload.prompt.includes("廓形偏A字"));
assert(userFabricPayload.prompt.includes("度假系列"));
assert.deepEqual(userFabricPayload.options.inputSummary.inputModes, ["面料图片", "设计草图", "文字描述"]);
assert.deepEqual(userFabricPayload.options.inputSummary.assetKinds, ["fabric", "sketch"]);
assert(userFabricPayload.prompt.includes("多模态输入：面料图片、设计草图、文字描述"));

assert(workflowPayload.modelControlOptions.length >= 18);
assert(workflowPayload.modelControlOptions.some((option) => option.id === "black-adult-01"));
assert(workflowPayload.modelControlOptions.some((option) => option.id === "senior-global-01"));
assert(workflowPayload.modelControlOptions.some((option) => option.id === "child-black-01"));
assert(workflowPayload.modelControlOptions.some((option) => option.id === "plus-south-asian-01"));
assert(workflowPayload.modelControlOptions.some((option) => option.id === "senior-east-asian-male-01"));
assert(workflowPayload.filteredModelOptions("child").every((option) => option.ageGroup === "child"));
assert(workflowPayload.filteredModelOptions("child").some((option) => option.id === "child-black-01"));
assert(workflowPayload.filteredModelOptions("plus").every((option) => option.bodyType === "plus"));
assert(workflowPayload.filteredModelOptions("plus").some((option) => option.id === "plus-south-asian-01"));
assert(workflowPayload.filteredModelOptions("menswear").every((option) => option.gender === "male"));
assert(workflowPayload.filteredModelOptions("diverse").some((option) => option.id === "middle-eastern-female-01"));
assert.equal(workflowPayload.modelCollectionFilterLabel("diverse"), "多元人种");
const dynamicModelOptions = workflowPayload.commercialModelsToModelOptions([
  {
    id: "server-only-plus-01",
    name: "服务端新增大码模特",
    ethnicity: "global",
    ageGroup: "adult",
    bodyType: "plus",
    gender: "female",
    commercialUse: true,
    poses: ["standing"],
  },
]);
assert.deepEqual(dynamicModelOptions.map((option) => [option.id, option.label, option.prompt]), [["server-only-plus-01", "服务端新增大码模特", "服务端新增大码模特"]]);
assert.equal(workflowPayload.filteredModelOptions("plus", dynamicModelOptions)[0].id, "server-only-plus-01");
assert.deepEqual(workflowPayload.compatiblePoseOptions("server-only-plus-01", dynamicModelOptions).map((option) => option.id), ["standing"]);
const dynamicVirtualPayload = workflowPayload.buildWorkflowPayload("virtual-model-showcase", {
  createDemoAsset,
  modelOptions: dynamicModelOptions,
  virtualModelControls: {
    modelId: "server-only-plus-01",
    sceneId: "studio",
    poseId: "turnaround",
  },
});
assert.equal(dynamicVirtualPayload.options.modelId, "server-only-plus-01");
assert.equal(dynamicVirtualPayload.options.poseId, "standing");
assert(dynamicVirtualPayload.prompt.includes("服务端新增大码模特"));
const middleEasternPoseOptions = workflowPayload.compatiblePoseOptions("middle-eastern-adult-01");
assert.deepEqual(middleEasternPoseOptions.map((option) => option.id), ["standing", "walking"]);
assert.equal(workflowPayload.modelProfileText("plus-global-01"), "大码模特 · 全球/成年/大码/女 · 可商用");
const unsupportedPoseVirtualPayload = workflowPayload.buildWorkflowPayload("virtual-model-showcase", {
  createDemoAsset,
  virtualModelControls: {
    modelId: "middle-eastern-adult-01",
    sceneId: "city",
    poseId: "turnaround",
  },
});
assert.equal(unsupportedPoseVirtualPayload.options.poseId, "standing");
assert(unsupportedPoseVirtualPayload.prompt.includes("站立姿势"));
assert(!unsupportedPoseVirtualPayload.prompt.includes("转身姿势"));

const userVirtualPayload = workflowPayload.buildWorkflowPayload("virtual-model-showcase", {
  createDemoAsset,
  virtualModelControls: {
    modelId: "black-adult-01",
    sceneId: "grassland",
    poseId: "standing",
  },
  virtualModelInputs: {
    sourceType: "mannequin",
    description: "男装夹克人台图，保留硬挺肩线和拉链细节。",
    assets: [{ kind: "mannequin", name: "uploaded-mens-jacket-mannequin.png", mimeType: "image/png", sourceUrl: "data:image/png;base64,garment", note: "用户上传人台图" }],
  },
});
assert.equal(userVirtualPayload.assets[0].name, "uploaded-mens-jacket-mannequin.png");
assert.equal(userVirtualPayload.assets[0].kind, "mannequin");
assert.equal(userVirtualPayload.options.modelId, "black-adult-01");
assert.equal(userVirtualPayload.options.makeVideo, false);
assert(userVirtualPayload.prompt.includes("黑人成年女模特"));
assert(userVirtualPayload.prompt.includes("草地场景"));
assert(userVirtualPayload.prompt.includes("人台图"));
assert(userVirtualPayload.prompt.includes("硬挺肩线"));

const uploadedPostprocessPayload = workflowPayload.buildWorkflowPayload("postprocess-suite", {
  createDemoAsset,
  postprocessInputs: {
    assets: [
      { kind: "result", name: "batch-look-1.png", mimeType: "image/png", sourceUrl: "data:image/png;base64,one", note: "用户上传后期图1" },
      { kind: "result", name: "batch-look-2.png", mimeType: "image/png", sourceUrl: "data:image/png;base64,two", note: "用户上传后期图2" },
    ],
  },
  postprocessControls: {
    actions: ["cutout", "resize"],
    targetColor: "original",
    targetRatio: "1:1",
    targetScenes: ["studio", "city"],
  },
});
assert.deepEqual(uploadedPostprocessPayload.assets.map((asset) => asset.name), ["batch-look-1.png", "batch-look-2.png"]);
assert.deepEqual(uploadedPostprocessPayload.options.targetScenes, ["studio", "city"]);
assert(uploadedPostprocessPayload.prompt.includes("棚拍场景"));
assert(uploadedPostprocessPayload.prompt.includes("城市街景"));
assert.equal(
  workflowPayload.postprocessBatchPreviewText(
    {
      actions: ["cutout", "resize"],
      targetColor: "original",
      targetRatio: "1:1",
      targetScenes: ["studio", "city"],
    },
    2,
  ),
  "预计输出 4 张 · 输入2 · 场景2 · 智能抠图/比例调整",
);

console.log(JSON.stringify({ checks: "passed" }, null, 2));
