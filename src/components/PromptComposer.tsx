import { WandSparkles } from "lucide-react";
import type { GenerationMode } from "../types";
import { Button, Section } from "./ui";

interface PromptComposerProps {
  mode: GenerationMode;
  prompt: string;
  cost: number;
  canGenerate: boolean;
  optimizationNotice?: string;
  onPromptChange: (prompt: string) => void;
  onOptimize: () => void;
  onGenerate: () => void;
}

export function PromptComposer({
  mode,
  prompt,
  cost,
  canGenerate,
  optimizationNotice,
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
      {optimizationNotice ? <p className="prompt-notice">{optimizationNotice}</p> : null}
    </Section>
  );
}
