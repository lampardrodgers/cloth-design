import { providerNotice } from "../lib/providerMode";
import type { ApiConfig } from "../lib/api";

/**
 * 生成入口上方的状态横幅。
 * 演示模式下必须显眼地说清「这次点击不会真的出图」，否则用户拿到占位图会以为是产品坏了。
 */
export function ProviderBanner({ apiConfig, compact = false }: { apiConfig: ApiConfig | null; compact?: boolean }) {
  const notice = providerNotice(apiConfig);
  if (!notice) return null;

  return (
    <aside className={`provider-banner provider-banner-${notice.tone} ${compact ? "compact" : ""}`} role="status">
      <span className="provider-banner-mark" aria-hidden="true">
        {notice.tone === "demo" ? "◇" : "!"}
      </span>
      <div className="provider-banner-copy">
        <strong>{notice.title}</strong>
        <span>{notice.detail}</span>
        {notice.hint ? <small>{notice.hint}</small> : null}
      </div>
    </aside>
  );
}
