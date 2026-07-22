import { Lightbulb, WandSparkles } from "lucide-react";
import type { GenerationMode, ModeKey } from "../types";
import { Button } from "./ui";

interface PromptComposerProps {
  mode: GenerationMode;
  prompt: string;
  optimizationNotice?: string;
  onPromptChange: (prompt: string) => void;
  onOptimize: () => void;
}

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

export function PromptComposer({
  mode,
  prompt,
  optimizationNotice,
  onPromptChange,
  onOptimize,
}: PromptComposerProps) {
  const addSuggestion = (suggestion: string) => {
    if (prompt.includes(suggestion)) return;
    const separator = prompt.trim().length > 0 && !/[，。；,.!?！？]$/.test(prompt.trim()) ? "，" : "";
    onPromptChange(`${prompt.trim()}${separator}${suggestion}`);
  };

  return (
    <section className="section flow-section prompt-section" aria-labelledby="prompt-heading">
      <header className="flow-section-head">
        <span className="flow-step-index" aria-hidden="true">3</span>
        <div className="flow-section-copy">
          <span className="flow-kicker">描述效果</span>
          <h2 id="prompt-heading" aria-label="提示词">告诉 AI 你想要的画面</h2>
          <p>像和摄影师沟通一样，说明主体、场景或风格即可，不需要学习专业写法。</p>
        </div>
        <Button className="prompt-optimize" icon={<WandSparkles size={15} />} onClick={onOptimize}>
          帮我完善
        </Button>
      </header>

      <div className="prompt-composer-body">
        <label className="prompt-input-wrap">
          <span className="sr-only">画面描述</span>
          <textarea
            aria-label="画面描述"
            value={prompt}
            onChange={(event) => onPromptChange(event.target.value)}
            placeholder={mode.promptStarter}
            rows={6}
          />
          <span className="prompt-count">{prompt.trim().length} 字</span>
        </label>

        <div className="prompt-suggestions" aria-label="描述建议">
          <span><Lightbulb size={14} aria-hidden="true" /> 快速补充</span>
          <div>
            {promptSuggestions[mode.id].map((suggestion) => (
              <button
                type="button"
                className={prompt.includes(suggestion) ? "selected" : ""}
                aria-pressed={prompt.includes(suggestion)}
                key={suggestion}
                onClick={() => addSuggestion(suggestion)}
              >
                {suggestion}
              </button>
            ))}
          </div>
        </div>
      </div>

      {optimizationNotice ? <p className="prompt-notice" aria-live="polite">{optimizationNotice}</p> : null}
    </section>
  );
}
