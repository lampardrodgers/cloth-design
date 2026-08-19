import { useEffect, useState, type FormEvent } from "react";
import { isAdminRole } from "../lib/accounts";
import { DatabaseZap, KeyRound, Plug, Search, Settings2, ShieldCheck, UserPlus, WalletCards } from "lucide-react";
import { generationModes } from "../data/catalog";
import { imageQualityLabel, imageQualitySummary } from "../lib/imageQuality";
import { isResolutionAllowed, resolutionOrder, resolutionShortLabels } from "../lib/resolution";
import type {
  CreditPolicy,
  CreditLedgerEntry,
  GeneratedResult,
  ModeKey,
  ModelRoute,
  PaymentOrder,
  ResolutionKey,
  PaymentConfigStatus,
  QualityKey,
  RechargePackage,
  SystemPromptMap,
  UserAccount,
} from "../types";
import {
  fetchAdminGenerationResultsPage,
  fetchAdminLedgerPage,
  fetchAdminOrdersPage,
  fetchAdminPaymentEventsPage,
  fetchAdminUsersPage,
} from "../lib/api";
import type { AdminOverviewResponse, AdminPaymentEvent, AdminSummary, ImageProviderSettings, StorageAdminOverview } from "../lib/api";
import { usePagedList } from "../lib/paging";
import { Metric, Pager, Section } from "./ui";
import { AdminShortVideo } from "./AdminShortVideo";

