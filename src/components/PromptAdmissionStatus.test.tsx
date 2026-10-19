import {
  Children,
  isValidElement,
  type ReactElement,
  type ReactNode,
} from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, it, vi } from "vitest";
import { freshThreadState } from "../runtime/session_projection";
const h = vi.hoisted(() => ({ cancel: vi.fn() }));
vi.mock("../runtime/sessions", () => ({ threads: { cancel: h.cancel } }));
import { PromptAdmissionStatus } from "./PromptAdmissionStatus";
import { PROMPT_ADMISSION as S } from "../runtime/prompt_admission_strings";
function elements(node: ReactNode): ReactElement<Record<string, unknown>>[] {
  const result: ReactElement<Record<string, unknown>>[] = [];
  Children.forEach(node, (value) => {
    if (isValidElement<Record<string, unknown>>(value))
      result.push(value, ...elements(value.props.children as ReactNode));
  });
  return result;
}
beforeEach(() => h.cancel.mockReset());
it("uses the shared status row and keeps cancellation reachable while waiting", () => {
  const thread = freshThreadState("owned", "a", "/owned", "s");
  thread.submitting = true;
  thread.promptAdmission = { phase: "waiting", cancelling: false };
  const tree = PromptAdmissionStatus({ thread, active: true });
  const html = renderToStaticMarkup(tree);
  expect(html).toContain('role="status"');
  expect(html).toContain(S.waiting);
  const button = elements(tree).find((node) => node.type === "button")!;
  expect(button.props.disabled).toBe(false);
  (button.props.onClick as () => void)();
  expect(h.cancel).toHaveBeenCalledWith("owned");
  thread.promptAdmission.cancelling = true;
  expect(
    renderToStaticMarkup(<PromptAdmissionStatus thread={thread} active />),
  ).toContain(S.cancelling);
});
it("does not confuse a hidden view or actual Agent work with waiting", () => {
  const thread = freshThreadState("owned", "a", "/owned", "s");
  thread.submitting = true;
  thread.promptAdmission = { phase: "waiting", cancelling: false };
  expect(PromptAdmissionStatus({ thread, active: false })).toBeNull();
  thread.promptAdmission.phase = "offered";
  expect(PromptAdmissionStatus({ thread, active: true })).toBeNull();
  thread.submitting = false;
  thread.promptAdmission = null;
  expect(PromptAdmissionStatus({ thread, active: true })).toBeNull();
});
