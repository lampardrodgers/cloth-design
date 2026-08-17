import { useEffect, useMemo, useRef, useState } from "react";
import { generationModes, ratioOptions, roleLabels } from "../data/catalog";
import { estimateCredits } from "../lib/costing";
import { useStoredState } from "../lib/storedState";
import type {
  CreditPolicy,
  GeneratedResult,
  GenerationMode,
  ModeKey,
  ReferenceImage,
  StudioSettings,
  UserAccount,
} from "../types";
import type { ApiConfig } from "../lib/api";
import { ModePicker } from "./ModePicker";
import { ProviderBanner } from "./ProviderBanner";
import { ResultPanelList, ResultStage, resultToReference } from "./OutputGallery";
import { ParameterPanel } from "./ParameterPanel";
import { PromptComposer } from "./PromptComposer";

const referenceAlphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");

function nextReferenceLabel(references: ReferenceImage[]) {
  const used = new Set(references.map((item) => item.label));
  return referenceAlphabet.find((label) => !used.has(label)) ?? `${references.length + 1}`;
}

interface DeliveryPreset {
  id: string;
  label: string;
  detail: string;
  mode: ModeKey;
  patch: Partial<StudioSettings>;
}

/** 交付预设：一次点击套用「用途 + 成片设置」，避免逐项调整。 */
const deliveryPresets: DeliveryPreset[] = [
  {
    id: "product",
    label: "电商主图",
    detail: "1:1 · 高清 · PNG",
    mode: "product",
    patch: { ratioId: "1-1", resolution: "hd", quality: "high", outputFormat: "png", background: "opaque" },
  },
  {
    id: "campaign",
    label: "广告大片",
    detail: "3:2 · 标准 · JPEG",
    mode: "campaign",
    patch: { ratioId: "3-2", resolution: "native", quality: "high", outputFormat: "jpeg", background: "auto" },
  },
  {
    id: "fabric",
    label: "面料平铺",
    detail: "1:1 · 标准 · PNG",
    mode: "fabric",
    patch: { ratioId: "1-1", resolution: "native", quality: "medium", outputFormat: "png", background: "opaque" },
  },
  {
    id: "social",
    label: "社媒竖版",
    detail: "2:3 · 高清 · WebP",
    mode: "lookbook",
    patch: { ratioId: "2-3", resolution: "hd", quality: "high", outputFormat: "webp", background: "auto" },
  },
];

