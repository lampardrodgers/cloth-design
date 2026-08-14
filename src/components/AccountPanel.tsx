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
  onRecharge: (pkg: RechargePackage, provider: PaymentProvider) => void;
  onDemoComplete: (order: PaymentOrder) => void;
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
  onRecharge,
  onDemoComplete,
}: AccountPanelProps) {
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
        <div className="metric metric-good"><span>余额</span><strong>{currentUser.credits}</strong></div>
        <div className="metric metric-default"><span>本月消耗</span><strong>{currentUser.monthlyUsed}</strong></div>
        <div className="metric metric-default"><span>成片</span><strong>{generationResults.length}</strong></div>
      </section>

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
