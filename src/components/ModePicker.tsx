import {
  Blend,
  Image,
  Layers3,
  Megaphone,
  Shirt,
  Sparkles,
  SwatchBook,
  Type,
  type LucideIcon,
} from "lucide-react";
import { generationModes } from "../data/catalog";
import type { ModeKey } from "../types";

interface ModePickerProps {
  activeMode: ModeKey;
  onChange: (mode: ModeKey) => void;
}

const modeMeta: Record<ModeKey, { icon: LucideIcon; outcome: string }> = {
  text: { icon: Type, outcome: "从一句描述开始" },
  free: { icon: Sparkles, outcome: "自由表达创意" },
  tryon: { icon: Shirt, outcome: "真人快速换装" },
  fusion: { icon: Blend, outcome: "组合多张素材" },
  campaign: { icon: Megaphone, outcome: "制作品牌广告" },
  product: { icon: Image, outcome: "生成电商主图" },
  fabric: { icon: SwatchBook, outcome: "探索面料花型" },
  lookbook: { icon: Layers3, outcome: "生成系列搭配" },
};

export function ModePicker({ activeMode, onChange }: ModePickerProps) {
  const selectedMode = generationModes.find((mode) => mode.id === activeMode) ?? generationModes[0];

  return (
    <section className="section flow-section mode-picker-section" aria-labelledby="mode-picker-heading">
      <header className="flow-section-head">
        <span className="flow-step-index" aria-hidden="true">1</span>
        <div className="flow-section-copy">
          <span className="flow-kicker">选择用途</span>
          <h2 id="mode-picker-heading">这次想制作什么？</h2>
          <p>{selectedMode.description}</p>
        </div>
        <span className="flow-step-state">已选择</span>
      </header>

      <div className="mode-strip mode-grid" role="radiogroup" aria-label="功能选择">
        {generationModes.map((mode) => {
          const Icon = modeMeta[mode.id].icon;
          const selected = activeMode === mode.id;
          return (
            <button
              type="button"
              role="radio"
              aria-checked={selected}
              key={mode.id}
              className={`mode-pill ${selected ? "active" : ""}`}
              onClick={() => onChange(mode.id)}
            >
              <span className="mode-icon" aria-hidden="true"><Icon size={18} /></span>
              <span className="mode-copy">
                <strong>{mode.shortTitle}</strong>
                <small>{modeMeta[mode.id].outcome}</small>
              </span>
              <span className="mode-selected-dot" aria-hidden="true" />
            </button>
          );
        })}
      </div>
    </section>
  );
}
