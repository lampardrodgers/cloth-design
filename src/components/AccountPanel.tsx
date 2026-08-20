import { useEffect, useState, type FormEvent } from "react";
import { changeMyPassword } from "../lib/api";
import { imageQualityLabel } from "../lib/imageQuality";
import { resolutionShortLabels } from "../lib/resolution";
import type {
  CreditLedgerEntry,
  GeneratedResult,
  ImageProviderOption,
  PaymentCapabilities,
  PaymentOrder,
  PaymentProvider,
  RechargePackage,
  UserAccount,
} from "../types";

interface AccountPanelProps {
  currentUser: UserAccount;
  imageProviders: ImageProviderOption[];
  packages: RechargePackage[];
  orders: PaymentOrder[];
  ledger: CreditLedgerEntry[];
  generationResults: GeneratedResult[];
  paymentCapabilities: PaymentCapabilities;
  activeOrder?: PaymentOrder | null;
  debugUnlimited?: boolean;
  onRecharge: (pkg: RechargePackage, provider: PaymentProvider) => void;
  onDemoComplete: (order: PaymentOrder) => void;
  /** 保存 / 清除账号自备的图像接口 Key。返回错误文案时留在原地提示。 */
  onSaveApiKey?: (apiKey: string, providerId: string) => Promise<string | void>;
  onClearApiKey?: () => Promise<string | void>;
  onSelectImageProvider?: (providerId: string) => Promise<string | void>;
}

const providerLabels: Record<PaymentProvider, string> = {
  alipay: "支付宝",
  wechat: "微信",
};

const ledgerKindLabels: Record<string, string> = {
  recharge: "充值",
  consume: "消耗",
  refund: "退款",
  admin_adjust: "人工调分",
};

