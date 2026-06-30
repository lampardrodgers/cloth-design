import { useEffect, useMemo, useRef, useState, type PointerEvent, type ReactNode } from "react";
import {
  BadgeCheck,
  Bookmark,
  CircleAlert,
  Clapperboard,
  Cloud,
  Download,
  HelpCircle,
  ImageUp,
  Layers3,
  Loader2,
  PlayCircle,
  RefreshCcw,
  Scissors,
  SlidersHorizontal,
  Shirt,
  Sparkles,
  SwatchBook,
  Trash2,
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
		fabricColorOptions,
		fissionDimensionOptions,
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
import { Button, ChipGroup, ChipToggleGroup, ComboBox, FieldCard, NumberStepper } from "./ui";

type CoreWorkflowType = Extract<WorkflowType, "fabric-to-style" | "virtual-model-showcase" | "postprocess-suite">;

const workflowTabs: Array<{ id: CoreWorkflowType; module: string; label: string; short: string; outcome: string; icon: typeof Sparkles }> = [
  { id: "fabric-to-style", module: "①", label: "面料到款式", short: "面料图 + 描述 + 草图", outcome: "款式方案与裂变", icon: SwatchBook },
  { id: "virtual-model-showcase", module: "②", label: "虚拟模特展示", short: "平铺图 / 人台图 / 设计图", outcome: "逼真上身效果", icon: Shirt },
  { id: "postprocess-suite", module: "③", label: "图像后期优化", short: "服装图 / 模特图 / 批量图", outcome: "抠图、美化、修复", icon: Scissors },
];

const moduleRequirements: Record<
  CoreWorkflowType,
  {
    module: string;
    title: string;
    promise: string;
    inputTitle: string;
    outputTitle: string;
    requirements: Array<{ title: string; detail: string }>;
    steps: Array<{ icon: typeof Sparkles; title: string; detail: string }>;
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
    steps: [
      { icon: ImageUp, title: "放入面料", detail: "面料图、草图和一句需求都可以用。" },
      { icon: SlidersHorizontal, title: "调款式", detail: "改图案、衣长、袖长和领口。" },
      { icon: PlayCircle, title: "生成变体", detail: "一次拿到多个可比较方案。" },
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
    steps: [
      { icon: ImageUp, title: "放入服装图", detail: "平铺图、人台图或设计图都可试穿。" },
      { icon: SlidersHorizontal, title: "选模特场景", detail: "儿童、大码、熟龄、不同人种都可选。" },
      { icon: PlayCircle, title: "生成上身图", detail: "直接看静态商业展示效果。" },
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
    steps: [
      { icon: ImageUp, title: "放入商品图", detail: "支持多张图一起处理。" },
      { icon: SlidersHorizontal, title: "选择后期动作", detail: "抠图、补光、修复、擦除、重色。" },
      { icon: PlayCircle, title: "批量交付", detail: "生成可下载的处理结果。" },
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

/* ── 面料可视调整编辑器（袖长/衣长/领口拖柄），默认折叠 ── */
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
    <div className="fabric-preview-editor">
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

/* ── 上传缩略图 tile：上传后显示预览而非文件名 ── */
function UploadTile({
  label,
  accept = "image/*",
  multiple = false,
  hint,
  assets,
  onUpload,
  onClear,
}: {
  label: string;
  accept?: string;
  multiple?: boolean;
  hint: string;
  assets: WorkflowAsset[];
  onUpload: (files: FileList | null) => void;
  onClear: () => void;
}) {
  const preview = assets[0];
  const multiPreview = multiple && assets.length > 1;
  return (
    <div className="upload-tile">
      {preview ? (
        <div className={multiPreview ? "upload-tile-preview multi" : "upload-tile-preview"}>
          {multiPreview ? (
            <div className="upload-tile-preview-grid">
              {assets.slice(0, 6).map((asset, index) => (
                <figure key={`${asset.name}-${index}`}>
                  <img src={asset.sourceUrl} alt={asset.name} />
                  {index === 5 && assets.length > 6 ? <figcaption>+{assets.length - 5}</figcaption> : null}
                </figure>
              ))}
            </div>
          ) : (
            <img src={preview.sourceUrl} alt={preview.name} />
          )}
          <div className="upload-tile-meta">
            <span>{multiPreview ? `已选择 ${assets.length} 张图片` : preview.name}</span>
            <button type="button" aria-label="清除" className="upload-tile-clear" onClick={onClear}>
              <Trash2 size={14} />
            </button>
          </div>
        </div>
      ) : (
        <label className="upload-tile-empty">
          <ImageUp size={18} />
          <span>{label}</span>
          <small>{hint}</small>
          <input type="file" accept={accept} multiple={multiple} onChange={(event) => onUpload(event.currentTarget.files)} />
        </label>
      )}
    </div>
  );
}

/* ── 单个表单字段行：标签 + 控件 + 提示 ── */
function Field({
  label,
  hint,
  optional,
  children,
  wide,
}: {
  label: string;
  hint?: string;
  optional?: boolean;
  children: React.ReactNode;
  wide?: boolean;
}) {
  return (
    <div className={wide ? "field wide" : "field"}>
      <div className="field-label">
        <span>{label}</span>
        {optional ? <em>选填</em> : null}
      </div>
      {children}
      {hint ? <small className="field-hint">{hint}</small> : null}
    </div>
  );
}

/* ── 滑杆 + 数值（连续区间）── */
function SliderField({
  label,
  value,
  onChange,
  min = 0,
  max = 100,
  suffix = "%",
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
  suffix?: string;
}) {
  return (
    <div className="field">
      <div className="field-label">
        <span>{label}</span>
        <strong>{value}{suffix}</strong>
      </div>
      <div className="slider-row">
        <input type="range" min={min} max={max} value={value} onChange={(event) => onChange(clampControlPercent(Number(event.target.value)))} />
        <input
          type="number"
          min={min}
          max={max}
          value={value}
          onChange={(event) => onChange(clampControlPercent(Number(event.target.value)))}
        />
      </div>
    </div>
  );
}

const colorSwatches: Record<string, string> = {
  moss: "#6f8065",
  ivory: "#f3efe4",
  butter: "#f3d980",
  "soft-pink": "#e6c4c8",
  "mist-blue": "#aec7d2",
  wine: "#7e3144",
  navy: "#203b61",
  charcoal: "#4d5453",
  khaki: "#b8aa8c",
  black: "#1f2423",
  sage: "#9baa87",
  original: "conic-gradient(from 90deg, #f3efe4, #8aa37a, #e6c4c8, #aec7d2, #f3efe4)",
};

function ColorOptionGroup({
  options,
  value,
  onChange,
  ariaLabel,
}: {
  options: Array<{ id: string; label: string }>;
  value: string;
  onChange: (value: string) => void;
  ariaLabel: string;
}) {
  return (
    <div className="swatch-group" role="radiogroup" aria-label={ariaLabel}>
      {options.map((option) => {
        const selected = option.id === value;
        const color = colorSwatches[option.id] ?? "#d8ded9";
        return (
          <button
            key={option.id}
            type="button"
            role="radio"
            aria-checked={selected}
            className={selected ? "swatch-option selected" : "swatch-option"}
            onClick={() => onChange(option.id)}
          >
            <span style={{ background: color }} />
            <small>{option.label}</small>
          </button>
        );
      })}
    </div>
  );
}

function PanelHeading({
  eyebrow,
  title,
  action,
}: {
  eyebrow?: string;
  title: string;
  action?: ReactNode;
}) {
  return (
    <div className="workflow-panel-heading">
      <div>
        {eyebrow ? <span>{eyebrow}</span> : null}
        <strong>{title}</strong>
      </div>
      {action}
    </div>
  );
}

function InputStatus({ items }: { items: Array<{ label: string; active?: boolean }> }) {
  return (
    <div className="workflow-input-status">
      {items.map((item) => (
        <span key={item.label} className={item.active ? "ready" : ""}>
          {item.label}
        </span>
      ))}
    </div>
  );
}

function SourceReadinessCard({
  title,
  detail,
  items,
}: {
  title: string;
  detail: string;
  items: string[];
}) {
  return (
    <div className="source-readiness-card">
      <BadgeCheck size={17} />
      <div>
        <strong>{title}</strong>
        <span>{detail}</span>
        <small>{items.join(" / ")}</small>
      </div>
    </div>
  );
}

function WorkflowOutputActions({ variant = "default" }: { variant?: "default" | "postprocess" }) {
  return (
    <div className="workflow-output-actions">
      <Button icon={<RefreshCcw size={14} />}>继续编辑</Button>
      <Button icon={<Bookmark size={14} />}>{variant === "postprocess" ? "作为参考" : "作为后期素材"}</Button>
      <Button icon={<Download size={14} />}>{variant === "postprocess" ? "下载全部" : "下载"}</Button>
      <Button icon={<Cloud size={14} />}>{variant === "postprocess" ? "同步 WebDAV" : "WebDAV"}</Button>
    </div>
  );
}

function PreviewImage({ kind, note, alt }: { kind: WorkflowAsset["kind"]; note: string; alt: string }) {
  return <img src={createDemoAssetUrl(kind, note)} alt={alt} />;
}

function FabricFallbackResults() {
  return (
    <div className="workflow-preview-grid fabric-preview-results">
      {["款式方案 A", "款式方案 B", "款式方案 C"].map((title, index) => (
        <article key={title} className="workflow-preview-card">
          <div className="workflow-preview-media">
            <PreviewImage kind="result" note={index === 0 ? "green" : ""} alt={title} />
            <span className={index === 2 ? "badge-warn" : "badge-good"}>{index === 0 ? "优质" : index === 1 ? "良好" : "一般"}</span>
          </div>
          <strong>{title}</strong>
          <small>苔绿 / 提花 / 中长裙摆</small>
          <div className="mini-actions">
            <button type="button">继续编辑</button>
            <button type="button">作为参考</button>
            <button type="button">下载</button>
          </div>
        </article>
      ))}
    </div>
  );
}

function VirtualFallbackResults() {
  return (
    <div className="virtual-output-preview">
      <div className="virtual-main-result">
        <PreviewImage kind="result" note="" alt="虚拟模特上身效果" />
        <span>高清 4K</span>
      </div>
      <SourceReadinessCard title="来源保留度" detail="92%" items={["泡泡袖造型", "腰部排扣细节", "米白色", "领口褶皱"]} />
      <div className="motion-strip">
        <strong>动态预览</strong>
        <div>
          {[0, 1, 2].map((item) => (
            <figure key={item}>
              <PreviewImage kind="result" note="" alt={`动态预览 ${item + 1}`} />
            </figure>
          ))}
        </div>
      </div>
    </div>
  );
}

function PostprocessFallbackResults() {
  return (
    <div className="postprocess-output-preview">
      <div className="before-after-card">
        <div>
          <span>原图</span>
          <PreviewImage kind="result" note="" alt="原图" />
        </div>
        <button type="button" aria-label="拖动滑块查看对比">
          <SlidersHorizontal size={16} />
        </button>
        <div>
          <span>效果图</span>
          <PreviewImage kind="result" note="green" alt="效果图" />
        </div>
      </div>
      <div className="workflow-preview-grid postprocess-preview-results">
        {["透明底", "精修", "重色", "电商裁剪"].map((title, index) => (
          <article key={title} className="workflow-preview-card compact">
            <div className="workflow-preview-media">
              <PreviewImage kind="result" note={index === 2 ? "green" : ""} alt={title} />
              <span>{index === 0 ? "PNG" : index === 3 ? "4:5" : title}</span>
            </div>
            <strong>{title}</strong>
          </article>
        ))}
      </div>
    </div>
  );
}

function WorkflowResultArea({ active, job }: { active: CoreWorkflowType; job?: WorkflowJob }) {
  const hasResults = Boolean(job?.results.length);
  if (hasResults) {
    return (
      <div className="workflow-results-grid">
        {job!.results.map((result) => (
          <ResultCard result={result} key={result.id} compact />
        ))}
      </div>
    );
  }

  if (active === "virtual-model-showcase") return <VirtualFallbackResults />;
  if (active === "postprocess-suite") return <PostprocessFallbackResults />;
  return <FabricFallbackResults />;
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
      <div className="module-help-steps">
        {spec.steps.map((step, index) => {
          const Icon = step.icon;
          return (
            <article key={step.title}>
              <span>{index + 1}</span>
              <Icon size={16} />
              <div>
                <strong>{step.title}</strong>
                <small>{step.detail}</small>
              </div>
            </article>
          );
        })}
      </div>
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

function ResultCard({ result, compact = false }: { result: WorkflowResult; compact?: boolean }) {
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

  const resultClassName = compact
    ? failed
      ? "workflow-result-card compact failed"
      : "workflow-result-card compact"
    : failed
      ? "workflow-result-card failed"
      : "workflow-result-card";

  return (
    <article className={resultClassName}>
      <div className="workflow-result-media">
        {isPlayableVideo ? <video src={result.imageUrl} controls muted playsInline preload="metadata" /> : <img src={result.imageUrl} alt={result.title} />}
        <span>{mediaLabel}</span>
        <span className="evidence-badge">{evidence.label}</span>
      </div>
      <div className="workflow-result-body">
        <strong>{result.title}</strong>
        <span>{resultVersionLabel(result)}</span>
        {compact ? (
          <div className="compact-result-tags">
            <span>{evidence.label}</span>
            {qualityGate?.status ? <span>{qualityGate.status === "passed" ? "质检通过" : "需复核"}</span> : null}
            {result.metadata.colors ? <span>{textList(result.metadata.colors)}</span> : null}
          </div>
        ) : (
          <>
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
          </>
        )}
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
  if (!job) return null;
  return (
    <div className="workflow-steps-rail">
      {job.steps.map((step) => (
        <span key={step.id} className={`step-${step.status}`}>
          {step.status === "failed" ? <CircleAlert size={13} /> : <BadgeCheck size={13} />}
          {step.title}
        </span>
      ))}
    </div>
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

  const visibleModelOptions = filteredModelOptions(virtualModelFilter, activeModelOptions);
  const selectedVirtualSource = virtualSourceOptions.find((option) => option.kind === virtualModelInputs.sourceType) ?? virtualSourceOptions[0];
  const selectedVirtualPoseOptions = compatiblePoseOptions(virtualModelControls.modelId, activeModelOptions);
  const postprocessInputCount = postprocessInputs.assets.length || reusablePostprocessAssets.length || 2;
  const postprocessBatchPreview = postprocessBatchPreviewText(postprocessControls, postprocessInputCount);
  const activeTab = workflowTabs.find((tab) => tab.id === active) ?? workflowTabs[0];
  const ActiveIcon = activeTab.icon;
  const fabricHasFabric = fabricInputs.assets.some((asset) => asset.kind === "fabric");
  const fabricHasSketch = fabricInputs.assets.some((asset) => asset.kind === "sketch");
  const visibleHistoryAssets =
    generatedResults.length > 0
      ? generatedResults.slice(0, 6).map((item) => ({ sourceUrl: item.imageUrl, name: item.title }))
      : reusablePostprocessAssets;

  return (
    <main className={`workflow-center workflow-module-shell workflow-module-${active}`}>
      <header className="workflow-topbar">
        <div className="workflow-topbar-title">
          <h1>{activeTab.label}</h1>
          <p>{activeTab.short} → {activeTab.outcome}</p>
        </div>
        <nav className="workflow-step-tabs workflow-segments" role="tablist" aria-label="AI功能模块">
          {workflowTabs.map((tab) => {
            const Icon = tab.icon;
            return (
              <button
                key={tab.id}
                role="tab"
                aria-selected={active === tab.id}
                className={active === tab.id ? "segment active" : "segment"}
                onClick={() => {
                  setActive(tab.id);
                  setActiveJob(latestByType(dashboard?.jobs ?? [], tab.id) ?? null);
                  setHelpOpen(false);
                  setError("");
                }}
                type="button"
              >
                <em>{tab.module}</em>
                <Icon size={15} />
                <span>{tab.label}</span>
              </button>
            );
          })}
        </nav>
        <button className="workflow-help-trigger" aria-expanded={helpOpen} aria-label="查看功能说明" onClick={() => setHelpOpen((open) => !open)} type="button">
          <HelpCircle size={16} />
          <span>使用指南</span>
        </button>
      </header>

      {helpOpen ? <ModuleHelpPopover active={active} onClose={() => setHelpOpen(false)} /> : null}

      <div className="workflow-split">
        {error ? <div className="workflow-alert">{error}</div> : null}
        <WorkflowFailureNotice job={currentJob} />

        <section className="workflow-col workflow-col-left panel-scroll" aria-label="素材上传">
          <PanelHeading
            eyebrow={active === "postprocess-suite" ? `3/${Math.max(postprocessInputCount, 1)}` : "输入"}
            title={active === "fabric-to-style" ? "素材" : active === "virtual-model-showcase" ? "服装来源" : "待处理图片"}
            action={active === "postprocess-suite" ? <button type="button" className="mini-clear" onClick={() => setPostprocessInputs({ assets: [] })}>清空</button> : null}
          />
          {active === "fabric-to-style" ? (
            <FieldCard step="素材" icon={<SwatchBook size={15} />} title="面料与草图" hint="不传也能试跑">
              <InputStatus
                items={[
                  { label: fabricHasFabric ? "面料已上传" : "面料可上传", active: fabricHasFabric },
                  { label: fabricHasSketch ? "草图已上传" : "草图可选", active: fabricHasSketch },
                ]}
              />
              <div className="upload-tiles">
                <UploadTile
                  label="上传面料图片"
                  hint="布料 / 花型 / 纹理"
                  assets={fabricInputs.assets.filter((asset) => asset.kind === "fabric")}
                  onUpload={(files) => handleFabricAssetUpload(files, "fabric")}
                  onClear={() => setFabricInputs((current) => ({ ...current, assets: current.assets.filter((asset) => asset.kind !== "fabric") }))}
                />
                <UploadTile
                  label="上传设计草图"
                  hint="可选 · 默认版型"
                  assets={fabricInputs.assets.filter((asset) => asset.kind === "sketch")}
                  onUpload={(files) => handleFabricAssetUpload(files, "sketch")}
                  onClear={() => setFabricInputs((current) => ({ ...current, assets: current.assets.filter((asset) => asset.kind !== "sketch") }))}
                />
              </div>
              <Field label="款式描述" optional hint="越具体越贴近商品方向。">
                <textarea
                  aria-label="款式描述"
                  placeholder="例如：春夏通勤连衣裙，保留面料纹理，版型干净，适合电商主图"
                  value={fabricInputs.textDescription}
                  onChange={(event) => updateFabricInputs({ textDescription: event.target.value })}
                />
              </Field>
              <SourceReadinessCard title="输入提示" detail="支持面料图片、设计草图和文字描述组合使用。" items={["JPG/PNG/WEBP", "草图可选", "默认素材可试跑"]} />
            </FieldCard>
          ) : null}

          {active === "virtual-model-showcase" ? (
            <FieldCard step="素材" icon={<Shirt size={15} />} title="服装来源" hint="不传也能试跑">
              <Field label="来源类型">
                <ChipGroup
                  ariaLabel="来源类型"
                  options={virtualSourceOptions.map((option) => ({ id: option.kind, label: option.label }))}
                  value={virtualModelInputs.sourceType}
                  onChange={(value) => setVirtualModelInputs((current) => ({ ...current, sourceType: value as VirtualModelInputs["sourceType"], assets: [] }))}
                />
              </Field>
              <UploadTile
                label={`上传${selectedVirtualSource.label}`}
                hint="平铺图 / 人台图 / 设计图"
                assets={virtualModelInputs.assets}
                onUpload={handleVirtualAssetUpload}
                onClear={() => updateVirtualModelInputs({ assets: [] })}
              />
              <Field label="服装说明" optional hint="强调必须保留的款式细节。">
                <textarea
                  aria-label="服装说明"
                  placeholder="例如：保持泡泡袖、腰部排扣和米白色雪纺质感"
                  value={virtualModelInputs.description}
                  onChange={(event) => updateVirtualModelInputs({ description: event.target.value })}
                />
              </Field>
              <SourceReadinessCard
                title={virtualModelInputs.assets.length > 0 ? "来源已就绪" : "可使用默认来源"}
                detail={virtualSourceFallbackLabel(virtualModelInputs.sourceType)}
                items={["保留廓形", "保留面料", "保留关键细节"]}
              />
            </FieldCard>
          ) : null}

          {active === "postprocess-suite" ? (
            <>
            <FieldCard step="素材" icon={<ImageUp size={15} />} title="待处理图片" hint="可多张；不传复用最近图">
              <div className="postprocess-upload-grid">
                <UploadTile
                  label="上传批量图片"
                  hint="支持多张"
                  multiple
                  assets={postprocessInputs.assets}
                  onUpload={handlePostprocessAssetUpload}
                  onClear={() => setPostprocessInputs({ assets: [] })}
                />
              </div>
              <SourceReadinessCard
                title={postprocessInputs.assets.length > 0 ? `已选择 ${postprocessInputs.assets.length} 张` : "可复用最近生成图"}
                detail={reusablePostprocessAssets.length > 0 ? "检测到可复用素材" : "默认批量演示素材"}
                items={["可拖拽调整顺序", "单次最多 50 张", "批量交付"]}
              />
            </FieldCard>
            <FieldCard step="动作" icon={<Scissors size={15} />} title="后期动作" hint="可多选">
              <Field label="后期动作" hint="点选一个或多个。">
                <ChipToggleGroup
                  ariaLabel="后期动作"
                  options={postprocessActionOptions.map((option) => ({ id: option.id, label: option.label }))}
                  values={postprocessControls.actions}
                  onToggle={togglePostprocessAction}
                />
              </Field>
            </FieldCard>
            </>
          ) : null}
        </section>

        <section className="workflow-col workflow-col-center panel-scroll" aria-label={`${activeTab.label}设定`}>
          <PanelHeading eyebrow="控制" title={active === "fabric-to-style" ? "款式设定" : active === "virtual-model-showcase" ? "模特与场景" : "效果调整"} />
          {active === "fabric-to-style" ? (
            <>
              <FieldCard step="设定" icon={<SlidersHorizontal size={15} />} title="款式设定" hint="点选即可">
                <div className="fabric-design-grid">
                  <div className="fabric-control-stack">
                    <Field label="服装品类" hint="可输入自定义，如 coat / shirt / skirt。">
                      <ComboBox
                        ariaLabel="服装品类"
                        options={[{ id: "dress", label: "连衣裙" }, { id: "coat", label: "外套" }, { id: "shirt", label: "衬衫" }, { id: "skirt", label: "半裙" }, { id: "top", label: "上衣" }, { id: "pants", label: "裤装" }]}
                        value={fabricInputs.garmentCategory}
                        onChange={(value) => updateFabricInputs({ garmentCategory: value })}
                        placeholder="输入或选择服装品类"
                      />
                    </Field>
                    <Field label="面料图案">
                      <ChipGroup ariaLabel="面料图案" options={fabricPatternOptions.slice(0, 6).map((option) => ({ id: option.id, label: option.label }))} value={fabricControls.pattern} onChange={(value) => updateFabricControls({ pattern: value })} />
                    </Field>
                    <Field label="主色调" hint="常用电商色板，可继续自定义。">
                      <ColorOptionGroup ariaLabel="主色调" options={fabricColorOptions.slice(0, 5).map((option) => ({ id: option.id, label: option.label }))} value={fabricControls.color} onChange={(value) => updateFabricControls({ color: value })} />
                    </Field>
                    <Field label="领口">
                      <ChipGroup ariaLabel="领口" options={necklineOptions.slice(0, 4).map((option) => ({ id: option.id, label: option.label }))} value={fabricControls.neckline} onChange={(value) => updateFabricControls({ neckline: value })} />
                    </Field>
                    <Field label={`衣长 · ${hemLengthOptions[optionIndex(hemLengthOptions, fabricControls.hemLength)]?.label}`}>
                      <input aria-label="衣长" type="range" min="0" max={hemLengthOptions.length - 1} value={optionIndex(hemLengthOptions, fabricControls.hemLength)} onChange={(event) => updateFabricControls({ hemLength: hemLengthOptions[Number(event.target.value)]?.id ?? fabricControls.hemLength })} />
                    </Field>
                    <Field label={`袖长 · ${sleeveLengthOptions[optionIndex(sleeveLengthOptions, fabricControls.sleeveLength)]?.label}`}>
                      <input aria-label="袖长" type="range" min="0" max={sleeveLengthOptions.length - 1} value={optionIndex(sleeveLengthOptions, fabricControls.sleeveLength)} onChange={(event) => updateFabricControls({ sleeveLength: sleeveLengthOptions[Number(event.target.value)]?.id ?? fabricControls.sleeveLength })} />
                    </Field>
                  </div>
                  <div className="fabric-outline-panel">
                    <div className="fabric-outline-head">
                      <strong>款式轮廓编辑</strong>
                      <button type="button" onClick={() => updateFabricControls(defaultFabricControls)}>重置</button>
                    </div>
                    <FabricPreviewEditor controls={fabricControls} onChange={updateFabricControls} />
                  </div>
                </div>
              </FieldCard>

              <div className="run-bar">
                <Field label="裂变维度" hint="决定多个变体往哪个方向裂变。">
                  <ChipGroup ariaLabel="裂变维度" size="sm" options={fissionDimensionOptions.map((option) => ({ id: option.id, label: option.label }))} value={fabricControls.fissionDimension} onChange={(value) => updateFabricControls({ fissionDimension: value })} />
                </Field>
                <Field label="变体数量" hint="首次 2 张；测款可 4-8 张。">
                  <NumberStepper ariaLabel="款式变体数量" min={1} max={8} value={fabricControls.variants} onChange={(value) => updateFabricControls({ variants: value })} />
                </Field>
                <Button variant="primary" icon={loading ? <Loader2 size={15} /> : <Sparkles size={15} />} onClick={() => runWorkflow("fabric-to-style")} disabled={loading}>
                  生成款式方案
                </Button>
              </div>
            </>
          ) : null}

          {active === "virtual-model-showcase" ? (
            <>
              <FieldCard step="设定" icon={<Shirt size={15} />} title="模特与场景" hint="点选或输入">
                <Field label="模特分类">
                  <ChipGroup ariaLabel="模特分类" size="sm" options={modelCollectionFilterOptions.map((option) => ({ id: option.id, label: option.label }))} value={virtualModelFilter} onChange={(value) => selectVirtualModelFilter(value as ModelCollectionFilter)} />
                </Field>
                <Field label="虚拟模特" hint={`覆盖 ${visibleModelOptions.length} 个可商用画像，可搜索。`}>
                  <ComboBox ariaLabel="虚拟模特" options={visibleModelOptions.map((option) => ({ id: option.id, label: option.label }))} value={virtualModelControls.modelId} onChange={(value) => selectVirtualModel(value)} placeholder="选择或搜索模特" />
                </Field>
                <div className="virtual-model-profile" aria-label="虚拟模特资料">
                  <strong>{modelProfileText(virtualModelControls.modelId, activeModelOptions)}</strong>
                  <span>{visibleModelOptions.length} 个可商用画像</span>
                </div>
                <div className="model-portrait-rail" aria-label="虚拟模特缩略图">
                  {visibleModelOptions.slice(0, 6).map((model) => (
                    <button
                      type="button"
                      key={model.id}
                      className={model.id === virtualModelControls.modelId ? "selected" : ""}
                      onClick={() => selectVirtualModel(model.id)}
                    >
                      <PreviewImage kind="result" note="" alt={model.label} />
                      <span>{model.label}</span>
                    </button>
                  ))}
                </div>
                <Field label="展示场景" hint="可输入自定义，如海边、咖啡馆。">
                  <ComboBox ariaLabel="展示场景" options={sceneControlOptions.map((option) => ({ id: option.id, label: option.label }))} value={virtualModelControls.sceneId} onChange={(value) => updateVirtualModelControls({ sceneId: value })} placeholder="选择或输入场景" />
                </Field>
                <Field label="模特姿势" hint="可输入自定义姿势。">
                  <ComboBox ariaLabel="模特姿势" options={selectedVirtualPoseOptions.map((option) => ({ id: option.id, label: option.label }))} value={virtualModelControls.poseId} onChange={(value) => updateVirtualModelControls({ poseId: value })} placeholder="选择或输入姿势" />
                </Field>
              </FieldCard>

              <div className="run-bar">
                <label className="toggle-field">
                  <input type="checkbox" checked={virtualModelControls.motionPreview} onChange={(event) => updateVirtualModelControls({ motionPreview: event.target.checked })} />
                  <span>生成动效预览</span>
                  <small>开启后额外生成该姿势的短视频动效</small>
                </label>
                <Button variant="primary" icon={loading ? <Loader2 size={15} /> : <Clapperboard size={15} />} onClick={() => runWorkflow("virtual-model-showcase")} disabled={loading}>
                  生成上身展示
                </Button>
              </div>
            </>
          ) : null}

          {active === "postprocess-suite" ? (
            <>
              <FieldCard step="设定" icon={<SlidersHorizontal size={15} />} title="效果调整">
                <Field label="输出场景" hint="可多选，每选一个多一组。">
                  <ChipToggleGroup ariaLabel="输出场景" size="sm" options={postprocessSceneOptions.map((option) => ({ id: option.id, label: option.label }))} values={postprocessControls.targetScenes} onToggle={togglePostprocessScene} />
                </Field>
                <div className="postprocess-batch-preview" aria-label="批量输出预估">
                  <strong>批量输出</strong>
                  <span>{postprocessBatchPreview}</span>
                </div>
                <Field label="目标颜色">
                  <ColorOptionGroup ariaLabel="目标颜色" options={targetColorOptions.slice(0, 6).map((option) => ({ id: option.id, label: option.label }))} value={postprocessControls.targetColor} onChange={(value) => updatePostprocessControls({ targetColor: value })} />
                </Field>
                <Field label="输出比例">
                  <ChipGroup ariaLabel="输出比例" options={targetRatioOptions.map((option) => ({ id: option.id, label: option.label }))} value={postprocessControls.targetRatio} onChange={(value) => updatePostprocessControls({ targetRatio: value })} />
                </Field>
                <SliderField label="补光强度" value={postprocessControls.lightStrength} onChange={(value) => updatePostprocessControls({ lightStrength: value })} />
                <SliderField label="美体强度" value={postprocessControls.beautyLevel} onChange={(value) => updatePostprocessControls({ beautyLevel: value })} />
              </FieldCard>

              <FieldCard step="进阶" icon={<SlidersHorizontal size={15} />} title="修复与擦除" hint="按需调整" collapsible defaultOpen={false}>
                <Field label="修复重点">
                  <ChipGroup ariaLabel="修复重点" options={postprocessRepairFocusOptions.map((option) => ({ id: option.id, label: option.label }))} value={postprocessControls.repairFocus} onChange={(value) => updatePostprocessControls({ repairFocus: value })} />
                </Field>
                <Field label="擦除目标" optional hint="仅勾选对象擦除时使用。">
                  <input aria-label="擦除目标" type="text" placeholder="例如：背景杂物、地面污点、模特手边道具" value={postprocessControls.eraseTarget} onChange={(event) => updatePostprocessControls({ eraseTarget: event.target.value })} />
                </Field>
              </FieldCard>

              <div className="run-bar">
                <small className="field-hint">{reusablePostprocessAssets.length > 0 ? "使用前序真实生成图" : "默认批量演示素材"}</small>
                <Button variant="primary" icon={loading ? <Loader2 size={15} /> : <Scissors size={15} />} onClick={() => runWorkflow("postprocess-suite")} disabled={loading}>
                  开始批量后期
                </Button>
              </div>
            </>
          ) : null}
        </section>

        <section className="workflow-col workflow-col-right panel-scroll" aria-label={`${activeTab.label}结果`}>
          <PanelHeading eyebrow="输出" title="结果" action={<ActiveIcon size={16} />} />
          <WorkflowSteps job={currentJob} />
          <WorkflowResultArea active={active} job={currentJob} />
          <WorkflowOutputActions variant={active === "postprocess-suite" ? "postprocess" : "default"} />

          <div className="workflow-history-head">
            <Layers3 size={14} />
            <strong>历史与可复用素材</strong>
          </div>
          {visibleHistoryAssets.length > 0 ? (
            <div className="workflow-history-grid">
              {visibleHistoryAssets.map((asset, index) => (
                <figure key={`${asset.sourceUrl}-${index}`} className="history-thumb">
                  <img src={asset.sourceUrl} alt={asset.name} loading="lazy" />
                  <figcaption>{asset.name}</figcaption>
                </figure>
              ))}
            </div>
          ) : (
            <div className="workflow-empty workflow-empty-output">
              <Sparkles size={24} />
              <strong>结果会显示在这里</strong>
              <span>默认素材可直接试跑；左侧上传你的图片后优先使用你的素材。生成后的结果会沉淀到这里，供后期模块复用。</span>
            </div>
          )}
        </section>
      </div>
    </main>
  );
}
