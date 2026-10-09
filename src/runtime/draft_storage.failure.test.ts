import { beforeEach, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: h.invoke }));
beforeEach(() => {
  vi.resetModules();
  h.invoke.mockReset();
});

it.each([
  ["readOnly", "只读"],
  ["full", "空间不足"],
  ["corrupt", "无法读取"],
])(
  "keeps the latest input and explains %s, then saves only on retry",
  async (code, text) => {
    let disk = { text: "saved" };
    let current = disk;
    h.invoke.mockImplementation(async (command, input) => {
      if (command === "settings_get") return disk;
      if (command === "settings_set")
        throw `FARFOLD_STORAGE:${code}:test failure`;
    });
    const { draftPersistence: d } = await import("./draft_storage");
    d.configure(
      () => current,
      (value) => {
        current = value as typeof current;
      },
    );
    await d.load();
    current = { text: "latest unsaved input" };
    d.changed();
    await expect(d.flush()).rejects.toThrow(text);
    expect(d.snapshot().error).toContain(text);
    expect(current.text).toBe("latest unsaved input");
    expect(disk.text).toBe("saved");
    h.invoke.mockImplementation(async (command, input) => {
      if (command === "settings_set") disk = input.value;
    });
    await d.flush();
    expect(disk.text).toBe("latest unsaved input");
  },
);
