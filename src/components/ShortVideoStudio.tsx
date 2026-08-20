import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import { Clapperboard, CloudUpload, Download, Megaphone, RefreshCw, Sparkles, Trash2, Upload, WandSparkles } from "lucide-react";
import {
  archiveShortVideoTask,
  createShortVideoTask,
  cancelShortVideoTask,
  deleteShortVideoTask,
  fetchShortVideoMaterials,
  fetchShortVideoOverview,
  fetchShortVideoTasks,
  generateShortVideoMetadata,
  generateShortVideoScript,
  generateShortVideoTerms,
  testShortVideoEngine,
  uploadShortVideoMaterial,
  uploadShortVideoMusic,
  type ShortVideoOverview,
} from "../lib/api";
import type { PageInfo } from "../lib/api";
import { taskDurationLabel } from "../lib/duration";
import { useStoredState } from "../lib/storedState";
import { useNow } from "../lib/useNow";
import type { ShortVideoAspectOption, ShortVideoFile, ShortVideoMetadata, ShortVideoRequest, ShortVideoTask } from "../types";
import { Button, ChipGroup, NumberStepper, Pager } from "./ui";

/**
 * 短视频工坊：一句主题 → 文案 → 关键词 → 配音 / 字幕 / 素材 → 成片。
 *
 * 渲染在 MoneyPrinterTurbo 引擎里跑，这个页面只负责收参数、看进度、放成片；
 * 参数校验和权限都在服务端（/api/shortvideo/*）。默认只有 admin 能看到这个视图。
 */

const TASK_POLL_MS = 3000;
const ENGINE_POLL_MS = 30000;
const FORM_STORAGE_KEY = "clothdesign:shortvideo:form";

const defaultForm: ShortVideoRequest = {
  subject: "",
  script: "",
  terms: [],
  language: "zh-CN",
  aspect: "9:16",
  clipDuration: 5,
  clipSpeed: 1,
  matchScript: false,
  paragraphs: 1,
  scriptPrompt: "",
  concatMode: "random",
  transition: "",
  count: 1,
  source: "pexels",
  materials: [],
  voice: "zh-CN-XiaoxiaoNeural-Female",
  voiceRate: 1,
  voiceVolume: 1,
  bgm: { type: "random", file: "", volume: 0.2 },
  subtitle: {
    enabled: true,
    position: "bottom",
    customPosition: 70,
    font: "STHeitiMedium.ttc",
    size: 60,
    color: "#FFFFFF",
    strokeColor: "#000000",
    strokeWidth: 1.5,
    background: { enabled: false, color: "#000000", rounded: true },
  },
};

const rateOptions = [
  { id: "0.8", label: "慢 0.8×" },
  { id: "1", label: "正常 1×" },
  { id: "1.2", label: "快 1.2×" },
  { id: "1.5", label: "很快 1.5×" },
];

function AspectGlyph({ option, size = 20 }: { option: ShortVideoAspectOption; size?: number }) {
  const longest = Math.max(option.width, option.height) || 1;
  const width = Math.max(4, (option.width / longest) * size);
  const height = Math.max(4, (option.height / longest) * size);
  return (
    <span className="ratio-glyph" style={{ width: size, height: size }} aria-hidden="true">
      <i className="ratio-glyph-box" style={{ width, height }} />
    </span>
  );
}

