import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ratioOptions } from "../data/catalog";
import { outputSizeForRatio, outputSizeMismatch } from "../lib/outputSize";
import type { ProviderProtocol, RatioOption, ResolutionKey } from "../types";

interface RatioPickerProps {
  value: string;
  /** 用来算每个比例真正会交付多少像素。 */
  resolution: ResolutionKey;
  protocol: ProviderProtocol;
  onChange: (ratioId: string) => void;
  options?: RatioOption[];
  ariaLabel?: string;
}

interface MenuPlacement {
  top?: number;
  bottom?: number;
  left: number;
  width: number;
  maxHeight: number;
  direction: "up" | "down";
}

const MENU_GAP = 6;
const MENU_EDGE = 8;
// 16 个比例排成三列六行，屏幕够高时一次全看见，不用在小框里再滚一次。
const MENU_IDEAL_HEIGHT = 460;
const MENU_MIN_HEIGHT = 168;
const MENU_MIN_WIDTH = 336;

/** 1536×1024 这种尺寸对应的比例名，用来说明「选的是 16:9，实际按 3:2 出」。 */
function deliveredRatioLabel(width?: number, height?: number) {
  if (!width || !height) return "";
  const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a);
  const divisor = gcd(width, height) || 1;
  return `${Math.round(width / divisor)}:${Math.round(height / divisor)}`;
}

/** 比例示意图：按真实宽高比画的小方块，横的竖的一眼看出来。 */
export function RatioGlyph({ ratio, size = 22 }: { ratio: RatioOption; size?: number }) {
  const longest = Math.max(ratio.width, ratio.height) || 1;
  const width = Math.max(4, (ratio.width / longest) * size);
  const height = Math.max(4, (ratio.height / longest) * size);
  return (
    <span className="ratio-glyph" style={{ width: size, height: size }} aria-hidden="true">
      <i className={`ratio-glyph-box ${ratio.id === "auto" ? "ratio-glyph-auto" : ""}`} style={{ width, height }} />
    </span>
  );
}

/**
 * 比例选择器。
 *
 * 原来是个原生 <select>：菜单由系统画，展开是一列干巴巴的「3:2 / 2:3 / 3:4」，
 * 光看数字分不清哪个是横哪个是竖，聚焦时那圈描边也和整站的样式对不上。
 * 这里换成自己画的下拉：每一项配一张按真实比例画的示意图，再写清这一档实际交付多少像素。
 *
 * 菜单挂在 body 上用 fixed 定位：左边那张卡是定高滚动容器（`.simple-card`），
 * 菜单留在卡里会被裁掉半截——控件本来就在卡的底部，往下弹一定超出边界。
 * 现在按剩余空间决定往下还是往上弹，高度也照着可用空间收，永远完整可见。
 */
