import { CreditCard, Lock, Plus, UserRound } from "lucide-react";
import type { RechargePackage, UserAccount } from "../types";
import { Button, Metric, Section } from "./ui";

interface AccountPanelProps {
  currentUser: UserAccount;
  users: UserAccount[];
  packages: RechargePackage[];
  onRecharge: (pkg: RechargePackage) => void;
  onAdjustUser: (userId: string, credits: number) => void;
}

export function AccountPanel({ currentUser, users, packages: packagesList, onRecharge, onAdjustUser }: AccountPanelProps) {
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

      <Section title="用户管理">
        <div className="user-table" role="table">
          <div className="table-row table-head" role="row">
            <span>用户</span>
            <span>角色</span>
            <span>余额</span>
            <span>状态</span>
            <span>操作</span>
          </div>
          {users.map((user) => (
            <div className="table-row" role="row" key={user.id}>
              <span>{user.name}</span>
              <span>{user.role}</span>
              <span>{user.credits}</span>
              <span className={user.status === "locked" ? "status-bad" : "status-good"}>
                {user.status === "locked" ? <Lock size={13} /> : null}
                {user.status === "locked" ? "锁定" : "正常"}
              </span>
              <span>
                <button className="icon-button" aria-label="加积分" onClick={() => onAdjustUser(user.id, 100)}>
                  <Plus size={15} />
                </button>
              </span>
            </div>
          ))}
        </div>
      </Section>
    </div>
  );
}