function formatBytes(bytes: number) {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const index = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const value = bytes / 1024 ** index;
  return `${value >= 10 || index === 0 ? Math.round(value) : value.toFixed(1)} ${units[index]}`;
}

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
  imageProviders?: ImageProviderSettings[];
  onSaveImageProvider?: (input: { providerId: string; baseUrl: string; model: string }) => Promise<string | void>;
  onResetImageProvider?: (providerId: string) => Promise<string | void>;
  onTestImageProvider?: (providerId: string) => Promise<{ ok: boolean; message: string }>;
  /** 后台建号 / 重置密码；返回字符串表示失败原因。 */
  onCreateUser?: (input: { username: string; password: string; name: string; apiKey: string; apiProviderId: string; unlimited: boolean; credits: number }) => Promise<string | void>;
  onResetPassword?: (id: string, password: string) => Promise<string | void>;
  onSetApiKey?: (id: string, apiKey: string, providerId: string) => Promise<string | void>;
  packages: RechargePackage[];
  onPackagesChange: (packages: RechargePackage[]) => void;
  onPackagePatch?: (id: string, patch: Partial<RechargePackage>) => void;
  orders?: PaymentOrder[];
  ledger?: CreditLedgerEntry[];
  generationResults?: GeneratedResult[];
  paymentEvents?: AdminPaymentEvent[];
  /** overview 带回来的各列表总数/页数；上面那几个数组只是第一页。 */
  pagination?: AdminOverviewResponse["pagination"];
  paymentConfig?: PaymentConfigStatus;
  creditPolicy: CreditPolicy;
  onCreditPolicyChange: (policy: CreditPolicy) => void;
  storage?: StorageAdminOverview;
  onRunStorageMaintenance?: () => Promise<string | void>;
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
  imageProviders = [],
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
  pagination,
  paymentConfig,
  creditPolicy,
  onCreditPolicyChange,
  storage,
  onRunStorageMaintenance,
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

  const [storageBusy, setStorageBusy] = useState(false);
  const [storageNotice, setStorageNotice] = useState("");
  const runMaintenance = async () => {
    if (!onRunStorageMaintenance || storageBusy) return;
    setStorageBusy(true);
    setStorageNotice("正在巡检…");
    try {
      const error = await onRunStorageMaintenance();
      setStorageNotice(error || "巡检完成。");
    } finally {
      setStorageBusy(false);
    }
  };

  const [providerDrafts, setProviderDrafts] = useState<Record<string, { baseUrl: string; model: string }>>({});
  const [providerBusy, setProviderBusy] = useState("");
  const [providerNotice, setProviderNotice] = useState("");

  // 后台数据回来（或被别处改过）之后，把输入框同步成当前生效的值
  useEffect(() => {
    setProviderDrafts(Object.fromEntries(imageProviders.map((provider) => [provider.id, { baseUrl: provider.baseUrl, model: provider.model }])));
  }, [imageProviders]);

  const saveProvider = async (event: FormEvent, providerId: string) => {
    event.preventDefault();
    if (!onSaveImageProvider || providerBusy) return;
    setProviderBusy(`${providerId}:save`);
    setProviderNotice("");
    try {
      const error = await onSaveImageProvider({ providerId, ...(providerDrafts[providerId] || { baseUrl: "", model: "" }) });
      setProviderNotice(error || "已保存，立刻生效，不用重启服务。");
    } finally {
      setProviderBusy("");
    }
  };

  const resetProvider = async (providerId: string) => {
    if (!onResetImageProvider || providerBusy) return;
    setProviderBusy(`${providerId}:reset`);
    setProviderNotice("");
    try {
      const error = await onResetImageProvider(providerId);
      setProviderNotice(error || "已恢复成 .env 里的默认值。");
    } finally {
      setProviderBusy("");
    }
  };

  const testProvider = async (providerId: string) => {
    if (!onTestImageProvider || providerBusy) return;
    setProviderBusy(`${providerId}:test`);
    setProviderNotice("正在连接…");
    try {
      const result = await onTestImageProvider(providerId);
      setProviderNotice(`${result.ok ? "✓ " : "✗ "}${result.message}`);
    } finally {
      setProviderBusy("");
    }
  };

  /*
   * 后台列表全部走服务端分页：overview 只带回每个列表的第一页，翻页/搜索再按需拉。
   * 之前是一次性拉 80 条塞进 overview、前端再 slice 出 8~12 条渲染，
   * 拉回来的大半白拉，而第 13 条往后根本看不到——数据一多就彻底不能用。
   */
  const usersList = usePagedList<UserAccount>({
    load: fetchAdminUsersPage,
    seedItems: users,
    seedInfo: pagination?.users,
    onSeedPatch: onUsersChange,
  });
  const ordersList = usePagedList<PaymentOrder>({
    load: fetchAdminOrdersPage,
    seedItems: orders,
    seedInfo: pagination?.orders,
  });
  const eventsList = usePagedList<AdminPaymentEvent>({
    load: fetchAdminPaymentEventsPage,
    seedItems: paymentEvents,
    seedInfo: pagination?.paymentEvents,
  });
  const ledgerList = usePagedList<CreditLedgerEntry>({
    load: fetchAdminLedgerPage,
    seedItems: ledger,
    seedInfo: pagination?.ledger,
  });
  const resultsList = usePagedList<GeneratedResult>({
    load: fetchAdminGenerationResultsPage,
    seedItems: generationResults,
    seedInfo: pagination?.generationResults,
  });

  // 搜索框单独存一份草稿，敲字时不要每个键都发请求（回车或点放大镜才查）。
  const [userSearch, setUserSearch] = useState("");
  const submitUserSearch = (event: FormEvent) => {
    event.preventDefault();
    usersList.go({ q: userSearch.trim() });
  };

  const [draft, setDraft] = useState({ username: "", password: "", name: "", apiKey: "", apiProviderId: "default", unlimited: false, credits: 0 });
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
        setDraft({ username: "", password: "", name: "", apiKey: "", apiProviderId: "default", unlimited: false, credits: 0 });
        // 停在第一页时外面会重拉 overview；翻到别的页就得自己刷一下，不然总数还是旧的。
        usersList.refresh();
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
    const error = await onSetApiKey(user.id, next.trim(), user.apiProviderId || "default");
    if (!error) usersList.refresh();
    setCreateNotice(error || (next.trim() ? `已给「${user.username ?? user.name}」配好 Key。` : `已清除「${user.username ?? user.name}」的 Key。`));
  };

  /** 这条线路本身最高能出到几 K；账号上限只能在这个范围内往下压。 */
  const providerCapOf = (providerId?: string): ResolutionKey =>
    imageProviders.find((provider) => provider.id === (providerId || "default"))?.maxResolution ?? "fourK";

  const updateUser = (id: string, patch: Partial<UserAccount>) => {
    usersList.patchItems((list) => list.map((user) => (user.id === id ? { ...user, ...patch } : user)));
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

      {imageProviders.length && onSaveImageProvider ? (
        <Section title="图像接口" action={<Plug size={17} />}>
          <p className="admin-note">
            多套 URL Base 同时生效。用户在账户页选择供应商，服务端会把该供应商的地址、模型和对应 Key 成套使用。
            留空某一项再保存会恢复对应的 <code>.env</code> 默认值。
          </p>
          <div className="admin-provider-list">
            {imageProviders.map((imageProvider) => {
              const providerDraft = providerDrafts[imageProvider.id] || { baseUrl: imageProvider.baseUrl, model: imageProvider.model };
              return (
                <form className="admin-provider" key={imageProvider.id} onSubmit={(event) => void saveProvider(event, imageProvider.id)}>
                  <header className="admin-provider-head">
                    <strong>{imageProvider.name}</strong>
                    <span>{imageProvider.serverKeyConfigured ? "共享 Key 已配置" : "共享 Key 未配置"} · {imageProvider.protocol === "apimart" ? "异步任务协议" : "OpenAI 兼容协议"}</span>
                  </header>
                  <label className="field admin-provider-url">
                    <span>接口地址 <em className={`admin-tag ${imageProvider.baseUrlSource === "custom" ? "admin-tag-ok" : ""}`}>{imageProvider.baseUrlSource === "custom" ? "后台已改" : "来自 .env"}</em></span>
                    <input
                      value={providerDraft.baseUrl}
                      onChange={(event) => setProviderDrafts((current) => ({ ...current, [imageProvider.id]: { ...providerDraft, baseUrl: event.target.value } }))}
                      placeholder={imageProvider.defaults.baseUrl}
                      spellCheck={false}
                      autoComplete="off"
                    />
                  </label>
                  <label className="field">
                    <span>模型名 <em className={`admin-tag ${imageProvider.modelSource === "custom" ? "admin-tag-ok" : ""}`}>{imageProvider.modelSource === "custom" ? "后台已改" : "来自 .env"}</em></span>
                    <input
                      value={providerDraft.model}
                      onChange={(event) => setProviderDrafts((current) => ({ ...current, [imageProvider.id]: { ...providerDraft, model: event.target.value } }))}
                      placeholder={imageProvider.defaults.model}
                      spellCheck={false}
                      autoComplete="off"
                    />
                  </label>
                  <div className="admin-provider-actions">
                    <button type="submit" className="btn btn-primary" disabled={Boolean(providerBusy)}>{providerBusy === `${imageProvider.id}:save` ? "保存中…" : "保存"}</button>
                    {onTestImageProvider ? <button type="button" className="btn btn-secondary" disabled={Boolean(providerBusy)} onClick={() => void testProvider(imageProvider.id)}>{providerBusy === `${imageProvider.id}:test` ? "测试中…" : "测试连接"}</button> : null}
                    {onResetImageProvider ? <button type="button" className="btn btn-secondary" disabled={Boolean(providerBusy)} onClick={() => void resetProvider(imageProvider.id)}>恢复默认</button> : null}
                  </div>
                  <p className="admin-provider-current">当前生效：<code>{imageProvider.baseUrl}/images/generations</code> · 模型 <code>{imageProvider.model}</code>{imageProvider.updatedAt ? ` · 最后修改 ${new Date(imageProvider.updatedAt).toLocaleString("zh-CN")}` : ""}</p>
                </form>
              );
            })}
          </div>
          {providerNotice ? <p className="admin-create-notice">{providerNotice}</p> : null}
        </Section>
      ) : null}

      <AdminShortVideo />

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
          「上限」是这个账号能开到几 K：Packy 线路本身只出 1K，APIMart 才有 2K / 4K，留「跟随线路」就按线路能力走。
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
              <span>URL Base</span>
              <select value={draft.apiProviderId} onChange={(event) => setDraft({ ...draft, apiProviderId: event.target.value })}>
                {imageProviders.map((provider) => <option value={provider.id} key={provider.id}>{provider.name}</option>)}
              </select>
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

        <form className="admin-list-tools" onSubmit={submitUserSearch} role="search">
          <label className="admin-search">
            <Search size={15} aria-hidden="true" />
            <input
              type="search"
              value={userSearch}
              placeholder="搜账号名或显示名"
              aria-label="搜索账号"
              onChange={(event) => {
                setUserSearch(event.target.value);
                // 清空搜索框就立刻回到全部，不用再按一次回车。
                if (!event.target.value.trim() && usersList.query.q) usersList.go({ q: "" });
              }}
            />
          </label>
          <select
            aria-label="按状态筛选"
            value={usersList.query.filter ?? "all"}
            onChange={(event) => usersList.go({ filter: event.target.value })}
          >
            <option value="all">全部账号</option>
            <option value="pending">待开通</option>
            <option value="locked">已锁定</option>
            <option value="unlimited">无限额度</option>
            <option value="own-key">自备 Key</option>
          </select>
          <button type="submit" className="btn btn-secondary" disabled={usersList.loading}>查找</button>
        </form>
        {usersList.error ? <p className="admin-create-notice">{usersList.error}</p> : null}

        <div className="user-table admin-table">
          <div className="table-row table-head" role="row">
            <span>用户</span>
            <span>角色</span>
            <span>开通</span>
            <span>无限</span>
            <span>短视频</span>
            <span>余额</span>
            <span>用量</span>
            <span>线路 / Key</span>
            <span>状态</span>
            <span>操作</span>
          </div>
          {usersList.items.map((user) => {
            const usage = user.usage;
            const approved = user.approved !== false;
            const lastActive = usage?.lastActiveAt ? new Date(usage.lastActiveAt) : null;
            return (
              <div className={`table-row ${approved ? "" : "table-row-pending"}`} role="row" key={user.id}>
                <span className="admin-user-cell">
                  <i className="admin-user-avatar" aria-hidden="true">{(user.name || user.username || "?").trim().charAt(0)}</i>
                  <span className="admin-user-lines">
                    <input
                      className="admin-user-name"
                      value={user.name}
                      onChange={(event) => updateUser(user.id, { name: event.target.value })}
                      aria-label={`${user.username ?? user.id} 显示名`}
                      title="点这里改显示名"
                    />
                    <small>{user.username ?? user.email ?? user.id}</small>
                  </span>
                </span>
                {/* 角色不可改：后台只有 admin 这一个账号能进，其余一律普通用户 */}
                <span className="admin-self-role" title={isAdminRole(user.role) ? "后台管理员账号" : "普通用户，进不了后台"}>
                  {isAdminRole(user.role) ? "管理员" : "用户"}
                  {user.id === currentUserId ? " · 你" : ""}
                </span>
                <span>
                  {isAdminRole(user.role) ? (
                    <small className="admin-tag admin-tag-ok">管理员</small>
                  ) : (
                    <button
                      type="button"
                      className={`btn ${approved ? "btn-secondary" : "btn-primary"} admin-approve`}
                      title={approved ? "收回开通：该账号将无法登录使用" : "放行：开通后该账号即可登录使用"}
                      onClick={() => updateUser(user.id, { approved: !approved })}
                    >
                      {approved ? "已开通" : "待开通"}
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
                    {/* 显示状态而不是动作：写「开」会让人分不清是已开还是点了才开 */}
                    {user.unlimited ? "∞ 已开" : "关"}
                  </button>
                </span>
                <span>
                  {isAdminRole(user.role) ? (
                    <small className="admin-tag admin-tag-ok" title="管理员天然能用短视频">可用</small>
                  ) : (
                    <button
                      type="button"
                      className={`btn ${user.shortVideoEnabled ? "btn-primary" : "btn-secondary"} admin-approve`}
                      title={user.shortVideoEnabled ? "收回短视频：这个账号左栏的「短视频」入口会消失" : "给这个账号打开短视频模块（默认只有管理员能用）"}
                      onClick={() => updateUser(user.id, { shortVideoEnabled: !user.shortVideoEnabled })}
                    >
                      {user.shortVideoEnabled ? "已开" : "关"}
                    </button>
                  )}
                </span>
                {/* 只读值就别做成输入框，看着能改其实不能 */}
                <span className={`admin-balance ${user.unlimited ? "admin-balance-unlimited" : ""}`}>
                  {user.unlimited ? "∞" : user.credits}
                </span>
                <span className="admin-usage" title={lastActive ? `最近活跃 ${lastActive.toLocaleString("zh-CN")}` : "还没有生成记录"}>
                  <strong>{usage?.taskCount ?? 0} 次</strong>
                  <small>
                    {usage?.imageCount ?? 0} 张 · 耗 {usage?.creditsSpent ?? 0} 分
                    {usage?.taskCount30d ? ` · 30 天 ${usage.taskCount30d} 次` : ""}
                    {usage?.ownKeyTaskCount ? ` · 自备 Key ${usage.ownKeyTaskCount} 次` : ""}
                  </small>
                </span>
                <span>
                  <span className="admin-user-provider">
                    <select className="admin-input" value={user.apiProviderId || "default"} onChange={(event) => updateUser(user.id, { apiProviderId: event.target.value })} aria-label={`${user.name} URL Base`}>
                      {imageProviders.map((provider) => <option value={provider.id} key={provider.id}>{provider.name}</option>)}
                    </select>
                    {/* 分辨率上限：留空跟随线路本身的能力，选了就是在线路能力之内再往下压。 */}
                    <select
                      className="admin-input"
                      value={user.maxResolutionSetting || ""}
                      onChange={(event) => updateUser(user.id, { maxResolutionSetting: event.target.value as UserAccount["maxResolutionSetting"] })}
                      aria-label={`${user.name} 分辨率上限`}
                      title={`当前实际上限 ${resolutionShortLabels[user.maxResolution ?? "native"]}${
                        user.maxResolutionSource === "account" ? "（后台设定）" : "（线路能力）"
                      }`}
                    >
                      <option value="">跟随线路 · {resolutionShortLabels[providerCapOf(user.apiProviderId)]}</option>
                      {resolutionOrder.map((key) => (
                        <option value={key} key={key} disabled={!isResolutionAllowed(key, providerCapOf(user.apiProviderId))}>
                          最高 {resolutionShortLabels[key]}
                        </option>
                      ))}
                    </select>
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
                  <button className="btn btn-secondary" title="加 100 积分" disabled={user.unlimited} onClick={() => onCreditAdjust?.(user.id, 100)}>+100</button>
                  <button className="btn btn-secondary" title="扣 100 积分" disabled={user.unlimited} onClick={() => onCreditAdjust?.(user.id, -100)}>-100</button>
                  {onResetPassword ? (
                    <button className="btn btn-secondary" title="重置这个账号的登录密码" onClick={() => void resetPassword(user)}>改密</button>
                  ) : null}
                </span>
              </div>
            );
          })}
          {usersList.items.length === 0 ? (
            <p className="muted-text admin-list-empty">
              {usersList.query.q || (usersList.query.filter ?? "all") !== "all" ? "没有匹配的账号。" : "还没有账号。"}
            </p>
          ) : null}
        </div>
        <Pager
          page={usersList.page}
          pageCount={usersList.pageCount}
          total={usersList.total}
          loading={usersList.loading}
          unit="个账号"
          onChange={(page) => usersList.go({ page })}
        />
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
            {ordersList.items.map((order) => (
              <article key={order.id}>
                <strong>{order.provider} · {order.status}</strong>
                <span>{order.subject}</span>
                <span>￥{(order.amountCents / 100).toFixed(2)} · {order.credits} 积分</span>
              </article>
            ))}
            {ordersList.total === 0 ? <span className="muted-text">暂无订单</span> : null}
          </div>
          <Pager
            page={ordersList.page}
            pageCount={ordersList.pageCount}
            total={ordersList.total}
            loading={ordersList.loading}
            unit="笔"
            onChange={(page) => ordersList.go({ page })}
          />
        </Section>

        <Section title="支付事件">
          <div className="billing-admin-list">
            {eventsList.items.map((event) => (
              <article key={event.id}>
                <strong>{event.provider} · {event.processed ? "已入账" : "未入账"}</strong>
                <span>{event.orderId || event.eventKey}</span>
                <span>{event.transactionId || event.createdAt}</span>
              </article>
            ))}
            {eventsList.total === 0 ? <span className="muted-text">暂无支付通知</span> : null}
          </div>
          <Pager
            page={eventsList.page}
            pageCount={eventsList.pageCount}
            total={eventsList.total}
            loading={eventsList.loading}
            onChange={(page) => eventsList.go({ page })}
          />
        </Section>
      </section>

      <Section title="生成审计">
        <div className="billing-admin-list generation-history-list">
          {resultsList.items.map((result) => (
            <article key={result.id}>
              {/* 一页十五张缩略图（3 列 × 5 行），全部懒加载：滚不到的那些不占带宽也不占解码 */}
              <img src={result.imageUrl} alt={result.title} loading="lazy" decoding="async" />
              <div>
                <strong>{imageQualityLabel(result.qualityGate)} · {result.title}</strong>
                <span>{result.userName || result.userEmail || result.userId} · {result.mode} · {result.ratioLabel}</span>
                <span>{imageQualitySummary({ qualityGate: result.qualityGate, imageInspection: result.imageInspection })}</span>
              </div>
            </article>
          ))}
          {resultsList.total === 0 ? <span className="muted-text">暂无生成记录</span> : null}
        </div>
        <Pager
          page={resultsList.page}
          pageCount={resultsList.pageCount}
          total={resultsList.total}
          loading={resultsList.loading}
          unit="张"
          onChange={(page) => resultsList.go({ page })}
        />
      </Section>

      <section className="admin-two">
        <Section title="存储策略" action={<DatabaseZap size={17} />}>
          <p className="admin-note">
            成片在服务器上固定保留 <strong>{storage?.retentionDays ?? 3} 天</strong>（写死，不开放修改），每小时巡检一次，到期删文件、记录标「已清理」。
            长期保存靠每个账号自己在「文件管理」里配的本地文件夹或 WebDAV 云盘。
          </p>
          <div className="metric-row admin-metrics">
            <Metric label="服务器文件" value={`${storage?.fileCount ?? 0} 个`} hint={formatBytes(storage?.diskBytes ?? 0)} />
            <Metric label="暂存中" value={`${storage?.active ?? 0} 张`} hint={`${storage?.retentionDays ?? 3} 天内`} />
            <Metric label="已推云盘" value={`${storage?.backedUp ?? 0} 张`} hint={`${storage?.webdavUsers ?? 0} 个账号启用了 WebDAV`} />
            <Metric label="已清理" value={`${storage?.expired ?? 0} 张`} tone="default" />
          </div>
          <div className="admin-provider-actions">
            <button type="button" className="btn btn-secondary" onClick={runMaintenance} disabled={storageBusy || !onRunStorageMaintenance}>
              {storageBusy ? "巡检中…" : "立即巡检一次"}
            </button>
            <small className="muted-text">
              {storage?.lastMaintenance
                ? `上次 ${new Date(storage.lastMaintenance.ranAt).toLocaleString("zh-CN")}：清理 ${storage.lastMaintenance.expired} 条、删文件 ${storage.lastMaintenance.filesDeleted + storage.lastMaintenance.orphansDeleted} 个、释放 ${formatBytes(storage.lastMaintenance.bytesFreed)}`
                : "服务启动后还没跑过巡检（首次在启动 30 秒后）"}
            </small>
          </div>
          {storageNotice ? <p className="admin-create-notice">{storageNotice}</p> : null}
        </Section>

        <Section title="商业化底座" action={<ShieldCheck size={17} />}>
          <div className="stack-grid admin-stack-grid">
            <article>
              <KeyRound size={18} />
              <strong>用户系统</strong>
              <span>Better Auth 管理登录态；/admin 和后台 API 只对 admin 这一个管理员账号开放。</span>
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

      {/* 积分流水平时不看，收起来放在最底下，点开才拉展开的那几页。 */}
      <Section title="积分流水" collapsible defaultOpen={false} summary={`共 ${ledgerList.total} 条`}>
        <div className="billing-admin-list ledger-grid">
          {ledgerList.items.map((item) => (
            <article key={item.id}>
              <strong>{item.kind} · {item.amount > 0 ? "+" : ""}{item.amount}</strong>
              <span>{item.reason}</span>
              <span>余额 {item.balanceAfter}</span>
            </article>
          ))}
          {ledgerList.total === 0 ? <span className="muted-text">暂无流水</span> : null}
        </div>
        <Pager
          page={ledgerList.page}
          pageCount={ledgerList.pageCount}
          total={ledgerList.total}
          loading={ledgerList.loading}
          onChange={(page) => ledgerList.go({ page })}
        />
      </Section>
    </div>
  );
}
