import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  creditPolicy as defaultCreditPolicy,
  generationModes,
  initialReferences,
  initialTasks,
  modelRoutes,
  ratioOptions,
} from "./data/catalog";
import {
  adjustAdminCredits,
  archiveAllGenerationResults,
  archiveGenerationResult,
  clearMyApiKey,
  createAdminUser,
  resetAdminUserPassword,
  resetImageProvider,
  saveImageProvider,
  setAdminUserApiKey,
  testImageProvider,
  testMyImageProvider,
  completeDemoPayment,
  createPaymentOrder,
  deleteGenerationResult,
  fetchAdminOverview,
  fetchApiConfig,
  fetchMe,
  fetchPaymentOrder,
  fetchStorage,
  requestGeneration,
  runAdminStorageMaintenance,
  saveMyApiKey,
  selectMyImageProvider,
  saveWebdavSettings,
  testWebdavSettings,
  endDebugSession,
  signOut,
  updateAdminPackage,
  updateAdminUser,
  type AdminOverviewResponse,
  type ApiConfig,
  type StorageResponse,
  type WebdavSettingsInput,
  setUserShortVideoAccess,
} from "./lib/api";
import { folderPermission, forgetLocalFolder, loadSavedFolder, localFolderSupported, pickLocalFolder, saveImageToFolder } from "./lib/localFolder";
import { outputSizeForRatio } from "./lib/outputSize";
import { capabilityFromAccount } from "./lib/resolution";
import { resultFileName } from "./lib/resultFiles";
import { buildEditablePrompt, buildOptimizedPrompt } from "./lib/prompt";
import {
  attachmentsToReferences,
  buildAnnotationEditPrompt,
  buildFreePrompt,
  buildSketchPrompt,
  buildSubmissionRecord,
  MAX_SUBMISSION_RECORDS,
} from "./lib/freeStudio";
import { useCappedStoredState, useStoredState } from "./lib/storedState";
import type {
  CreditPolicy,
  CreditLedgerEntry,
  GeneratedResult,
  GenerationMode,
  GenerationTask,
  ImageProviderOption,
  ModeKey,
  PaymentCapabilities,
  PaymentConfigStatus,
  PaymentOrder,
  PaymentProvider,
  RechargePackage,
  ReferenceImage,
  ReferenceRole,
  LocalFolderPolicy,
  StudioSettings,
  SubmissionRecord,
  SystemPromptMap,
  UserAccount,
  ViewKey,
} from "./types";
import { AccountPanel } from "./components/AccountPanel";
import { AdminPanel } from "./components/AdminPanel";
import { AuthPanel } from "./components/AuthPanel";
import { FreeStudio, type FreeGenerationInput, type FreeLayout } from "./components/FreeStudio";
import { ReferencePanel } from "./components/ReferencePanel";
import { StoragePanel, type LocalFolderState } from "./components/StoragePanel";
import { isAdminRole } from "./lib/accounts";
import { ShortVideoHub } from "./components/ShortVideoHub";
import { StudioWorkspace } from "./components/StudioWorkspace";
import { TaskRail } from "./components/TaskRail";
import { WorkflowCenter } from "./components/WorkflowCenter";

