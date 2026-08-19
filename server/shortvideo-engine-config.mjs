import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

/**
 * 直接读写引擎（MoneyPrinterTurbo）的 config.toml。
 *
 * 引擎自己没有配置接口：`app/config/config.py` 在进程启动时 `load_config()` 一次，
 * 之后只有它的 Streamlit 页面会写文件。我们不用它的页面（风格、账号体系都不一样），
 * 所以素材库 Key、字幕方案、并发这些只能改文件——本站后台改完再重启引擎。
 *
 * 两个安全考虑：
 * - 只认白名单里的键，别的一律不动，也不做整份 TOML 的序列化（那会把注释全丢掉）；
 *   这里按「节 + 行」定点替换，文件里的注释和排版原样保留。
 * - Key 一律不回传明文，只回「配好了没有」和脱敏提示。
 */

/** 没配就说明这台机器上没有引擎源码（例如开发机），后台相应地显示成只读。 */
export function engineConfigPath() {
  return String(process.env.SHORTVIDEO_ENGINE_CONFIG || "").trim();
}

export function engineConfigEditable() {
  return Boolean(engineConfigPath());
}

/** 例如 `systemctl restart mpt-api`；不配就只提示「改完要手动重启引擎」。 */
function restartArgv() {
  const raw = String(process.env.SHORTVIDEO_ENGINE_RESTART_CMD || "").trim();
  if (!raw) return null;
  const argv = raw.split(/\s+/).filter(Boolean);
  return argv.length ? argv : null;
}

export function engineRestartAvailable() {
  return Boolean(restartArgv());
}

/* ── 字段白名单 ───────────────────────────────────────────────────────────── */

/**
 * kind：
 *   secret      —— 单个 Key，回传只给「已配置 + 脱敏」
 *   secretList  —— Key 数组（引擎支持多个轮询），回传只给个数
 *   enum / int / text / bool —— 明文回传，可以直接在后台看到当前值
 */
export const ENGINE_CONFIG_FIELDS = Object.freeze([
  {
    id: "pexelsApiKeys",
    section: "app",
    key: "pexels_api_keys",
    kind: "secretList",
    label: "Pexels Key",
    group: "material",
    hint: "免费实拍视频库，短视频「在线素材」默认走它。多个 Key 会轮着用。",
    docs: "https://www.pexels.com/api/",
  },
  {
    id: "pixabayApiKeys",
    section: "app",
    key: "pixabay_api_keys",
    kind: "secretList",
    label: "Pixabay Key",
    group: "material",
    hint: "第二个免费素材库，Pexels 搜不到词的时候换它试试。",
    docs: "https://pixabay.com/api/docs/",
  },
  {
    id: "coverrApiKeys",
    section: "app",
    key: "coverr_api_keys",
    kind: "secretList",
    label: "Coverr Key",
    group: "material",
    hint: "偏氛围感的免费素材库。",
    docs: "https://coverr.co/developers",
  },
  {
    id: "subtitleProvider",
    section: "app",
    key: "subtitle_provider",
    kind: "enum",
    options: ["edge", "whisper"],
    label: "字幕方案",
    group: "engine",
    hint: "edge 用配音的时间轴对齐，快且不吃机器；whisper 是本地语音识别，更准但要下 1.6–3 GB 模型、吃内存和 CPU。",
  },
  {
    id: "maxConcurrentTasks",
    section: "app",
    key: "max_concurrent_tasks",
    kind: "int",
    min: 1,
    max: 8,
    label: "引擎并发",
    group: "engine",
    hint: "引擎同时渲染几条。2 核的机器建议 1–2，调大只会互相拖慢。",
  },
  {
    id: "maxQueuedTasks",
    section: "app",
    key: "max_queued_tasks",
    kind: "int",
    min: 1,
    max: 200,
    label: "引擎队列上限",
    group: "engine",
    hint: "排队超过这个数，引擎直接拒收（本站会显示「引擎队列已满」）。",
  },
  {
    id: "azureSpeechKey",
    section: "azure",
    key: "speech_key",
    kind: "secret",
    label: "Azure 语音 Key",
    group: "voice",
    hint: "配了才能用 Azure TTS V2 那批音色（比免费 Edge TTS 更自然、支持多语种混读）。",
    docs: "https://portal.azure.com/",
  },
  {
    id: "azureSpeechRegion",
    section: "azure",
    key: "speech_region",
    kind: "text",
    label: "Azure 语音区域",
    group: "voice",
    hint: "例如 eastus、southeastasia，和上面的 Key 成套。",
  },
  {
    id: "siliconflowApiKey",
    section: "siliconflow",
    key: "api_key",
    kind: "secret",
    label: "SiliconFlow Key",
    group: "voice",
    hint: "硅基流动的 TTS，国内访问快，有中文音色。",
    docs: "https://cloud.siliconflow.cn/",
  },
  {
    id: "whisperModelSize",
    section: "whisper",
    key: "model_size",
    kind: "enum",
    options: ["large-v3", "large-v3-turbo", "medium", "small", "base"],
    label: "Whisper 模型",
    group: "engine",
    hint: "只有字幕方案选 whisper 时才用得上。large-v3 约 3 GB、turbo 约 1.6 GB，首次生成会先下载。",
  },
  {
    id: "whisperDevice",
    section: "whisper",
    key: "device",
    kind: "enum",
    options: ["cpu", "cuda"],
    label: "Whisper 设备",
    group: "engine",
    hint: "没有独立显卡就保持 cpu。",
  },
]);

