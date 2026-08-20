import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type DragEvent } from "react";
import { Clapperboard, CloudUpload, Download, Film, Image as ImageIcon, Link2, Music, Plus, RefreshCw, Sparkles, Trash2, Upload } from "lucide-react";
import {
  archiveSeedanceTask,
  createSeedanceLastFrameRef,
  createSeedanceTasks,
  deleteSeedanceRef,
  deleteSeedanceTask,
  fetchSeedanceOverview,
  fetchSeedanceTasks,
  retrySeedanceGroupMerge,
  testSeedance,
  uploadSeedanceRef,
  type SeedanceOverview,
} from "../lib/api";
import type { PageInfo } from "../lib/api";
import { clipboardImageFiles, clipboardHasText } from "../lib/clipboardImages";
import { taskDurationLabel } from "../lib/duration";
import { useStoredState } from "../lib/storedState";
import { useNow } from "../lib/useNow";
import type { SeedanceMediaSlot, SeedanceModel, SeedanceMode, SeedanceRatioOption, SeedanceRef, SeedanceRefKind, SeedanceRequest, SeedanceTask } from "../types";
import { Button, ChipGroup, NumberStepper, Pager } from "./ui";

/**
 * Seedance 工坊：直接调火山方舟的视频生成模型出片。
 *
 * 参数按服务端下发的模型能力矩阵动态增减：常用的（方式 / 模型 / 提示词 / 素材 / 画幅 / 分辨率 / 时长 / 有声）直接摆出来，
 * 其余（种子、固定镜头、水印、尾帧、帧数、输出格式、服务等级、优先级、样片、联网搜索、超时、条数）收在「高级参数」里。
 * 校验和权限都在服务端（/api/seedance/*）；这里只负责把参数收齐、把进度和成片摆出来。
 */

const TASK_POLL_MS = 5000;
const STATUS_POLL_MS = 30000;
const FORM_STORAGE_KEY = "clothdesign:seedance:form";

const defaultForm: SeedanceRequest = {
  model: "",
  mode: "text",
  prompt: "",
  firstFrame: null,
  lastFrame: null,
  middleFrames: [],
  keyframeStrategy: "reference",
  references: [],
  omniTaskType: "auto",
  ratio: "9:16",
  resolution: "",
  duration: 5,
  frames: null,
  generateAudio: true,
  watermark: false,
  seed: -1,
  cameraFixed: false,
  returnLastFrame: false,
  outputFormat: "mp4",
  serviceTier: "default",
  priority: 0,
  draft: false,
  webSearch: false,
  expiresAfter: 172800,
  count: 1,
  draftTaskId: null,
};

const EXPIRES_CHOICES = [
  { id: "3600", label: "1 小时" },
  { id: "21600", label: "6 小时" },
  { id: "86400", label: "24 小时" },
  { id: "172800", label: "48 小时（默认）" },
  { id: "259200", label: "72 小时" },
];

const KIND_ICON: Record<SeedanceRefKind, typeof ImageIcon> = { image: ImageIcon, video: Film, audio: Music };
const KIND_LABEL: Record<SeedanceRefKind, string> = { image: "图片", video: "视频", audio: "音频" };

function RatioGlyph({ option, size = 20 }: { option: SeedanceRatioOption; size?: number }) {
  if (!option.w || !option.h) {
    return (
      <span className="ratio-glyph" style={{ width: size, height: size }} aria-hidden="true">
        <i className="ratio-glyph-box ratio-glyph-auto" style={{ width: size * 0.8, height: size * 0.8 }} />
      </span>
    );
  }
  const longest = Math.max(option.w, option.h);
  return (
    <span className="ratio-glyph" style={{ width: size, height: size }} aria-hidden="true">
      <i className="ratio-glyph-box" style={{ width: Math.max(4, (option.w / longest) * size), height: Math.max(4, (option.h / longest) * size) }} />
    </span>
  );
}

