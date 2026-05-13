import { WandSparkles } from "lucide-react";
import type { GenerationMode, StudioSettings } from "../types";
import { Button, Section } from "./ui";

interface PromptComposerProps {
  mode: GenerationMode;
  prompt: string;
  optimizedPrompt: string;
  settings: StudioSettings;
  cost: number;
  canGenerate: boolean;
  onPromptChange: (prompt: string) => void;
  onOptimize: () => void;
  onGenerate: () => void;
}

export function PromptComposer({
  mode,
  prompt,
  optimizedPrompt,
  cost,
  canGenerate,
  onPromptChange,
  onOptimize,
  onGenerate,
}: PromptComposerProps) {
  return (
    <Section
      title="提示词"
      action={<Button icon={<WandSparkles size={15} />} onClick={onOptimize}>优化</Button>}
      className="prompt-section"
    >
      <textarea
        value={prompt}
        onChange={(event) => onPromptChange(event.target.value)}
        placeholder={mode.promptStarter}
        rows={6}
      />
      <div className="prompt-footer">
        <span>预计 {cost} 积分</span>
        <Button variant="primary" onClick={onGenerate} disabled={!canGenerate}>
          生成
        </Button>
      </div>
      <div className="optimized-box">
        <strong>系统提示词</strong>
        <p>{optimizedPrompt}</p>
      </div>
    </Section>
  );
}
