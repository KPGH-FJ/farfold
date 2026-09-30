import { beforeEach, expect, it, vi } from "vitest";
const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
import { loadThemePreference, saveThemePreference } from "./theme";

beforeEach(() => invoke.mockReset());

it("imports the old preference only after the metadata write succeeds", async () => {
  const storage = { getItem: vi.fn(() => "dark"), removeItem: vi.fn() };
  invoke
    .mockResolvedValueOnce(null)
    .mockRejectedValueOnce(new Error("disk full"));
  await expect(loadThemePreference(storage)).rejects.toThrow("disk full");
  expect(storage.removeItem).not.toHaveBeenCalled();
  invoke.mockResolvedValueOnce(null).mockResolvedValueOnce(null);
  await expect(loadThemePreference(storage)).resolves.toBe("dark");
  expect(invoke).toHaveBeenLastCalledWith("settings_set", {
    key: "themeMode",
    value: "dark",
  });
  expect(storage.removeItem).toHaveBeenCalledWith("farfold.theme-mode");
});

it("uses metadata when present and never falls back to an old preference", async () => {
  const storage = { getItem: vi.fn(() => "dark"), removeItem: vi.fn() };
  invoke.mockResolvedValueOnce("system");
  await expect(loadThemePreference(storage)).resolves.toBe("system");
  expect(storage.getItem).not.toHaveBeenCalled();
  await saveThemePreference("light");
  expect(invoke).toHaveBeenLastCalledWith("settings_set", {
    key: "themeMode",
    value: "light",
  });
});

it("cannot let duplicate initialization overwrite a later user choice", async () => {
  let saved: string | null = null;
  let darkWrites = 0;
  let finishLateMigration: (() => void) | undefined;
  invoke.mockImplementation(
    async (command: string, args: { value?: string }) => {
      if (command === "settings_get") return null;
      if (command !== "settings_set") return undefined;
      if (args.value === "dark" && ++darkWrites === 2) {
        await new Promise<void>((resolve) => {
          finishLateMigration = resolve;
        });
      }
      saved = args.value ?? null;
    },
  );
  const storage = { getItem: () => "dark", removeItem: () => {} };
  const first = loadThemePreference(storage);
  const duplicate = loadThemePreference(storage);
  await first;
  await saveThemePreference("light");
  finishLateMigration?.();
  await duplicate;
  expect(saved).toBe("light");
});
