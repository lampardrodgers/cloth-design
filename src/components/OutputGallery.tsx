import { Download, ImageDown, RotateCw, Send, Trash2 } from "lucide-react";
import type { GeneratedResult, ReferenceImage } from "../types";
import { Button, Section } from "./ui";

interface OutputGalleryProps {
  results: GeneratedResult[];
  onUseAsReference: (result: GeneratedResult) => void;
  onSync: (id: string) => void;
  onDelete: (id: string) => void;
}

export function OutputGallery({ results, onUseAsReference, onSync, onDelete }: OutputGalleryProps) {
  return (
    <Section title="出图" action={<span className="gallery-count">{results.length} 张</span>} className="gallery-section">
      {results.length === 0 ? (
        <div className="empty-gallery">
          <ImageDown size={32} />
          <strong>等待生成</strong>
          <span>图片完成后可继续编辑、下载或存入 WebDAV。</span>
        </div>
      ) : (
        <div className="gallery-grid">
          {results.map((result) => (
            <article className="result-card" key={result.id}>
              <img src={result.imageUrl} alt={result.title} />
              <div className="result-meta">
                <div>
                  <strong>{result.title}</strong>
                  <span>{result.ratioLabel} · {result.storageStatus}</span>
                </div>
                <span>{result.credits} 分</span>
              </div>
              <div className="result-actions">
                <Button icon={<RotateCw size={14} />} onClick={() => onUseAsReference(result)}>继续</Button>
                <Button icon={<Send size={14} />} onClick={() => onSync(result.id)}>WebDAV</Button>
                <a className="icon-button" href={result.imageUrl} download={`${result.title}.svg`} aria-label="下载">
                  <Download size={15} />
                </a>
                <button className="icon-button" onClick={() => onDelete(result.id)} aria-label="删除">
                  <Trash2 size={15} />
                </button>
              </div>
            </article>
          ))}
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
    fileName: `${result.title}.svg`,
    previewUrl: result.imageUrl,
  };
}
