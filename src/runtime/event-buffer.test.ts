import { describe, expect, it } from "vitest";
import { appendBounded } from "./event-buffer";
import {
  acceptsRuntimeEvent,
  lifecycleFailureMessage,
  parseExtensionUiRequest,
} from "./pi";

describe("appendBounded", () => {
  it("retains only the newest runtime events", () => {
    expect(appendBounded([1, 2, 3], 4, 3)).toEqual([2, 3, 4]);
  });

  it("rejects a non-positive limit", () => {
    expect(() => appendBounded([], "event", 0)).toThrow(RangeError);
  });
});

describe("runtime event isolation", () => {
  it("drops events from an older Pi generation", () => {
    expect(acceptsRuntimeEvent(4, { generation: 3 })).toBe(false);
    expect(acceptsRuntimeEvent(4, { generation: 4 })).toBe(true);
    expect(acceptsRuntimeEvent(4, { generation: 5 })).toBe(true);
  });

  it("does not report an intentional stop as a failure", () => {
    expect(
      lifecycleFailureMessage({ state: "terminated", reason: "stopped" }),
    ).toBeNull();
    expect(
      lifecycleFailureMessage({
        state: "terminated",
        reason: "exited",
        code: 1,
      }),
    ).toContain("异常退出");
  });

  it("accepts only documented extension dialog shapes", () => {
    expect(
      parseExtensionUiRequest({
        type: "extension_ui_request",
        id: "dialog-1",
        method: "select",
        title: "Choose",
        options: ["A", "B"],
      }),
    ).toMatchObject({ id: "dialog-1", method: "select" });
    expect(
      parseExtensionUiRequest({
        type: "extension_ui_request",
        id: "dialog-2",
        method: "select",
        title: "Choose",
      }),
    ).toBeNull();
    expect(
      parseExtensionUiRequest({
        type: "extension_ui_request",
        id: "dialog-3",
        method: "custom",
      }),
    ).toBeNull();
  });
});
