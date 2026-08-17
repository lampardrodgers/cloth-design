import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type Ref } from "react";
import {
  appendChipText,
  applyChipInsert,
  chipInsertText,
  chipKindLabels,
  chipPrefixes,
  colorChipText,
  defaultPromptLibrary,
  filterChips,
  findChipTrigger,
  type ChipKind,
  type ChipTrigger,
  type ColorChip,
  type GalleryChip,
  type PromptLibrary,
  type SnippetChip,
} from "../lib/promptLibrary";
import { useStoredState } from "../lib/storedState";

type AnyChip = GalleryChip | ColorChip | SnippetChip;

interface UsePromptChipsOptions {
  value: string;
  onChange: (value: string) => void;
  /** `@` 能引用的图：创作台是参考素材，自由创作是已上传的附件。 */
  gallery: GalleryChip[];
}

/**
 * 把描述框接上 `@` / `#` / `~` 三类原子 chip。
 * 返回的 handler 由调用方挂到自己的 textarea 上——两个创作界面的外壳不一样，
 * 这里只负责触发、筛选和插入。
 */
export function usePromptChips({ value, onChange, gallery }: UsePromptChipsOptions) {
  const [library, setLibrary] = useStoredState<PromptLibrary>("clothdesign:promptLibrary", defaultPromptLibrary);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const pickerRef = useRef<HTMLDivElement | null>(null);
  const [trigger, setTrigger] = useState<ChipTrigger | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);

  const items = useMemo<AnyChip[]>(() => {
    if (!trigger) return [];
    if (trigger.kind === "gallery") return filterChips(gallery, trigger.query);
    if (trigger.kind === "color") return filterChips(library.colors, trigger.query);
    return filterChips(library.snippets, trigger.query);
  }, [gallery, library, trigger]);

  useEffect(() => setActiveIndex(0), [trigger?.kind, trigger?.query]);

  useEffect(() => {
    if (!trigger) return;
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (pickerRef.current?.contains(target) || textareaRef.current?.contains(target)) return;
      setTrigger(null);
    };
    document.addEventListener("pointerdown", handlePointerDown);
    return () => document.removeEventListener("pointerdown", handlePointerDown);
  }, [trigger]);

  const syncTrigger = (element: HTMLTextAreaElement) => {
    setTrigger(findChipTrigger(element.value, element.selectionStart ?? element.value.length));
  };

  const commit = (next: { value: string; caret: number }) => {
    onChange(next.value);
    setTrigger(null);
    window.requestAnimationFrame(() => {
      const element = textareaRef.current;
      if (!element) return;
      element.focus();
      element.setSelectionRange(next.caret, next.caret);
    });
  };

  const choose = (item: AnyChip) => {
    if (!trigger) return;
    commit(applyChipInsert(value, trigger, chipInsertText(trigger.kind, item)));
  };

  /** 点 chip 按钮时不用真的打出触发符，直接在末尾开一个空触发段。 */
  const openKind = (kind: ChipKind) => {
    if (trigger?.kind === kind) {
      setTrigger(null);
      return;
    }
    setTrigger({ kind, start: value.length, end: value.length, query: "" });
    textareaRef.current?.focus();
  };

  /** 选择器开着时吃掉方向键和回车，否则回车会直接触发生成。 */
  const handleKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (!trigger) return false;
    if (event.key === "Escape") {
      event.preventDefault();
      setTrigger(null);
      return true;
    }
    if (!items.length) return false;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      setActiveIndex((index) => (index + step + items.length) % items.length);
      return true;
    }
    if (event.key === "Enter" || event.key === "Tab") {
      event.preventDefault();
      choose(items[activeIndex] ?? items[0]);
      return true;
    }
    return false;
  };

  const textareaProps = {
    ref: textareaRef,
    onChange: (event: { target: HTMLTextAreaElement }) => {
      onChange(event.target.value);
      syncTrigger(event.target);
    },
    onClick: (event: { currentTarget: HTMLTextAreaElement }) => syncTrigger(event.currentTarget),
    onKeyUp: (event: { currentTarget: HTMLTextAreaElement }) => {
      // 光标被方向键移走后，原来的触发段可能已经不在光标处了。
      syncTrigger(event.currentTarget);
    },
  };

  const picker = trigger ? (
    <ChipPicker
      ref={pickerRef}
      kind={trigger.kind}
      query={trigger.query}
      items={items}
      activeIndex={activeIndex}
      onHover={setActiveIndex}
      onChoose={choose}
      onClose={() => setTrigger(null)}
      onLibraryChange={setLibrary}
    />
  ) : null;

  const appendText = (text: string) => commit(appendChipText(value, text));

  return { textareaProps, handleKeyDown, picker, openKind, openKindActive: trigger?.kind ?? null, appendText };
}

interface PromptChipBarProps {
  onOpenKind: (kind: ChipKind) => void;
  activeKind: ChipKind | null;
  galleryCount: number;
}

