import { useEffect, useRef, useState, type DragEvent, type PointerEvent as ReactPointerEvent } from "react";
import { imageQualityLabel, imageQualitySummary } from "../lib/imageQuality";
import { isPlaceholderImage } from "../lib/providerMode";
import { resultFileName } from "../lib/resultFiles";
import type { GeneratedResult, ReferenceImage, StorageStatus } from "../types";

/** 过期成片文件已经不在服务器上了，再拿去当参考只会让下一次生成报「参考图读不到」。 */
const EXPIRED_REFERENCE_HINT = "这张成片已在服务器上清理，文件不在了，不能再加入参考。";

const storageStatusLabels: Record<StorageStatus, string> = {
  "local-cache": "服务器暂存",
  "cloud-temp": "服务器暂存",
  webdav: "已推云盘",
  expired: "服务器已清理",
};

interface Annotation {
  id: string;
  left: number;
  top: number;
  text: string;
}

interface ResultStageProps {
  results: GeneratedResult[];
  selectedId: string;
  onSelect: (id: string) => void;
  isGenerating?: boolean;
  /** 前后对比里的「原图」，通常是第一张参考素材。 */
  beforeUrl?: string;
  onDelete: (id: string) => void;
  onDropFiles: (files: FileList) => void;
  onUseAsReference: (result: GeneratedResult) => void;
  onReusePrompt: (prompt: string) => void;
}

