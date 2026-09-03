import { describe, expect, it, vi } from "vitest";
import {
  filterCommandPaletteItems,
  type CommandPaletteItem,
} from "./CommandPalette";

const items: CommandPaletteItem[] = [
  {
    id: "new-session",
    label: "新对话",
    description: "通过 Pi 创建原生 Session",
    keywords: ["session", "create"],
    onSelect: vi.fn(),
  },
  {
    id: "runtime",
    label: "切换到 OpenCode",
    description: "切换工作区，不移植 Session",
    keywords: ["runtime"],
    onSelect: vi.fn(),
  },
];

describe("filterCommandPaletteItems", () => {
  it("searches labels, descriptions, and explicit keywords", () => {
    expect(filterCommandPaletteItems(items, "新对话")).toEqual([items[0]]);
    expect(filterCommandPaletteItems(items, "工作区")).toEqual([items[1]]);
    expect(filterCommandPaletteItems(items, "runtime")).toEqual([items[1]]);
    expect(filterCommandPaletteItems(items, "missing")).toEqual([]);
  });

  it("preserves declared command order when no query is present", () => {
    expect(filterCommandPaletteItems(items, "  ")).toEqual(items);
  });
});
