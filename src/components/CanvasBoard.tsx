import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowToolbarItem,
  AssetRecordType,
  AssetToolbarItem,
  BaseBoxShapeUtil,
  Box,
  DefaultColorStyle,
  DefaultImageToolbar,
  DefaultImageToolbarContent,
  DefaultStylePanel,
  DefaultToolbar,
  DrawToolbarItem,
  EllipseToolbarItem,
  EraserToolbarItem,
  FrameToolbarItem,
  HandToolbarItem,
  HighlightToolbarItem,
  HTMLContainer,
  LaserToolbarItem,
  LineToolbarItem,
  NoteToolbarItem,
  RectangleToolbarItem,
  SelectToolbarItem,
  StateNode,
  T,
  TextToolbarItem,
  Tldraw,
  TldrawUiButtonIcon,
  TldrawUiMenuToolItem,
  TldrawUiToolbarButton,
  createShapeId,
  onDragFromToolbarToCreateShape,
  startEditingShapeWithRichText,
  stopEventPropagation,
  toRichText,
  useEditor,
  useValue,
  type Editor,
  type RecordProps,
  type TLBaseShape,
  type TLComponents,
  type TLImageShape,
  type TLPointerEventInfo,
  type TLShape,
  type TLShapeId,
  type TLUiOverrides,
} from "tldraw";
import { getAssetUrlsByImport } from "@tldraw/assets/imports.vite";
import "tldraw/tldraw.css";
import { ratioOptions } from "../data/catalog";
import { CANVAS_PERSISTENCE_KEY } from "../lib/canvasStore";
import { reportClientError } from "../lib/clientErrors";
import {
  attachmentUsageHints,
  attachmentUsageLabels,
  frameSizeForRatio,
  nearestRatioId,
} from "../lib/freeStudio";
import { outputSizeForRatio } from "../lib/outputSize";
import { isPlaceholderImage } from "../lib/providerMode";
import type { AttachmentUsage, FreeAttachment, GeneratedResult, PendingCanvasImage } from "../types";

const assetUrls = getAssetUrlsByImport();
const PERSISTENCE_KEY = CANVAS_PERSISTENCE_KEY;
const AI_FRAME_TYPE = "ai-frame";
const AI_FRAME_TOOL_ID = "ai-frame-tool";
const ANNOTATION_TOOL_ID = "annotation";
const FRAME_LONG_EDGE = 540;
const DEFAULT_RATIO_ID = "2-3";
const EXPORT_MIN_EDGE = 640;
const RESULT_GAP = 40;
const REF_THUMB_EDGE = 200;
const REF_GAP = 20;
const ANNOTATION_MIN_LENGTH = 8;
const ANNOTATION_COLORS = new Set(["red", "orange", "yellow", "light-red"]);
const PANEL_MIN_W = 520;
const PANEL_MAX_W = 640;
const PANEL_MARGIN = 16;
const PANEL_OFFSET = 14;
// 底部要给 tldraw 的工具栏留位置，面板压在工具栏上就点不到工具了。
const PANEL_BOTTOM_RESERVE = 78;

// 画布上能选的比例：除「自动」外全部开放。非原生比例照样能画框，只是接口会按最近的原生尺寸交付。
const frameRatios = ratioOptions.filter((ratio) => ratio.id !== "auto");

/* ────────────────────────────────────────────────────────────────────────────
 * AI 画框
 *
 * 沿用 Cowart 的核心契约：画框是「我要在这个位置、这个尺寸、这个比例来一张图」的
 * 占位符，生成完成后被同位置的图片形状取代。用自定义 box shape 而不是 tldraw
 * 内置 frame，避免 frame 自动把拖进范围的图形收成子节点。
 * ──────────────────────────────────────────────────────────────────────────── */

interface AiFrameProps {
  w: number;
  h: number;
  ratioId: string;
  prompt: string;
  status: string;
  message: string;
  /** 已链接为引用图的画布图片 id。老记录没有这个字段，所以是可选。 */
  refIds?: string[];
}

// tldraw v5 通过模块增强把自定义形状并进 TLShape 联合类型，
// 否则 editor.createShape / getShape 之类的泛型都认不出 ai-frame。
declare module "@tldraw/tlschema" {
  interface TLGlobalShapePropsMap {
    [AI_FRAME_TYPE]: AiFrameProps;
  }
}

type AiFrameShape = TLBaseShape<typeof AI_FRAME_TYPE, AiFrameProps>;

function ratioLabelFor(ratioId: string) {
  return ratioOptions.find((ratio) => ratio.id === ratioId)?.label ?? "1:1";
}

class AiFrameShapeUtil extends BaseBoxShapeUtil<AiFrameShape> {
  static override type = AI_FRAME_TYPE;

  static override props: RecordProps<AiFrameShape> = {
    w: T.number,
    h: T.number,
    ratioId: T.string,
    prompt: T.string,
    status: T.string,
    message: T.string,
    refIds: T.arrayOf(T.string).optional(),
  };

  getDefaultProps(): AiFrameShape["props"] {
    const size = frameSizeForRatio(ratioOptions.find((ratio) => ratio.id === DEFAULT_RATIO_ID), FRAME_LONG_EDGE);
    return { ...size, ratioId: DEFAULT_RATIO_ID, prompt: "", status: "idle", message: "", refIds: [] };
  }

  override canEdit() {
    return false;
  }

  // 画框比例就是交付比例，拖角只缩放不变形。
  override isAspectRatioLocked() {
    return true;
  }

  component(shape: AiFrameShape) {
    const ratio = ratioOptions.find((item) => item.id === shape.props.ratioId);
    const size = outputSizeForRatio(ratio);
    return (
      <HTMLContainer className={`ai-frame ai-frame-${shape.props.status}`}>
        <span className="ai-frame-label">
          AI 画框 · {ratio?.label ?? "1:1"}
          {size.auto ? "" : ` · ${size.width}×${size.height}`}
        </span>
        {shape.props.status === "running" ? (
          <span className="ai-frame-status running">
            <i className="ai-frame-spinner" aria-hidden="true" />
            正在生成…
          </span>
        ) : shape.props.status === "failed" ? (
          <span className="ai-frame-status failed">{shape.props.message || "生成失败"}</span>
        ) : shape.props.prompt.trim() ? (
          <span className="ai-frame-hint ai-frame-prompt">{shape.props.prompt.trim()}</span>
        ) : (
          <span className="ai-frame-hint">在下方描述要生成什么</span>
        )}
      </HTMLContainer>
    );
  }

  override getIndicatorPath(shape: AiFrameShape) {
    const path = new Path2D();
    path.rect(0, 0, shape.props.w, shape.props.h);
    return path;
  }
}

function isAiFrame(shape: TLShape | null | undefined): shape is AiFrameShape {
  return shape?.type === AI_FRAME_TYPE;
}

function isImageShape(shape: TLShape | null | undefined): shape is TLImageShape {
  return shape?.type === "image";
}

function frameRefIds(frame: AiFrameShape): TLShapeId[] {
  return (frame.props.refIds ?? []) as TLShapeId[];
}

/* ────────────────────────────────────────────────────────────────────────────
 * 标注工具：拖一下拉出红色箭头，松手直接写字。
 * 用 tldraw 自带的箭头 + 文字，画布上就是普通形状，可以再挪、再改。
 * ──────────────────────────────────────────────────────────────────────────── */

function annotationBend(dx: number, dy: number, scale: number) {
  const length = Math.hypot(dx, dy);
  if (length === 0) return 0;
  const bend = Math.min(Math.max(length * 0.12, 16 * scale), 48 * scale);
  if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? -bend : bend;
  return bend;
}

class AnnotationIdle extends StateNode {
  static override id = "idle";

  override onEnter() {
    this.editor.setCursor({ type: "cross", rotation: 0 });
  }

  override onPointerDown(info: TLPointerEventInfo) {
    this.parent.transition("pointing", info);
  }

  override onCancel() {
    this.editor.setCurrentTool("select");
  }
}

class AnnotationPointing extends StateNode {
  static override id = "pointing";

  arrowId: TLShapeId | null = null;
  origin: { x: number; y: number } | null = null;
  markId = "";

