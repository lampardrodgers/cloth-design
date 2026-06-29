import { useEffect, useMemo, useRef, useState, type PointerEvent } from "react";
import {
  BadgeCheck,
  Brush,
  CircleAlert,
  Clapperboard,
  HelpCircle,
  ImageUp,
  Layers3,
  Loader2,
  PlayCircle,
  Scissors,
  SlidersHorizontal,
  Shirt,
  Sparkles,
  SwatchBook,
  X,
} from "lucide-react";
import { createWorkflowJob, fetchWorkflowDashboard, generatedResultsToWorkflowAssets, workflowResultsToWorkflowAssets } from "../lib/api";
import { fabricControlsFromPreviewPoint, fabricPreviewLayout, type FabricPreviewHandle } from "../lib/fabricPreview";
import {
  workflowCutoutQualityText,
  workflowEditControlText,
  workflowFabricAnalysisText,
  workflowFabricInputText,
  workflowJobFailureNotice,
  workflowPostprocessBatchText,
  workflowPostprocessTuningText,
  workflowResultEvidence,
  workflowStyleRecommendationText,
  workflowStyleMatchText,
  workflowTryOnSourceText,
  workflowVirtualModelText,
} from "../lib/workflowEvidence";
import {
	  buildWorkflowPayload as buildControlledWorkflowPayload,
	  defaultFabricControls,
	  defaultFabricInputs,
	  defaultPostprocessControls,
	  defaultPostprocessInputs,
	  defaultVirtualModelControls,
	  defaultVirtualModelInputs,
	  fabricPatternOptions,
	  compatiblePoseOptions,
	  commercialModelsToModelOptions,
	  hemLengthOptions,
	  modelProfileText,
	  filteredModelOptions,
	  modelCollectionFilterOptions,
	  modelControlOptions,
	  necklineOptions,
	  postprocessActionOptions,
	  postprocessBatchPreviewText,
	  postprocessRepairFocusOptions,
	  postprocessSceneOptions,
	  sceneControlOptions,
	  sleeveLengthOptions,
	  targetColorOptions,
	  targetRatioOptions,
	  virtualSourceFallbackLabel,
	  virtualSourceOptions,
	  type FabricControls,
	  type FabricInputs,
	  type ModelCollectionFilter,
	  type PostprocessControls,
	  type PostprocessInputs,
	  type VirtualModelControls,
	  type VirtualModelInputs,
	} from "../lib/workflowPayload";
import type { GeneratedResult, WorkflowAsset, WorkflowDashboard, WorkflowJob, WorkflowResult, WorkflowType } from "../types";
import { Button, Metric, Section } from "./ui";

type CoreWorkflowType = Extract<WorkflowType, "fabric-to-style" | "virtual-model-showcase" | "postprocess-suite">;

const workflowTabs: Array<{ id: CoreWorkflowType; module: string; label: string; short: string; outcome: string; icon: typeof Sparkles }> = [
  { id: "fabric-to-style", module: "模块一", label: "面料到款式", short: "面料图 + 描述 + 草图", outcome: "款式方案与裂变", icon: SwatchBook },
  { id: "virtual-model-showcase", module: "模块二", label: "虚拟模特展示", short: "平铺图 / 人台图 / 设计图", outcome: "逼真上身效果", icon: Shirt },
  { id: "postprocess-suite", module: "模块三", label: "图像后期优化", short: "服装图 / 模特图 / 批量图", outcome: "抠图、美化、修复", icon: Scissors },
];

const workflowGuides: Record<CoreWorkflowType, Array<{ icon: typeof Sparkles; title: string; detail: string }>> = {
  "fabric-to-style": [
    { icon: ImageUp, title: "放入面料", detail: "面料图、草图和一句需求都可以用。" },
    { icon: SlidersHorizontal, title: "调款式", detail: "改图案、衣长、袖长和领口。" },
    { icon: PlayCircle, title: "生成变体", detail: "一次拿到多个可比较方案。" },
  ],
  "virtual-model-showcase": [
    { icon: ImageUp, title: "放入服装图", detail: "平铺图、人台图或设计图都可试穿。" },
    { icon: SlidersHorizontal, title: "选模特场景", detail: "儿童、大码、熟龄、不同人种都可选。" },
    { icon: PlayCircle, title: "生成上身图", detail: "直接看静态商业展示效果。" },
  ],
  "postprocess-suite": [
    { icon: ImageUp, title: "放入商品图", detail: "支持多张图一起处理。" },
    { icon: SlidersHorizontal, title: "选择后期动作", detail: "抠图、补光、修复、擦除、重色。" },
    { icon: PlayCircle, title: "批量交付", detail: "生成可下载的处理结果。" },
  ],
};

const moduleRequirements: Record<
  CoreWorkflowType,
  {
    module: string;
    title: string;
    promise: string;
    inputTitle: string;
    outputTitle: string;
    requirements: Array<{ title: string; detail: string }>;
  }
> = {
  "fabric-to-style": {
    module: "模块一",
    title: "面料到款式的智能生成",
    promise: "同时理解面料图片、文字风格描述和设计草图，先解析面料，再生成可编辑、可裂变的服装款式。",
    inputTitle: "输入：面料图片、款式/风格/颜色描述、设计草图",
    outputTitle: "输出：款式推荐、结构调整、配色/印花/细节变体",
    requirements: [
      { title: "多模态输入与理解", detail: "接收面料图片、文字描述和设计草图，不要求用户懂模型参数。" },
      { title: "智能面料解析与匹配", detail: "提取颜色、图案、纹理属性，并匹配适合的服装品类和版型。" },
      { title: "可控的款式生成与编辑", detail: "支持更换面料图案，拖拽或滑杆调整衣长、袖长、领口形状。" },
      { title: "款式拓展与裂变", detail: "基于一个基础款式生成多种配色、印花和细节版本。" },
    ],
  },
  "virtual-model-showcase": {
    module: "模块二",
    title: "虚拟模特的智能生成与展示",
    promise: "上传服装平铺图、人台图或设计图，选择模特、场景和动作，快速得到可评审的上身效果。",
    inputTitle: "输入：平铺图、人台图、设计图、模特/场景/姿势选择",
    outputTitle: "输出：上身效果图、场景图、动作分镜/动效预览",
    requirements: [
      { title: "从款式图到上身效果", detail: "把上传服装自动穿到虚拟模特身上，生成逼真静态展示图。" },
      { title: "丰富的虚拟模特库", detail: "覆盖不同人种、儿童、熟龄、大码、男装和女装模特。" },
      { title: "场景与动作的自由切换", detail: "切换城市、森林、草地、棚拍等背景，并选择站立、行走、转身等姿势。" },
    ],
  },
  "postprocess-suite": {
    module: "模块三",
    title: "图像后期处理与优化",
    promise: "把服装图或模特图批量放进来，一次完成抠图、补光、画质增强、修复、重色和比例调整。",
    inputTitle: "输入：单张或多张服装/模特/商品图片",
    outputTitle: "输出：透明底图、精修图、多场景批量图",
    requirements: [
      { title: "智能抠图", detail: "将服装或模特从复杂背景中分离，输出可继续使用的主体图。" },
      { title: "图片美化与增强", detail: "支持智能补光、画质增强、美体和手部修复，提升电商质感。" },
      { title: "细节微调与修复", detail: "支持对象擦除、智能重色和图片比例调整。" },
      { title: "批量处理", detail: "多张图片可批量抠图，并批量生成不同场景版本。" },
    ],
  },
};

