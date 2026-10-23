import { afterEach, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
// SSR observes the real transient store synchronously; it is not a DOM paint.
vi.mock("react", async (original) => {
  const actual = await original<typeof import("react")>();
  return {
    ...actual,
    useSyncExternalStore: (_subscribe: unknown, snapshot: () => unknown) =>
      snapshot(),
  };
});
const invoke = vi.hoisted(() =>
  vi.fn().mockResolvedValue({ status: "submitted" }),
);
vi.mock("@tauri-apps/api/core", () => ({ invoke, Channel: class {} }));
import { openingInquiries } from "../runtime/opening_inquiries";
import { OpeningElicitationList } from "./OpeningElicitationList";

afterEach(() => {
  openingInquiries.retireAll();
  for (const view of openingInquiries.getSnapshot())
    openingInquiries.dismiss(view.id);
  invoke.mockClear();
});
it("renders the actual common approval card with original input before an opening finishes", () => {
  const owner = openingInquiries.begin("controlled-opening", {
    agentId: "a",
    cwd: "/controlled",
  });
  owner.receive({
    kind: "permissionRequest",
    requestId: "p",
    owner: { connectionId: "c", sessionId: "s", requestId: "p" },
    toolCall: {
      title: "Original operation",
      kind: "execute",
      rawInput: { command: "echo '<owned>'", cwd: "/controlled" },
    },
    options: [
      { optionId: "yes", kind: "allow_once", name: "Controlled allow" },
      { optionId: "no", kind: "reject_once", name: "Controlled reject" },
    ],
  });
  const html = renderToStaticMarkup(
    <OpeningElicitationList agents={[{ id: "a", name: "Controlled Agent" }]} />,
  );
  expect(html).toContain('class="approval"');
  expect(html).toContain("Original operation");
  expect(html).toContain("echo &#x27;&lt;owned&gt;&#x27;");
  expect(html).toContain("/controlled");
  expect(html).toContain("Controlled allow");
  expect(html).toContain("Controlled reject");
  expect(invoke).not.toHaveBeenCalled();
});
