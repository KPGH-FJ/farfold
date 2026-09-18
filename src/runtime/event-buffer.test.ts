import { describe, expect, it } from "vitest";
import { appendBounded } from "./event-buffer";
import { parseExtensionUiRequest } from "./pi";

describe("appendBounded", () => {
  it("retains only the newest runtime events", () => {
    expect(appendBounded([1, 2, 3], 4, 3)).toEqual([2, 3, 4]);
  });

  it("rejects a non-positive limit", () => {
    expect(() => appendBounded([], "event", 0)).toThrow(RangeError);
  });
});

describe("runtime event isolation", () => {
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
