import { beforeEach, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({ states: [] as unknown[], cursor: 0 }));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useState: (initial: unknown) => {
    const index = h.cursor++;
    if (index >= h.states.length) h.states.push(initial);
    return [h.states[index], (next: unknown) => (h.states[index] = next)];
  },
}));
import { ConversationExportHost } from "./ConversationExportHost";
import {
  captureConversationExport,
  releasedExportSnapshot,
} from "../runtime/conversation_archive_snapshot";
const capture = () =>
  captureConversationExport(
    {
      cwd: "/synthetic",
      items: [
        {
          kind: "user",
          id: "message",
          text: "same text",
          attachments: [],
          time: 1,
          streaming: false,
        },
      ],
    },
    "same title",
    "Agent",
  );
beforeEach(() => {
  h.states = [];
});
it.each(["markdown", "zip"])(
  "%s replaces the exact snapshot owner even for identical text/name, but payload release keeps the registered view",
  (format) => {
    h.states = [format, false];
    const render = (value: ReturnType<typeof capture>) => {
      h.cursor = 0;
      return ConversationExportHost({
        capture: value,
        name: "same.md",
        onClose: () => {},
        onRegistered: () => {},
        returnFocusRef: { current: null },
      });
    };
    const first = capture(),
      second = capture();
    expect(first.markdown).toBe(second.markdown);
    expect(render(first).key).toBe(first.snapshotId);
    expect(render(second).key).toBe(second.snapshotId);
    expect(render(first).key).not.toBe(render(second).key);
    expect(render(releasedExportSnapshot(first)).key).toBe(render(first).key);
  },
);
