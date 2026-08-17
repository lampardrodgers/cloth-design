import { useState, type FormEvent } from "react";
import { imageQualityLabel } from "../lib/imageQuality";
import type {
  CreditLedgerEntry,
  GeneratedResult,
  PaymentCapabilities,
  PaymentOrder,
  PaymentProvider,
  RechargePackage,
  UserAccount,
} from "../types";

interface AccountPanelProps {
  currentUser: UserAccount;
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
  onSaveApiKey?: (apiKey: string) => Promise<string | void>;
  onClearApiKey?: () => Promise<string | void>;
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
}: AccountPanelProps) {
  const [apiKeyDraft, setApiKeyDraft] = useState("");
  const [apiKeyBusy, setApiKeyBusy] = useState(false);
  const [apiKeyNotice, setApiKeyNotice] = useState("");

  const submitApiKey = async (event: FormEvent) => {
    event.preventDefault();
    if (!onSaveApiKey || apiKeyBusy) return;
    setApiKeyBusy(true);
    setApiKeyNotice("");
    try {
      const error = await onSaveApiKey(apiKeyDraft);
      if (error) setApiKeyNotice(error);
      else {
        setApiKeyDraft("");
        setApiKeyNotice("已保存。之后的生成都走这把 Key，不再扣积分。");
      }
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
          {apiKeyNotice ? <small className="api-key-notice">{apiKeyNotice}</small> : null}
          <small className="muted-text">Key 加密保存在本站服务器上，页面上永远只显示前 3 位和后 4 位。</small>
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
                <img src={result.imageUrl} alt="" />
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
