import { imageApiBaseUrl } from "./provider-config.mjs";
import { shortVideoSettings } from "./shortvideo-settings.mjs";
import { serverApiKey } from "./user-keys.mjs";
import { fetchWithTimeout, timeoutMsFromEnv } from "./timeouts.mjs";

/**
 * 短视频的文案 / 关键词由本站自己写，不用 MPT 里那套 LLM 配置：
 * 这样 MPT 侧一个模型 Key 都不用配，本站也能统一走演示模式、统一报错文案。
 * 走 OpenAI 兼容的 /chat/completions；没单独配 SHORTVIDEO_LLM_* 就复用默认线路的地址和共享 Key。
 */

const DEFAULT_MODEL = "gpt-4o-mini";
const MAX_SUBJECT_CHARS = 200;
export const MAX_SCRIPT_CHARS = 3000;

/**
 * 优先级：后台改过的值 → .env → 复用某条图像线路的地址和共享 Key。
 * 图像线路的 Key 不一定能聊天（Packy 的图像 Key 只列出 gpt-image-2），所以线上一般指到 apimart 这类全能中转。
 */
export function shortVideoLlmSettings() {
  const configured = shortVideoSettings();
  const providerId = configured.llmProviderId;
  const baseUrl = configured.llmBaseUrl.replace(/\/+$/, "") || imageApiBaseUrl(providerId);
  const apiKey = configured.llmApiKey || serverApiKey(providerId);
  const model = configured.llmModel || DEFAULT_MODEL;
  const demo = process.env.OPENAI_DEMO_MODE === "true" || !apiKey;
  return {
    baseUrl,
    apiKey,
    model,
    demo,
    configured: Boolean(apiKey),
    source: configured.llmApiKey ? (configured.llmApiKeySource === "admin" ? "admin" : "shortvideo") : "image-provider",
    providerId,
  };
}

/** 给界面看的：只说有没有配、用哪个模型，Key 不出去。 */
export function shortVideoLlmStatus() {
  const settings = shortVideoLlmSettings();
  return { configured: settings.configured, demo: settings.demo, model: settings.model, source: settings.source, providerId: settings.providerId };
}

function llmTimeoutMs() {
  return timeoutMsFromEnv("SHORTVIDEO_LLM_TIMEOUT_MS", 60000);
}

function languageName(language) {
  const map = {
    "zh-CN": "简体中文",
    "zh-TW": "繁体中文",
    "en-US": "English",
    "ja-JP": "日本語",
    "ko-KR": "한국어",
  };
  return map[language] || "";
}