const fallbackDemoPng =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";

function createDemoAssetUrl(kind: WorkflowAsset["kind"], note: string) {
  if (typeof document === "undefined") return fallbackDemoPng;
  const canvas = document.createElement("canvas");
  canvas.width = 512;
  canvas.height = 512;
  const ctx = canvas.getContext("2d");
  if (!ctx) return fallbackDemoPng;

  ctx.fillStyle = "#f5f3ea";
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  if (kind === "fabric") {
    ctx.fillStyle = "#5f7d52";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.strokeStyle = "rgba(220, 235, 172, 0.28)";
    for (let x = 0; x < canvas.width; x += 32) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, canvas.height);
      ctx.stroke();
    }
    for (let y = 0; y < canvas.height; y += 28) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(canvas.width, y);
      ctx.stroke();
    }
    ctx.fillStyle = "rgba(183, 207, 96, 0.42)";
    for (let y = 42; y < canvas.height; y += 78) {
      for (let x = 54; x < canvas.width; x += 86) {
        ctx.beginPath();
        ctx.ellipse(x, y, 13, 22, 0.2, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  } else if (kind === "sketch") {
    ctx.strokeStyle = "#252822";
    ctx.lineWidth = 10;
    ctx.beginPath();
    ctx.moveTo(172, 120);
    ctx.lineTo(340, 120);
    ctx.lineTo(394, 444);
    ctx.quadraticCurveTo(256, 482, 118, 444);
    ctx.lineTo(172, 120);
    ctx.moveTo(172, 120);
    ctx.lineTo(116, 204);
    ctx.moveTo(340, 120);
    ctx.lineTo(396, 204);
    ctx.stroke();
  } else if (kind === "garment") {
    ctx.fillStyle = "#ede4ce";
    ctx.beginPath();
    ctx.moveTo(188, 92);
    ctx.lineTo(324, 92);
    ctx.lineTo(414, 462);
    ctx.quadraticCurveTo(256, 492, 98, 462);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = "rgba(118, 104, 84, 0.35)";
    for (let x = 176; x < 340; x += 34) {
      ctx.beginPath();
      ctx.moveTo(x, 112);
      ctx.lineTo(x + 18, 456);
      ctx.stroke();
    }
  } else if (kind === "result") {
    ctx.fillStyle = "#c9beb1";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = "#c98f72";
    ctx.beginPath();
    ctx.arc(256, 86, 34, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = note.includes("green") ? "#5f7d52" : "#efe6d0";
    ctx.beginPath();
    ctx.moveTo(174, 154);
    ctx.lineTo(338, 154);
    ctx.lineTo(394, 438);
    ctx.quadraticCurveTo(256, 468, 118, 438);
    ctx.closePath();
    ctx.fill();
  } else {
    ctx.fillStyle = "#edd36c";
    ctx.fillRect(80, 106, 168, 312);
    ctx.fillStyle = "#9bb08c";
    ctx.fillRect(264, 168, 156, 250);
  }

  return canvas.toDataURL("image/png");
}

function demoAsset(kind: WorkflowAsset["kind"], name: string, note = ""): WorkflowAsset {
  return {
    kind,
    name,
    mimeType: "image/png",
    sourceUrl: createDemoAssetUrl(kind, note),
    note,
  };
}

function readFileAsDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(reader.error || new Error("图片读取失败"));
    reader.readAsDataURL(file);
  });
}

async function fileToWorkflowAsset(file: File, kind: WorkflowAsset["kind"], note: string): Promise<WorkflowAsset> {
  return {
    kind,
    name: file.name,
    mimeType: file.type || "image/png",
    sourceUrl: await readFileAsDataUrl(file),
    note,
  };
}

function assetNameList(assets: WorkflowAsset[], fallback: string) {
  return assets.length > 0 ? assets.map((asset) => asset.name).join(" / ") : fallback;
}

function textList(value: unknown) {
  if (Array.isArray(value)) return value.join(" / ");
  if (typeof value === "string") return value;
  return "";
}

function latestByType(jobs: WorkflowJob[], type: WorkflowType) {
  return jobs.find((job) => job.type === type);
}

function optionIndex(options: Array<{ id: string }>, id: string) {
  return Math.max(0, options.findIndex((option) => option.id === id));
}

function clampControlPercent(value: number) {
  if (!Number.isFinite(value)) return 0;
  return Math.min(Math.max(Math.round(value), 0), 100);
}

