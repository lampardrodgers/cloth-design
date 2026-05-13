import { useEffect, useMemo, useState } from "react";
import {
  Archive,
  Images,
  LayoutDashboard,
  ListChecks,
  Settings,
  UserCog,
} from "lucide-react";
import {
  generationModes,
  initialReferences,
  initialStoragePolicy,
  initialTasks,
  initialUsers,
  modelRoutes,
  ratioOptions,
  rechargePackages,
} from "./data/catalog";
import { fetchApiConfig, requestGeneration, type ApiConfig } from "./lib/api";
import { buildOptimizedPrompt } from "./lib/prompt";
import type {
  GeneratedResult,
  GenerationMode,
  GenerationTask,
  RechargePackage,
  ReferenceImage,
  StoragePolicy,
  StudioSettings,
  UserAccount,
  ViewKey,
} from "./types";
import { AccountPanel } from "./components/AccountPanel";
import { AdminPanel } from "./components/AdminPanel";
import { StoragePanel } from "./components/StoragePanel";
import { StudioWorkspace } from "./components/StudioWorkspace";
import { TaskRail } from "./components/TaskRail";

const navigation: Array<{ id: ViewKey; label: string; icon: typeof Images }> = [
  { id: "studio", label: "生成", icon: Images },
  { id: "tasks", label: "任务", icon: ListChecks },
  { id: "account", label: "账户", icon: UserCog },
  { id: "admin", label: "后台", icon: Settings },
  { id: "storage", label: "存储", icon: Archive },
];

