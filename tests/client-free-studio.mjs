import assert from "node:assert/strict";
import fs from "node:fs/promises";
import ts from "typescript";

const source = await fs.readFile("src/lib/freeStudio.ts", "utf8");
const transpiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.ES2022,
    target: ts.ScriptTarget.ES2022,
  },
});
const freeStudio = await import(`data:text/javascript;base64,${Buffer.from(transpiled.outputText).toString("base64")}`);

const settings = {
  quality: "high",
  outputFormat: "png",
  background: "auto",
  inputFidelity: "standard",
};

/* ── 提示词：参考 vs 入画 ─────────────────────────────────────────────────── */

const mixedPrompt = freeStudio.buildFreePrompt(
  "把这件外套放到雪地场景里",
  [
    { id: "a", name: "coat.png", previewUrl: "data:image/png;base64,x", usage: "merge" },
    { id: "b", name: "mood.jpg", previewUrl: "data:image/jpeg;base64,y", usage: "reference" },
  ],
  settings,
);

assert(mixedPrompt.includes("上传图片1 = 入画（coat.png）"), mixedPrompt);
assert(mixedPrompt.includes("上传图片2 = 参考（mood.jpg）"), mixedPrompt);
assert(mixedPrompt.includes("入画图片要求"), mixedPrompt);
assert(mixedPrompt.includes("参考图片要求"), mixedPrompt);
assert(mixedPrompt.includes("用户描述:\n把这件外套放到雪地场景里"), mixedPrompt);
// 自由创作不套服装行业约束，这是它和创作台其它用途的核心区别。
assert(!mixedPrompt.includes("系统限制"), mixedPrompt);
assert(!mixedPrompt.includes("服装图片"), mixedPrompt);

const barePrompt = freeStudio.buildFreePrompt("一只在窗台上打盹的猫", [], settings);
assert(!barePrompt.includes("上传图片顺序"), barePrompt);
assert(!barePrompt.includes("入画图片要求"), barePrompt);
assert(!barePrompt.includes("参考图片要求"), barePrompt);
assert(barePrompt.includes("high quality, png, auto background, standard input fidelity."), barePrompt);

const referenceOnlyPrompt = freeStudio.buildFreePrompt(
  "换个更亮的背景",
  [{ id: "a", name: "ref.png", previewUrl: "data:image/png;base64,x", usage: "reference" }],
  settings,
);
assert(!referenceOnlyPrompt.includes("入画图片要求"), referenceOnlyPrompt);

/* ── 按标注改图的提示词 ─────────────────────────────────────────────────── */

const annotationPrompt = freeStudio.buildAnnotationEditPrompt("顺便把背景调亮一点", settings);
assert(annotationPrompt.includes("上传图片1 = 带人工标注的原图"), annotationPrompt);
assert(annotationPrompt.includes("箭头指向哪里，修改就发生在哪里"), annotationPrompt);
// 输出里绝不能残留标注痕迹，否则改图结果没法直接用。
assert(annotationPrompt.includes("不得保留任何标注箭头"), annotationPrompt);
assert(annotationPrompt.includes("补充说明:\n顺便把背景调亮一点"), annotationPrompt);

const bareAnnotationPrompt = freeStudio.buildAnnotationEditPrompt("", settings);
assert(!bareAnnotationPrompt.includes("补充说明"), bareAnnotationPrompt);

/* ── 按草图生成的提示词 ─────────────────────────────────────────────────── */

const sketchPrompt = freeStudio.buildSketchPrompt("要真实布料质感", settings);
assert(sketchPrompt.includes("上传图片1 = 画布上的手绘草图"), sketchPrompt);
// 草图里的文字是需求描述，不是要画进画面的字。
assert(sketchPrompt.includes("图里的文字是对画面的描述，不是要画进图里的字"), sketchPrompt);
assert(sketchPrompt.includes("不得保留任何草稿线条"), sketchPrompt);
assert(sketchPrompt.includes("补充说明:\n要真实布料质感"), sketchPrompt);
assert(!freeStudio.buildSketchPrompt("", settings).includes("补充说明"), "empty note should not emit a section");

/* ── 画布尺寸换算 ─────────────────────────────────────────────────────────── */

assert.deepEqual(freeStudio.frameSizeForRatio({ id: "2-3", width: 2, height: 3 }, 600), { w: 400, h: 600 });
assert.deepEqual(freeStudio.frameSizeForRatio({ id: "3-2", width: 3, height: 2 }, 600), { w: 600, h: 400 });

const ratios = [
  { id: "auto", width: 1, height: 1, native: true },
  { id: "1-1", width: 1, height: 1, native: true },
  { id: "2-3", width: 2, height: 3, native: true },
  { id: "3-2", width: 3, height: 2, native: true },
  { id: "9-16", width: 9, height: 16, native: false },
];
// 按标注改图要沿用原图比例，且只在真正能出图的原生比例里选。
assert.equal(freeStudio.nearestRatioId(1024, 1536, ratios), "2-3");
assert.equal(freeStudio.nearestRatioId(1536, 1024, ratios), "3-2");
assert.equal(freeStudio.nearestRatioId(1000, 1000, ratios), "1-1");
assert.notEqual(freeStudio.nearestRatioId(900, 1600, ratios), "9-16");

/* ── 界面结构与样式 ───────────────────────────────────────────────────────── */

const appSource = await fs.readFile("src/App.tsx", "utf8");
const simpleSource = await fs.readFile("src/components/SimpleComposer.tsx", "utf8");
const canvasSource = await fs.readFile("src/components/CanvasBoard.tsx", "utf8");
const freeStudioSource = await fs.readFile("src/components/FreeStudio.tsx", "utf8");
const attachmentSource = await fs.readFile("src/components/AttachmentStrip.tsx", "utf8");
const styles = await fs.readFile("src/styles.css", "utf8");