function FabricPreviewEditor({ controls, onChange }: { controls: FabricControls; onChange: (patch: Partial<FabricControls>) => void }) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const activeHandleRef = useRef<FabricPreviewHandle | null>(null);
  const layout = fabricPreviewLayout(controls);

  const updateFromPointer = (handle: FabricPreviewHandle, event: PointerEvent) => {
    const rect = rootRef.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0 || rect.height <= 0) return;
    const point = {
      x: ((event.clientX - rect.left) / rect.width) * 100,
      y: ((event.clientY - rect.top) / rect.height) * 100,
    };
    onChange(fabricControlsFromPreviewPoint(handle, point));
  };

  const startDrag = (handle: FabricPreviewHandle, event: PointerEvent<HTMLButtonElement>) => {
    activeHandleRef.current = handle;
    rootRef.current?.setPointerCapture(event.pointerId);
    updateFromPointer(handle, event);
  };

  const moveDrag = (event: PointerEvent<HTMLDivElement>) => {
    if (!activeHandleRef.current) return;
    updateFromPointer(activeHandleRef.current, event);
  };

  const endDrag = (event: PointerEvent<HTMLDivElement>) => {
    activeHandleRef.current = null;
    if (rootRef.current?.hasPointerCapture(event.pointerId)) {
      rootRef.current.releasePointerCapture(event.pointerId);
    }
  };

  return (
    <div className="fabric-preview-editor wide-control">
      <div className="fabric-preview-head">
        <strong>可视调整</strong>
        <span>{layout.summary}</span>
      </div>
      <div
        ref={rootRef}
        className="fabric-preview-canvas"
        onPointerMove={moveDrag}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      >
        <svg aria-hidden="true" viewBox="0 0 100 100" preserveAspectRatio="none">
          <path d={layout.path} />
          <line x1="50" y1="16" x2="50" y2="91" />
          <line x1="4" y1="41" x2="34" y2="41" />
          <line x1="50" y1="14" x2="50" y2="64" />
        </svg>
        <button
          aria-label="拖拽调整衣长"
          className="fabric-preview-handle hem"
          onPointerDown={(event) => startDrag("hemLengthPercent", event)}
          style={{ left: `${layout.handles.hem.x}%`, top: `${layout.handles.hem.y}%` }}
          type="button"
        />
        <button
          aria-label="拖拽调整袖长"
          className="fabric-preview-handle sleeve"
          onPointerDown={(event) => startDrag("sleeveLengthPercent", event)}
          style={{ left: `${layout.handles.sleeve.x}%`, top: `${layout.handles.sleeve.y}%` }}
          type="button"
        />
        <button
          aria-label="拖拽调整领口开度"
          className="fabric-preview-handle neckline"
          onPointerDown={(event) => startDrag("necklineDepthPercent", event)}
          style={{ left: `${layout.handles.neckline.x}%`, top: `${layout.handles.neckline.y}%` }}
          type="button"
        />
      </div>
      <div className="fabric-preview-stats">
        <span>衣长 {layout.normalized.hemLengthPercent}%</span>
        <span>袖长 {layout.normalized.sleeveLengthPercent}%</span>
        <span>领口 {layout.normalized.necklineDepthPercent}%</span>
      </div>
    </div>
  );
}

function WorkflowGuide({ type }: { type: CoreWorkflowType }) {
  return (
    <div className="workflow-guide" aria-label="使用步骤">
      {workflowGuides[type].map((item, index) => {
        const Icon = item.icon;
        return (
          <article key={item.title}>
            <span>{index + 1}</span>
            <Icon size={16} />
            <div>
              <strong>{item.title}</strong>
              <small>{item.detail}</small>
            </div>
          </article>
        );
      })}
    </div>
  );
}

function ModuleHelpPopover({ active, onClose }: { active: CoreWorkflowType; onClose: () => void }) {
  const spec = moduleRequirements[active];
  return (
    <section className="module-help-popover" aria-label={`${spec.title}功能说明`}>
      <div className="module-help-head">
        <div>
          <span>{spec.module}</span>
          <h2>{spec.title}</h2>
        </div>
        <button aria-label="关闭功能说明" onClick={onClose} type="button">
          <X size={16} />
        </button>
      </div>
      <p>{spec.promise}</p>
      <div className="module-help-io">
        <strong>{spec.inputTitle}</strong>
        <strong>{spec.outputTitle}</strong>
      </div>
      <div className="module-help-list">
        {spec.requirements.map((requirement) => (
          <article key={requirement.title}>
            <strong>{requirement.title}</strong>
            <span>{requirement.detail}</span>
          </article>
        ))}
      </div>
    </section>
  );
}

function WorkflowFieldNote({ children }: { children: string }) {
  return <small className="workflow-field-note">{children}</small>;
}

function resultVersionLabel(result: WorkflowResult) {
  const labels: Record<string, string> = {
    style_variant: "款式方案",
    try_on_image: "上身效果图",
    motion_storyboard: "动作分镜",
    postprocess_batch: "批量后期图",
    market_test_variant: "测款版本",
    brand_profile: "品牌配置",
  };
  return labels[result.versionType] || result.versionType.replace(/_/g, " ");
}

function workflowActionText(actions: unknown) {
  if (!Array.isArray(actions)) return "";
  const labels = new Map(postprocessActionOptions.map((item) => [item.id, item.label]));
  return actions.map((action) => labels.get(String(action)) || String(action)).join(" / ");
}

function ResultCard({ result }: { result: WorkflowResult }) {
  const qualityGate = result.metadata.qualityGate as
    | { status?: string; score?: number; assetInputCount?: number; issues?: string[]; nextActions?: string[] }
    | undefined;
  const failureEvidence = result.metadata.failureEvidence as { reason?: string; nextActions?: string[] } | undefined;
  const evidence = workflowResultEvidence(result);
  const fabricInputSummary = workflowFabricInputText(result);
  const fabricAnalysis = workflowFabricAnalysisText(result);
  const styleMatchSummary = workflowStyleMatchText(result);
  const styleRecommendation = workflowStyleRecommendationText(result);
  const editControlSummary = workflowEditControlText(result);
  const virtualModelSummary = workflowVirtualModelText(result);
  const tryOnSourceSummary = workflowTryOnSourceText(result);
  const postprocessBatchSummary = workflowPostprocessBatchText(result);
  const postprocessTuningSummary = workflowPostprocessTuningText(result);
  const cutoutQualitySummary = workflowCutoutQualityText(result);
  const failed = result.metadata.deliveryStatus === "failed";
  const isPlayableVideo = result.mediaType === "video" && (result.metadata.motionPreviewGenerated || result.imageUrl.endsWith(".mp4"));
  const mediaLabel =
    failed
      ? "失败"
      : isPlayableVideo
      ? "MP4"
      : result.mediaType === "video" && result.metadata.requiresVideoModelForMp4
      ? "分镜"
      : result.mediaType === "video"
        ? "短视频"
        : result.mediaType === "profile"
          ? "配置"
          : "图片";

  return (
    <article className={failed ? "workflow-result-card failed" : "workflow-result-card"}>
      <div className="workflow-result-media">
        {isPlayableVideo ? <video src={result.imageUrl} controls muted playsInline preload="metadata" /> : <img src={result.imageUrl} alt={result.title} />}
        <span>{mediaLabel}</span>
        <span className="evidence-badge">{evidence.label}</span>
      </div>
      <div className="workflow-result-body">
        <strong>{result.title}</strong>
        <span>{resultVersionLabel(result)}</span>
        <div className="generation-evidence">
          <span>{evidence.label}</span>
          <small>{evidence.detail}</small>
        </div>
        {result.metadata.colors ? <small>{textList(result.metadata.colors)}</small> : null}
        {fabricInputSummary ? <small>{fabricInputSummary}</small> : null}
        {fabricAnalysis ? <small>{fabricAnalysis}</small> : null}
        {styleMatchSummary ? <small>{styleMatchSummary}</small> : null}
        {styleRecommendation ? <small>{styleRecommendation}</small> : null}
        {editControlSummary ? <small>{editControlSummary}</small> : null}
        {virtualModelSummary ? <small>{virtualModelSummary}</small> : null}
        {tryOnSourceSummary ? <small>{tryOnSourceSummary}</small> : null}
        {postprocessBatchSummary ? <small>{postprocessBatchSummary}</small> : null}
        {postprocessTuningSummary ? <small>{postprocessTuningSummary}</small> : null}
        {cutoutQualitySummary ? <small>{cutoutQualitySummary}</small> : null}
        {workflowActionText(result.metadata.actions) ? <small>{workflowActionText(result.metadata.actions)}</small> : null}
        {result.mediaType === "profile" && result.metadata.palette ? <small>{textList(result.metadata.palette)}</small> : null}
        {result.mediaType === "profile" && result.metadata.texture ? <small>{textList(result.metadata.texture)}</small> : null}
        {qualityGate ? (
          <small>
            {qualityGate.status === "passed" ? "素材约束通过" : qualityGate.status === "rework" ? "需返工" : "需人工复核"} · {qualityGate.score ?? 0} · 输入{" "}
            {qualityGate.assetInputCount ?? 0}
          </small>
        ) : null}
        {qualityGate?.issues?.[0] ? <small className="quality-issue">{qualityGate.issues[0]}</small> : null}
        {qualityGate?.nextActions?.[0] ? <small className="quality-action">{qualityGate.nextActions[0]}</small> : null}
        {failureEvidence?.reason ? <small className="quality-issue">{failureEvidence.reason}</small> : null}
        {failureEvidence?.nextActions?.[0] ? <small className="quality-action">{failureEvidence.nextActions[0]}</small> : null}
      </div>
    </article>
  );
}

