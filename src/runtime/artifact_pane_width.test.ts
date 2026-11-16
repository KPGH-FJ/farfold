import { invoke } from "@tauri-apps/api/core";
import { beforeEach, expect, it, vi } from "vitest";
import { ArtifactPaneWidthPreference } from "./artifact_pane_width";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const ipc = vi.mocked(invoke);
beforeEach(() => {
  ipc.mockReset();
});

it.each([
  [null, 510],
  ["585", 510],
  [100, 320],
  [900, 720],
  [585, 585],
])("reads stored width %s as %s without rewriting it", async (saved, width) => {
  ipc.mockResolvedValue(saved);
  const preference = new ArtifactPaneWidthPreference();
  await preference.load();
  expect(preference.getSnapshot()).toEqual({ width, ready: true, error: null });
  expect(ipc).toHaveBeenCalledExactlyOnceWith("settings_get", {
    key: "artifactPaneWidth",
  });
});

it("protects the old preference when reading fails and allows a retry", async () => {
  ipc.mockRejectedValueOnce(new Error("read failed")).mockResolvedValue(520);
  const preference = new ArtifactPaneWidthPreference();
  const reading = preference.load();
  expect(preference.load()).toBe(reading);
  preference.resize(560);
  await reading;
  expect(preference.getSnapshot()).toEqual({
    width: 510,
    ready: false,
    error: "load",
  });
  expect(ipc).toHaveBeenCalledTimes(1);
  await preference.load();
  expect(preference.getSnapshot()).toEqual({
    width: 520,
    ready: true,
    error: null,
  });
});

it("keeps the last confirmed width when a later write fails and restores a retried write on restart", async () => {
  let saved = 510;
  let settleFirstSave!: () => void;
  let shouldFail = true;
  ipc.mockImplementation(async (command, args) => {
    if (command === "settings_get") return saved;
    const target = (args as { value: number }).value;
    if (target === 534) {
      await new Promise<void>((resolve) => {
        settleFirstSave = resolve;
      });
    }
    if (target === 606 && shouldFail) throw new Error("disk unavailable");
    saved = target;
    return undefined;
  });
  const preference = new ArtifactPaneWidthPreference();
  await preference.load();
  preference.resize(534);
  preference.resize(558);
  preference.resize(606);
  expect(ipc.mock.calls.map(([, args]) => args)).toEqual([
    { key: "artifactPaneWidth" },
    { key: "artifactPaneWidth", value: 534 },
  ]);
  settleFirstSave();
  await vi.waitFor(() =>
    expect(preference.getSnapshot()).toEqual({
      width: 534,
      ready: true,
      error: "save",
    }),
  );
  expect(saved).toBe(534);
  expect(ipc).toHaveBeenLastCalledWith("settings_set", {
    key: "artifactPaneWidth",
    value: 606,
  });

  shouldFail = false;
  preference.resize(606);
  expect(preference.getSnapshot().error).toBeNull();
  const restarted = new ArtifactPaneWidthPreference();
  await restarted.load();
  expect(restarted.getSnapshot().width).toBe(606);
});