  override onEnter() {
    const origin = this.editor.inputs.getOriginPagePoint();
    const scale = this.editor.getResizeScaleFactor();
    const picked = this.editor.getStyleForNextShape(DefaultColorStyle);
    const color = picked === DefaultColorStyle.defaultValue ? "red" : picked;
    const arrowId = createShapeId();
    this.arrowId = arrowId;
    this.origin = { x: origin.x, y: origin.y };
    this.markId = this.editor.markHistoryStoppingPoint(`annotation:${arrowId}`);
    this.editor.createShape({
      id: arrowId,
      type: "arrow",
      x: origin.x,
      y: origin.y,
      meta: { aiAnnotation: true },
      props: {
        kind: "arc",
        dash: "draw",
        size: "m",
        fill: "none",
        color,
        labelColor: color,
        bend: 0,
        start: { x: 0, y: 0 },
        end: { x: 1, y: 0 },
        arrowheadStart: "none",
        arrowheadEnd: "arrow",
        richText: toRichText(""),
        labelPosition: 0,
        font: "draw",
        scale,
      },
    });
  }

  override onPointerMove() {
    this.updateEnd();
  }

  override onPointerUp() {
    this.complete();
  }

  override onCancel() {
    this.bail();
  }

  override onInterrupt() {
    this.bail();
  }

  private updateEnd() {
    if (!this.arrowId || !this.origin) return;
    const point = this.editor.inputs.getCurrentPagePoint();
    this.editor.updateShapes([
      { id: this.arrowId, type: "arrow", props: { end: { x: point.x - this.origin.x, y: point.y - this.origin.y } } },
    ]);
  }

  private complete() {
    if (!this.arrowId || !this.origin) {
      this.parent.transition("idle");
      return;
    }
    this.updateEnd();
    const point = this.editor.inputs.getCurrentPagePoint();
    const dx = point.x - this.origin.x;
    const dy = point.y - this.origin.y;
    if (Math.hypot(dx, dy) < ANNOTATION_MIN_LENGTH / this.editor.getZoomLevel()) {
      this.editor.bailToMark(this.markId);
      this.parent.transition("idle");
      return;
    }
    this.editor.updateShapes([
      { id: this.arrowId, type: "arrow", props: { bend: annotationBend(dx, dy, this.editor.getResizeScaleFactor()) } },
    ]);
    const arrowId = this.arrowId;
    this.editor.select(arrowId);
    startEditingShapeWithRichText(this.editor, arrowId, { selectAll: true });
    // 写完标注回到标注工具，连着标几处不用每次点工具。
    this.editor.getCurrentTool().setCurrentToolIdMask(ANNOTATION_TOOL_ID);
  }

  private bail() {
    if (this.arrowId) this.editor.bailToMark(this.markId);
    this.parent.transition("idle");
  }
}

class AnnotationTool extends StateNode {
  static override id = ANNOTATION_TOOL_ID;
  static override initial = "idle";

  static override children() {
    return [AnnotationIdle, AnnotationPointing];
  }

  override onEnter() {
    if (this.editor.getInstanceState().isToolLocked) this.editor.updateInstanceState({ isToolLocked: false });
  }
}

function hasAnnotationColor(shape: TLShape) {
  const props = shape.props as { color?: string; labelColor?: string };
  return ANNOTATION_COLORS.has(props.color ?? "") || ANNOTATION_COLORS.has(props.labelColor ?? "");
}

function isAnnotationShape(shape: TLShape) {
  if (shape.meta?.aiAnnotation === true) return true;
  return (shape.type === "arrow" || shape.type === "text") && hasAnnotationColor(shape);
}

function isMarkShape(shape: TLShape) {
  return ["draw", "geo", "line", "highlight", "arrow", "text", "note"].includes(shape.type);
}

/**
 * 选中一张图点「按标注改图」时，把压在图上、连到图上或贴着图的标注一起带上。
 * 与 Cowart 一样按邻近范围收集，不要求用户先框选。
 */
function collectAnnotationShapeIds(editor: Editor, imageId: TLShapeId) {
  const bounds = editor.getShapePageBounds(imageId);
  if (!bounds) return [imageId];
  const near = bounds.clone().expandBy(Math.min(720, Math.max(160, Math.max(bounds.width, bounds.height))));
  const arrows: Box[] = [];
  const ids: TLShapeId[] = [];
  const texts: TLShapeId[] = [];
  for (const shape of editor.getCurrentPageShapesSorted()) {
    if (shape.id === imageId || isImageShape(shape) || isAiFrame(shape)) continue;
    const shapeBounds = editor.getShapePageBounds(shape.id);
    if (!shapeBounds) continue;
    if (shape.type === "arrow" && isAnnotationShape(shape) && near.collides(shapeBounds)) {
      ids.push(shape.id);
      arrows.push(shapeBounds);
      continue;
    }
    if (shape.type === "text" && isAnnotationShape(shape)) {
      texts.push(shape.id);
      continue;
    }
    // 画笔圈选、几何框、荧光笔：压在图上的一律算标注。
    if (isMarkShape(shape) && bounds.clone().expandBy(24).collides(shapeBounds)) ids.push(shape.id);
  }
  for (const textId of texts) {
    const textBounds = editor.getShapePageBounds(textId);
    if (!textBounds) continue;
    if (near.collides(textBounds) || arrows.some((arrow) => arrow.clone().expandBy(120).collides(textBounds))) {
      ids.push(textId);
    }
  }
  return [imageId, ...new Set(ids)];
}

/* ────────────────────────────────────────────────────────────────────────────
 * 画布 ↔ 生成内核之间的桥
 * ──────────────────────────────────────────────────────────────────────────── */

export interface CanvasGenerateInput {
  prompt: string;
  attachments: FreeAttachment[];
  ratioId: string;
  intent: "free" | "annotation" | "sketch";
}

interface CanvasApi {
  costFor: (referenceCount: number) => number;
  credits: number;
  results: GeneratedResult[];
  onGenerate: (input: CanvasGenerateInput) => Promise<GeneratedResult[]>;
  onNotice: (message: string) => void;
}

const CanvasApiContext = createContext<CanvasApi | null>(null);

function useCanvasApi() {
  const api = useContext(CanvasApiContext);
  if (!api) throw new Error("CanvasApiContext is missing");
  return api;
}

interface CanvasUi {
  libraryOpen: boolean;
  helpOpen: boolean;
  toggleLibrary: () => void;
  toggleHelp: () => void;
  closeLibrary: () => void;
  closeHelp: () => void;
}

const CanvasUiContext = createContext<CanvasUi | null>(null);

function useCanvasUi() {
  const ui = useContext(CanvasUiContext);
  if (!ui) throw new Error("CanvasUiContext is missing");
  return ui;
}

function imageShapeSource(editor: Editor, shape: TLImageShape) {
  if (!shape.props.assetId) return "";
  const asset = editor.getAsset(shape.props.assetId);
  return asset?.type === "image" ? (asset.props.src ?? "") : "";
}

function shapeUsage(shape: TLShape): AttachmentUsage {
  return shape.meta?.aiUsage === "merge" ? "merge" : "reference";
}

/**
 * 从视口中心出发找一块不压住已有内容的位置。新画框直接落在中心会盖住刚放上来的图，
 * 既看不见也点不中（tldraw 命中测试按几何图形走，上层形状会吃掉点击）。
 */
function findFreeSpot(editor: Editor, size: { w: number; h: number }) {
  const gap = 32;
  const viewport = editor.getViewportPageBounds();
  const center = viewport.center;
  const fallback = { x: center.x - size.w / 2, y: center.y - size.h / 2 };
  const existing = editor
    .getCurrentPageShapes()
    .map((shape) => editor.getShapePageBounds(shape.id))
    .filter((bounds): bounds is Box => Boolean(bounds));

  const isFree = (x: number, y: number) =>
    !existing.some((bounds) => new Box(x, y, size.w, size.h).expandBy(gap).collides(bounds));
  const inView = (x: number, y: number) =>
    x >= viewport.minX && y >= viewport.minY && x + size.w <= viewport.maxX && y + size.h <= viewport.maxY;

  if (isFree(fallback.x, fallback.y)) return { ...fallback, inViewport: true };

  const stepX = size.w + gap;
  const stepY = size.h + gap;
  const directions = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
    [1, 1],
    [-1, 1],
    [1, -1],
    [-1, -1],
  ];
  for (const requireInView of [true, false]) {
    for (let ring = 1; ring <= 12; ring += 1) {
      for (const [dx, dy] of directions) {
        const x = fallback.x + dx * ring * stepX;
        const y = fallback.y + dy * ring * stepY;
        if (requireInView && !inView(x, y)) continue;
        if (isFree(x, y)) return { x, y, inViewport: requireInView };
      }
    }
  }
  return { ...fallback, inViewport: true };
}

