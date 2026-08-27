import { describe, expect, it } from "vitest";
import { appendBounded } from "./event-buffer";

describe("appendBounded", () => {
  it("retains only the newest runtime events", () => {
    expect(appendBounded([1, 2, 3], 4, 3)).toEqual([2, 3, 4]);
  });

  it("rejects a non-positive limit", () => {
    expect(() => appendBounded([], "event", 0)).toThrow(RangeError);
  });
});