function WorkflowFailureNotice({ job }: { job?: WorkflowJob }) {
  const notice = workflowJobFailureNotice(job);
  if (!notice) return null;
  return (
    <div className="workflow-failure-notice" role="alert">
      <CircleAlert size={18} />
      <div>
        <strong>工作流未通过生产验收</strong>
        <span>{notice.reason}</span>
        {notice.nextActions.slice(0, 2).map((action) => (
          <small key={action}>{action}</small>
        ))}
      </div>
    </div>
  );
}

function WorkflowSteps({ job }: { job?: WorkflowJob }) {
  if (!job) {
    return (
      <div className="workflow-empty">
        <Layers3 size={22} />
        <span>运行工作流后会显示解析、生成、后期或测款步骤。</span>
      </div>
    );
  }
  return (
    <div className="workflow-steps">
      {job.steps.map((step) => (
        <article className={`step-${step.status}`} key={step.id}>
          {step.status === "failed" ? <CircleAlert size={16} /> : <BadgeCheck size={16} />}
          <div>
            <strong>{step.title}</strong>
            <span>{step.message}</span>
          </div>
        </article>
      ))}
    </div>
  );
}

function ResultsGrid({ job }: { job?: WorkflowJob }) {
  if (!job) {
    return (
      <div className="workflow-empty workflow-empty-output">
        <Sparkles size={22} />
        <strong>生成结果会显示在这里</strong>
        <span>默认素材可以直接试跑；上传自己的图片后会优先使用你的素材。</span>
      </div>
    );
  }
  return (
    <div className="workflow-results-grid">
      {job.results.map((result) => (
        <ResultCard result={result} key={result.id} />
      ))}
    </div>
  );
}

function CapabilityStatusList({ dashboard, active }: { dashboard: WorkflowDashboard | null; active: WorkflowType }) {
  const definition = dashboard?.definitions.find((item) => item.id === active);
  if (!definition?.capabilityStatus?.length) return null;
  const labels = {
    live: "真实接入",
    preview: "预览",
    requires_service: "需外部服务",
  };
  return (
    <div className="capability-status-list">
      {definition.capabilityStatus.map((capability) => {
        const label = capability.status === "requires_service" && capability.blocking === false ? "可选增强" : labels[capability.status];
        return (
          <span className={`capability-status ${capability.status}${capability.blocking === false ? " optional" : ""}`} key={capability.id} title={capability.note}>
            {capability.label} · {label}
          </span>
        );
      })}
    </div>
  );
}

function ProductionReadinessPanel({ dashboard }: { dashboard: WorkflowDashboard | null }) {
  const readiness = dashboard?.summary.productionReadiness;
  const counts = readiness?.capabilityCounts ?? { live: 0, preview: 0, requiresService: 0 };
  const provider = readiness?.provider;
  const providerHealth = provider?.health;
  const runtime = readiness?.runtime;
  const blockers = readiness?.blockers ?? [];
  const providerBlocking = Boolean(providerHealth?.blocking);
  return (
    <section className="readiness-panel" aria-label="生产验收摘要">
      <div className="readiness-head">
        <div>
          <h2>生产验收</h2>
          <p>
            {runtime?.label ?? "当前会话待确认"}
            {provider?.mode === "live" ? ` · ${provider.model}` : " · 不会调用真实图像接口"}
          </p>
          {providerHealth?.message ? <small>{providerHealth.message}</small> : null}
        </div>
        <span className={providerBlocking ? "readiness-badge warn" : provider?.mode === "live" ? "readiness-badge live" : "readiness-badge demo"}>
          {providerHealth?.label ?? (provider?.mode === "live" ? "真实出图" : "演示")}
        </span>
      </div>
      <div className="readiness-metrics">
        <Metric label="已接入" value={`${counts.live}`} tone="good" />
        <Metric label="预览能力" value={`${counts.preview}`} />
        <Metric label="阻断项" value={`${counts.requiresService + (providerBlocking ? 1 : 0)}`} tone={counts.requiresService > 0 || providerBlocking ? "warn" : "good"} />
      </div>
      {providerBlocking ? (
        <div className="readiness-blockers">
          <article>
            <div>
              <strong>基础图像接口 · {providerHealth?.label}</strong>
              <em>需处理</em>
            </div>
            <span>{providerHealth?.message}</span>
            {providerHealth?.resetAt ? <small>额度重置：{new Date(providerHealth.resetAt).toLocaleString()}</small> : null}
          </article>
        </div>
      ) : null}
      {blockers.length > 0 ? (
        <div className="readiness-blockers">
          {blockers.slice(0, 3).map((blocker) => (
            <article className={blocker.configured ? "configured" : ""} key={`${blocker.workflowId}-${blocker.capabilityId}`} title={blocker.note}>
              <div>
                <strong>{blocker.workflowTitle} · {blocker.label}</strong>
                <em>{blocker.configured ? "已配置" : "未配置"}</em>
              </div>
              <span>{blocker.service}</span>
              <code>{blocker.requiredEnv.join(" + ") || "待定义服务配置"}</code>
              <small>{blocker.nextAction}</small>
            </article>
          ))}
        </div>
      ) : null}
    </section>
  );
}

interface WorkflowCenterProps {
  generatedResults?: GeneratedResult[];
}

