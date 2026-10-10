import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
vi.mock("../runtime/sessions", () => ({
  useThreadsSnapshot: () => ({ version: 1, threads: new Map(), index: [] }),
}));
vi.mock("../runtime/collections", () => ({
  useCollections: () => ({ groups: [], assignments: {} }),
}));
import { CommandPalette } from "./CommandPalette";

it("offers explicit metadata and loaded-body scopes without opening a conversation", () => {
  const onSelect = vi.fn();
  const html = renderToStaticMarkup(
    <CommandPalette agents={[]} onClose={() => {}} onSelect={onSelect} />,
  );
  expect(html).toContain("已加载正文");
  expect(html).toContain("对话资料");
  expect(onSelect).not.toHaveBeenCalled();
});
