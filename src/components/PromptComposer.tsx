import type { KeyboardEvent } from "react";
import { roleLabels } from "../data/catalog";
import type { GenerationMode, ModeKey, ReferenceImage } from "../types";

const promptSuggestions: Record<ModeKey, string[]> = {
  text: ["干净棚拍", "突出面料质感", "高级电商风格"],
  free: ["自然光线", "细节清晰", "有故事感的构图"],
  tryon: ["保留人物长相", "衣服版型准确", "自然站姿"],
  fusion: ["融合自然", "保持主体一致", "统一光线与色调"],
  campaign: ["品牌大片质感", "预留文案空间", "适合社媒投放"],
  product: ["纯净背景", "正面完整展示", "保留真实颜色"],
  fabric: ["可无缝平铺", "纹理细节清晰", "适合服装生产"],
  lookbook: ["系列感统一", "自然搭配层次", "杂志编辑风格"],
};

interface PromptComposerProps {
  mode: GenerationMode;
  prompt: string;
  references: ReferenceImage[];
  optimizationNotice?: string;
  statusMessage: string;
  statusBlocked?: boolean;
  generateLabel: string;
  generateDisabled: boolean;
  onPromptChange: (prompt: string) => void;
  onOptimize: () => void;
  onGenerate: () => void;
  hoveredId?: string;
  onHover?: (id: string) => void;
  registerTokenEl?: (id: string, element: HTMLElement | null) => void;
}

export function PromptComposer({
  mode,
  prompt,
  references,
  optimizationNotice,
  statusMessage,
  statusBlocked = false,
  generateLabel,
  generateDisabled,
  onPromptChange,
  onOptimize,
  onGenerate,
  hoveredId = "",
  onHover,
  registerTokenEl,
}: PromptComposerProps) {
  const filledReferences = references.filter((reference) => Boolean(reference.previewUrl));

  const addSuggestion = (suggestion: string) => {
    if (prompt.includes(suggestion)) return;
    const trimmed = prompt.trim();
    const separator = trimmed.length > 0 && !/[，。；,.!?！？]$/.test(trimmed) ? "，" : "";
    onPromptChange(`${trimmed}${separator}${suggestion}`);
  };

  const insertToken = (reference: ReferenceImage) => {
    const token = `参考${reference.label}`;
    if (prompt.includes(token)) return;
    const trimmed = prompt.trim();
    onPromptChange(`${trimmed}${trimmed ? "，" : ""}${token}`);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      event.preventDefault();
      if (!generateDisabled) onGenerate();
    }
  };

  return (
    <section className="prompt-dock prompt-section" aria-labelledby="prompt-heading">
      <div className="prompt-dock-head">
        <span className="rail-kicker" id="prompt-heading">画面描述</span>
        <div className="prompt-tokens">
          {filledReferences.map((reference) => (
            <button
              type="button"
              key={reference.id}
              className={`prompt-token ${hoveredId === reference.id ? "active" : ""}`}
              ref={(node) => registerTokenEl?.(reference.id, node)}
              title="插入到描述"
              onClick={() => insertToken(reference)}
              onPointerEnter={() => onHover?.(reference.id)}
              onPointerLeave={() => onHover?.("")}
            >
              参考{reference.label} · {roleLabels[reference.role]}
            </button>
          ))}
        </div>
      </div>

      <div className="prompt-dock-row">
        <label className="prompt-input-wrap">
          <span className="sr-only">画面描述</span>
          <textarea
            aria-label="画面描述"
            value={prompt}
            rows={2}
            placeholder={mode.promptStarter}
            onChange={(event) => onPromptChange(event.target.value)}
            onKeyDown={handleKeyDown}
          />
          <span className="prompt-count">{prompt.trim().length} 字</span>
        </label>

        <div className="prompt-footer">
          <button type="button" className="btn btn-secondary prompt-optimize" onClick={onOptimize}>
            帮我完善描述
          </button>
          <button
            type="button"
            className="btn btn-primary prompt-generate"
            onClick={onGenerate}
            disabled={generateDisabled}
          >
            {generateLabel}
          </button>
        </div>
      </div>

      <div className="prompt-dock-foot">
        <div className="prompt-suggestions" aria-label="描述建议">
          {promptSuggestions[mode.id].map((suggestion) => (
            <button
              type="button"
              key={suggestion}
              className={`chip ${prompt.includes(suggestion) ? "selected" : ""}`}
              aria-pressed={prompt.includes(suggestion)}
              onClick={() => addSuggestion(suggestion)}
            >
              {suggestion}
            </button>
          ))}
        </div>
        <span className={`prompt-status ${statusBlocked ? "blocked" : ""}`} aria-live="polite">
          {optimizationNotice || statusMessage}
        </span>
      </div>
    </section>
  );
}
