import type { ApiConfig } from "./api";

/**
 * 演示模式的成片是服务端画的 SVG 占位图，不是图像引擎出的图。
 * 它是唯一会走 data:image/svg+xml 的来源，所以按这个前缀就能可靠地认出来。
 */
export function isPlaceholderImage(imageUrl?: string) {
  return Boolean(imageUrl?.startsWith("data:image/svg+xml"));
}

export type ProviderNotice = {
  tone: "demo" | "blocked";
  title: string;
  detail: string;
  hint?: string;
};

/**
 * 把「现在到底会不会真的调用图像接口」翻译成一句用户能直接照做的话。
 * 返回 null 表示一切正常，不打扰用户。
 */
export function providerNotice(apiConfig: ApiConfig | null | undefined): ProviderNotice | null {
  if (!apiConfig) return null;

  if (apiConfig.mode === "demo") {
    return {
      tone: "demo",
      title: "演示模式 · 出的是占位图",
      detail: apiConfig.providerReady
        ? "服务端设置了 OPENAI_DEMO_MODE=true，本次点击生成不会调用图像接口，返回的是占位图。"
        : "还没有配置图像接口密钥，点击生成不会调用真实接口，返回的是占位图。",
      hint: apiConfig.providerReady
        ? "把 .env 里的 OPENAI_DEMO_MODE 改成 false 并重启服务，即可切换成真实出图。"
        : "管理员可在后台「图像接口」里为对应供应商填写共享 API Key；也可以在 .env 配置 OPENAI_API_KEY / APIMART_API_KEY。",
    };
  }

  const health = apiConfig.providerHealth;
  if (health?.blocking) {
    return {
      tone: "blocked",
      title: `图像接口不可用 · ${health.label}`,
      detail: health.message || "图像接口暂时无法调用，这次生成会失败。",
      hint: health.resetAt ? `预计恢复时间：${health.resetAt}` : undefined,
    };
  }

  return null;
}
