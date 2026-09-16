import { describe, expect, it, vi } from "vitest";
import {
  hasLoadedModel,
  readPiModelReferences,
  selectPiRuntimeModel,
} from "./pi-model-selection";

const target = { provider: "zai", id: "glm-4.5-air" };

describe("Pi native model activation", () => {
  it("keeps Provider identity and rejects unverified catalogs", () => {
    expect(hasLoadedModel([{ ...target, provider: "other" }], target)).toBe(
      false,
    );
    expect(
      readPiModelReferences({ success: true, data: { models: [target] } }),
    ).toEqual([target]);
    for (const invalid of [
      null,
      {},
      { success: false },
      { success: true, data: { models: [null] } },
    ])
      expect(() => readPiModelReferences(invalid)).toThrow();
  });

  it("selects a loaded model without restarting the Session", async () => {
    const reloadSession = vi.fn();
    const select = vi.fn();
    await selectPiRuntimeModel(target, {
      readModels: async () => [target],
      reloadSession,
      select,
    });
    expect(reloadSession).not.toHaveBeenCalled();
    expect(select).toHaveBeenCalledWith(target);
  });

  it("rechecks the native catalog after reloading before selecting", async () => {
    const events: string[] = [];
    let loaded = false;
    await selectPiRuntimeModel(target, {
      readModels: async () => {
        events.push("read");
        return loaded ? [target] : [];
      },
      reloadSession: async () => {
        events.push("reload");
        loaded = true;
      },
      select: async () => {
        events.push("select");
      },
    });
    expect(events).toEqual(["read", "reload", "read", "select"]);
  });

  it("never selects a fallback or retries when reload fails or the model is still absent", async () => {
    for (const failure of [false, true]) {
      const select = vi.fn();
      const reloadSession = vi.fn(async () => {
        if (failure) throw new Error("native Session missing");
      });
      await expect(
        selectPiRuntimeModel(target, {
          readModels: async () => [],
          reloadSession,
          select,
        }),
      ).rejects.toThrow();
      expect(reloadSession).toHaveBeenCalledTimes(1);
      expect(select).not.toHaveBeenCalled();
    }
  });
});
