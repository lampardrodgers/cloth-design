import { useEffect, useMemo, useState } from "react";
import { Download, ImageDown, LoaderCircle, RotateCw, Send, Sparkles, Trash2 } from "lucide-react";
import { imageQualityLabel, imageQualitySummary } from "../lib/imageQuality";
import { resultFileName } from "../lib/resultFiles";
import type { GeneratedResult, ReferenceImage, StorageStatus } from "../types";
import { Button } from "./ui";

interface OutputGalleryProps {
  results: GeneratedResult[];
  isGenerating?: boolean;
  onUseAsReference: (result: GeneratedResult) => void;
  onSync: (id: string) => void;
  onDelete: (id: string) => void;
}

const storageStatusLabels: Record<StorageStatus, string> = {
  "local-cache": "本地暂存",
  "cloud-temp": "云端暂存",
  webdav: "已保存到云盘",
  expired: "文件已过期",
};

export function OutputGallery({ results, isGenerating = false, onUseAsReference, onSync, onDelete }: OutputGalleryProps) {
  const [selectedId, setSelectedId] = useState<string | null>(results[0]?.id ?? null);
  const selectedResult = useMemo(
    () => results.find((result) => result.id === selectedId) ?? results[0],
    [results, selectedId],
  );

  useEffect(() => {
    if (!results.length) {
      setSelectedId(null);
      return;
    }
    if (!selectedId || !results.some((result) => result.id === selectedId)) {
      setSelectedId(results[0].id);
    }
  }, [results, selectedId]);

  return (
    <section className="section gallery-section" aria-labelledby="gallery-heading" aria-busy={isGenerating}>
      <header className="gallery-head">
        <div>
          <span className="flow-kicker">创作结果</span>
          <h2 id="gallery-heading" aria-label="出图">成片预览</h2>
        </div>
        <span className="gallery-count">{results.length} 张</span>
      </header>

      {!selectedResult ? (
        <div className={`empty-gallery ${isGenerating ? "is-generating" : ""}`} aria-live="polite">
          <span className="empty-gallery-icon" aria-hidden="true">
            {isGenerating ? <LoaderCircle className="spin" size={30} /> : <ImageDown size={30} />}
          </span>
          <strong>{isGenerating ? "正在为你生成成片" : "你的成片会出现在这里"}</strong>
          <p>
            {isGenerating
              ? "可以先继续浏览当前设置，完成后会自动显示结果。"
              : "完成左侧的用途、素材和画面描述后，点击“开始生成”即可。"}
          </p>
          {!isGenerating ? (
            <ol className="empty-gallery-steps">
              <li><span>1</span> 选择用途</li>
              <li><span>2</span> 准备素材</li>
              <li><span>3</span> 描述并生成</li>
            </ol>
          ) : null}
        </div>
      ) : (
        <div className="gallery-stage">
          <article className="result-card">
            <div className="result-image-wrap">
              <img src={selectedResult.imageUrl} alt={selectedResult.title} />
              <span className="result-ready-badge"><Sparkles size={13} /> 成片已就绪</span>
            </div>
            <div className="result-meta">
              <div>
                <strong>{selectedResult.title}</strong>
                <span>
                  {selectedResult.ratioLabel} · {storageStatusLabels[selectedResult.storageStatus]}
                  <span className="sr-only"> · {selectedResult.storageStatus}</span>
                </span>
              </div>
              <span>{selectedResult.credits} 积分</span>
            </div>
            <div className={`result-quality quality-${selectedResult.qualityGate?.status ?? "unknown"}`}>
              <span>{imageQualityLabel(selectedResult.qualityGate)}</span>
              <small>{imageQualitySummary({ qualityGate: selectedResult.qualityGate, imageInspection: selectedResult.imageInspection })}</small>
            </div>
            <div className="result-actions">
              <Button aria-label="继续" icon={<RotateCw size={14} />} onClick={() => onUseAsReference(selectedResult)}>
                以此图继续编辑
              </Button>
              <Button aria-label="WebDAV" icon={<Send size={14} />} onClick={() => onSync(selectedResult.id)}>
                保存到云盘
              </Button>
              <a
                className="btn btn-secondary result-download"
                href={selectedResult.imageUrl}
                download={resultFileName(selectedResult)}
                aria-label="下载"
              >
                <Download size={15} />
                <span>下载</span>
              </a>
              <button className="icon-button result-delete" onClick={() => onDelete(selectedResult.id)} aria-label="删除">
                <Trash2 size={15} />
              </button>
            </div>
          </article>
          <div className="thumbnail-strip" aria-label="出图缩略图">
            {results.map((result) => (
              <button
                type="button"
                className={`result-thumb ${selectedResult.id === result.id ? "active" : ""}`}
                key={result.id}
                onClick={() => setSelectedId(result.id)}
                aria-label={`查看 ${result.title}`}
                aria-pressed={selectedResult.id === result.id}
              >
                <img src={result.imageUrl} alt="" />
                <span>{storageStatusLabels[result.storageStatus]}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </section>
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
