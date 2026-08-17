import { useEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent } from "react";
import { ratioOptions } from "../data/catalog";
import { outputSizeForRatio } from "../lib/outputSize";
import { isPlaceholderImage } from "../lib/providerMode";
import { formatResultTime, resultFileName } from "../lib/resultFiles";
import type { AttachmentUsage, FreeAttachment, GeneratedResult } from "../types";
import { AttachmentStrip } from "./AttachmentStrip";
import { PromptChipBar, usePromptChips } from "./PromptChips";
import { NumberStepper } from "./ui";

interface SimpleComposerProps {
  prompt: string;
  attachments: FreeAttachment[];
  ratioId: string;
  quantity: number;
  cost: number;
  credits: number;
  isGenerating: boolean;
  notice?: string;
  results: GeneratedResult[];
  onPromptChange: (value: string) => void;
  /** 一键清空描述和附件；成片历史不动。 */
  onClear: () => void;
  onAddFiles: (files: File[]) => void;
  onUsageChange: (id: string, usage: AttachmentUsage) => void;
  onRemoveAttachment: (id: string) => void;
  onRatioChange: (ratioId: string) => void;
  onQuantityChange: (quantity: number) => void;
  onGenerate: () => void;
  onUseAsAttachment: (result: GeneratedResult) => void;
  onSendToCanvas: (result: GeneratedResult) => void;
  onDeleteResult: (id: string) => void;
  onOpenAccount: () => void;
}

