import { expect, it, vi } from "vitest";
import { createFileDropHandler } from "./composer_file_drop";

function setup() {
  let owner = { key: "draft-a", generation: 1, enabled: true };
  let visible = true;
  const add = vi.fn();
  const highlight = vi.fn();
  const handler = createFileDropHandler({
    owner: () => owner,
    accepts: ({ x, y }) =>
      visible && x >= 100 && x <= 300 && y >= 200 && y <= 400,
    highlight,
    add,
  });
  const enter = () =>
    handler({ type: "enter", paths: ["/a.txt"], position: { x: 110, y: 210 } });
  const drop = () =>
    handler({
      type: "drop",
      paths: ["/a.txt", "/b.txt"],
      position: { x: 110, y: 210 },
    });
  return {
    handler,
    enter,
    drop,
    add,
    highlight,
    owner: () => owner,
    setOwner: (next: typeof owner) => {
      owner = next;
    },
    hide: () => {
      visible = false;
    },
  };
}
it("adds only a drop over the currently visible input without sending", () => {
  const s = setup();
  s.enter();
  expect(s.add).not.toHaveBeenCalled();
  expect(s.highlight).toHaveBeenLastCalledWith(true);
  s.drop();
  expect(s.add).toHaveBeenCalledExactlyOnceWith("draft-a", [
    "/a.txt",
    "/b.txt",
  ]);
  expect(s.highlight).toHaveBeenLastCalledWith(false);
  s.drop();
  expect(s.add).toHaveBeenCalledTimes(1);
});
it.each(["key", "generation", "enabled"] as const)(
  "does not transfer an in-flight gesture when %s changes",
  (field) => {
    const s = setup();
    s.enter();
    s.setOwner({
      ...s.owner(),
      [field]: field === "key" ? "draft-b" : field === "generation" ? 2 : false,
    });
    s.drop();
    expect(s.add).not.toHaveBeenCalled();
    expect(s.highlight).toHaveBeenLastCalledWith(false);
  },
);
it("does not import through a covering dialog, hidden input or another surface", () => {
  const s = setup();
  s.enter();
  s.hide();
  s.drop();
  expect(s.add).not.toHaveBeenCalled();
});
it("tracks crossing the input edge and clears on cancelled native drag", () => {
  const s = setup();
  s.enter();
  s.handler({ type: "over", position: { x: 90, y: 210 } });
  expect(s.highlight).toHaveBeenLastCalledWith(false);
  s.handler({ type: "over", position: { x: 110, y: 210 } });
  expect(s.highlight).toHaveBeenLastCalledWith(true);
  s.handler({ type: "leave" });
  s.drop();
  expect(s.add).not.toHaveBeenCalled();
});
it("ignores malformed, empty and non-file paths before any import", () => {
  const s = setup();
  for (const paths of [
    [],
    ["https://example.org/a"],
    ["relative.txt"],
    ["/good", ""],
  ]) {
    s.enter();
    s.handler({ type: "drop", paths, position: { x: 110, y: 210 } });
  }
  expect(s.add).not.toHaveBeenCalled();
});
it("accepts Windows paths as paths rather than URLs", () => {
  const s = setup();
  s.enter();
  s.handler({
    type: "drop",
    paths: ["C:\\work\\a.txt", "\\\\server\\share\\b.txt"],
    position: { x: 110, y: 210 },
  });
  expect(s.add).toHaveBeenCalledExactlyOnceWith("draft-a", [
    "C:\\work\\a.txt",
    "\\\\server\\share\\b.txt",
  ]);
});
