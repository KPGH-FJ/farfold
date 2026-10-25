import {
  Children,
  isValidElement,
  type ReactElement,
  type ReactNode,
} from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { WorkspaceAccessDecisionReview } from "./WorkspaceAccessDecisionReview";
import { WORKSPACE_ACCESS as S } from "../runtime/workspace_access_strings";
import type { WorkspaceAccessDecision } from "../runtime/workspace_access_types";

function fixture(
  decision: WorkspaceAccessDecision = "trust_cwd",
  pending = false,
) {
  const onBack = vi.fn();
  const onConfirm = vi.fn();
  const tree = WorkspaceAccessDecisionReview({
    snapshot: {
      phase: pending ? "submitting" : "review",
      decision,
      scope: {
        cwd: "/owned",
        repoRoot: "/project",
        repoScopeVerified: true,
        offeredDecisions: [decision],
      },
    },
    blocked: false,
    onBack,
    onConfirm,
  });
  const nodes = (value: ReactNode): ReactElement<Record<string, unknown>>[] =>
    Children.toArray(value).flatMap((child) =>
      isValidElement<Record<string, unknown>>(child)
        ? [child, ...nodes(child.props.children as ReactNode)]
        : [],
    );
  return {
    tree,
    onBack,
    onConfirm,
    buttons: nodes(tree).filter((node) => node.type === "button"),
    html: renderToStaticMarkup(tree),
  };
}
it.each(["trust_cwd", "trust_repo", "decline"] as const)(
  "reviews the real scope and persistence before a separate %s confirmation",
  (decision) => {
    const f = fixture(decision);
    expect(f.html).toContain(decision === "trust_repo" ? "/project" : "/owned");
    expect(f.html).toContain(S.scope);
    expect(f.html).toContain(S.persistent);
    expect(f.html).toContain(
      decision === "decline" ? S.declineEffect : S.grantEffect,
    );
    expect(f.onConfirm).not.toHaveBeenCalled();
    expect(f.buttons.every((button) => !button.props.autoFocus)).toBe(true);
    (f.buttons[0].props.onClick as () => void)();
    expect(f.onBack).toHaveBeenCalledOnce();
    expect(f.onConfirm).not.toHaveBeenCalled();
    (f.buttons[1].props.onClick as () => void)();
    expect(f.onConfirm).toHaveBeenCalledOnce();
  },
);
it("locks the two review actions while the store operation is pending without claiming cancellation", () => {
  const f = fixture("trust_cwd", true);
  expect(f.html).toContain(S.deciding);
  expect(f.buttons.every((button) => button.props.disabled === true)).toBe(
    true,
  );
  expect(f.onConfirm).not.toHaveBeenCalled();
  expect(f.onBack).not.toHaveBeenCalled();
});
