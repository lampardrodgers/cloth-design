/**
 * 前端异常上报。
 *
 * 白屏这种事最难查的地方在于：用户看到的是一片空白，浏览器控制台里的报错留在他们那台机器上。
 * 这里把渲染崩溃、未捕获异常、画布空白自检都发回服务端记一笔（`journalctl -u clothdesign` 里能看到），
 * 只送必要信息：一句话、调用栈、当前地址、浏览器串。图片、提示词一律不带。
 */

export interface ClientErrorReport {
  /** 出问题的地方：app / canvas / canvas-blank / window / promise */
  scope: string;
  message: string;
  stack?: string;
  /** 额外的诊断信息，比如画布空白时的容器尺寸 */
  detail?: Record<string, unknown>;
}

const MAX_PER_SESSION = 20;
const DEDUPE_MS = 30000;

let sent = 0;
const lastSentAt = new Map<string, number>();

/** 发一条给服务端。失败就算了——上报本身不能再把页面搞崩。 */
export function reportClientError(report: ClientErrorReport) {
  try {
    if (sent >= MAX_PER_SESSION) return;
    const key = `${report.scope}:${report.message}`;
    const now = Date.now();
    const previous = lastSentAt.get(key) ?? 0;
    if (now - previous < DEDUPE_MS) return;
    lastSentAt.set(key, now);
    sent += 1;

    const body = JSON.stringify({
      scope: report.scope,
      message: String(report.message ?? "").slice(0, 500),
      stack: report.stack ? String(report.stack).slice(0, 2000) : undefined,
      detail: report.detail,
      url: window.location.pathname + window.location.search,
      at: new Date().toISOString(),
    });
    // 页面正在崩溃时 fetch 可能来不及，sendBeacon 更稳。
    if (typeof navigator.sendBeacon === "function") {
      navigator.sendBeacon("/api/client-errors", new Blob([body], { type: "application/json" }));
      return;
    }
    void fetch("/api/client-errors", { method: "POST", headers: { "Content-Type": "application/json" }, body, keepalive: true }).catch(
      () => undefined,
    );
  } catch {
    // 上报失败不影响任何事
  }
}

/** 挂全局兜底：事件回调、定时器、Promise 里抛出来的错误，边界是接不到的。 */
export function installGlobalErrorReporting() {
  window.addEventListener("error", (event) => {
    const error = event.error as Error | undefined;
    reportClientError({
      scope: "window",
      message: error?.message || event.message || "未知脚本错误",
      stack: error?.stack,
      detail: { source: event.filename, line: event.lineno },
    });
  });

  window.addEventListener("unhandledrejection", (event) => {
    const reason = event.reason as Error | string | undefined;
    reportClientError({
      scope: "promise",
      message: reason instanceof Error ? reason.message : String(reason ?? "未处理的 Promise 拒绝"),
      stack: reason instanceof Error ? reason.stack : undefined,
    });
  });
}