export function RatioPicker({
  value,
  resolution,
  protocol,
  onChange,
  options = ratioOptions,
  ariaLabel = "画面比例",
}: RatioPickerProps) {
  const [open, setOpen] = useState(false);
  const [placement, setPlacement] = useState<MenuPlacement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const current = options.find((option) => option.id === value) ?? options[0];
  const currentSize = outputSizeForRatio(current, resolution, protocol);

  const measure = useCallback(() => {
    const trigger = triggerRef.current;
    if (!trigger) return;
    const rect = trigger.getBoundingClientRect();
    const roomBelow = window.innerHeight - rect.bottom - MENU_GAP - MENU_EDGE;
    const roomAbove = rect.top - MENU_GAP - MENU_EDGE;
    // 下面塞不下、上面更宽敞就往上弹；两边都不宽敞时选大的那边，再把高度收进去。
    const openUp = roomBelow < Math.min(MENU_IDEAL_HEIGHT, roomAbove);
    const room = openUp ? roomAbove : roomBelow;
    const maxHeight = Math.max(MENU_MIN_HEIGHT, Math.min(MENU_IDEAL_HEIGHT, room));
    const width = Math.min(Math.max(rect.width, MENU_MIN_WIDTH), window.innerWidth - MENU_EDGE * 2);
    const left = Math.min(Math.max(MENU_EDGE, rect.left), window.innerWidth - width - MENU_EDGE);
    setPlacement(
      openUp
        ? { bottom: window.innerHeight - rect.top + MENU_GAP, left, width, maxHeight, direction: "up" }
        : { top: rect.bottom + MENU_GAP, left, width, maxHeight, direction: "down" },
    );
  }, []);

  useLayoutEffect(() => {
    if (!open) {
      setPlacement(null);
      return;
    }
    measure();
  }, [open, measure]);

  // 卡片内部滚动、窗口缩放时菜单要跟着走（capture 才能收到内层容器的滚动）。
  useEffect(() => {
    if (!open) return;
    const update = () => measure();
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [open, measure]);

  // 点到别处或按 Esc 都收起来。菜单在 body 上，两个容器都要认。
  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (triggerRef.current?.contains(target) || menuRef.current?.contains(target)) return;
      setOpen(false);
    };
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      setOpen(false);
      triggerRef.current?.focus();
    };
    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  // 展开后焦点直接落在当前选中的那一项，键盘上下就能挑。
  useEffect(() => {
    if (!open || !placement) return;
    menuRef.current?.querySelector<HTMLButtonElement>('button[aria-selected="true"]')?.focus();
  }, [open, placement]);

  const moveFocus = (delta: number) => {
    const items = Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>('button[role="option"]') ?? []);
    if (!items.length) return;
    const index = items.findIndex((item) => item === document.activeElement);
    const next = items[Math.min(Math.max((index < 0 ? 0 : index) + delta, 0), items.length - 1)];
    next?.focus();
  };

  const select = (ratioId: string) => {
    onChange(ratioId);
    setOpen(false);
    triggerRef.current?.focus();
  };

  const menu =
    open && placement ? (
      <div
        className={`ratio-picker-menu ${placement.direction}`}
        role="listbox"
        aria-label={ariaLabel}
        ref={menuRef}
        style={{
          top: placement.top,
          bottom: placement.bottom,
          left: placement.left,
          width: placement.width,
          maxHeight: placement.maxHeight,
        }}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown") {
            event.preventDefault();
            moveFocus(1);
          } else if (event.key === "ArrowUp") {
            event.preventDefault();
            moveFocus(-1);
          }
        }}
      >
        {options.map((option) => {
          const size = outputSizeForRatio(option, resolution, protocol);
          // 选了 16:9 却按 3:2 出图这种事，得在选之前就说，别等出图了才发现。
          const mismatch = protocol === "apimart" ? "" : outputSizeMismatch(option);
          return (
            <button
              type="button"
              key={option.id}
              role="option"
              aria-selected={option.id === current.id}
              className={`ratio-picker-item ${option.id === current.id ? "selected" : ""}`}
              title={mismatch || (size.auto ? "由图像接口决定画幅" : `实际交付 ${size.label}`)}
              onClick={() => select(option.id)}
            >
              <RatioGlyph ratio={option} size={22} />
              <span className="ratio-picker-text">
                <strong>{option.label}</strong>
                <small>{size.auto ? "接口决定" : size.label}</small>
                {mismatch ? (
                  <em className="ratio-picker-mismatch">实际按 {deliveredRatioLabel(size.width, size.height)} 出</em>
                ) : null}
              </span>
            </button>
          );
        })}
      </div>
    ) : null;

  return (
    <div className={`ratio-picker ${open ? "open" : ""}`}>
      <button
        type="button"
        ref={triggerRef}
        className="ratio-picker-trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`${ariaLabel}：${current.label}`}
        title={currentSize.auto ? "比例交给图像接口自己定" : `实际交付 ${currentSize.label}`}
        onClick={() => setOpen((value) => !value)}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            setOpen(true);
          }
        }}
      >
        <RatioGlyph ratio={current} size={18} />
        <span className="ratio-picker-value">
          <strong>{current.label}</strong>
          <small>{currentSize.auto ? "接口决定" : currentSize.label}</small>
        </span>
        <i className="ratio-picker-caret" aria-hidden="true" />
      </button>
      {menu ? createPortal(menu, document.body) : null}
    </div>
  );
}
