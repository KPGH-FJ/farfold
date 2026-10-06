/**
 * 可搜索模型选择器（替代原生 <select>）：
 * 分组显示（option.group 优先，否则按 name 的 `provider/` 前缀分组），
 * 搜索框过滤 name/value/group，↑↓/Enter/Esc 键盘操作。
 * 面板用 fixed 定位 + 按钮矩形计算，不被 overflow 容器（sw-panel）裁剪。
 */
import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { ConfigChoice, ConfigOptionView } from "../runtime/sessions";
import { STRINGS } from "../runtime/strings";

function groupOf(choice: ConfigChoice): string {
  if (choice.group) return choice.group;
  const idx = choice.name.indexOf("/");
  return idx > 0 ? choice.name.slice(0, idx) : "";
}

export function ModelPicker({
  option,
  disabled,
  className,
  label,
  onPick,
}: {
  option: ConfigOptionView | null;
  disabled?: boolean;
  className?: string;
  label?: string;
  onPick: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [hi, setHi] = useState(0);
  const [pos, setPos] = useState<{ top: number; left: number; width: number }>({
    top: 0,
    left: 0,
    width: 280,
  });
  const rootRef = useRef<HTMLDivElement | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const listId = useId();

  const options = useMemo(() => option?.options ?? [], [option]);
  const current =
    option && typeof option.currentValue === "string"
      ? option.currentValue
      : "";
  const currentName =
    options.find((o) => o.value === current)?.name ??
    (current || STRINGS.switcher.defaultModel);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options;
    return options.filter(
      (o) =>
        o.name.toLowerCase().includes(q) ||
        o.value.toLowerCase().includes(q) ||
        groupOf(o).toLowerCase().includes(q),
    );
  }, [options, query]);

  /** 有序（分组内原序）扁平列表 + 组边界，供渲染与键盘导航共用。 */
  const flat = useMemo(() => {
    const out: { choice: ConfigChoice; group: string; first: boolean }[] = [];
    let lastGroup = "";
    for (const choice of filtered) {
      const group = groupOf(choice);
      out.push({ choice, group, first: group !== lastGroup });
      lastGroup = group;
    }
    return out;
  }, [filtered]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [open]);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  if (!option || option.type !== "select" || options.length === 0) {
    return <span className="sw-sel">{STRINGS.switcher.defaultModel}</span>;
  }

  const openPanel = () => {
    if (disabled) return;
    const rect = rootRef.current?.getBoundingClientRect();
    if (rect) {
      const width = Math.min(Math.max(rect.width, 260), 340);
      const left = Math.min(rect.left, window.innerWidth - width - 12);
      const top =
        rect.bottom + 360 > window.innerHeight
          ? Math.max(8, rect.top - 360 - 4)
          : rect.bottom + 4;
      setPos({ top, left, width });
    }
    setQuery("");
    setHi(0);
    setOpen(true);
  };

  const pick = (value: string) => {
    if (disabled) return;
    setOpen(false);
    buttonRef.current?.focus();
    onPick(value);
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.nativeEvent.isComposing) return;
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
      buttonRef.current?.focus();
      return;
    }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const next = Math.min(
        Math.max(hi + (e.key === "ArrowDown" ? 1 : -1), 0),
        flat.length - 1,
      );
      setHi(next);
      listRef.current
        ?.querySelector(`[data-idx="${next}"]`)
        ?.scrollIntoView({ block: "nearest" });
      return;
    }
    if (e.key === "Enter" && flat[hi]) {
      e.preventDefault();
      pick(flat[hi].choice.value);
    }
  };
  const searchLabel =
    option.category === "model" || option.id === "model"
      ? STRINGS.switcher.modelSearch
      : STRINGS.switcher.optionSearch;
  const accessibleLabel = label ?? option.name;

  return (
    <div className={`mp${className ? ` ${className}` : ""}`} ref={rootRef}>
      <button
        ref={buttonRef}
        type="button"
        className="mp-btn"
        disabled={disabled}
        aria-label={`${accessibleLabel}: ${currentName}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        onClick={() => (open ? setOpen(false) : openPanel())}
        title={currentName}
      >
        <span className="mp-label">{currentName}</span>
        <span className="chev">▾</span>
      </button>
      {open && (
        <div
          className="mp-panel"
          style={{ top: pos.top, left: pos.left, width: pos.width }}
        >
          <input
            ref={inputRef}
            className="mp-search"
            role="combobox"
            aria-label={searchLabel}
            aria-autocomplete="list"
            aria-expanded={open}
            aria-controls={listId}
            aria-activedescendant={
              flat[hi] ? `${listId}-option-${hi}` : undefined
            }
            value={query}
            placeholder={searchLabel}
            onChange={(e) => {
              setQuery(e.target.value);
              setHi(0);
            }}
            onKeyDown={onKey}
          />
          <div
            className="mp-list"
            ref={listRef}
            id={listId}
            role="listbox"
            aria-label={accessibleLabel}
          >
            {flat.length === 0 && (
              <div className="mp-empty">{STRINGS.palette.empty}</div>
            )}
            {flat.map((entry, idx) => (
              <div key={entry.choice.value}>
                {entry.first && entry.group && (
                  <div className="mp-group">{entry.group}</div>
                )}
                <div
                  id={`${listId}-option-${idx}`}
                  role="option"
                  aria-label={entry.choice.name}
                  aria-selected={entry.choice.value === current}
                  aria-disabled={disabled === true}
                  data-idx={idx}
                  className={`mp-opt${idx === hi ? " hi" : ""}${entry.choice.value === current ? " cur" : ""}`}
                  onMouseEnter={() => setHi(idx)}
                  onClick={() => pick(entry.choice.value)}
                >
                  <span className="mp-name">{entry.choice.name}</span>
                  {entry.choice.value === current && (
                    <span className="mp-check">✓</span>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
