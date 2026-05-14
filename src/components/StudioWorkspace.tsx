import { useMemo } from "react";
import { AlertTriangle } from "lucide-react";
import { generationModes, ratioOptions, roleLabels } from "../data/catalog";
import { estimateCredits } from "../lib/costing";
import type { CreditPolicy, GeneratedResult, GenerationMode, ReferenceImage, StudioSettings, UserAccount } from "../types";
import { ModePicker } from "./ModePicker";
import { OutputGallery, resultToReference } from "./OutputGallery";
import { ParameterPanel } from "./ParameterPanel";
import { PromptComposer } from "./PromptComposer";
import { ReferencePanel } from "./ReferencePanel";

interface StudioWorkspaceProps {
  settings: StudioSettings;
  prompt: string;
  references: ReferenceImage[];
  results: GeneratedResult[];
  user: UserAccount;
  creditPolicy: CreditPolicy;
  optimizationNotice?: string;
  onSettingsChange: (patch: Partial<StudioSettings>) => void;
  onPromptChange: (prompt: string) => void;
  onReferencesChange: (references: ReferenceImage[]) => void;
  onOptimize: () => void;
  onGenerate: (mode: GenerationMode, cost: number) => void;
  onUseAsReference: (references: ReferenceImage[]) => void;
  onSyncResult: (id: string) => void;
  onDeleteResult: (id: string) => void;
}

export function StudioWorkspace({
  settings,
  prompt,
  references,
  results,
  user,
  creditPolicy,
  optimizationNotice,
  onSettingsChange,
  onPromptChange,
  onReferencesChange,
  onOptimize,
  onGenerate,
  onUseAsReference,
  onSyncResult,
  onDeleteResult,
}: StudioWorkspaceProps) {
  const mode = generationModes.find((item) => item.id === settings.mode) ?? generationModes[0];
  const cost = useMemo(() => estimateCredits(mode, settings, references, creditPolicy), [mode, references, settings]);
  const ratio = ratioOptions.find((item) => item.id === settings.ratioId) ?? ratioOptions[0];
  const missingRoles = mode.requiredRefs.filter((role) => !references.some((ref) => ref.role === role && ref.previewUrl));
  const missingRoleText = missingRoles.map((role) => roleLabels[role]).join(" / ");
  const canGenerate = missingRoles.length === 0 && cost <= user.credits && ratio.allowedResolutions.includes(settings.resolution);

  const useResult = (result: GeneratedResult) => {
    const nextLabel = references.length < 26 ? "ABCDEFGHIJKLMNOPQRSTUVWXYZ"[references.length] : `${references.length + 1}`;
    onUseAsReference([...references, resultToReference(result, nextLabel)]);
  };

  return (
    <main className="workspace">
      <div className="left-panel panel-scroll">
        <ModePicker activeMode={settings.mode} onChange={(modeId) => onSettingsChange({ mode: modeId })} />
        <ReferencePanel references={references} onChange={onReferencesChange} />
      </div>

      <div className="center-panel panel-scroll">
        <PromptComposer
          mode={mode}
          prompt={prompt}
          cost={cost}
          canGenerate={canGenerate}
          optimizationNotice={optimizationNotice}
          onPromptChange={onPromptChange}
          onOptimize={onOptimize}
          onGenerate={() => onGenerate(mode, cost)}
        />
        {!canGenerate ? (
          <div className="inline-warning">
            <AlertTriangle size={16} />
            <span>
              {missingRoles.length > 0
                ? `缺少 ${missingRoleText} 参考图`
                : cost > user.credits
                  ? "积分不足"
                : "当前分辨率不支持该比例"}
            </span>
          </div>
        ) : null}
        <ParameterPanel settings={settings} onChange={onSettingsChange} />
      </div>

      <div className="right-panel panel-scroll">
        <OutputGallery results={results} onUseAsReference={useResult} onSync={onSyncResult} onDelete={onDeleteResult} />
      </div>
    </main>
  );
}
