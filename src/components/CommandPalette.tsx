import { useEffect, useRef, useState } from "react";
import { MagnifyingGlass } from "@phosphor-icons/react";
import type { ThemeMode } from "../runtime/theme";

export interface CommandPaletteItem {
  id: string;
  label: string;
  description: string;
  keywords?: string[];
  shortcut?: string;
  disabled?: boolean;
  onSelect: () => void;
}

interface CommandPaletteProps {
  open: boolean;
  items: CommandPaletteItem[];
  themeMode: ThemeMode;
  onOpen: () => void;
  onClose: () => void;
  onThemeMode: (mode: ThemeMode) => void;
}

export function filterCommandPaletteItems(
  items: CommandPaletteItem[],
  query: string,
): CommandPaletteItem[] {
  const normalized = query.trim().toLocaleLowerCase();
  if (!normalized) return items;
  return items.filter((item) =>
    [item.label, item.description, ...(item.keywords ?? [])].some((value) =>
      value.toLocaleLowerCase().includes(normalized),
    ),
  );
}

export function CommandPalette({
  open,
  items,
  themeMode,
  onOpen,
  onClose,
  onThemeMode,
}: CommandPaletteProps) {
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const dialogRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  const wasOpen = useRef(false);
  const paletteItems: CommandPaletteItem[] = [
    ...items,
    {
      id: "theme-system",
      label: "外观：跟随系统",
      description:
        themeMode === "system"
          ? "当前选择 · 跟随 macOS 外观变化"
          : "跟随 macOS 的浅色或深色外观",
      keywords: ["theme", "appearance", "主题", "system"],
      onSelect: () => onThemeMode("system"),
    },
    {
      id: "theme-light",
      label: "外观：浅色",
      description:
        themeMode === "light" ? "当前选择" : "始终使用 Farfold 浅色外观",
      keywords: ["theme", "appearance", "主题", "light"],
      onSelect: () => onThemeMode("light"),
    },
    {
      id: "theme-dark",
      label: "外观：深色",
      description:
        themeMode === "dark" ? "当前选择" : "始终使用 Farfold 深色外观",
      keywords: ["theme", "appearance", "主题", "dark"],
      onSelect: () => onThemeMode("dark"),
    },
  ];
  const visibleItems = filterCommandPaletteItems(paletteItems, query);

  useEffect(() => {
    function handleShortcut(event: KeyboardEvent) {
      if (
        (event.metaKey || event.ctrlKey) &&
        event.shiftKey &&
        event.key.toLocaleLowerCase() === "p"
      ) {
        event.preventDefault();
        if (open) onClose();
        else onOpen();
      }
    }
    window.addEventListener("keydown", handleShortcut);
    return () => window.removeEventListener("keydown", handleShortcut);
  }, [onClose, onOpen, open]);

  useEffect(() => {
    if (open) {
      previousFocus.current = document.activeElement as HTMLElement | null;
      wasOpen.current = true;
      setQuery("");
      setSelectedIndex(0);
      requestAnimationFrame(() => inputRef.current?.focus());
      return;
    }
    if (!wasOpen.current) return;
    wasOpen.current = false;
    previousFocus.current?.focus();
  }, [open]);

  useEffect(() => setSelectedIndex(0), [query]);

  if (!open) return null;

  function runItem(item: CommandPaletteItem | undefined) {
    if (!item || item.disabled) return;
    onClose();
    requestAnimationFrame(item.onSelect);
  }

  return (
    <div
      className="command-palette-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className="command-palette"
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="命令面板"
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            onClose();
            return;
          }
          if (event.key === "ArrowDown" && visibleItems.length) {
            event.preventDefault();
            setSelectedIndex((current) =>
              Math.min(current + 1, visibleItems.length - 1),
            );
            return;
          }
          if (event.key === "ArrowUp" && visibleItems.length) {
            event.preventDefault();
            setSelectedIndex((current) => Math.max(current - 1, 0));
            return;
          }
          if (event.key === "Enter") {
            event.preventDefault();
            runItem(visibleItems[selectedIndex]);
            return;
          }
          if (event.key !== "Tab") return;
          const focusable = Array.from(
            dialogRef.current?.querySelectorAll<HTMLElement>(
              "input, button:not([disabled])",
            ) ?? [],
          );
          if (!focusable.length) return;
          const currentIndex = focusable.indexOf(
            document.activeElement as HTMLElement,
          );
          const nextIndex = event.shiftKey
            ? currentIndex <= 0
              ? focusable.length - 1
              : currentIndex - 1
            : currentIndex === focusable.length - 1
              ? 0
              : currentIndex + 1;
          event.preventDefault();
          focusable[nextIndex]?.focus();
        }}
      >
        <label className="command-palette-search">
          <MagnifyingGlass size={18} aria-hidden="true" />
          <input
            ref={inputRef}
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="输入命令或操作…"
            aria-label="搜索命令"
            role="combobox"
            aria-controls="farfold-command-palette-results"
            aria-expanded="true"
            aria-activedescendant={
              visibleItems[selectedIndex]
                ? `farfold-command-${visibleItems[selectedIndex].id}`
                : undefined
            }
          />
          <kbd>Esc</kbd>
        </label>
        <div
          className="command-palette-results"
          id="farfold-command-palette-results"
          role="listbox"
          aria-label="可用命令"
        >
          {visibleItems.length ? (
            visibleItems.map((item, index) => (
              <button
                id={`farfold-command-${item.id}`}
                key={item.id}
                type="button"
                role="option"
                aria-selected={index === selectedIndex}
                className={index === selectedIndex ? "selected" : ""}
                disabled={item.disabled}
                onMouseEnter={() => setSelectedIndex(index)}
                onClick={() => runItem(item)}
              >
                <span>
                  <strong>{item.label}</strong>
                  <small>{item.description}</small>
                </span>
                {item.shortcut && <kbd>{item.shortcut}</kbd>}
              </button>
            ))
          ) : (
            <p>没有匹配的命令</p>
          )}
        </div>
        <footer>
          <span>↑↓ 选择</span>
          <span>↵ 执行</span>
          <span>⌘⇧P 打开或关闭</span>
        </footer>
      </div>
    </div>
  );
}