interface StudioWorkspaceProps {
  settings: StudioSettings;
  prompt: string;
  references: ReferenceImage[];
  results: GeneratedResult[];
  user: UserAccount;
  creditPolicy: CreditPolicy;
  optimizationNotice?: string;
  isGenerating?: boolean;
  apiConfig?: ApiConfig | null;
  hoveredReferenceId?: string;
  onHoverReference?: (id: string) => void;
  registerTokenEl?: (id: string, element: HTMLElement | null) => void;
  onSettingsChange: (patch: Partial<StudioSettings>) => void;
  onPromptChange: (prompt: string) => void;
  onReferencesChange: (references: ReferenceImage[]) => void;
  /** 清空描述和参考图，回到空白状态。 */
  onClear: () => void;
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
  apiConfig = null,
  hoveredReferenceId,
  onHoverReference,
  registerTokenEl,
  onSettingsChange,
  onPromptChange,
  onReferencesChange,
  onClear,
  onOptimize,
  onGenerate,
  onUseAsReference,
  onSyncResult,
  onDeleteResult,
  onOpenAccount,
}: StudioWorkspaceProps) {
  const [level, setLevel] = useState<"novice" | "expert">("novice");
  const [selectedId, setSelectedId] = useState("");
  const [settingsLocked, setSettingsLocked] = useStoredState("clothdesign:settingsLocked", false);

  const mode = generationModes.find((item) => item.id === settings.mode) ?? generationModes[0];
  const ratio = ratioOptions.find((item) => item.id === settings.ratioId) ?? ratioOptions[0];
  const cost = useMemo(
    () => estimateCredits(mode, settings, references, creditPolicy),
    [mode, references, settings, creditPolicy],
  );

  const filledReferences = references.filter((reference) => Boolean(reference.previewUrl));
  const missingRoles = mode.requiredRefs.filter(
    (role) => !references.some((reference) => reference.role === role && reference.previewUrl),
  );
  const ratioAllowed = ratio.allowedResolutions.includes(settings.resolution);
  const hasEnoughCredits = cost <= user.credits;
  const canGenerate = missingRoles.length === 0 && hasEnoughCredits && ratioAllowed && !isGenerating;

  // 新成片一落地就切过去。否则画布还停在上一张，用户根本看不出这次到底生成了没有。
  const newestId = results[0]?.id ?? "";
  const seenNewestRef = useRef(newestId);
  useEffect(() => {
    if (!results.length) {
      setSelectedId("");
      seenNewestRef.current = "";
      return;
    }
    if (newestId !== seenNewestRef.current) {
      seenNewestRef.current = newestId;
      setSelectedId(newestId);
      return;
    }
    if (!selectedId || !results.some((result) => result.id === selectedId)) {
      setSelectedId(results[0].id);
    }
  }, [newestId, results, selectedId]);

  const statusMessage = isGenerating
    ? "生成中，可继续调整设置"
    : missingRoles.length > 0
      ? `还需上传：${missingRoles.map((role) => roleLabels[role]).join("、")}`
      : !hasEnoughCredits
        ? `积分不足 · 需要 ${cost}`
        : !ratioAllowed
          ? "当前清晰度不支持所选画面比例"
          : "已就绪 · ⌘ + Enter 生成";
  const statusBlocked = !isGenerating && (missingRoles.length > 0 || !hasEnoughCredits || !ratioAllowed);

  const costBreakdown = [
    `${mode.shortTitle} 基础 ${mode.baseCredits}`,
    `参考图 ${filledReferences.length}×${creditPolicy.perReference}`,
    settings.quality === "high" ? "精细成片" : null,
    settings.resolution === "fourK" ? "4K 交付" : null,
    `${settings.quantity} 张`,
  ]
    .filter(Boolean)
    .join(" · ");

  const acceptFiles = (files: FileList) => {
    const images = Array.from(files).filter((file) => file.type.startsWith("image/"));
    if (!images.length) return;
    let next = [...references];
    images.forEach((file, index) => {
      const previewUrl = URL.createObjectURL(file);
      const note = file.name.replace(/\.[^.]+$/, "");
      const target = next.find((reference) => !reference.previewUrl);
      if (target) {
        next = next.map((reference) =>
          reference.id === target.id ? { ...reference, previewUrl, fileName: file.name, file, note } : reference,
        );
      } else {
        next = [
          ...next,
          {
            id: `ref-drop-${Date.now()}-${index}`,
            label: nextReferenceLabel(next),
            role: "style",
            note,
            fileName: file.name,
            file,
            previewUrl,
          },
        ];
      }
    });
    onReferencesChange(next);
  };

  /**
   * 把成片放进参考素材。优先填当前模式还空着的槽位——直接往后追加的话，
   * 「换衣」这类必填 model/garment 的模式会一直卡在「还需上传」。
   */
  const useResult = (result: GeneratedResult) => {
    const empty = references.find((reference) => !reference.previewUrl);
    if (empty) {
      const filled = resultToReference(result, empty.label);
      onUseAsReference(
        references.map((reference) =>
          reference.id === empty.id ? { ...filled, id: empty.id, role: empty.role } : reference,
        ),
      );
      return;
    }
    onUseAsReference([...references, resultToReference(result, nextReferenceLabel(references))]);
  };

  const applyPreset = (preset: DeliveryPreset) => {
    onSettingsChange({ mode: preset.mode });
    onSettingsChange(preset.patch);
  };

  const presetActive = (preset: DeliveryPreset) =>
    settings.mode === preset.mode &&
    (Object.keys(preset.patch) as Array<keyof StudioSettings>).every((key) => settings[key] === preset.patch[key]);

  return (
    <main className="workspace studio-workspace">
      <section className="studio-main">
        <ModePicker activeMode={settings.mode} onChange={(modeId) => onSettingsChange({ mode: modeId })} />

        <ProviderBanner apiConfig={apiConfig} compact />

        <ResultStage
          results={results}
          selectedId={selectedId}
          onSelect={setSelectedId}
          isGenerating={isGenerating}
          beforeUrl={filledReferences[0]?.previewUrl}
          onDelete={onDeleteResult}
          onDropFiles={acceptFiles}
          onUseAsReference={useResult}
          onReusePrompt={onPromptChange}
        />

        <PromptComposer
          mode={mode}
          prompt={prompt}
          references={references}
          optimizationNotice={optimizationNotice}
          statusMessage={statusMessage}
          statusBlocked={statusBlocked}
          generateLabel={isGenerating ? "正在生成…" : `生成 ${settings.quantity} 张 · ${cost} 积分`}
          generateDisabled={!canGenerate}
          onPromptChange={onPromptChange}
          onClear={onClear}
          canClear={prompt.trim().length > 0 || references.some((reference) => reference.previewUrl || reference.fileName)}
          onOptimize={onOptimize}
          onGenerate={() => onGenerate(mode, cost)}
          hoveredId={hoveredReferenceId}
          onHover={onHoverReference}
          registerTokenEl={registerTokenEl}
        />
      </section>

      <aside className="settings-aside panel-scroll" aria-label="成片设置">
        <div className="settings-aside-head">
          <span className="rail-kicker">成片设置</span>
          {settingsLocked ? null : (
            <div className="level-switch" role="group" aria-label="设置深度">
              <button type="button" className={level === "novice" ? "active" : ""} onClick={() => setLevel("novice")}>
                新手
              </button>
              <button type="button" className={level === "expert" ? "active" : ""} onClick={() => setLevel("expert")}>
                专家
              </button>
            </div>
          )}
          <button
            type="button"
            className={`settings-lock ${settingsLocked ? "active" : ""}`}
            aria-pressed={settingsLocked}
            title={settingsLocked ? "解锁后可以继续调整参数" : "锁定后参数折叠成摘要，连续出图时不会被误改"}
            onClick={() => setSettingsLocked((value) => !value)}
          >
            {settingsLocked ? "已锁定" : "锁定"}
          </button>
        </div>

        <div className="settings-aside-body">
          <ParameterPanel
            settings={settings}
            onChange={onSettingsChange}
            showAdvanced={level === "expert"}
            onExpandAdvanced={() => setLevel("expert")}
            locked={settingsLocked}
          />

          <div className="settings-block cost-block">
            <div className="cost-head">
              <span>预计消耗</span>
              <strong>{cost}</strong>
            </div>
            <small>{costBreakdown}</small>
            {!hasEnoughCredits ? (
              <button type="button" className="btn btn-primary" onClick={onOpenAccount}>
                积分不足 · 去充值
              </button>
            ) : null}
          </div>

          <div className="settings-block preset-block">
            <span className="rail-kicker">交付预设</span>
            <div className="preset-list">
              {deliveryPresets.map((preset) => (
                <button
                  type="button"
                  key={preset.id}
                  className={`preset-option ${presetActive(preset) ? "active" : ""}`}
                  // 预设本身就是一整套参数，锁定后放它进来等于绕开了锁。
                  disabled={settingsLocked}
                  title={settingsLocked ? "参数已锁定，先解锁再套用预设" : preset.detail}
                  onClick={() => applyPreset(preset)}
                >
                  <strong>{preset.label}</strong>
                  <small>{preset.detail}</small>
                </button>
              ))}
            </div>
          </div>

          <ResultPanelList
            results={results}
            selectedId={selectedId}
            onSelect={setSelectedId}
            onUseAsReference={useResult}
            onSync={onSyncResult}
            onDelete={onDeleteResult}
          />
        </div>
      </aside>
    </main>
  );
}