function loadImageSize(src: string) {
  return new Promise<{ w: number; h: number }>((resolve) => {
    const image = new Image();
    image.onload = () => resolve({ w: image.naturalWidth || 1024, h: image.naturalHeight || 1024 });
    image.onerror = () => resolve({ w: 1024, h: 1024 });
    image.src = src;
  });
}

/** 把一张图落到画布上：建 asset + image shape，返回新形状 id。给了 box 就按 box 等比放进去。 */
async function placeImage(
  editor: Editor,
  image: { url: string; name: string; resultId?: string },
  box: { x: number; y: number; w: number; h: number } | null,
  longEdge = 460,
) {
  const natural = await loadImageSize(image.url);
  const assetId = AssetRecordType.createId();
  editor.createAssets([
    {
      id: assetId,
      type: "image",
      typeName: "asset",
      props: {
        name: image.name,
        src: image.url,
        w: natural.w,
        h: natural.h,
        mimeType: image.url.startsWith("data:") ? image.url.slice(5, image.url.indexOf(";")) : "image/png",
        isAnimated: false,
      },
      meta: {},
    },
  ]);

  let placement: { x: number; y: number; w: number; h: number };
  if (box) {
    // 接口有时按最近的原生比例交付（9:16 → 2:3），等比放进画框，别硬拉伸。
    const scale = Math.min(box.w / natural.w, box.h / natural.h);
    const w = Math.round(natural.w * scale);
    const h = Math.round(natural.h * scale);
    placement = { x: box.x + (box.w - w) / 2, y: box.y + (box.h - h) / 2, w, h };
  } else {
    const scale = longEdge / Math.max(natural.w, natural.h);
    const size = { w: Math.round(natural.w * scale), h: Math.round(natural.h * scale) };
    placement = { ...findFreeSpot(editor, size), ...size };
  }

  const shapeId = createShapeId();
  editor.createShape({
    id: shapeId,
    type: "image",
    x: placement.x,
    y: placement.y,
    props: { assetId, w: placement.w, h: placement.h },
    meta: { aiUsage: "reference", aiResultId: image.resultId ?? null, aiName: image.name },
  });
  return shapeId;
}

function readFileAsDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error("读取失败"));
    reader.readAsDataURL(file);
  });
}

function clipboardImageFiles(event: React.ClipboardEvent) {
  return Array.from(event.clipboardData?.items ?? [])
    .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
    .map((item) => item.getAsFile())
    .filter((file): file is File => Boolean(file));
}

function createFrame(editor: Editor, at: { x: number; y: number } | null, ratioId = DEFAULT_RATIO_ID) {
  const ratio = ratioOptions.find((item) => item.id === ratioId);
  const size = frameSizeForRatio(ratio, FRAME_LONG_EDGE);
  const spot = at ? { ...at, inViewport: true } : findFreeSpot(editor, size);
  const id = createShapeId();
  editor.createShape<AiFrameShape>({
    id,
    type: AI_FRAME_TYPE,
    x: spot.x,
    y: spot.y,
    props: { ...size, ratioId, prompt: "", status: "idle", message: "", refIds: [] },
  });
  return { id, size, spot };
}

function updateFrame(editor: Editor, frame: AiFrameShape, props: Partial<AiFrameProps>) {
  editor.updateShape<AiFrameShape>({ id: frame.id, type: AI_FRAME_TYPE, props: { ...frame.props, ...props } });
}

function linkRefs(editor: Editor, frameId: TLShapeId, ids: TLShapeId[]) {
  const frame = editor.getShape<AiFrameShape>(frameId);
  if (!frame) return;
  const next = [...new Set([...frameRefIds(frame), ...ids])];
  updateFrame(editor, frame, { refIds: next });
}

function unlinkRef(editor: Editor, frameId: TLShapeId, id: TLShapeId) {
  const frame = editor.getShape<AiFrameShape>(frameId);
  if (!frame) return;
  updateFrame(editor, frame, { refIds: frameRefIds(frame).filter((item) => item !== id) });
}

/** 上传/粘贴的参考图落在画框左侧一列，既能看见也能继续用。 */
async function placeRefBesideFrame(editor: Editor, frame: AiFrameShape, image: { url: string; name: string }) {
  const natural = await loadImageSize(image.url);
  const scale = REF_THUMB_EDGE / Math.max(natural.w, natural.h);
  const w = Math.round(natural.w * scale);
  const h = Math.round(natural.h * scale);
  const existing = frameRefIds(frame)
    .map((id) => editor.getShapePageBounds(id))
    .filter((bounds): bounds is Box => Boolean(bounds))
    .filter((bounds) => bounds.maxX <= frame.x);
  const y = existing.length ? Math.max(...existing.map((bounds) => bounds.maxY)) + REF_GAP : frame.y;
  const shapeId = await placeImage(editor, image, { x: frame.x - REF_GAP - w, y, w, h });
  return shapeId;
}

function viewportRect(editor: Editor, box: Box) {
  const topLeft = editor.pageToViewport({ x: box.minX, y: box.minY });
  const bottomRight = editor.pageToViewport({ x: box.maxX, y: box.maxY });
  return { left: topLeft.x, top: topLeft.y, right: bottomRight.x, bottom: bottomRight.y };
}

/* ────────────────────────────────────────────────────────────────────────────
 * 工具栏（tldraw Toolbar 插槽）：标注 | 选择 抓手 AI画框 | 媒体 画笔 …
 * ──────────────────────────────────────────────────────────────────────────── */

function AnnotationToolbarItem() {
  const editor = useEditor();
  const selected = useValue("annotation tool selected", () => editor.getCurrentToolId() === ANNOTATION_TOOL_ID, [editor]);
  return (
    <button
      type="button"
      aria-label="标注"
      aria-pressed={selected}
      title="标注 · C"
      className="tlui-button tlui-button__tool canvas-annotation-tool"
      data-value={ANNOTATION_TOOL_ID}
      onClick={() => editor.setCurrentTool(ANNOTATION_TOOL_ID)}
    >
      {annotationIcon}
      <span>标注</span>
    </button>
  );
}

function AiFrameToolbarItem() {
  const editor = useEditor();
  const selected = useValue("ai frame tool selected", () => editor.getCurrentToolId() === AI_FRAME_TOOL_ID, [editor]);
  return <TldrawUiMenuToolItem toolId={AI_FRAME_TOOL_ID} isSelected={selected} />;
}

function CanvasToolbar() {
  return (
    <DefaultToolbar maxItems={9}>
      <AnnotationToolbarItem />
      <div className="canvas-toolbar-divider" role="separator" aria-orientation="vertical" />
      <SelectToolbarItem />
      <HandToolbarItem />
      <AiFrameToolbarItem />
      <div className="canvas-toolbar-divider" role="separator" aria-orientation="vertical" />
      <AssetToolbarItem />
      <DrawToolbarItem />
      <EraserToolbarItem />
      <TextToolbarItem />
      <ArrowToolbarItem />
      <NoteToolbarItem />
      <RectangleToolbarItem />
      <EllipseToolbarItem />
      <LineToolbarItem />
      <HighlightToolbarItem />
      <LaserToolbarItem />
      <FrameToolbarItem />
    </DefaultToolbar>
  );
}

const aiFrameIcon = (
  <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="3.5" y="4.5" width="17" height="15" rx="1.5" />
    <path d="M12 8.5l.9 2.1 2.1.9-2.1.9-.9 2.1-.9-2.1-2.1-.9 2.1-.9z" fill="currentColor" stroke="none" />
  </svg>
);

const annotationIcon = (
  <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M5 19c4-1 8-5 12-11" />
    <path d="M13.5 7.5H17V11" />
    <rect x="3.5" y="3.5" width="8" height="5.5" rx="1.2" />
  </svg>
);

