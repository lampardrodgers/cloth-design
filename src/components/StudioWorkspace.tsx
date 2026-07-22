import { useMemo } from "react";
import { AlertTriangle, Check, CircleDollarSign, LoaderCircle, Sparkles } from "lucide-react";
import { generationModes, ratioOptions, roleLabels } from "../data/catalog";
import { estimateCredits } from "../lib/costing";
import type { CreditPolicy, GeneratedResult, GenerationMode, ReferenceImage, StudioSettings, UserAccount } from "../types";
import { Button } from "./ui";
import { ModePicker } from "./ModePicker";
import { OutputGallery, resultToReference } from "./OutputGallery";
import { ParameterPanel } from "./ParameterPanel";
import { PromptComposer } from "./PromptComposer";
import { ReferencePanel } from "./ReferencePanel";

const referenceAlphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");

function nextReferenceLabel(references: ReferenceImage[]) {
  const used = new Set(references.map((item) => item.label));
  return referenceAlphabet.find((label) => !used.has(label)) ?? `${references.length + 1}`;
}

interface StudioWorkspaceProps {
  settings: StudioSettings;
  prompt: string;
  references: ReferenceImage[];
  results: GeneratedResult[];
  user: UserAccount;
  creditPolicy: CreditPolicy;
  optimizationNotice?: string;
  isGenerating?: boolean;
  onSettingsChange: (patch: Partial<StudioSettings>) => void;
  onPromptChange: (prompt: string) => void;
  onReferencesChange: (references: ReferenceImage[]) => void;
  onOptimize: () => void;
  onGenerate: (mode: GenerationMode, cost: number) => void;
  onUseAsReference: (references: ReferenceImage[]) => void;
  onSyncResult: (id: string) => void;
  onDeleteResult: (id: string) => void;
  onOpenAccount: () => void;
}

export function StudioWorkspace({
  settings,
  prompt,
  references,
  results,
  user,
  creditPolicy,
  optimizationNotice,
  isGenerating = false,
  onSettingsChange,
  onPromptChange,
  onReferencesChange,
  onOptimize,
  onGenerate,
  onUseAsReference,
  onSyncResult,
  onDeleteResult,
  onOpenAccount,
}: StudioWorkspaceProps) {
  const mode = generationModes.find((item) => item.id === settings.mode) ?? generationModes[0];
  const cost = useMemo(() => estimateCredits(mode, settings, references, creditPolicy), [mode, references, settings, creditPolicy]);
  const ratio = ratioOptions.find((item) => item.id === settings.ratioId) ?? ratioOptions[0];
  const missingRoles = mode.requiredRefs.filter((role) => !references.some((reference) => reference.role === role && reference.previewUrl));
  const missingRoleText = missingRoles.map((role) => roleLabels[role]).join("、");
  const ratioAllowed = ratio.allowedResolutions.includes(settings.resolution);
  const hasEnoughCredits = cost <= user.credits;
  const baseCanGenerate = missingRoles.length === 0 && hasEnoughCredits && ratioAllowed;
  const canGenerate = baseCanGenerate && !isGenerating;
  const readinessSteps = [
    { label: "用途", ready: true },
    { label: mode.requiredRefs.length > 0 ? "必需素材" : "素材可选", ready: missingRoles.length === 0 },
    { label: "画面描述", ready: prompt.trim().length > 0 },
  ];
  const readyCount = readinessSteps.filter((step) => step.ready).length;

  const blockingMessage = isGenerating
    ? "正在生成上一批成片，请稍候"
    : missingRoles.length > 0
      ? `还需上传：${missingRoleText}`
      : !hasEnoughCredits
        ? `当前有 ${user.credits} 积分，本次预计需要 ${cost} 积分`
        : !ratioAllowed
          ? "当前清晰度不支持所选画面比例"
          : "已准备好，可以开始生成";

  const useResult = (result: GeneratedResult) => {
    const nextLabel = nextReferenceLabel(references);
    onUseAsReference([...references, resultToReference(result, nextLabel)]);
  };

  return (
    <main className="workspace studio-workspace">
      <header className="studio-hero">
        <div className="studio-hero-copy">
          <span className="studio-eyebrow"><Sparkles size={14} /> AI 服装创作台</span>
          <h1>从一个想法，快速得到可用成片</h1>
          <p>按顺序完成下面几步。常用设置已经替你选好，不懂参数也能直接开始。</p>
        </div>
        <div className="studio-readiness" aria-label={`创作准备进度 ${readyCount} / ${readinessSteps.length}`}>
          <div className="studio-readiness-head">
            <span>准备进度</span>
            <strong>{readyCount}/{readinessSteps.length}</strong>
          </div>
          <div className="studio-readiness-track" aria-hidden="true">
            <span style={{ width: `${(readyCount / readinessSteps.length) * 100}%` }} />
          </div>
          <div className="studio-readiness-steps">
            {readinessSteps.map((step) => (
              <span className={step.ready ? "ready" : ""} key={step.label}>
                <Check size={12} aria-hidden="true" /> {step.label}
              </span>
            ))}
          </div>
        </div>
      </header>

      <div className="studio-layout">
        <div className="creation-panel panel-scroll">
          <ModePicker activeMode={settings.mode} onChange={(modeId) => onSettingsChange({ mode: modeId })} />
          <ReferencePanel
            references={references}
            requiredRefs={mode.requiredRefs}
            recommendedRefs={mode.recommendedRefs}
            onChange={onReferencesChange}
          />
          <PromptComposer
            mode={mode}
            prompt={prompt}
            optimizationNotice={optimizationNotice}
            onPromptChange={onPromptChange}
            onOptimize={onOptimize}
          />
          <ParameterPanel settings={settings} onChange={onSettingsChange} />

          <div className={`generation-bar ${canGenerate ? "ready" : "blocked"}`}>
            <div className="generation-status" aria-live="polite">
              <span className="generation-status-icon" aria-hidden="true">
                {isGenerating ? <LoaderCircle className="spin" size={20} /> : baseCanGenerate ? <Check size={20} /> : <AlertTriangle size={20} />}
              </span>
              <div>
                <strong>{blockingMessage}</strong>
                <span>预计消耗 {cost} 积分 · 生成 {settings.quantity} 张</span>
              </div>
            </div>

            {!hasEnoughCredits && missingRoles.length === 0 ? (
              <Button variant="primary" icon={<CircleDollarSign size={17} />} onClick={onOpenAccount}>
                获取积分后生成
              </Button>
            ) : (
              <div className="prompt-footer">
                <span className="sr-only">预计 {cost} 积分</span>
                <Button
                  variant="primary"
                  aria-label="生成"
                  icon={isGenerating ? <LoaderCircle className="spin" size={17} /> : <Sparkles size={17} />}
                  onClick={() => onGenerate(mode, cost)}
                  disabled={!canGenerate}
                >
                  {isGenerating ? "正在生成" : `开始生成 ${settings.quantity} 张`}
                </Button>
              </div>
            )}
          </div>
        </div>

        <aside className="preview-panel panel-scroll" aria-label="成片结果">
          <OutputGallery
            results={results}
            isGenerating={isGenerating}
            onUseAsReference={useResult}
            onSync={onSyncResult}
            onDelete={onDeleteResult}
          />
        </aside>
      </div>
    </main>
  );
}