export function WorkflowCenter({ generatedResults = [] }: WorkflowCenterProps) {
  const [active, setActive] = useState<CoreWorkflowType>("fabric-to-style");
  const [helpOpen, setHelpOpen] = useState(false);
  const [dashboard, setDashboard] = useState<WorkflowDashboard | null>(null);
  const [activeJob, setActiveJob] = useState<WorkflowJob | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [fabricControls, setFabricControls] = useState<FabricControls>(defaultFabricControls);
  const [fabricInputs, setFabricInputs] = useState<FabricInputs>(defaultFabricInputs);
  const [virtualModelControls, setVirtualModelControls] = useState<VirtualModelControls>(defaultVirtualModelControls);
  const [virtualModelInputs, setVirtualModelInputs] = useState<VirtualModelInputs>(defaultVirtualModelInputs);
  const [virtualModelFilter, setVirtualModelFilter] = useState<ModelCollectionFilter>("all");
  const [postprocessControls, setPostprocessControls] = useState<PostprocessControls>(defaultPostprocessControls);
  const [postprocessInputs, setPostprocessInputs] = useState<PostprocessInputs>(defaultPostprocessInputs);
  const workflowPendingRef = useRef(false);
  const lastWorkflowRunRef = useRef<{ type: WorkflowType; startedAt: number } | null>(null);

  useEffect(() => {
    fetchWorkflowDashboard()
      .then((data) => {
        setDashboard(data);
        setActiveJob(latestByType(data.jobs, active) ?? data.jobs[0] ?? null);
      })
      .catch((err) => setError(err instanceof Error ? err.message : "工作流数据加载失败"));
  }, []);

  useEffect(() => {
    if (!dashboard?.jobs.some((job) => job.status === "running")) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      fetchWorkflowDashboard()
        .then((data) => {
          if (cancelled) return;
          setDashboard(data);
          setActiveJob((current) => {
            if (current) {
              const updated = data.jobs.find((job) => job.id === current.id);
              if (updated) return updated;
            }
            return latestByType(data.jobs, active) ?? data.jobs[0] ?? null;
          });
        })
        .catch((err) => {
          if (!cancelled) setError(err instanceof Error ? err.message : "工作流状态刷新失败");
        });
    }, 3500);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [active, dashboard?.jobs]);

  const currentJob = useMemo(() => {
    if (activeJob?.type === active) return activeJob;
    return latestByType(dashboard?.jobs ?? [], active) ?? undefined;
  }, [active, activeJob, dashboard?.jobs]);
  const reusablePostprocessAssets = useMemo(() => {
    const generatedAssets = generatedResultsToWorkflowAssets(generatedResults, { max: 2, notePrefix: "真实生成结果" });
    return generatedAssets.length > 0 ? generatedAssets : workflowResultsToWorkflowAssets(dashboard?.jobs ?? [], { max: 2, notePrefix: "功能中心前序结果" });
  }, [dashboard?.jobs, generatedResults]);
  const dashboardModelOptions = useMemo(() => commercialModelsToModelOptions(dashboard?.commercialModels ?? []), [dashboard?.commercialModels]);
  const activeModelOptions = dashboardModelOptions.length > 0 ? dashboardModelOptions : modelControlOptions;
  const updateFabricControls = (patch: Partial<FabricControls>) => setFabricControls((current) => ({ ...current, ...patch }));
  const updateFabricInputs = (patch: Partial<FabricInputs>) => setFabricInputs((current) => ({ ...current, ...patch }));
  const updateVirtualModelControls = (patch: Partial<VirtualModelControls>) => setVirtualModelControls((current) => ({ ...current, ...patch }));
  const selectVirtualModel = (modelId: string) =>
    setVirtualModelControls((current) => {
      const availablePoses = compatiblePoseOptions(modelId, activeModelOptions);
      const poseId = availablePoses.some((pose) => pose.id === current.poseId) ? current.poseId : availablePoses[0]?.id ?? current.poseId;
      return { ...current, modelId, poseId };
    });
  const selectVirtualModelFilter = (filterId: ModelCollectionFilter) => {
    const options = filteredModelOptions(filterId, activeModelOptions);
    setVirtualModelFilter(filterId);
    setVirtualModelControls((current) => {
      if (options.some((model) => model.id === current.modelId)) return current;
      const nextModel = options[0] ?? activeModelOptions[0] ?? modelControlOptions[0];
      const availablePoses = compatiblePoseOptions(nextModel.id, activeModelOptions);
      return { ...current, modelId: nextModel.id, poseId: availablePoses[0]?.id ?? current.poseId };
    });
  };
  const updateVirtualModelInputs = (patch: Partial<VirtualModelInputs>) => setVirtualModelInputs((current) => ({ ...current, ...patch }));
  const updatePostprocessControls = (patch: Partial<PostprocessControls>) => setPostprocessControls((current) => ({ ...current, ...patch }));
  const togglePostprocessAction = (actionId: string) =>
    setPostprocessControls((current) => {
      const actions = current.actions.includes(actionId) ? current.actions.filter((item) => item !== actionId) : [...current.actions, actionId];
      return { ...current, actions: actions.length > 0 ? actions : ["cutout"] };
    });
  const togglePostprocessScene = (sceneId: string) =>
    setPostprocessControls((current) => {
      const targetScenes = current.targetScenes.includes(sceneId) ? current.targetScenes.filter((item) => item !== sceneId) : [...current.targetScenes, sceneId];
      return { ...current, targetScenes: targetScenes.length > 0 ? targetScenes : ["studio"] };
    });

  const handleFabricAssetUpload = async (files: FileList | null, kind: "fabric" | "sketch") => {
    const selectedFiles = Array.from(files ?? []);
    if (selectedFiles.length === 0) return;
    try {
      const uploadedAssets = await Promise.all(selectedFiles.map((file) => fileToWorkflowAsset(file, kind, kind === "fabric" ? "用户上传面料" : "用户上传草图")));
      setFabricInputs((current) => ({
        ...current,
        assets: [...current.assets.filter((asset) => asset.kind !== kind), ...uploadedAssets],
      }));
    } catch (err) {
      setError(err instanceof Error ? err.message : "图片读取失败");
    }
  };

  const handleVirtualAssetUpload = async (files: FileList | null) => {
    const selectedFile = Array.from(files ?? [])[0];
    if (!selectedFile) return;
    try {
      const asset = await fileToWorkflowAsset(selectedFile, virtualModelInputs.sourceType, "用户上传虚拟模特来源图");
      updateVirtualModelInputs({ assets: [asset] });
    } catch (err) {
      setError(err instanceof Error ? err.message : "图片读取失败");
    }
  };

  const handlePostprocessAssetUpload = async (files: FileList | null) => {
    const selectedFiles = Array.from(files ?? []);
    if (selectedFiles.length === 0) return;
    try {
      const assets = await Promise.all(selectedFiles.map((file, index) => fileToWorkflowAsset(file, "result", `用户上传后期图 ${index + 1}`)));
      setPostprocessInputs({ assets });
    } catch (err) {
      setError(err instanceof Error ? err.message : "图片读取失败");
    }
  };

  const runWorkflow = async (type: CoreWorkflowType) => {
    const now = Date.now();
    const lastRun = lastWorkflowRunRef.current;
    if (workflowPendingRef.current || (lastRun?.type === type && now - lastRun.startedAt < 800)) return;
    workflowPendingRef.current = true;
    lastWorkflowRunRef.current = { type, startedAt: now };
    setLoading(true);
    setError("");
    try {
      const payload = buildWorkflowPayload(type);
      const response = await createWorkflowJob(payload);
      setDashboard(response.dashboard);
      setActiveJob(response.job);
      setActive(type);
      if (response.error || response.job.status === "failed") {
        setError(response.error || response.job.message);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "工作流创建失败");
    } finally {
      workflowPendingRef.current = false;
      setLoading(false);
    }
  };

  const buildWorkflowPayload = (type: WorkflowType) =>
    buildControlledWorkflowPayload(type, {
      createDemoAsset: demoAsset,
	      reusablePostprocessAssets,
	      fabricControls,
	      fabricInputs,
	      virtualModelControls,
	      virtualModelInputs,
	      modelOptions: activeModelOptions,
	      postprocessControls,
	      postprocessInputs,
	    });

  const activeModelSummary = dashboard?.commercialModels ?? [];
  const childModel = activeModelSummary.find((model) => model.ageGroup === "child");
  const plusModel = activeModelSummary.find((model) => model.bodyType === "plus");
  const diversityModel = activeModelSummary.find((model) => model.ethnicity === "black" || model.ethnicity === "south-asian");
  const seniorModel = activeModelSummary.find((model) => model.ageGroup === "senior");
  const selectedVirtualSource = virtualSourceOptions.find((option) => option.kind === virtualModelInputs.sourceType) ?? virtualSourceOptions[0];
  const visibleModelOptions = filteredModelOptions(virtualModelFilter, activeModelOptions);
  const selectedVirtualPoseOptions = compatiblePoseOptions(virtualModelControls.modelId, activeModelOptions);
  const selectedVirtualPoseLabels = selectedVirtualPoseOptions.map((option) => option.label).join(" / ");
  const postprocessInputCount = postprocessInputs.assets.length || reusablePostprocessAssets.length || 2;
  const postprocessBatchPreview = postprocessBatchPreviewText(postprocessControls, postprocessInputCount);
  const activeTab = workflowTabs.find((tab) => tab.id === active) ?? workflowTabs[0];
  const ActiveIcon = activeTab.icon;

  return (
    <main className="workflow-center panel-scroll">
      <header className="workflow-topbar">
        <div>
          <h1>AI功能中心</h1>
          <p>选择模块，上传素材，设置效果，然后生成可评审图片。默认素材可直接试跑。</p>
        </div>
        <div className="workflow-current-task">
          <ActiveIcon size={17} />
          <strong>{activeTab.label}</strong>
          <span>{activeTab.short} {"->"} {activeTab.outcome}</span>
        </div>
        <button className="workflow-help-trigger" aria-expanded={helpOpen} aria-label="查看功能说明" onClick={() => setHelpOpen((open) => !open)} type="button">
          <HelpCircle size={17} />
          <span>功能说明</span>
        </button>
      </header>

      {helpOpen ? <ModuleHelpPopover active={active} onClose={() => setHelpOpen(false)} /> : null}

      <div className="workflow-module-layout">
        <nav className="workflow-tabs" role="tablist" aria-label="AI功能模块">
          {workflowTabs.map((tab) => {
            const Icon = tab.icon;
            return (
              <button
                key={tab.id}
                role="tab"
                aria-selected={active === tab.id}
                aria-controls={`workflow-panel-${tab.id}`}
                className={active === tab.id ? "active" : ""}
                onClick={() => {
                  setActive(tab.id);
                  setActiveJob(latestByType(dashboard?.jobs ?? [], tab.id) ?? null);
                  setHelpOpen(false);
                }}
                type="button"
              >
                <span className="module-index">{tab.module}</span>
                <Icon size={17} />
                <span>
                  <strong>{tab.label}</strong>
                  <small>{tab.short}</small>
                </span>
                <em>{tab.outcome}</em>
              </button>
            );
          })}
        </nav>

        <section id={`workflow-panel-${active}`} className="workflow-stage" role="tabpanel" aria-label={`${activeTab.label}工作区`}>

      {error ? <div className="inline-warning">{error}</div> : null}
      <WorkflowFailureNotice job={currentJob} />

      {active === "fabric-to-style" ? (
        <section className="workflow-grid workflow-workbench">
          <Section title="面料到款式" action={<SwatchBook size={17} />} className="workflow-builder-card">
            <div className="workflow-copy">
              <WorkflowGuide type="fabric-to-style" />
	              <div className="workflow-control-grid">
	                <label className="wide-control">
	                  <span>款式描述</span>
	                  <textarea
	                    aria-label="款式描述"
                      placeholder="例如：春夏通勤连衣裙，保留面料纹理，版型干净，适合电商主图"
	                    value={fabricInputs.textDescription}
	                    onChange={(event) => updateFabricInputs({ textDescription: event.target.value })}
	                  />
                    <WorkflowFieldNote>不写也能生成；写得越具体，款式越贴近你的商品方向。</WorkflowFieldNote>
	                </label>
	                <label>
	                  <span>服装品类</span>
	                  <input
	                    aria-label="服装品类"
	                    type="text"
	                    value={fabricInputs.garmentCategory}
	                    onChange={(event) => updateFabricInputs({ garmentCategory: event.target.value })}
	                  />
                    <WorkflowFieldNote>默认 dress，可改成 coat、shirt、skirt 等。</WorkflowFieldNote>
	                </label>
	                <label className="workflow-upload-tile">
	                  <span>面料图片</span>
	                  <input aria-label="面料图片" type="file" accept="image/*" onChange={(event) => handleFabricAssetUpload(event.currentTarget.files, "fabric")} />
                    <WorkflowFieldNote>上传布料、花型、纹理照片。</WorkflowFieldNote>
	                </label>
	                <label className="workflow-upload-tile">
	                  <span>设计草图</span>
	                  <input aria-label="设计草图" type="file" accept="image/*" onChange={(event) => handleFabricAssetUpload(event.currentTarget.files, "sketch")} />
                    <WorkflowFieldNote>可选；没有草图会按默认版型生成。</WorkflowFieldNote>
	                </label>
	                <FabricPreviewEditor controls={fabricControls} onChange={updateFabricControls} />
	                <label>
	                  <span>面料图案</span>
	                  <select aria-label="面料图案" value={fabricControls.pattern} onChange={(event) => updateFabricControls({ pattern: event.target.value })}>
                    {fabricPatternOptions.map((option) => (
                      <option key={option.id} value={option.id}>{option.label}</option>
                    ))}
                  </select>
                </label>
                <label>
                  <span>领口</span>
                  <select aria-label="领口" value={fabricControls.neckline} onChange={(event) => updateFabricControls({ neckline: event.target.value })}>
                    {necklineOptions.map((option) => (
                      <option key={option.id} value={option.id}>{option.label}</option>
                    ))}
                  </select>
                </label>
                <label>
                  <span>衣长 · {hemLengthOptions[optionIndex(hemLengthOptions, fabricControls.hemLength)]?.label}</span>
                  <input
                    aria-label="衣长"
                    type="range"
                    min="0"
                    max={hemLengthOptions.length - 1}
                    value={optionIndex(hemLengthOptions, fabricControls.hemLength)}
                    onChange={(event) => updateFabricControls({ hemLength: hemLengthOptions[Number(event.target.value)]?.id ?? fabricControls.hemLength })}
                  />
                </label>
                <label>
                  <span>袖长 · {sleeveLengthOptions[optionIndex(sleeveLengthOptions, fabricControls.sleeveLength)]?.label}</span>
                  <input
                    aria-label="袖长"
                    type="range"
                    min="0"
                    max={sleeveLengthOptions.length - 1}
                    value={optionIndex(sleeveLengthOptions, fabricControls.sleeveLength)}
                    onChange={(event) => updateFabricControls({ sleeveLength: sleeveLengthOptions[Number(event.target.value)]?.id ?? fabricControls.sleeveLength })}
                  />
                </label>
	                <label>
	                  <span>变体数量</span>
	                  <input
                    aria-label="款式变体数量"
                    type="number"
                    min="1"
                    max="8"
                    value={fabricControls.variants}
                    onChange={(event) => updateFabricControls({ variants: Number(event.target.value) })}
	                  />
                    <WorkflowFieldNote>首次建议 2 张；需要测款时再加到 4-8 张。</WorkflowFieldNote>
	                </label>
	              </div>
	              <small className="workflow-asset-list">{assetNameList(fabricInputs.assets, "默认面料和草图素材")}</small>
	            </div>
            <Button variant="primary" icon={loading ? <Loader2 size={15} /> : <Sparkles size={15} />} onClick={() => runWorkflow("fabric-to-style")} disabled={loading}>
              生成面料款式方案
            </Button>
          </Section>
          <Section title="执行步骤" className="workflow-side-panel">
            <WorkflowSteps job={currentJob} />
          </Section>
          <Section title="生成结果" className="workflow-output-panel">
            <ResultsGrid job={currentJob} />
          </Section>
        </section>
      ) : null}

      {active === "virtual-model-showcase" ? (
        <section className="workflow-grid workflow-workbench">
          <Section title="虚拟模特展示" action={<Shirt size={17} />} className="workflow-builder-card">
            <div className="workflow-copy">
              <WorkflowGuide type="virtual-model-showcase" />
            </div>
            <div className="model-library">
              <article>
                <strong>儿童模特</strong>
                <span>{childModel?.name ?? "可商用儿童模特"} · 行走/站立</span>
              </article>
              <article>
                <strong>大码模特</strong>
                <span>{plusModel?.name ?? "可商用大码模特"} · 多体型覆盖</span>
              </article>
              <article>
                <strong>多元人种</strong>
                <span>{diversityModel?.name ?? "多元可商用模特"} · 人种覆盖</span>
              </article>
              <article>
                <strong>熟龄模特</strong>
                <span>{seniorModel?.name ?? "可商用熟龄模特"} · 年龄覆盖</span>
              </article>
	              <article>
	                <strong>场景动作</strong>
	                <span>城市、森林、草地、棚拍、站立/行走/转身</span>
	              </article>
	              <div className="workflow-control-grid">
	                <label>
	                  <span>来源类型</span>
	                  <select
	                    aria-label="来源类型"
	                    value={virtualModelInputs.sourceType}
	                    onChange={(event) => setVirtualModelInputs((current) => ({ ...current, sourceType: event.target.value as VirtualModelInputs["sourceType"], assets: [] }))}
	                  >
	                    {virtualSourceOptions.map((option) => (
	                      <option key={option.id} value={option.kind}>{option.label}</option>
	                    ))}
	                  </select>
                    <WorkflowFieldNote>选你手里已有的素材类型。</WorkflowFieldNote>
	                </label>
	                <label className="workflow-upload-tile">
	                  <span>{selectedVirtualSource.label}</span>
	                  <input aria-label="虚拟模特来源图" type="file" accept="image/*" onChange={(event) => handleVirtualAssetUpload(event.currentTarget.files)} />
                    <WorkflowFieldNote>没有上传时会使用默认服装素材试跑。</WorkflowFieldNote>
	                </label>
	                <label className="wide-control">
	                  <span>服装说明</span>
	                  <textarea
	                    aria-label="服装说明"
                      placeholder="例如：保持泡泡袖、腰部排扣和米白色雪纺质感"
	                    value={virtualModelInputs.description}
	                    onChange={(event) => updateVirtualModelInputs({ description: event.target.value })}
	                  />
                    <WorkflowFieldNote>用于强调必须保留的款式细节。</WorkflowFieldNote>
	                </label>
	                <label>
	                  <span>模特分类</span>
	                  <select aria-label="模特分类" value={virtualModelFilter} onChange={(event) => selectVirtualModelFilter(event.target.value as ModelCollectionFilter)}>
	                    {modelCollectionFilterOptions.map((option) => (
	                      <option key={option.id} value={option.id}>{option.label}</option>
	                    ))}
	                  </select>
	                </label>
	                <label>
	                  <span>虚拟模特</span>
	                  <select aria-label="虚拟模特" value={virtualModelControls.modelId} onChange={(event) => selectVirtualModel(event.target.value)}>
                    {visibleModelOptions.map((option) => (
                      <option key={option.id} value={option.id}>{option.label}</option>
                    ))}
                  </select>
                </label>
                <div className="virtual-model-profile" aria-label="虚拟模特资料">
                  <strong>{modelProfileText(virtualModelControls.modelId, activeModelOptions)}</strong>
                  <span>{visibleModelOptions.length} 个可商用画像 · 可用姿势 {selectedVirtualPoseLabels}</span>
                </div>
                <label>
                  <span>展示场景</span>
                  <select aria-label="展示场景" value={virtualModelControls.sceneId} onChange={(event) => updateVirtualModelControls({ sceneId: event.target.value })}>
                    {sceneControlOptions.map((option) => (
                      <option key={option.id} value={option.id}>{option.label}</option>
                    ))}
                  </select>
                </label>
                <label>
                  <span>模特姿势</span>
                  <select aria-label="模特姿势" value={virtualModelControls.poseId} onChange={(event) => updateVirtualModelControls({ poseId: event.target.value })}>
                    {selectedVirtualPoseOptions.map((option) => (
                      <option key={option.id} value={option.id}>{option.label}</option>
                    ))}
	                  </select>
	                </label>
	              </div>
	              <small className="workflow-asset-list">{assetNameList(virtualModelInputs.assets, virtualSourceFallbackLabel(virtualModelInputs.sourceType))}</small>
	            </div>
            <Button variant="primary" icon={loading ? <Loader2 size={15} /> : <Clapperboard size={15} />} onClick={() => runWorkflow("virtual-model-showcase")} disabled={loading}>
              生成上身展示
            </Button>
          </Section>
          <Section title="执行步骤" className="workflow-side-panel">
            <WorkflowSteps job={currentJob} />
          </Section>
          <Section title="生成结果" className="workflow-output-panel">
            <ResultsGrid job={currentJob} />
          </Section>
        </section>
      ) : null}

      {active === "postprocess-suite" ? (
        <section className="workflow-grid workflow-workbench">
          <Section title="图像后期优化" action={<Scissors size={17} />} className="workflow-builder-card">
            <div className="workflow-copy">
              <WorkflowGuide type="postprocess-suite" />
            </div>
            <div className="postprocess-list">
              {postprocessActionOptions.map((action) => (
                <label key={action.id}>
                  <input
                    type="checkbox"
                    checked={postprocessControls.actions.includes(action.id)}
                    onChange={() => togglePostprocessAction(action.id)}
                  />
                  <span>{action.label}</span>
                </label>
              ))}
            </div>
	            <div className="workflow-control-grid">
	              <label className="wide-control workflow-upload-tile">
	                <span>批量图片</span>
	                <input aria-label="批量图片" type="file" accept="image/*" multiple onChange={(event) => handlePostprocessAssetUpload(event.currentTarget.files)} />
                  <WorkflowFieldNote>可以一次选多张；不上传时会优先复用最近生成结果。</WorkflowFieldNote>
	              </label>
	              <div className="postprocess-batch-preview" aria-label="批量输出预估">
	                <strong>批量输出</strong>
	                <span>{postprocessBatchPreview}</span>
	              </div>
	              <label>
	                <span>目标颜色</span>
	                <select aria-label="目标颜色" value={postprocessControls.targetColor} onChange={(event) => updatePostprocessControls({ targetColor: event.target.value })}>
                  {targetColorOptions.map((option) => (
                    <option key={option.id} value={option.id}>{option.label}</option>
                  ))}
                </select>
              </label>
              <label>
                <span>输出比例</span>
                <select aria-label="输出比例" value={postprocessControls.targetRatio} onChange={(event) => updatePostprocessControls({ targetRatio: event.target.value })}>
                  {targetRatioOptions.map((option) => (
                    <option key={option.id} value={option.id}>{option.label}</option>
                  ))}
	                </select>
	              </label>
	              <label className="wide-control">
	                <span>擦除目标</span>
	                <input
	                  aria-label="擦除目标"
	                  type="text"
                    placeholder="例如：背景杂物、地面污点、模特手边道具"
	                  value={postprocessControls.eraseTarget}
	                  onChange={(event) => updatePostprocessControls({ eraseTarget: event.target.value })}
	                />
                  <WorkflowFieldNote>只有勾选对象擦除时会重点使用。</WorkflowFieldNote>
	              </label>
	              <label>
	                <span>补光强度 · {postprocessControls.lightStrength}%</span>
	                <input
	                  aria-label="补光强度"
	                  type="range"
	                  min="0"
	                  max="100"
	                  value={postprocessControls.lightStrength}
	                  onChange={(event) => updatePostprocessControls({ lightStrength: clampControlPercent(Number(event.target.value)) })}
	                />
	                <input
	                  aria-label="补光强度数值"
	                  type="number"
	                  min="0"
	                  max="100"
	                  value={postprocessControls.lightStrength}
	                  onChange={(event) => updatePostprocessControls({ lightStrength: clampControlPercent(Number(event.target.value)) })}
	                />
	              </label>
	              <label>
	                <span>美体强度 · {postprocessControls.beautyLevel}%</span>
	                <input
	                  aria-label="美体强度"
	                  type="range"
	                  min="0"
	                  max="100"
	                  value={postprocessControls.beautyLevel}
	                  onChange={(event) => updatePostprocessControls({ beautyLevel: clampControlPercent(Number(event.target.value)) })}
	                />
	                <input
	                  aria-label="美体强度数值"
	                  type="number"
	                  min="0"
	                  max="100"
	                  value={postprocessControls.beautyLevel}
	                  onChange={(event) => updatePostprocessControls({ beautyLevel: clampControlPercent(Number(event.target.value)) })}
	                />
	              </label>
	              <label>
	                <span>修复重点</span>
	                <select aria-label="修复重点" value={postprocessControls.repairFocus} onChange={(event) => updatePostprocessControls({ repairFocus: event.target.value })}>
	                  {postprocessRepairFocusOptions.map((option) => (
	                    <option key={option.id} value={option.id}>{option.label}</option>
	                  ))}
	                </select>
	              </label>
	            </div>
	            <div className="postprocess-list scene-list">
	              {postprocessSceneOptions.map((scene) => (
	                <label key={scene.id}>
	                  <input
	                    type="checkbox"
	                    checked={postprocessControls.targetScenes.includes(scene.id)}
	                    onChange={() => togglePostprocessScene(scene.id)}
	                  />
	                  <span>{scene.label}</span>
	                </label>
	              ))}
	            </div>
	            <small className="workflow-asset-list">{assetNameList(postprocessInputs.assets, reusablePostprocessAssets.length > 0 ? "使用前序真实生成图" : "默认批量演示素材")}</small>
	            <Button variant="primary" icon={loading ? <Loader2 size={15} /> : <Brush size={15} />} onClick={() => runWorkflow("postprocess-suite")} disabled={loading}>
              开始批量后期
            </Button>
          </Section>
          <Section title="执行步骤" className="workflow-side-panel">
            <WorkflowSteps job={currentJob} />
          </Section>
          <Section title="生成结果" className="workflow-output-panel">
            <ResultsGrid job={currentJob} />
          </Section>
        </section>
      ) : null}

        </section>
      </div>
    </main>
  );
}
