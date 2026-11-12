import { beforeEach, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
const h = vi.hoisted(() => ({ snapshot: {} as any, current: true }));
vi.mock("../runtime/sessions", () => ({
  threads: {
    thread: () => undefined,
    toolChanges: { resolveRecovery: vi.fn() },
  },
}));
vi.mock("../runtime/session_tool_recovery_controller", () => ({
  SessionToolRecoveryController: class {
    subscribe = () => () => {};
    getSnapshot = () => h.snapshot;
    isCurrent = () => h.current;
    blocked = false;
    inspect() {}
    confirm() {}
  },
}));
import { SessionToolRecovery } from "./SessionToolRecovery";
import { freshThreadState } from "../runtime/session_projection";
import { TOOL_RECOVERY as S } from "../runtime/session_tool_recovery_strings";
function render() {
  const thread = freshThreadState("owned", "fixture", "/owned", "native");
  thread.sessionToolRecoveryRequired = true;
  return renderToStaticMarkup(<SessionToolRecovery thread={thread} />);
}
beforeEach(() => {
  h.current = true;
  h.snapshot = {
    phase: "review",
    error: null,
    confirmationUnresolved: false,
    inspection: {
      outcome: "changed",
      resolution: "acceptCurrent",
      canConfirm: true,
      configuration: {
        complete: true,
        items: [
          { name: "First", kind: "http", address: "http://127.0.0.1:8910/" },
          {
            name: "Second",
            kind: "http",
            address: "http://127.0.0.1:8910/mcp",
          },
        ],
      },
    },
  };
});
it("shows both complete addresses and a separate explicit acceptance action", () => {
  const html = render();
  expect(html).toContain("http://127.0.0.1:8910/");
  expect(html).toContain("http://127.0.0.1:8910/mcp");
  expect(html).toContain(S.acceptCurrent);
  expect(html).toContain(S.currentSettings);
  expect(html).not.toContain(`>${S.confirm}<`);
});
it("offers no acceptance when a full safe report is unavailable", () => {
  h.snapshot.inspection = {
    outcome: "changed",
    resolution: null,
    canConfirm: false,
    configuration: null,
  };
  const html = render();
  expect(html).toContain(S.limitedReview);
  expect(html).not.toContain(S.acceptCurrent);
});
it("does not describe accepting current settings as proof of the old mutation or current adoption", () => {
  h.snapshot.phase = "resolved";
  const html = render();
  expect(html).toContain(S.acceptedCurrent);
  expect(html).not.toContain(S.resolved);
});