const initialSettings: StudioSettings = {
  mode: "text",
  ratioId: "1-1",
  resolution: "native",
  quality: "high",
  outputFormat: "png",
  background: "auto",
  moderation: "auto",
  quantity: 2,
  compression: 90,
  inputFidelity: "standard",
  streamPreview: true,
  preserveIdentity: true,
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

function App() {
  const [view, setView] = useState<ViewKey>("studio");
  const [settings, setSettings] = useStoredState<StudioSettings>("clothdesign:settings", initialSettings);
  const [references, setReferences] = useState<ReferenceImage[]>(initialReferences);
  const [prompt, setPrompt] = useState(generationModes.find((mode) => mode.id === initialSettings.mode)?.promptStarter ?? "");
  const [optimizedPrompt, setOptimizedPrompt] = useState("");
  const [tasks, setTasks] = useStoredState<GenerationTask[]>("clothdesign:tasks", initialTasks);
  const [results, setResults] = useStoredState<GeneratedResult[]>("clothdesign:results", []);
  const [users, setUsers] = useStoredState<UserAccount[]>("clothdesign:users", initialUsers);
  const [routes, setRoutes] = useStoredState("clothdesign:routes", modelRoutes);
  const [storagePolicy, setStoragePolicy] = useStoredState<StoragePolicy>("clothdesign:storage", initialStoragePolicy);
  const [apiConfig, setApiConfig] = useState<ApiConfig | null>(null);

  const currentUser = users[0];
  const activeMode = useMemo(() => generationModes.find((mode) => mode.id === settings.mode) ?? generationModes[0], [settings.mode]);

  useEffect(() => {
    const mode = generationModes.find((item) => item.id === settings.mode);
    if (mode) {
      setPrompt((current) => (current.trim().length > 0 ? current : mode.promptStarter));
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
    setOptimizedPrompt(buildOptimizedPrompt(prompt, activeMode, references, settings));
  }, [activeMode, prompt, references, settings]);

  useEffect(() => {
    fetchApiConfig()
      .then(setApiConfig)
      .catch(() => setApiConfig({ mode: "demo", providerReady: false, imageModelConfigured: false, port: 8888 }));
  }, []);

  const updateUserCredits = (delta: number) => {
    setUsers((items) =>
      items.map((user, index) =>
        index === 0
          ? {
              ...user,
              credits: Math.max(0, user.credits + delta),
              monthlyUsed: delta < 0 ? user.monthlyUsed + Math.abs(delta) : user.monthlyUsed,
            }
          : user,
      ),
    );
  };

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
    if (mode) setPrompt(mode.promptStarter);
  };

  const handleOptimize = () => {
    setOptimizedPrompt(buildOptimizedPrompt(prompt, activeMode, references, settings));
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

    updateUserCredits(-cost);
    setTasks((items) => [nextTask, ...items]);

    const progressTimer = window.setTimeout(() => {
      setTasks((items) => items.map((task) => (task.id === taskId ? { ...task, progress: 58, message: "正在合成服装细节" } : task)));
    }, 650);

    try {
      const response = await requestGeneration({
        mode,
        settings,
        references,
        prompt: optimizedPrompt,
        apiSize: ratio.apiSize,
        ratioLabel: ratio.label,
      });
      setApiConfig({
        mode: response.mode,
        providerReady: response.providerReady,
        imageModelConfigured: response.imageModelConfigured,
        port: response.port,
      });

      const newResults = response.results.map((result, index) => ({
        id: `result-${taskId}-${index}`,
        taskId,
        title: `${mode.shortTitle}-${nowLabel().replace(":", "")}-${index + 1}`,
        mode: mode.id,
        ratioLabel: ratio.label,
        storageStatus: storagePolicy.autoSyncOriginals ? "cloud-temp" : "local-cache",
        credits: Math.ceil(cost / Math.max(response.results.length, 1)),
        imageUrl: result.imageUrl,
        createdAt: nowLabel(),
      })) satisfies GeneratedResult[];

      setTasks((items) =>
        items.map((task) =>
          task.id === taskId
            ? {
                ...task,
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
      updateUserCredits(cost);
      setTasks((items) =>
        items.map((task) =>
          task.id === taskId
            ? {
                ...task,
                status: "failed",
                progress: 100,
                credits: 0,
                message: error instanceof Error ? `${error.message}，积分已退回` : "生成失败，积分已退回",
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
  };

  const handleRecharge = (pkg: RechargePackage) => {
    updateUserCredits(pkg.credits);
    const rechargeTask: GenerationTask = {
      id: `order-${Date.now()}`,
      mode: "text",
      prompt: `${pkg.title} 充值订单`,
      status: "success",
      progress: 100,
      credits: -pkg.credits,
      createdAt: nowLabel(),
      message: `支付成功，增加 ${pkg.credits} 积分`,
    };
    setTasks((items) => [rechargeTask, ...items]);
  };

  const handleAdjustUser = (userId: string, credits: number) => {
    setUsers((items) => items.map((user) => (user.id === userId ? { ...user, credits: user.credits + credits } : user)));
  };

  const handleSyncResult = (id: string) => {
    setResults((items) => items.map((item) => (item.id === id ? { ...item, storageStatus: "webdav" } : item)));
  };

  const handleDeleteResult = (id: string) => {
    setResults((items) => items.filter((item) => item.id !== id));
  };

  const renderView = () => {
    if (view === "studio") {
      return (
        <StudioWorkspace
          settings={settings}
          prompt={prompt}
          optimizedPrompt={optimizedPrompt}
          references={references}
          results={results}
          user={currentUser}
          tasks={tasks}
          onSettingsChange={(patch) => (patch.mode ? handleModePrompt(patch.mode) : handleSettingsChange(patch))}
          onPromptChange={setPrompt}
          onReferencesChange={setReferences}
          onOptimize={handleOptimize}
          onGenerate={handleGenerate}
          onUseAsReference={setReferences}
          onSyncResult={handleSyncResult}
          onDeleteResult={handleDeleteResult}
          onRetryTask={handleRetryTask}
        />
      );
    }

    if (view === "tasks") {
      return (
        <main className="single-view panel-scroll">
          <TaskRail tasks={tasks} onRetry={handleRetryTask} />
        </main>
      );
    }

    if (view === "account") {
      return (
        <main className="single-view panel-scroll">
          <AccountPanel currentUser={currentUser} users={users} packages={rechargePackages} onRecharge={handleRecharge} onAdjustUser={handleAdjustUser} />
        </main>
      );
    }

    if (view === "admin") {
      return (
        <main className="single-view panel-scroll">
          <AdminPanel routes={routes} onRoutesChange={setRoutes} />
        </main>
      );
    }

    return (
      <main className="single-view panel-scroll">
        <StoragePanel policy={storagePolicy} onChange={setStoragePolicy} results={results} />
      </main>
    );
  };

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand">
          <LayoutDashboard size={18} />
          <strong>ClothDesign AI</strong>
        </div>
        <div className="top-status">
          <span>{activeMode.title}</span>
          <span>{apiConfig?.mode === "live" ? "OpenAI 就绪" : "演示模式"}</span>
          <span>{currentUser.credits} 积分</span>
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
