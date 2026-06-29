import { CheckCircle2, CreditCard, QrCode, UserRound } from "lucide-react";
import { imageQualityLabel, imageQualitySummary } from "../lib/imageQuality";
import type { CreditLedgerEntry, GeneratedResult, PaymentCapabilities, PaymentOrder, PaymentProvider, RechargePackage, UserAccount } from "../types";
import { Button, Metric, Section } from "./ui";

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
    <div className="account-layout">
      <Section title="账户">
        <div className="account-card">
          <div className="avatar">
            <UserRound size={24} />
          </div>
          <div>
            <strong>{currentUser.name}</strong>
            <span>{currentUser.plan} · {currentUser.role}</span>
          </div>
        </div>
        <div className="metric-row">
          <Metric label="余额" value={`${currentUser.credits}`} tone="good" />
          <Metric label="本月消耗" value={`${currentUser.monthlyUsed}`} />
          <Metric label="状态" value={currentUser.status === "active" ? "正常" : "锁定"} />
        </div>
      </Section>

      <Section title="充值">
        <div className="package-grid">
          {packagesList.map((item) => (
            <article className="package-card" key={item.id}>
              <span>{item.badge}</span>
              <strong>{item.title}</strong>
              <p>{item.credits} 积分</p>
              <div className="payment-buttons">
                <Button icon={<CreditCard size={14} />} onClick={() => onRecharge(item, "alipay")}>
                  支付宝 ￥{item.price}
                </Button>
                <Button icon={<CreditCard size={14} />} onClick={() => onRecharge(item, "wechat")}>
                  微信 ￥{item.price}
                </Button>
              </div>
            </article>
          ))}
        </div>
      </Section>

      {activeOrder ? (
        <Section title="扫码支付" action={<QrCode size={17} />}>
          <div className="payment-order-card">
            <img src={activeOrder.qrCodeDataUrl} alt={`${providerLabels[activeOrder.provider]}支付二维码`} />
            <div>
              <strong>{providerLabels[activeOrder.provider]} · {activeOrder.subject}</strong>
              <span>订单 {activeOrder.id}</span>
              <span>{activeOrder.credits} 积分 · ￥{(activeOrder.amountCents / 100).toFixed(2)}</span>
              <span>状态：{activeOrder.status}</span>
              {paymentCapabilities[activeOrder.provider]?.demoCompleteAllowed && activeOrder.status === "pending" ? (
                <Button icon={<CheckCircle2 size={14} />} onClick={() => onDemoComplete(activeOrder)}>
                  模拟支付成功
                </Button>
              ) : null}
            </div>
          </div>
        </Section>
      ) : null}

      <Section title="订单与积分流水">
        <div className="billing-list">
          {orders.slice(0, 5).map((order) => (
            <article key={order.id}>
              <strong>{providerLabels[order.provider]} · {order.status}</strong>
              <span>{order.subject}</span>
              <span>￥{(order.amountCents / 100).toFixed(2)} · {order.credits} 积分</span>
            </article>
          ))}
          {ledger.slice(0, 5).map((item) => (
            <article key={item.id}>
              <strong>{item.kind} · {item.amount > 0 ? "+" : ""}{item.amount}</strong>
              <span>{item.reason}</span>
              <span>余额 {item.balanceAfter}</span>
            </article>
          ))}
        </div>
      </Section>

      <Section title="最近生成">
        <div className="billing-list generation-history-list">
          {generationResults.slice(0, 6).map((result) => (
            <article key={result.id}>
              <img src={result.imageUrl} alt={result.title} />
              <div>
                <strong>{result.title}</strong>
                <span>{result.ratioLabel} · {result.credits} 积分 · {imageQualityLabel(result.qualityGate)}</span>
                <span>{imageQualitySummary({ qualityGate: result.qualityGate, imageInspection: result.imageInspection })}</span>
              </div>
            </article>
          ))}
          {generationResults.length === 0 ? <span className="muted-text">暂无生成记录</span> : null}
        </div>
      </Section>
    </div>
  );
}
