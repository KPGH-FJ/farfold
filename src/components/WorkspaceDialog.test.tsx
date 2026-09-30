import { expect, it, vi } from "vitest";
import type { ReactElement } from "react";
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useEffect: () => {},
  useRef: (current: unknown) => ({ current }),
}));
import { WorkspaceDialog } from "./WorkspaceDialog";
it("consumes only its own native cancel event before React can close an enclosing dialog", () => {
  const close = vi.fn();
  const node = WorkspaceDialog({
    title: "Account guide",
    onClose: close,
    children: null,
  }) as ReactElement<{ onCancel(event: unknown): void }>;
  const parent = {},
    child = {},
    preventDefault = vi.fn(),
    stopPropagation = vi.fn();
  node.props.onCancel({
    target: child,
    currentTarget: parent,
    preventDefault,
    stopPropagation,
  });
  expect(close).not.toHaveBeenCalled();
  node.props.onCancel({
    target: child,
    currentTarget: child,
    preventDefault,
    stopPropagation,
  });
  expect(preventDefault).toHaveBeenCalledOnce();
  expect(stopPropagation).toHaveBeenCalledOnce();
  expect(close).toHaveBeenCalledOnce();
});
