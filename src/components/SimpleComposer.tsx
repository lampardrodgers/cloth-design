import { useEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent } from "react";
import { freeResolutionOptions } from "../data/catalog";
import { isPlaceholderImage } from "../lib/providerMode";
import { attachmentUsageLabels } from "../lib/freeStudio";
import { isResolutionAllowed, resolutionLimitNote, resolutionOptionTitle } from "../lib/resolution";
import { formatResultTime, resultFileName } from "../lib/resultFiles";
import type {
  AttachmentUsage,
  FreeAttachment,
  GeneratedResult,
  ProviderCapability,
  ResolutionKey,
  SubmissionRecord,
} from "../types";
import { AttachmentStrip } from "./AttachmentStrip";
import { PromptChipBar, usePromptChips } from "./PromptChips";
import { RatioPicker } from "./RatioPicker";
import { NumberStepper } from "./ui";

interface SimpleComposerProps {
  prompt: string;
  attachments: FreeAttachment[];
  ratioId: string;
  resolution: ResolutionKey;
  /** 当前账号走的哪条线路、最高能开到几 K。 */
  capability: ProviderCapability;
  quantity: number;
  cost: number;
  credits: number;
  /** 手上还有几张在生成。提交后左边就清空了，这个数只用来显示进度。 */
  pendingCount: number;
  /** 每次提交的现场存档（描述 / 参考图 / 参数），按 taskId 对上成片。 */
  submissions: SubmissionRecord[];
  notice?: string;
  results: GeneratedResult[];
  onPromptChange: (value: string) => void;
  /** 一键清空描述和附件；成片历史不动。 */
  onClear: () => void;
  onAddFiles: (files: File[]) => void;
  onUsageChange: (id: string, usage: AttachmentUsage) => void;
  onRemoveAttachment: (id: string) => void;
  onRatioChange: (ratioId: string) => void;
  onResolutionChange: (resolution: ResolutionKey) => void;
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
  resolution,
  capability,
  quantity,
  cost,
  credits,
  pendingCount,
  submissions,
  notice,
  results,
  onPromptChange,
  onClear,
  onAddFiles,
  onUsageChange,
  onRemoveAttachment,
  onRatioChange,
  onResolutionChange,
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

  const resolutionNote = resolutionLimitNote(capability);
  const hasEnoughCredits = cost <= credits;
  const isGenerating = pendingCount > 0;
  // 提交后描述会被清空，按钮自然就灰了，所以不用再拿「正在生成」锁住整块表单——
  // 用户可以马上写下一张排队生成。
  const canGenerate = prompt.trim().length > 0 && hasEnoughCredits;
  const selected = results.find((result) => result.id === selectedId) ?? results[0];
  // 提交现场按 taskId 对上；旧成片没有存档，退回到成片自己记的那句描述。
  const submission = selected ? submissions.find((item) => item.taskId === selected.taskId) : undefined;
  const submittedPrompt = submission?.prompt ?? selected?.prompt ?? "";

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

  // 张数只在右边那颗「N 张生成中」上说一次，状态位不重复。
  const statusMessage = !prompt.trim()
    ? isGenerating
      ? "已提交，可以接着写下一张"
      : "先写一句你想要的画面"
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
              <small className="muted-text">不限题材 · 图片可拖入或 ⌘/Ctrl + V 粘贴</small>
              <button
                type="button"
                className="text-button"
                disabled={!prompt.trim() && !attachments.length}
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
              placeholder="例如：黄昏的城市天台，一只橘猫蹲在栏杆上看远处的高楼，光线很柔。人物、产品、风景、插画、海报都行，想到什么写什么。"
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
          />

          <div className="simple-controls">
            <div className="simple-control">
              <span className="rail-kicker">比例</span>
              <RatioPicker value={ratioId} resolution={resolution} protocol={capability.protocol} onChange={onRatioChange} />
            </div>