const uiOverrides: TLUiOverrides = {
  translations: {
    en: {
      [`tool.${AI_FRAME_TOOL_ID}`]: "AI 画框",
      [`tool.${ANNOTATION_TOOL_ID}`]: "标注",
    },
    "zh-cn": {
      [`tool.${AI_FRAME_TOOL_ID}`]: "AI 画框",
      [`tool.${ANNOTATION_TOOL_ID}`]: "标注",
    },
  },
  tools(editor, tools) {
    return {
      ...tools,
      // A 让给 AI 画框，箭头保留在工具栏里点选。
      arrow: { ...tools.arrow, kbd: undefined },
      [AI_FRAME_TOOL_ID]: {
        id: AI_FRAME_TOOL_ID,
        label: `tool.${AI_FRAME_TOOL_ID}`,
        icon: aiFrameIcon,
        kbd: "a",
        onSelect() {
          const { id, size, spot } = createFrame(editor, null);
          editor.select(id);
          editor.setCurrentTool("select.idle");
          if (!spot.inViewport) editor.centerOnPoint({ x: spot.x + size.w / 2, y: spot.y + size.h / 2 });
        },
        onDragStart(_source, info) {
          onDragFromToolbarToCreateShape(editor, info, {
            createShape: (id) => {
              const size = frameSizeForRatio(ratioOptions.find((ratio) => ratio.id === DEFAULT_RATIO_ID), FRAME_LONG_EDGE);
              editor.createShape<AiFrameShape>({
                id,
                type: AI_FRAME_TYPE,
                props: { ...size, ratioId: DEFAULT_RATIO_ID, prompt: "", status: "idle", message: "", refIds: [] },
              });
            },
            onDragEnd: (id) => editor.select(id),
          });
        },
      },
      [ANNOTATION_TOOL_ID]: {
        id: ANNOTATION_TOOL_ID,
        label: `tool.${ANNOTATION_TOOL_ID}`,
        icon: annotationIcon,
        kbd: "c",
        onSelect() {
          editor.setCurrentTool(ANNOTATION_TOOL_ID);
        },
      },
    };
  },
};

/* ────────────────────────────────────────────────────────────────────────────
 * 样式面板：选中画框时换成「尺寸 / 比例 / 输出像素」
 * ──────────────────────────────────────────────────────────────────────────── */

function CanvasStylePanel(props: React.ComponentProps<typeof DefaultStylePanel>) {
  const editor = useEditor();
  const frame = useValue(
    "selected ai frame for style panel",
    () => {
      const only = editor.getOnlySelectedShape();
      return isAiFrame(only) ? only : null;
    },
    [editor],
  );
  if (!frame) return <DefaultStylePanel {...props} />;
  return (
    <div className="tlui-style-panel tlui-style-panel__wrapper canvas-frame-style" data-testid="style.panel">
      <FrameSizeControls frame={frame} />
    </div>
  );
}

