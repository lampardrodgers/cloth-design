import { useEffect, useMemo, useState } from "react";
import {
  Archive,
  ClipboardList,
  Images,
  LayoutDashboard,
  Sparkles,
  UserCog,
} from "lucide-react";
import {
  creditPolicy as defaultCreditPolicy,
  generationModes,
  initialReferences,
  initialStoragePolicy,
  initialTasks,
  modelRoutes,
  ratioOptions,
} from "./data/catalog";
import {
  adjustAdminCredits,
  completeDemoPayment,
  createPaymentOrder,
  deleteGenerationResult,
  fetchAdminOverview,
  fetchApiConfig,
  fetchMe,
  fetchPaymentOrder,
  requestGeneration,
  signOut,
  updateAdminPackage,
  updateGenerationResultStorageStatus,
  updateAdminUser,
  type AdminOverviewResponse,
  type ApiConfig,
} from "./lib/api";
import { buildEditablePrompt, buildOptimizedPrompt } from "./lib/prompt";
import type {
  CreditPolicy,
  CreditLedgerEntry,
  GeneratedResult,
  GenerationMode,
  GenerationTask,
  ModeKey,
  PaymentCapabilities,
  PaymentConfigStatus,
  PaymentOrder,
  PaymentProvider,
  RechargePackage,
  ReferenceImage,
  ReferenceRole,
  StoragePolicy,
  StudioSettings,
  SystemPromptMap,
  UserAccount,
  ViewKey,
} from "./types";
import { AccountPanel } from "./components/AccountPanel";
import { AdminPanel } from "./components/AdminPanel";
import { AuthPanel } from "./components/AuthPanel";
import { StoragePanel } from "./components/StoragePanel";
import { StudioWorkspace } from "./components/StudioWorkspace";
import { TaskRail } from "./components/TaskRail";
import { WorkflowCenter } from "./components/WorkflowCenter";

const navigation: Array<{ id: ViewKey; label: string; icon: typeof Images }> = [
  { id: "studio", label: "生成", icon: Images },
  { id: "workflows", label: "功能", icon: Sparkles },
  { id: "account", label: "账户", icon: UserCog },
  { id: "storage", label: "存储", icon: Archive },
];

const initialSystemPrompts = generationModes.reduce((map, mode) => {
  map[mode.id] = mode.systemTemplate;
  return map;
}, {} as SystemPromptMap);

const initialSettings: StudioSettings = {
  mode: "text",
  ratioId: "1-1",
  resolution: "native",
  quality: "high",
  outputFormat: "png",
  background: "auto",
  moderation: "auto",
  quantity: 1,
  compression: 90,
  inputFidelity: "standard",
  streamPreview: true,
  preserveIdentity: true,
};

const defaultPaymentCapabilities: PaymentCapabilities = {
  alipay: { enabled: true, demoMode: true, demoCompleteAllowed: false },
  wechat: { enabled: true, demoMode: true, demoCompleteAllowed: false },
};

const defaultPaymentConfig: PaymentConfigStatus = {
  alipay: { provider: "alipay", enabled: true, demoMode: true, ready: false, missing: [] },
  wechat: { provider: "wechat", enabled: true, demoMode: true, ready: false, missing: [] },
};

function nowLabel() {
  return new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit" }).format(new Date());
}

function readStoredState<T>(key: string, fallback: T): T {
  try {
    const rawValue = window.localStorage.getItem(key);
    return rawValue ? (JSON.parse(rawValue) as T) : fallback;
  } catch {
    return fallback;
  }
}

function useStoredState<T>(key: string, fallback: T) {
  const [value, setValue] = useState<T>(() => readStoredState(key, fallback));

  useEffect(() => {
    try {
      window.localStorage.setItem(key, JSON.stringify(value));
    } catch {
      // Ignore quota errors; the app can continue with in-memory state.
    }
  }, [key, value]);

  return [value, setValue] as const;
}

const referenceAlphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");

function orderedReferenceLabel(index: number) {
  return referenceAlphabet[index] ?? `${index + 1}`;
}