/** 简易模式：左边写描述，右边看成片，历史成片摆在下面。 */
export function SimpleComposer({
  prompt,
  attachments,
  ratioId,
  quantity,
  cost,
  credits,
  isGenerating,
  notice,
  results,
  onPromptChange,
  onClear,
  onAddFiles,
  onUsageChange,
  onRemoveAttachment,
  onRatioChange,
  onQuantityChange,
  onGenerate,
  onUseAsAttachment,
  onSendToCanvas,
  onDeleteResult,
  onOpenAccount,
}: SimpleComposerProps) {
  const [selectedId, setSelectedId] = useState("");
  const [zoomOpen, setZoomOpen] = useState(false);
  const [promptOpen, setPromptOpen] = useState(false);
  const [dropActive, setDropActive] = useState(false);

  const nativeRatios = ratioOptions.filter((ratio) => ratio.native);
  const ratio = ratioOptions.find((item) => item.id === ratioId) ?? ratioOptions[0];
  const outputSize = outputSizeForRatio(ratio);
  const hasEnoughCredits = cost <= credits;
  const canGenerate = prompt.trim().length > 0 && hasEnoughCredits && !isGenerating;
  const selected = results.find((result) => result.id === selectedId) ?? results[0];

  // `@` 引用已经传进来的附件，插入的标记和提示词构建器里的编号一致。
  const galleryChips = useMemo(
    () =>
      attachments.map((attachment, index) => ({
        id: attachment.id,
        name: `${attachment.name} · ${attachment.usage === "merge" ? "入画" : "参考"}`,
        insert: `上传图片${index + 1}`,
        previewUrl: attachment.previewUrl,
      })),
    [attachments],
  );
  const chips = usePromptChips({ value: prompt, onChange: onPromptChange, gallery: galleryChips });

  // 新成片一落地就切到右边的大图，否则根本看不出这次到底生成了没有。
  const newestId = results[0]?.id ?? "";
  const seenNewestRef = useRef(newestId);
  useEffect(() => {
    if (!results.length) {
      setSelectedId("");
      seenNewestRef.current = "";
      return;
    }
    if (newestId !== seenNewestRef.current) {
      seenNewestRef.current = newestId;
      setSelectedId(newestId);
      return;
    }
    if (!selectedId || !results.some((result) => result.id === selectedId)) setSelectedId(results[0].id);
  }, [newestId, results, selectedId]);

  useEffect(() => setPromptOpen(false), [selectedId]);

  useEffect(() => {
    if (!zoomOpen) return;
    const handleEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") setZoomOpen(false);
    };
    document.addEventListener("keydown", handleEscape);
    return () => document.removeEventListener("keydown", handleEscape);
  }, [zoomOpen]);

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (chips.handleKeyDown(event)) return;
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      event.preventDefault();
      if (canGenerate) onGenerate();
    }
  };

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDropActive(false);
    const images = Array.from(event.dataTransfer.files ?? []).filter((file) => file.type.startsWith("image/"));
    if (images.length) onAddFiles(images);
  };

  const statusMessage = isGenerating
    ? "生成中…"
    : !prompt.trim()
      ? "先写一句你想要的画面"
      : !hasEnoughCredits
        ? `积分不足 · 需要 ${cost}`
        : "已就绪 · ⌘ / Ctrl + Enter 生成";

  return (
    <div
      className={`simple-composer ${dropActive ? "drop-active" : ""}`}
      onDragOver={(event) => {
        event.preventDefault();
        setDropActive(true);
      }}
      onDragLeave={() => setDropActive(false)}
      onDrop={handleDrop}
    >
      <div className="simple-top">
        <section className="simple-card">
          <header className="simple-card-head">
            <span className="rail-kicker">画面描述</span>
            <span className="simple-card-head-side">
              <small className="muted-text">不限题材 · 可直接拖入图片</small>
              <button
                type="button"
                className="text-button"
                disabled={isGenerating || (!prompt.trim() && !attachments.length)}
                title="清空描述和附件，成片历史保留"
                onClick={onClear}
              >
                清空
              </button>
            </span>
          </header>

          <label className="simple-prompt chip-anchor">
            <span className="sr-only">画面描述</span>
            <textarea
              aria-label="画面描述"
              rows={4}
              value={prompt}
              placeholder="例如：一件米白色羊毛大衣挂在木质衣架上，晨光从侧面打进来，背景是安静的水泥墙。"
              onKeyDown={handleKeyDown}
              {...chips.textareaProps}
            />
            <span className="prompt-count">{prompt.trim().length} 字</span>
            {chips.picker}
          </label>

          <PromptChipBar onOpenKind={chips.openKind} activeKind={chips.openKindActive} galleryCount={galleryChips.length} />

          <AttachmentStrip
            attachments={attachments}
            onAddFiles={onAddFiles}
            onUsageChange={onUsageChange}
            onRemove={onRemoveAttachment}
            disabled={isGenerating}
          />

          <div className="simple-controls">
            <div className="simple-control">
              <span className="rail-kicker">比例</span>
              <div className="chip-group chip-sm" role="radiogroup" aria-label="画面比例">
                {nativeRatios.map((option) => (
                  <button
                    type="button"
                    key={option.id}
                    role="radio"
                    aria-checked={option.id === ratioId}
                    className={option.id === ratioId ? "chip selected" : "chip"}
                    onClick={() => onRatioChange(option.id)}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="simple-control">
              <span className="rail-kicker">张数</span>
              <NumberStepper value={quantity} min={1} max={4} onChange={onQuantityChange} ariaLabel="生成张数" />
            </div>
          </div>

          <div className={`output-size ${outputSize.auto ? "auto" : ""}`}>
            <span>输出像素</span>
            <strong>{outputSize.label}</strong>
          </div>

          <div className="simple-submit">
            <button type="button" className="btn btn-primary" disabled={!canGenerate} onClick={onGenerate}>
              {isGenerating ? "正在生成…" : `生成 ${quantity} 张 · ${cost} 积分`}
            </button>
            <span className={`prompt-status ${!isGenerating && !hasEnoughCredits ? "blocked" : ""}`} aria-live="polite">
              {notice || statusMessage}
            </span>
            {!hasEnoughCredits ? (
              <button type="button" className="text-button" onClick={onOpenAccount}>
                去充值
              </button>
            ) : null}
          </div>
        </section>

        <section className="simple-stage" aria-label="当前成片">
          {isGenerating ? (
            <div className="simple-stage-body simple-stage-pending" aria-live="polite">
              <span className="simple-pending-mark" aria-hidden="true">◇</span>
              <strong>正在生成…</strong>
              <small>已提交给图像引擎，完成后这里会变成成片</small>
              <div className="stage-progress" aria-hidden="true"><i /></div>
            </div>
          ) : selected ? (
            <>
              <div className="simple-stage-body simple-stage-image">
                <button type="button" className="simple-stage-plate" onClick={() => setZoomOpen(true)} title="点开放大">
                  <img src={selected.imageUrl} alt={selected.title} />
                  {isPlaceholderImage(selected.imageUrl) ? <em className="placeholder-tag">演示占位图</em> : null}
                </button>
                {promptOpen && selected.prompt ? (
                  <div className="stage-prompt" role="dialog" aria-label="这张成片的描述">
                    <header>
                      <span className="rail-kicker">当时的描述</span>
                      <button type="button" onClick={() => setPromptOpen(false)} aria-label="关闭描述">×</button>
                    </header>
                    <p>{selected.prompt}</p>
                    <div className="stage-prompt-actions">
                      <button
                        type="button"
                        className="text-button"
                        onClick={() => {
                          onPromptChange(selected.prompt ?? "");
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
              </div>

              <footer className="simple-stage-foot">
                <div className="simple-stage-meta">
                  <strong title={selected.title}>{selected.title}</strong>
                  <small>{selected.ratioLabel} · {formatResultTime(selected.createdAt)}</small>
                </div>
                <div className="simple-stage-actions">
                  <button type="button" className="text-button" onClick={() => onUseAsAttachment(selected)}>
                    加入参考
                  </button>
                  <button type="button" className="text-button" onClick={() => onSendToCanvas(selected)}>
                    放到画布
                  </button>
                  <button
                    type="button"
                    className="text-button"
                    disabled={!selected.prompt}
                    title={selected.prompt ? "看看这张是用什么描述出来的" : "这张成片没有记录描述"}
                    onClick={() => setPromptOpen((value) => !value)}
                  >
                    提示词
                  </button>
                  <a className="text-button" href={selected.imageUrl} download={resultFileName(selected)}>
                    下载
                  </a>
                  <button type="button" className="text-button danger" onClick={() => onDeleteResult(selected.id)}>
                    删除
                  </button>
                </div>
              </footer>
            </>
          ) : (
            <div className="simple-stage-body simple-stage-empty">
              <span className="simple-pending-mark" aria-hidden="true">◇</span>
              <strong>成片会出现在这里</strong>
              <small>写一句描述就能出第一张图。上传的图片可以设成「参考」借鉴风格，或设成「入画」让它出现在成片里。</small>
            </div>
          )}
        </section>
      </div>

      <section className="simple-results" aria-label="历史成片">
        <header className="simple-card-head">
          <span className="rail-kicker">成片</span>
          <small className="muted-text">{results.length ? `${results.length} 张 · 点一下在右侧查看` : "还没有成片"}</small>
        </header>

        {results.length ? (
          <div className="simple-result-grid">
            {results.map((result) => (
              <figure className={`simple-result-card ${selected?.id === result.id ? "active" : ""}`} key={result.id}>
                <button
                  type="button"
                  className="simple-result-thumb"
                  aria-pressed={selected?.id === result.id}
                  onClick={() => setSelectedId(result.id)}
                >
                  <img src={result.imageUrl} alt={result.title} loading="lazy" />
                  {isPlaceholderImage(result.imageUrl) ? <em className="placeholder-tag">演示占位图</em> : null}
                </button>
                <figcaption>
                  <strong title={result.title}>{result.title}</strong>
                  <small>{result.ratioLabel} · {formatResultTime(result.createdAt)}</small>
                </figcaption>
                <div className="simple-result-actions">
                  <button type="button" className="text-button" onClick={() => onUseAsAttachment(result)}>
                    加入参考
                  </button>
                  <button type="button" className="text-button" onClick={() => onSendToCanvas(result)}>
                    放到画布
                  </button>
                  <a className="text-button" href={result.imageUrl} download={resultFileName(result)}>
                    下载
                  </a>
                  <button type="button" className="text-button danger" onClick={() => onDeleteResult(result.id)}>
                    删除
                  </button>
                </div>
              </figure>
            ))}
          </div>
        ) : (
          <p className="simple-empty">生成过的图都会留在这里，点一下就能在右侧大图查看，或者直接加入参考继续改。</p>
        )}
      </section>

      {zoomOpen && selected ? (
        <div className="simple-zoom" role="dialog" aria-label={selected.title} onClick={() => setZoomOpen(false)}>
          <img src={selected.imageUrl} alt={selected.title} />
          <button type="button" className="simple-zoom-close" aria-label="关闭预览">×</button>
        </div>
      ) : null}
    </div>
  );
}