/** 三个触发按钮。不放这排按钮，没人会知道可以打 `@`。 */
export function PromptChipBar({ onOpenKind, activeKind, galleryCount }: PromptChipBarProps) {
  const kinds: ChipKind[] = ["gallery", "color", "snippet"];
  return (
    <div className="chip-bar" role="group" aria-label="快捷引用">
      {kinds.map((kind) => (
        <button
          type="button"
          key={kind}
          className={`chip chip-trigger ${activeKind === kind ? "selected" : ""}`}
          aria-pressed={activeKind === kind}
          title={`在描述里打 ${chipPrefixes[kind]} 也能唤出`}
          onClick={() => onOpenKind(kind)}
        >
          <em>{chipPrefixes[kind]}</em>
          {chipKindLabels[kind]}
          {kind === "gallery" && galleryCount ? <small>{galleryCount}</small> : null}
        </button>
      ))}
    </div>
  );
}

interface ChipPickerProps {
  kind: ChipKind;
  query: string;
  items: AnyChip[];
  activeIndex: number;
  onHover: (index: number) => void;
  onChoose: (item: AnyChip) => void;
  onClose: () => void;
  onLibraryChange: (update: (current: PromptLibrary) => PromptLibrary) => void;
}

function ChipPicker({
  ref,
  kind,
  query,
  items,
  activeIndex,
  onHover,
  onChoose,
  onClose,
  onLibraryChange,
}: ChipPickerProps & { ref: Ref<HTMLDivElement> }) {
  const [adding, setAdding] = useState(false);
  const [draftName, setDraftName] = useState("");
  const [draftValue, setDraftValue] = useState(kind === "color" ? "#C8262C" : "");

  const editable = kind !== "gallery";

  const addEntry = () => {
    const name = draftName.trim();
    const detail = draftValue.trim();
    if (!name || !detail) return;
    onLibraryChange((current) =>
      kind === "color"
        ? { ...current, colors: [...current.colors, { id: `color-${name}-${current.colors.length}`, name, hex: detail }] }
        : { ...current, snippets: [...current.snippets, { id: `snippet-${name}-${current.snippets.length}`, name, text: detail }] },
    );
    setDraftName("");
    setDraftValue(kind === "color" ? "#C8262C" : "");
    setAdding(false);
  };

  const removeEntry = (id: string) => {
    onLibraryChange((current) =>
      kind === "color"
        ? { ...current, colors: current.colors.filter((item) => item.id !== id) }
        : { ...current, snippets: current.snippets.filter((item) => item.id !== id) },
    );
  };

  return (
    <div className="chip-picker" ref={ref} role="listbox" aria-label={`${chipKindLabels[kind]}选择`}>
      <header className="chip-picker-head">
        <span className="rail-kicker">
          {chipPrefixes[kind]} {chipKindLabels[kind]}
        </span>
        {query ? <small>筛选「{query}」</small> : null}
        <button type="button" className="chip-picker-close" onClick={onClose} aria-label="关闭">
          ×
        </button>
      </header>

      {items.length ? (
        <ul className="chip-picker-list">
          {items.map((item, index) => (
            <li key={item.id}>
              <button
                type="button"
                role="option"
                aria-selected={index === activeIndex}
                className={`chip-picker-item ${index === activeIndex ? "active" : ""}`}
                onPointerEnter={() => onHover(index)}
                onClick={() => onChoose(item)}
              >
                {kind === "color" ? <i className="chip-swatch" style={{ background: (item as ColorChip).hex }} /> : null}
                {kind === "gallery" && (item as GalleryChip).previewUrl ? (
                  <img className="chip-thumb" src={(item as GalleryChip).previewUrl} alt="" />
                ) : null}
                <strong>{item.name}</strong>
                <small>
                  {kind === "color"
                    ? colorChipText(item as ColorChip)
                    : kind === "snippet"
                      ? (item as SnippetChip).text
                      : (item as GalleryChip).insert}
                </small>
              </button>
              {editable ? (
                <button
                  type="button"
                  className="chip-picker-remove"
                  aria-label={`删除 ${item.name}`}
                  onClick={() => removeEntry(item.id)}
                >
                  ×
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : (
        <p className="chip-picker-empty">
          {kind === "gallery" ? "还没有可引用的图片，先上传参考素材。" : "没有匹配的条目。"}
        </p>
      )}

      {editable ? (
        adding ? (
          <div className="chip-picker-add">
            <input
              value={draftName}
              placeholder="名称"
              aria-label="名称"
              autoFocus
              onChange={(event) => setDraftName(event.target.value)}
            />
            {kind === "color" ? (
              <input type="color" value={draftValue} aria-label="颜色" onChange={(event) => setDraftValue(event.target.value)} />
            ) : (
              <input
                value={draftValue}
                placeholder="插入到描述里的文字"
                aria-label="片段内容"
                onChange={(event) => setDraftValue(event.target.value)}
              />
            )}
            <button type="button" className="text-button" onClick={addEntry}>
              保存
            </button>
            <button type="button" className="text-button" onClick={() => setAdding(false)}>
              取消
            </button>
          </div>
        ) : (
          <button type="button" className="chip-picker-new" onClick={() => setAdding(true)}>
            ＋ 新建{chipKindLabels[kind]}
          </button>
        )
      ) : null}
    </div>
  );
}
