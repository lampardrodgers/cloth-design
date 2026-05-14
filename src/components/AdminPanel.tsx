import { DatabaseZap, KeyRound, Settings2, ShieldCheck, WalletCards } from "lucide-react";
import { generationModes } from "../data/catalog";
import type {
  CreditPolicy,
  ModeKey,
  ModelRoute,
  QualityKey,
  RechargePackage,
  StoragePolicy,
  SystemPromptMap,
  UserAccount,
} from "../types";
import { Metric, Section } from "./ui";

interface AdminPanelProps {
  routes: ModelRoute[];
  onRoutesChange: (routes: ModelRoute[]) => void;
  users: UserAccount[];
  onUsersChange: (users: UserAccount[]) => void;
  packages: RechargePackage[];
  onPackagesChange: (packages: RechargePackage[]) => void;
  creditPolicy: CreditPolicy;
  onCreditPolicyChange: (policy: CreditPolicy) => void;
  storagePolicy: StoragePolicy;
  onStoragePolicyChange: (policy: StoragePolicy) => void;
  systemPrompts: SystemPromptMap;
  onSystemPromptsChange: (modeId: ModeKey, value: string) => void;
}

export function AdminPanel({
  routes,
  onRoutesChange,
  users,
  onUsersChange,
  packages: packagesList,
  onPackagesChange,
  creditPolicy,
  onCreditPolicyChange,
  storagePolicy,
  onStoragePolicyChange,
  systemPrompts,
  onSystemPromptsChange,
}: AdminPanelProps) {
  const updateRoute = (id: string, patch: Partial<ModelRoute>) => {
    onRoutesChange(routes.map((route) => (route.id === id ? { ...route, ...patch } : route)));
  };

  const updatePackage = (id: string, patch: Partial<RechargePackage>) => {
    onPackagesChange(packagesList.map((item) => (item.id === id ? { ...item, ...patch } : item)));
  };

  const updateUser = (id: string, patch: Partial<UserAccount>) => {
    onUsersChange(users.map((user) => (user.id === id ? { ...user, ...patch } : user)));
  };

  return (
    <div className="admin-layout">
      <Section title="模型路由" action={<Settings2 size={17} />}>
        <div className="route-table admin-table">
          <div className="table-row table-head">
            <span>前台能力</span>
            <span>供应商</span>
            <span>内部模型</span>
            <span>端点</span>
            <span>质量/状态</span>
            <span>计费公式</span>
          </div>
          {routes.map((route) => (
            <div className="table-row" key={route.id}>
              <input
                className="admin-input"
                value={route.frontendCapability}
                onChange={(event) => updateRoute(route.id, { frontendCapability: event.target.value })}
                aria-label={`${route.id} 前台能力`}
              />
              <input
                className="admin-input"
                value={route.provider}
                onChange={(event) => updateRoute(route.id, { provider: event.target.value })}
                aria-label={`${route.id} 供应商`}
              />
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
              <input
                className="admin-input"
                value={route.creditFormula}
                onChange={(event) => updateRoute(route.id, { creditFormula: event.target.value })}
                aria-label={`${route.frontendCapability} 计费公式`}
              />
            </div>
          ))}
        </div>
      </Section>

      <section className="admin-two">
        <Section title="积分规则" action={<WalletCards size={17} />}>
          <div className="metric-row admin-metrics">
            <Metric label="参考图" value={`+${creditPolicy.perReference}`} />
            <Metric label="高质量" value={`x${creditPolicy.highQualityMultiplier}`} />
            <Metric label="4K" value={`x${creditPolicy.fourKMultiplier}`} />
            <Metric label="失败退款" value={`${creditPolicy.failureRefundRate * 100}%`} tone="good" />
          </div>
          <div className="settings-grid admin-settings-grid">
            <label className="field">
              <span>每张参考图加分</span>
              <input
                type="number"
                min={0}
                value={creditPolicy.perReference}
                onChange={(event) => onCreditPolicyChange({ ...creditPolicy, perReference: Number(event.target.value) })}
              />
            </label>
            <label className="field">
              <span>高质量倍率</span>
              <input
                type="number"
                step={0.05}
                min={1}
                value={creditPolicy.highQualityMultiplier}
                onChange={(event) => onCreditPolicyChange({ ...creditPolicy, highQualityMultiplier: Number(event.target.value) })}
              />
            </label>
            <label className="field">
              <span>4K倍率</span>
              <input
                type="number"
                step={0.05}
                min={1}
                value={creditPolicy.fourKMultiplier}
                onChange={(event) => onCreditPolicyChange({ ...creditPolicy, fourKMultiplier: Number(event.target.value) })}
              />
            </label>
            <label className="field">
              <span>透明背景加分</span>
              <input
                type="number"
                min={0}
                value={creditPolicy.transparentBackgroundFee}
                onChange={(event) => onCreditPolicyChange({ ...creditPolicy, transparentBackgroundFee: Number(event.target.value) })}
              />
            </label>
          </div>
        </Section>

        <Section title="充值套餐" action={<KeyRound size={17} />}>
          <div className="package-admin-list">
            {packagesList.map((item) => (
              <article key={item.id}>
                <input
                  className="admin-input"
                  value={item.title}
                  onChange={(event) => updatePackage(item.id, { title: event.target.value })}
                  aria-label={`${item.id} 套餐名`}
                />
                <label className="field">
                  <span>积分</span>
                  <input
                    type="number"
                    min={1}
                    value={item.credits}
                    onChange={(event) => updatePackage(item.id, { credits: Number(event.target.value) })}
                  />
                </label>
                <label className="field">
                  <span>价格</span>
                  <input
                    type="number"
                    min={0}
                    value={item.price}
                    onChange={(event) => updatePackage(item.id, { price: Number(event.target.value) })}
                  />
                </label>
                <label className="field">
                  <span>标签</span>
                  <input value={item.badge} onChange={(event) => updatePackage(item.id, { badge: event.target.value })} />
                </label>
              </article>
            ))}
          </div>
        </Section>
      </section>

      <Section title="用户额度">
        <div className="user-table admin-table">
          <div className="table-row table-head" role="row">
            <span>用户</span>
            <span>角色</span>
            <span>余额</span>
            <span>月消耗</span>
            <span>状态</span>
          </div>
          {users.map((user) => (
            <div className="table-row" role="row" key={user.id}>
              <input className="admin-input" value={user.name} onChange={(event) => updateUser(user.id, { name: event.target.value })} />
              <select className="admin-input" value={user.role} onChange={(event) => updateUser(user.id, { role: event.target.value as UserAccount["role"] })}>
                <option value="owner">owner</option>
                <option value="designer">designer</option>
                <option value="operator">operator</option>
              </select>
              <input
                className="admin-input"
                type="number"
                min={0}
                value={user.credits}
                onChange={(event) => updateUser(user.id, { credits: Number(event.target.value) })}
              />
              <input
                className="admin-input"
                type="number"
                min={0}
                value={user.monthlyUsed}
                onChange={(event) => updateUser(user.id, { monthlyUsed: Number(event.target.value) })}
              />
              <select className="admin-input" value={user.status} onChange={(event) => updateUser(user.id, { status: event.target.value as UserAccount["status"] })}>
                <option value="active">正常</option>
                <option value="locked">锁定</option>
              </select>
            </div>
          ))}
        </div>
      </Section>

      <section className="admin-two">
        <Section title="存储策略" action={<DatabaseZap size={17} />}>
          <div className="settings-grid admin-settings-grid">
            <label className="field">
              <span>本地缓存上限 GB</span>
              <input
                type="number"
                min={1}
                value={storagePolicy.localCacheLimitGb}
                onChange={(event) => onStoragePolicyChange({ ...storagePolicy, localCacheLimitGb: Number(event.target.value) })}
              />
            </label>
            <label className="field">
              <span>本地保留小时</span>
              <input
                type="number"
                min={1}
                value={storagePolicy.localCacheTtlHours}
                onChange={(event) => onStoragePolicyChange({ ...storagePolicy, localCacheTtlHours: Number(event.target.value) })}
              />
            </label>
            <label className="field">
              <span>云端保留天数</span>
              <input
                type="number"
                min={1}
                value={storagePolicy.cloudTempTtlDays}
                onChange={(event) => onStoragePolicyChange({ ...storagePolicy, cloudTempTtlDays: Number(event.target.value) })}
              />
            </label>
            <label className="field">
              <span>失败清理小时</span>
              <input
                type="number"
                min={1}
                value={storagePolicy.purgeFailedAfterHours}
                onChange={(event) => onStoragePolicyChange({ ...storagePolicy, purgeFailedAfterHours: Number(event.target.value) })}
              />
            </label>
            <label className="field span-2">
              <span>WebDAV 地址</span>
              <input value={storagePolicy.webdavEndpoint} onChange={(event) => onStoragePolicyChange({ ...storagePolicy, webdavEndpoint: event.target.value })} />
            </label>
          </div>
          <div className="switch-row admin-switches">
            <label>
              <input type="checkbox" checked={storagePolicy.webdavEnabled} onChange={(event) => onStoragePolicyChange({ ...storagePolicy, webdavEnabled: event.target.checked })} />
              <span>启用 WebDAV</span>
            </label>
            <label>
              <input type="checkbox" checked={storagePolicy.autoSyncOriginals} onChange={(event) => onStoragePolicyChange({ ...storagePolicy, autoSyncOriginals: event.target.checked })} />
              <span>自动同步原图</span>
            </label>
            <label>
              <input type="checkbox" checked={storagePolicy.keepThumbnailsLocally} onChange={(event) => onStoragePolicyChange({ ...storagePolicy, keepThumbnailsLocally: event.target.checked })} />
              <span>缩略图留本地</span>
            </label>
          </div>
        </Section>

        <Section title="商业化底座" action={<ShieldCheck size={17} />}>
          <div className="stack-grid admin-stack-grid">
            <article>
              <KeyRound size={18} />
              <strong>用户系统</strong>
              <span>客户页不显示后台入口；生产环境用 Supabase Auth / Auth.js 管理员鉴权保护 /admin。</span>
            </article>
            <article>
              <ShieldCheck size={18} />
              <strong>支付订单</strong>
              <span>支付回调写入积分流水，失败任务按退款比例退回。</span>
            </article>
            <article>
              <DatabaseZap size={18} />
              <strong>模型与风控</strong>
              <span>模型、端点、质量、积分、存储生命周期集中在这里配置。</span>
            </article>
          </div>
        </Section>
      </section>

      <Section title="系统提示词模板">
        <div className="prompt-template-grid">
          {generationModes.map((mode) => (
            <label className="field" key={mode.id}>
              <span>{mode.title}</span>
              <textarea
                value={systemPrompts[mode.id] ?? mode.systemTemplate}
                onChange={(event) => onSystemPromptsChange(mode.id, event.target.value)}
              />
            </label>
          ))}
        </div>
      </Section>
    </div>
  );
}
