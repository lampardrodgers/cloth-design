import { CreditCard, UserRound } from "lucide-react";
import type { RechargePackage, UserAccount } from "../types";
import { Button, Metric, Section } from "./ui";

interface AccountPanelProps {
  currentUser: UserAccount;
  packages: RechargePackage[];
  onRecharge: (pkg: RechargePackage) => void;
}

export function AccountPanel({ currentUser, packages: packagesList, onRecharge }: AccountPanelProps) {
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
              <Button icon={<CreditCard size={14} />} onClick={() => onRecharge(item)}>￥{item.price}</Button>
            </article>
          ))}
        </div>
      </Section>
    </div>
  );
}