function takeReferenceForRole(references: ReferenceImage[], role: ReferenceRole) {
  const withImage = references.findIndex((ref) => ref.role === role && (ref.previewUrl || ref.fileName));
  const index = withImage >= 0 ? withImage : references.findIndex((ref) => ref.role === role);
  if (index < 0) return null;
  return references.splice(index, 1)[0];
}

function normalizeModeReferences(references: ReferenceImage[], requiredRefs: ReferenceRole[]) {
  if (requiredRefs.length === 0) return references;
  const remaining = [...references];
  const required = requiredRefs.map((role) => {
    const existing = takeReferenceForRole(remaining, role);
    if (existing) return existing;
    return {
      id: `ref-required-${role}-${Date.now()}`,
      label: "",
      role,
      note: "",
    } satisfies ReferenceImage;
  });
  const ordered = [...required, ...remaining];
  return ordered.map((ref, index) => ({
    ...ref,
    label: orderedReferenceLabel(index),
  }));
}

function mergeResults(existing: GeneratedResult[], incoming: GeneratedResult[] = []) {
  const seen = new Set<string>();
  return [...incoming, ...existing].filter((item) => {
    if (seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });
}

function App() {
  const [view, setView] = useState<ViewKey>("studio");
  const [path, setPath] = useState(() => window.location.pathname);
  const [settings, setSettings] = useStoredState<StudioSettings>("clothdesign:settings", initialSettings);
  const [references, setReferences] = useState<ReferenceImage[]>(initialReferences);
  const [prompt, setPrompt] = useState(generationModes.find((mode) => mode.id === initialSettings.mode)?.promptStarter ?? "");
  const [optimizationNotice, setOptimizationNotice] = useState("");
  const [taskMenuOpen, setTaskMenuOpen] = useState(false);
  const [tasks, setTasks] = useStoredState<GenerationTask[]>("clothdesign:tasks", initialTasks);
  const [results, setResults] = useStoredState<GeneratedResult[]>("clothdesign:results", []);
  const [currentUser, setCurrentUser] = useState<UserAccount | null>(null);
  const [packages, setPackages] = useState<RechargePackage[]>([]);
  const [orders, setOrders] = useState<PaymentOrder[]>([]);
  const [ledger, setLedger] = useState<CreditLedgerEntry[]>([]);
  const [activeOrder, setActiveOrder] = useState<PaymentOrder | null>(null);
  const [paymentCapabilities, setPaymentCapabilities] = useState<PaymentCapabilities>(defaultPaymentCapabilities);
  const [paymentConfig, setPaymentConfig] = useState<PaymentConfigStatus>(defaultPaymentConfig);
  const [authLoading, setAuthLoading] = useState(true);
  const [authError, setAuthError] = useState("");
  const [adminOverview, setAdminOverview] = useState<AdminOverviewResponse | null>(null);
  const [routes, setRoutes] = useStoredState("clothdesign:routes", modelRoutes);
  const [creditPolicy, setCreditPolicy] = useStoredState<CreditPolicy>("clothdesign:creditPolicy", defaultCreditPolicy);
  const [systemPrompts, setSystemPrompts] = useStoredState<SystemPromptMap>("clothdesign:systemPrompts", initialSystemPrompts);
  const [storagePolicy, setStoragePolicy] = useStoredState<StoragePolicy>("clothdesign:storage", initialStoragePolicy);
  const [apiConfig, setApiConfig] = useState<ApiConfig | null>(null);
  const providerHealth = apiConfig?.providerHealth;

  const activeMode = useMemo(() => {
    const mode = generationModes.find((item) => item.id === settings.mode) ?? generationModes[0];
    return { ...mode, systemTemplate: systemPrompts[mode.id] ?? mode.systemTemplate };
  }, [settings.mode, systemPrompts]);
  const runningTasks = tasks.filter((task) => task.status === "running").length;

  useEffect(() => {
    const handlePopState = () => setPath(window.location.pathname);
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, []);

  useEffect(() => {
    const mode = generationModes.find((item) => item.id === settings.mode);
    if (mode) {
      setPrompt((current) => (current.trim().length > 0 ? current : mode.promptStarter));
      setReferences((current) => normalizeModeReferences(current, mode.requiredRefs));
    }
  }, [settings.mode]);

  useEffect(() => {
    const selectedRatio = ratioOptions.find((ratio) => ratio.id === settings.ratioId);
    if (selectedRatio && !selectedRatio.allowedResolutions.includes(settings.resolution)) {
      const fallback = ratioOptions.find((ratio) => ratio.allowedResolutions.includes(settings.resolution)) ?? ratioOptions[1];
      setSettings((current) => ({ ...current, ratioId: fallback.id }));
    }
  }, [settings.resolution, settings.ratioId]);

  useEffect(() => {
    fetchApiConfig()
      .then(setApiConfig)
      .catch(() => setApiConfig({ mode: "demo", providerReady: false, imageModelConfigured: false, authEnabled: true, port: 8888 }));
  }, []);

  const loadAccount = async () => {
    setAuthError("");
    try {
      const data = await fetchMe();
      setCurrentUser(data.account);
      setPackages(data.packages);
      setOrders(data.orders);
      setLedger(data.ledger);
      setPaymentCapabilities(data.paymentCapabilities);
      setResults((items) => mergeResults(items, data.generationResults));
      if ("paymentConfig" in data) setPaymentConfig(data.paymentConfig as PaymentConfigStatus);
      return data.account;
    } catch (error) {
      setCurrentUser(null);
      setAuthError(error instanceof Error ? error.message : "请先登录");
      return null;
    } finally {
      setAuthLoading(false);
    }
  };

  useEffect(() => {
    void loadAccount();
  }, []);

  useEffect(() => {
    if (!activeOrder || activeOrder.status !== "pending") return;
    const timer = window.setInterval(async () => {
      try {
        const data = await fetchPaymentOrder(activeOrder.id);
        setActiveOrder(data.order);
        setCurrentUser(data.account);
        setLedger(data.ledger);
        if (data.order.status === "paid") {
          await loadAccount();
        }
      } catch {
        // Polling is best-effort; the next manual refresh will reconcile state.
      }
    }, 2500);
    return () => window.clearInterval(timer);
  }, [activeOrder?.id, activeOrder?.status]);

  useEffect(() => {
    if (!path.startsWith("/admin") || !currentUser || !["owner", "admin"].includes(currentUser.role)) return;
    fetchAdminOverview().then(setAdminOverview).catch(() => setAdminOverview(null));
  }, [path, currentUser?.id, currentUser?.role]);

  const handleSettingsChange = (patch: Partial<StudioSettings>) => {
    setSettings((current) => {
      const next = { ...current, ...patch };
      if (patch.outputFormat === "png") {
        next.compression = 100;
      }
      return next;
    });
  };

  const handleModePrompt = (modeId: StudioSettings["mode"]) => {
    const mode = generationModes.find((item) => item.id === modeId);
    handleSettingsChange({ mode: modeId });
    if (mode) {
      setPrompt(mode.promptStarter);
      setReferences((current) => normalizeModeReferences(current, mode.requiredRefs));
    }
  };

  const handleOptimize = () => {
    setPrompt(buildEditablePrompt(prompt, activeMode, references, settings));
    setOptimizationNotice("已按当前功能、参考图关系和商业出图质量补齐提示词。");
  };

  const handleGenerate = async (mode: GenerationMode, cost: number) => {
    const ratio = ratioOptions.find((item) => item.id === settings.ratioId) ?? ratioOptions[0];
    const taskId = `task-${Date.now()}`;
    const taskPrompt = prompt.trim() || mode.promptStarter;
    const nextTask: GenerationTask = {
      id: taskId,
      mode: mode.id,
      prompt: taskPrompt,
      status: "running",
      progress: 8,
      credits: cost,
      createdAt: nowLabel(),
      message: settings.streamPreview ? "生成中，已开启 partial preview" : "生成中",
    };

    setTasks((items) => [nextTask, ...items]);

    const progressTimer = window.setTimeout(() => {
      setTasks((items) => items.map((task) => (task.id === taskId ? { ...task, progress: 58, message: "正在合成服装细节" } : task)));
    }, 650);

    try {
      const response = await requestGeneration({
        mode,
        settings,
        references,
        prompt: buildOptimizedPrompt(taskPrompt, mode, references, settings),
        apiSize: ratio.apiSize,
        ratioLabel: ratio.label,
      });
      setApiConfig({
        mode: response.mode,
        providerReady: response.providerReady,
        imageModelConfigured: response.imageModelConfigured,
        authEnabled: response.authEnabled,
        port: response.port,
      });
      if (response.account) setCurrentUser(response.account);

      const serverTaskId = response.taskId || taskId;
      const newResults = response.results.map((result, index) => ({
        id: `result-${serverTaskId}-${index}`,
        taskId: serverTaskId,
        title: `${mode.shortTitle}-${nowLabel().replace(":", "")}-${index + 1}`,
        mode: mode.id,
        ratioLabel: ratio.label,
        storageStatus: storagePolicy.autoSyncOriginals ? "cloud-temp" : "local-cache",
        credits: Math.ceil(cost / Math.max(response.results.length, 1)),
        imageUrl: result.imageUrl,
        imageInspection: result.imageInspection,
        qualityGate: result.qualityGate,
        createdAt: nowLabel(),
      })) satisfies GeneratedResult[];

      setTasks((items) =>
        items.map((task) =>
          task.id === taskId
            ? {
                ...task,
                id: serverTaskId,
                status: "success",
                progress: 100,
                message:
                  response.mode === "demo"
                    ? `${response.message} 结果已进入演示存储。`
                    : storagePolicy.autoSyncOriginals
                      ? "已进入云端临时区，等待 WebDAV 归档"
                      : "已保存在本地缓存",
              }
            : task,
        ),
      );
      setResults((items) => [...newResults, ...items]);
    } catch (error) {
      setTasks((items) =>
        items.map((task) =>
          task.id === taskId
            ? {
                ...task,
                status: "failed",
                progress: 100,
                credits: 0,
                message: error instanceof Error ? error.message : "生成失败",
              }
            : task,
        ),
      );
    } finally {
      window.clearTimeout(progressTimer);
    }
  };

  const handleRetryTask = (task: GenerationTask) => {
    const mode = generationModes.find((item) => item.id === task.mode) ?? generationModes[0];
    setPrompt(task.prompt);
    setSettings((current) => ({ ...current, mode: mode.id }));
    setView("studio");
    setTaskMenuOpen(false);
  };

  const handleRecharge = async (pkg: RechargePackage, provider: PaymentProvider) => {
    try {
      const response = await createPaymentOrder(pkg.id, provider);
      setActiveOrder(response.order);
      setOrders((items) => [response.order, ...items.filter((item) => item.id !== response.order.id)]);
      setPaymentCapabilities(response.paymentCapabilities);
    } catch (error) {
      setAuthError(error instanceof Error ? error.message : "创建支付订单失败");
    }
  };

  const handleDemoComplete = async (order: PaymentOrder) => {
    try {
      const response = await completeDemoPayment(order.id);
      setActiveOrder(response.order);
      setCurrentUser(response.account);
      setLedger(response.ledger);
      await loadAccount();
    } catch (error) {
      setAuthError(error instanceof Error ? error.message : "模拟支付失败");
    }
  };

  const handleSignOut = async () => {
    await signOut().catch(() => undefined);
    setCurrentUser(null);
    setAdminOverview(null);
    setActiveOrder(null);
  };

  const handleSetAdminPath = (nextPath: string) => {
    window.history.pushState({}, "", nextPath);
    setPath(nextPath);
    if (nextPath !== "/admin") setView("studio");
  };

  const handleSyncResult = async (id: string) => {
    try {
      const { result } = await updateGenerationResultStorageStatus(id, "webdav");
      setResults((items) => items.map((item) => (item.id === id ? { ...item, storageStatus: result.storageStatus } : item)));
      setAdminOverview((current) =>
        current
          ? { ...current, generationResults: current.generationResults.map((item) => (item.id === id ? { ...item, storageStatus: result.storageStatus } : item)) }
          : current,
      );
    } catch (error) {
      setAuthError(error instanceof Error ? error.message : "同步 WebDAV 状态失败");
    }
  };

  const handleDeleteResult = async (id: string) => {
    const deletedResult = results.find((item) => item.id === id);
    const remainingResults = results.filter((item) => item.id !== id);
    try {
      await deleteGenerationResult(id);
      setResults((items) => items.filter((item) => item.id !== id));
      if (deletedResult?.taskId && !remainingResults.some((item) => item.taskId === deletedResult.taskId)) {
        setTasks((items) => items.filter((task) => task.id !== deletedResult.taskId));
      }
      if (deletedResult?.imageUrl) {
        setReferences((items) => items.filter((item) => item.previewUrl !== deletedResult.imageUrl));
      }
      setAdminOverview((current) =>
        current ? { ...current, generationResults: current.generationResults.filter((item) => item.id !== id) } : current,
      );
    } catch (error) {
      setAuthError(error instanceof Error ? error.message : "删除生成结果失败");
    }
  };

  const renderView = () => {
    if (!currentUser) return null;
    if (view === "studio") {
      return (
        <StudioWorkspace
          settings={settings}
          prompt={prompt}
          references={references}
          results={results}
          user={currentUser}
          creditPolicy={creditPolicy}
          optimizationNotice={optimizationNotice}
          onSettingsChange={(patch) => (patch.mode ? handleModePrompt(patch.mode) : handleSettingsChange(patch))}
          onPromptChange={(value) => {
            setPrompt(value);
            setOptimizationNotice("");
          }}
          onReferencesChange={setReferences}
          onOptimize={handleOptimize}
          onGenerate={handleGenerate}
          onUseAsReference={setReferences}
          onSyncResult={handleSyncResult}
          onDeleteResult={handleDeleteResult}
        />
      );
    }

    if (view === "account") {
      return (
        <main className="single-view panel-scroll">
          <AccountPanel
            currentUser={currentUser}
            packages={packages}
            orders={orders}
            ledger={ledger}
            paymentCapabilities={paymentCapabilities}
            generationResults={results}
            activeOrder={activeOrder}
            onRecharge={handleRecharge}
            onDemoComplete={handleDemoComplete}
          />
        </main>
      );
    }

    if (view === "workflows") {
      return <WorkflowCenter generatedResults={results} />;
    }

    return (
      <main className="single-view panel-scroll">
        <StoragePanel policy={storagePolicy} onChange={setStoragePolicy} results={results} />
      </main>
    );
  };

  if (authLoading) {
    return <main className="auth-shell">正在加载账号...</main>;
  }

  if (!currentUser) {
    return (
      <>
        <AuthPanel onAuthenticated={async () => {
          await loadAccount();
        }} />
        {authError && !authError.includes("请先登录") ? <div className="auth-error">{authError}</div> : null}
      </>
    );
  }

  if (path.startsWith("/admin")) {
    if (!["owner", "admin"].includes(currentUser.role)) {
      return (
        <div className="admin-shell">
          <header className="admin-topbar">
            <div className="brand">
              <LayoutDashboard size={18} />
              <strong>ClothDesign Admin</strong>
            </div>
            <button className="btn btn-secondary" onClick={() => handleSetAdminPath("/")}>
              返回客户页
            </button>
          </header>
          <main className="admin-page panel-scroll">
            <div className="inline-warning">当前账号没有管理员权限。</div>
          </main>
        </div>
      );
    }

    return (
      <div className="admin-shell">
        <header className="admin-topbar">
          <div className="brand">
            <LayoutDashboard size={18} />
            <strong>ClothDesign Admin</strong>
          </div>
          <button className="btn btn-secondary" onClick={() => handleSetAdminPath("/")}>
            返回客户页
          </button>
        </header>
        <main className="admin-page panel-scroll">
          <AdminPanel
            routes={routes}
            onRoutesChange={setRoutes}
            users={adminOverview?.users ?? [currentUser]}
            onUsersChange={(items) => setAdminOverview((current) => (current ? { ...current, users: items } : current))}
            onUserPatch={(id, patch) => {
              updateAdminUser(id, patch)
                .then(({ user }) =>
                  setAdminOverview((current) =>
                    current ? { ...current, users: current.users.map((item) => (item.id === id ? user : item)) } : current,
                  ),
                )
                .catch((error) => setAuthError(error instanceof Error ? error.message : "用户更新失败"));
            }}
            onCreditAdjust={(id, amount) => {
              adjustAdminCredits(id, amount, `后台人工调分 ${amount > 0 ? "+" : ""}${amount}`)
                .then(({ user }) =>
                  setAdminOverview((current) =>
                    current ? { ...current, users: current.users.map((item) => (item.id === id ? user : item)) } : current,
                  ),
                )
                .then(() => fetchAdminOverview().then(setAdminOverview))
                .catch((error) => setAuthError(error instanceof Error ? error.message : "人工调分失败"));
            }}
            packages={adminOverview?.packages ?? packages}
            onPackagesChange={(items) => setAdminOverview((current) => (current ? { ...current, packages: items } : current))}
            onPackagePatch={(id, patch) => {
              const normalizedPatch = {
                ...patch,
                amountCents: patch.amountCents ?? (patch.price !== undefined ? Math.round(patch.price * 100) : undefined),
              };
              updateAdminPackage(id, normalizedPatch)
                .then(({ package: item }) => {
                  setAdminOverview((current) =>
                    current ? { ...current, packages: current.packages.map((pkg) => (pkg.id === id ? item : pkg)) } : current,
                  );
                  setPackages((items) => items.map((pkg) => (pkg.id === id ? item : pkg)).filter((pkg) => pkg.enabled !== false));
                })
                .catch((error) => setAuthError(error instanceof Error ? error.message : "套餐更新失败"));
            }}
            orders={adminOverview?.orders}
            ledger={adminOverview?.ledger}
            paymentEvents={adminOverview?.paymentEvents}
            generationResults={adminOverview?.generationResults}
            paymentConfig={adminOverview?.paymentConfig ?? paymentConfig}
            creditPolicy={creditPolicy}
            onCreditPolicyChange={setCreditPolicy}
            storagePolicy={storagePolicy}
            onStoragePolicyChange={setStoragePolicy}
            systemPrompts={systemPrompts}
            onSystemPromptsChange={(modeId: ModeKey, value: string) =>
              setSystemPrompts((items) => ({ ...items, [modeId]: value }))
            }
          />
        </main>
      </div>
    );
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand">
          <LayoutDashboard size={18} />
          <strong>ClothDesign AI</strong>
        </div>
        <div className="top-status">
          <span>{activeMode.title}</span>
          <span>{providerHealth?.label ?? (apiConfig?.mode === "live" ? "图像引擎就绪" : "演示模式")}</span>
          <span className="credit-pill">{currentUser.credits} 积分</span>
          <button className="task-menu-button" onClick={handleSignOut}>
            <span>退出</span>
          </button>
          <button className="task-menu-button" onClick={() => setTaskMenuOpen((open) => !open)} aria-expanded={taskMenuOpen}>
            <ClipboardList size={16} />
            <span>任务</span>
            {runningTasks > 0 ? <em>{runningTasks}</em> : null}
          </button>
          {taskMenuOpen ? (
            <div className="task-popover">
              <TaskRail tasks={tasks} results={results} onRetry={handleRetryTask} />
            </div>
          ) : null}
        </div>
      </header>

      <div className="app-body">
        <nav className="rail" aria-label="主导航">
          {navigation.map((item) => {
            const Icon = item.icon;
            return (
              <button
                key={item.id}
                className={view === item.id ? "active" : ""}
                onClick={() => setView(item.id)}
                aria-label={item.label}
                title={item.label}
              >
                <Icon size={19} />
                <span>{item.label}</span>
              </button>
            );
          })}
        </nav>
        {renderView()}
      </div>
    </div>
  );
}

export default App;