export function AccountPanel({
  currentUser,
  imageProviders,
  packages: packagesList,
  orders,
  ledger,
  generationResults,
  paymentCapabilities,
  activeOrder,
  debugUnlimited = false,
  onRecharge,
  onDemoComplete,
  onSaveApiKey,
  onClearApiKey,
  onSelectImageProvider,
}: AccountPanelProps) {
  const [apiKeyDraft, setApiKeyDraft] = useState("");
  const [apiKeyBusy, setApiKeyBusy] = useState(false);
  const [apiKeyNotice, setApiKeyNotice] = useState("");
  const [providerId, setProviderId] = useState(currentUser.apiProviderId || imageProviders[0]?.id || "default");
  // 自己改密码：以前只有管理员能在后台重置，用户没有入口。
  const [passwordDraft, setPasswordDraft] = useState({ current: "", next: "", confirm: "" });
  const [passwordBusy, setPasswordBusy] = useState(false);
  const [passwordNotice, setPasswordNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const submitPassword = async (event: FormEvent) => {
    event.preventDefault();
    if (passwordBusy) return;
    if (passwordDraft.next.length < 8) {
      setPasswordNotice({ ok: false, text: "新密码至少 8 位。" });
      return;
    }
    if (passwordDraft.next !== passwordDraft.confirm) {
      setPasswordNotice({ ok: false, text: "两次输入的新密码不一样。" });
      return;
    }
    setPasswordBusy(true);
    setPasswordNotice(null);
    try {
      await changeMyPassword(passwordDraft.current, passwordDraft.next);
      setPasswordDraft({ current: "", next: "", confirm: "" });
      setPasswordNotice({ ok: true, text: "密码已修改。其它设备上的登录已失效，需要用新密码重新登录。" });
    } catch (error) {
      setPasswordNotice({ ok: false, text: error instanceof Error ? error.message : "修改密码失败" });
    } finally {
      setPasswordBusy(false);
    }
  };
  useEffect(() => setProviderId(currentUser.apiProviderId || imageProviders[0]?.id || "default"), [currentUser.apiProviderId, imageProviders]);
  const selectedProvider = imageProviders.find((provider) => provider.id === providerId);

  const submitApiKey = async (event: FormEvent) => {
    event.preventDefault();
    if (!onSaveApiKey || apiKeyBusy) return;
    setApiKeyBusy(true);
    setApiKeyNotice("");
    try {
      const error = await onSaveApiKey(apiKeyDraft, providerId);
      if (error) setApiKeyNotice(error);
      else {
        setApiKeyDraft("");
        setApiKeyNotice("已保存。之后的生成都走这把 Key，不再扣积分。");
      }
    } finally {
      setApiKeyBusy(false);
    }
  };

  const selectProvider = async (nextProviderId: string) => {
    setProviderId(nextProviderId);
    setApiKeyNotice("");
    if (!onSelectImageProvider) return;
    setApiKeyBusy(true);
    try {
      const error = await onSelectImageProvider(nextProviderId);
      setApiKeyNotice(error || `已切换到 ${imageProviders.find((provider) => provider.id === nextProviderId)?.name || "新接口"}。`);
    } finally {
      setApiKeyBusy(false);
    }
  };

  const clearApiKey = async () => {
    if (!onClearApiKey || apiKeyBusy) return;
    setApiKeyBusy(true);
    setApiKeyNotice("");
    try {
      const error = await onClearApiKey();
      setApiKeyNotice(error || "已清除，之后的生成改用站点共享 Key，按积分计费。");
    } finally {
      setApiKeyBusy(false);
    }
  };

  return (
    <div className="account-layout editorial-page">
      <section className="metric-row account-card-row">
        <div className="account-card">
          <i className="avatar" aria-hidden="true">{currentUser.name.trim().charAt(0) || "我"}</i>
          <span>
            <strong>{currentUser.name}</strong>
            <small>{currentUser.plan} · {currentUser.role}</small>
          </span>
        </div>
        <div className="metric metric-good"><span>余额</span><strong>{debugUnlimited ? "∞" : currentUser.credits}</strong></div>
        <div className="metric metric-default"><span>本月消耗</span><strong>{currentUser.monthlyUsed}</strong></div>
        <div className="metric metric-default"><span>成片</span><strong>{generationResults.length}</strong></div>
      </section>

      {onSaveApiKey ? (
        <section className="editorial-section api-key-section">
          <span className="rail-kicker">图像接口 Key</span>
          <p className="muted-text">
            {currentUser.hasOwnApiKey
              ? `当前使用你自己的 Key（${currentUser.apiKeyHint ?? "已保存"}），接口费用直接记在这把 Key 上${debugUnlimited ? "" : "，生成不扣积分"}。`
              : currentUser.serverKeyConfigured
                ? `不填也能用：默认走站点共享 Key${debugUnlimited ? "" : "，按积分计费。填了自己的 Key 之后生成不再扣积分"}。`
                : "站点还没配置共享 Key。填入你自己的 Key 才能真实出图，否则只会得到演示占位图。"}
          </p>
          <form className="api-key-form" onSubmit={submitApiKey}>
            <select
              value={providerId}
              onChange={(event) => void selectProvider(event.target.value)}
              disabled={apiKeyBusy}
              aria-label="图像接口 URL Base"
            >
              {imageProviders.map((provider) => (
                <option value={provider.id} key={provider.id}>{provider.name}</option>
              ))}
            </select>
            <input
              type="password"
              value={apiKeyDraft}
              onChange={(event) => setApiKeyDraft(event.target.value)}
              placeholder={currentUser.hasOwnApiKey ? "粘贴新的 Key 可以直接替换" : "sk-…"}
              autoComplete="off"
              spellCheck={false}
              aria-label="图像接口 Key"
              disabled={apiKeyBusy}
            />
            <button type="submit" className="btn btn-primary" disabled={apiKeyBusy || !apiKeyDraft.trim()}>
              {apiKeyBusy ? "保存中…" : "保存"}
            </button>
            {currentUser.hasOwnApiKey ? (
              <button type="button" className="btn btn-secondary" disabled={apiKeyBusy} onClick={clearApiKey}>
                清除
              </button>
            ) : null}
          </form>
          {selectedProvider ? (
            <small className="api-provider-url">
              URL Base：<code>{selectedProvider.baseUrl}</code> · 模型 <code>{selectedProvider.model}</code>
              {/* 换线路会直接改变能选的分辨率，别让人换完才发现 4K 没了。 */}
              {selectedProvider.maxResolution ? ` · 最高 ${resolutionShortLabels[selectedProvider.maxResolution]}` : ""}
              {currentUser.maxResolutionSource === "account" && currentUser.maxResolution
                ? `（管理员把这个账号压到 ${resolutionShortLabels[currentUser.maxResolution]}）`
                : ""}
            </small>
          ) : null}
          {apiKeyNotice ? <small className="api-key-notice">{apiKeyNotice}</small> : null}
          <small className="muted-text">Key 加密保存在本站服务器上，页面上永远只显示前 3 位和后 4 位。</small>
        </section>
      ) : null}

      {currentUser.username || currentUser.email ? (
        <section className="editorial-section password-section">
          <span className="rail-kicker">修改密码</span>
          <form className="password-form" onSubmit={(event) => void submitPassword(event)}>
            <input
              type="password"
              value={passwordDraft.current}
              onChange={(event) => setPasswordDraft({ ...passwordDraft, current: event.target.value })}
              placeholder="当前密码"
              autoComplete="current-password"
              aria-label="当前密码"
              disabled={passwordBusy}
              required
            />
            <input
              type="password"
              value={passwordDraft.next}
              onChange={(event) => setPasswordDraft({ ...passwordDraft, next: event.target.value })}
              placeholder="新密码（至少 8 位）"
              autoComplete="new-password"
              aria-label="新密码"
              minLength={8}
              disabled={passwordBusy}
              required
            />
            <input
              type="password"
              value={passwordDraft.confirm}
              onChange={(event) => setPasswordDraft({ ...passwordDraft, confirm: event.target.value })}
              placeholder="再输一遍新密码"
              autoComplete="new-password"
              aria-label="确认新密码"
              minLength={8}
              disabled={passwordBusy}
              required
            />
            <button type="submit" className="btn btn-primary" disabled={passwordBusy || !passwordDraft.current || !passwordDraft.next || !passwordDraft.confirm}>
              {passwordBusy ? "修改中…" : "修改密码"}
            </button>
          </form>
          {passwordNotice ? <small className={passwordNotice.ok ? "api-key-notice" : "api-key-notice password-error"}>{passwordNotice.text}</small> : null}
          <small className="muted-text">改完其它设备上的登录会一起失效；忘了当前密码请联系管理员在后台重置。</small>
        </section>
      ) : null}

      <section className="editorial-section">
        <span className="rail-kicker">充值</span>
        <div className="package-grid">
          {packagesList.map((item) => (
            <article className="package-card" key={item.id}>
              <em>{item.badge}</em>
              <strong>{item.title}</strong>
              <div className="package-price">
                <span>{item.credits}</span>
                <small>积分 · ￥{item.price}</small>
              </div>
              <div className="payment-buttons">
                <button type="button" className="btn btn-primary" onClick={() => onRecharge(item, "alipay")}>
                  支付宝支付 ￥{item.price}
                </button>
                <button type="button" className="btn btn-secondary" onClick={() => onRecharge(item, "wechat")}>
                  微信支付 ￥{item.price}
                </button>
              </div>
            </article>
          ))}
        </div>
      </section>

      {activeOrder ? (
        <section className="editorial-section order-section">
          <h2 className="section-title">扫码支付</h2>
          <div className="payment-order-card">
            <img src={activeOrder.qrCodeDataUrl} alt={`${providerLabels[activeOrder.provider]}支付二维码`} />
            <div>
              <strong>{providerLabels[activeOrder.provider]} · {activeOrder.subject}</strong>
              <span>订单 {activeOrder.id}</span>
              <span>{activeOrder.credits} 积分 · ￥{(activeOrder.amountCents / 100).toFixed(2)}</span>
              <span>状态 {activeOrder.status === "paid" ? "已支付" : "待支付"}</span>
              {paymentCapabilities[activeOrder.provider]?.demoCompleteAllowed && activeOrder.status === "pending" ? (
                <button type="button" className="btn btn-primary" onClick={() => onDemoComplete(activeOrder)}>
                  模拟支付成功
                </button>
              ) : null}
            </div>
          </div>
        </section>
      ) : null}

      <section className="editorial-split">
        <div className="editorial-section">
          <span className="rail-kicker">订单与流水</span>
          <table className="editorial-table">
            <thead>
              <tr>
                <th>条目</th>
                <th>说明</th>
                <th className="numeric">积分</th>
              </tr>
            </thead>
            <tbody>
              {orders.slice(0, 4).map((order) => (
                <tr key={order.id}>
                  <td>{providerLabels[order.provider]}</td>
                  <td className="muted">{order.subject} · {order.status}</td>
                  <td className="numeric">{order.credits}</td>
                </tr>
              ))}
              {ledger.slice(0, 6).map((item) => (
                <tr key={item.id}>
                  <td>{ledgerKindLabels[item.kind] ?? item.kind}</td>
                  <td className="muted">{item.reason}</td>
                  <td className={`numeric ${item.amount > 0 ? "positive" : ""}`}>
                    {item.amount > 0 ? "+" : ""}{item.amount}
                  </td>
                </tr>
              ))}
              {orders.length === 0 && ledger.length === 0 ? (
                <tr><td colSpan={3} className="muted">暂无记录</td></tr>
              ) : null}
            </tbody>
          </table>
        </div>

        <div className="editorial-section">
          <span className="rail-kicker">最近生成</span>
          {generationResults.length === 0 ? <p className="muted-text">暂无生成记录</p> : null}
          <div className="billing-list generation-history-list">
            {generationResults.slice(0, 5).map((result) => (
              <article key={result.id}>
                {result.storageStatus === "expired" ? (
                  <span className="generation-history-expired" title="服务器副本已清理">已清理</span>
                ) : (
                  <img src={result.imageUrl} alt="" />
                )}
                <div>
                  <strong>{result.title}</strong>
                  <span>{result.ratioLabel} · {result.credits} 积分</span>
                </div>
                <em className={`quality-${result.qualityGate?.status ?? "unknown"}`}>
                  {imageQualityLabel(result.qualityGate)}
                </em>
              </article>
            ))}
          </div>
        </div>
      </section>
    </div>
  );
}