/** 创作台中央的深色画布：成片展示、前后对比、放大、标注与拖拽投放。 */
export function ResultStage({
  results,
  selectedId,
  onSelect,
  isGenerating = false,
  beforeUrl,
  onDelete,
  onDropFiles,
  onUseAsReference,
  onReusePrompt,
}: ResultStageProps) {
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const [dropActive, setDropActive] = useState(false);
  const [zoomOpen, setZoomOpen] = useState(false);
  const [compareOn, setCompareOn] = useState(false);
  const [comparePos, setComparePos] = useState(50);
  const [annotateMode, setAnnotateMode] = useState(false);
  const [promptOpen, setPromptOpen] = useState(false);
  const [annotations, setAnnotations] = useState<Record<string, Annotation[]>>({});

  const selected = results.find((result) => result.id === selectedId) ?? results[0];
  const pins = selected ? annotations[selected.id] ?? [] : [];

  useEffect(() => {
    if (!zoomOpen) return;
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setZoomOpen(false);
    };
    document.addEventListener("keydown", handleEscape);
    return () => document.removeEventListener("keydown", handleEscape);
  }, [zoomOpen]);

  useEffect(() => {
    setCompareOn(false);
    setPromptOpen(false);
  }, [selectedId]);

  const patchPins = (next: Annotation[]) => {
    if (!selected) return;
    setAnnotations((current) => ({ ...current, [selected.id]: next }));
  };

  const canvasPoint = (clientX: number, clientY: number) => {
    const box = canvasRef.current?.getBoundingClientRect();
    if (!box) return { left: 50, top: 50 };
    return {
      left: Math.min(96, Math.max(4, ((clientX - box.left) / box.width) * 100)),
      top: Math.min(96, Math.max(8, ((clientY - box.top) / box.height) * 100)),
    };
  };

  const handleCanvasClick = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!annotateMode || !selected) return;
    if ((event.target as HTMLElement).closest("input,button,a,select,figure")) return;
    const point = canvasPoint(event.clientX, event.clientY);
    patchPins([...pins, { id: `pin-${Date.now()}`, ...point, text: "" }]);
  };

  const startPinDrag = (id: string, event: ReactPointerEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    const move = (moveEvent: PointerEvent) => {
      const point = canvasPoint(moveEvent.clientX, moveEvent.clientY);
      setAnnotations((current) => {
        if (!selected) return current;
        const list = (current[selected.id] ?? []).map((pin) => (pin.id === id ? { ...pin, ...point } : pin));
        return { ...current, [selected.id]: list };
      });
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const startCompare = (event: ReactPointerEvent<HTMLDivElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    const move = (moveEvent: PointerEvent | ReactPointerEvent<HTMLDivElement>) => {
      setComparePos(Math.min(98, Math.max(2, ((moveEvent.clientX - box.left) / box.width) * 100)));
    };
    move(event);
    const up = () => {
      window.removeEventListener("pointermove", move as (event: PointerEvent) => void);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move as (event: PointerEvent) => void);
    window.addEventListener("pointerup", up);
  };

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDropActive(false);
    if (event.dataTransfer.files?.length) onDropFiles(event.dataTransfer.files);
  };

  const annotateHint = !selected
    ? "生成成片后可标注"
    : annotateMode
      ? "点击画面添加标注"
      : pins.length
        ? `${pins.length} 条标注`
        : "点「标注」后在成片上批注";

  return (
    <div className="studio-stage">
      <div
        className={`stage-canvas ${dropActive ? "drop-active" : ""} ${annotateMode && selected ? "annotating" : ""}`}
        ref={canvasRef}
        onClick={handleCanvasClick}
        onDragOver={(event) => {
          event.preventDefault();
          if (!dropActive) setDropActive(true);
        }}
        onDragLeave={() => setDropActive(false)}
        onDrop={handleDrop}
      >
        <div className="stage-toolbar">
          <div className="stage-toolbar-left">
            <button
              type="button"
              className={`stage-tool ${annotateMode ? "active" : ""}`}
              disabled={!selected}
              onClick={() => {
                setAnnotateMode((value) => !value);
                setCompareOn(false);
              }}
            >
              标注
            </button>
            <span className="stage-toolbar-hint">{annotateHint}</span>
          </div>
          <div className="stage-toolbar-right">
            <button
              type="button"
              className="stage-tool stage-tool-primary"
              disabled={!selected || selected.storageStatus === "expired"}
              title={selected?.storageStatus === "expired" ? EXPIRED_REFERENCE_HINT : "把这张成片放进左栏参考素材，接着往下改"}
              onClick={() => selected && onUseAsReference(selected)}
            >
              加入参考
            </button>
            <button
              type="button"
              className={`stage-tool ${promptOpen ? "active" : ""}`}
              disabled={!selected?.prompt}
              title={selected?.prompt ? "看看这张是用什么描述出来的" : "这张成片没有记录描述"}
              onClick={() => setPromptOpen((value) => !value)}
            >
              提示词
            </button>
            <button
              type="button"
              className={`stage-tool ${compareOn ? "active" : ""}`}
              disabled={!selected || !beforeUrl}
              onClick={() => {
                setCompareOn((value) => !value);
                setAnnotateMode(false);
              }}
            >
              前后对比
            </button>
            <button type="button" className="stage-tool" disabled={!selected} onClick={() => setZoomOpen(true)}>
              放大
            </button>
            {selected ? (
              <a className="stage-tool" href={selected.imageUrl} download={resultFileName(selected)}>下载</a>
            ) : (
              <span className="stage-tool disabled">下载</span>
            )}
            <button type="button" className="stage-tool" disabled={!selected} onClick={() => selected && onDelete(selected.id)}>
              删除
            </button>
          </div>
        </div>

        {promptOpen && selected?.prompt ? (
          <div className="stage-prompt" role="dialog" aria-label="这张成片的描述">
            <header>
              <span className="rail-kicker">当时的描述</span>
              <button type="button" onClick={() => setPromptOpen(false)} aria-label="关闭描述">
                ×
              </button>
            </header>
            <p>{selected.prompt}</p>
            <div className="stage-prompt-actions">
              <button
                type="button"
                className="text-button"
                onClick={() => {
                  onReusePrompt(selected.prompt ?? "");
                  setPromptOpen(false);
                }}
              >
                用这段重做
              </button>
              <button
                type="button"
                className="text-button"
                onClick={() => navigator.clipboard?.writeText(selected.prompt ?? "")}
              >
                复制
              </button>
            </div>
          </div>
        ) : null}

        {selected ? (
          <figure className={`stage-plate ${selected.storageStatus === "expired" ? "stage-plate-expired" : ""}`} title={`${selected.title} · ${selected.ratioLabel}`}>
            {selected.storageStatus === "expired" ? (
              <div className="expired-plate" role="img" aria-label={`${selected.title} 已过期`}>
                <strong>服务器副本已清理</strong>
                <span>{selected.archivePath ? `云盘备份：${selected.archivePath}` : "成片只在服务器保留 3 天，请及时存到本地或云盘"}</span>
              </div>
            ) : (
              <img src={selected.imageUrl} alt={selected.title} />
            )}
            {compareOn && beforeUrl ? (
              <div className="stage-compare" onPointerDown={startCompare}>
                <div className="stage-compare-before" style={{ clipPath: `inset(0 ${100 - comparePos}% 0 0)` }}>
                  <img src={beforeUrl} alt="原图" />
                  <span>原图</span>
                </div>
                <i className="stage-compare-line" style={{ left: `${comparePos}%` }} />
                <i className="stage-compare-handle" style={{ left: `${comparePos}%` }} />
              </div>
            ) : null}
            {isPlaceholderImage(selected.imageUrl) ? <em className="placeholder-tag stage-placeholder">演示占位图 · 未调用图像接口</em> : null}
            <figcaption>
              <span>{selected.title}</span>
              <span>
                {selected.ratioLabel} · {storageStatusLabels[selected.storageStatus]} · {selected.credits} 积分
                <span className="sr-only"> · {selected.storageStatus}</span>
              </span>
            </figcaption>
          </figure>
        ) : (
          <div className="stage-empty" aria-live="polite">
            <span className="stage-empty-mark" aria-hidden="true">◇</span>
            <strong>{isGenerating ? "正在为你生成成片" : "成片会出现在这里"}</strong>
            <p>
              {isGenerating
                ? "可以继续调整设置，完成后会自动显示结果。"
                : "左栏放入参考素材\n⌘ + Enter 生成，之后可在成片上标注"}
            </p>
          </div>
        )}

        {pins.map((pin, index) => (
          <div
            className={`stage-pin ${pin.left > 52 ? "flip" : ""}`}
            key={pin.id}
            style={{ left: `${pin.left}%`, top: `${pin.top}%` }}
          >
            <button type="button" className="stage-pin-dot" title="拖动标注" onPointerDown={(event) => startPinDrag(pin.id, event)}>
              {index + 1}
            </button>
            <span className="stage-pin-body">
              <input
                value={pin.text}
                placeholder="写下修改意见"
                aria-label={`标注 ${index + 1}`}
                onChange={(event) => patchPins(pins.map((item) => (item.id === pin.id ? { ...item, text: event.target.value } : item)))}
              />
              <button type="button" aria-label={`删除标注 ${index + 1}`} onClick={() => patchPins(pins.filter((item) => item.id !== pin.id))}>
                ×
              </button>
            </span>
          </div>
        ))}

        {dropActive ? <div className="stage-dropzone">松手加入左栏参考素材</div> : null}
        {isGenerating ? (
          <>
            {/* 已有成片时画布不会走空状态，这里补一个明确的进行中提示。 */}
            <div className="stage-working" role="status">
              <i className="stage-working-spinner" aria-hidden="true" />
              <span>
                <strong>正在生成…</strong>
                <small>已提交给图像引擎，完成后会自动显示新成片</small>
              </span>
            </div>
            <div className="stage-progress" aria-hidden="true"><i /></div>
          </>
        ) : null}
      </div>

      {results.length > 0 || isGenerating ? (
        <div className="stage-filmstrip" aria-label="成片缩略图">
          {isGenerating ? (
            <span className="result-thumb result-thumb-pending" aria-label="正在生成">
              <i aria-hidden="true" />
            </span>
          ) : null}
          {results.map((result) => (
            <button
              type="button"
              key={result.id}
              className={`result-thumb ${selected?.id === result.id ? "active" : ""}`}
              title={result.title}
              aria-label={`查看 ${result.title}`}
              aria-pressed={selected?.id === result.id}
              onClick={() => onSelect(result.id)}
            >
              <img src={result.imageUrl} alt="" />
            </button>
          ))}
        </div>
      ) : null}

      {zoomOpen && selected ? (
        <div className="stage-zoom" role="dialog" aria-label="成片放大" onClick={() => setZoomOpen(false)}>
          <figure>
            <img src={selected.imageUrl} alt={`${selected.title} 放大`} />
            <figcaption>{selected.title} · {selected.ratioLabel} · 点击任意处关闭</figcaption>
          </figure>
        </div>
      ) : null}
    </div>
  );
}

