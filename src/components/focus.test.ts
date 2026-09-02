import { describe, expect, it, vi } from "vitest";
import { canRestoreFocus, type FocusCandidate } from "./focus";

function candidate(isConnected: boolean, interactive: boolean): FocusCandidate {
  return {
    isConnected,
    matches: vi.fn(() => interactive),
  };
}

describe("canRestoreFocus", () => {
  it("rejects a connected page root so a dialog can use its trigger fallback", () => {
    expect(canRestoreFocus(candidate(true, false))).toBe(false);
  });

  it("accepts a connected interactive trigger", () => {
    expect(canRestoreFocus(candidate(true, true))).toBe(true);
  });

  it("rejects an interactive element removed with the dialog", () => {
    expect(canRestoreFocus(candidate(false, true))).toBe(false);
  });
});