            <div className="simple-control">
              <span className="rail-kicker">分辨率</span>
              {/* 线路开不到的档位照样列出来但点不动：藏起来只会让人以为功能没了。 */}
              <div className="chip-group chip-sm" role="radiogroup" aria-label="输出分辨率">
                {freeResolutionOptions.map((option) => {
                  const allowed = isResolutionAllowed(option.id, capability.maxResolution);
                  return (
                    <button
                      type="button"
                      key={option.id}
                      role="radio"
                      aria-checked={option.id === resolution}
                      disabled={!allowed}
                      title={resolutionOptionTitle(option.id, capability)}
                      className={option.id === resolution ? "chip selected" : "chip"}
                      onClick={() => onResolutionChange(option.id)}
                    >
                      {option.label}
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="simple-control">
              <span className="rail-kicker">张数</span>
              <NumberStepper value={quantity} min={1} max={4} onChange={onQuantityChange} ariaLabel="生成张数" />
            </div>
          </div>

          {/* 说明单独占一行：塞进分辨率那一列会把「张数」挤歪。 */}
          {resolutionNote ? <p className="simple-controls-note">{resolutionNote}</p> : null}

          {/* 状态在左、按钮钉右：状态文案和「N 张生成中」长短变化都不会推着生成按钮乱跑。 */}
          <div className="simple-submit">
            <div className="simple-submit-status">
              <span className={`prompt-status ${!isGenerating && !hasEnoughCredits ? "blocked" : ""}`} aria-live="polite">
                {notice || statusMessage}
              </span>
              {!hasEnoughCredits ? (
                <button type="button" className="text-button" onClick={onOpenAccount}>
                  去充值
                </button>
              ) : null}
              {isGenerating ? <em className="simple-pending-chip">{pendingCount} 张生成中</em> : null}
            </div>
            <button type="button" className="btn btn-primary" disabled={!canGenerate} onClick={onGenerate}>
              生成 {quantity} 张 · {cost} 积分
            </button>
          </div>
        </section>

        <section className="simple-stage" aria-label="当前成片">
          {isGenerating && selected ? (
            <div className="simple-stage-pending-bar" aria-live="polite">
              <span className="simple-pending-mark" aria-hidden="true">◇</span>
              <strong>{pendingCount} 张生成中…</strong>
              <small>出图后自动切到这里，右下角「任务」能看进度</small>
            </div>
          ) : null}
          {isGenerating && !selected ? (
            <div className="simple-stage-body simple-stage-pending" aria-live="polite">
              <span className="simple-pending-mark" aria-hidden="true">◇</span>
              <strong>{pendingCount} 张生成中…</strong>
              <small>已提交给图像引擎，左边可以接着写下一张</small>
              <div className="stage-progress" aria-hidden="true"><i /></div>
            </div>
          ) : selected ? (
            <>
              <div className="simple-stage-body simple-stage-image">
                <button type="button" className="simple-stage-plate" onClick={() => setZoomOpen(true)} title="点开放大">
                  <img src={selected.imageUrl} alt={selected.title} />
                  {isPlaceholderImage(selected.imageUrl) ? <em className="placeholder-tag">演示占位图</em> : null}
                </button>
                {promptOpen && (submission || selected.prompt) ? (
                  <div className="stage-prompt" role="dialog" aria-label="这张成片的提交详情">
                    <header>
                      <span className="rail-kicker">当时提交了什么</span>
                      <button type="button" onClick={() => setPromptOpen(false)} aria-label="关闭提交详情">×</button>
                    </header>
                    <p>{submittedPrompt || "（没有写描述）"}</p>
                    {submission?.references.length ? (
                      <div className="submission-refs">
                        <span className="rail-kicker">参考图 {submission.references.length} 张</span>
                        <div className="submission-ref-list">
                          {submission.references.map((reference, index) => (
                            <figure className="submission-ref" key={`${reference.name}-${index}`}>
                              {reference.thumbUrl ? (
                                <img src={reference.thumbUrl} alt={reference.name} />
                              ) : (
                                <span className="submission-ref-missing">无缩略图</span>
                              )}
                              <figcaption title={reference.name}>
                                <em>{attachmentUsageLabels[reference.usage]}</em>
                                {reference.name}
                              </figcaption>
                            </figure>
                          ))}
                        </div>
                      </div>
                    ) : submission ? (
                      <p className="submission-empty">这次没有带参考图</p>
                    ) : null}
                    {submission ? (
                      <dl className="submission-params">
                        <div><dt>比例</dt><dd>{submission.ratioLabel}</dd></div>
                        <div><dt>输出像素</dt><dd>{submission.sizeLabel}</dd></div>
                        <div><dt>张数</dt><dd>{submission.quantity}</dd></div>
                        <div><dt>画质</dt><dd>{submission.quality}</dd></div>
                        <div><dt>格式</dt><dd>{submission.outputFormat}</dd></div>
                        <div><dt>背景</dt><dd>{submission.background}</dd></div>
                        <div><dt>参考图保真</dt><dd>{submission.inputFidelity}</dd></div>
                        <div><dt>提交时间</dt><dd>{submission.createdAt}</dd></div>
                      </dl>
                    ) : (
                      <p className="submission-empty">这张成片是旧版本生成的，只留下了描述</p>
                    )}
                    <div className="stage-prompt-actions">
                      <button
                        type="button"
                        className="text-button"
                        disabled={!submittedPrompt}
                        onClick={() => {
                          onPromptChange(submittedPrompt);
                          setPromptOpen(false);
                        }}
                      >
                        用这段重做
                      </button>
                      <button
                        type="button"
                        className="text-button"
                        disabled={!submittedPrompt}
                        onClick={() => navigator.clipboard?.writeText(submittedPrompt)}
                      >
                        复制描述
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
                    disabled={!submission && !selected.prompt}
                    title={
                      submission
                        ? "看看这张当时提交的描述、参考图和参数"
                        : selected.prompt
                          ? "看看这张是用什么描述出来的"
                          : "这张成片没有留下提交记录"
                    }
                    onClick={() => setPromptOpen((value) => !value)}
                  >
                    提交详情
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
