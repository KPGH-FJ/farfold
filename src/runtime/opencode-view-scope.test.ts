import { describe, expect, it } from "vitest";
import { OpenCodeViewScope } from "./opencode-view-scope";

describe("OpenCode workspace reconciliation scope", () => {
  it("rejects old queued work and late failures after a new Session opens", async () => {
    const scope = new OpenCodeViewScope();
    const oldSession = scope.capture();
    const queued = Promise.resolve().then(() => scope.isCurrent(oldSession));
    scope.pause();
    expect(scope.capture()).toBeNull();
    scope.resume();
    expect(await queued).toBe(false);
    expect(scope.isCurrent(oldSession)).toBe(false);
    expect(scope.isCurrent(scope.capture())).toBe(true);
  });

  it("does not invalidate same-session background events or view-only focus", () => {
    const scope = new OpenCodeViewScope();
    const request = scope.capture();
    expect(scope.isCurrent(request)).toBe(true);
    expect(scope.isCurrent(scope.capture())).toBe(true);
    scope.pause();
    expect(scope.isCurrent(request)).toBe(false);
    expect(scope.isCurrent(null)).toBe(false);
  });
});
