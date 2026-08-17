import { useRef, type DragEvent } from "react";
import { attachmentUsageHints, attachmentUsageLabels, MAX_ATTACHMENTS } from "../lib/freeStudio";
import type { AttachmentUsage, FreeAttachment } from "../types";

interface AttachmentStripProps {
  attachments: FreeAttachment[];
  onAddFiles: (files: File[]) => void;
  onUsageChange: (id: string, usage: AttachmentUsage) => void;
  onRemove: (id: string) => void;
  max?: number;
  disabled?: boolean;
  emptyHint?: string;
}

/**
 * 附件条：一次可以传多张图，每张单独选「参考」还是「入画」。
 * 简易模式和画布里的生成面板共用同一套交互，避免两处出现不同的上传规则。
 */
export function AttachmentStrip({
  attachments,
  onAddFiles,
  onUsageChange,
  onRemove,
  max = MAX_ATTACHMENTS,
  disabled = false,
  emptyHint = "可选：上传参考图，或上传必须出现在成片里的图片",
}: AttachmentStripProps) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const full = attachments.length >= max;

  const pickFiles = (fileList: FileList | null) => {
    const images = Array.from(fileList ?? []).filter((file) => file.type.startsWith("image/"));
    if (images.length) onAddFiles(images);
  };

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    if (disabled || full) return;
    pickFiles(event.dataTransfer.files);
  };

  return (
    <div
      className={`attachment-strip ${attachments.length ? "" : "attachment-strip-empty"}`}
      onDragOver={(event) => event.preventDefault()}
      onDrop={handleDrop}
    >
      <div className="attachment-strip-head">
        <span className="rail-kicker">附件</span>
        <small>
          {attachments.length}/{max} · {emptyHint}
        </small>
      </div>

      <div className="attachment-list">
        {attachments.map((attachment) => (
          <figure className={`attachment-card attachment-${attachment.usage}`} key={attachment.id}>
            <img src={attachment.previewUrl} alt={attachment.name} />
            <button
              type="button"
              className="icon-button attachment-remove"
              aria-label={`移除 ${attachment.name}`}
              disabled={disabled}
              onClick={() => onRemove(attachment.id)}
            >
              ×
            </button>
            <div className="attachment-usage" role="radiogroup" aria-label={`${attachment.name} 的用途`}>
              {(Object.keys(attachmentUsageLabels) as AttachmentUsage[]).map((usage) => (
                <button
                  type="button"
                  key={usage}
                  role="radio"
                  aria-checked={attachment.usage === usage}
                  className={attachment.usage === usage ? "active" : ""}
                  title={attachmentUsageHints[usage]}
                  disabled={disabled}
                  onClick={() => onUsageChange(attachment.id, usage)}
                >
                  {attachmentUsageLabels[usage]}
                </button>
              ))}
            </div>
            <figcaption title={attachment.name}>{attachment.name}</figcaption>
          </figure>
        ))}

        <button
          type="button"
          className="attachment-add"
          disabled={disabled || full}
          title={full ? `最多 ${max} 张` : "点击选择，或直接把图片拖进来"}
          onClick={() => inputRef.current?.click()}
        >
          <em>+</em>
          <span>{full ? `已达 ${max} 张` : "添加图片"}</span>
        </button>
      </div>

      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        multiple
        className="sr-only"
        aria-label="上传附件图片"
        onChange={(event) => {
          pickFiles(event.target.files);
          event.target.value = "";
        }}
      />
    </div>
  );
}
