import { useEffect, useMemo, useState } from "react";
import { Download, ImageDown, RotateCw, Send, Trash2 } from "lucide-react";
import { imageQualityLabel, imageQualitySummary } from "../lib/imageQuality";
import { resultFileName } from "../lib/resultFiles";
import type { GeneratedResult, ReferenceImage } from "../types";
import { Button, Section } from "./ui";

interface OutputGalleryProps {
  results: GeneratedResult[];
  onUseAsReference: (result: GeneratedResult) => void;
  onSync: (id: string) => void;
  onDelete: (id: string) => void;
}

export function OutputGallery({ results, onUseAsReference, onSync, onDelete }: OutputGalleryProps) {
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
    <Section title="出图" action={<span className="gallery-count">{results.length} 张</span>} className="gallery-section">
      {!selectedResult ? (
        <div className="empty-gallery">
          <ImageDown size={32} />
          <strong>等待生成</strong>
          <span>图片完成后可继续编辑、下载或存入 WebDAV。</span>
        </div>
      ) : (
        <div className="gallery-stage">
          <article className="result-card">
            <img src={selectedResult.imageUrl} alt={selectedResult.title} />
            <div className="result-meta">
              <div>
                <strong>{selectedResult.title}</strong>
                <span>{selectedResult.ratioLabel} · {selectedResult.storageStatus}</span>
              </div>
              <span>{selectedResult.credits} 分</span>
            </div>
            <div className={`result-quality quality-${selectedResult.qualityGate?.status ?? "unknown"}`}>
              <span>{imageQualityLabel(selectedResult.qualityGate)}</span>
              <small>{imageQualitySummary({ qualityGate: selectedResult.qualityGate, imageInspection: selectedResult.imageInspection })}</small>
            </div>
            <div className="result-actions">
              <Button icon={<RotateCw size={14} />} onClick={() => onUseAsReference(selectedResult)}>继续</Button>
              <Button icon={<Send size={14} />} onClick={() => onSync(selectedResult.id)}>WebDAV</Button>
              <a className="icon-button" href={selectedResult.imageUrl} download={resultFileName(selectedResult)} aria-label="下载">
                <Download size={15} />
              </a>
              <button className="icon-button" onClick={() => onDelete(selectedResult.id)} aria-label="删除">
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
              >
                <img src={result.imageUrl} alt="" />
                <span>{result.storageStatus}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </Section>
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
