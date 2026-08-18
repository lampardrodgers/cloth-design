import { Suspense, useCallback, useMemo, useState } from "react";
import { generationModes } from "../data/catalog";
import { estimateCredits } from "../lib/costing";
import { resetCanvasStore } from "../lib/canvasStore";
import { filesToAttachments, MAX_ATTACHMENTS } from "../lib/freeStudio";
import { lazyWithReload } from "../lib/lazyChunk";
import { useStoredState } from "../lib/storedState";
import type {
  AttachmentUsage,
  CreditPolicy,
  FreeAttachment,
  GeneratedResult,
  PendingCanvasImage,
  StudioSettings,
  SubmissionRecord,
} from "../types";
import type { ApiConfig } from "../lib/api";
import type { CanvasGenerateInput } from "./CanvasBoard";
import { ErrorBoundary } from "./ErrorBoundary";
import { ProviderBanner } from "./ProviderBanner";
import { SimpleComposer } from "./SimpleComposer";

// tldraw 有 1.7MB，只在真正切到画布时才拉，别拖慢创作台和简易模式。
// 版本更新后老页面手里的文件名会失效，lazyWithReload 负责自动刷一次而不是整页白屏。
const CanvasBoard = lazyWithReload("canvas", () => import("./CanvasBoard").then((module) => ({ default: module.CanvasBoard })));

export interface FreeGenerationInput {
  prompt: string;
  attachments: FreeAttachment[];
  ratioId: string;
  quantity: number;
  /** free = 按描述出图；annotation = 带批注的截图当修改需求书；sketch = 手绘草图当构图需求。 */
  intent?: "free" | "annotation" | "sketch";
}

export type FreeLayout = "simple" | "canvas";

interface FreeStudioProps {
  results: GeneratedResult[];
  /** 每次提交的现场存档，按 taskId 对上成片。 */
  submissions: SubmissionRecord[];
  credits: number;
  creditPolicy: CreditPolicy;
  settings: StudioSettings;
  apiConfig: ApiConfig | null;
  /** 简易/画布切换由顶栏承载，工作区里不再单独占一条标题栏。 */
  layout: FreeLayout;
  onLayoutChange: (layout: FreeLayout) => void;
  onGenerate: (input: FreeGenerationInput) => Promise<GeneratedResult[]>;
  onDeleteResult: (id: string) => void;
  onOpenAccount: () => void;
}

const freeMode = generationModes.find((mode) => mode.id === "free") ?? generationModes[0];

/**
 * 自由创作：同一套生成内核的两种外壳。
 * - 简易：一个描述框 + 一排附件，最短路径出图；
 * - 画布：tldraw 无限画布，AI 画框就地生成、批注驱动改图。
 */
