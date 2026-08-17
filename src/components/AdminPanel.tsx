import { useEffect, useState, type FormEvent } from "react";
import { DatabaseZap, KeyRound, Plug, Settings2, ShieldCheck, UserPlus, WalletCards } from "lucide-react";
import { generationModes } from "../data/catalog";
import { imageQualityLabel, imageQualitySummary } from "../lib/imageQuality";
import type {
  CreditPolicy,
  CreditLedgerEntry,
  GeneratedResult,
  ModeKey,
  ModelRoute,
  PaymentOrder,
  PaymentConfigStatus,
  QualityKey,
  RechargePackage,
  StoragePolicy,
  SystemPromptMap,
  UserAccount,
} from "../types";
import type { AdminSummary, ImageProviderSettings } from "../lib/api";
import { Metric, Section } from "./ui";

interface AdminPanelProps {
  routes: ModelRoute[];
  onRoutesChange: (routes: ModelRoute[]) => void;
  users: UserAccount[];
  onUsersChange: (users: UserAccount[]) => void;
  onUserPatch?: (id: string, patch: Partial<UserAccount>) => void | Promise<string | void>;
  onCreditAdjust?: (id: string, amount: number) => void;
  summary?: AdminSummary;
  /** 当前登录的管理员，用来把自己那行的角色和状态设成只读，避免误点把自己关在门外。 */
  currentUserId?: string;
  imageProvider?: ImageProviderSettings;
  onSaveImageProvider?: (input: { baseUrl: string; model: string }) => Promise<string | void>;
  onResetImageProvider?: () => Promise<string | void>;
  onTestImageProvider?: () => Promise<{ ok: boolean; message: string }>;
  /** 后台建号 / 重置密码；返回字符串表示失败原因。 */
  onCreateUser?: (input: { username: string; password: string; name: string; apiKey: string; unlimited: boolean; credits: number }) => Promise<string | void>;
  onResetPassword?: (id: string, password: string) => Promise<string | void>;
  onSetApiKey?: (id: string, apiKey: string) => Promise<string | void>;
  packages: RechargePackage[];
  onPackagesChange: (packages: RechargePackage[]) => void;
  onPackagePatch?: (id: string, patch: Partial<RechargePackage>) => void;
  orders?: PaymentOrder[];
  ledger?: CreditLedgerEntry[];
  generationResults?: GeneratedResult[];
  paymentEvents?: Array<{
    id: string;
    provider: string;
    eventKey: string;
    orderId?: string | null;
    transactionId?: string | null;
    processed: boolean;
    createdAt: string;
  }>;
  paymentConfig?: PaymentConfigStatus;
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
  onUserPatch,
  onCreditAdjust,
  summary,
  currentUserId,
  imageProvider,
  onSaveImageProvider,
  onResetImageProvider,
  onTestImageProvider,
  onCreateUser,
  onResetPassword,
  onSetApiKey,
  packages: packagesList,
  onPackagesChange,
  onPackagePatch,
  orders = [],
  ledger = [],
  generationResults = [],
  paymentEvents = [],
  paymentConfig,
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
    onPackagePatch?.(id, patch);
  };

  const [providerDraft, setProviderDraft] = useState({ baseUrl: "", model: "" });
  const [providerBusy, setProviderBusy] = useState("");
  const [providerNotice, setProviderNotice] = useState("");

  // 后台数据回来（或被别处改过）之后，把输入框同步成当前生效的值
  useEffect(() => {
    if (imageProvider) setProviderDraft({ baseUrl: imageProvider.baseUrl, model: imageProvider.model });
  }, [imageProvider?.baseUrl, imageProvider?.model]);

  const saveProvider = async (event: FormEvent) => {
    event.preventDefault();
    if (!onSaveImageProvider || providerBusy) return;
    setProviderBusy("save");
    setProviderNotice("");
    try {
      const error = await onSaveImageProvider(providerDraft);
      setProviderNotice(error || "已保存，立刻生效，不用重启服务。");
    } finally {
      setProviderBusy("");
    }
  };

  const resetProvider = async () => {
    if (!onResetImageProvider || providerBusy) return;
    setProviderBusy("reset");
    setProviderNotice("");
    try {
      const error = await onResetImageProvider();
      setProviderNotice(error || "已恢复成 .env 里的默认值。");
    } finally {
      setProviderBusy("");
    }
  };

  const testProvider = async () => {
    if (!onTestImageProvider || providerBusy) return;
    setProviderBusy("test");
    setProviderNotice("正在连接…");
    try {
      const result = await onTestImageProvider();
      setProviderNotice(`${result.ok ? "✓ " : "✗ "}${result.message}`);
    } finally {
      setProviderBusy("");
    }
  };

  const [draft, setDraft] = useState({ username: "", password: "", name: "", apiKey: "", unlimited: false, credits: 0 });
  const [creating, setCreating] = useState(false);
  const [createNotice, setCreateNotice] = useState("");

  const submitNewUser = async (event: FormEvent) => {
    event.preventDefault();
    if (!onCreateUser || creating) return;
    setCreating(true);
    setCreateNotice("");
    try {
      const error = await onCreateUser(draft);
      if (error) setCreateNotice(error);
      else {
        setCreateNotice(`已创建账号「${draft.username}」，把账号名和这个密码发给对方就能登录。`);
        setDraft({ username: "", password: "", name: "", apiKey: "", unlimited: false, credits: 0 });
      }
    } finally {
      setCreating(false);
    }
  };

  const resetPassword = async (user: UserAccount) => {
    if (!onResetPassword) return;
    const next = window.prompt(`给「${user.username ?? user.name}」设置新密码（至少 8 位）：`);
    if (!next) return;
    const error = await onResetPassword(user.id, next);
    setCreateNotice(error || `已重置「${user.username ?? user.name}」的密码，请把新密码告诉对方。`);
  };

  const editApiKey = async (user: UserAccount) => {
    if (!onSetApiKey) return;
    const next = window.prompt(
      `给「${user.username ?? user.name}」配置图像接口 Key。\n留空并确定 = 清除，改用站点共享 Key。`,
      "",
    );
    if (next === null) return;
    const error = await onSetApiKey(user.id, next.trim());
    setCreateNotice(error || (next.trim() ? `已给「${user.username ?? user.name}」配好 Key。` : `已清除「${user.username ?? user.name}」的 Key。`));
  };

  const updateUser = (id: string, patch: Partial<UserAccount>) => {
    onUsersChange(users.map((user) => (user.id === id ? { ...user, ...patch } : user)));
    // 服务端可能拒绝（例如取消最后一个管理员），失败要说出来并把界面改回去
    void Promise.resolve(onUserPatch?.(id, patch)).then((error) => {
      if (typeof error === "string" && error) setCreateNotice(error);
    });
  };

  return (
    <div className="admin-layout">
      {summary ? (
        <Section title="运行概览">
          <div className="metric-row admin-summary">
            <Metric label="账号" value={String(summary.users.total)} tone={summary.users.pending ? "warn" : "default"} hint={summary.users.pending ? `${summary.users.pending} 个待开通` : "全部已开通"} />
            <Metric label="今日活跃" value={String(summary.users.active24h)} tone="default" hint={`${summary.users.unlimited} 个无限额度 · ${summary.users.withOwnKey} 个自备 Key`} />
            <Metric label="今日生成" value={String(summary.tasks.last24h)} tone={summary.tasks.failed24h ? "warn" : "good"} hint={summary.tasks.failed24h ? `其中 ${summary.tasks.failed24h} 次失败` : "没有失败任务"} />
            <Metric label="累计成片" value={String(summary.images.total)} tone="default" hint={`今日 +${summary.images.last24h}`} />
            <Metric label="30 天耗分" value={String(summary.creditsSpent30d)} tone="default" hint={summary.selfSignupAllowed ? "自助注册：开放" : "自助注册：已关闭"} />
          </div>
        </Section>
      ) : null}

      {imageProvider && onSaveImageProvider ? (
        <Section title="图像接口" action={<Plug size={17} />}>
          <p className="admin-note">
            这里改的是全站出图走的接口地址和模型名，保存后立刻生效、不用重启。
            留空某一项再保存就回到 <code>.env</code> 里的默认值。
            账号自备的 Key 也走这个地址，所以换地址前先确认大家的 Key 是同一家的。
          </p>
          <form className="admin-provider" onSubmit={saveProvider}>
            <label className="field admin-provider-url">
              <span>
                接口地址
                <em className={`admin-tag ${imageProvider.baseUrlSource === "custom" ? "admin-tag-ok" : ""}`}>
                  {imageProvider.baseUrlSource === "custom" ? "后台已改" : "来自 .env"}
                </em>
              </span>
              <input
                value={providerDraft.baseUrl}
                onChange={(e) => setProviderDraft({ ...providerDraft, baseUrl: e.target.value })}
                placeholder={imageProvider.defaults.baseUrl}
                spellCheck={false}
                autoComplete="off"
              />
            </label>
            <label className="field">
              <span>
                模型名
                <em className={`admin-tag ${imageProvider.modelSource === "custom" ? "admin-tag-ok" : ""}`}>
                  {imageProvider.modelSource === "custom" ? "后台已改" : "来自 .env"}
                </em>
              </span>
              <input
                value={providerDraft.model}
                onChange={(e) => setProviderDraft({ ...providerDraft, model: e.target.value })}
                placeholder={imageProvider.defaults.model}
                spellCheck={false}
                autoComplete="off"
              />
            </label>
            <div className="admin-provider-actions">
              <button type="submit" className="btn btn-primary" disabled={Boolean(providerBusy)}>
                {providerBusy === "save" ? "保存中…" : "保存"}
              </button>
              {onTestImageProvider ? (
                <button type="button" className="btn btn-secondary" disabled={Boolean(providerBusy)} onClick={() => void testProvider()}>
                  {providerBusy === "test" ? "测试中…" : "测试连接"}
                </button>
              ) : null}
              {onResetImageProvider ? (
                <button type="button" className="btn btn-secondary" disabled={Boolean(providerBusy)} onClick={() => void resetProvider()}>
                  恢复默认
                </button>
              ) : null}
            </div>
          </form>
          <p className="admin-provider-current">
            当前生效：<code>{imageProvider.baseUrl}/images/generations</code> · 模型 <code>{imageProvider.model}</code>
            {imageProvider.updatedAt ? ` · 最后修改 ${new Date(imageProvider.updatedAt).toLocaleString("zh-CN")}` : ""}
          </p>
          {providerNotice ? <p className="admin-create-notice">{providerNotice}</p> : null}
        </Section>
      ) : null}

      <Section title="模型路由（仅本机备忘）" action={<Settings2 size={17} />}>
        <p className="admin-note">
          这张表只存在你自己浏览器里，用来记录前台能力和内部模型的对应关系，
          <strong>不会下发给服务端，也不影响实际出图</strong>。真正生效的地址和模型见上面的「图像接口」。
        </p>
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

      <Section title="用户与用量" action={<UserPlus size={17} />}>
        <p className="admin-note">
          {summary && !summary.selfSignupAllowed
            ? "自助注册已关闭：账号只能在这里创建，建出来的一律是普通用户，进不了后台。把账号名和初始密码发给对方即可登录。"
            : "自助注册开放中：别人注册后默认「待开通」，需要在这里点「开通」才放行。"}
          {" "}勾了「无限」的账号生成不扣积分、顶栏显示 ∞；不勾就按「初始积分」计费。
          配了专属 Key 的账号出图走自己那把 Key，不占站点额度也不扣积分。
        </p>

        {onCreateUser ? (
          <form className="admin-create-user" onSubmit={submitNewUser}>
            <label className="field">
              <span>账号名</span>
              <input required value={draft.username} onChange={(e) => setDraft({ ...draft, username: e.target.value })} placeholder="xiaoli" autoComplete="off" spellCheck={false} />
            </label>
            <label className="field">
              <span>初始密码</span>
              <input type="text" required minLength={8} value={draft.password} onChange={(e) => setDraft({ ...draft, password: e.target.value })} placeholder="至少 8 位" autoComplete="off" />
            </label>
            <label className="field">
              <span>显示名</span>
              <input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="可留空" />
            </label>
            <label className="field admin-create-key">
              <span>图像接口 Key（可选）</span>
              <input value={draft.apiKey} onChange={(e) => setDraft({ ...draft, apiKey: e.target.value })} placeholder="配了对方登录就能直接用" autoComplete="off" spellCheck={false} />
            </label>
            <label className="field">
              <span>初始积分</span>
              <input type="number" min={0} value={draft.credits} onChange={(e) => setDraft({ ...draft, credits: Number(e.target.value) })} />
            </label>
            <label className="admin-create-check">
              <input type="checkbox" checked={draft.unlimited} onChange={(e) => setDraft({ ...draft, unlimited: e.target.checked })} />
              <span>无限额度</span>
            </label>
            <button type="submit" className="btn btn-primary" disabled={creating}>
              {creating ? "创建中…" : "创建账号"}
            </button>
          </form>
        ) : null}
        {createNotice ? <p className="admin-create-notice">{createNotice}</p> : null}

        <div className="user-table admin-table">
          <div className="table-row table-head" role="row">
            <span>用户</span>
            <span>角色</span>
            <span>开通</span>
            <span>无限</span>
            <span>余额</span>
            <span>用量</span>
            <span>Key</span>
            <span>状态</span>
            <span>操作</span>
          </div>
          {users.map((user) => {
            const usage = user.usage;
            const approved = user.approved !== false;
            const lastActive = usage?.lastActiveAt ? new Date(usage.lastActiveAt) : null;
            return (
              <div className={`table-row ${approved ? "" : "table-row-pending"}`} role="row" key={user.id}>
                <span className="admin-user-cell">
                  <input className="admin-input" value={user.name} onChange={(event) => updateUser(user.id, { name: event.target.value })} aria-label={`${user.username ?? user.id} 显示名`} />
                  <small>{user.username ?? user.email ?? user.id}</small>
                </span>
                {user.id === currentUserId ? (
                  <span className="admin-self-role" title="这是你自己的账号，角色不能在这里改，防止误点后进不了后台">
                    {user.role} · 你
                  </span>
                ) : (
                  <select className="admin-input" value={user.role} onChange={(event) => updateUser(user.id, { role: event.target.value as UserAccount["role"] })}>
                    <option value="owner">owner</option>
                    <option value="admin">admin</option>
                    <option value="user">user</option>
                  </select>
                )}
                <span>
                  {["owner", "admin"].includes(user.role) ? (
                    <small className="admin-tag admin-tag-ok">管理员</small>
                  ) : (
                    <button
                      type="button"
                      className={`btn ${approved ? "btn-secondary" : "btn-primary"} admin-approve`}
                      title={approved ? "收回开通：该账号将无法登录使用" : "放行：开通后该账号即可登录使用"}
                      onClick={() => updateUser(user.id, { approved: !approved })}
                    >
                      {approved ? "已开通" : "开通"}
                    </button>
                  )}
                </span>
                <span>
                  <button
                    type="button"
                    className={`btn ${user.unlimited ? "btn-primary" : "btn-secondary"} admin-approve`}
                    title={user.unlimited ? "取消无限额度，恢复按积分计费" : "开无限额度：生成不扣积分，登录后顶栏显示 ∞"}
                    onClick={() => updateUser(user.id, { unlimited: !user.unlimited })}
                  >
                    {user.unlimited ? "∞ 已开" : "开"}
                  </button>
                </span>
                <input className="admin-input" type="number" min={0} value={user.unlimited ? 0 : user.credits} readOnly aria-label="余额" />
                <span className="admin-usage" title={lastActive ? `最近活跃 ${lastActive.toLocaleString("zh-CN")}` : "还没有生成记录"}>
                  <strong>{usage?.taskCount ?? 0} 次</strong>
                  <small>
                    {usage?.imageCount ?? 0} 张 · 耗 {usage?.creditsSpent ?? 0} 分
                    {usage?.taskCount30d ? ` · 30 天 ${usage.taskCount30d} 次` : ""}
                    {usage?.ownKeyTaskCount ? ` · 自备 Key ${usage.ownKeyTaskCount} 次` : ""}
                  </small>
                </span>
                <span>
                  <button
                    type="button"
                    className={`admin-tag admin-tag-button ${user.hasOwnApiKey ? "admin-tag-ok" : ""}`}
                    title={user.hasOwnApiKey ? `已配 ${user.apiKeyHint ?? ""}，点击更换或清除` : "点击给这个账号配专属 Key"}
                    onClick={() => void editApiKey(user)}
                    disabled={!onSetApiKey}
                  >
                    {user.hasOwnApiKey ? user.apiKeyHint ?? "已配" : "共享"}
                  </button>
                </span>
                {user.id === currentUserId ? (
                  <span className="admin-self-role" title="不能锁定自己">正常</span>
                ) : (
                  <select className="admin-input" value={user.status} onChange={(event) => updateUser(user.id, { status: event.target.value as UserAccount["status"] })}>
                    <option value="active">正常</option>
                    <option value="locked">锁定</option>
                  </select>
                )}
                <span className="admin-route-actions">
                  <button className="btn btn-secondary" title="加 100 积分" onClick={() => onCreditAdjust?.(user.id, 100)}>+100</button>
                  <button className="btn btn-secondary" title="扣 100 积分" onClick={() => onCreditAdjust?.(user.id, -100)}>-100</button>
                  {onResetPassword ? (
                    <button className="btn btn-secondary" title="重置这个账号的登录密码" onClick={() => void resetPassword(user)}>改密</button>
                  ) : null}
                </span>
              </div>
            );
          })}
        </div>
      </Section>

      <section className="admin-two">
        <Section title="支付配置" action={<ShieldCheck size={17} />}>
          <div className="billing-admin-list">
            {(["alipay", "wechat"] as const).map((provider) => {
              const config = paymentConfig?.[provider];
              return (
                <article key={provider}>
                  <strong>{provider === "alipay" ? "支付宝" : "微信支付"} · {config?.ready ? "配置完整" : "待配置"}</strong>
                  <span>{config?.demoMode ? "当前演示模式" : "当前真实支付模式"}</span>
                  <span>{config?.missing.length ? `缺少：${config.missing.join("、")}` : "商户参数和回调地址已满足启动校验"}</span>
                </article>
              );
            })}
          </div>
        </Section>

        <Section title="支付订单">
          <div className="billing-admin-list">
            {orders.slice(0, 8).map((order) => (
              <article key={order.id}>
                <strong>{order.provider} · {order.status}</strong>
                <span>{order.subject}</span>
                <span>￥{(order.amountCents / 100).toFixed(2)} · {order.credits} 积分</span>
              </article>
            ))}
            {orders.length === 0 ? <span className="muted-text">暂无订单</span> : null}
          </div>
        </Section>

        <Section title="支付事件">
          <div className="billing-admin-list">
            {paymentEvents.slice(0, 8).map((event) => (
              <article key={event.id}>
                <strong>{event.provider} · {event.processed ? "已入账" : "未入账"}</strong>
                <span>{event.orderId || event.eventKey}</span>
                <span>{event.transactionId || event.createdAt}</span>
              </article>
            ))}
            {paymentEvents.length === 0 ? <span className="muted-text">暂无支付通知</span> : null}
          </div>
        </Section>
      </section>

      <Section title="积分流水">
        <div className="billing-admin-list ledger-grid">
          {ledger.slice(0, 12).map((item) => (
            <article key={item.id}>
              <strong>{item.kind} · {item.amount > 0 ? "+" : ""}{item.amount}</strong>
              <span>{item.reason}</span>
              <span>余额 {item.balanceAfter}</span>
            </article>
          ))}
          {ledger.length === 0 ? <span className="muted-text">暂无流水</span> : null}
        </div>
      </Section>

      <Section title="最近生成审计">
        <div className="billing-admin-list generation-history-list">
          {generationResults.slice(0, 12).map((result) => (
            <article key={result.id}>
              <img src={result.imageUrl} alt={result.title} />
              <div>
                <strong>{imageQualityLabel(result.qualityGate)} · {result.title}</strong>
                <span>{result.userName || result.userEmail || result.userId} · {result.mode} · {result.ratioLabel}</span>
                <span>{imageQualitySummary({ qualityGate: result.qualityGate, imageInspection: result.imageInspection })}</span>
              </div>
            </article>
          ))}
          {generationResults.length === 0 ? <span className="muted-text">暂无生成记录</span> : null}
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
              <span>Better Auth 管理登录态；/admin 和后台 API 由 owner/admin 权限保护。</span>
            </article>
            <article>
              <ShieldCheck size={18} />
              <strong>支付订单</strong>
              <span>支付宝和微信支付回调验签后写入服务端积分流水。</span>
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
