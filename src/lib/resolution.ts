import type { ProviderCapability, ResolutionKey } from "../types";

/** 从低到高：1K → 2K → 4K。 */
export const resolutionOrder: ResolutionKey[] = ["native", "hd", "fourK"];

export const resolutionShortLabels: Record<ResolutionKey, string> = {
  native: "1K",
  hd: "2K",
  fourK: "4K",
};

export function resolutionRank(value: ResolutionKey | undefined) {
  const index = resolutionOrder.indexOf(value as ResolutionKey);
  return index < 0 ? 0 : index;
}

/** 取「想要的档位」和「上限」里低的那个。 */
export function clampResolution(value: ResolutionKey | undefined, cap: ResolutionKey | undefined): ResolutionKey {
  return resolutionOrder[Math.min(resolutionRank(value), resolutionRank(cap))];
}

export function isResolutionAllowed(value: ResolutionKey, cap: ResolutionKey | undefined) {
  return resolutionRank(value) <= resolutionRank(cap);
}

/**
 * 为什么这一档点不了：分不清是线路本身出不来，还是后台把这个账号压低了，
 * 用户就只会以为是界面坏了。
 */
export function resolutionLimitNote(capability: ProviderCapability): string {
  const cap = capability.maxResolution;
  if (cap === "fourK") return "";
  const label = resolutionShortLabels[cap];
  if (capability.maxResolutionSource === "account") {
    return `管理员把这个账号的上限设成了 ${label}，更高的档位要找管理员放开。`;
  }
  return `当前线路（${capability.providerName}）最高 ${label}；2K / 4K 需要换成 APIMart 线路。`;
}

/** 某一档为什么是灰的，鼠标悬上去要能看到一句人话。 */
export function resolutionOptionTitle(value: ResolutionKey, capability: ProviderCapability): string {
  if (isResolutionAllowed(value, capability.maxResolution)) return `按 ${resolutionShortLabels[value]} 出图`;
  return `${resolutionShortLabels[value]} 不可用：${resolutionLimitNote(capability)}`;
}

export const defaultProviderCapability: ProviderCapability = {
  providerName: "图像接口",
  protocol: "openai",
  maxResolution: "native",
  maxResolutionSource: "provider",
};

/** 账号信息还没回来时先按最保守的来，别先把 4K 亮出来再收回去。 */
export function capabilityFromAccount(account: {
  apiProviderName?: string;
  apiProviderProtocol?: ProviderCapability["protocol"];
  maxResolution?: ResolutionKey;
  maxResolutionSource?: ProviderCapability["maxResolutionSource"];
} | null | undefined): ProviderCapability {
  if (!account) return defaultProviderCapability;
  return {
    providerName: account.apiProviderName || defaultProviderCapability.providerName,
    protocol: account.apiProviderProtocol || defaultProviderCapability.protocol,
    maxResolution: account.maxResolution || defaultProviderCapability.maxResolution,
    maxResolutionSource: account.maxResolutionSource || "provider",
  };
}
