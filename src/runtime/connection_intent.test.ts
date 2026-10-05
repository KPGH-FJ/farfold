import { afterEach, describe, expect, it } from "vitest";
import {
  allowAutomaticConnection,
  isAutomaticConnectionAllowed,
  pauseAutomaticConnection,
  subscribeConnectionIntent,
} from "./connection_intent";

afterEach(() => {
  allowAutomaticConnection("intent-a");
  allowAutomaticConnection("intent-b");
});

describe("explicit connection intent", () => {
  it("blocks incidental opens after disconnect, until an explicit use", () => {
    expect(isAutomaticConnectionAllowed("intent-a")).toBe(true);
    pauseAutomaticConnection("intent-a");
    expect(isAutomaticConnectionAllowed("intent-a")).toBe(false);
    expect(isAutomaticConnectionAllowed("intent-b")).toBe(true);
    allowAutomaticConnection("intent-a");
    expect(isAutomaticConnectionAllowed("intent-a")).toBe(true);
  });

  it("rolls back a failed disconnect without undoing a later user action", () => {
    const rollback = pauseAutomaticConnection("intent-a");
    rollback();
    expect(isAutomaticConnectionAllowed("intent-a")).toBe(true);
    const staleRollback = pauseAutomaticConnection("intent-a");
    allowAutomaticConnection("intent-a");
    pauseAutomaticConnection("intent-a");
    staleRollback();
    expect(isAutomaticConnectionAllowed("intent-a")).toBe(false);
  });

  it("notifies mounted consumers only when permission changes", () => {
    let changes = 0;
    const unsubscribe = subscribeConnectionIntent(() => changes++);
    const rollback = pauseAutomaticConnection("intent-a");
    pauseAutomaticConnection("intent-a");
    rollback();
    expect(changes).toBe(1);
    allowAutomaticConnection("intent-a");
    expect(changes).toBe(2);
    unsubscribe();
    pauseAutomaticConnection("intent-a");
    expect(changes).toBe(2);
  });
});