export function FreeStudio({
  results,
  submissions,
  credits,
  creditPolicy,
  settings,
  apiConfig,
  layout,
  onLayoutChange,
  onGenerate,
  onDeleteResult,
  onOpenAccount,
}: FreeStudioProps) {
  const [prompt, setPrompt] = useStoredState("clothdesign:free:prompt", "");
  const [attachments, setAttachments] = useStoredState<FreeAttachment[]>("clothdesign:free:attachments", []);
  const [ratioId, setRatioId] = useStoredState("clothdesign:free:ratio", "1-1");
  const [quantity, setQuantity] = useStoredState("clothdesign:free:quantity", 1);
  const [pendingImages, setPendingImages] = useState<PendingCanvasImage[]>([]);
  const [notice, setNotice] = useState("");
  /** 手上有几张还在生成。简易模式不再因此锁住输入框，只用来显示进度。 */
  const [pendingCount, setPendingCount] = useState(0);

  const costFor = useCallback(
    (referenceCount: number, count = 1) =>
      estimateCredits(
        freeMode,
        { ...settings, mode: "free", ratioId, quantity: count },
        Array.from({ length: referenceCount }, (_, index) => ({
          id: `count-${index}`,
          label: String(index + 1),
          role: "style" as const,
          note: "",
          previewUrl: "counted",
        })),
        creditPolicy,
      ),
    [creditPolicy, ratioId, settings],
  );

  const canvasCostFor = useCallback((referenceCount: number) => costFor(referenceCount, 1), [costFor]);
  const simpleCost = useMemo(() => costFor(attachments.length, quantity), [attachments.length, costFor, quantity]);

  /* ── 简易模式 ─────────────────────────────────────────────────────────────── */

  const handleAddFiles = async (files: File[]) => {
    const { attachments: added, errors } = await filesToAttachments(files.slice(0, MAX_ATTACHMENTS - attachments.length));
    if (errors.length) setNotice(errors[0]);
    else if (added.length) setNotice("");
    if (added.length) setAttachments((current) => [...current, ...added].slice(0, MAX_ATTACHMENTS));
  };

  /**
   * 简易模式提交：交出去就清空左边，接着写下一张，不用等这张出完。
   * 描述和参考图都进了这次提交的存档（右边「提交详情」能查），所以清空不算丢东西；
   * 万一请求当场就失败，而用户还没开始写下一张，就把刚才那份放回去。
   */
  const handleSimpleGenerate = () => {
    const submitted = { prompt, attachments };
    if (!submitted.prompt.trim()) return;
    setNotice("");
    setPendingCount((count) => count + 1);
    const running = onGenerate({ prompt: submitted.prompt, attachments: submitted.attachments, ratioId, quantity });
    setPrompt("");
    setAttachments([]);
    running
      .catch((error) => {
        setNotice(error instanceof Error ? error.message : "生成失败");
        setPrompt((current) => (current.trim() ? current : submitted.prompt));
        setAttachments((current) => (current.length ? current : submitted.attachments));
      })
      .finally(() => setPendingCount((count) => Math.max(0, count - 1)));
  };

  const handleUseAsAttachment = (result: GeneratedResult) => {
    setAttachments((current) => {
      if (current.some((item) => item.previewUrl === result.imageUrl)) return current;
      return [
        ...current,
        { id: `att-result-${result.id}`, name: result.title, previewUrl: result.imageUrl, usage: "reference" as AttachmentUsage },
      ].slice(0, MAX_ATTACHMENTS);
    });
    setNotice(`已把「${result.title}」加入参考，可继续在描述里说明怎么改。`);
  };

  /** 画布上的图 →（简易模式的）参考图。和「放到画布」正好互为一对。 */
  const handleSendCanvasImageToSimple = useCallback(
    (image: { url: string; name: string; annotated?: boolean }) => {
      let added = false;
      setAttachments((current) => {
        if (current.length >= MAX_ATTACHMENTS) return current;
        if (current.some((item) => item.previewUrl === image.url)) return current;
        added = true;
        return [
          ...current,
          {
            id: `att-canvas-${Date.now().toString(36)}`,
            name: image.name,
            previewUrl: image.url,
            usage: (image.annotated ? "merge" : "reference") as AttachmentUsage,
            annotated: image.annotated,
          },
        ];
      });
      // setState 的回调是同步跑的，这里已经能知道结果了。
      setNotice(
        added
          ? `已加到简易模式的参考图${image.annotated ? "（带标注，按入画使用）" : ""}，切到「简易」就能看到。`
          : `简易模式的参考图最多 ${MAX_ATTACHMENTS} 张，或这张已经在里面了。`,
      );
    },
    [setAttachments],
  );

  const handleSendResultToCanvas = (result: GeneratedResult) => {
    setPendingImages((current) => [...current, { id: result.id, url: result.imageUrl, name: result.title }]);
    onLayoutChange("canvas");
  };

  /* ── 画布 ─────────────────────────────────────────────────────────────────── */

  const handleCanvasGenerate = useCallback(
    (input: CanvasGenerateInput) =>
      onGenerate({ prompt: input.prompt, attachments: input.attachments, ratioId: input.ratioId, quantity: 1, intent: input.intent }),
    [onGenerate],
  );

  const handlePendingConsumed = useCallback(
    (ids: string[]) => setPendingImages((current) => current.filter((item) => !ids.includes(item.id))),
    [],
  );

  return (
    <main className="workspace free-workspace">
      {layout === "simple" ? (
        <div className="free-body panel-scroll">
          <ProviderBanner apiConfig={apiConfig} />
          <SimpleComposer
            prompt={prompt}
            attachments={attachments}
            ratioId={ratioId}
            quantity={quantity}
            cost={simpleCost}
            credits={credits}
            pendingCount={pendingCount}
            submissions={submissions}
            notice={notice}
            results={results}
            onPromptChange={(value) => {
              setPrompt(value);
              setNotice("");
            }}
            onClear={() => {
              setPrompt("");
              setAttachments([]);
              setNotice("");
            }}
            onAddFiles={handleAddFiles}
            onUsageChange={(id, usage) =>
              setAttachments((current) => current.map((item) => (item.id === id ? { ...item, usage } : item)))
            }
            onRemoveAttachment={(id) => setAttachments((current) => current.filter((item) => item.id !== id))}
            onRatioChange={setRatioId}
            onQuantityChange={setQuantity}
            onGenerate={handleSimpleGenerate}
            onUseAsAttachment={handleUseAsAttachment}
            onSendToCanvas={handleSendResultToCanvas}
            onDeleteResult={onDeleteResult}
            onOpenAccount={onOpenAccount}
          />
        </div>
      ) : (
        <div className="free-body free-body-canvas">
          <ProviderBanner apiConfig={apiConfig} compact />
          <ErrorBoundary
            scope="canvas"
            title="画布没能打开"
            hint="画布的内容存在这台电脑的浏览器里，刷新不会丢。实在起不来可以清掉本机画布内容重来。"
            actions={() => (
              <>
                <button type="button" className="btn btn-secondary" onClick={() => onLayoutChange("simple")}>
                  改用简易模式
                </button>
                <button
                  type="button"
                  className="btn btn-danger"
                  onClick={async () => {
                    await resetCanvasStore();
                    window.location.reload();
                  }}
                >
                  清空本机画布内容
                </button>
              </>
            )}
          >
            <Suspense
              fallback={
                <div className="canvas-loading" aria-live="polite">
                  <span aria-hidden="true">◇</span>
                  <strong>正在打开画布…</strong>
                </div>
              }
            >
              <CanvasBoard
                costFor={canvasCostFor}
                credits={credits}
                results={results}
                pendingImages={pendingImages}
                onGenerate={handleCanvasGenerate}
                onPendingConsumed={handlePendingConsumed}
                onNotice={setNotice}
                onSendToSimple={handleSendCanvasImageToSimple}
              />
            </Suspense>
          </ErrorBoundary>
          {notice ? (
            <div className="free-canvas-notice" role="alert">
              <span>{notice}</span>
              <button type="button" onClick={() => setNotice("")} aria-label="关闭提示">
                ×
              </button>
            </div>
          ) : null}
        </div>
      )}
    </main>
  );
}