const FIELD_BY_ID = new Map(ENGINE_CONFIG_FIELDS.map((field) => [field.id, field]));

/* ── TOML 定点读写 ────────────────────────────────────────────────────────── */

/** 每一节的行区间：[startLine, endLine)。节名取 `[app]` 里的 app；文件开头的裸键归到 ""。 */
function sectionRanges(lines) {
  const ranges = new Map();
  let current = "";
  let start = 0;
  lines.forEach((line, index) => {
    const match = /^\s*\[([^\]]+)\]\s*$/.exec(line);
    if (!match) return;
    ranges.set(current, [start, index]);
    current = match[1].trim();
    start = index + 1;
  });
  ranges.set(current, [start, lines.length]);
  return ranges;
}

/** 在某一节里找 `key = ...` 那一行（跳过注释掉的）。 */
function findKeyLine(lines, section, key) {
  const range = sectionRanges(lines).get(section);
  if (!range) return -1;
  const pattern = new RegExp(`^\\s*${key.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")}\\s*=`);
  for (let index = range[0]; index < range[1]; index += 1) {
    if (lines[index].trimStart().startsWith("#")) continue;
    if (pattern.test(lines[index])) return index;
  }
  return -1;
}

function parseTomlValue(raw) {
  const text = String(raw ?? "").trim();
  if (!text) return "";
  if (text.startsWith("[")) {
    // 只处理单行字符串数组，够用了：pexels_api_keys = ["a", "b"]
    const inner = text.slice(1, text.lastIndexOf("]"));
    return inner
      .split(",")
      .map((item) => item.trim().replace(/^["']|["']$/g, ""))
      .filter(Boolean);
  }
  if (text === "true" || text === "false") return text === "true";
  if (/^-?\d+(\.\d+)?$/.test(text)) return Number(text);
  return text.replace(/^["']|["']$/g, "");
}

function formatTomlValue(value) {
  if (Array.isArray(value)) return `[${value.map((item) => JSON.stringify(String(item))).join(", ")}]`;
  if (typeof value === "number") return String(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  return JSON.stringify(String(value));
}

function readRawValue(lines, field) {
  const index = findKeyLine(lines, field.section, field.key);
  if (index < 0) return undefined;
  const line = lines[index];
  const value = line.slice(line.indexOf("=") + 1);
  // 行尾注释：值是字符串或数组时不好粗暴切，这里只在明显是「数字/布尔 + #」时剥掉。
  const cleaned = /^["'[]/.test(value.trim()) ? value : value.split("#")[0];
  return parseTomlValue(cleaned);
}

function keyHint(value) {
  const text = String(value || "");
  if (!text) return "";
  if (text.length <= 8) return `${text.slice(0, 2)}…`;
  return `${text.slice(0, 3)}…${text.slice(-4)}`;
}

/** 后台要看的引擎配置快照：Key 一律脱敏，其它明文。 */
export async function readEngineConfig() {
  const filePath = engineConfigPath();
  if (!filePath) {
    return { editable: false, restartAvailable: engineRestartAvailable(), path: "", fields: [], error: "没有配置 SHORTVIDEO_ENGINE_CONFIG，本站改不了引擎配置。" };
  }
  let text;
  try {
    text = await fs.readFile(filePath, "utf8");
  } catch (error) {
    return {
      editable: false,
      restartAvailable: engineRestartAvailable(),
      path: filePath,
      fields: [],
      error: `读不到引擎配置文件：${error instanceof Error ? error.message : String(error)}`,
    };
  }
  const lines = text.split("\n");
  const fields = ENGINE_CONFIG_FIELDS.map((field) => {
    const value = readRawValue(lines, field);
    const base = { id: field.id, label: field.label, group: field.group, kind: field.kind, hint: field.hint, docs: field.docs || "", options: field.options || null, present: value !== undefined };
    if (field.kind === "secret") {
      return { ...base, configured: Boolean(value), hint2: keyHint(value), value: "" };
    }
    if (field.kind === "secretList") {
      const list = Array.isArray(value) ? value.filter(Boolean) : [];
      return { ...base, configured: list.length > 0, count: list.length, value: "" };
    }
    return { ...base, configured: value !== undefined && value !== "", value: value === undefined ? "" : value };
  });
  return { editable: true, restartAvailable: engineRestartAvailable(), path: filePath, fields, error: null };
}

/** 用户填错（枚举不对、数字越界）要报 400，别混进「服务出错了」那一档。 */
function inputError(message) {
  const error = new Error(message);
  error.status = 400;
  return error;
}

function normalizeFieldValue(field, raw) {
  if (field.kind === "secretList") {
    const items = Array.isArray(raw) ? raw : String(raw ?? "").split(/[\s,，;；\n]+/);
    return items.map((item) => String(item).trim()).filter(Boolean);
  }
  if (field.kind === "secret" || field.kind === "text") {
    const value = String(raw ?? "").trim();
    if (value.length > 200) throw inputError(`${field.label}太长了。`);
    if (/\s/.test(value) && field.kind === "secret") throw inputError(`${field.label}里不能有空格。`);
    return value;
  }
  if (field.kind === "enum") {
    const value = String(raw ?? "").trim();
    if (!field.options.includes(value)) throw inputError(`${field.label}只能是 ${field.options.join(" / ")}。`);
    return value;
  }
  if (field.kind === "int") {
    const value = Number(raw);
    if (!Number.isFinite(value)) throw inputError(`${field.label}要是数字。`);
    const rounded = Math.round(value);
    if (rounded < field.min || rounded > field.max) throw inputError(`${field.label}要在 ${field.min}–${field.max} 之间。`);
    return rounded;
  }
  if (field.kind === "bool") return Boolean(raw);
  throw new Error(`未知字段类型：${field.kind}`);
}

/**
 * 写回 config.toml。只动白名单里、这次真的传了的键；写之前先备份一份。
 * 引擎是启动时读一次配置，所以改完必须重启才生效（restartEngine）。
 */
export async function writeEngineConfig(patch = {}) {
  const filePath = engineConfigPath();
  if (!filePath) throw new Error("没有配置 SHORTVIDEO_ENGINE_CONFIG，本站改不了引擎配置。");
  const original = await fs.readFile(filePath, "utf8");
  const lines = original.split("\n");
  const changed = [];

  for (const [id, raw] of Object.entries(patch)) {
    const field = FIELD_BY_ID.get(id);
    if (!field) throw inputError(`不认识的配置项：${id}`);
    if (raw === undefined || raw === null) continue;
    const value = normalizeFieldValue(field, raw);
    const index = findKeyLine(lines, field.section, field.key);
    const rendered = `${field.key} = ${formatTomlValue(value)}`;
    if (index >= 0) {
      if (lines[index].trim() === rendered.trim()) continue;
      lines[index] = rendered;
    } else {
      // 这一节里还没有这个键：加在节的末尾（保持注释不动）。
      const range = sectionRanges(lines).get(field.section);
      if (!range) throw inputError(`引擎配置里找不到 [${field.section}] 这一节。`);
      lines.splice(range[1], 0, rendered);
    }
    changed.push(field.id);
  }

  if (!changed.length) return { changed: [], backupPath: "" };

  const backupPath = `${filePath}.bak`;
  await fs.writeFile(backupPath, original, "utf8");
  const tempPath = `${filePath}.tmp-${process.pid}`;
  await fs.writeFile(tempPath, lines.join("\n"), "utf8");
  await fs.rename(tempPath, filePath);
  return { changed, backupPath: path.basename(backupPath) };
}

/** 重启引擎服务（配了 SHORTVIDEO_ENGINE_RESTART_CMD 才可用）。不经过 shell。 */
export function restartEngine() {
  const argv = restartArgv();
  if (!argv) return Promise.reject(new Error("没有配置 SHORTVIDEO_ENGINE_RESTART_CMD，请手动重启引擎服务。"));
  return new Promise((resolve, reject) => {
    const child = spawn(argv[0], argv.slice(1), { stdio: ["ignore", "pipe", "pipe"] });
    const stderr = [];
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve({ ok: true });
      else reject(new Error(`重启引擎失败（${code}）：${Buffer.concat(stderr).toString("utf8").slice(0, 300)}`));
    });
  });
}