function FrameSizeControls({ frame }: { frame: AiFrameShape }) {
  const editor = useEditor();
  const [widthText, setWidthText] = useState(String(Math.round(frame.props.w)));
  const [heightText, setHeightText] = useState(String(Math.round(frame.props.h)));
  useEffect(() => {
    setWidthText(String(Math.round(frame.props.w)));
    setHeightText(String(Math.round(frame.props.h)));
  }, [frame.id, frame.props.w, frame.props.h]);

  const ratio = ratioOptions.find((item) => item.id === frame.props.ratioId);
  const size = outputSizeForRatio(ratio);
  const aspect = frame.props.w / Math.max(1, frame.props.h);

  const commit = (w: number, h: number) => {
    const width = Math.round(Math.min(4096, Math.max(64, w)));
    const height = Math.round(Math.min(4096, Math.max(64, h)));
    if (!Number.isFinite(width) || !Number.isFinite(height)) return;
    editor.markHistoryStoppingPoint("resize-ai-frame");
    updateFrame(editor, frame, { w: width, h: height, ratioId: nearestRatioId(width, height, ratioOptions) });
  };

  const applyRatio = (ratioId: string) => {
    const next = ratioOptions.find((item) => item.id === ratioId);
    const longEdge = Math.max(frame.props.w, frame.props.h);
    const nextSize = frameSizeForRatio(next, longEdge);
    editor.markHistoryStoppingPoint(`ai-frame-ratio:${ratioId}`);
    updateFrame(editor, frame, { ratioId, ...nextSize });
  };

  return (
    <div className="canvas-frame-style-body" onPointerDown={stopEventPropagation}>
      <section>
        <header>尺寸</header>
        <div className="canvas-size-row">
          <label>
            <span>W</span>
            <input
              inputMode="numeric"
              aria-label="画框宽度"
              value={widthText}
              onChange={(event) => setWidthText(event.target.value)}
              onBlur={() => {
                const w = Number(widthText);
                if (w > 0) commit(w, w / aspect);
                else setWidthText(String(Math.round(frame.props.w)));
              }}
              onKeyDown={(event) => {
                event.stopPropagation();
                if (event.key === "Enter") event.currentTarget.blur();
              }}
            />
          </label>
          <span className="canvas-size-lock" title="宽高按比例联动" aria-hidden="true">
            ⟷
          </span>
          <label>
            <span>H</span>
            <input
              inputMode="numeric"
              aria-label="画框高度"
              value={heightText}
              onChange={(event) => setHeightText(event.target.value)}
              onBlur={() => {
                const h = Number(heightText);
                if (h > 0) commit(h * aspect, h);
                else setHeightText(String(Math.round(frame.props.h)));
              }}
              onKeyDown={(event) => {
                event.stopPropagation();
                if (event.key === "Enter") event.currentTarget.blur();
              }}
            />
          </label>
        </div>
      </section>
      <section>
        <header>比例</header>
        <div className="canvas-aspect-grid" role="radiogroup" aria-label="画框比例">
          {frameRatios.map((item) => {
            const iconScale = 22 / Math.max(item.width, item.height);
            return (
              <button
                type="button"
                key={item.id}
                role="radio"
                aria-checked={item.id === frame.props.ratioId}
                className="canvas-aspect-preset"
                onClick={() => applyRatio(item.id)}
              >
                <i style={{ width: Math.max(8, Math.round(item.width * iconScale)), height: Math.max(8, Math.round(item.height * iconScale)) }} />
                <span>{item.label}</span>
              </button>
            );
          })}
        </div>
      </section>
      <section>
        <header>输出像素</header>
        <p className="canvas-output-size">
          {size.auto ? "由图像接口决定" : `${size.width} × ${size.height} px`}
          {ratio && !ratio.native ? <small>接口按最近的原生尺寸交付，成片会等比放进画框</small> : null}
        </p>
      </section>
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────────────────
 * 图片工具栏：选中一张图时在 tldraw 的图片工具条上加「按标注改图」
 * ──────────────────────────────────────────────────────────────────────────── */

function CanvasImageToolbar() {
  return (
    <DefaultImageToolbar>
      <CanvasImageToolbarContent />
    </DefaultImageToolbar>
  );
}

function CanvasImageToolbarContent() {
  const editor = useEditor();
  const actions = useContext(CanvasActionsContext);
  const imageShapeId = useValue(
    "selected image id",
    () => {
      const only = editor.getOnlySelectedShape();
      return isImageShape(only) ? only.id : null;
    },
    [editor],
  );
  const isInCropTool = useValue("crop tool", () => editor.isIn("select.crop."), [editor]);
  const handleManipulatingEnd = useCallback(() => {
    editor.setCroppingShape(null);
    editor.setCurrentTool("select.idle");
  }, [editor]);
  const handleManipulatingStart = useCallback(() => editor.setCurrentTool("select.crop.idle"), [editor]);
  if (!imageShapeId) return null;
  const marks = actions ? actions.annotationCount(imageShapeId) : 0;
  return (
    <>
      <DefaultImageToolbarContent
        imageShapeId={imageShapeId}
        isManipulating={isInCropTool}
        onEditAltTextStart={() => undefined}
        onManipulatingStart={handleManipulatingStart}
        onManipulatingEnd={handleManipulatingEnd}
      />
      {!isInCropTool && actions ? (
        <TldrawUiToolbarButton
          type="icon"
          className="canvas-annotation-edit"
          title={marks ? `按标注改图 · 已找到 ${marks} 处标注` : "按标注改图 · 先用「标注」工具在图上标出要改哪里"}
          disabled={actions.busy}
          onClick={() => actions.editByAnnotation(imageShapeId)}
        >
          <TldrawUiButtonIcon icon="tool-highlight" small />
          <span className="canvas-annotation-edit-label">{actions.busy ? "生成中…" : "按标注改图"}</span>
        </TldrawUiToolbarButton>
      ) : null}
    </>
  );
}

interface CanvasActions {
  busy: boolean;
  annotationCount: (imageId: TLShapeId) => number;
  editByAnnotation: (imageId: TLShapeId) => void;
}

const CanvasActionsContext = createContext<CanvasActions | null>(null);

/* ────────────────────────────────────────────────────────────────────────────
 * 右上角：成片库 / 说明 / 清空
 * ──────────────────────────────────────────────────────────────────────────── */

function CanvasSharePanel() {
  const editor = useEditor();
  const api = useCanvasApi();
  const ui = useCanvasUi();
  const shapeCount = useValue("shape count", () => editor.getCurrentPageShapeIds().size, [editor]);
  const clearCanvas = () => {
    const ids = Array.from(editor.getCurrentPageShapeIds());
    if (!ids.length) return;
    editor.markHistoryStoppingPoint("clear-canvas");
    editor.deleteShapes(ids);
    api.onNotice("画布已清空，⌘/Ctrl + Z 可撤销。");
  };
  return (
    <div className="canvas-share-panel" onPointerDown={stopEventPropagation}>
      <button
        type="button"
        className={ui.libraryOpen ? "active" : ""}
        aria-expanded={ui.libraryOpen}
        disabled={!api.results.length}
        title={api.results.length ? "把生成过的成片放到画布上" : "还没有成片"}
        onClick={ui.toggleLibrary}
      >
        成片 {api.results.length}
      </button>
      <button type="button" disabled={!shapeCount} title="删掉画布上的全部内容（可撤销）" onClick={clearCanvas}>
        清空
      </button>
      <button
        type="button"
        className={ui.helpOpen ? "active" : ""}
        aria-label="画布用法说明"
        aria-expanded={ui.helpOpen}
        title="画布怎么用"
        onClick={ui.toggleHelp}
      >
        ?
      </button>
    </div>
  );
}

/**
 * 成片抽屉：把已经生成过的图直接放到画布上。
 * 正在编辑画框时，放上去的图同时链接为这次生成的引用图，省掉一次点选。
 */
function ResultLibrary({ onClose }: { onClose: () => void }) {
  const editor = useEditor();
  const api = useCanvasApi();
  const [placingId, setPlacingId] = useState("");

  const place = async (result: GeneratedResult) => {
    if (placingId) return;
    setPlacingId(result.id);
    try {
      const frame = editor.getOnlySelectedShape();
      if (isAiFrame(frame)) {
        const shapeId = await placeRefBesideFrame(editor, frame, { url: result.imageUrl, name: result.title });
        linkRefs(editor, frame.id, [shapeId]);
        editor.select(frame.id);
      } else {
        const shapeId = await placeImage(editor, { url: result.imageUrl, name: result.title, resultId: result.id }, null);
        const box = editor.getShapePageBounds(shapeId);
        if (box) editor.centerOnPoint(box.center);
        editor.select(shapeId);
      }
    } catch (error) {
      api.onNotice(error instanceof Error ? error.message : "放到画布失败");
    } finally {
      setPlacingId("");
    }
  };

  return (
    <div className="canvas-library" onPointerDown={stopEventPropagation} onWheel={stopEventPropagation}>
      <header>
        <strong>成片</strong>
        <small>点一下放到画布 · 选中画框时会直接成为引用图</small>
        <button type="button" className="icon-button" aria-label="关闭成片列表" onClick={onClose}>
          ×
        </button>
      </header>
      <div className="canvas-library-grid">
        {api.results.map((result) => (
          <button
            type="button"
            key={result.id}
            className="canvas-library-item"
            disabled={Boolean(placingId)}
            title={`${result.title} · ${result.ratioLabel}`}
            onClick={() => void place(result)}
          >
            <img src={result.imageUrl} alt={result.title} loading="lazy" />
            {isPlaceholderImage(result.imageUrl) ? <em className="placeholder-tag">演示</em> : null}
            <span>{placingId === result.id ? "放入中…" : result.title}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

/** 用法说明。空画布自动显示，其余时候从右上「?」调出。 */
function CanvasGuide({ onClose }: { onClose?: () => void }) {
  return (
    <div className={onClose ? "canvas-guide canvas-guide-pinned" : "canvas-guide"} onPointerDown={stopEventPropagation}>
      <header>
        <strong>画布怎么用</strong>
        {onClose ? (
          <button type="button" className="icon-button" aria-label="关闭说明" onClick={onClose}>
            ×
          </button>
        ) : null}
      </header>
      <ol>
        <li>
          <em>要新图</em>按 <kbd>A</kbd> 或点工具栏的「AI 画框」放一个框，在下方写描述 → 生成，成片原地替换画框。
        </li>
        <li>
          <em>给参考</em>选中画框，在面板里上传 / 粘贴图片，或从画布、成片库里挑；右侧面板可改比例和尺寸。
        </li>
        <li>
          <em>改图</em>按 <kbd>C</kbd> 用「标注」在图上拉箭头写要改什么 → 选中这张图 → 「按标注改图」，新图出现在右边。
        </li>
        <li>
          <em>画草图</em>用画笔勾构图再框选 → 「按草图生成」。
        </li>
      </ol>
      <small>滚轮平移 · ⌘/Ctrl + 滚轮缩放 · ⌘/Ctrl + Z 撤销 · Delete 删除</small>
    </div>
  );
}

function EmptyCanvasGuide() {
  const editor = useEditor();
  const empty = useValue("canvas is empty", () => editor.getCurrentPageShapeIds().size === 0, [editor]);
  return empty ? <CanvasGuide /> : null;
}

/* ────────────────────────────────────────────────────────────────────────────
 * 画布上方浮层：画框生成面板 / 草图生成条 / 成片库 / 说明
 * ──────────────────────────────────────────────────────────────────────────── */

interface FramePanelRef {
  id: TLShapeId;
  name: string;
  src: string;
  usage: AttachmentUsage;
}

function CanvasOverlay({
  pendingImages,
  onPendingConsumed,
  onActions,
}: {
  pendingImages: PendingCanvasImage[];
  onPendingConsumed: (ids: string[]) => void;
  onActions: (actions: CanvasActions) => void;
}) {
  const editor = useEditor();
  const api = useCanvasApi();
  const ui = useCanvasUi();
  const [busyFrameIds, setBusyFrameIds] = useState<TLShapeId[]>([]);
  const [contentBusy, setContentBusy] = useState(false);
  const consumedRef = useRef(new Set<string>());

  // 简易模式点「放到画布」时画布还没挂载，落在这里补插。
  useEffect(() => {
    const fresh = pendingImages.filter((item) => !consumedRef.current.has(item.id));
    if (!fresh.length) return;
    fresh.forEach((item) => consumedRef.current.add(item.id));
    void (async () => {
      const ids: TLShapeId[] = [];
      for (const item of fresh) {
        ids.push(await placeImage(editor, { url: item.url, name: item.name }, null));
      }
      if (ids.length) {
        editor.select(...ids);
        editor.zoomToSelection();
      }
      onPendingConsumed(fresh.map((item) => item.id));
    })();
  }, [editor, onPendingConsumed, pendingImages]);

  const selection = useValue(
    "free-canvas-selection",
    () => {
      // 读一下相机和视口，镜头一动面板就跟着重新定位。
      editor.getCamera();
      const viewport = editor.getViewportScreenBounds();
      const shapes = editor.getSelectedShapes();
      const only = shapes.length === 1 ? shapes[0] : null;
      const frame = isAiFrame(only) ? only : null;
      const frameBox = frame ? editor.getShapePageBounds(frame.id) : null;

      const refs: FramePanelRef[] = frame
        ? frameRefIds(frame)
            .map((id) => editor.getShape(id))
            .filter((shape): shape is TLImageShape => isImageShape(shape))
            .map((shape) => ({
              id: shape.id,
              name: String(shape.meta?.aiName ?? "画布图片"),
              src: imageShapeSource(editor, shape),
              usage: shapeUsage(shape),
            }))
        : [];
      const linked = new Set(refs.map((ref) => ref.id));
      const available = frame
        ? editor
            .getCurrentPageShapes()
            .filter((shape): shape is TLImageShape => isImageShape(shape) && !linked.has(shape.id))
            .map((shape) => ({ id: shape.id, src: imageShapeSource(editor, shape) }))
            .filter((image) => image.src)
        : [];

      // 没选画框、没选图，但选了画笔/几何图形 —— 这是草图。
      const sketchIds =
        !frame && shapes.length && shapes.every((shape) => isMarkShape(shape) && !isAiFrame(shape)) && shapes.some((shape) => ["draw", "geo", "line", "highlight"].includes(shape.type))
          ? shapes.map((shape) => shape.id)
          : [];
      const sketchBounds = sketchIds.length ? editor.getSelectionPageBounds() : null;

      return {
        viewport: { width: viewport.width, height: viewport.height },
        frame,
        frameRect: frameBox ? viewportRect(editor, frameBox) : null,
        refs,
        available,
        sketchIds,
        sketchRect: sketchBounds ? viewportRect(editor, sketchBounds) : null,
      };
    },
    [editor],
  );

  const setUsage = (id: TLShapeId, usage: AttachmentUsage) => {
    const shape = editor.getShape(id);
    if (!shape) return;
    editor.updateShape({ id, type: shape.type, meta: { ...shape.meta, aiUsage: usage } });
  };

  const generateFrame = async (frame: AiFrameShape) => {
    if (busyFrameIds.includes(frame.id)) return;
    const attachments: FreeAttachment[] = frameRefIds(frame)
      .map((id) => editor.getShape(id))
      .filter((shape): shape is TLImageShape => isImageShape(shape))
      .map((shape) => ({
        id: shape.id,
        name: String(shape.meta?.aiName ?? "画布图片"),
        previewUrl: imageShapeSource(editor, shape),
        usage: shapeUsage(shape),
      }))
      .filter((item) => item.previewUrl);

    setBusyFrameIds((current) => [...current, frame.id]);
    updateFrame(editor, frame, { status: "running", message: "" });
    try {
      const results = await api.onGenerate({ prompt: frame.props.prompt, attachments, ratioId: frame.props.ratioId, intent: "free" });
      const [first] = results;
      if (!first) throw new Error("图像引擎没有返回结果");
      const box = editor.getShapePageBounds(frame.id);
      // 原地替换：位置和尺寸沿用画框，这是「画框即契约」的关键一步。
      const shapeId = await placeImage(
        editor,
        { url: first.imageUrl, name: first.title, resultId: first.id },
        box ? { x: box.minX, y: box.minY, w: box.width, h: box.height } : null,
      );
      editor.deleteShape(frame.id);
      editor.select(shapeId);
    } catch (error) {
      const message = error instanceof Error ? error.message : "生成失败";
      const latest = editor.getShape<AiFrameShape>(frame.id);
      if (latest) updateFrame(editor, latest, { status: "failed", message });
      api.onNotice(message);
    } finally {
      setBusyFrameIds((current) => current.filter((id) => id !== frame.id));
    }
  };

  /** 把一组形状导出成一张图交给图像引擎，结果放在右边。批注是修改需求书，草图是构图需求书。 */
  const generateFromShapes = useCallback(
    async (ids: TLShapeId[], intent: "annotation" | "sketch", note: string) => {
      if (contentBusy || !ids.length) return;
      const box = Box.Common(ids.map((id) => editor.getShapePageBounds(id)).filter((bounds): bounds is Box => Boolean(bounds)));
      const anchor = intent === "annotation" ? editor.getShapePageBounds(ids[0]) ?? box : box;
      const targetBox = { x: box.maxX + RESULT_GAP, y: anchor.minY, w: anchor.width, h: anchor.height };
      const ratioId = nearestRatioId(anchor.width, anchor.height, ratioOptions);
      const pendingId = createShapeId();
      editor.createShape<AiFrameShape>({
        id: pendingId,
        type: AI_FRAME_TYPE,
        x: targetBox.x,
        y: targetBox.y,
        props: {
          w: targetBox.w,
          h: targetBox.h,
          ratioId,
          prompt: note.trim() || (intent === "annotation" ? "按标注改图" : "按草图生成"),
          status: "running",
          message: "",
          refIds: [],
        },
      });
      const together = Box.Common([box, new Box(targetBox.x, targetBox.y, targetBox.w, targetBox.h)]);
      if (!editor.getViewportPageBounds().contains(together)) {
        editor.zoomToBounds(together, { inset: 56, animation: { duration: 220 } });
      }

      setContentBusy(true);
      try {
        const pixelRatio = Math.max(2, EXPORT_MIN_EDGE / Math.max(1, Math.min(box.width, box.height)));
        const exported = await editor.toImageDataUrl(ids, { format: "png", background: true, darkMode: false, padding: 8, pixelRatio });
        const results = await api.onGenerate({
          prompt: note,
          attachments: [
            { id: `canvas-${ids[0]}`, name: intent === "annotation" ? "annotated.png" : "sketch.png", previewUrl: exported.url, usage: "merge" },
          ],
          ratioId,
          intent,
        });
        const [first] = results;
        if (!first) throw new Error("图像引擎没有返回结果");
        // 原内容一概不动，成片原地替换掉「生成中」画框，天然形成前后对比。
        const shapeId = await placeImage(editor, { url: first.imageUrl, name: first.title, resultId: first.id }, targetBox);
        editor.deleteShape(pendingId);
        editor.select(shapeId);
      } catch (error) {
        const message = error instanceof Error ? error.message : "按画布内容生成失败";
        const pending = editor.getShape<AiFrameShape>(pendingId);
        if (pending) updateFrame(editor, pending, { status: "failed", message });
        api.onNotice(message);
      } finally {
        setContentBusy(false);
      }
    },
    [api, contentBusy, editor],
  );

  // 图片工具栏上的「按标注改图」通过 context 调回来。
  useEffect(() => {
    onActions({
      busy: contentBusy,
      annotationCount: (imageId) => collectAnnotationShapeIds(editor, imageId).length - 1,
      editByAnnotation: (imageId) => {
        const ids = collectAnnotationShapeIds(editor, imageId);
        if (ids.length < 2) {
          api.onNotice("这张图上还没有标注：按 C 用「标注」工具在图上拉箭头写要改什么。");
          return;
        }
        void generateFromShapes(ids, "annotation", "");
      },
    });
  }, [api, contentBusy, editor, generateFromShapes, onActions]);

  return (
    <>
      {selection.frame && selection.frameRect ? (
        <FramePanel
          key={selection.frame.id}
          frame={selection.frame}
          refs={selection.refs}
          available={selection.available}
          rect={selection.frameRect}
          viewport={selection.viewport}
          busy={busyFrameIds.includes(selection.frame.id)}
          cost={api.costFor(selection.refs.filter((ref) => ref.src).length)}
          credits={api.credits}
          results={api.results}
          onPromptChange={(prompt) => updateFrame(editor, selection.frame!, { prompt, status: "idle", message: "" })}
          onUsageChange={setUsage}
          onUnlink={(id) => unlinkRef(editor, selection.frame!.id, id)}
          onLink={(ids) => linkRefs(editor, selection.frame!.id, ids)}
          onUpload={async (files) => {
            const frame = selection.frame!;
            const ids: TLShapeId[] = [];
            for (const file of files) {
              try {
                const url = await readFileAsDataUrl(file);
                const latest = editor.getShape<AiFrameShape>(frame.id) ?? frame;
                ids.push(await placeRefBesideFrame(editor, latest, { url, name: file.name }));
                if (ids.length) linkRefs(editor, frame.id, ids.slice(-1));
              } catch (error) {
                api.onNotice(error instanceof Error ? error.message : `${file.name} 读取失败`);
              }
            }
            editor.select(frame.id);
          }}
          onGenerate={() => void generateFrame(selection.frame!)}
        />
      ) : null}

      {selection.sketchRect && selection.sketchIds.length ? (
        <SketchActions
          rect={selection.sketchRect}
          viewport={selection.viewport}
          count={selection.sketchIds.length}
          busy={contentBusy}
          cost={api.costFor(1)}
          credits={api.credits}
          onGenerate={(note) => void generateFromShapes(selection.sketchIds, "sketch", note)}
        />
      ) : null}

      {ui.libraryOpen ? <ResultLibrary onClose={ui.closeLibrary} /> : null}
      {ui.helpOpen ? <CanvasGuide onClose={ui.closeHelp} /> : null}
      <EmptyCanvasGuide />
    </>
  );
}

/** 贴在草图选区下方的小条：按草图生成。 */
function SketchActions({
  rect,
  viewport,
  count,
  busy,
  cost,
  credits,
  onGenerate,
}: {
  rect: { left: number; top: number; right: number; bottom: number };
  viewport: { width: number; height: number };
  count: number;
  busy: boolean;
  cost: number;
  credits: number;
  onGenerate: (note: string) => void;
}) {
  const [note, setNote] = useState("");
  const enough = cost <= credits;
  const width = 400;
  const left = Math.max(PANEL_MARGIN, Math.min((rect.left + rect.right) / 2 - width / 2, viewport.width - width - PANEL_MARGIN));
  const top = Math.min(rect.bottom + 10, Math.max(PANEL_MARGIN, viewport.height - 50 - PANEL_BOTTOM_RESERVE));
  return (
    <section
      className="canvas-sketch-actions"
      style={{ left, top, width }}
      aria-label="按草图生成"
      onPointerDown={stopEventPropagation}
      onWheel={stopEventPropagation}
    >
      <input
        type="text"
        aria-label="补充说明"
        placeholder={`已选 ${count} 个笔画 · 可选：再补一句想要的风格`}
        value={note}
        onChange={(event) => setNote(event.target.value)}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === "Enter" && !busy && enough) onGenerate(note);
        }}
      />
      <button type="button" className="canvas-send" disabled={busy || !enough} onClick={() => onGenerate(note)}>
        {busy ? "生成中…" : `按草图生成 · ${cost} 分`}
      </button>
    </section>
  );
}

interface FramePanelProps {
  frame: AiFrameShape;
  refs: FramePanelRef[];
  available: Array<{ id: TLShapeId; src: string }>;
  rect: { left: number; top: number; right: number; bottom: number };
  viewport: { width: number; height: number };
  busy: boolean;
  cost: number;
  credits: number;
  results: GeneratedResult[];
  onPromptChange: (value: string) => void;
  onUsageChange: (id: TLShapeId, usage: AttachmentUsage) => void;
  onUnlink: (id: TLShapeId) => void;
  onLink: (ids: TLShapeId[]) => void;
  onUpload: (files: File[]) => Promise<void>;
  onGenerate: () => void;
}

/**
 * 贴在画框正下方、居中对齐的生成面板（Cowart 的布局）：
 * 参考图一排 → 描述框 → 生成。放不下时贴着视口底边，不翻到画框上面去挡住画框。
 */
function FramePanel({
  frame,
  refs,
  available,
  rect,
  viewport,
  busy,
  cost,
  credits,
  results,
  onPromptChange,
  onUsageChange,
  onUnlink,
  onLink,
  onUpload,
  onGenerate,
}: FramePanelProps) {
  const editor = useEditor();
  const panelRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const [height, setHeight] = useState(200);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [uploading, setUploading] = useState(false);

  useEffect(() => {
    const element = panelRef.current;
    if (!element) return;
    const measure = () => setHeight(element.offsetHeight);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  // 刚放下画框就能直接打字。
  useEffect(() => {
    if (frame.props.status === "idle" && !frame.props.prompt) textareaRef.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [frame.id]);

  const frameWidth = rect.right - rect.left;
  const width = Math.min(PANEL_MAX_W, Math.max(PANEL_MIN_W, frameWidth), viewport.width - PANEL_MARGIN * 2);
  const left = Math.max(PANEL_MARGIN, Math.min(rect.left + frameWidth / 2 - width / 2, viewport.width - width - PANEL_MARGIN));
  const top = Math.max(PANEL_MARGIN, Math.min(rect.bottom + PANEL_OFFSET, viewport.height - height - PANEL_BOTTOM_RESERVE));

  const enough = cost <= credits;
  const canGenerate = frame.props.prompt.trim().length > 0 && enough && !busy;
  const ratio = ratioOptions.find((item) => item.id === frame.props.ratioId);
  const size = outputSizeForRatio(ratio);

  const upload = async (files: File[]) => {
    const images = files.filter((file) => file.type.startsWith("image/"));
    if (!images.length) return;
    setUploading(true);
    try {
      await onUpload(images);
    } finally {
      setUploading(false);
    }
  };

  return (
    <section
      className="canvas-frame-panel"
      ref={panelRef}
      style={{ left, top, width }}
      aria-label="画框生成设置"
      onPointerDown={stopEventPropagation}
      onWheel={stopEventPropagation}
      onKeyDown={(event) => event.stopPropagation()}
    >
      <div className="canvas-ref-strip">
        {refs.map((ref) => (
          <figure className={`canvas-ref-card canvas-ref-${ref.usage}`} key={ref.id}>
            {ref.src ? <img src={ref.src} alt={ref.name} /> : <span className="canvas-ref-missing">无源图</span>}
            <div className="canvas-ref-usage" role="radiogroup" aria-label={`${ref.name} 的用途`}>
              {(Object.keys(attachmentUsageLabels) as AttachmentUsage[]).map((usage) => (
                <button
                  type="button"
                  key={usage}
                  role="radio"
                  aria-checked={ref.usage === usage}
                  className={ref.usage === usage ? "active" : ""}
                  title={attachmentUsageHints[usage]}
                  onClick={() => onUsageChange(ref.id, usage)}
                >
                  {attachmentUsageLabels[usage]}
                </button>
              ))}
            </div>
            <button type="button" className="canvas-ref-remove" aria-label={`取消引用 ${ref.name}`} onClick={() => onUnlink(ref.id)}>
              ×
            </button>
          </figure>
        ))}
        <div className="canvas-ref-add-wrap">
          <button
            type="button"
            className={pickerOpen ? "canvas-ref-add active" : "canvas-ref-add"}
            aria-expanded={pickerOpen}
            title="上传、粘贴，或从画布 / 成片里挑参考图"
            onClick={() => setPickerOpen((open) => !open)}
          >
            <em aria-hidden="true">{uploading ? "…" : "+"}</em>
            <span>参考图</span>
          </button>
        </div>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          multiple
          className="sr-only"
          aria-label="上传参考图"
          onChange={(event) => {
            void upload(Array.from(event.target.files ?? []));
            event.target.value = "";
            setPickerOpen(false);
          }}
        />
      </div>

      {pickerOpen ? (
        <div className="canvas-ref-picker" role="dialog" aria-label="选择参考图">
          <div className="canvas-ref-picker-actions">
            <button type="button" onClick={() => fileInputRef.current?.click()}>
              上传图片
            </button>
            <small>也可以直接把图粘贴到描述框里</small>
          </div>
          {available.length ? (
            <div className="canvas-ref-picker-group">
              <span>画布上的图</span>
              <div className="canvas-picker-list">
                {available.map((image) => (
                  <button
                    type="button"
                    key={image.id}
                    className="canvas-picker-thumb"
                    title="加为引用图"
                    onClick={() => {
                      onLink([image.id]);
                    }}
                  >
                    <img src={image.src} alt="" />
                  </button>
                ))}
              </div>
            </div>
          ) : null}
          {results.length ? (
            <div className="canvas-ref-picker-group">
              <span>成片</span>
              <div className="canvas-picker-list">
                {results.slice(0, 24).map((result) => (
                  <button
                    type="button"
                    key={result.id}
                    className="canvas-picker-thumb"
                    title={result.title}
                    onClick={async () => {
                      const latest = editor.getShape<AiFrameShape>(frame.id) ?? frame;
                      const shapeId = await placeRefBesideFrame(editor, latest, { url: result.imageUrl, name: result.title });
                      onLink([shapeId]);
                      editor.select(frame.id);
                    }}
                  >
                    <img src={result.imageUrl} alt="" />
                  </button>
                ))}
              </div>
            </div>
          ) : null}
        </div>
      ) : null}

      <textarea
        ref={textareaRef}
        aria-label="画框描述"
        rows={3}
        value={frame.props.prompt}
        placeholder="描述你想生成的图片，⌘ / Ctrl + Enter 直接生成"
        onChange={(event) => onPromptChange(event.target.value)}
        onPaste={(event) => {
          const files = clipboardImageFiles(event);
          if (!files.length) return;
          event.preventDefault();
          void upload(files);
        }}
        onKeyDown={(event) => {
          event.stopPropagation();
          if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
            event.preventDefault();
            if (canGenerate) onGenerate();
          }
        }}
      />

      <footer>
        <small className="canvas-frame-meta">
          {ratio?.label ?? "1:1"} · {size.auto ? "尺寸由接口决定" : `${size.width}×${size.height}`}
          {refs.length ? ` · ${refs.length} 张引用图` : ""}
          {!enough ? <b> · 积分不足，需要 {cost} 分</b> : null}
        </small>
        <button type="button" className="canvas-send" disabled={!canGenerate} onClick={onGenerate}>
          {busy ? "生成中…" : `生成 · ${cost} 分`}
        </button>
      </footer>
      {frame.props.status === "failed" && frame.props.message ? <small className="canvas-frame-warning">{frame.props.message}</small> : null}
    </section>
  );
}

/* ────────────────────────────────────────────────────────────────────────────
 * 画布外壳
 * ──────────────────────────────────────────────────────────────────────────── */

const shapeUtils = [AiFrameShapeUtil];
const tools = [AnnotationTool];

/* ────────────────────────────────────────────────────────────────────────────
 * 空白自检
 *
 * 有过「画布开着开着整片变白」的反馈：外壳还在、DOM 结构看不出问题，就是画不出来。
 * 复现不了的东西也得能自己爬起来，所以这里每 5 秒量一次 tldraw 容器：
 * 连着两次量不到（没有容器 / 尺寸为 0 / 工具栏没了）就重挂一次编辑器，
 * 画布内容存在 IndexedDB 里，重挂不会丢。重挂两次还是白的就不再折腾，
 * 显示一条提示让用户刷新，同时把现场尺寸发回服务端，好定位真正的原因。
 * ──────────────────────────────────────────────────────────────────────────── */

const WATCHDOG_INTERVAL_MS = 5000;
const WATCHDOG_STRIKES = 2;
const WATCHDOG_MAX_REMOUNTS = 2;
// 重挂之后编辑器要重新从 IndexedDB 读一遍，这段时间不算它空白。
const WATCHDOG_GRACE_MS = 8000;

function useCanvasWatchdog(shellRef: React.RefObject<HTMLDivElement | null>, onRemount: () => void) {
  const [gaveUp, setGaveUp] = useState(false);
  const stateRef = useRef({ strikes: 0, remounts: 0, healthySeen: false, graceUntil: 0, gaveUp: false });

  // 编辑器 onMount 一响就说明画布真的起来过了；之后再量不到就是变白，不是还在加载。
  const markReady = useCallback(() => {
    stateRef.current.healthySeen = true;
    stateRef.current.strikes = 0;
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => {
      const state = stateRef.current;
      if (state.gaveUp || Date.now() < state.graceUntil) return;
      const shell = shellRef.current;
      if (!shell) return;

      const container = shell.querySelector(".tl-container");
      const rect = container?.getBoundingClientRect();
      const toolbar = Boolean(shell.querySelector(".tlui-toolbar"));
      const healthy = Boolean(container && rect && rect.width > 2 && rect.height > 2 && toolbar);

      if (healthy) {
        state.healthySeen = true;
        state.strikes = 0;
        return;
      }
      // 还没成功起来过就先别管，那是加载中，不是变白。
      if (!state.healthySeen) return;

      state.strikes += 1;
      if (state.strikes < WATCHDOG_STRIKES) return;
      state.strikes = 0;

      const shellRect = shell.getBoundingClientRect();
      const detail = {
        hasContainer: Boolean(container),
        containerW: Math.round(rect?.width ?? -1),
        containerH: Math.round(rect?.height ?? -1),
        shellW: Math.round(shellRect.width),
        shellH: Math.round(shellRect.height),
        toolbar,
        hidden: document.hidden,
        remounts: state.remounts,
        viewport: `${window.innerWidth}x${window.innerHeight}`,
      };

      if (state.remounts >= WATCHDOG_MAX_REMOUNTS) {
        state.gaveUp = true;
        setGaveUp(true);
        reportClientError({ scope: "canvas-blank-giveup", message: "画布重挂两次仍然是空白", detail });
        return;
      }

      state.remounts += 1;
      state.graceUntil = Date.now() + WATCHDOG_GRACE_MS;
      reportClientError({ scope: "canvas-blank", message: "画布空白，自动重挂编辑器", detail });
      onRemount();
    }, WATCHDOG_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [onRemount, shellRef]);

  return { gaveUp, markReady };
}

interface CanvasBoardProps {
  costFor: (referenceCount: number) => number;
  credits: number;
  results: GeneratedResult[];
  pendingImages: PendingCanvasImage[];
  onGenerate: (input: CanvasGenerateInput) => Promise<GeneratedResult[]>;
  onPendingConsumed: (ids: string[]) => void;
  onNotice: (message: string) => void;
}

export function CanvasBoard({ costFor, credits, results, pendingImages, onGenerate, onPendingConsumed, onNotice }: CanvasBoardProps) {
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [actions, setActions] = useState<CanvasActions | null>(null);
  const ui = useMemo<CanvasUi>(
    () => ({
      libraryOpen,
      helpOpen,
      toggleLibrary: () => {
        setLibraryOpen((open) => !open);
        setHelpOpen(false);
      },
      toggleHelp: () => {
        setHelpOpen((open) => !open);
        setLibraryOpen(false);
      },
      closeLibrary: () => setLibraryOpen(false),
      closeHelp: () => setHelpOpen(false),
    }),
    [helpOpen, libraryOpen],
  );
  const [api, setApi] = useState<CanvasApi>(() => ({ costFor, credits, results, onGenerate, onNotice }));
  useEffect(() => setApi({ costFor, credits, results, onGenerate, onNotice }), [costFor, credits, results, onGenerate, onNotice]);

  const components = useMemo<TLComponents>(
    () => ({
      Toolbar: CanvasToolbar,
      StylePanel: CanvasStylePanel,
      ImageToolbar: CanvasImageToolbar,
      SharePanel: CanvasSharePanel,
      InFrontOfTheCanvas: () => (
        <CanvasOverlay pendingImages={pendingImages} onPendingConsumed={onPendingConsumed} onActions={setActions} />
      ),
    }),
    [onPendingConsumed, pendingImages],
  );

  const shellRef = useRef<HTMLDivElement | null>(null);
  const [mountKey, setMountKey] = useState(0);
  const remount = useCallback(() => setMountKey((key) => key + 1), []);
  const { gaveUp: blanked, markReady } = useCanvasWatchdog(shellRef, remount);

  // 画布是独立的合成层。标签页在后台待久了再切回来，Chromium 偶尔会漏掉这一层的重绘 ——
  // 看着就是画布一片空白，DOM 其实一点没坏。回到前台时轻推一下，逼它重画。
  useEffect(() => {
    const repaint = () => {
      if (document.hidden) return;
      const container = shellRef.current?.querySelector<HTMLElement>(".tl-container");
      if (!container) return;
      container.style.opacity = "0.999";
      window.requestAnimationFrame(() => {
        container.style.opacity = "";
      });
    };
    document.addEventListener("visibilitychange", repaint);
    window.addEventListener("pageshow", repaint);
    window.addEventListener("focus", repaint);
    return () => {
      document.removeEventListener("visibilitychange", repaint);
      window.removeEventListener("pageshow", repaint);
      window.removeEventListener("focus", repaint);
    };
  }, []);

  const handleMount = useCallback(
    (editor: Editor) => {
      // 之前的版本把画布锁成深色，用户偏好会一直留着；这里明确回到浅色，和整个工作台一致。
      editor.user.updateUserPreferences({ colorScheme: "light" });
      markReady();
    },
    [markReady],
  );

  return (
    <CanvasApiContext.Provider value={api}>
      <CanvasUiContext.Provider value={ui}>
        <CanvasActionsContext.Provider value={actions}>
          <div className="canvas-shell" ref={shellRef}>
            <Tldraw
              key={mountKey}
              persistenceKey={PERSISTENCE_KEY}
              assetUrls={assetUrls}
              shapeUtils={shapeUtils}
              tools={tools}
              overrides={uiOverrides}
              components={components}
              onMount={handleMount}
            />
            {blanked ? (
              <div className="canvas-blank-notice" role="alert">
                <strong>画布显示不出来了</strong>
                <span>已经试着重新加载过，还是空白。刷新页面通常能恢复，画布上的内容不会丢。</span>
                <button type="button" className="btn btn-primary" onClick={() => window.location.reload()}>
                  刷新页面
                </button>
              </div>
            ) : null}
          </div>
        </CanvasActionsContext.Provider>
      </CanvasUiContext.Provider>
    </CanvasApiContext.Provider>
  );
}