async function chat(messages, { temperature = 0.8, maxTokens = 1200 } = {}) {
  const settings = shortVideoLlmSettings();
  const url = `${settings.baseUrl}/chat/completions`;
  let response;
  try {
    response = await fetchWithTimeout(
      url,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${settings.apiKey}` },
        // 有的中转（APIMart）不写 stream 也按 SSE 回，明确说不要流；下面还留了一手 SSE 解析兜底。
        body: JSON.stringify({ model: settings.model, messages, temperature, max_tokens: maxTokens, stream: false }),
      },
      { timeoutMs: llmTimeoutMs(), timeoutMessage: "文案模型响应超时。" },
    );
  } catch (error) {
    throw new Error(`文案模型连不上：${error instanceof Error ? error.message : String(error)}`);
  }
  const text = await response.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = null;
  }
  if (!response.ok) {
    const detail = body?.error?.message || text.slice(0, 200) || `HTTP ${response.status}`;
    throw new Error(`文案模型返回 ${response.status}：${detail}`);
  }
  const value = body ? completionText(body) : sseText(text);
  if (!value.trim()) throw new Error("文案模型没有返回内容。");
  return value.trim();
}

/** 非流式响应：choices[0].message.content（字符串或分段数组）。 */
function completionText(body) {
  const content = body?.choices?.[0]?.message?.content;
  return Array.isArray(content) ? content.map((part) => part?.text || "").join("") : String(content || "");
}

/** SSE 流：把每个 data: 块里的 delta.content 拼起来。 */
export function sseText(raw) {
  const parts = [];
  for (const line of String(raw || "").split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    try {
      const chunk = JSON.parse(payload);
      const delta = chunk?.choices?.[0]?.delta?.content ?? chunk?.choices?.[0]?.message?.content ?? "";
      if (delta) parts.push(Array.isArray(delta) ? delta.map((part) => part?.text || "").join("") : String(delta));
    } catch {
      // 半截 JSON 直接跳过。
    }
  }
  return parts.join("");
}

/** 去掉模型爱加的标题、序号、引号和 markdown 装饰，只留能直接念的旁白。 */
export function cleanScript(raw) {
  let text = String(raw || "").replace(/\r\n?/g, "\n");
  text = text.replace(/```[a-z]*\n?/gi, "");
  // markdown 标题整行不要：那是模型自己加的「标题」，不是旁白。
  text = text.replace(/^\s*#+\s.*$/gm, "");
  text = text.replace(/^\s*(\*\*|__)/gm, "");
  text = text.replace(/\*\*|__|\*/g, "");
  text = text.replace(/^\s*(?:第?\s*[一二三四五六七八九十\d]+\s*[段节、.．:：)]|[-•·]\s*)/gm, "");
  text = text.replace(/^\s*[「“"']?(?:文案|旁白|脚本|标题|Script|Narration)\s*[:：]\s*/gim, "");
  text = text.replace(/^["“「](.*)["”」]$/gms, "$1");
  text = text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n");
  return text.slice(0, MAX_SCRIPT_CHARS).trim();
}

export function normalizeTerms(raw, amount = 5) {
  let items = [];
  if (Array.isArray(raw)) items = raw;
  else {
    const text = String(raw || "").trim();
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[0]);
        if (Array.isArray(parsed)) items = parsed;
      } catch {
        items = [];
      }
    }
    if (!items.length) items = text.split(/[,\n，、;；]/);
  }
  const seen = new Set();
  const terms = [];
  for (const item of items) {
    const term = String(item ?? "")
      .replace(/^["'\s\d.\-•]+|["'\s]+$/g, "")
      .replace(/\s+/g, " ")
      .trim();
    if (!term || term.length > 60) continue;
    const key = term.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    terms.push(term);
    if (terms.length >= amount) break;
  }
  return terms;
}

function demoScript(subject, language, paragraphs) {
  const topic = subject || "这个主题";
  const lines =
    language === "en-US"
      ? [
          `Let's talk about ${topic}. Here is the one thing most people miss.`,
          `Start small, keep it simple, and let the details do the talking.`,
          `That's ${topic} in under a minute. Save this for later.`,
        ]
      : [
          `今天聊聊${topic}。很多人第一步就走偏了，其实关键只有一个。`,
          `先把最基础的那件事做对，剩下的交给细节和时间。`,
          `这就是关于${topic}的一分钟版本，记得收藏。`,
        ];
  return lines.slice(0, Math.max(1, Math.min(paragraphs, lines.length))).join("\n");
}

function demoTerms(subject, amount) {
  const base = ["city street", "sunlight window", "close up hands", "walking outdoors", "coffee table", "night lights", "nature landscape", "people smiling"];
  const seed = String(subject || "").length;
  const rotated = base.slice(seed % base.length).concat(base.slice(0, seed % base.length));
  return rotated.slice(0, amount);
}

/** 用户输入的问题（没主题、没文案）报 400，不要和模型 / 网络故障混成 500。 */
function inputError(message) {
  const error = new Error(message);
  error.status = 400;
  return error;
}

export function normalizeSubject(raw) {
  return String(raw ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_SUBJECT_CHARS);
}

/**
 * 写旁白文案。要求：只有能直接念的正文，没有标题、没有镜头提示、没有 markdown。
 */
export async function generateShortVideoScript({ subject, language = "", paragraphs = 1, prompt = "" }) {
  const topic = normalizeSubject(subject);
  if (!topic) throw inputError("请先写一句视频主题。");
  const count = Math.min(Math.max(Number(paragraphs) || 1, 1), 10);
  const settings = shortVideoLlmSettings();
  if (settings.demo) return demoScript(topic, language, count);
  const lang = languageName(language);
  const system = [
    "你是短视频旁白撰稿人。用户给一个主题，你写一段可以直接配音朗读的旁白。",
    "硬性要求：",
    "1. 只输出旁白正文，不要标题、不要「文案：」之类的前缀、不要镜头/画面提示、不要 markdown、不要引号、不要序号。",
    `2. 分成 ${count} 个自然段，每段之间空一行；整体控制在 ${count * 90} 字左右，节奏适合 30–60 秒的短视频。`,
    "3. 开头一句要抓人，结尾要收得住；语气自然口语化，不堆砌形容词。",
    lang ? `4. 使用${lang}写作。` : "4. 使用主题所用的语言写作。",
    prompt ? `5. 额外要求：${prompt.slice(0, 500)}` : "",
  ]
    .filter(Boolean)
    .join("\n");
  const raw = await chat(
    [
      { role: "system", content: system },
      { role: "user", content: `主题：${topic}` },
    ],
    { temperature: 0.8, maxTokens: 900 },
  );
  const script = cleanScript(raw);
  if (!script) throw new Error("文案模型返回了空内容，换个主题再试。");
  return script;
}

const PLATFORM_STYLES = {
  douyin: { name: "抖音", title: "20 字以内的钩子标题", tags: "5–8 个中文话题标签" },
  xiaohongshu: { name: "小红书", title: "20 字以内、带一点情绪的标题", tags: "6–10 个中文话题标签" },
  bilibili: { name: "B 站", title: "30 字以内、信息量足的标题", tags: "5–8 个中文标签" },
  tiktok: { name: "TikTok", title: "an English hook under 12 words", tags: "5–8 English hashtags" },
  youtube: { name: "YouTube Shorts", title: "an English title under 60 characters", tags: "5–8 English hashtags incl. #shorts" },
  instagram: { name: "Instagram Reels", title: "an English hook under 12 words", tags: "5–8 English hashtags" },
};

function demoMetadata(subject, platform) {
  const topic = subject || "这条视频";
  const english = platform === "tiktok" || platform === "youtube" || platform === "instagram";
  return english
    ? { title: `${topic} in 60 seconds`, caption: `Everything you need to know about ${topic}. Save this for later.`, hashtags: ["#shorts", "#howto", "#tips", "#fyp", "#viral"] }
    : { title: `${topic}，一条讲清楚`, caption: `关于${topic}，这条把该说的都说了。觉得有用就收藏。`, hashtags: ["#干货分享", "#新手必看", "#收藏", "#教程", "#日常"] };
}

/**
 * 生成发布用的标题 / 简介 / 话题标签。成片本身只是素材，能直接发出去才算做完。
 * 走本站自己的模型（引擎那条 /social-metadata 也能做，但那样要给引擎配模型 Key）。
 */
export async function generateShortVideoMetadata({ subject, script, platform = "douyin", language = "" }) {
  const topic = normalizeSubject(subject);
  const body = String(script || "").trim().slice(0, MAX_SCRIPT_CHARS);
  if (!topic && !body) throw inputError("请先写主题或文案。");
  const style = PLATFORM_STYLES[platform] || PLATFORM_STYLES.douyin;
  const settings = shortVideoLlmSettings();
  if (settings.demo) return demoMetadata(topic || body.slice(0, 12), platform);
  const lang = languageName(language);
  const system = [
    `你在给一条要发到${style.name}的短视频写发布文案。`,
    "只输出一个 JSON 对象，字段固定为 title、caption、hashtags：",
    `1. title：${style.title}，不要书名号、不要标点堆砌。`,
    "2. caption：1–3 句简介，能直接贴进发布框，可以带一句引导（收藏 / 关注 / 评论区聊）。",
    `3. hashtags：${style.tags}，每个都以 # 开头，不要空格。`,
    lang ? `4. title 和 caption 用${lang}。` : "",
    "不要输出解释，不要 markdown 代码块。",
  ]
    .filter(Boolean)
    .join("\n");
  const raw = await chat(
    [
      { role: "system", content: system },
      { role: "user", content: `主题：${topic || "（无）"}\n旁白：\n${body || "（无）"}` },
    ],
    { temperature: 0.7, maxTokens: 500 },
  );
  return parseMetadata(raw, topic || body.slice(0, 12), platform);
}

/** 模型偶尔会在 JSON 外面裹一层解释或代码块，这里尽量抠出来；抠不到就退回启发式结果。 */
export function parseMetadata(raw, subject, platform) {
  const text = String(raw || "").replace(/```[a-z]*|```/gi, "").trim();
  const match = text.match(/\{[\s\S]*\}/);
  if (match) {
    try {
      const parsed = JSON.parse(match[0]);
      const title = String(parsed.title || "").trim().slice(0, 120);
      const caption = String(parsed.caption || "").trim().slice(0, 800);
      const hashtags = (Array.isArray(parsed.hashtags) ? parsed.hashtags : String(parsed.hashtags || "").split(/[\s,，]+/))
        .map((tag) => String(tag).trim().replace(/^#*/, ""))
        .filter(Boolean)
        .slice(0, 12)
        .map((tag) => `#${tag}`);
      if (title || caption || hashtags.length) return { title, caption, hashtags };
    } catch {
      // 落到下面的兜底。
    }
  }
  const fallback = demoMetadata(subject, platform);
  const firstLine = text.split("\n").map((line) => line.trim()).filter(Boolean)[0] || "";
  return { ...fallback, title: firstLine.slice(0, 120) || fallback.title };
}

/** 后台的「测一下」：发一条最短的请求确认线路 / Key / 模型都对，花费可以忽略。 */
export async function testShortVideoLlm() {
  const settings = shortVideoLlmSettings();
  if (settings.demo) return { ok: false, message: "演示模式：没有可用的 Key，文案会用示例内容。", model: settings.model };
  try {
    const reply = await chat([{ role: "user", content: "回复两个字：正常" }], { temperature: 0, maxTokens: 16 });
    return { ok: true, message: `连通正常（${settings.model} 回了「${reply.slice(0, 20)}」）。`, model: settings.model };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : "文案模型测试失败。", model: settings.model };
  }
}

/**
 * 抽素材关键词。Pexels / Pixabay 只认英文，所以不管文案什么语言，关键词一律英文短语。
 */
export async function generateShortVideoTerms({ subject, script, amount = 5 }) {
  const topic = normalizeSubject(subject);
  const body = String(script || "").trim().slice(0, MAX_SCRIPT_CHARS);
  if (!topic && !body) throw inputError("请先写主题或文案。");
  const count = Math.min(Math.max(Number(amount) || 5, 1), 10);
  const settings = shortVideoLlmSettings();
  if (settings.demo) return demoTerms(topic || body, count);
  const system = [
    "你负责给短视频找配图素材的检索词。根据主题和旁白，给出用于在 Pexels / Pixabay 检索实拍视频的英文关键词。",
    "要求：",
    `1. 恰好 ${count} 个，每个 1–3 个英文单词，描述具体可见的画面（人、物、场景、动作），不要抽象概念。`,
    "2. 与主题强相关，第一个词最贴主题；彼此不要重复。",
    '3. 只输出一个 JSON 数组，例如 ["city skyline", "coffee cup"]，不要任何解释。',
  ].join("\n");
  const raw = await chat(
    [
      { role: "system", content: system },
      { role: "user", content: `主题：${topic || "（无）"}\n旁白：\n${body || "（无）"}` },
    ],
    { temperature: 0.4, maxTokens: 300 },
  );
  const terms = normalizeTerms(raw, count);
  if (!terms.length) throw new Error("没抽出可用的关键词，可以手动填几个英文词。");
  return terms;
}