function formatBytes(bytes: number) {
  if (!bytes) return "";
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function remainingLabel(iso: string, now: number) {
  const diff = Date.parse(iso) - now;
  if (!Number.isFinite(diff)) return "";
  if (diff <= 0) return "即将清理";
  const hours = Math.floor(diff / 3600000);
  if (hours >= 48) return `${Math.floor(hours / 24)} 天后清理`;
  if (hours >= 1) return `${hours} 小时后清理`;
  return `${Math.max(1, Math.floor(diff / 60000))} 分钟后清理`;
}

function formatTime(iso: string) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function isActive(task: ShortVideoTask) {
  return task.status === "queued" || task.status === "running";
}

function statusLabel(task: ShortVideoTask) {
  if (task.status === "completed") return "已完成";
  if (task.status === "failed") return "失败";
  if (task.status === "cancelled") return "已取消";
  if (task.status === "queued") return "排队中";
  return `${task.stageLabel} ${task.progress}%`;
}

export function ShortVideoStudio() {
  const [overview, setOverview] = useState<ShortVideoOverview | null>(null);
  const [loadError, setLoadError] = useState("");
  const [tasks, setTasks] = useState<ShortVideoTask[]>([]);
  const [taskPage, setTaskPage] = useState<PageInfo | undefined>(undefined);
  // 当前停在第几页。放 ref 里让 3 秒一次的轮询能读到最新值，又不会把定时器重建一遍。
  const taskPageRef = useRef(1);
  // 在跑的任务数按整个账号算，服务端给——翻到第二页时不能只数这一页。
  const [activeCount, setActiveCount] = useState(0);
  const [materials, setMaterials] = useState<ShortVideoFile[]>([]);
  const [form, setForm] = useStoredState<ShortVideoRequest>(FORM_STORAGE_KEY, defaultForm);
  const [termDraft, setTermDraft] = useState("");
  // "" = 空闲；发布文案是按任务算的，所以用 `metadata:<taskId>` 这种带后缀的写法。
  const [busy, setBusy] = useState<string>("");
  const [notice, setNotice] = useState<{ tone: "info" | "bad" | "good"; text: string } | null>(null);
  const [expandedTaskId, setExpandedTaskId] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const musicInputRef = useRef<HTMLInputElement | null>(null);
  const [metadataPlatform, setMetadataPlatform] = useStoredState("clothdesign:shortvideo:platform", "douyin");
  const [metadataByTask, setMetadataByTask] = useState<Record<string, ShortVideoMetadata>>({});

  // 老版本存的表单可能缺字段：和默认值合一下，别让页面因为 undefined 炸掉。
  const safeForm = useMemo<ShortVideoRequest>(
    () => ({
      ...defaultForm,
      ...form,
      terms: Array.isArray(form.terms) ? form.terms : [],
      materials: Array.isArray(form.materials) ? form.materials : [],
      bgm: { ...defaultForm.bgm, ...(form.bgm || {}) },
      subtitle: {
        ...defaultForm.subtitle,
        ...(form.subtitle || {}),
        background: { ...defaultForm.subtitle.background, ...(form.subtitle?.background || {}) },
      },
    }),
    [form],
  );

  const patch = useCallback(
    (changes: Partial<ShortVideoRequest>) => setForm((current) => ({ ...defaultForm, ...current, ...changes })),
    [setForm],
  );

  const load = useCallback(async () => {
    try {
      const data = await fetchShortVideoOverview();
      setOverview(data);
      setTasks(data.tasks);
      setTaskPage(data.tasksPagination);
      taskPageRef.current = data.tasksPagination?.page ?? 1;
      setActiveCount(data.activeCount ?? data.tasks.filter(isActive).length);
      setMaterials(data.materials);
      setLoadError("");
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "短视频模块加载失败。");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  /** 拉某一页任务。不传页码就刷新当前这一页。 */
  const loadTasks = useCallback(async (page = taskPageRef.current) => {
    const data = await fetchShortVideoTasks({ page });
    taskPageRef.current = data.pagination?.page ?? page;
    setTasks(data.tasks);
    setTaskPage(data.pagination);
    setActiveCount(data.activeCount ?? data.tasks.filter(isActive).length);
  }, []);

  // 有任务在跑就每 3 秒刷一次；没有就歇着。刷的是当前停留的那一页。
  const hasActive = activeCount > 0;
  // 渲染一次要好几分钟，光有进度条看不出跑了多久，这里每秒把「已跑」往前推一格。
  const now = useNow(hasActive);
  useEffect(() => {
    if (!hasActive) return;
    const timer = window.setInterval(() => {
      void loadTasks().catch(() => undefined);
    }, TASK_POLL_MS);
    return () => window.clearInterval(timer);
  }, [hasActive, loadTasks]);

  // 引擎离线时隔一会儿再探一次，恢复了页面自己会亮起来。
  const engineOnline = Boolean(overview?.engine.online);
  useEffect(() => {
    if (!overview || engineOnline) return;
    const timer = window.setInterval(() => {
      testShortVideoEngine()
        .then((data) => setOverview((current) => (current ? { ...current, engine: data.engine } : current)))
        .catch(() => undefined);
    }, ENGINE_POLL_MS);
    return () => window.clearInterval(timer);
  }, [overview, engineOnline]);

  useEffect(() => {
    if (!notice || notice.tone === "bad") return;
    const timer = window.setTimeout(() => setNotice(null), 5000);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const options = overview?.options ?? null;
  const limits = options?.limits;
  const maxActive = limits?.maxActivePerUser ?? 2;
  const atLimit = activeCount >= maxActive;

  const voiceGroups = useMemo(() => {
    const groups = new Map<string, ShortVideoOverview["options"]["voices"]>();
    for (const voice of options?.voices ?? []) {
      const list = groups.get(voice.locale) ?? [];
      list.push(voice);
      groups.set(voice.locale, list);
    }
    return [...groups.entries()];
  }, [options]);

  const handleTestEngine = async () => {
    setBusy("engine");
    try {
      const data = await testShortVideoEngine();
      setOverview((current) => (current ? { ...current, engine: data.engine } : current));
      if (data.engine.online) {
        setNotice({ tone: "good", text: `引擎在线（${data.engine.latencyMs ?? "?"} ms）。` });
        void load();
      } else {
        setNotice({ tone: "bad", text: data.engine.error || "引擎离线。" });
      }
    } catch (error) {
      setNotice({ tone: "bad", text: error instanceof Error ? error.message : "探测失败。" });
    } finally {
      setBusy("");
    }
  };

  const handleScript = async () => {
    if (!safeForm.subject.trim()) {
      setNotice({ tone: "bad", text: "先写一句主题，再让 AI 写文案。" });
      return;
    }
    setBusy("script");
    try {
      const data = await generateShortVideoScript({ subject: safeForm.subject, language: safeForm.language });
      patch({ script: data.script });
      setNotice({ tone: "good", text: "文案已生成，可以直接改。" });
    } catch (error) {
      setNotice({ tone: "bad", text: error instanceof Error ? error.message : "文案生成失败。" });
    } finally {
      setBusy("");
    }
  };

  const handleTerms = async () => {
    if (!safeForm.subject.trim() && !safeForm.script.trim()) {
      setNotice({ tone: "bad", text: "主题或文案至少有一个，才能抽关键词。" });
      return;
    }
    setBusy("terms");
    try {
      const data = await generateShortVideoTerms({ subject: safeForm.subject, script: safeForm.script, amount: 5 });
      patch({ terms: data.terms });
    } catch (error) {
      setNotice({ tone: "bad", text: error instanceof Error ? error.message : "关键词生成失败。" });
    } finally {
      setBusy("");
    }
  };

  const addTerm = () => {
    const value = termDraft.trim();
    if (!value) return;
    if (!safeForm.terms.includes(value)) patch({ terms: [...safeForm.terms, value].slice(0, 10) });
    setTermDraft("");
  };

  const toggleMaterial = (name: string) => {
    const next = safeForm.materials.includes(name) ? safeForm.materials.filter((item) => item !== name) : [...safeForm.materials, name];
    patch({ materials: next });
  };

  const handleUpload = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (limits && file.size > limits.materialMaxBytes) {
      setNotice({ tone: "bad", text: `素材太大了，最多 ${Math.round(limits.materialMaxBytes / 1024 / 1024)} MB。` });
      return;
    }
    setBusy("upload");
    try {
      const uploaded = await uploadShortVideoMaterial(file);
      const list = await fetchShortVideoMaterials();
      setMaterials(list.files);
      patch({ source: "local", materials: [...safeForm.materials, uploaded.file] });
      setNotice({ tone: "good", text: `已上传 ${uploaded.originalName}。` });
    } catch (error) {
      setNotice({ tone: "bad", text: error instanceof Error ? error.message : "上传失败。" });
    } finally {
      setBusy("");
    }
  };

  const handleMusicUpload = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (limits && file.size > limits.musicMaxBytes) {
      setNotice({ tone: "bad", text: `音乐太大了，最多 ${Math.round(limits.musicMaxBytes / 1024 / 1024)} MB。` });
      return;
    }
    setBusy("music");
    try {
      const uploaded = await uploadShortVideoMusic(file);
      const next = await fetchShortVideoOverview();
      setOverview(next);
      patch({ bgm: { ...safeForm.bgm, type: "file", file: uploaded.file } });
      setNotice({ tone: "good", text: `已上传 ${uploaded.originalName}，并选成这次的背景音乐。` });
    } catch (error) {
      setNotice({ tone: "bad", text: error instanceof Error ? error.message : "上传音乐失败。" });
    } finally {
      setBusy("");
    }
  };

  const handleMetadata = async (task: ShortVideoTask) => {
    setBusy(`metadata:${task.id}`);
    try {
      const { metadata } = await generateShortVideoMetadata({
        subject: task.subject,
        script: task.script,
        platform: metadataPlatform,
        language: task.params.language ?? "",
      });
      setMetadataByTask((current) => ({ ...current, [task.id]: metadata }));
    } catch (error) {
      setNotice({ tone: "bad", text: error instanceof Error ? error.message : "发布文案生成失败。" });
    } finally {
      setBusy("");
    }
  };

  const copyText = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setNotice({ tone: "good", text: "已复制。" });
    } catch {
      setNotice({ tone: "bad", text: "浏览器不让复制，手动选中吧。" });
    }
  };

  const handleSubmit = async () => {
    if (!safeForm.subject.trim() && !safeForm.script.trim()) {
      setNotice({ tone: "bad", text: "主题和文案至少填一个。" });
      return;
    }
    if (safeForm.source === "local" && !safeForm.materials.length) {
      setNotice({ tone: "bad", text: "选了本地素材，就至少挑一个文件。" });
      return;
    }
    setBusy("submit");
    try {
      const data = await createShortVideoTask(safeForm);
      // 新任务永远在第一页；停在第几页都跳回去，不然提交完看不到它。
      await loadTasks(1).catch(() => setTasks((current) => [data.task, ...current.filter((item) => item.id !== data.task.id)]));
      setExpandedTaskId(data.task.id);
      setNotice({ tone: "good", text: "任务已提交，合成大约要一到三分钟。" });
    } catch (error) {
      setNotice({ tone: "bad", text: error instanceof Error ? error.message : "提交失败。" });
    } finally {
      setBusy("");
    }
  };

  const handleArchive = async (task: ShortVideoTask) => {
    setBusy(`archive:${task.id}`);
    try {
      await archiveShortVideoTask(task.id);
      await loadTasks();
      setNotice({ tone: "good", text: "已推到云盘。" });
    } catch (error) {
      setNotice({ tone: "bad", text: error instanceof Error ? error.message : "归档失败。" });
    } finally {
      setBusy("");
    }
  };

  /** 排队中 / 生成中的任务取消：本站标成已取消、不再轮询；引擎那边的任务顺手删掉。 */
  const handleCancel = async (task: ShortVideoTask) => {
    if (!window.confirm(task.status === "queued" ? "取消这条排队中的任务？" : "这条已经在生成了，取消后已消耗的引擎时间不会退回。仍然取消？")) return;
    setBusy(`cancel:${task.id}`);
    try {
      const data = await cancelShortVideoTask(task.id);
      setActiveCount(data.activeCount);
      setTasks((current) => current.map((item) => (item.id === task.id ? data.task : item)));
      setNotice({ tone: "info", text: "已取消。" });
    } catch (error) {
      setNotice({ tone: "bad", text: error instanceof Error ? error.message : "取消失败。" });
    } finally {
      setBusy("");
    }
  };

  const handleDelete = async (task: ShortVideoTask) => {
    // 删除连服务器上的成片一起没了，没有回收站：至少确认一次。
    if (!window.confirm(task.status === "completed" ? "删除这条任务和它的成片、字幕？服务器上的文件会一起清掉，无法恢复。" : "删除这条任务记录？")) return;
    try {
      await deleteShortVideoTask(task.id);
      // 重新拉当前这一页：删掉一条之后要把后面的补上来，总数也要跟着变。
      await loadTasks().catch(() => setTasks((current) => current.filter((item) => item.id !== task.id)));
    } catch (error) {
      setNotice({ tone: "bad", text: error instanceof Error ? error.message : "删除失败。" });
    }
  };

  const submitBlocked = !engineOnline || atLimit || busy === "submit";
  const submitHint = !overview
    ? "正在连接短视频引擎…"
    : !overview.engine.configured
      ? "引擎未接入：服务端还没配 SHORTVIDEO_ENGINE_URL。"
      : !overview.engine.online
        ? `引擎离线：${overview.engine.error || "连不上"}`
        : atLimit
          ? `同时最多跑 ${maxActive} 条，等前面的完成。`
          : overview.llm.demo && !safeForm.script.trim()
            ? "文案模型是演示模式：会用示例文案，建议自己写。"
            : `不扣积分 · ${safeForm.aspect} · ${safeForm.count} 条`;

  const engineTone = !overview ? "" : overview.engine.online ? "online" : overview.engine.configured ? "offline" : "unset";
  const engineText = !overview
    ? "连接中"
    : overview.engine.online
      ? `引擎在线 · ${overview.engine.url}`
      : overview.engine.configured
        ? "引擎离线"
        : "引擎未接入";

  // 页面外壳（single-view / shortvideo-page / 子模块切换）在 ShortVideoHub 里，这里只渲染本模块的内容。
  return (
    <div className="shortvideo-module" data-module="compose">
      <header className="shortvideo-head">
        <div className="shortvideo-head-copy">
          <span className="rail-kicker">短视频</span>
          <h1>
            <Clapperboard size={20} aria-hidden="true" /> 一句主题，出一条带配音字幕的短视频
          </h1>
          <p className="muted-text">
            写文案 → 抽关键词 → 找素材 → 配音字幕 → 合成。成片在本站保留 {limits?.retention?.outputDays ?? 3} 天（可推云盘），上传的素材 / 音乐 {limits?.retention?.uploadHours ?? 24} 小时后自动清理。仅 admin 可见，暂不扣积分。
          </p>
        </div>
        <div className="shortvideo-head-side">
          <button
            type="button"
            className={`shortvideo-engine-pill ${engineTone}`}
            onClick={() => void handleTestEngine()}
            disabled={busy === "engine"}
            title={overview?.engine.error || "点一下重新探测引擎"}
          >
            <i aria-hidden="true" />
            {engineText}
            <RefreshCw size={12} aria-hidden="true" className={busy === "engine" ? "spin" : ""} />
          </button>
        </div>
      </header>

      {loadError ? <p className="shortvideo-notice bad">{loadError}</p> : null}
      {notice ? (
        <p className={`shortvideo-notice ${notice.tone}`} role="status">
          {notice.text}
        </p>
      ) : null}

      <div className="shortvideo-layout">
        <section className="simple-card shortvideo-form" aria-label="短视频参数">
          {/* 1. 主题与文案 */}
          <div className="shortvideo-block">
            <div className="shortvideo-block-head">
              <span className="rail-kicker">1 · 主题与文案</span>
              <div className="chip-group chip-sm">
                {(options?.languages ?? []).map((item) => (
                  <button
                    type="button"
                    key={item.id || "auto"}
                    role="radio"
                    aria-checked={safeForm.language === item.id}
                    className={safeForm.language === item.id ? "chip selected" : "chip"}
                    onClick={() => patch({ language: item.id })}
                  >
                    {item.label}
                  </button>
                ))}
              </div>
            </div>
            <label className="field">
              <span>主题</span>
              <input
                type="text"
                value={safeForm.subject}
                maxLength={200}
                placeholder="例如：秋冬大衣穿搭三招 / 一分钟看懂羊毛和羊绒的区别"
                onChange={(event) => patch({ subject: event.target.value })}
              />
            </label>
            <label className="simple-prompt shortvideo-script">
              <textarea
                rows={6}
                value={safeForm.script}
                maxLength={limits?.maxScriptChars ?? 3000}
                placeholder="旁白文案。留空的话，提交时会先用 AI 按主题写一段；也可以点右下角先生成再改。"
                onChange={(event) => patch({ script: event.target.value })}
              />
              <span className="shortvideo-script-foot">
                <small>
                  {safeForm.script.length} / {limits?.maxScriptChars ?? 3000} 字
                </small>
                <Button variant="ghost" icon={<WandSparkles size={14} />} onClick={() => void handleScript()} disabled={busy === "script"}>
                  {busy === "script" ? "写文案中…" : "AI 写文案"}
                </Button>
              </span>
            </label>
            <div className="shortvideo-row">
              <div className="simple-control">
                <span className="field-label">写几段</span>
                <NumberStepper
                  value={safeForm.paragraphs}
                  min={limits?.paragraphs[0] ?? 1}
                  max={limits?.paragraphs[1] ?? 10}
                  onChange={(value) => patch({ paragraphs: value })}
                  ariaLabel="文案段落数"
                />
              </div>
              <label className="field shortvideo-select wide">
                <span>写文案的额外要求（可留空）</span>
                <input
                  type="text"
                  value={safeForm.scriptPrompt}
                  maxLength={limits?.maxScriptPromptChars ?? 500}
                  placeholder="例如：口语一点，开头先抛一个问题，别用形容词堆砌"
                  onChange={(event) => patch({ scriptPrompt: event.target.value })}
                />
              </label>
            </div>
          </div>

          {/* 2. 画面 */}
          <div className="shortvideo-block">
            <span className="rail-kicker">2 · 画面</span>
            <div className="shortvideo-row">
              <div className="simple-control">
                <span className="field-label">画幅</span>
                <div className="chip-group chip-sm shortvideo-aspects" role="radiogroup" aria-label="画幅">
                  {(options?.aspects ?? []).map((item) => (
                    <button
                      type="button"
                      key={item.id}
                      role="radio"
                      aria-checked={safeForm.aspect === item.id}
                      title={item.hint}
                      className={safeForm.aspect === item.id ? "chip selected" : "chip"}
                      onClick={() => patch({ aspect: item.id })}
                    >
                      <AspectGlyph option={item} size={16} />
                      {item.label}
                    </button>
                  ))}
                </div>
              </div>
              <div className="simple-control">
                <span className="field-label">素材来源</span>
                <ChipGroup size="sm" ariaLabel="素材来源" options={options?.sources ?? []} value={safeForm.source} onChange={(id) => patch({ source: id })} />
              </div>
            </div>

            {safeForm.source === "local" ? (
              <div className="shortvideo-materials">
                <div className="shortvideo-block-head">
                  <span className="field-label">本地素材（可多选，按点选顺序拼接；上传 {limits?.retention?.uploadHours ?? 24} 小时后自动清理）</span>
                  <input ref={fileInputRef} type="file" accept=".mp4,.mov,.avi,.flv,.mkv,.jpg,.jpeg,.png" hidden onChange={(event) => void handleUpload(event)} />
                  <Button variant="ghost" icon={<Upload size={14} />} onClick={() => fileInputRef.current?.click()} disabled={busy === "upload" || !engineOnline}>
                    {busy === "upload" ? "上传中…" : "上传素材"}
                  </Button>
                </div>
                {materials.length ? (
                  <div className="chip-group chip-sm" role="group" aria-label="本地素材">
                    {materials.map((file) => {
                      const selected = safeForm.materials.includes(file.name);
                      return (
                        <button
                          type="button"
                          key={file.name}
                          aria-pressed={selected}
                          className={selected ? "chip selected" : "chip"}
                          title={`${formatBytes(file.size)}${file.expiresAt ? ` · ${remainingLabel(file.expiresAt, now)}` : ""}`}
                          onClick={() => toggleMaterial(file.name)}
                        >
                          {file.originalName || file.name}
                        </button>
                      );
                    })}
                  </div>
                ) : (
                  <p className="field-hint">引擎里还没有本地素材，先上传几段视频或图片。</p>
                )}
              </div>
            ) : (
              <div className="shortvideo-terms">
                <div className="shortvideo-block-head">
                  <span className="field-label">素材关键词（英文，检索实拍库用；留空自动生成）</span>
                  <Button variant="ghost" icon={<Sparkles size={14} />} onClick={() => void handleTerms()} disabled={busy === "terms"}>
                    {busy === "terms" ? "抽取中…" : "AI 抽关键词"}
                  </Button>
                </div>
                <div className="chip-group chip-sm shortvideo-term-chips" role="group" aria-label="关键词">
                  {safeForm.terms.map((term) => (
                    <button type="button" key={term} className="chip selected" title="点一下移除" onClick={() => patch({ terms: safeForm.terms.filter((item) => item !== term) })}>
                      {term} ×
                    </button>
                  ))}
                  <input
                    type="text"
                    className="shortvideo-term-input"
                    value={termDraft}
                    placeholder={safeForm.terms.length ? "再加一个…" : "如 city street、coffee cup"}
                    onChange={(event) => setTermDraft(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === ",") {
                        event.preventDefault();
                        addTerm();
                      }
                    }}
                    onBlur={addTerm}
                  />
                </div>
              </div>
            )}

            <div className="shortvideo-row">
              <div className="simple-control">
                <span className="field-label">单段时长（秒）</span>
                <NumberStepper value={safeForm.clipDuration} min={limits?.clipDuration[0] ?? 2} max={limits?.clipDuration[1] ?? 10} onChange={(value) => patch({ clipDuration: value })} ariaLabel="单段时长" />
              </div>
              <div className="simple-control">
                <span className="field-label">拼接</span>
                <ChipGroup size="sm" ariaLabel="拼接方式" options={options?.concatModes ?? []} value={safeForm.concatMode} onChange={(id) => patch({ concatMode: id })} />
              </div>
              <label className="field shortvideo-select">
                <span>转场</span>
                <select value={safeForm.transition} onChange={(event) => patch({ transition: event.target.value })}>
                  {(options?.transitions ?? []).map((item) => (
                    <option key={item.id || "none"} value={item.id}>
                      {item.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field shortvideo-range">
                <span>片段倍速 {safeForm.clipSpeed.toFixed(2)}×</span>
                <input
                  type="range"
                  min={limits?.clipSpeed[0] ?? 0.5}
                  max={limits?.clipSpeed[1] ?? 2}
                  step={0.05}
                  value={safeForm.clipSpeed}
                  onChange={(event) => patch({ clipSpeed: Number(event.target.value) })}
                />
              </label>
              <div className="simple-control">
                <span className="field-label">条数</span>
                <NumberStepper value={safeForm.count} min={1} max={limits?.maxCount ?? 3} onChange={(value) => patch({ count: value })} ariaLabel="生成条数" />
              </div>
            </div>

            {safeForm.source !== "local" ? (
              <label className="shortvideo-check">
                <input type="checkbox" checked={safeForm.matchScript} onChange={(event) => patch({ matchScript: event.target.checked })} />
                <span>
                  <strong>素材跟着文案走</strong>
                  <small>逐段找对应画面，讲到哪儿画面就到哪儿；开了会强制按顺序拼接。</small>
                </span>
              </label>
            ) : null}

            {/* 引擎在一次出多条时会强制打乱顺序，这里照实说，别让人以为设置没生效。 */}
            {safeForm.count > 1 && safeForm.concatMode === "sequential" ? (
              <p className="field-hint">一次出多条时引擎会强制随机拼接，「顺序拼接」这次不会生效。</p>
            ) : null}
            {safeForm.matchScript && safeForm.concatMode !== "sequential" ? (
              <p className="field-hint">「素材跟着文案走」会按顺序拼接，拼接方式这次按顺序算。</p>
            ) : null}
          </div>

          {/* 3. 配音与音乐 */}
          <div className="shortvideo-block">
            <span className="rail-kicker">3 · 配音与音乐</span>
            <div className="shortvideo-row">
              <label className="field shortvideo-select wide">
                <span>音色（Edge TTS）</span>
                <select value={safeForm.voice} onChange={(event) => patch({ voice: event.target.value })}>
                  {voiceGroups.map(([locale, voices]) => (
                    <optgroup key={locale} label={locale}>
                      {voices.map((voice) => (
                        <option key={voice.id} value={voice.id}>
                          {voice.label}
                        </option>
                      ))}
                    </optgroup>
                  ))}
                </select>
              </label>
              <div className="simple-control">
                <span className="field-label">语速</span>
                <ChipGroup size="sm" ariaLabel="语速" options={rateOptions} value={String(safeForm.voiceRate)} onChange={(id) => patch({ voiceRate: Number(id) })} />
              </div>
            </div>
            <div className="shortvideo-row">
              <div className="simple-control">
                <span className="field-label">背景音乐</span>
                <ChipGroup size="sm" ariaLabel="背景音乐" options={options?.bgm ?? []} value={safeForm.bgm.type} onChange={(id) => patch({ bgm: { ...safeForm.bgm, type: id } })} />
              </div>
              {safeForm.bgm.type === "file" ? (
                <>
                  <label className="field shortvideo-select wide">
                    <span>曲目</span>
                    <select value={safeForm.bgm.file} onChange={(event) => patch({ bgm: { ...safeForm.bgm, file: event.target.value } })}>
                      <option value="">选一首…</option>
                      {(overview?.musics ?? []).map((music) => (
                        <option key={music.name} value={music.name}>
                          {music.originalName ? `${music.originalName}（${music.name}）` : music.name}
                          {music.expiresAt ? ` · ${remainingLabel(music.expiresAt, now)}` : ""}
                        </option>
                      ))}
                    </select>
                  </label>
                  <div className="simple-control">
                    <span className="field-label">自己的音乐</span>
                    <input ref={musicInputRef} type="file" accept=".mp3,.m4a,.aac,.wav,.flac,.ogg,.opus,.wma" hidden onChange={(event) => void handleMusicUpload(event)} />
                    <Button variant="ghost" icon={<Upload size={14} />} onClick={() => musicInputRef.current?.click()} disabled={busy === "music" || !engineOnline}>
                      {busy === "music" ? "上传中…" : "上传音乐"}
                    </Button>
                  </div>
                </>
              ) : null}
              {safeForm.bgm.type !== "none" ? (
                <label className="field shortvideo-range">
                  <span>音乐音量 {Math.round(safeForm.bgm.volume * 100)}%</span>
                  <input type="range" min={0} max={1} step={0.05} value={safeForm.bgm.volume} onChange={(event) => patch({ bgm: { ...safeForm.bgm, volume: Number(event.target.value) } })} />
                </label>
              ) : null}
            </div>
          </div>

          {/* 4. 字幕 */}
          <div className="shortvideo-block">
            <div className="shortvideo-block-head">
              <span className="rail-kicker">4 · 字幕</span>
              <ChipGroup
                size="sm"
                ariaLabel="字幕开关"
                options={[
                  { id: "on", label: "显示" },
                  { id: "off", label: "不要" },
                ]}
                value={safeForm.subtitle.enabled ? "on" : "off"}
                onChange={(id) => patch({ subtitle: { ...safeForm.subtitle, enabled: id === "on" } })}
              />
            </div>
            {safeForm.subtitle.enabled ? (
              <div className="shortvideo-row">
                <div className="simple-control">
                  <span className="field-label">位置</span>
                  <ChipGroup size="sm" ariaLabel="字幕位置" options={options?.subtitlePositions ?? []} value={safeForm.subtitle.position} onChange={(id) => patch({ subtitle: { ...safeForm.subtitle, position: id } })} />
                </div>
                <label className="field shortvideo-select">
                  <span>字体</span>
                  <select value={safeForm.subtitle.font} onChange={(event) => patch({ subtitle: { ...safeForm.subtitle, font: event.target.value } })}>
                    {(options?.fonts ?? []).map((font) => (
                      <option key={font.id} value={font.id}>
                        {font.label}
                      </option>
                    ))}
                  </select>
                </label>
                <div className="simple-control">
                  <span className="field-label">字号</span>
                  <NumberStepper value={safeForm.subtitle.size} min={24} max={120} step={4} onChange={(value) => patch({ subtitle: { ...safeForm.subtitle, size: value } })} ariaLabel="字号" />
                </div>
                <label className="field shortvideo-color">
                  <span>字色</span>
                  <input type="color" value={safeForm.subtitle.color} onChange={(event) => patch({ subtitle: { ...safeForm.subtitle, color: event.target.value.toUpperCase() } })} />
                </label>
                <label className="field shortvideo-color">
                  <span>描边</span>
                  <input type="color" value={safeForm.subtitle.strokeColor} onChange={(event) => patch({ subtitle: { ...safeForm.subtitle, strokeColor: event.target.value.toUpperCase() } })} />
                </label>
                {safeForm.subtitle.position === "custom" ? (
                  <label className="field shortvideo-range">
                    <span>距顶部 {Math.round(safeForm.subtitle.customPosition)}%</span>
                    <input
                      type="range"
                      min={limits?.customPosition[0] ?? 0}
                      max={limits?.customPosition[1] ?? 100}
                      step={1}
                      value={safeForm.subtitle.customPosition}
                      onChange={(event) => patch({ subtitle: { ...safeForm.subtitle, customPosition: Number(event.target.value) } })}
                    />
                  </label>
                ) : null}
                <label className="shortvideo-check">
                  <input
                    type="checkbox"
                    checked={safeForm.subtitle.background.enabled}
                    onChange={(event) => patch({ subtitle: { ...safeForm.subtitle, background: { ...safeForm.subtitle.background, enabled: event.target.checked } } })}
                  />
                  <span>
                    <strong>加底色</strong>
                    <small>亮素材上白字看不清时打开。</small>
                  </span>
                </label>
                {safeForm.subtitle.background.enabled ? (
                  <>
                    <label className="field shortvideo-color">
                      <span>底色</span>
                      <input
                        type="color"
                        value={safeForm.subtitle.background.color}
                        onChange={(event) => patch({ subtitle: { ...safeForm.subtitle, background: { ...safeForm.subtitle.background, color: event.target.value.toUpperCase() } } })}
                      />
                    </label>
                    <label className="shortvideo-check">
                      <input
                        type="checkbox"
                        checked={safeForm.subtitle.background.rounded}
                        onChange={(event) => patch({ subtitle: { ...safeForm.subtitle, background: { ...safeForm.subtitle.background, rounded: event.target.checked } } })}
                      />
                      <span>
                        <strong>圆角</strong>
                      </span>
                    </label>
                  </>
                ) : null}
              </div>
            ) : null}
          </div>

          <div className="simple-submit shortvideo-submit">
            <div className="simple-submit-status">
              <span className={`prompt-status ${submitBlocked && busy !== "submit" ? "blocked" : ""}`} aria-live="polite">
                {submitHint}
              </span>
            </div>
            <Button variant="primary" icon={<Clapperboard size={15} />} onClick={() => void handleSubmit()} disabled={submitBlocked}>
              {busy === "submit" ? "提交中…" : "生成短视频"}
            </Button>
          </div>
        </section>

        <section className="shortvideo-tasks" aria-label="短视频任务">
          <header className="simple-card-head">
            <h2>任务</h2>
            <span className="muted-text">
              {activeCount ? `${activeCount} 条在跑 · ` : ""}
              {taskPage?.total ?? tasks.length} 条
            </span>
          </header>
          {tasks.length === 0 ? (
            <p className="shortvideo-empty">
              <Clapperboard size={26} aria-hidden="true" />
              还没有任务。左边填好主题，点「生成短视频」。
            </p>
          ) : null}
          {tasks.map((task) => {
            const expanded = expandedTaskId === task.id || (task.status === "completed" && expandedTaskId === null && tasks[0]?.id === task.id);
            const aspect = task.params.aspect || "9:16";
            const [aw, ah] = aspect.split(":").map(Number);
            const duration = taskDurationLabel({
              startedAt: task.createdAt,
              finishedAt: task.finishedAt,
              running: isActive(task),
              now,
            });
            return (
              <article key={task.id} className={`shortvideo-task ${task.status}`}>
                <button type="button" className="shortvideo-task-head" onClick={() => setExpandedTaskId(expanded ? "" : task.id)} aria-expanded={expanded}>
                  <span className="shortvideo-task-title">
                    <strong>{task.subject || "（无主题）"}</strong>
                    <small>
                      {formatTime(task.createdAt)} · {aspect} · {task.params.count ?? 1} 条
                      {duration ? ` · ${duration}` : ""}
                      {task.result.audioDuration ? ` · 配音 ${task.result.audioDuration}s` : ""}
                    </small>
                  </span>
                  <span className={`shortvideo-status ${task.status}`}>{statusLabel(task)}</span>
                </button>
                {isActive(task) ? (
                  <div className="progress-track" aria-hidden="true">
                    <span style={{ width: `${Math.max(4, task.progress)}%` }} />
                  </div>
                ) : null}
                {task.status === "failed" ? (
                  <p className="shortvideo-task-error">
                    {task.error || "生成失败。"}
                    {task.failureSource === "system" ? "（本站或网络问题，不是引擎渲染失败）" : ""}
                  </p>
                ) : null}
                {expanded && task.status === "completed" && !task.result.videos.length && task.storage?.expiredAt ? (
                  <p className="shortvideo-task-error">
                    成片在服务器上只保留 {task.storage.retentionDays} 天，已清理。{task.storage.archivePath ? ` 云盘里还有一份：${task.storage.archivePath}` : " 没有推过云盘，这条只剩文案记录。"}
                  </p>
                ) : null}
                {expanded && task.status === "completed" && task.result.videos.length ? (
                  <div className="shortvideo-task-body">
                    <div className="shortvideo-videos">
                      {task.result.videos.map((video) => (
                        <figure key={video.name} className="shortvideo-video">
                          <video controls preload="metadata" src={video.url} playsInline style={{ aspectRatio: aw && ah ? `${aw} / ${ah}` : "9 / 16" }} />
                          <figcaption>
                            <span>
                              {video.name} · {formatBytes(video.bytes)}
                            </span>
                            <a className="text-button" href={`${video.url}?download`}>
                              <Download size={13} aria-hidden="true" /> 下载
                            </a>
                          </figcaption>
                        </figure>
                      ))}
                    </div>
                    {task.script ? (
                      <details className="shortvideo-script-details">
                        <summary>文案</summary>
                        <p>{task.script}</p>
                        {task.terms.length ? <small>关键词：{task.terms.join(" · ")}</small> : null}
                      </details>
                    ) : null}
                    {task.result.warnings?.length ? <p className="field-hint">引擎提示：{task.result.warnings.join("；")}</p> : null}
                    <p className="field-hint">
                      {task.storage?.status === "webdav" && task.storage.archivePath ? `已推云盘：${task.storage.archivePath} · ` : ""}
                      服务器保留 {task.storage?.retentionDays ?? 3} 天{task.storage?.expiresAt ? `（${remainingLabel(task.storage.expiresAt, now)}）` : ""}，到期自动清理；要留底请下载或推云盘。
                    </p>

                    {/* 成片只是素材，能直接发出去才算做完：标题 / 简介 / 话题标签一次给齐。 */}
                    <div className="shortvideo-publish">
                      <div className="shortvideo-block-head">
                        <span className="field-label">发布文案</span>
                        <Button
                          variant="ghost"
                          icon={<Megaphone size={14} />}
                          onClick={() => void handleMetadata(task)}
                          disabled={busy === `metadata:${task.id}`}
                        >
                          {busy === `metadata:${task.id}` ? "生成中…" : metadataByTask[task.id] ? "换一版" : "生成"}
                        </Button>
                      </div>
                      <div className="chip-group chip-sm" role="radiogroup" aria-label="发布平台">
                        {(options?.platforms ?? []).map((platform) => (
                          <button
                            type="button"
                            key={platform.id}
                            role="radio"
                            aria-checked={metadataPlatform === platform.id}
                            className={metadataPlatform === platform.id ? "chip selected" : "chip"}
                            onClick={() => setMetadataPlatform(platform.id)}
                          >
                            {platform.label}
                          </button>
                        ))}
                      </div>
                      {metadataByTask[task.id] ? (
                        <dl className="shortvideo-publish-body">
                          <dt>标题</dt>
                          <dd>
                            <span>{metadataByTask[task.id].title}</span>
                            <button type="button" className="text-button" onClick={() => void copyText(metadataByTask[task.id].title)}>
                              复制
                            </button>
                          </dd>
                          <dt>简介</dt>
                          <dd>
                            <span>{metadataByTask[task.id].caption}</span>
                            <button type="button" className="text-button" onClick={() => void copyText(metadataByTask[task.id].caption)}>
                              复制
                            </button>
                          </dd>
                          <dt>话题</dt>
                          <dd>
                            <span>{metadataByTask[task.id].hashtags.join(" ")}</span>
                            <button type="button" className="text-button" onClick={() => void copyText(metadataByTask[task.id].hashtags.join(" "))}>
                              复制
                            </button>
                          </dd>
                        </dl>
                      ) : null}
                    </div>
                  </div>
                ) : null}
                {expanded && isActive(task) ? (
                  <div className="shortvideo-task-actions">
                    <button type="button" className="text-button danger" onClick={() => void handleCancel(task)} disabled={busy === `cancel:${task.id}`}>
                      <Trash2 size={13} aria-hidden="true" /> {busy === `cancel:${task.id}` ? "取消中…" : "取消任务"}
                    </button>
                  </div>
                ) : null}
                {expanded && (task.status === "completed" || task.status === "failed" || task.status === "cancelled") ? (
                  <div className="shortvideo-task-actions">
                    {task.result.subtitle ? (
                      <a className="text-button" href={`${task.result.subtitle}?download`}>
                        字幕 .srt
                      </a>
                    ) : null}
                    {task.status === "completed" && task.result.videos.length && task.storage?.status !== "webdav" ? (
                      <button type="button" className="text-button" onClick={() => void handleArchive(task)} disabled={busy === `archive:${task.id}`} title="推到文件管理里配的 WebDAV 云盘">
                        <CloudUpload size={13} aria-hidden="true" /> {busy === `archive:${task.id}` ? "推送中…" : "推到云盘"}
                      </button>
                    ) : null}
                    <button type="button" className="text-button danger" onClick={() => void handleDelete(task)}>
                      <Trash2 size={13} aria-hidden="true" /> 删除
                    </button>
                  </div>
                ) : null}
              </article>
            );
          })}
          {taskPage ? (
            <Pager
              page={taskPage.page}
              pageCount={taskPage.pageCount}
              total={taskPage.total}
              onChange={(page) => void loadTasks(page).catch(() => undefined)}
            />
          ) : null}
        </section>
      </div>
    </div>
  );
}
