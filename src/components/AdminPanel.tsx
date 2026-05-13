import { DatabaseZap, KeyRound, Settings2, ShieldCheck } from "lucide-react";
import { creditPolicy, generationModes, ratioOptions, resolutionOptions } from "../data/catalog";
import type { ModelRoute, QualityKey } from "../types";
import { Metric, Section } from "./ui";

interface AdminPanelProps {
  routes: ModelRoute[];
  onRoutesChange: (routes: ModelRoute[]) => void;
}

export function AdminPanel({ routes, onRoutesChange }: AdminPanelProps) {
  const updateRoute = (id: string, patch: Partial<ModelRoute>) => {
    onRoutesChange(routes.map((route) => (route.id === id ? { ...route, ...patch } : route)));
  };

  return (
    <div className="admin-layout">
      <Section title="模型映射" action={<Settings2 size={17} />}>
        <div className="route-table">
          <div className="table-row table-head">
            <span>前台能力</span>
            <span>供应商</span>
            <span>内部模型</span>
            <span>端点</span>
            <span>质量/状态</span>
          </div>
          {routes.map((route) => (
            <div className="table-row" key={route.id}>
              <span>{route.frontendCapability}</span>
              <span>{route.provider}</span>
              <input
                className="admin-input"
                value={route.model}
                onChange={(event) => updateRoute(route.id, { model: event.target.value })}
                aria-label={`${route.frontendCapability} 模型`}
              />
              <input
                className="admin-input"
                value={route.endpoint}
                onChange={(event) => updateRoute(route.id, { endpoint: event.target.value })}
                aria-label={`${route.frontendCapability} 端点`}
              />
              <span className="admin-route-actions">
                <select
                  value={route.defaultQuality}
                  onChange={(event) => updateRoute(route.id, { defaultQuality: event.target.value as QualityKey })}
                  aria-label={`${route.frontendCapability} 默认质量`}
                >
                  <option value="auto">auto</option>
                  <option value="low">low</option>
                  <option value="medium">medium</option>
                  <option value="high">high</option>
                </select>
                <label className={route.enabled ? "status-good" : "status-bad"}>
                  <input
                    type="checkbox"
                    checked={route.enabled}
                    onChange={(event) => updateRoute(route.id, { enabled: event.target.checked })}
                  />
                  {route.enabled ? "启用" : "停用"}
                </label>
              </span>
            </div>
          ))}
        </div>
      </Section>

      <Section title="积分规则">
        <div className="metric-row">
          <Metric label="参考图" value={`+${creditPolicy.perReference}`} />
          <Metric label="高质量" value={`x${creditPolicy.highQualityMultiplier}`} />
          <Metric label="4K" value={`x${creditPolicy.fourKMultiplier}`} />
          <Metric label="失败退款" value={`${creditPolicy.failureRefundRate * 100}%`} tone="good" />
        </div>
        <div className="mode-cost-grid">
          {generationModes.map((mode) => (
            <article key={mode.id}>
              <strong>{mode.title}</strong>
              <span>{mode.baseCredits} 基础分</span>
              <p>{mode.systemTemplate}</p>
            </article>
          ))}
        </div>
      </Section>

      <Section title="参数约束">
        <div className="constraint-grid">
          {resolutionOptions.map((resolution) => (
            <article key={resolution.id}>
              <strong>{resolution.label}</strong>
              <span>{resolution.detail}</span>
              <p>
                {ratioOptions
                  .filter((ratio) => ratio.allowedResolutions.includes(resolution.id))
                  .map((ratio) => ratio.label)
                  .join(" / ")}
              </p>
            </article>
          ))}
        </div>
      </Section>

      <Section title="商业化底座">
        <div className="stack-grid">
          <article>
            <KeyRound size={18} />
            <strong>用户系统</strong>
            <span>Supabase Auth 或 Auth.js，支持邮箱、企业微信、子账号、角色权限。</span>
          </article>
          <article>
            <ShieldCheck size={18} />
            <strong>支付订单</strong>
            <span>Stripe / Lemon Squeezy / 国内聚合支付，订单回调写积分流水。</span>
          </article>
          <article>
            <DatabaseZap size={18} />
            <strong>后台能力</strong>
            <span>模型路由、价格、套餐、风控、人工加扣分、审计日志集中配置。</span>
          </article>
        </div>
      </Section>
    </div>
  );
}
