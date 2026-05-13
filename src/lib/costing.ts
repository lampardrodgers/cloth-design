import type { CreditPolicy, GenerationMode, ReferenceImage, StudioSettings } from "../types";

export function estimateCredits(
  mode: GenerationMode,
  settings: StudioSettings,
  references: ReferenceImage[],
  policy: CreditPolicy,
) {
  const activeReferenceCount = references.filter((item) => item.previewUrl || item.fileName).length;
  let total = mode.baseCredits + activeReferenceCount * policy.perReference;

  if (settings.quality === "high") {
    total *= policy.highQualityMultiplier;
  }

  if (settings.resolution === "fourK") {
    total *= policy.fourKMultiplier;
  }

  if (settings.background === "transparent") {
    total += policy.transparentBackgroundFee;
  }

  if (settings.inputFidelity === "high" && activeReferenceCount > 0) {
    total += activeReferenceCount * 3;
  }

  return Math.ceil(total * settings.quantity);
}
