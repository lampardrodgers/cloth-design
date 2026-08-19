import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { ChevronDown, ChevronLeft, ChevronRight, Minus, Plus } from "lucide-react";
import { pageWindow } from "../lib/paging";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "primary" | "secondary" | "ghost" | "danger";
  icon?: ReactNode;
}

export function Button({ variant = "secondary", icon, children, className = "", ...props }: ButtonProps) {
  return (
    <button className={`btn btn-${variant} ${className}`} {...props}>
      {icon ? <span className="btn-icon">{icon}</span> : null}
      <span>{children}</span>
    </button>
  );
}

export function Section({
  title,
  action,
  children,
  className = "",
  collapsible = false,
  defaultOpen = true,
  /** 折叠状态下标题旁边的一行小字，比如「共 137 条」。 */
  summary,
}: {
  title: string;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
  /** 平时用不到、点开才看的版块（比如积分流水）收起来，别占着首屏。 */
  collapsible?: boolean;
  defaultOpen?: boolean;
  summary?: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  if (!collapsible) {
    return (
      <section className={`section ${className}`}>
        <div className="section-head">
          <h2>{title}</h2>
          {action}
        </div>
        {children}
      </section>
    );
  }
  return (
    <section className={`section section-collapsible ${open ? "" : "collapsed"} ${className}`}>
      <button type="button" className="section-head section-toggle" aria-expanded={open} onClick={() => setOpen((current) => !current)}>
        <h2>{title}</h2>
        {summary ? <small className="section-summary">{summary}</small> : null}
        <span className="section-chevron" aria-hidden="true">
          <ChevronDown size={16} />
        </span>
      </button>
      {open ? children : null}
    </section>
  );
}

export function Metric({
  label,
  value,
  tone = "default",
  hint,
}: {
  label: string;
  value: string;
  tone?: "default" | "good" | "warn";
  /** 数字下面的一行小字，用来说明这个数是怎么来的。 */
  hint?: string;
}) {
  return (
    <div className={`metric metric-${tone}`}>
      <span>{label}</span>
      <strong>{value}</strong>
      {hint ? <small className="metric-hint">{hint}</small> : null}
    </div>
  );
}

/**
 * 列表页码条。
 * 只有一页时不画按钮，但总数还是要说一声——「就这么多」和「只显示了这么多」是两回事，
 * 后台里这个区别很重要。
 */
export function Pager({
  page,
  pageCount,
  total,
  loading = false,
  unit = "条",
  onChange,
}: {
  page: number;
  pageCount: number;
  total: number;
  loading?: boolean;
  /** 计数单位：条 / 张 / 个。 */
  unit?: string;
  onChange: (page: number) => void;
}) {
  const safeCount = Math.max(1, pageCount);
  const jump = (next: number) => {
    if (loading || next < 1 || next > safeCount || next === page) return;
    onChange(next);
  };
  return (
    <div className="pager" role="navigation" aria-label="分页">
      <span className="pager-count">
        共 {total} {unit}
        {safeCount > 1 ? ` · 第 ${page}/${safeCount} 页` : ""}
        {loading ? " · 加载中…" : ""}
      </span>
      {safeCount > 1 ? (
        <div className="pager-controls">
          <button type="button" className="pager-step" disabled={loading || page <= 1} aria-label="上一页" onClick={() => jump(page - 1)}>
            <ChevronLeft size={15} />
          </button>
          {pageWindow(page, safeCount).map((value, index) =>
            value === 0 ? (
              <span key={`gap-${index}`} className="pager-gap" aria-hidden="true">
                …
              </span>
            ) : (
              <button
                key={value}
                type="button"
                className={value === page ? "pager-page current" : "pager-page"}
                aria-current={value === page ? "page" : undefined}
                disabled={loading}
                onClick={() => jump(value)}
              >
                {value}
              </button>
            ),
          )}
          <button
            type="button"
            className="pager-step"
            disabled={loading || page >= safeCount}
            aria-label="下一页"
            onClick={() => jump(page + 1)}
          >
            <ChevronRight size={15} />
          </button>
        </div>
      ) : null}
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────────────────
 * 可复用交互组件（AI功能中心使用）
 * ──────────────────────────────────────────────────────────────────────────── */

interface ChipOption {
  id: string;
  label: string;
  hint?: string;
}

interface ChipGroupProps {
  options: ChipOption[];
  value: string;
  onChange: (id: string) => void;
  ariaLabel?: string;
  className?: string;
  size?: "sm" | "md";
}

/** 单选药丸组：用于少量有限项（图案/领型/后期动作等），所见即所得、一键切换。 */
export function ChipGroup({ options, value, onChange, ariaLabel, className = "", size = "md" }: ChipGroupProps) {
  return (
    <div className={`chip-group chip-${size} ${className}`} role="radiogroup" aria-label={ariaLabel}>
      {options.map((option) => {
        const selected = option.id === value;
        return (
          <button
            key={option.id}
            type="button"
            role="radio"
            aria-checked={selected}
            title={option.hint}
            className={selected ? "chip selected" : "chip"}
            onClick={() => onChange(option.id)}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

/** 多选药丸组：用于后期动作、场景等多选场景。 */
export function ChipToggleGroup({
  options,
  values,
  onToggle,
  ariaLabel,
  size = "md",
}: {
  options: ChipOption[];
  values: string[];
  onToggle: (id: string) => void;
  ariaLabel?: string;
  size?: "sm" | "md";
}) {
  return (
    <div className={`chip-group chip-${size}`} role="group" aria-label={ariaLabel}>
      {options.map((option) => {
        const selected = values.includes(option.id);
        return (
          <button
            key={option.id}
            type="button"
            aria-pressed={selected}
            title={option.hint}
            className={selected ? "chip selected" : "chip"}
            onClick={() => onToggle(option.id)}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

interface ComboBoxProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "onChange" | "value"> {
  options: ChipOption[];
  /** 受控值：可以是某个 option.id，也可以是用户自定义文本。 */
  value: string;
  onChange: (value: string) => void;
  /** 允许输入自定义值（不限制在 options 内）。默认 true。 */
  allowCustom?: boolean;
  ariaLabel?: string;
}

/**
 * 组合框：输入框 + 下拉。既可在候选项里搜索/选择，也可自由输入自定义值。
 * 用于列表较多或可自定义的字段（虚拟模特/展示场景/模特姿势/服装品类）。
 */
export function ComboBox({
  options,
  value,
  onChange,
  allowCustom = true,
  ariaLabel,
  placeholder,
  ...rest
}: ComboBoxProps) {
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(-1);
  const wrapperRef = useRef<HTMLDivElement | null>(null);

  const filtered = useMemo(() => {
    const query = value.trim().toLowerCase();
    if (!query) return options;
    return options.filter(
      (option) => option.label.toLowerCase().includes(query) || option.id.toLowerCase().includes(query),
    );
  }, [options, value]);

  useEffect(() => {
    if (!open) return;
    const handlePointer = (event: globalThis.PointerEvent) => {
      if (wrapperRef.current && !wrapperRef.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", handlePointer);
    return () => document.removeEventListener("pointerdown", handlePointer);
  }, [open]);

  const pick = (id: string) => {
    onChange(id);
    setOpen(false);
    setHighlight(-1);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setOpen(true);
      setHighlight((current) => Math.min(current + 1, filtered.length - 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setHighlight((current) => Math.max(current - 1, 0));
    } else if (event.key === "Enter") {
      if (open && highlight >= 0 && highlight < filtered.length) {
        event.preventDefault();
        pick(filtered[highlight].id);
      } else {
        setOpen(false);
      }
    } else if (event.key === "Escape") {
      setOpen(false);
      setHighlight(-1);
    }
  };

  return (
    <div className="combo-box" ref={wrapperRef}>
      <input
        {...rest}
        type="text"
        role="combobox"
        aria-expanded={open}
        aria-autocomplete="list"
        aria-label={ariaLabel}
        autoComplete="off"
        placeholder={placeholder ?? "选择或输入…"}
        value={value}
        onChange={(event) => {
          onChange(event.target.value);
          setOpen(true);
          setHighlight(-1);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={handleKeyDown}
      />
      <button
        type="button"
        tabIndex={-1}
        className="combo-caret"
        aria-label={open ? "收起候选项" : "展开候选项"}
        onClick={() => setOpen((current) => !current)}
      >
        <ChevronDown size={15} />
      </button>
      {open && filtered.length > 0 ? (
        <ul className="combo-list" role="listbox">
          {filtered.map((option, index) => (
            <li key={option.id} role="option" aria-selected={option.id === value}>
              <button
                type="button"
                className={index === highlight ? "focused" : ""}
                onMouseEnter={() => setHighlight(index)}
                onClick={() => pick(option.id)}
              >
                <span>{option.label}</span>
                {option.hint ? <em>{option.hint}</em> : null}
              </button>
            </li>
          ))}
        </ul>
      ) : open && allowCustom && value.trim().length > 0 ? (
        <ul className="combo-list" role="listbox">
          <li role="option" aria-selected>
            <button type="button" className="focused" onClick={() => pick(value.trim())}>
              <span>使用“{value.trim()}”</span>
              <em>自定义</em>
            </button>
          </li>
        </ul>
      ) : null}
      {!allowCustom ? null : null}
    </div>
  );
}

interface FieldCardProps {
  index?: number;
  step?: string;
  icon?: ReactNode;
  title: string;
  hint?: string;
  children: ReactNode;
  collapsible?: boolean;
  defaultOpen?: boolean;
  footer?: ReactNode;
}

/**
 * 模块卡：统一视觉层级。顶部 segment 已显示模块编号(①②③)，
 * 卡片本身用 step 标签(素材/设定/输出)区分流程阶段，避免每个模块又从①开始造成重复混乱。
 * 支持折叠，用于渐进式披露进阶项（13 寸一屏适配）。
 */
export function FieldCard({ index, step, icon, title, hint, children, collapsible = false, defaultOpen = true, footer }: FieldCardProps) {
  const [open, setOpen] = useState(defaultOpen);
  const toggleFromKeyboard = (event: KeyboardEvent<HTMLElement>) => {
    if (!collapsible || !["Enter", " "].includes(event.key)) return;
    event.preventDefault();
    setOpen((current) => !current);
  };
  return (
    <section className={`field-card${collapsible ? " collapsible" : ""}${open ? "" : " collapsed"}`}>
      <header
        className="field-card-head"
        role={collapsible ? "button" : undefined}
        tabIndex={collapsible ? 0 : undefined}
        aria-expanded={collapsible ? open : undefined}
        onClick={collapsible ? () => setOpen((current) => !current) : undefined}
        onKeyDown={collapsible ? toggleFromKeyboard : undefined}
      >
        <div className="field-card-title">
          {index ? <span className="field-card-index">{index}</span> : null}
          {step ? <span className="field-card-step">{step}</span> : null}
          {icon}
          <strong>{title}</strong>
        </div>
        {hint ? <small className="field-card-hint">{hint}</small> : null}
        {collapsible ? (
          <span className="field-card-toggle" aria-hidden="true">
            {open ? <Minus size={15} /> : <Plus size={15} />}
          </span>
        ) : null}
      </header>
      {open ? <div className="field-card-body">{children}</div> : null}
      {open && footer ? <div className="field-card-footer">{footer}</div> : null}
    </section>
  );
}

interface NumberStepperProps {
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
  step?: number;
  ariaLabel?: string;
}

/** 步进数值：变体数量等，比原生 number 友好。 */
export function NumberStepper({ value, onChange, min = 1, max = 8, step = 1, ariaLabel }: NumberStepperProps) {
  const clamp = (next: number) => Math.min(max, Math.max(min, next));
  return (
    <div className="number-stepper">
      <button type="button" aria-label="减少" disabled={value <= min} onClick={() => onChange(clamp(value - step))}>
        <Minus size={15} />
      </button>
      <input
        type="number"
        aria-label={ariaLabel}
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange(clamp(Number(event.target.value) || min))}
      />
      <button type="button" aria-label="增加" disabled={value >= max} onClick={() => onChange(clamp(value + step))}>
        <Plus size={15} />
      </button>
    </div>
  );
}