const navigation: Array<{
  id: ViewKey;
  label: string;
  displayLabel: string;
  description: string;
}> = [
  { id: "free", label: "自由", displayLabel: "自由创作", description: "简易 / 画布" },
  { id: "studio", label: "生成", displayLabel: "开始创作", description: "图片生成" },
  { id: "workflows", label: "功能", displayLabel: "更多工具", description: "专项流程" },
  { id: "account", label: "账户", displayLabel: "账户与积分", description: "套餐明细" },
  { id: "storage", label: "存储", displayLabel: "文件管理", description: "保存归档" },
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

const referenceAlphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");
const legacyDemoTaskIds = new Set(["task-1027", "task-1028"]);

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

/**
 * 任务和成片在浏览器本地留多少条。
 * 完整历史在服务端（文件管理页按页翻），本地这份只是「最近用过的」——
 * localStorage 只有 5MB 上下，不封顶的话出图上千之后写入就会开始失败。
 */
const LOCAL_HISTORY_LIMIT = 200;

function mergeResults(existing: GeneratedResult[], incoming: GeneratedResult[] = []) {
  const seen = new Set<string>();
  return [...incoming, ...existing].filter((item) => {
    if (seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });
}

function App() {
  // 自由创作排在导航第一位，登录后也直接落在这里。
  const [view, setView] = useState<ViewKey>("free");
  const [path, setPath] = useState(() => window.location.pathname);
  const [settings, setSettings] = useStoredState<StudioSettings>("clothdesign:settings", initialSettings);
  const [references, setReferences] = useState<ReferenceImage[]>(initialReferences);
  const [prompt, setPrompt] = useState(
    generationModes.find((mode) => mode.id === settings.mode)?.promptStarter ?? generationModes[0].promptStarter,
  );
  const [modeDrafts, setModeDrafts] = useStoredState<Partial<Record<ModeKey, string>>>("clothdesign:modeDrafts", {});
  const [optimizationNotice, setOptimizationNotice] = useState("");
  const [generationSubmitting, setGenerationSubmitting] = useState(false);
  const generationLockRef = useRef(false);
  const [taskMenuOpen, setTaskMenuOpen] = useState(false);
  const [tasks, setTasks] = useCappedStoredState<GenerationTask>("clothdesign:tasks", initialTasks, LOCAL_HISTORY_LIMIT);
  const [results, setResults] = useCappedStoredState<GeneratedResult>("clothdesign:results", [], LOCAL_HISTORY_LIMIT);
  // 每次提交的现场（描述 / 参考图缩略图 / 参数）。简易模式提交完就清空输入框，靠这份存档回看。
  const [submissions, setSubmissions] = useStoredState<SubmissionRecord[]>("clothdesign:submissions", []);

  // 页面关掉/刷新时，正在跑的那次请求就跟着断了，任务却会以「运行中」留在本地列表里，
  // 看着像还在生成、其实永远不会有结果。启动时收口一次；真出了图仍会从服务端同步进成片。
  useEffect(() => {
    setTasks((items) =>
      items.some((task) => task.status === "running")
        ? items.map((task) =>
            task.status === "running"
              ? { ...task, status: "failed" as const, progress: 100, message: "页面刷新时断开了跟踪；如果这次出图成功，成片会出现在列表里。" }
              : task,
          )
        : items,
    );
    // 只在挂载时收口一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [currentUser, setCurrentUser] = useState<UserAccount | null>(null);
  const [packages, setPackages] = useState<RechargePackage[]>([]);
  const [orders, setOrders] = useState<PaymentOrder[]>([]);
  const [ledger, setLedger] = useState<CreditLedgerEntry[]>([]);
  const [activeOrder, setActiveOrder] = useState<PaymentOrder | null>(null);
  const [paymentCapabilities, setPaymentCapabilities] = useState<PaymentCapabilities>(defaultPaymentCapabilities);
  const [paymentConfig, setPaymentConfig] = useState<PaymentConfigStatus>(defaultPaymentConfig);
  const [imageProviders, setImageProviders] = useState<ImageProviderOption[]>([]);
  const [authLoading, setAuthLoading] = useState(true);
  const [authError, setAuthError] = useState("");
  const [debugUnlimited, setDebugUnlimited] = useState(false);
  const [adminOverview, setAdminOverview] = useState<AdminOverviewResponse | null>(null);
  const [routes, setRoutes] = useStoredState("clothdesign:routes", modelRoutes);
  const [creditPolicy, setCreditPolicy] = useStoredState<CreditPolicy>("clothdesign:creditPolicy", defaultCreditPolicy);
  const [systemPrompts, setSystemPrompts] = useStoredState<SystemPromptMap>("clothdesign:systemPrompts", initialSystemPrompts);
  // 文件管理：服务器那边的概况/文件列表从接口取；本地文件夹只存在这台浏览器里。
  const [storageData, setStorageData] = useState<StorageResponse | null>(null);
  const [storageLoading, setStorageLoading] = useState(false);
  // 当前停在成片列表的第几页。放 ref 里：刷新/归档要用到它，但它变了不需要重渲染。
  const storagePageRef = useRef(1);
  const [localFolderPolicy, setLocalFolderPolicy] = useStoredState<LocalFolderPolicy>("clothdesign:localFolder", { autoSave: true });
  const [localFolderHandle, setLocalFolderHandle] = useState<FileSystemDirectoryHandle | null>(null);
  const [localFolderPermission, setLocalFolderPermission] = useState<LocalFolderState["permission"]>(null);
  const [localFolderStats, setLocalFolderStats] = useState<{ savedCount: number; lastSavedPath: string | null; lastError: string | null }>({
    savedCount: 0,
    lastSavedPath: null,
    lastError: null,
  });
  const localFolderRef = useRef<FileSystemDirectoryHandle | null>(null);
  const localFolderAutoSaveRef = useRef(true);
  const [apiConfig, setApiConfig] = useState<ApiConfig | null>(null);
  const [providerTesting, setProviderTesting] = useState(false);
  const [providerTestResult, setProviderTestResult] = useState<{
    ok: boolean;
    label: string;
    message: string;
  } | null>(null);
  const [providerTestNotice, setProviderTestNotice] = useState<{
    ok: boolean;
    message: string;
  } | null>(null);
  const [railCollapsed, setRailCollapsed] = useStoredState("clothdesign:railCollapsed", false);
  // 自由创作的简易/画布切换放在顶栏，省掉工作区里那条只写着同一句话的标题栏。
  const [freeLayout, setFreeLayout] = useStoredState<FreeLayout>("clothdesign:free:layout", "simple");
  const providerHealth = apiConfig?.providerHealth;
  const providerStatusBlocked = providerTestResult ? !providerTestResult.ok : Boolean(providerHealth?.blocking);

  /**
   * 测当前账号的图像接口（只打 /models，不出图）。
   * silent = 打开页面时自动测的那一次：结果照样更新顶栏，但不弹提示条打扰人。
   */
  const handleTestImageProvider = async ({ silent = false } = {}) => {
    if (providerTesting) return;
    setProviderTesting(true);
    setProviderTestResult(null);
    if (!silent) setProviderTestNotice(null);
    try {
      const result = await testMyImageProvider();
      const next = {
        ok: result.ok,
        label: result.label || (result.ok ? "连接成功" : "连接失败"),
        message: result.message,
      };
      setProviderTestResult(next);
      // 自动测通了就安静地把顶栏点亮；测不通是要马上知道的事，照样弹。
      if (!silent || !result.ok) setProviderTestNotice({ ok: result.ok, message: result.message });
    } catch (error) {
      const message = error instanceof Error ? error.message : "测试图像接口失败。";
      setProviderTestResult({ ok: false, label: "连接失败", message });
      setProviderTestNotice({ ok: false, message });
    } finally {
      setProviderTesting(false);
    }
  };

  /**
   * 顶栏那颗状态灯原来靠「最近一次真实出图」推断，自备 Key 的账号一条都不算，
   * 于是跑了一天图还是写着「未实测」。登录后自动实测一次，让它一开始就说人话。
   */
  const autoTestedForRef = useRef("");
  useEffect(() => {
    const accountId = currentUser?.id;
    if (!accountId || !apiConfig || apiConfig.mode !== "live") return;
    // 换账号、换线路都要重新测一次；同一套配置只测一次。
    const signature = `${accountId}:${currentUser?.apiProviderId ?? "default"}:${currentUser?.hasOwnApiKey ? "own" : "shared"}`;
    if (autoTestedForRef.current === signature) return;
    autoTestedForRef.current = signature;
    void handleTestImageProvider({ silent: true });
    // handleTestImageProvider 每次渲染都是新函数，放进依赖会把自己测循环。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentUser?.id, currentUser?.apiProviderId, currentUser?.hasOwnApiKey, apiConfig?.mode]);

  // 提示条自己会退场：成功看一眼就够了，失败多留一会儿好把原因读完。
  useEffect(() => {
    if (!providerTestNotice) return;
    const timer = window.setTimeout(() => setProviderTestNotice(null), providerTestNotice.ok ? 6000 : 15000);
    return () => window.clearTimeout(timer);
  }, [providerTestNotice]);

  /** 当前账号的出图能力（走哪条线、最高几 K），比例与分辨率控件都照它渲染。 */
  const providerCapability = useMemo(() => capabilityFromAccount(currentUser), [currentUser]);

  // 左栏素材卡与描述里「参考 X」标记之间的连线，用来说明素材和文字的对应关系。
  const referenceCardEls = useRef<Record<string, HTMLElement | null>>({});
  const referenceTokenEls = useRef<Record<string, HTMLElement | null>>({});
  const [hoveredReferenceId, setHoveredReferenceId] = useState("");
  const [referenceLinkPath, setReferenceLinkPath] = useState("");

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

  useLayoutEffect(() => {
    const compute = () => {
      const card = referenceCardEls.current[hoveredReferenceId];
      const token = referenceTokenEls.current[hoveredReferenceId];
      if (!hoveredReferenceId || !card || !token) {
        setReferenceLinkPath("");
        return;
      }
      const cardBox = card.getBoundingClientRect();
      const tokenBox = token.getBoundingClientRect();
      const startX = cardBox.right;
      const startY = cardBox.top + cardBox.height / 2;
      const endX = tokenBox.left;
      const endY = tokenBox.top + tokenBox.height / 2;
      const bend = Math.max(70, (endX - startX) / 2);
      setReferenceLinkPath(
        `M ${startX.toFixed(1)} ${startY.toFixed(1)} C ${(startX + bend).toFixed(1)} ${startY.toFixed(1)} ${(endX - bend).toFixed(1)} ${endY.toFixed(1)} ${endX.toFixed(1)} ${endY.toFixed(1)}`,
      );
    };
    compute();
    window.addEventListener("resize", compute);
    window.addEventListener("scroll", compute, true);
    return () => {
      window.removeEventListener("resize", compute);
      window.removeEventListener("scroll", compute, true);
    };
  }, [hoveredReferenceId, references, view]);

  useEffect(() => {
    if (!taskMenuOpen) return;
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setTaskMenuOpen(false);
    };
    document.addEventListener("keydown", handleEscape);
    return () => document.removeEventListener("keydown", handleEscape);
  }, [taskMenuOpen]);

  useEffect(() => {
    setTasks((items) => {
      const realTasks = items.filter((task) => !legacyDemoTaskIds.has(task.id));
      return realTasks.length === items.length ? items : realTasks;
    });
  }, []);

  useEffect(() => {
    const mode = generationModes.find((item) => item.id === settings.mode);
    if (mode) {
      setPrompt((current) => modeDrafts[mode.id] ?? (current.trim().length > 0 ? current : mode.promptStarter));
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
      .catch(() =>
        setApiConfig({
          mode: "demo",
          providerReady: false,
          imageModelConfigured: false,
          authEnabled: true,
          selfSignupAllowed: true,
          debugUnlimitedAvailable: false,
          port: 8888,
        }),
      );
  }, []);

  const loadAccount = async () => {
    setAuthError("");
    try {
      const data = await fetchMe();
      setCurrentUser(data.account);
      setDebugUnlimited(Boolean(data.debugUnlimited));
      setPackages(data.packages);
      setOrders(data.orders);
      setLedger(data.ledger);
      setPaymentCapabilities(data.paymentCapabilities);
      setImageProviders(data.imageProviders || []);
      setResults((items) => mergeResults(items, data.generationResults));
      if ("paymentConfig" in data) setPaymentConfig(data.paymentConfig as PaymentConfigStatus);
      return data.account;
    } catch (error) {
      setCurrentUser(null);
      setDebugUnlimited(false);
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

  const loadAdminOverview = async () => {
    try {
      setAdminOverview(await fetchAdminOverview());
    } catch {
      setAdminOverview(null);
    }
  };

  useEffect(() => {
    if (!path.startsWith("/admin") || !currentUser || !isAdminRole(currentUser.role)) return;
    void loadAdminOverview();
  }, [path, currentUser?.id, currentUser?.role]);

  // 进文件管理页时拉一次服务器那边的文件状态（过期、已推云盘等以服务端为准）
  useEffect(() => {
    if (view !== "storage" || !currentUser) return;
    void loadStorage();
  }, [view, currentUser?.id]);

  // 普通账号直接敲 /admin：不给看后台壳子，地址栏也改回首页。
  useEffect(() => {
    if (!path.startsWith("/admin") || !currentUser || isAdminRole(currentUser.role)) return;
    window.history.replaceState({}, "", "/");
    setPath("/");
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

  /** 一键清空创作台当前状态：描述、参考图、优化提示。成片和设置不动。 */
  const handleClearStudio = () => {
    const mode = generationModes.find((item) => item.id === settings.mode) ?? generationModes[0];
    references.forEach((reference) => {
      if (reference.previewUrl?.startsWith("blob:")) URL.revokeObjectURL(reference.previewUrl);
    });
    setPrompt("");
    setModeDrafts((current) => ({ ...current, [mode.id]: "" }));
    setReferences(normalizeModeReferences([], mode.requiredRefs));
    setOptimizationNotice("");
    setHoveredReferenceId("");
  };

  const handleModePrompt = (modeId: StudioSettings["mode"]) => {
    const mode = generationModes.find((item) => item.id === modeId);
    setModeDrafts((current) => ({ ...current, [settings.mode]: prompt }));
    handleSettingsChange({ mode: modeId });
    if (mode) {
      setPrompt(modeDrafts[modeId] ?? mode.promptStarter);
      setReferences((current) => normalizeModeReferences(current, mode.requiredRefs));
    }
    setOptimizationNotice("");
  };

  const handleOptimize = () => {
    const optimizedPrompt = buildEditablePrompt(prompt, activeMode, references, settings);
    setPrompt(optimizedPrompt);
    setModeDrafts((current) => ({ ...current, [settings.mode]: optimizedPrompt }));
    setOptimizationNotice("已按当前功能、参考图关系和商业出图质量补齐提示词。");
  };

  const handleGenerate = async (mode: GenerationMode, cost: number) => {
    if (generationLockRef.current) return;
    generationLockRef.current = true;
    setGenerationSubmitting(true);
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
      startedAt: Date.now(),
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
        userPrompt: taskPrompt,
        apiSize: ratio.apiSize,
        ratioLabel: ratio.label,
      });
      // 只覆盖服务端这次回报的字段，别把 providerHealth 抹掉，否则顶栏状态会退化成猜测值。
      setApiConfig((current) => ({
        ...current,
        mode: response.mode,
        providerReady: response.providerReady,
        imageModelConfigured: response.imageModelConfigured,
        authEnabled: response.authEnabled,
        port: response.port,
        providerHealth: response.providerHealth ?? current?.providerHealth,
      }));
      if (response.account) setCurrentUser(response.account);

      const serverTaskId = response.taskId || taskId;
      const newResults = response.results.map((result, index) => ({
        id: `result-${serverTaskId}-${index}`,
        taskId: serverTaskId,
        title: `${mode.shortTitle}-${nowLabel().replace(":", "")}-${index + 1}`,
        mode: mode.id,
        prompt: taskPrompt,
        ratioLabel: ratio.label,
        storageStatus: "cloud-temp",
        expiresAt: new Date(Date.now() + (apiConfig?.storageRetentionDays ?? 3) * 24 * 60 * 60 * 1000).toISOString(),
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
                finishedAt: Date.now(),
                message:
                  response.mode === "demo"
                    ? `${response.message} 结果已进入演示存储。`
                    : `已出图，服务器保留 ${apiConfig?.storageRetentionDays ?? 3} 天`,
              }
            : task,
        ),
      );
      setResults((items) => [...newResults, ...items]);
      void autoSaveResultsLocally(newResults);
    } catch (error) {
      setTasks((items) =>
        items.map((task) =>
          task.id === taskId
            ? {
                ...task,
                status: "failed",
                progress: 100,
                credits: 0,
                finishedAt: Date.now(),
                message: error instanceof Error ? error.message : "生成失败",
              }
            : task,
        ),
      );
    } finally {
      window.clearTimeout(progressTimer);
      generationLockRef.current = false;
      setGenerationSubmitting(false);
    }
  };

  /**
   * 自由创作的生成入口。和创作台共用同一条 /api/generate 通道与任务/积分记账，
   * 区别只在提示词：这里不套服装行业约束，只声明每张附件是「参考」还是「入画」。
   */
  const handleFreeGenerate = async ({
    prompt: rawPrompt,
    attachments,
    ratioId,
    resolution,
    quantity,
    intent = "free",
  }: FreeGenerationInput) => {
    const trimmedPrompt = rawPrompt.trim();
    if (intent === "free" && !trimmedPrompt) throw new Error("请先写一句画面描述。");
    if (intent !== "free" && !attachments.length) throw new Error("没有拿到画布截图。");

    const mode = generationModes.find((item) => item.id === "free") ?? generationModes[0];
    const ratio = ratioOptions.find((item) => item.id === ratioId) ?? ratioOptions[1];
    const freeSettings: StudioSettings = {
      ...settings,
      mode: "free",
      ratioId: ratio.id,
      quantity,
      resolution,
    };
    const references = await attachmentsToReferences(attachments);
    const finalPrompt =
      intent === "annotation"
        ? buildAnnotationEditPrompt(trimmedPrompt, freeSettings)
        : intent === "sketch"
          ? buildSketchPrompt(trimmedPrompt, freeSettings)
          : buildFreePrompt(trimmedPrompt, attachments, freeSettings);
    const intentLabels = { free: "", annotation: "按标注改图", sketch: "按草图生成" } as const;
    const taskLabel = trimmedPrompt || intentLabels[intent] || "自由创作";
    const taskId = `task-${Date.now()}`;

    setTasks((items) => [
      {
        id: taskId,
        mode: mode.id,
        prompt: taskLabel,
        status: "running",
        progress: 12,
        credits: 0,
        createdAt: nowLabel(),
        startedAt: Date.now(),
        message: intent === "free" ? "自由创作生成中" : `${intentLabels[intent]}中`,
      },
      ...items,
    ]);

    // 存档要在提交那一刻就落下：输入框马上会被清空，之后只能从这里回看。
    // 缩略图是异步压的，后面换任务 id 时得接在这条链后面，否则出图太快会改到一个还没落地的记录。
    const submissionStored = buildSubmissionRecord({
      taskId,
      prompt: taskLabel,
      attachments,
      ratioLabel: ratio.label,
      sizeLabel: outputSizeForRatio(ratio, resolution, providerCapability.protocol).label,
      quantity,
      settings: freeSettings,
      createdAt: nowLabel(),
    }).then((record) => setSubmissions((items) => [record, ...items].slice(0, MAX_SUBMISSION_RECORDS)));

    try {
      const response = await requestGeneration({
        mode,
        settings: freeSettings,
        references,
        prompt: finalPrompt,
        userPrompt: taskLabel,
        apiSize: ratio.apiSize,
        ratioLabel: ratio.label,
      });
      if (response.account) setCurrentUser(response.account);
      setApiConfig((current) => ({
        ...current,
        mode: response.mode,
        providerReady: response.providerReady,
        imageModelConfigured: response.imageModelConfigured,
        authEnabled: response.authEnabled,
        port: response.port,
        providerHealth: response.providerHealth ?? current?.providerHealth,
      }));

      const serverTaskId = response.taskId || taskId;
      // 服务端会换一个任务 id，存档跟着改，成片才找得到自己的提交现场。
      if (serverTaskId !== taskId) {
        void submissionStored.then(() =>
          setSubmissions((items) =>
            items.map((item) => (item.taskId === taskId ? { ...item, taskId: serverTaskId } : item)),
          ),
        );
      }
      const newResults = response.results.map((result, index) => ({
        id: `result-${serverTaskId}-${index}`,
        taskId: serverTaskId,
        title: `${intent === "free" ? "自由" : intentLabels[intent]}-${nowLabel().replace(":", "")}-${index + 1}`,
        mode: mode.id,
        prompt: taskLabel,
        ratioLabel: ratio.label,
        storageStatus: "cloud-temp",
        expiresAt: new Date(Date.now() + (apiConfig?.storageRetentionDays ?? 3) * 24 * 60 * 60 * 1000).toISOString(),
        credits: Math.ceil((response.credits ?? 0) / Math.max(response.results.length, 1)),
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
                credits: response.credits ?? 0,
                finishedAt: Date.now(),
                message: response.message,
              }
            : task,
        ),
      );
      setResults((items) => [...newResults, ...items]);
      void autoSaveResultsLocally(newResults);
      return newResults;
    } catch (error) {
      const message = error instanceof Error ? error.message : "生成失败";
      setTasks((items) =>
        items.map((task) =>
          task.id === taskId
            ? { ...task, status: "failed", progress: 100, credits: 0, finishedAt: Date.now(), message }
            : task,
        ),
      );
      throw error;
    }
  };

  const handleRetryTask = (task: GenerationTask) => {
    const mode = generationModes.find((item) => item.id === task.mode) ?? generationModes[0];
    setPrompt(task.prompt);
    setModeDrafts((current) => ({ ...current, [mode.id]: task.prompt }));
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
    await Promise.all([signOut().catch(() => undefined), endDebugSession().catch(() => undefined)]);
    setCurrentUser(null);
    setDebugUnlimited(false);
    setAdminOverview(null);
    setActiveOrder(null);
  };

  const handleSetAdminPath = (nextPath: string) => {
    window.history.pushState({}, "", nextPath);
    setPath(nextPath);
    if (nextPath !== "/admin") setView("free");
  };

  /** 把成片同步进各处状态：创作台的 results、后台的最近生成、文件管理的列表。 */
  const applyResultPatch = (id: string, patch: Partial<GeneratedResult>) => {
    setResults((items) => items.map((item) => (item.id === id ? { ...item, ...patch } : item)));
    setStorageData((current) => (current ? { ...current, results: current.results.map((item) => (item.id === id ? { ...item, ...patch } : item)) } : current));
    setAdminOverview((current) =>
      current ? { ...current, generationResults: current.generationResults.map((item) => (item.id === id ? { ...item, ...patch } : item)) } : current,
    );
  };

  /** 推到账号自己的 WebDAV 云盘。返回错误文案（成功返回 undefined）。 */
  const handleArchiveResult = async (id: string): Promise<string | void> => {
    try {
      const { result } = await archiveGenerationResult(id);
      applyResultPatch(id, { storageStatus: result.storageStatus, archivedAt: result.archivedAt, archivePath: result.archivePath });
      setStorageData((current) => (current ? { ...current, overview: { ...current.overview, archived: current.overview.archived + 1, active: Math.max(0, current.overview.active - 1) } } : current));
    } catch (error) {
      return error instanceof Error ? error.message : "推到云盘失败";
    }
  };

  /** 创作台右栏的「推到云盘」：失败用顶部提示条说明。 */
  const handleSyncResult = async (id: string) => {
    const error = await handleArchiveResult(id);
    if (error) setAuthError(error);
  };

  /** 把成片列表所有页翻一遍。只给「全部存到本地」用，别在渲染路径上调。 */
  const fetchAllStorageResults = async () => {
    const collected: GeneratedResult[] = [];
    let page = 1;
    let pageCount = 1;
    do {
      const data = await fetchStorage({ page, pageSize: 100 });
      collected.push(...data.results);
      pageCount = data.resultsPagination?.pageCount ?? 1;
      page += 1;
    } while (page <= pageCount);
    return collected;
  };

  const loadStorage = async (page = storagePageRef.current) => {
    setStorageLoading(true);
    try {
      const data = await fetchStorage({ page });
      storagePageRef.current = data.resultsPagination?.page ?? page;
      setStorageData(data);
      // 服务端是文件状态的权威：过期 / 已推云盘要同步回创作台的列表
      const byId = new Map(data.results.map((item) => [item.id, item]));
      setResults((items) =>
        items.map((item) => {
          const remote = byId.get(item.id);
          return remote
            ? { ...item, storageStatus: remote.storageStatus, expiresAt: remote.expiresAt, expiredAt: remote.expiredAt, archivedAt: remote.archivedAt, archivePath: remote.archivePath }
            : item;
        }),
      );
    } catch (error) {
      setAuthError(error instanceof Error ? error.message : "读取文件管理失败");
    } finally {
      setStorageLoading(false);
    }
  };

  const handleSaveWebdav = async (input: WebdavSettingsInput): Promise<string | void> => {
    try {
      const { overview } = await saveWebdavSettings(input);
      setStorageData((current) => (current ? { ...current, overview } : { overview, results: [] }));
    } catch (error) {
      return error instanceof Error ? error.message : "保存 WebDAV 配置失败";
    }
  };

  const handleTestWebdav = async (input: WebdavSettingsInput) => {
    try {
      return await testWebdavSettings(input);
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : "测试失败" };
    }
  };

  const handleArchiveAll = async (): Promise<string | void> => {
    try {
      // 归档完留在当前这一页，别把人甩回第一页。
      const data = await archiveAllGenerationResults({ page: storagePageRef.current });
      setStorageData(data);
      const byId = new Map(data.results.map((item) => [item.id, item]));
      setResults((items) => items.map((item) => (byId.has(item.id) ? { ...item, ...byId.get(item.id)! } : item)));
      if (data.summary.failed > 0) return `推了 ${data.summary.archived} 张，${data.summary.failed} 张失败：${data.summary.errors[0] || "未知原因"}`;
    } catch (error) {
      return error instanceof Error ? error.message : "批量推送失败";
    }
  };

  // ---- 本地文件夹（File System Access API，只在这台浏览器上）----
  useEffect(() => {
    localFolderAutoSaveRef.current = localFolderPolicy.autoSave;
  }, [localFolderPolicy.autoSave]);

  useEffect(() => {
    let cancelled = false;
    void loadSavedFolder().then(async (handle) => {
      if (cancelled || !handle) return;
      localFolderRef.current = handle;
      setLocalFolderHandle(handle);
      setLocalFolderPermission(await folderPermission(handle, false));
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const handlePickFolder = async (): Promise<string | void> => {
    try {
      // 已经选过、只是权限退回 prompt：先试着重新授权，不用再弹选择框
      if (localFolderRef.current && localFolderPermission !== "granted") {
        const permission = await folderPermission(localFolderRef.current, true);
        setLocalFolderPermission(permission);
        if (permission === "granted") return;
      }
      const handle = await pickLocalFolder();
      if (!handle) return;
      localFolderRef.current = handle;
      setLocalFolderHandle(handle);
      setLocalFolderPermission(await folderPermission(handle, true));
      setLocalFolderStats({ savedCount: 0, lastSavedPath: null, lastError: null });
    } catch (error) {
      return error instanceof Error ? error.message : "选择文件夹失败";
    }
  };

  const handleForgetFolder = async () => {
    await forgetLocalFolder();
    localFolderRef.current = null;
    setLocalFolderHandle(null);
    setLocalFolderPermission(null);
  };

  const saveResultLocally = async (result: GeneratedResult): Promise<string | void> => {
    const handle = localFolderRef.current;
    if (!handle) return "还没有选择本地文件夹。";
    if (result.storageStatus === "expired") return "这张成片的服务器副本已经清理，存不了。";
    try {
      const savedPath = await saveImageToFolder(handle, {
        url: result.imageUrl,
        fileName: resultFileName({ title: `${result.title}-${result.id.slice(-6)}`, imageUrl: result.imageUrl }),
        createdAt: result.createdAt,
      });
      setLocalFolderPermission("granted");
      setLocalFolderStats((current) => ({ savedCount: current.savedCount + 1, lastSavedPath: savedPath, lastError: null }));
    } catch (error) {
      const message = error instanceof Error ? error.message : "写入本地文件夹失败";
      if (/权限/.test(message)) setLocalFolderPermission("prompt");
      setLocalFolderStats((current) => ({ ...current, lastError: message }));
      return message;
    }
  };

  /** 出图后自动存本地：没选文件夹或没开自动就什么也不做；失败不打断流程，只在文件管理里显示。 */
  const autoSaveResultsLocally = async (items: GeneratedResult[]) => {
    if (!localFolderRef.current || !localFolderAutoSaveRef.current) return;
    for (const item of items) await saveResultLocally(item);
  };

  const handleSaveAllLocally = async (): Promise<string | void> => {
    // 「全部存到本地」是整个账号的口径，不是当前这一页——先把所有页翻一遍。
    const source = storageData ? await fetchAllStorageResults() : results;
    const targets = source.filter((item) => item.storageStatus !== "expired");
    let failed = 0;
    let firstError = "";
    for (const item of targets) {
      const error = await saveResultLocally(item);
      if (error) {
        failed += 1;
        firstError = firstError || error;
        if (/权限/.test(error)) break;
      }
    }
    if (failed) return `${targets.length - failed} 张已存，${failed} 张失败：${firstError}`;
  };

  const localFolderState: LocalFolderState = {
    supported: localFolderSupported(),
    name: localFolderHandle?.name ?? null,
    permission: localFolderPermission,
    autoSave: localFolderPolicy.autoSave,
    savedCount: localFolderStats.savedCount,
    lastSavedPath: localFolderStats.lastSavedPath,
    lastError: localFolderStats.lastError,
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
      setStorageData((current) => (current ? { ...current, results: current.results.filter((item) => item.id !== id) } : current));
    } catch (error) {
      setAuthError(error instanceof Error ? error.message : "删除生成结果失败");
    }
  };

  // 调试座位和管理员开过「无限额度」的账号，在界面上是同一种状态：显示 ∞、不校验余额。
  const unlimitedCredits = debugUnlimited || currentUser?.unlimited === true;

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
          isGenerating={generationSubmitting}
          apiConfig={apiConfig}
          hoveredReferenceId={hoveredReferenceId}
          onHoverReference={setHoveredReferenceId}
          registerTokenEl={(id, element) => {
            referenceTokenEls.current[id] = element;
          }}
          onSettingsChange={(patch) => (patch.mode ? handleModePrompt(patch.mode) : handleSettingsChange(patch))}
          onPromptChange={(value) => {
            setPrompt(value);
            setModeDrafts((current) => ({ ...current, [settings.mode]: value }));
            setOptimizationNotice("");
          }}
          onReferencesChange={setReferences}
          onClear={handleClearStudio}
          onOptimize={handleOptimize}
          onGenerate={handleGenerate}
          onUseAsReference={setReferences}
          onSyncResult={handleSyncResult}
          onDeleteResult={handleDeleteResult}
          onOpenAccount={() => setView("account")}
        />
      );
    }

    if (view === "free") {
      return (
        <FreeStudio
          results={results.filter((result) => result.mode === "free")}
          submissions={submissions}
          credits={unlimitedCredits ? Number.MAX_SAFE_INTEGER : currentUser.credits}
          creditPolicy={creditPolicy}
          settings={settings}
          apiConfig={apiConfig}
          capability={providerCapability}
          layout={freeLayout}
          onLayoutChange={setFreeLayout}
          onGenerate={handleFreeGenerate}
          onDeleteResult={handleDeleteResult}
          onOpenAccount={() => setView("account")}
        />
      );
    }

    if (view === "account") {
      return (
        <main className="single-view panel-scroll">
          <AccountPanel
            currentUser={currentUser}
            imageProviders={imageProviders}
            packages={packages}
            orders={orders}
            ledger={ledger}
            paymentCapabilities={paymentCapabilities}
            debugUnlimited={unlimitedCredits}
            generationResults={results}
            activeOrder={activeOrder}
            onRecharge={handleRecharge}
            onDemoComplete={handleDemoComplete}
            onSaveApiKey={async (apiKey, providerId) => {
              try {
                const { account } = await saveMyApiKey(apiKey, providerId);
                setCurrentUser(account);
              } catch (error) {
                return error instanceof Error ? error.message : "保存失败";
              }
            }}
            onSelectImageProvider={async (providerId) => {
              try {
                const { account } = await selectMyImageProvider(providerId);
                setCurrentUser(account);
              } catch (error) {
                return error instanceof Error ? error.message : "切换图像接口失败";
              }
            }}
            onClearApiKey={async () => {
              try {
                const { account } = await clearMyApiKey();
                setCurrentUser(account);
              } catch (error) {
                return error instanceof Error ? error.message : "清除失败";
              }
            }}
          />
        </main>
      );
    }

    if (view === "workflows") {
      return <WorkflowCenter generatedResults={results} apiConfig={apiConfig} />;
    }

    // 短视频只对开了权限的账号（默认 admin）渲染；权限被收回时视图跟着消失，服务端每个接口也各自把关。
    if (view === "shortvideo") {
      if (!currentUser.features?.shortVideo) return null;
      return <ShortVideoHub />;
    }

    return (
      <main className="single-view panel-scroll">
        <StoragePanel
          overview={storageData?.overview ?? null}
          results={storageData?.results ?? results}
          pagination={storageData?.resultsPagination}
          onPageChange={(page) => void loadStorage(page)}
          loading={storageLoading}
          onRefresh={() => void loadStorage()}
          onSaveWebdav={handleSaveWebdav}
          onTestWebdav={handleTestWebdav}
          onArchive={handleArchiveResult}
          onArchiveAll={handleArchiveAll}
          onDelete={handleDeleteResult}
          localFolder={localFolderState}
          onPickFolder={handlePickFolder}
          onForgetFolder={handleForgetFolder}
          onToggleAutoSave={(value) => setLocalFolderPolicy({ autoSave: value })}
          onSaveToFolder={saveResultLocally}
          onSaveAllToFolder={handleSaveAllLocally}
        />
      </main>
    );
  };

  // 短视频不在公共导航表里（按账号开关渲染），顶栏的当前位置单独给它一份文案。
  const activeNavigationItem =
    view === "shortvideo"
      ? { id: "shortvideo" as const, label: "视频", displayLabel: "短视频", description: "文案 · 配音 · 成片" }
      : (navigation.find((item) => item.id === view) ?? navigation[0]);

  if (authLoading) {
    return (
      <main className="auth-shell app-loading" aria-live="polite">
        <span className="app-loading-icon" aria-hidden="true">◇</span>
        <strong>正在打开创作台</strong>
        <span>马上就好…</span>
      </main>
    );
  }

  if (!currentUser) {
    return (
      <>
        <AuthPanel
          onAuthenticated={async () => {
            await loadAccount();
          }}
          selfSignupAllowed={apiConfig?.selfSignupAllowed !== false}
        />
        {authError && !authError.includes("请先登录") ? <div className="auth-error">{authError}</div> : null}
      </>
    );
  }

  // 只有 admin 账号能看到后台；别人直接敲 /admin 也会被送回客户页（下面的 effect 负责改地址栏）。
  if (path.startsWith("/admin") && isAdminRole(currentUser.role)) {
    return (
      <div className="admin-shell">
        <header className="admin-topbar">
          <div className="brand">
            <img className="brand-mark" src="/favicon.svg" alt="" aria-hidden="true" />
            <strong>ImageDesign Admin</strong>
          </div>
          <button className="btn btn-secondary" onClick={() => handleSetAdminPath("/")}>
            返回客户页
          </button>
        </header>
        <main className="admin-page panel-scroll">
          <header className="admin-page-head">
            <div>
              <span>ImageDesign Admin</span>
              <h1>后台控制台</h1>
            </div>
          </header>
          <AdminPanel
            routes={routes}
            onRoutesChange={setRoutes}
            summary={adminOverview?.summary}
            currentUserId={currentUser.id}
            imageProviders={adminOverview?.imageProviders ?? (adminOverview?.imageProvider ? [adminOverview.imageProvider] : [])}
            onSaveImageProvider={async (input) => {
              try {
                await saveImageProvider(input);
                await loadAdminOverview();
              } catch (error) {
                return error instanceof Error ? error.message : "保存接口配置失败";
              }
            }}
            onResetImageProvider={async (providerId) => {
              try {
                await resetImageProvider(providerId);
                await loadAdminOverview();
              } catch (error) {
                return error instanceof Error ? error.message : "恢复默认失败";
              }
            }}
            onTestImageProvider={async (providerId) => {
              try {
                return await testImageProvider(providerId);
              } catch (error) {
                return { ok: false, message: error instanceof Error ? error.message : "测试失败" };
              }
            }}
            onCreateUser={async (input) => {
              try {
                await createAdminUser(input);
                await loadAdminOverview();
              } catch (error) {
                return error instanceof Error ? error.message : "创建账号失败";
              }
            }}
            onResetPassword={async (id, password) => {
              try {
                await resetAdminUserPassword(id, password);
              } catch (error) {
                return error instanceof Error ? error.message : "重置密码失败";
              }
            }}
            onSetApiKey={async (id, apiKey, providerId) => {
              try {
                await setAdminUserApiKey(id, apiKey, providerId);
                await loadAdminOverview();
              } catch (error) {
                return error instanceof Error ? error.message : "配置 Key 失败";
              }
            }}
            users={adminOverview?.users ?? [currentUser]}
            onUsersChange={(items) => setAdminOverview((current) => (current ? { ...current, users: items } : current))}
            onUserPatch={async (id, patch) => {
              try {
                // 短视频开关走单独的端点，不混进 PATCH /api/admin/users/:id。
                if (typeof patch.shortVideoEnabled === "boolean") {
                  const result = await setUserShortVideoAccess(id, patch.shortVideoEnabled);
                  setAdminOverview((current) =>
                    current
                      ? {
                          ...current,
                          users: current.users.map((item) =>
                            item.id === id ? { ...item, shortVideoEnabled: result.shortVideoEnabled, canUseShortVideo: result.canUseShortVideo } : item,
                          ),
                        }
                      : current,
                  );
                  return;
                }
                const { user } = await updateAdminUser(id, patch);
                setAdminOverview((current) =>
                  current ? { ...current, users: current.users.map((item) => (item.id === id ? user : item)) } : current,
                );
              } catch (error) {
                // 失败时把服务端的真实状态拉回来，不要让界面停在没生效的改动上
                await loadAdminOverview();
                return error instanceof Error ? error.message : "用户更新失败";
              }
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
            pagination={adminOverview?.pagination}
            paymentConfig={adminOverview?.paymentConfig ?? paymentConfig}
            creditPolicy={creditPolicy}
            onCreditPolicyChange={setCreditPolicy}
            storage={adminOverview?.storage}
            onRunStorageMaintenance={async () => {
              try {
                const { storage } = await runAdminStorageMaintenance();
                setAdminOverview((current) => (current ? { ...current, storage } : current));
              } catch (error) {
                return error instanceof Error ? error.message : "清理失败";
              }
            }}
            systemPrompts={systemPrompts}
            onSystemPromptsChange={(modeId: ModeKey, value: string) =>
              setSystemPrompts((items) => ({ ...items, [modeId]: value }))
            }
          />
        </main>
      </div>
    );
  }

  const isAdminUser = isAdminRole(currentUser.role);
  // 短视频入口：服务端按账号下发开关（默认只有 admin 为 true），别的账号连入口都不渲染。
  const canUseShortVideo = currentUser.features?.shortVideo === true;

  return (
    <>
      <div className="app-shell">
        <header className="topbar">
          <div className="topbar-brand-group">
            <div className="brand">
              <img className="brand-mark" src="/favicon.svg" alt="" aria-hidden="true" />
              <span className="brand-copy">
                <strong>ImageDesign AI</strong>
                <small>图片视觉工作台</small>
              </span>
            </div>
            <span className="topbar-divider" aria-hidden="true" />
            <div className="topbar-context">
              <span>{activeNavigationItem.description}</span>
              <strong>{activeNavigationItem.displayLabel}</strong>
            </div>
            {view === "free" ? (
              <div className="level-switch" role="group" aria-label="创作方式">
                <button type="button" className={freeLayout === "simple" ? "active" : ""} onClick={() => setFreeLayout("simple")}>
                  简易
                </button>
                <button type="button" className={freeLayout === "canvas" ? "active" : ""} onClick={() => setFreeLayout("canvas")}>
                  画布
                </button>
              </div>
            ) : null}
          </div>

          <div className="top-status">
            <button
              type="button"
              className={`engine-status ${providerStatusBlocked ? "blocked" : "ready"} ${providerTesting ? "testing" : ""}`}
              onClick={() => void handleTestImageProvider()}
              disabled={providerTesting}
              title={providerTesting ? "正在测试当前账号的图像接口（不会生成图片）" : providerTestResult?.message || "点击测试当前账号的图像接口连通性（不会生成图片）"}
              aria-label="测试当前账号的图像接口连通性"
            >
              <i aria-hidden="true" />
              {providerTesting
                ? "测试中…"
                : providerTestResult?.label ?? providerHealth?.label ?? (apiConfig?.mode === "live" ? "图像服务已就绪" : "演示模式")}
            </button>
            <button
              className="credit-button"
              onClick={() => setView("account")}
              aria-label={unlimitedCredits ? "无限额度" : `账户余额 ${currentUser.credits} 积分`}
            >
              <strong>{unlimitedCredits ? "∞" : currentUser.credits}</strong> {unlimitedCredits ? "无限额度" : "积分"}
            </button>
            <button
              className={`task-menu-button ${runningTasks > 0 ? "running" : ""}`}
              onClick={() => setTaskMenuOpen((open) => !open)}
              aria-expanded={taskMenuOpen}
              aria-label={runningTasks > 0 ? `${runningTasks} 个任务生成中` : "任务"}
            >
              {runningTasks > 0 ? <i className="task-running-dot" aria-hidden="true" /> : null}
              {runningTasks > 0 ? "生成中" : "任务"} <em>{runningTasks > 0 ? runningTasks : tasks.length}</em>
            </button>
            <span className="user-summary" title={currentUser.name}>
              <i aria-hidden="true">{currentUser.name.trim().charAt(0) || "我"}</i>
              <span>{currentUser.name}</span>
            </span>
            <button className="signout-button" onClick={handleSignOut} aria-label="退出">
              退出
            </button>
          </div>
        </header>

        <div className="app-body">
          <aside className={`rail ${railCollapsed ? "collapsed" : ""}`} aria-label="主导航">
            <div className="rail-head">
              {railCollapsed ? null : <span className="rail-kicker">导航</span>}
              <button
                type="button"
                className="rail-toggle"
                onClick={() => {
                  setRailCollapsed((collapsed) => !collapsed);
                  // 收起时左栏的素材卡会卸载，连线的起点没了，先把悬停态清掉免得留下一条断线。
                  setHoveredReferenceId("");
                }}
                aria-expanded={!railCollapsed}
                aria-label={railCollapsed ? "展开侧边栏" : "收起侧边栏"}
                title={railCollapsed ? "展开侧边栏" : "收起侧边栏"}
              >
                <span aria-hidden="true">{railCollapsed ? "»" : "«"}</span>
              </button>
            </div>

            <nav className="rail-nav">
              {navigation.map((item) => (
                <button
                  key={item.id}
                  className={view === item.id ? "active" : ""}
                  onClick={() => {
                    setView(item.id);
                    setTaskMenuOpen(false);
                  }}
                  aria-label={item.displayLabel}
                  aria-current={view === item.id ? "page" : undefined}
                  title={railCollapsed ? item.displayLabel : item.label}
                >
                  <span className="rail-icon" aria-hidden="true" />
                  <span className="rail-short" aria-hidden="true">{item.label}</span>
                  <span className="rail-copy">
                    <strong>{item.displayLabel}</strong>
                    <small>{item.description}</small>
                  </span>
                </button>
              ))}
              {canUseShortVideo ? (
                <button
                  className={view === "shortvideo" ? "active" : ""}
                  onClick={() => {
                    setView("shortvideo");
                    setTaskMenuOpen(false);
                  }}
                  aria-label="短视频"
                  aria-current={view === "shortvideo" ? "page" : undefined}
                  title={railCollapsed ? "短视频" : "视频"}
                >
                  <span className="rail-icon" aria-hidden="true" />
                  <span className="rail-short" aria-hidden="true">视频</span>
                  <span className="rail-copy">
                    <strong>短视频</strong>
                    <small>文案 · 配音 · 成片</small>
                  </span>
                </button>
              ) : null}
              {isAdminUser ? (
                <button
                  className={path.startsWith("/admin") ? "active" : ""}
                  onClick={() => handleSetAdminPath("/admin")}
                  aria-label="管理后台"
                  title={railCollapsed ? "管理后台" : "后台"}
                >
                  <span className="rail-icon" aria-hidden="true" />
                  <span className="rail-short" aria-hidden="true">后台</span>
                  <span className="rail-copy">
                    <strong>管理后台</strong>
                    <small>仅 admin 账号</small>
                  </span>
                </button>
              ) : null}
            </nav>

            <div className="rail-divider" aria-hidden="true" />

            {railCollapsed ? null : view === "studio" ? (
              <ReferencePanel
                references={references}
                requiredRefs={activeMode.requiredRefs}
                recommendedRefs={activeMode.recommendedRefs}
                onChange={setReferences}
                hoveredId={hoveredReferenceId}
                onHover={setHoveredReferenceId}
                registerCardEl={(id, element) => {
                  referenceCardEls.current[id] = element;
                }}
              />
            ) : (
              <section className="rail-section session-summary">
                <header className="rail-section-head">
                  <span className="rail-kicker">本次会话</span>
                </header>
                <div className="session-rows">
                  <div><span>参考素材</span><strong>{references.filter((item) => item.previewUrl).length} / {references.length}</strong></div>
                  <div><span>成片</span><strong>{results.length}</strong></div>
                  <div><span>任务</span><strong>{tasks.length}</strong></div>
                </div>
                <button type="button" className="btn btn-secondary" onClick={() => setView("studio")}>
                  回到创作台
                </button>
                <small className="muted-text">素材、成片与设置在切换界面时保留，不会刷新。</small>
              </section>
            )}
          </aside>
          {renderView()}
        </div>
      </div>

      <svg className="reference-link-layer" aria-hidden="true">
        {referenceLinkPath ? <path d={referenceLinkPath} /> : null}
      </svg>

      {taskMenuOpen ? (
        <>
          <div className="task-scrim" onClick={() => setTaskMenuOpen(false)} />
          <div className="task-popover" role="dialog" aria-label="生成任务">
            <TaskRail
              tasks={tasks}
              results={results}
              submissions={submissions}
              onRetry={handleRetryTask}
              onClose={() => setTaskMenuOpen(false)}
            />
          </div>
        </>
      ) : null}

      {authError && !authError.includes("请先登录") ? (
        <div className="global-notice" role="alert">
          <span>{authError}</span>
          <button type="button" onClick={() => setAuthError("")} aria-label="关闭提示">×</button>
        </div>
      ) : null}
      {providerTestNotice ? (
        <div className={`global-notice provider-test-notice ${providerTestNotice.ok ? "" : "failed"}`} role={providerTestNotice.ok ? "status" : "alert"}>
          <span>{providerTestNotice.message}</span>
          <button type="button" onClick={() => setProviderTestNotice(null)} aria-label="关闭接口测试提示">×</button>
        </div>
      ) : null}
    </>
  );
}

export default App;
