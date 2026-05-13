import { generationModes } from "../data/catalog";
import type { ModeKey } from "../types";

interface ModePickerProps {
  activeMode: ModeKey;
  onChange: (mode: ModeKey) => void;
}

export function ModePicker({ activeMode, onChange }: ModePickerProps) {
  return (
    <div className="mode-strip" aria-label="功能选择">
      {generationModes.map((mode) => (
        <button
          type="button"
          key={mode.id}
          className={`mode-pill ${activeMode === mode.id ? "active" : ""}`}
          onClick={() => onChange(mode.id)}
        >
          <strong>{mode.shortTitle}</strong>
          <span>{mode.action}</span>
        </button>
      ))}
    </div>
  );
}
