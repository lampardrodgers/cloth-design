import { useEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent } from "react";
import { CheckCircle2, ImageOff, LoaderCircle, X } from "lucide-react";
import { freeResolutionOptions } from "../data/catalog";
import { isPlaceholderImage } from "../lib/providerMode";
import { taskDurationLabel } from "../lib/duration";
import { attachmentUsageLabels } from "../lib/freeStudio";
import { isResolutionAllowed, resolutionOptionTitle } from "../lib/resolution";
import { formatResultTime, resultFileName } from "../lib/resultFiles";
import { useStoredState } from "../lib/storedState";
import { useNow } from "../lib/useNow";
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

/** 服务器上过期清理的成片只剩一条记录，没法再当参考或放进画布。 */
const EXPIRED_ACTION_HINT = "这张成片已在服务器上清理，文件不在了，不能再加入参考或放到画布。";

export interface SimplePendingJob {
  id: string;
  prompt: string;
  quantity: number;
  ratioLabel: string;
  resolutionLabel: string;
  createdAt: string;
}

export interface SimpleGenerationCompletion {
  jobId: string;
  resultIds: string[];
}

interface SimplePreviewState {
  mode: "image" | "pending" | "empty";
  pendingJobId?: string;
  pendingIndex?: number;
}

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
  /** 当前仍在生成的提交：右侧预览和底部成片区共用这份进度。 */
  pendingJobs: SimplePendingJob[];
  /** 已完成但尚未处理的成片批次，用于决定自动切图还是只弹出完成提示。 */
  completionQueue: SimpleGenerationCompletion[];
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
  onCompletionHandled: (jobId: string) => void;
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
  pendingJobs,
  completionQueue,
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
  onCompletionHandled,
}: SimpleComposerProps) {
  const initialSelectedId = results[0]?.id ?? "";
  // 预览选择写进本地状态：切去账户、功能或画布再回来，也要尊重用户刚才的「清空预览」。
  const [selectedId, setSelectedId] = useStoredState("clothdesign:free:simple-selected-result", initialSelectedId);
  const [previewState, setPreviewState] = useStoredState<SimplePreviewState>(
    "clothdesign:free:simple-preview-state",
    { mode: initialSelectedId ? "image" : "empty" },
  );
  const previewMode = previewState.mode;
  const [zoomOpen, setZoomOpen] = useState(false);
  const [promptOpen, setPromptOpen] = useState(false);
  const [dropActive, setDropActive] = useState(false);
  const [completionNotice, setCompletionNotice] = useState<{ resultIds: string[]; count: number } | null>(null);
  // 从画布切回来时组件会重挂载；已有任务不是「新提交」，不能擅自覆盖持久化的人工选择。
  const knownPendingIdsRef = useRef(new Set(pendingJobs.map((job) => job.id)));
  const overriddenPendingIdsRef = useRef(new Set<string>());
  const seenCompletionRef = useRef("");

  const hasEnoughCredits = cost <= credits;
  const pendingCount = pendingJobs.reduce((total, job) => total + job.quantity, 0);
  const isGenerating = pendingCount > 0;
  // 生成中的卡片自己数秒，让人知道这次已经等了多久，而不是只看一条来回滚的进度条。
  const now = useNow(isGenerating);
  const selectedPendingJob =
    previewMode === "pending"
      ? pendingJobs.find((job) => job.id === previewState.pendingJobId)
      : undefined;
  const selectedPendingIndex = Math.min(
    Math.max(previewState.pendingIndex ?? 0, 0),
    Math.max((selectedPendingJob?.quantity ?? 1) - 1, 0),
  );
  const latestPendingDuration = taskDurationLabel({ startedAt: selectedPendingJob?.createdAt, running: true, now });
  // 提交后描述会被清空，按钮自然就灰了，所以不用再拿「正在生成」锁住整块表单——
  // 用户可以马上写下一张排队生成。
  const canGenerate = prompt.trim().length > 0 && hasEnoughCredits;
  const selected = previewMode === "image" ? results.find((result) => result.id === selectedId) : undefined;
  const pendingSlots = useMemo(
    () =>
      pendingJobs.flatMap((job) =>
        Array.from({ length: job.quantity }, (_, index) => ({ job, index, key: `${job.id}-${index}` })),
      ),
    [pendingJobs],
  );
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

  // 新提交一开始就把旧图收起来，右侧和底部同时进入明确的「生成中」状态。
  useEffect(() => {
    const newlyStarted = pendingJobs.filter((job) => !knownPendingIdsRef.current.has(job.id));
    pendingJobs.forEach((job) => knownPendingIdsRef.current.add(job.id));
    if (!newlyStarted.length) return;
    setPreviewState({ mode: "pending", pendingJobId: newlyStarted[0].id, pendingIndex: 0 });
    setCompletionNotice(null);
    setPromptOpen(false);
    setZoomOpen(false);
  }, [pendingJobs, setPreviewState]);

  // 生成失败、页面刷新或任务记录失效时，没有新图可切，就恢复生成前的选择；之前清空则继续空白。
  useEffect(() => {
    if (previewMode !== "pending" || !previewState.pendingJobId) return;
    const stillPending = pendingJobs.some((job) => job.id === previewState.pendingJobId);
    const completionWaiting = completionQueue.some((completion) => completion.jobId === previewState.pendingJobId);
    if (stillPending || completionWaiting) return;
    setPreviewState({ mode: selectedId && results.some((result) => result.id === selectedId) ? "image" : "empty" });
  }, [completionQueue, pendingJobs, previewMode, previewState.pendingJobId, results, selectedId, setPreviewState]);

  // 新图完成：没有人工改选就自动展示；生成途中点过旧图或清空过预览，则只弹提示，不抢走当前画面。
  useEffect(() => {
    const nextCompletion = completionQueue.find((completion) => seenCompletionRef.current !== completion.jobId);
    if (!nextCompletion) return;
    const availableResultIds = nextCompletion.resultIds.filter((id) => results.some((result) => result.id === id));
    if (!availableResultIds.length) return;
    seenCompletionRef.current = nextCompletion.jobId;
    const isSelectedPendingJob =
      previewState.mode === "pending" && previewState.pendingJobId === nextCompletion.jobId;
    const overridden = overriddenPendingIdsRef.current.has(nextCompletion.jobId) || !isSelectedPendingJob;
    overriddenPendingIdsRef.current.delete(nextCompletion.jobId);
    if (overridden) {
      setCompletionNotice({ resultIds: availableResultIds, count: availableResultIds.length });
    } else {
      setSelectedId(availableResultIds[Math.min(previewState.pendingIndex ?? 0, availableResultIds.length - 1)]);
      setPreviewState({ mode: "image" });
      setCompletionNotice(null);
    }
    onCompletionHandled(nextCompletion.jobId);
  }, [completionQueue, onCompletionHandled, previewState, results, setPreviewState, setSelectedId]);

  useEffect(() => {
    if (previewMode !== "image" || !selectedId || results.some((result) => result.id === selectedId)) return;
    setSelectedId("");
    setPreviewState({ mode: "empty" });
  }, [previewMode, results, selectedId, setPreviewState, setSelectedId]);

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

  const markCurrentGenerationAsOverridden = () => {
    pendingJobs.forEach((job) => overriddenPendingIdsRef.current.add(job.id));
  };

  const handleSelectResult = (id: string) => {
    markCurrentGenerationAsOverridden();
    setSelectedId(id);
    setPreviewState({ mode: "image" });
    setCompletionNotice(null);
  };

  const handleSelectPending = (jobId: string, index: number) => {
    // 用户重新点回生成卡，表示这次又是他想看的目标；完成后应自动切图，不再只弹提醒。
    overriddenPendingIdsRef.current.delete(jobId);
    setPreviewState({ mode: "pending", pendingJobId: jobId, pendingIndex: index });
    setCompletionNotice(null);
    setPromptOpen(false);
    setZoomOpen(false);
  };

  const handleClearPreview = () => {
    markCurrentGenerationAsOverridden();
    setSelectedId("");
    setPreviewState({ mode: "empty" });
    setPromptOpen(false);
    setZoomOpen(false);
    setCompletionNotice(null);
  };

  const handleViewCompletedResult = () => {
    const nextId = completionNotice?.resultIds.find((id) => results.some((result) => result.id === id));
    if (!nextId) return;
    setSelectedId(nextId);
    setPreviewState({ mode: "image" });
    setCompletionNotice(null);
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
          {previewMode === "pending" && selectedPendingJob ? (
            <>
              <div className="simple-stage-body simple-stage-pending" aria-live="polite">
                <LoaderCircle className="simple-pending-loader" size={32} strokeWidth={1.5} aria-hidden="true" />
                <strong>正在生成第 {selectedPendingIndex + 1} 张图片</strong>
                <small>
                  {selectedPendingJob.prompt || "已提交给图像引擎"}
                  <br />左边可以继续写下一张，完成后会自动显示在这里
                </small>
                <div className="stage-progress" aria-hidden="true"><i /></div>
              </div>
              <footer className="simple-stage-foot simple-stage-pending-foot">
                <div className="simple-stage-meta">
                  <strong>生成中</strong>
                  <small>
                    {selectedPendingJob.ratioLabel} · {selectedPendingJob.resolutionLabel} · 第 {selectedPendingIndex + 1} / {selectedPendingJob.quantity} 张
                    {latestPendingDuration ? ` · ${latestPendingDuration}` : ""}
                  </small>
                </div>
                <div className="simple-stage-actions">
                  <button type="button" className="text-button simple-clear-preview" onClick={handleClearPreview}>
                    <ImageOff size={13} aria-hidden="true" />
                    清空预览
                  </button>
                </div>
              </footer>
            </>
          ) : selected ? (
            <>
              {isGenerating ? (
                <div className="simple-stage-pending-bar" aria-live="polite">
                  <LoaderCircle className="simple-pending-loader" size={15} aria-hidden="true" />
                  <strong>还有 {pendingCount} 张生成中</strong>
                  <small>已保留你正在查看的图片</small>
                </div>
              ) : null}
              <div className="simple-stage-body simple-stage-image">
                {selected.storageStatus === "expired" ? (
                  // 服务器只保留 3 天，文件清掉之后别再渲染一张裂图。
                  <div className="simple-stage-plate simple-stage-plate-expired">
                    <div className="expired-plate" role="img" aria-label={`${selected.title} 已过期`}>
                      <strong>服务器副本已清理</strong>
                      <span>{selected.archivePath ? `云盘备份：${selected.archivePath}` : "成片只在服务器保留 3 天，请及时存到本地或云盘"}</span>
                    </div>
                  </div>
                ) : (
                  <button type="button" className="simple-stage-plate" onClick={() => setZoomOpen(true)} title="点开放大">
                    <img src={selected.imageUrl} alt={selected.title} />
                    {isPlaceholderImage(selected.imageUrl) ? <em className="placeholder-tag">演示占位图</em> : null}
                  </button>
                )}
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
                  <button
                    type="button"
                    className="text-button"
                    disabled={selected.storageStatus === "expired"}
                    title={selected.storageStatus === "expired" ? EXPIRED_ACTION_HINT : ""}
                    onClick={() => onUseAsAttachment(selected)}
                  >
                    加入参考
                  </button>
                  <button
                    type="button"
                    className="text-button"
                    disabled={selected.storageStatus === "expired"}
                    title={selected.storageStatus === "expired" ? EXPIRED_ACTION_HINT : ""}
                    onClick={() => onSendToCanvas(selected)}
                  >
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
                  {selected.storageStatus !== "expired" ? (
                    <a className="text-button" href={selected.imageUrl} download={resultFileName(selected)}>
                      下载
                    </a>
                  ) : null}
                  <button type="button" className="text-button danger" onClick={() => onDeleteResult(selected.id)}>
                    删除
                  </button>
                  <button type="button" className="text-button simple-clear-preview" onClick={handleClearPreview}>
                    <ImageOff size={13} aria-hidden="true" />
                    清空预览
                  </button>
                </div>
              </footer>
            </>
          ) : (
            <div className="simple-stage-body simple-stage-empty">
              <ImageOff className="simple-empty-icon" size={30} strokeWidth={1.35} aria-hidden="true" />
              <strong>成片会出现在这里</strong>
              <small>写一句描述就能出第一张图。上传的图片可以设成「参考」借鉴风格，或设成「入画」让它出现在成片里。</small>
            </div>
          )}
        </section>
      </div>

      <section className="simple-results" aria-label="历史成片">
        <header className="simple-card-head">
          <span className="rail-kicker">成片</span>
          <small className="muted-text">
            {isGenerating
              ? `${pendingCount} 张生成中 · 已有 ${results.length} 张成片`
              : results.length
                ? `${results.length} 张 · 点一下在右侧查看`
                : "还没有成片"}
          </small>
        </header>

        {pendingSlots.length || results.length ? (
          <div className="simple-result-grid">
            {pendingSlots.map(({ job, index, key }) => {
              const elapsed = taskDurationLabel({ startedAt: job.createdAt, running: true, now });
              const active =
                previewState.mode === "pending" &&
                previewState.pendingJobId === job.id &&
                (previewState.pendingIndex ?? 0) === index;
              return (
                <figure className={`simple-result-card simple-result-card-pending ${active ? "active" : ""}`} key={key}>
                  <button
                    type="button"
                    className="simple-result-thumb simple-result-thumb-pending"
                    aria-label={`查看第 ${index + 1} 张图片的生成状态`}
                    aria-pressed={active}
                    onClick={() => handleSelectPending(job.id, index)}
                  >
                    <LoaderCircle className="simple-pending-loader" size={24} strokeWidth={1.5} aria-hidden="true" />
                    <strong>生成中</strong>
                    <small>{index + 1} / {job.quantity}</small>
                    <div className="stage-progress" aria-hidden="true"><i /></div>
                  </button>
                  <figcaption>
                    <strong title={job.prompt}>{job.prompt}</strong>
                    <small>
                      {job.ratioLabel} · {job.resolutionLabel} · {formatResultTime(job.createdAt)}
                      {elapsed ? ` · ${elapsed}` : ""}
                    </small>
                  </figcaption>
                  <div className="simple-result-pending-status">点一下可重新查看生成状态</div>
                </figure>
              );
            })}
            {results.map((result) => (
              <figure className={`simple-result-card ${selected?.id === result.id ? "active" : ""}`} key={result.id}>
                <button
                  type="button"
                  className={`simple-result-thumb ${result.storageStatus === "expired" ? "simple-result-thumb-expired" : ""}`}
                  aria-pressed={selected?.id === result.id}
                  onClick={() => handleSelectResult(result.id)}
                >
                  {result.storageStatus === "expired" ? (
                    <span className="result-thumb-expired" aria-label={`${result.title} 已清理`}>已清理</span>
                  ) : (
                    <img src={result.imageUrl} alt={result.title} loading="lazy" />
                  )}
                  {isPlaceholderImage(result.imageUrl) ? <em className="placeholder-tag">演示占位图</em> : null}
                </button>
                <figcaption>
                  <strong title={result.title}>{result.title}</strong>
                  <small>{result.ratioLabel} · {formatResultTime(result.createdAt)}</small>
                </figcaption>
                <div className="simple-result-actions">
                  <button
                    type="button"
                    className="text-button"
                    disabled={result.storageStatus === "expired"}
                    title={result.storageStatus === "expired" ? EXPIRED_ACTION_HINT : ""}
                    onClick={() => onUseAsAttachment(result)}
                  >
                    加入参考
                  </button>
                  <button
                    type="button"
                    className="text-button"
                    disabled={result.storageStatus === "expired"}
                    title={result.storageStatus === "expired" ? EXPIRED_ACTION_HINT : ""}
                    onClick={() => onSendToCanvas(result)}
                  >
                    放到画布
                  </button>
                  {result.storageStatus !== "expired" ? (
                    <a className="text-button" href={result.imageUrl} download={resultFileName(result)}>
                      下载
                    </a>
                  ) : null}
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

      {completionNotice ? (
        <div className="simple-completion-notice" role="status" aria-live="polite">
          <CheckCircle2 size={21} strokeWidth={1.7} aria-hidden="true" />
          <div>
            <strong>新图像已完成生成</strong>
            <span>已保留你当前查看的内容，共完成 {completionNotice.count} 张。</span>
          </div>
          <button type="button" className="btn btn-secondary" onClick={handleViewCompletedResult}>
            查看新图
          </button>
          <button
            type="button"
            className="icon-button"
            aria-label="关闭新图完成提示"
            onClick={() => setCompletionNotice(null)}
          >
            <X size={16} aria-hidden="true" />
          </button>
        </div>
      ) : null}

      {zoomOpen && selected ? (
        <div className="simple-zoom" role="dialog" aria-label={selected.title} onClick={() => setZoomOpen(false)}>
          <img src={selected.imageUrl} alt={selected.title} />
          <button type="button" className="simple-zoom-close" aria-label="关闭预览">×</button>
        </div>
      ) : null}
    </div>
  );
}