function formatBytes(bytes: number) {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

function formatTime(iso: string) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return `${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")} ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function isActive(task: SeedanceTask) {
  return task.status === "queued" || task.status === "running";
}

/** 把任意（可能过期的）表单收成当前模型能接受的值；UI 绑定的是这份，提交的也是这份。 */
function coerceForm(raw: SeedanceRequest, model: SeedanceModel | null, ratios: SeedanceRatioOption[]): SeedanceRequest {
  const form: SeedanceRequest = { ...defaultForm, ...raw, references: Array.isArray(raw.references) ? raw.references : [], middleFrames: Array.isArray(raw.middleFrames) ? raw.middleFrames : [] };
  if (!model) return form;
  form.model = model.id;
  if (!model.modes.includes(form.mode)) form.mode = model.modes[0];
  if (!model.resolutions.includes(form.resolution)) form.resolution = model.defaultResolution;
  const allowAdaptive = form.mode === "text" ? model.textAdaptive : true;
  const ratioIds = ratios.map((item) => item.id).filter((id) => id !== "adaptive" || allowAdaptive);
  if (!ratioIds.includes(form.ratio)) form.ratio = allowAdaptive && form.mode !== "text" ? "adaptive" : "9:16";
  if (form.mode === "image" && model.imageAdaptiveOnly) form.ratio = "adaptive";
  if (form.mode === "omni" && model.omniTaskType && (form.omniTaskType === "edit" || form.omniTaskType === "extend")) form.ratio = "adaptive";
  if (!model.omniTaskType || form.mode !== "omni") form.omniTaskType = "auto";
  if (form.duration === -1 && !model.duration.smart) form.duration = Math.min(Math.max(5, model.duration.min), model.duration.max);
  if (form.duration !== -1) form.duration = Math.min(Math.max(Math.round(form.duration) || model.duration.min, model.duration.min), model.duration.max);
  if (!model.frames) form.frames = null;
  if (!model.audio) form.generateAudio = false;
  if (!model.seed) form.seed = -1;
  if (!model.cameraFixed || form.mode === "omni") form.cameraFixed = false;
  if (!model.draft) form.draft = false;
  if (form.draft) {
    form.resolution = "480p";
    form.returnLastFrame = false;
  }
  if (!model.outputFormats.includes(form.outputFormat)) form.outputFormat = "mp4";
  if (!model.serviceTiers.includes(form.serviceTier)) form.serviceTier = "default";
  if (!model.priority || form.serviceTier === "flex") form.priority = 0;
  if (!model.webSearch) form.webSearch = false;
  if (form.mode !== "image") {
    form.firstFrame = null;
    form.lastFrame = null;
    form.middleFrames = [];
  }
  if (!model.lastFrame) form.lastFrame = null;
  // 中间帧的落地法跟着模型走：2.x 默认参考图一镜到底；不支持参考图就只能分段；连尾帧都不支持的（1.0 pro fast）两条路都没有。
  if (form.middleFrames.length) {
    if (form.keyframeStrategy === "reference" && !model.omni) form.keyframeStrategy = "segments";
    if (form.keyframeStrategy === "segments" && !model.lastFrame && model.omni) form.keyframeStrategy = "reference";
    if (form.keyframeStrategy === "segments") form.count = 1;
  }
  if (form.mode !== "omni") form.references = [];
  return form;
}

/** 拖素材库里的卡片到槽位时，dataTransfer 里放的就是这个。 */
const REF_DRAG_TYPE = "application/x-seedance-ref";

/** 放下的是文件还是素材库的引用。 */
function readDrop(event: DragEvent<HTMLElement>): { files: File[]; refId: string } {
  const refId = event.dataTransfer.getData(REF_DRAG_TYPE) || "";
  const files = Array.from(event.dataTransfer.files ?? []);
  return { files, refId };
}

/** 是否带着文件 / 素材引用在拖（纯文字拖动不算）。 */
function dragHasPayload(event: DragEvent<HTMLElement>) {
  const types = Array.from(event.dataTransfer.types ?? []);
  return types.includes("Files") || types.includes(REF_DRAG_TYPE);
}

function formatRemaining(iso: string | null | undefined, now: number) {
  if (!iso) return "";
  const diff = Date.parse(iso) - now;
  if (!Number.isFinite(diff)) return "";
  if (diff <= 0) return "即将清理";
  const hours = Math.floor(diff / 3600000);
  if (hours >= 48) return `${Math.floor(hours / 24)} 天后清理`;
  if (hours >= 1) return `${hours} 小时后清理`;
  return `${Math.max(1, Math.floor(diff / 60000))} 分钟后清理`;
}

function targetLabel(target: string) {
  if (target === "last") return "尾帧";
  if (target === "middle:new") return "中间帧";
  if (target.startsWith("middle:")) return `中间帧 ${Number(target.slice(7)) + 1}`;
  return "首帧";
}

function slotLabel(slot: SeedanceMediaSlot | null, refs: SeedanceRef[]) {
  if (!slot) return "";
  if (slot.refId) return refs.find((ref) => ref.id === slot.refId)?.name || slot.name || "已上传素材";
  return slot.url || "";
}

function slotPreview(slot: SeedanceMediaSlot | null, refs: SeedanceRef[]) {
  if (!slot) return "";
  if (slot.refId) {
    const ref = refs.find((item) => item.id === slot.refId);
    return ref?.kind === "image" ? ref.url : "";
  }
  return /^https?:\/\//.test(slot.url || "") && /\.(png|jpe?g|webp|gif|bmp)(\?|$)/i.test(slot.url || "") ? slot.url || "" : "";
}

export function SeedanceStudio() {
  const [overview, setOverview] = useState<SeedanceOverview | null>(null);
  const [loadError, setLoadError] = useState("");
  const [tasks, setTasks] = useState<SeedanceTask[]>([]);
  const [taskPage, setTaskPage] = useState<PageInfo | undefined>(undefined);
  const taskPageRef = useRef(1);
  const [activeCount, setActiveCount] = useState(0);
  const [arkActiveCount, setArkActiveCount] = useState(0);
  const [refs, setRefs] = useState<SeedanceRef[]>([]);
  const [rawForm, setForm] = useStoredState<SeedanceRequest>(FORM_STORAGE_KEY, defaultForm);
  const [showAdvanced, setShowAdvanced] = useStoredState("clothdesign:seedance:advanced", false);
  const [busy, setBusy] = useState<string>("");
  const [notice, setNotice] = useState<{ tone: "info" | "bad" | "good"; text: string } | null>(null);
  const [expandedTaskId, setExpandedTaskId] = useState<string | null>(null);
  // 正在往哪个槽位填素材："first" / "last" / "omni" / "middle:new"（追加一张中间帧）/ "middle:<序号>"（替换那张）。
  const [pickTarget, setPickTarget] = useState<string>("first");
  const [urlDraft, setUrlDraft] = useState("");
  const [urlKind, setUrlKind] = useState<SeedanceRefKind>("image");
  const [useFrames, setUseFrames] = useState(false);
  const [dropOver, setDropOver] = useState<string>("");
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const options = overview?.options;
  const status = overview?.status;
  const models = useMemo(() => options?.models ?? [], [options]);

  const load = useCallback(async () => {
    try {
      const data = await fetchSeedanceOverview();
      setOverview(data);
      setTasks(data.tasks);
      setTaskPage(data.pagination);
      taskPageRef.current = data.pagination?.page ?? 1;
      setActiveCount(data.activeCount ?? data.tasks.filter(isActive).length);
      setArkActiveCount(data.arkActiveCount ?? data.activeCount ?? 0);
      setRefs(data.refs);
      setLoadError("");
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "Seedance 模块加载失败。");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const loadTasks = useCallback(async (page = taskPageRef.current) => {
    const data = await fetchSeedanceTasks({ page });
    taskPageRef.current = data.pagination?.page ?? page;
    setTasks(data.tasks);
    setTaskPage(data.pagination);
    setActiveCount(data.activeCount ?? data.tasks.filter(isActive).length);
    setArkActiveCount(data.arkActiveCount ?? data.activeCount ?? 0);
  }, []);

  // 有任务在跑就每 5 秒刷一次；方舟那边一条视频要几分钟，刷太勤没意义。
  const hasActive = activeCount > 0;
  const now = useNow(hasActive);
  useEffect(() => {
    if (!hasActive) return;
    const timer = window.setInterval(() => {
      void loadTasks().catch(() => undefined);
    }, TASK_POLL_MS);
    return () => window.clearInterval(timer);
  }, [hasActive, loadTasks]);

  // 方舟连不上时隔一会儿再探一次。
  const online = Boolean(status?.online);
  useEffect(() => {
    if (!overview || online || !status?.configured) return;
    const timer = window.setInterval(() => {
      testSeedance()
        .then((data) => setOverview((current) => (current ? { ...current, status: data.status } : current)))
        .catch(() => undefined);
    }, STATUS_POLL_MS);
    return () => window.clearInterval(timer);
  }, [overview, online, status?.configured]);

  /* ── 模型 / 表单 ────────────────────────────────────────────────────────── */

  // 先按方式筛模型：想做多模态参考就只剩 2.x；当前模型不支持就换成第一个支持的。
  const requestedMode: SeedanceMode = rawForm.mode || "text";
  const modelsForMode = useMemo(() => models.filter((model) => model.modes.includes(requestedMode)), [models, requestedMode]);
  const model = useMemo<SeedanceModel | null>(() => {
    if (!models.length) return null;
    const pool = modelsForMode.length ? modelsForMode : models;
    return pool.find((item) => item.id === rawForm.model) || pool.find((item) => item.id === options?.defaultModel) || pool[0];
  }, [models, modelsForMode, rawForm.model, options?.defaultModel]);

  const form = useMemo(() => coerceForm(rawForm, model, options?.ratios ?? []), [rawForm, model, options?.ratios]);

  const patch = useCallback((changes: Partial<SeedanceRequest>) => setForm((current) => ({ ...defaultForm, ...current, ...changes })), [setForm]);

  const ratioChoices = useMemo(() => {
    if (!options || !model) return [];
    const allowAdaptive = form.mode === "text" ? model.textAdaptive : true;
    return options.ratios.filter((item) => item.id !== "adaptive" || allowAdaptive);
  }, [options, model, form.mode]);
  const ratioLocked = Boolean(model && ((form.mode === "image" && model.imageAdaptiveOnly) || (form.mode === "omni" && model.omniTaskType && (form.omniTaskType === "edit" || form.omniTaskType === "extend"))));
  const resolutionChoices = useMemo(() => (options && model ? options.resolutions.filter((item) => model.resolutions.includes(item.id)) : []), [options, model]);
  const omniCounts = useMemo(
    () => ({
      image: form.references.filter((item) => item.kind === "image").length,
      video: form.references.filter((item) => item.kind === "video").length,
      audio: form.references.filter((item) => item.kind === "audio").length,
    }),
    [form.references],
  );
  const needsPublicMedia = form.references.some((item) => item.refId && item.kind !== "image");

  /* ── 素材 ───────────────────────────────────────────────────────────────── */

  const keyframeCount = (form.firstFrame ? 1 : 0) + form.middleFrames.length + (form.lastFrame ? 1 : 0);
  const maxKeyframes = options?.limits.maxKeyframes ?? 9;

  /**
   * 把一个素材放进目标槽位。图生视频：首帧 / 中间帧 / 尾帧；多模态：追加到参考列表。
   * 图生视频里连续放图（比如一次拖进来三张）时会顺着走：首帧 → 中间帧 → …，最后一张不自动当尾帧（尾帧要明确指定）。
   */
  const placeSlot = (slot: SeedanceMediaSlot & { kind: SeedanceRefKind }, target = pickTarget): string => {
    const image = { refId: slot.refId, url: slot.url, kind: "image" as const, name: slot.name };
    if (form.mode === "image") {
      if (slot.kind !== "image") {
        setNotice({ tone: "bad", text: "首帧 / 中间帧 / 尾帧只能用图片。" });
        return target;
      }
      if (target === "last") {
        patch({ lastFrame: image });
        return "last";
      }
      if (target.startsWith("middle:")) {
        const index = target === "middle:new" ? -1 : Number(target.slice(7));
        if (index >= 0 && index < form.middleFrames.length) {
          patch({ middleFrames: form.middleFrames.map((item, i) => (i === index ? image : item)) });
          return target;
        }
        if (keyframeCount >= maxKeyframes) {
          setNotice({ tone: "bad", text: `首帧 + 中间帧 + 尾帧最多 ${maxKeyframes} 张。` });
          return target;
        }
        patch({ middleFrames: [...form.middleFrames, image] });
        return "middle:new";
      }
      patch({ firstFrame: image });
      // 首帧放好了，再来的图自然是中间帧。
      return "middle:new";
    }
    if (form.mode === "omni") {
      if (!model?.omni) return target;
      const limit = slot.kind === "image" ? model.omni.images : slot.kind === "video" ? model.omni.videos : model.omni.audios;
      const current = omniCounts[slot.kind];
      if (current >= limit) {
        setNotice({ tone: "bad", text: `${model.name} 最多 ${limit} 个参考${KIND_LABEL[slot.kind]}。` });
        return target;
      }
      if (form.references.some((item) => item.refId && item.refId === slot.refId)) return target;
      patch({ references: [...form.references, slot] });
      return "omni";
    }
    setNotice({ tone: "info", text: "文生视频不需要素材；想用图片请切到「图生视频」或「多模态参考」。" });
    return target;
  };

  /**
   * 上传一批文件并依次放进槽位。上传（文件选择框 / 拖进来 / ⌘V 粘贴）都走这里。
   * 图生视频按「首帧 → 中间帧 → …」顺着放；多模态全部追加。
   * 注意连续放多张时 form 还是旧的，所以这里把 patch 后的中间帧自己攒着，最后一次写回。
   */
  const uploadFiles = async (files: File[], target = pickTarget, { keepTarget = false } = {}) => {
    const list = files.filter((file) => (form.mode === "image" ? file.type.startsWith("image/") : true));
    if (!list.length) {
      if (files.length) setNotice({ tone: "bad", text: form.mode === "image" ? "图生视频只收图片。" : "没有可用的文件。" });
      return;
    }
    setBusy("upload");
    setNotice(null);
    let nextTarget = target;
    let first = form.firstFrame;
    let last = form.lastFrame;
    let middles = [...form.middleFrames];
    let references = [...form.references];
    const uploaded: SeedanceRef[] = [];
    let failure = "";
    for (const file of list) {
      try {
        const { ref } = await uploadSeedanceRef(file);
        uploaded.push(ref);
        const slot = { refId: ref.id, kind: ref.kind, name: ref.name };
        if (form.mode === "image") {
          if (ref.kind !== "image") continue;
          const image = { refId: ref.id, kind: "image" as const, name: ref.name };
          if (nextTarget === "last") {
            last = image;
            nextTarget = "last";
          } else if (nextTarget.startsWith("middle:") && nextTarget !== "middle:new" && Number(nextTarget.slice(7)) < middles.length) {
            middles = middles.map((item, i) => (i === Number(nextTarget.slice(7)) ? image : item));
          } else if (nextTarget === "middle:new" || (nextTarget === "first" && first)) {
            if ((first ? 1 : 0) + middles.length + (last ? 1 : 0) >= maxKeyframes) {
              failure = `首帧 + 中间帧 + 尾帧最多 ${maxKeyframes} 张，多的没放进去。`;
              break;
            }
            middles = [...middles, image];
            nextTarget = "middle:new";
          } else {
            first = image;
            nextTarget = "middle:new";
          }
        } else if (form.mode === "omni") {
          if (!model?.omni) continue;
          const limit = ref.kind === "image" ? model.omni.images : ref.kind === "video" ? model.omni.videos : model.omni.audios;
          if (references.filter((item) => item.kind === ref.kind).length >= limit) {
            failure = `${model.name} 最多 ${limit} 个参考${KIND_LABEL[ref.kind]}，多的没放进去。`;
            continue;
          }
          references = [...references, slot];
        }
      } catch (error) {
        failure = error instanceof Error ? error.message : "上传失败。";
        break;
      }
    }
    if (uploaded.length) {
      setRefs((current) => [...uploaded.slice().reverse(), ...current.filter((item) => !uploaded.some((ref) => ref.id === item.id))]);
      if (form.mode === "image") patch({ firstFrame: first, lastFrame: last, middleFrames: middles });
      else if (form.mode === "omni") patch({ references });
      else setNotice({ tone: "info", text: "文生视频不需要素材；想用图片请切到「图生视频」或「多模态参考」。" });
      // 拖到某个具体槽位只填那一格，不改「接下来往哪放」；从上传按钮 / 粘贴进来的才顺着走。
      if (!keepTarget) setPickTarget(nextTarget);
    }
    if (failure) setNotice({ tone: "bad", text: failure });
    else if (uploaded.length === 1) {
      const ref = uploaded[0];
      setNotice({ tone: "good", text: `已上传 ${ref.name}${ref.width && ref.height ? `（${ref.width}×${ref.height}）` : ""}${ref.durationSeconds ? `（${ref.durationSeconds.toFixed(1)} 秒）` : ""}。` });
    } else if (uploaded.length > 1) setNotice({ tone: "good", text: `已上传 ${uploaded.length} 个文件并放进${form.mode === "image" ? "关键帧" : "参考列表"}。` });
    setBusy("");
  };

  const handleUpload = async (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []);
    event.target.value = "";
    if (!files.length) return;
    await uploadFiles(files);
  };

  /** 拖到槽位 / 参考区上放下：文件就上传，素材库的卡片就直接放。 */
  const handleDrop = (event: DragEvent<HTMLElement>, target: string) => {
    event.preventDefault();
    event.stopPropagation();
    setDropOver("");
    if (form.mode === "text") {
      setNotice({ tone: "info", text: "文生视频不需要素材；想用图片请切到「图生视频」或「多模态参考」。" });
      return;
    }
    const { files, refId } = readDrop(event);
    const specific = target === "first" || target === "last" || (target.startsWith("middle:") && target !== "middle:new");
    if (refId) {
      const ref = refs.find((item) => item.id === refId);
      if (ref) {
        const next = placeSlot({ refId: ref.id, kind: ref.kind, name: ref.name }, target);
        if (!specific) setPickTarget(next);
      }
      return;
    }
    if (files.length) void uploadFiles(files, target, { keepTarget: specific });
  };

  const dragProps = (target: string) => ({
    onDragOver: (event: DragEvent<HTMLElement>) => {
      if (!dragHasPayload(event)) return;
      event.preventDefault();
      event.stopPropagation();
      event.dataTransfer.dropEffect = "copy";
      if (dropOver !== target) setDropOver(target);
    },
    onDragLeave: (event: DragEvent<HTMLElement>) => {
      if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
      setDropOver((current) => (current === target ? "" : current));
    },
    onDrop: (event: DragEvent<HTMLElement>) => handleDrop(event, target),
  });

  // ⌘ / Ctrl + V：剪贴板里有图就直接收进当前槽位（和作图那边一样）；粘纯文字照常。
  const pasteRef = useRef<(files: File[]) => void>(() => undefined);
  pasteRef.current = (files) => {
    if (form.mode === "text" || !overview) return;
    void uploadFiles(files);
  };
  useEffect(() => {
    const handlePaste = (event: ClipboardEvent) => {
      const files = clipboardImageFiles(event.clipboardData);
      if (!files.length) return;
      if (!clipboardHasText(event.clipboardData)) event.preventDefault();
      pasteRef.current(files);
    };
    document.addEventListener("paste", handlePaste);
    return () => document.removeEventListener("paste", handlePaste);
  }, []);

  const handleAddUrl = () => {
    const url = urlDraft.trim();
    if (!url) return;
    if (!/^https?:\/\//i.test(url) && !url.startsWith("asset://")) {
      setNotice({ tone: "bad", text: "链接要以 http(s):// 开头（公网可访问），或是方舟素材库的 asset:// 编号。" });
      return;
    }
    const kind: SeedanceRefKind = form.mode === "image" ? "image" : urlKind;
    placeSlot({ url, kind, name: url });
    setUrlDraft("");
  };

  const handleDeleteRef = async (ref: SeedanceRef) => {
    setBusy(`ref:${ref.id}`);
    try {
      await deleteSeedanceRef(ref.id);
      setRefs((current) => current.filter((item) => item.id !== ref.id));
      patch({
        firstFrame: form.firstFrame?.refId === ref.id ? null : form.firstFrame,
        lastFrame: form.lastFrame?.refId === ref.id ? null : form.lastFrame,
        middleFrames: form.middleFrames.filter((item) => item.refId !== ref.id),
        references: form.references.filter((item) => item.refId !== ref.id),
      });
    } catch (error) {
      setNotice({ tone: "bad", text: error instanceof Error ? error.message : "删除素材失败。" });
    } finally {
      setBusy("");
    }
  };

  /* ── 提交 / 任务操作 ─────────────────────────────────────────────────────── */

  const submitHint = (() => {
    if (!overview) return "加载中…";
    if (!status?.configured) return "还没配置 API Key（后台 → Seedance）";
    if (!status.online) return `方舟连不上：${status.error || "离线"}`;
    if (!model) return "没有可用的模型";
    if (form.mode === "text" && !form.prompt.trim()) return "先写提示词";
    if (form.mode === "image" && !form.firstFrame) return "先选首帧图片";
    if (form.mode === "image" && form.middleFrames.length && form.keyframeStrategy === "reference" && !model.omni) return `${model.name} 不支持参考图，中间帧请改用「分段接力」`;
    if (form.mode === "image" && form.middleFrames.length && form.keyframeStrategy === "segments" && !model.lastFrame) return `${model.name} 不支持尾帧，没法分段接力`;
    if (form.mode === "omni" && !form.references.length) return "先加至少一个参考素材";
    if (form.mode === "omni" && model.omni && !model.omni.audioOnly && !omniCounts.image && !omniCounts.video) return `${model.name} 不能只给音频`;
    if ((form.omniTaskType === "edit" || form.omniTaskType === "extend") && !omniCounts.video) return "编辑 / 延长至少要一个参考视频";
    if (needsPublicMedia && !status.publicMediaReady) return "参考视频 / 音频需要本站有公网地址（后台 → Seedance → 公网地址）";
    const maxActive = options?.limits.maxActivePerUser ?? 2;
    const segmentsMode = form.mode === "image" && form.middleFrames.length > 0 && form.keyframeStrategy === "segments";
    if (segmentsMode ? arkActiveCount >= maxActive : arkActiveCount + form.count > maxActive) return `同时最多 ${maxActive} 条，现在 ${arkActiveCount} 条在跑`;
    return "";
  })();
  const submitBlocked = Boolean(submitHint) || busy === "submit";

  const handleSubmit = async () => {
    if (submitBlocked) return;
    setBusy("submit");
    setNotice(null);
    try {
      const payload: Partial<SeedanceRequest> = { ...form, frames: useFrames && model?.frames ? form.frames : null, draftTaskId: null };
      const result = await createSeedanceTasks(payload);
      setActiveCount(result.activeCount);
      setArkActiveCount(result.arkActiveCount ?? result.activeCount);
      await loadTasks(1);
      setExpandedTaskId(result.tasks[0]?.id ?? null);
      setNotice(
        result.warning
          ? { tone: "bad", text: result.warning }
          : result.group
            ? { tone: "good", text: `分段接力已建立：共 ${result.group.total} 段，超出并发的段会在本站排队依次提交，全部完成后自动拼成一条。` }
            : { tone: "good", text: `已提交 ${result.tasks.length} 条到火山方舟，排队中。` },
      );
    } catch (error) {
      setNotice({ tone: "bad", text: error instanceof Error ? error.message : "提交失败。" });
    } finally {
      setBusy("");
    }
  };

  /** 基于样片出正式版：方舟会复用样片那次的提示词 / 图 / 画幅 / 时长。 */
  const handleFinalFromDraft = async (task: SeedanceTask) => {
    if (!task.arkTaskId) return;
    setBusy(`final:${task.id}`);
    setNotice(null);
    try {
      const result = await createSeedanceTasks({ model: task.model, mode: task.mode, prompt: "", draftTaskId: task.arkTaskId, resolution: task.params.resolution === "480p" ? "720p" : task.params.resolution, draft: false, count: 1 });
      setActiveCount(result.activeCount);
      await loadTasks(1);
      setNotice({ tone: "good", text: "已基于样片提交正式版。" });
    } catch (error) {
      setNotice({ tone: "bad", text: error instanceof Error ? error.message : "提交失败。" });
    } finally {
      setBusy("");
    }
  };

  const handleDelete = async (task: SeedanceTask) => {
    const running = task.status === "running";
    if (running && !window.confirm("这条已经在生成了，火山方舟不支持中途取消，删掉本站记录后照样计费。仍然删除？")) return;
    if (!running && task.status !== "queued" && !window.confirm("删除这条任务和成片？")) return;
    setBusy(`delete:${task.id}`);
    try {
      const result = await deleteSeedanceTask(task.id, { force: running });
      setActiveCount(result.activeCount);
      await loadTasks();
    } catch (error) {
      setNotice({ tone: "bad", text: error instanceof Error ? error.message : "删除失败。" });
    } finally {
      setBusy("");
    }
  };

  /** 用上一条的尾帧当下一条的首帧——连续镜头。 */
  const handleContinueFromLastFrame = async (task: SeedanceTask) => {
    setBusy(`continue:${task.id}`);
    try {
      const { ref } = await createSeedanceLastFrameRef(task.id);
      setRefs((current) => [ref, ...current]);
      patch({ mode: "image", model: models.find((item) => item.id === task.model && item.modes.includes("image"))?.id || form.model, firstFrame: { refId: ref.id, kind: "image", name: ref.name }, lastFrame: null, middleFrames: [] });
      setPickTarget("middle:new");
      setNotice({ tone: "good", text: "已把尾帧放到首帧位置，改改提示词就能接着拍。" });
      window.scrollTo({ top: 0, behavior: "smooth" });
    } catch (error) {
      setNotice({ tone: "bad", text: error instanceof Error ? error.message : "取尾帧失败。" });
    } finally {
      setBusy("");
    }
  };

  /** 同参数再来一条：把任务的参数灌回表单。 */
  const handleReuse = (task: SeedanceTask) => {
    const params = task.params;
    patch({
      ...defaultForm,
      ...params,
      model: task.model,
      mode: task.mode,
      prompt: task.prompt,
      references: Array.isArray(params.references) ? (params.references as SeedanceRequest["references"]) : reconstructReferences(task),
      firstFrame: params.firstFrame ?? null,
      lastFrame: params.lastFrame ?? null,
      middleFrames: Array.isArray(params.middleFrames) ? params.middleFrames : [],
      keyframeStrategy: params.keyframeStrategy ?? "reference",
      count: 1,
      draftTaskId: null,
    });
    setNotice({ tone: "info", text: "参数已回填到表单。" });
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const handleTest = async () => {
    setBusy("status");
    try {
      const data = await testSeedance();
      setOverview((current) => (current ? { ...current, status: data.status } : current));
    } catch (error) {
      setNotice({ tone: "bad", text: error instanceof Error ? error.message : "探测失败。" });
    } finally {
      setBusy("");
    }
  };

  const handleArchive = async (task: SeedanceTask) => {
    setBusy(`archive:${task.id}`);
    try {
      await archiveSeedanceTask(task.id);
      await loadTasks();
      setNotice({ tone: "good", text: "已推到云盘。" });
    } catch (error) {
      setNotice({ tone: "bad", text: error instanceof Error ? error.message : "归档失败。" });
    } finally {
      setBusy("");
    }
  };

  const handleRetryMerge = async (groupId: string) => {
    setBusy(`merge:${groupId}`);
    try {
      await retrySeedanceGroupMerge(groupId);
      await loadTasks();
    } catch (error) {
      setNotice({ tone: "bad", text: error instanceof Error ? error.message : "合并失败。" });
    } finally {
      setBusy("");
    }
  };

  // 分段接力的几段是一起建的、时间相邻，同一页里按 group 聚一下，组头上放合并成片。
  const clusters = useMemo(() => {
    const list: Array<{ key: string; group: SeedanceTask["group"]; tasks: SeedanceTask[] }> = [];
    for (const task of tasks) {
      const previous = list[list.length - 1];
      if (task.group && previous?.group?.id === task.group.id) {
        previous.tasks.push(task);
        continue;
      }
      list.push({ key: task.group ? `group:${task.group.id}` : `task:${task.id}`, group: task.group, tasks: [task] });
    }
    // 组内按段号升序看更顺。
    for (const cluster of list) if (cluster.group) cluster.tasks.sort((a, b) => (a.group?.index ?? 0) - (b.group?.index ?? 0));
    return list;
  }, [tasks]);

  /* ── 渲染 ───────────────────────────────────────────────────────────────── */

  const statusTone = !overview ? "" : status?.online ? "online" : status?.configured ? "offline" : "unset";
  const statusText = !overview ? "连接中" : status?.online ? `方舟在线 · ${status.latencyMs ?? "?"} ms` : status?.configured ? "方舟离线" : "未配置 Key";
  const limits = options?.limits;
  const durationSummary = useFrames && model?.frames && form.frames ? `${form.frames} 帧（${(form.frames / 24).toFixed(2)} 秒）` : form.duration === -1 ? "智能时长" : `${form.duration} 秒`;

  return (
    <div className="shortvideo-module seedance-module" data-module="seedance">
      <header className="shortvideo-head">
        <div className="shortvideo-head-copy">
          <span className="rail-kicker">短视频 · AI 直出</span>
          <h1>
            <Sparkles size={20} aria-hidden="true" /> 一段提示词，Seedance 直接出片
          </h1>
          <p className="muted-text">
            文生视频 / 图生视频 / 多模态参考，走火山方舟。成片回传到本站保留 {limits?.retention?.outputDays ?? 3} 天（可推云盘），上传的素材 {limits?.retention?.uploadHours ?? 24} 小时后自动清理。仅开了权限的账号可见，按方舟实际用量计费。
          </p>
        </div>
        <div className="shortvideo-head-side">
          <button type="button" className={`shortvideo-engine-pill ${statusTone}`} onClick={() => void handleTest()} disabled={busy === "status"} title={status?.error || "点一下重新探测"}>
            <i aria-hidden="true" />
            {statusText}
            <RefreshCw size={12} aria-hidden="true" className={busy === "status" ? "spin" : ""} />
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
        <section className="simple-card shortvideo-form" aria-label="Seedance 参数">
          {/* 1. 方式与模型 */}
          <div className="shortvideo-block">
            <div className="shortvideo-block-head">
              <span className="rail-kicker">1 · 方式与模型</span>
            </div>
            <div className="chip-group" role="radiogroup" aria-label="生成方式">
              {(options?.modes ?? []).map((item) => (
                <button type="button" key={item.id} role="radio" aria-checked={form.mode === item.id} className={form.mode === item.id ? "chip selected" : "chip"} title={item.hint} onClick={() => patch({ mode: item.id as SeedanceMode })}>
                  {item.label}
                </button>
              ))}
            </div>
            <p className="field-hint">{options?.modes.find((item) => item.id === form.mode)?.hint}</p>
            <label className="field">
              <span>模型</span>
              <div className="shortvideo-select wide">
                <select value={model?.id ?? ""} onChange={(event) => patch({ model: event.target.value })} aria-label="模型">
                  {(modelsForMode.length ? modelsForMode : models).map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name}
                      {item.status === "retiring" ? "（退役中）" : ""} — {item.blurb}
                    </option>
                  ))}
                </select>
              </div>
            </label>
            {model ? (
              <p className="field-hint seedance-model-hint">
                <code>{model.id}</code> · {model.duration.min}–{model.duration.max} 秒{model.duration.smart ? "（可智能）" : ""} · 最高 {model.resolutions[model.resolutions.length - 1]} · {model.audio ? "可出有声" : "无声"}
                {model.omni ? ` · 参考图 ${model.omni.images} / 视频 ${model.omni.videos} / 音频 ${model.omni.audios}` : ""}
                {model.priceHint ? ` · ${model.priceHint}` : ""}
              </p>
            ) : null}
          </div>

          {/* 2. 提示词 */}
          <div className="shortvideo-block shortvideo-script">
            <div className="shortvideo-block-head">
              <span className="rail-kicker">2 · 提示词{form.mode === "text" ? "" : "（可选）"}</span>
              <small className="muted-text">
                {form.prompt.length}/{limits?.maxPromptChars ?? 3000}
              </small>
            </div>
            <textarea
              rows={5}
              value={form.prompt}
              maxLength={limits?.maxPromptChars ?? 3000}
              placeholder={
                form.mode === "omni"
                  ? "例：参考@图像1 的产品和配色，镜头像@视频1 那样缓慢推进，配上@音频1 的节奏……"
                  : form.mode === "image"
                    ? "例：让画面里的模特转身走向镜头，裙摆随风飘起，柔和的午后光。"
                    : "例：一位穿米白色亚麻长裙的模特走在清晨的老城石板路上，镜头缓慢跟拍，胶片质感。"
              }
              onChange={(event) => patch({ prompt: event.target.value })}
            />
            <p className="field-hint">
              中文别超过 500 字、英文别超过 1000 词，写多了模型反而抓不住重点。
              {form.mode === "omni" ? " 多模态参考用 @图像1、@视频1、@音频1 按添加顺序引用素材。" : ""}
              {model?.audio && form.generateAudio ? " 想让角色说话，把台词放进双引号。" : ""}
            </p>
          </div>

          {/* 3. 素材 */}
          {form.mode !== "text" ? (
            <div className="shortvideo-block">
              <div className="shortvideo-block-head">
                <span className="rail-kicker">3 · 素材</span>
                {form.mode === "omni" && model?.omni ? (
                  <small className="muted-text">
                    图 {omniCounts.image}/{model.omni.images} · 视频 {omniCounts.video}/{model.omni.videos} · 音频 {omniCounts.audio}/{model.omni.audios}
                  </small>
                ) : null}
              </div>

              {form.mode === "image" ? (
                <>
                  <div className={`seedance-slots ${dropOver === "middle:new" ? "drop-active" : ""}`} {...dragProps("middle:new")}>
                    <SlotCard
                      title="首帧"
                      required
                      slot={form.firstFrame}
                      refs={refs}
                      active={pickTarget === "first"}
                      dropActive={dropOver === "first"}
                      onPick={() => setPickTarget("first")}
                      onClear={() => patch({ firstFrame: null })}
                      dragProps={dragProps("first")}
                    />
                    {form.middleFrames.map((frame, index) => (
                      <SlotCard
                        key={`${frame.refId || frame.url}-${index}`}
                        title={`中间帧 ${index + 1}`}
                        slot={frame}
                        refs={refs}
                        active={pickTarget === `middle:${index}`}
                        dropActive={dropOver === `middle:${index}`}
                        onPick={() => setPickTarget(`middle:${index}`)}
                        onClear={() => patch({ middleFrames: form.middleFrames.filter((_, i) => i !== index) })}
                        dragProps={dragProps(`middle:${index}`)}
                      />
                    ))}
                    {keyframeCount < maxKeyframes && (model?.omni || model?.lastFrame) ? (
                      <button
                        type="button"
                        className={`seedance-slot seedance-slot-add ${pickTarget === "middle:new" ? "active" : ""} ${dropOver === "middle:new" ? "drop-active" : ""}`}
                        onClick={() => setPickTarget("middle:new")}
                        aria-pressed={pickTarget === "middle:new"}
                        title="接下来上传 / 拖进来 / 粘贴的图片按顺序当中间帧"
                        {...dragProps("middle:new")}
                      >
                        <Plus size={18} aria-hidden="true" />
                        <span>
                          <strong>加中间帧</strong>
                          <small>{pickTarget === "middle:new" ? "待放入：上传、拖进来或 ⌘V" : "点一下选中"}</small>
                        </span>
                      </button>
                    ) : null}
                    {model?.lastFrame ? (
                      <SlotCard
                        title="尾帧（可选）"
                        slot={form.lastFrame}
                        refs={refs}
                        active={pickTarget === "last"}
                        dropActive={dropOver === "last"}
                        onPick={() => setPickTarget("last")}
                        onClear={() => patch({ lastFrame: null })}
                        dragProps={dragProps("last")}
                      />
                    ) : null}
                  </div>
                  {form.middleFrames.length ? (
                    <div className="seedance-keyframe-strategy">
                      <span className="field-label">中间帧怎么落地</span>
                      <div className="chip-group" role="radiogroup" aria-label="中间帧方式">
                        {(options?.keyframeStrategies ?? []).map((item) => {
                          const disabled = item.id === "reference" ? !model?.omni : !model?.lastFrame;
                          return (
                            <button
                              type="button"
                              key={item.id}
                              role="radio"
                              aria-checked={form.keyframeStrategy === item.id}
                              className={form.keyframeStrategy === item.id ? "chip selected" : "chip"}
                              disabled={disabled}
                              title={disabled ? (item.id === "reference" ? "只有 Seedance 2.x 支持参考图" : "这个模型不支持尾帧") : item.hint}
                              onClick={() => patch({ keyframeStrategy: item.id as "reference" | "segments" })}
                            >
                              {item.label}
                            </button>
                          );
                        })}
                      </div>
                      <p className="field-hint">
                        {form.keyframeStrategy === "segments"
                          ? `分段接力：${keyframeCount} 张关键帧 → ${form.lastFrame ? keyframeCount - 1 : keyframeCount} 段首尾帧视频，按段计费；超出并发的段在本站排队依次提交，全部完成后自动拼成一条（各段也能单独下载）。`
                          : "一镜到底：所有关键帧当参考图交给 2.x，一条任务出一段连续视频；首尾帧大体一致、中间帧是「经过」的画面，没有分段那么严格，但只按一条计费。"}
                      </p>
                    </div>
                  ) : null}
                </>
              ) : null}

              {form.mode === "omni" ? (
                <ol className={`seedance-ref-list ${dropOver === "omni" ? "drop-active" : ""}`} {...dragProps("omni")}>
                  {form.references.length === 0 ? <li className="field-hint">还没加参考素材。上传、拖进来、⌘V 粘贴，或从素材库选、粘贴公网链接。</li> : null}
                  {form.references.map((item, index) => {
                    const Icon = KIND_ICON[item.kind];
                    const ordinal = form.references.slice(0, index + 1).filter((other) => other.kind === item.kind).length;
                    const preview = slotPreview(item, refs);
                    return (
                      <li key={`${item.refId || item.url}-${index}`} className="seedance-ref-item">
                        {preview ? <img src={preview} alt="" /> : <Icon size={16} aria-hidden="true" />}
                        <span>
                          <strong>
                            @{KIND_LABEL[item.kind] === "图片" ? "图像" : KIND_LABEL[item.kind]}
                            {ordinal}
                          </strong>
                          <small>{slotLabel(item, refs)}</small>
                        </span>
                        <button type="button" className="text-button" onClick={() => patch({ references: form.references.filter((_, i) => i !== index) })}>
                          移除
                        </button>
                      </li>
                    );
                  })}
                </ol>
              ) : null}

              <div className="seedance-add-row">
                <input ref={fileInputRef} type="file" hidden multiple accept={form.mode === "image" ? "image/*" : "image/*,video/mp4,video/quicktime,audio/mpeg,audio/wav"} onChange={(event) => void handleUpload(event)} />
                <Button variant="secondary" icon={<Upload size={14} />} onClick={() => fileInputRef.current?.click()} disabled={busy === "upload"}>
                  {busy === "upload" ? "上传中…" : form.mode === "image" ? `上传图片到${targetLabel(pickTarget)}` : "上传图片 / 视频 / 音频"}
                </Button>
                <div className="seedance-url-row">
                  {form.mode === "omni" ? (
                    <select value={urlKind} onChange={(event) => setUrlKind(event.target.value as SeedanceRefKind)} aria-label="链接类型">
                      <option value="image">图片链接</option>
                      <option value="video">视频链接</option>
                      <option value="audio">音频链接</option>
                    </select>
                  ) : null}
                  <input
                    type="url"
                    value={urlDraft}
                    placeholder="或粘贴公网链接 / asset:// 素材 ID"
                    onChange={(event) => setUrlDraft(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault();
                        handleAddUrl();
                      }
                    }}
                  />
                  <button type="button" className="text-button" onClick={handleAddUrl} disabled={!urlDraft.trim()}>
                    <Link2 size={13} aria-hidden="true" /> 加入
                  </button>
                </div>
              </div>

              {refs.length ? (
                <details className="seedance-library">
                  <summary>
                    最近上传（{refs.length}）· 点一下或拖到槽位放进{form.mode === "image" ? targetLabel(pickTarget) : "参考列表"} · 上传 {limits?.retention?.uploadHours ?? 24} 小时后自动清理
                  </summary>
                  <div className="seedance-ref-grid">
                    {refs.map((ref) => {
                      const Icon = KIND_ICON[ref.kind];
                      const inUse = form.firstFrame?.refId === ref.id || form.lastFrame?.refId === ref.id || form.middleFrames.some((item) => item.refId === ref.id) || form.references.some((item) => item.refId === ref.id);
                      const expiresAt = new Date(Date.parse(ref.createdAt) + (limits?.retention?.uploadHours ?? 24) * 3600000).toISOString();
                      return (
                        <div key={ref.id} className={`seedance-ref-card ${inUse ? "in-use" : ""}`}>
                          <button
                            type="button"
                            className="seedance-ref-thumb"
                            title={`${ref.name} · 点一下放入，或拖到槽位`}
                            draggable
                            onDragStart={(event) => {
                              event.dataTransfer.setData(REF_DRAG_TYPE, ref.id);
                              event.dataTransfer.effectAllowed = "copy";
                            }}
                            onClick={() => setPickTarget(placeSlot({ refId: ref.id, kind: ref.kind, name: ref.name }))}
                          >
                            {ref.kind === "image" ? <img src={ref.url} alt={ref.name} loading="lazy" /> : <Icon size={22} aria-hidden="true" />}
                          </button>
                          <span className="seedance-ref-meta" title={ref.name}>
                            {ref.name}
                            <small>
                              {ref.width && ref.height ? `${ref.width}×${ref.height} · ` : ""}
                              {ref.durationSeconds ? `${ref.durationSeconds.toFixed(1)}s · ` : ""}
                              {formatBytes(ref.bytes)} · {formatRemaining(expiresAt, now)}
                            </small>
                          </span>
                          <button type="button" className="text-button danger" onClick={() => void handleDeleteRef(ref)} disabled={busy === `ref:${ref.id}`} aria-label={`删除 ${ref.name}`}>
                            <Trash2 size={12} aria-hidden="true" />
                          </button>
                        </div>
                      );
                    })}
                  </div>
                </details>
              ) : null}

              <p className="field-hint">
                图片 300–6000 px、宽高比 0.4–2.5、≤ 30 MB；视频 mp4 / mov、2–30 秒、≥ 24 fps、≤ 200 MB；音频 mp3 / wav、2–30 秒、≤ 15 MB。2.x 不接受含真人人脸的参考图 / 视频。
                {needsPublicMedia && status && !status.publicMediaReady ? " 参考视频 / 音频要靠公网地址交给方舟，本站还没配公网地址。" : ""}
              </p>
            </div>
          ) : null}

          {/* 4. 输出 */}
          <div className="shortvideo-block">
            <div className="shortvideo-block-head">
              <span className="rail-kicker">{form.mode !== "text" ? "4" : "3"} · 输出</span>
            </div>
            <div className="shortvideo-row">
              <div className="simple-control">
                <span className="field-label">画幅{ratioLocked ? "（这种任务由模型跟随素材，不可选）" : ""}</span>
                <div className="chip-group shortvideo-aspects" role="radiogroup" aria-label="画幅">
                  {ratioChoices.map((item) => (
                    <button
                      type="button"
                      key={item.id}
                      role="radio"
                      aria-checked={form.ratio === item.id}
                      className={form.ratio === item.id ? "chip selected" : "chip"}
                      title={item.hint}
                      disabled={ratioLocked && item.id !== "adaptive"}
                      onClick={() => patch({ ratio: item.id })}
                    >
                      <RatioGlyph option={item} /> {item.label}
                    </button>
                  ))}
                </div>
              </div>
            </div>
            <div className="shortvideo-row">
              <div className="simple-control">
                <span className="field-label">分辨率</span>
                <ChipGroup options={resolutionChoices.map((item) => ({ id: item.id, label: item.label, hint: item.hint }))} value={form.resolution} onChange={(id) => patch({ resolution: id, draft: id !== "480p" ? false : form.draft })} ariaLabel="分辨率" size="sm" />
              </div>
              <div className="simple-control">
                <span className="field-label">时长</span>
                {useFrames && model?.frames ? (
                  <div className="seedance-frames">
                    <NumberStepper value={form.frames ?? 121} min={limits?.frames[0] ?? 29} max={limits?.frames[1] ?? 289} step={4} onChange={(value) => patch({ frames: value })} ariaLabel="帧数" />
                    <small className="muted-text">帧 ≈ {((form.frames ?? 121) / 24).toFixed(2)} 秒（24 fps，需满足 25+4n）</small>
                  </div>
                ) : (
                  <div className="seedance-duration">
                    <NumberStepper value={form.duration === -1 ? model?.duration.min ?? 4 : form.duration} min={model?.duration.min ?? 2} max={model?.duration.max ?? 12} onChange={(value) => patch({ duration: value })} ariaLabel="时长（秒）" />
                    <small className="muted-text">秒</small>
                    {model?.duration.smart ? (
                      <button type="button" className={form.duration === -1 ? "chip selected" : "chip"} onClick={() => patch({ duration: form.duration === -1 ? Math.min(Math.max(5, model.duration.min), model.duration.max) : -1 })} title="让模型按内容自己定长度（费用按实际时长算）">
                        智能时长
                      </button>
                    ) : null}
                  </div>
                )}
              </div>
            </div>
            {model?.frames ? (
              <label className="shortvideo-check">
                <input type="checkbox" checked={useFrames} onChange={(event) => setUseFrames(event.target.checked)} />
                <span>
                  <strong>按帧数指定（出小数秒）</strong>
                  <small>1.0 系列专属：帧数 = 时长 × 24，只能取 29–289 里满足 25+4n 的值。</small>
                </span>
              </label>
            ) : null}
            {model?.audio ? (
              <label className="shortvideo-check">
                <input type="checkbox" checked={form.generateAudio} onChange={(event) => patch({ generateAudio: event.target.checked })} />
                <span>
                  <strong>生成有声视频</strong>
                  <small>模型按画面和提示词配人声、音效、背景音乐（单声道）。关掉就是无声片。</small>
                </span>
              </label>
            ) : null}
          </div>

          {/* 高级参数：默认收起 */}
          <div className="shortvideo-block seedance-advanced">
            <button type="button" className="seedance-advanced-toggle" aria-expanded={showAdvanced} onClick={() => setShowAdvanced(!showAdvanced)}>
              <span className="rail-kicker">高级参数</span>
              <small className="muted-text">{showAdvanced ? "收起" : "展开 · 种子 / 镜头 / 水印 / 尾帧 / 格式 / 优先级 / 样片 / 联网 / 超时 / 条数"}</small>
            </button>
            {showAdvanced && model ? (
              <div className="seedance-advanced-body">
                <div className="shortvideo-row">
                  {model.seed ? (
                    <label className="field">
                      <span>随机种子（-1 = 随机）</span>
                      <input type="number" min={-1} max={limits?.seedMax ?? 2147483647} value={form.seed} onChange={(event) => patch({ seed: Math.max(-1, Math.round(Number(event.target.value) || -1)) })} />
                    </label>
                  ) : null}
                  {model.outputFormats.length > 1 ? (
                    <div className="simple-control">
                      <span className="field-label">输出格式</span>
                      <ChipGroup options={(options?.outputFormats ?? []).filter((item) => model.outputFormats.includes(item.id))} value={form.outputFormat} onChange={(id) => patch({ outputFormat: id })} ariaLabel="输出格式" size="sm" />
                    </div>
                  ) : null}
                  {model.serviceTiers.includes("flex") ? (
                    <div className="simple-control">
                      <span className="field-label">服务等级</span>
                      <ChipGroup options={(options?.serviceTiers ?? []).filter((item) => model.serviceTiers.includes(item.id))} value={form.serviceTier} onChange={(id) => patch({ serviceTier: id })} ariaLabel="服务等级" size="sm" />
                    </div>
                  ) : null}
                  {model.priority && form.serviceTier !== "flex" ? (
                    <div className="simple-control">
                      <span className="field-label">优先级（0–9，越大越先跑）</span>
                      <NumberStepper value={form.priority} min={0} max={9} onChange={(value) => patch({ priority: value })} ariaLabel="优先级" />
                    </div>
                  ) : null}
                  {model.omniTaskType && form.mode === "omni" ? (
                    <div className="simple-control">
                      <span className="field-label">任务类型</span>
                      <ChipGroup options={options?.omniTaskTypes ?? []} value={form.omniTaskType} onChange={(id) => patch({ omniTaskType: id })} ariaLabel="任务类型" size="sm" />
                    </div>
                  ) : null}
                  <label className="field">
                    <span>任务超时</span>
                    <div className="shortvideo-select">
                      <select value={String(form.expiresAfter)} onChange={(event) => patch({ expiresAfter: Number(event.target.value) })} aria-label="任务超时">
                        {EXPIRES_CHOICES.map((item) => (
                          <option key={item.id} value={item.id}>
                            {item.label}
                          </option>
                        ))}
                      </select>
                    </div>
                  </label>
                  {!(form.mode === "image" && form.middleFrames.length && form.keyframeStrategy === "segments") ? (
                    <div className="simple-control">
                      <span className="field-label">一次提交几条</span>
                      <NumberStepper value={form.count} min={1} max={limits?.maxCount ?? 4} onChange={(value) => patch({ count: value })} ariaLabel="条数" />
                    </div>
                  ) : null}
                </div>
                <div className="seedance-checks">
                  {model.cameraFixed && form.mode !== "omni" ? (
                    <label className="shortvideo-check">
                      <input type="checkbox" checked={form.cameraFixed} onChange={(event) => patch({ cameraFixed: event.target.checked })} />
                      <span>
                        <strong>固定镜头</strong>
                        <small>在提示词里追加「固定摄像头」，效果不保证。</small>
                      </span>
                    </label>
                  ) : null}
                  <label className="shortvideo-check">
                    <input type="checkbox" checked={form.watermark} onChange={(event) => patch({ watermark: event.target.checked })} />
                    <span>
                      <strong>加「AI 生成」水印</strong>
                      <small>右下角。默认不加。</small>
                    </span>
                  </label>
                  <label className="shortvideo-check">
                    <input type="checkbox" checked={form.returnLastFrame} disabled={form.draft} onChange={(event) => patch({ returnLastFrame: event.target.checked })} />
                    <span>
                      <strong>返回尾帧图</strong>
                      <small>拿到成片最后一帧（无水印 PNG），下一条直接当首帧接着拍。{form.draft ? " 样片模式下不可用。" : ""}</small>
                    </span>
                  </label>
                  {model.draft ? (
                    <label className="shortvideo-check">
                      <input type="checkbox" checked={form.draft} onChange={(event) => patch({ draft: event.target.checked, resolution: event.target.checked ? "480p" : form.resolution })} />
                      <span>
                        <strong>样片模式（便宜）</strong>
                        <small>先出 480p 预览看构图和动作，满意了再在任务卡上点「出正式版」。</small>
                      </span>
                    </label>
                  ) : null}
                  {model.webSearch ? (
                    <label className="shortvideo-check">
                      <input type="checkbox" checked={form.webSearch} onChange={(event) => patch({ webSearch: event.target.checked })} />
                      <span>
                        <strong>允许联网搜索</strong>
                        <small>模型自己判断要不要查网上的信息（商品、天气等），会慢一点。</small>
                      </span>
                    </label>
                  ) : null}
                </div>
              </div>
            ) : null}
          </div>

          <div className="simple-submit shortvideo-submit">
            <div className="simple-submit-status seedance-submit-status">
              <small className="muted-text">
                {model?.name} · {ratioChoices.find((item) => item.id === form.ratio)?.label || form.ratio} · {form.resolution} · {durationSummary}
                {model?.audio ? (form.generateAudio ? " · 有声" : " · 无声") : ""}
                {form.draft ? " · 样片" : ""}
                {form.mode === "image" && form.middleFrames.length ? (form.keyframeStrategy === "segments" ? ` · 分段接力 ${form.lastFrame ? keyframeCount - 1 : keyframeCount} 段` : ` · ${keyframeCount} 张关键帧一镜到底`) : ""}
                {form.count > 1 ? ` · ×${form.count}` : ""}
              </small>
              <span className={`prompt-status ${submitBlocked && busy !== "submit" ? "blocked" : ""}`} aria-live="polite">
                {submitHint}
              </span>
            </div>
            <Button variant="primary" icon={<Clapperboard size={15} />} onClick={() => void handleSubmit()} disabled={submitBlocked}>
              {busy === "submit" ? "提交中…" : form.mode === "image" && form.middleFrames.length && form.keyframeStrategy === "segments" ? `分段生成 ${form.lastFrame ? keyframeCount - 1 : keyframeCount} 段` : form.count > 1 ? `生成 ${form.count} 条` : "生成视频"}
            </Button>
          </div>
        </section>

        <section className="shortvideo-tasks" aria-label="Seedance 任务">
          <header className="simple-card-head">
            <h2>任务</h2>
            <span className="muted-text">
              {activeCount ? `${activeCount} 条在跑 · ` : ""}
              {taskPage?.total ?? tasks.length} 条
            </span>
          </header>
          {tasks.length === 0 ? (
            <p className="shortvideo-empty">
              <Sparkles size={26} aria-hidden="true" />
              还没有任务。左边写好提示词，点「生成视频」。
            </p>
          ) : null}
          {clusters.map((cluster) => (
            <div key={cluster.key} className={cluster.group ? `seedance-group ${cluster.group.status}` : "seedance-cluster"}>
              {cluster.group ? (
                <header className="seedance-group-head">
                  <span className="seedance-group-title">
                    <Film size={14} aria-hidden="true" />
                    <strong>分段接力 · {cluster.group.total} 段</strong>
                    <small>
                      {cluster.group.status === "merged"
                        ? "已拼成一条"
                        : cluster.group.status === "merging"
                          ? "正在合并…"
                          : cluster.group.status === "partial"
                            ? `有 ${cluster.group.failed} 段没成功`
                            : cluster.group.status === "failed"
                              ? "合并失败"
                              : `已完成 ${cluster.group.completed}/${cluster.group.total}`}
                      {cluster.group.error ? ` · ${cluster.group.error}` : ""}
                    </small>
                  </span>
                  <span className="seedance-group-actions">
                    {cluster.group.merged ? (
                      <>
                        <a className="text-button" href={cluster.group.merged.url} target="_blank" rel="noreferrer">
                          播放整条{cluster.group.merged.durationSeconds ? `（${Math.round(cluster.group.merged.durationSeconds)}s）` : ""}
                        </a>
                        <a className="text-button" href={`${cluster.group.merged.url}?download`}>
                          <Download size={13} aria-hidden="true" /> 下载整条 · {formatBytes(cluster.group.merged.bytes)}
                        </a>
                      </>
                    ) : null}
                    {cluster.group.mergedExpiredAt ? <small className="muted-text">合并成片已到期清理</small> : null}
                    {cluster.group.status === "failed" ? (
                      <button type="button" className="text-button" onClick={() => void handleRetryMerge(cluster.group!.id)} disabled={busy === `merge:${cluster.group.id}`}>
                        {busy === `merge:${cluster.group.id}` ? "合并中…" : "再试一次合并"}
                      </button>
                    ) : null}
                  </span>
                </header>
              ) : null}
              {cluster.group?.merged && cluster.group.status === "merged" ? (
                <figure className="shortvideo-video seedance-merged">
                  <video controls preload="metadata" src={cluster.group.merged.url} playsInline />
                </figure>
              ) : null}
              {cluster.tasks.map((task) => {
            const expanded = expandedTaskId === task.id || (expandedTaskId === null && tasks[0]?.id === task.id);
            const ratio = task.result.ratio || (task.params.ratio !== "adaptive" ? task.params.ratio : "") || "";
            const [rw, rh] = ratio.split(":").map(Number);
            const duration = taskDurationLabel({ startedAt: task.createdAt, finishedAt: task.finishedAt, running: isActive(task), now });
            const modeLabel = options?.modes.find((item) => item.id === task.mode)?.label || task.mode;
            return (
              <article key={task.id} className={`shortvideo-task seedance-task ${task.status}`}>
                <button type="button" className="shortvideo-task-head" onClick={() => setExpandedTaskId(expanded ? "" : task.id)} aria-expanded={expanded}>
                  <span className="shortvideo-task-title">
                    <strong>
                      {task.group ? `第 ${task.group.index} 段 · ` : ""}
                      {task.prompt ? task.prompt.slice(0, 60) : task.params.draftTaskId ? "样片出正式版" : `（${modeLabel}，无提示词）`}
                    </strong>
                    <small>
                      {formatTime(task.createdAt)} · {task.modelName} · {modeLabel}
                      {task.params.resolution ? ` · ${task.params.resolution}` : ""}
                      {task.result.duration ? ` · ${task.result.duration}s` : task.params.duration && task.params.duration > 0 ? ` · ${task.params.duration}s` : ""}
                      {duration ? ` · ${duration}` : ""}
                    </small>
                  </span>
                  <span className={`shortvideo-status ${task.status === "expired" || task.status === "cancelled" ? "failed" : task.status}`}>{task.statusLabel}</span>
                </button>
                {isActive(task) ? <div className="progress-track seedance-progress" aria-hidden="true"><span /></div> : null}
                {task.status === "failed" || task.status === "expired" || task.status === "cancelled" ? (
                  <p className="shortvideo-task-error">
                    {task.error || "生成失败。"}
                    {task.result.remoteVideoUrl ? (
                      <>
                        {" "}
                        <a href={task.result.remoteVideoUrl} target="_blank" rel="noreferrer">
                          方舟远端地址（24 小时内有效）
                        </a>
                      </>
                    ) : null}
                  </p>
                ) : null}
                {expanded && task.status === "completed" && !task.result.video && task.storage?.expiredAt ? (
                  <p className="shortvideo-task-error">
                    成片在服务器上只保留 {task.storage.retentionDays} 天，已于 {formatTime(task.storage.expiredAt)} 清理。
                    {task.storage.archivePath ? ` 云盘里还有一份：${task.storage.archivePath}` : " 没有推过云盘，这条只剩参数记录。"}
                  </p>
                ) : null}
                {expanded && task.status === "completed" && task.result.video ? (
                  <div className="shortvideo-task-body">
                    <div className="shortvideo-videos">
                      <figure className="shortvideo-video">
                        <video controls preload="metadata" src={task.result.video.url} playsInline style={{ aspectRatio: rw && rh ? `${rw} / ${rh}` : undefined }} />
                        <figcaption>
                          <span>
                            {task.result.resolution || ""}
                            {task.result.ratio ? ` · ${task.result.ratio}` : ""}
                            {task.result.duration ? ` · ${task.result.duration}s` : ""}
                            {task.result.generateAudio ? " · 有声" : ""}
                            {task.result.outputFormat === "mov" ? " · MOV" : ""} · {formatBytes(task.result.video.bytes)}
                          </span>
                          <a className="text-button" href={`${task.result.video.url}?download`}>
                            <Download size={13} aria-hidden="true" /> 下载
                          </a>
                        </figcaption>
                      </figure>
                      {task.result.lastFrame ? (
                        <figure className="shortvideo-video seedance-last-frame">
                          <img src={task.result.lastFrame.url} alt="尾帧" />
                          <figcaption>
                            <span>尾帧</span>
                            <a className="text-button" href={`${task.result.lastFrame.url}?download`}>
                              <Download size={13} aria-hidden="true" /> PNG
                            </a>
                          </figcaption>
                        </figure>
                      ) : null}
                    </div>
                    {task.result.outputFormat === "mov" || task.result.resolution === "4k" || (task.result.resolution === "1080p" && task.model.includes("2-5")) ? (
                      <p className="field-hint">这条是 10bit / H.265 或 MOV 编码，浏览器可能放不了——下载后用 VLC / QuickTime 看。</p>
                    ) : null}
                    <p className="field-hint seedance-storage-line">
                      {task.storage?.status === "webdav" && task.storage.archivePath ? `已推云盘：${task.storage.archivePath} · ` : ""}
                      服务器保留 {task.storage?.retentionDays ?? 3} 天{task.storage?.expiresAt ? `（${formatRemaining(task.storage.expiresAt, now)}）` : ""}，到期自动清理；要留底请下载或推云盘。
                    </p>
                    <details className="shortvideo-script-details">
                      <summary>参数与用量</summary>
                      <p>{task.prompt || "（无提示词）"}</p>
                      <small>
                        模型 {task.result.arkModel || task.model}
                        {task.result.seed !== null && task.result.seed !== undefined ? ` · 种子 ${task.result.seed}` : ""}
                        {task.result.fps ? ` · ${task.result.fps} fps` : ""}
                        {task.result.usage ? ` · 用量 ${task.result.usage.completionTokens.toLocaleString()} tokens` : ""}
                        {task.result.usage?.webSearch ? ` · 联网 ${task.result.usage.webSearch} 次` : ""}
                        {task.result.draft ? " · 样片" : ""}
                        {task.arkTaskId ? ` · 方舟任务 ${task.arkTaskId}` : ""}
                      </small>
                      {task.content.filter((item) => item.type !== "text").length ? (
                        <small>素材：{task.content.filter((item) => item.type !== "text").map((item) => `${item.role || item.type}${item.name ? `（${item.name}）` : item.url ? `（${item.url.slice(0, 40)}）` : ""}`).join("、")}</small>
                      ) : null}
                    </details>
                  </div>
                ) : null}
                {expanded && !isActive(task) ? (
                  <div className="shortvideo-task-actions">
                    <button type="button" className="text-button" onClick={() => handleReuse(task)}>
                      同参数再来一条
                    </button>
                    {task.status === "completed" && task.result.lastFrame ? (
                      <button type="button" className="text-button" onClick={() => void handleContinueFromLastFrame(task)} disabled={busy === `continue:${task.id}`}>
                        用尾帧接着拍
                      </button>
                    ) : null}
                    {task.status === "completed" && task.result.draft && task.arkTaskId ? (
                      <button type="button" className="text-button" onClick={() => void handleFinalFromDraft(task)} disabled={busy === `final:${task.id}`}>
                        {busy === `final:${task.id}` ? "提交中…" : "基于样片出正式版"}
                      </button>
                    ) : null}
                    {task.status === "completed" && task.result.video && task.storage?.status !== "webdav" ? (
                      <button type="button" className="text-button" onClick={() => void handleArchive(task)} disabled={busy === `archive:${task.id}`} title="推到文件管理里配的 WebDAV 云盘">
                        <CloudUpload size={13} aria-hidden="true" /> {busy === `archive:${task.id}` ? "推送中…" : "推到云盘"}
                      </button>
                    ) : null}
                    <button type="button" className="text-button danger" onClick={() => void handleDelete(task)} disabled={busy === `delete:${task.id}`}>
                      <Trash2 size={13} aria-hidden="true" /> 删除
                    </button>
                  </div>
                ) : null}
                {expanded && isActive(task) ? (
                  <div className="shortvideo-task-actions">
                    <small className="muted-text">{task.pendingSubmit ? "在本站排队，等前面的段腾出并发就自动提交到方舟。" : task.status === "queued" ? "在方舟排队。" : "方舟正在生成，通常 1–5 分钟；不支持中途取消。"}</small>
                    <button type="button" className="text-button danger" onClick={() => void handleDelete(task)} disabled={busy === `delete:${task.id}`}>
                      <Trash2 size={13} aria-hidden="true" /> {task.status === "queued" ? "取消" : "删除记录"}
                    </button>
                  </div>
                ) : null}
              </article>
            );
              })}
            </div>
          ))}
          {taskPage ? <Pager page={taskPage.page} pageCount={taskPage.pageCount} total={taskPage.total} onChange={(page) => void loadTasks(page).catch(() => undefined)} /> : null}
        </section>
      </div>
    </div>
  );
}

/** 任务参数里没存 references 的老记录，从 content 清单反推一份。 */
function reconstructReferences(task: SeedanceTask): SeedanceRequest["references"] {
  return task.content
    .filter((item) => item.role === "reference_image" || item.role === "reference_video" || item.role === "reference_audio")
    .map((item) => ({
      kind: (item.role === "reference_image" ? "image" : item.role === "reference_video" ? "video" : "audio") as SeedanceRefKind,
      refId: item.refId || undefined,
      url: item.url || undefined,
      name: item.name || null,
    }));
}

function SlotCard({
  title,
  required = false,
  slot,
  refs,
  active,
  dropActive = false,
  onPick,
  onClear,
  dragProps,
}: {
  title: string;
  required?: boolean;
  slot: SeedanceMediaSlot | null;
  refs: SeedanceRef[];
  active: boolean;
  dropActive?: boolean;
  onPick: () => void;
  onClear: () => void;
  dragProps?: Record<string, unknown>;
}) {
  const preview = slotPreview(slot, refs);
  return (
    <div className={`seedance-slot ${active ? "active" : ""} ${slot ? "filled" : ""} ${dropActive ? "drop-active" : ""}`} {...(dragProps ?? {})}>
      <button type="button" className="seedance-slot-body" onClick={onPick} aria-pressed={active} title={active ? "接下来上传 / 拖进来 / ⌘V 粘贴的图片会放到这里" : "点一下选中；也可以直接把图片拖到这里"}>
        {preview ? <img src={preview} alt={title} /> : <ImageIcon size={22} aria-hidden="true" />}
        <span>
          <strong>
            {title}
            {required ? " *" : ""}
          </strong>
          <small>{slot ? slotLabel(slot, refs) : dropActive ? "松手放入" : active ? "待放入：上传、拖进来或 ⌘V" : "点一下选中，或拖图进来"}</small>
        </span>
      </button>
      {slot ? (
        <button type="button" className="text-button" onClick={onClear}>
          清除
        </button>
      ) : null}
    </div>
  );
}