interface ResultPanelListProps {
  results: GeneratedResult[];
  selectedId: string;
  onSelect: (id: string) => void;
  onUseAsReference: (result: GeneratedResult) => void;
  onSync: (id: string) => void;
  onDelete: (id: string) => void;
}

/** 右栏「最近成片」：查看、以此继续、归档与删除。 */
export function ResultPanelList({
  results,
  selectedId,
  onSelect,
  onUseAsReference,
  onSync,
  onDelete,
}: ResultPanelListProps) {
  return (
    <div className="settings-block recent-results">
      <div className="settings-block-head">
        <span className="rail-kicker">最近成片</span>
        <small>{results.length ? `${results.length} 张` : ""}</small>
      </div>
      {results.length === 0 ? (
        <p className="muted-text">还没有成片。生成后可在这里快速回看、继续编辑或下载。</p>
      ) : null}
      {results.slice(0, 6).map((result) => (
        <article className={`result-card ${selectedId === result.id ? "active" : ""}`} key={result.id}>
          <button type="button" className="result-thumb" title="在画布上查看" onClick={() => onSelect(result.id)}>
            {result.storageStatus === "expired" ? <span className="result-thumb-expired">已清理</span> : <img src={result.imageUrl} alt="" />}
            {isPlaceholderImage(result.imageUrl) ? <em className="placeholder-tag">演示</em> : null}
          </button>
          <div className="result-meta">
            <strong>{result.title}</strong>
            <small>
              {result.ratioLabel} · {result.credits} 积分 · {storageStatusLabels[result.storageStatus]}
              <span className="sr-only"> · {result.storageStatus}</span>
            </small>
            <small className={`result-quality quality-${result.qualityGate?.status ?? "unknown"}`}>
              {imageQualityLabel(result.qualityGate)}
              <span className="sr-only"> {imageQualitySummary({ qualityGate: result.qualityGate, imageInspection: result.imageInspection })}</span>
            </small>
            <div className="result-actions">
              <button
                type="button"
                className="text-button"
                aria-label="加入参考"
                disabled={result.storageStatus === "expired"}
                title={result.storageStatus === "expired" ? EXPIRED_REFERENCE_HINT : undefined}
                onClick={() => onUseAsReference(result)}
              >
                加入参考
              </button>
              {result.storageStatus === "cloud-temp" || result.storageStatus === "local-cache" ? (
                <button type="button" className="text-button" aria-label="WebDAV" onClick={() => onSync(result.id)}>
                  推到云盘
                </button>
              ) : null}
              <a className="text-button" href={result.imageUrl} download={resultFileName(result)} aria-label="下载">
                下载
              </a>
              <button type="button" className="text-button result-delete" aria-label="删除" onClick={() => onDelete(result.id)}>
                删除
              </button>
            </div>
          </div>
        </article>
      ))}
    </div>
  );
}

export function resultToReference(result: GeneratedResult, label: string): ReferenceImage {
  return {
    id: `ref-result-${result.id}`,
    label,
    role: "style",
    note: result.title,
    fileName: resultFileName(result),
    previewUrl: result.imageUrl,
  };
}
