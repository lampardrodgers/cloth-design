/**
 * 提示词原子 chip：在描述里打 `@` / `#` / `~` 就能唤出图片、色卡和常用片段。
 *
 * 三类分开是有意的——`@` 指向这次真的传进去的图，`#` 是能落到生产的色号，
 * `~` 是反复要写的那几句话。混成一个列表就又变回一堆记不住的按钮了。
 */

export type ChipKind = "gallery" | "color" | "snippet";

export const chipPrefixes: Record<ChipKind, string> = {
  gallery: "@",
  color: "#",
  snippet: "~",
};

export const chipKindLabels: Record<ChipKind, string> = {
  gallery: "参考图",
  color: "色卡",
  snippet: "片段",
};

export interface GalleryChip {
  id: string;
  name: string;
  /** 插入到描述里的文字，通常是「参考A」这种能被提示词构建器识别的标记。 */
  insert: string;
  previewUrl?: string;
}

export interface ColorChip {
  id: string;
  name: string;
  hex: string;
}

export interface SnippetChip {
  id: string;
  name: string;
  text: string;
}

export interface PromptLibrary {
  colors: ColorChip[];
  snippets: SnippetChip[];
}

/** 服装场景的默认色卡与片段，用户可以在选择器里增删。 */
export const defaultPromptLibrary: PromptLibrary = {
  colors: [
    { id: "color-offwhite", name: "米白", hex: "#F3EFE7" },
    { id: "color-oat", name: "燕麦", hex: "#E4D9C4" },
    { id: "color-haze", name: "雾霾蓝", hex: "#8FA3B8" },
    { id: "color-navy", name: "藏青", hex: "#1F2A44" },
    { id: "color-caramel", name: "焦糖", hex: "#A9652E" },
    { id: "color-olive", name: "橄榄绿", hex: "#4E5B3A" },
    { id: "color-red", name: "正红", hex: "#C8262C" },
    { id: "color-charcoal", name: "炭黑", hex: "#2B2B2B" },
  ],
  snippets: [
    { id: "snippet-studio", name: "干净棚拍", text: "纯色背景，柔和棚拍光，画面干净无杂物" },
    { id: "snippet-fabric", name: "面料质感", text: "面料纹理、织法和垂坠感清晰可辨" },
    { id: "snippet-ecom", name: "电商主图", text: "正面完整展示，主体居中，四周留白均匀" },
    { id: "snippet-model", name: "模特实穿", text: "模特自然站姿，服装版型准确不变形" },
    { id: "snippet-detail", name: "工艺细节", text: "聚焦缝线、扣件与工艺细节" },
    { id: "snippet-daylight", name: "自然光", text: "自然日光侧光，阴影柔和" },
  ],
};

/** 色卡带上十六进制值一起插入——只写「米白」出来的颜色每次都不一样。 */
export function colorChipText(color: ColorChip) {
  return `${color.name}(${color.hex.toUpperCase()})`;
}

export function chipInsertText(kind: ChipKind, item: GalleryChip | ColorChip | SnippetChip) {
  if (kind === "gallery") return (item as GalleryChip).insert;
  if (kind === "color") return colorChipText(item as ColorChip);
  return (item as SnippetChip).text;
}

export interface ChipTrigger {
  kind: ChipKind;
  /** 触发符在原文里的下标。 */
  start: number;
  /** 光标位置，[start, end) 就是要被替换掉的那段。 */
  end: number;
  /** 触发符后面已经打出来的过滤词。 */
  query: string;
}

const KIND_BY_PREFIX = new Map<string, ChipKind>(
  (Object.keys(chipPrefixes) as ChipKind[]).map((kind) => [chipPrefixes[kind], kind]),
);

/** 触发符必须处在词首，否则邮箱、井号话题和波浪号都会误触发。 */
function isBoundary(char: string | undefined) {
  return char === undefined || /[\s，。；：、,.;:!?！？（）()\[\]【】"'"']/.test(char);
}

/**
 * 从光标往前找触发符。触发符和光标之间不能有空白，
 * 过滤词也限制在 12 个字符内——再长就说明用户只是在正常打字。
 */
export function findChipTrigger(value: string, caret: number): ChipTrigger | null {
  const limit = Math.max(0, caret - 13);
  for (let index = caret - 1; index >= limit; index -= 1) {
    const char = value[index];
    if (/\s/.test(char)) return null;
    const kind = KIND_BY_PREFIX.get(char);
    if (!kind) continue;
    if (!isBoundary(value[index - 1])) return null;
    return { kind, start: index, end: caret, query: value.slice(index + 1, caret) };
  }
  return null;
}

const SEPARATOR = /[\s，。；：、,.;:!?！？]/;

/** 用插入文本替换掉触发段，并返回替换后的新光标位置。 */
export function applyChipInsert(value: string, trigger: Pick<ChipTrigger, "start" | "end">, insertText: string) {
  const before = value.slice(0, trigger.start);
  const after = value.slice(trigger.end);
  // 两头都补中文逗号，免得插在句子中间粘成「…大衣米白(#F3EFE7)一张主图…」。
  const leadGlue = before.trim().length > 0 && !SEPARATOR.test(before.slice(-1)) ? "，" : "";
  const tailGlue = after.length > 0 && !SEPARATOR.test(after[0]) ? "，" : "";
  const next = `${before}${leadGlue}${insertText}${tailGlue}${after}`;
  return { value: next, caret: before.length + leadGlue.length + insertText.length };
}

/** 追加到描述末尾（点 chip 按钮而不是打触发符时走这条）。 */
export function appendChipText(value: string, insertText: string) {
  return applyChipInsert(value, { start: value.length, end: value.length }, insertText);
}

export function filterChips<T extends { name: string }>(items: T[], query: string) {
  const keyword = query.trim().toLowerCase();
  if (!keyword) return items;
  return items.filter((item) => item.name.toLowerCase().includes(keyword));
}
