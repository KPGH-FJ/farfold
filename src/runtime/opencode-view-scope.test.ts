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

import { OpenCodeActivityReadScope } from "./opencode-view-scope";

describe("OpenCode activity reads", () => {
  it("prevents a slow pre-Stop unknown result from overwriting a newer idle read", async () => {
    const scope = new OpenCodeActivityReadScope();
    let finishOlder!: () => void;
    let displayed = "working";
    const older = scope.begin();
    const slow = new Promise<void>((resolve) => {
      finishOlder = resolve;
    }).then(() => {
      if (scope.isCurrent(older)) displayed = "unknown";
    });
    const afterStop = scope.begin();
    if (scope.isCurrent(afterStop)) displayed = "idle";
    finishOlder();
    await slow;
    expect(displayed).toBe("idle");
  });
  it("lets a later native activity event invalidate an outstanding HTTP read", () => {
    const scope = new OpenCodeActivityReadScope();
    const read = scope.begin();
    scope.invalidate();
    expect(scope.isCurrent(read)).toBe(false);
    expect(scope.isCurrent(scope.begin())).toBe(true);
  });
});
