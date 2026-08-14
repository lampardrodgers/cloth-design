import { generationModes } from "../data/catalog";
import type { ModeKey } from "../types";

interface ModePickerProps {
  activeMode: ModeKey;
  onChange: (mode: ModeKey) => void;
}

/** 每个用途的一句话结果承诺，出现在功能名下方，让不懂参数的用户也能选对。 */
const modeOutcome: Record<ModeKey, string> = {
  text: "一句话开始",
  free: "不限题材",
  tryon: "真人换装",
  fusion: "多图合成",
  campaign: "品牌大片",
  product: "电商主图",
  fabric: "面料纹理",
  lookbook: "系列搭配",
};

export function ModePicker({ activeMode, onChange }: ModePickerProps) {
  return (
    <div className="mode-strip" role="radiogroup" aria-label="功能选择">
      <span className="mode-strip-label">用途</span>
      {generationModes.map((mode) => {
        const selected = activeMode === mode.id;
        return (
          <button
            type="button"
            role="radio"
            aria-checked={selected}
            key={mode.id}
            title={mode.description}
            className={`mode-pill ${selected ? "active" : ""}`}
            onClick={() => onChange(mode.id)}
          >
            <strong>{mode.shortTitle}</strong>
            <small>{modeOutcome[mode.id]}</small>
          </button>
        );
      })}
    </div>
  );
}