assert(appSource.includes('id: "free"'), "App should expose the free-creation view in the main navigation");
assert(appSource.includes("handleFreeGenerate"), "App should own the free-creation generation handler");
assert(appSource.includes("buildFreePrompt"), "Free creation must use the unguarded free prompt builder");

for (const token of ["simple-composer", "simple-prompt", "simple-controls", "simple-result-grid"]) {
  assert(simpleSource.includes(token), `SimpleComposer should render the ${token} structure`);
}
for (const token of ["attachment-strip", "attachment-usage", "attachment-add"]) {
  assert(attachmentSource.includes(token), `AttachmentStrip should render the ${token} structure`);
}
for (const token of ["ai-frame", "canvas-frame-panel", "canvas-sketch-actions", "canvas-share-panel"]) {
  assert(canvasSource.includes(token), `CanvasBoard should render the ${token} structure`);
}
// 画布交互对齐 Cowart：AI 画框是工具栏里的工具（A 键 / 拖放），标注是独立工具（C 键），
// 「按标注改图」长在图片工具条上，不再对着任意选中都弹一条操作栏。
assert(canvasSource.includes('kbd: "a"') && canvasSource.includes("onDragFromToolbarToCreateShape"), "AI 画框要能按 A 或从工具栏拖出来");
assert(canvasSource.includes("class AnnotationTool extends StateNode") && canvasSource.includes('kbd: "c"'), "要有独立的标注工具");
assert(canvasSource.includes("startEditingShapeWithRichText"), "拉完箭头直接进入写字");
assert(canvasSource.includes("DefaultImageToolbar") && canvasSource.includes("按标注改图"), "按标注改图放在图片工具条上");
assert(canvasSource.includes("collectAnnotationShapeIds"), "按标注改图要自动收集图周围的标注");
assert(canvasSource.includes("StylePanel: CanvasStylePanel") && canvasSource.includes("canvas-aspect-preset"), "选中画框时右侧要能改比例和尺寸");
assert(canvasSource.includes("isAspectRatioLocked"), "画框拖角只缩放不变形");
assert(canvasSource.includes("refIds"), "引用图记在画框上，不靠多选");
assert(canvasSource.includes("onPaste") && canvasSource.includes("clipboardImageFiles"), "描述框里粘贴图片要能直接成为参考图");
assert(canvasSource.includes('colorScheme: "light"'), "画布回到浅色，和工作台一致");
assert(!canvasSource.includes("canvas-top-panel"), "不再有自定义顶栏，用 tldraw 自己的工具栏");
// 画框即契约：生成结果必须原地替换画框，而不是另起一张。
assert(canvasSource.includes("editor.deleteShape(frame.id)"), "generated image must replace its AI frame");
assert(canvasSource.includes("x: box.minX, y: box.minY, w: box.width, h: box.height"), "replacement must reuse the frame box");
// 按标注改图：导出「原图 + 批注」，结果放在原图右侧，原图和批注都不动。
assert(canvasSource.includes("toImageDataUrl"), "annotation edit must export the annotated region");
assert(canvasSource.includes("x: box.maxX + RESULT_GAP"), "annotation result must be placed beside the original");
assert(canvasSource.includes("persistenceKey"), "canvas must persist locally");
assert(!canvasSource.includes("editor.deleteShape(image.id)"), "annotation edit must never delete the original image");
// 图上有标注 = 改图，纯手绘选区 = 按草图生成，走同一条导出→生成的路。
assert(canvasSource.includes('generateFromShapes(ids, "annotation"') && canvasSource.includes('"sketch", note)'), "annotation and sketch must share the export path");
assert(canvasSource.includes("darkMode: false"), "canvas export must use a light background for the image engine");
// 画布里要能直接取用生成过的成片。
for (const token of ["canvas-library", "ResultLibrary", "canvas-guide"]) {
  assert(canvasSource.includes(token), `CanvasBoard should include ${token}`);
}
assert(freeStudioSource.includes("results={results}"), "canvas must receive the generated results library");

// 仍然按需加载，但走 lazyWithReload：版本更新后老页面拿不到旧文件名时自动刷一次，而不是整页白屏。
assert(
  freeStudioSource.includes('lazyWithReload("canvas"') && freeStudioSource.includes('import("./CanvasBoard")'),
  "tldraw must be loaded on demand so it does not weigh down the studio",
);
assert(freeStudioSource.includes('<ErrorBoundary'), "canvas must sit behind an error boundary so a crash never shows a blank page");
// 白屏兜底：自检 + 切回前台时强制重绘（合成层漏画时 DOM 是好的，自检看不出来）。
assert(canvasSource.includes("useCanvasWatchdog"), "canvas must self-check for blank rendering");
assert(canvasSource.includes("visibilitychange"), "canvas must force a repaint when the tab comes back to the front");
assert(canvasSource.includes("multiple"), "Attachment inputs must accept multiple images");
assert(simpleSource.includes("multiple") || attachmentSource.includes("multiple"), "Simple mode must accept multiple images");

for (const selector of [
  ".simple-composer",
  ".attachment-strip",
  ".attachment-usage",
  ".canvas-shell",
  ".ai-frame",
  ".canvas-frame-panel",
  ".canvas-sketch-actions",
  ".canvas-share-panel",
  ".canvas-aspect-preset",
  ".canvas-annotation-tool",
  ".canvas-annotation-edit",
  ".canvas-library",
  ".canvas-guide",
]) {
  assert(styles.includes(selector), `styles.css should define ${selector}`);
}

console.log(JSON.stringify({ checks: "passed" }, null, 2));
