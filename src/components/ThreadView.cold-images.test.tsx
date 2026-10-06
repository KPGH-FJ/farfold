import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

const h = vi.hoisted(() => ({
  invoke: vi.fn().mockResolvedValue(null),
  copied: [] as string[],
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: h.invoke,
  Channel: class {},
}));
vi.mock("react/jsx-runtime", async (original) => {
  const actual = await original<typeof import("react/jsx-runtime")>();
  return {
    ...actual,
    jsx: (...args: Parameters<typeof actual.jsx>) => {
      if (typeof args[0] === "function" && args[0].name === "MessageCopyButton")
        h.copied.push((args[1] as { text: string }).text);
      return actual.jsx(...args);
    },
  };
});
vi.mock("react/jsx-dev-runtime", async (original) => {
  const actual = await original<typeof import("react/jsx-dev-runtime")>();
  return {
    ...actual,
    jsxDEV: (...args: Parameters<typeof actual.jsxDEV>) => {
      if (typeof args[0] === "function" && args[0].name === "MessageCopyButton")
        h.copied.push((args[1] as { text: string }).text);
      return actual.jsxDEV(...args);
    },
  };
});
import { ThreadView } from "./ThreadView";
import { threads } from "../runtime/sessions";
import { PNG_IMAGE_TEST_DATA } from "../runtime/image_fixtures.test-support";

beforeEach(() => {
  h.copied.length = 0;
  h.invoke.mockClear();
});
afterEach(() => vi.unstubAllGlobals());

it("presents a replayed text image as an explicit unopened attachment while preserving the original message and copy", async () => {
  const image = vi.fn();
  vi.stubGlobal("Image", image);
  const text = `Keep this exact original text.[@image](data:image/png;base64,${PNG_IMAGE_TEST_DATA})`;
  h.invoke.mockImplementation(async (command, args) => {
    if (command === "agent_work_get") return { cwd: "/p", enabled: {} };
    if (command !== "session_open") return [];
    args.channel.onmessage({
      update: {
        sessionUpdate: "user_message_chunk",
        content: { type: "text", text },
      },
    });
    args.channel.onmessage({
      kind: "session_history_complete",
      openToken: args.openToken,
    });
    return { cwd: "/p", nativeSessionId: "owned", resumed: true };
  });
  const thread = await threads.open({
    agentId: "cold-image-fixture",
    cwd: "/p",
    nativeSessionId: "owned",
  });
  expect(thread.resumed).toBe(true);
  const first = thread.items[0];
  expect(first.kind).toBe("user");
  if (first.kind !== "user")
    throw new Error("Expected a replayed user message");
  expect(first.time).toBe(0);
  h.invoke.mockClear();
  const before = structuredClone(thread);
  const html = renderToStaticMarkup(
    <ThreadView
      thread={thread}
      active
      agents={[]}
      onGoSettings={() => {}}
      onOpened={() => {}}
    />,
  );
  expect(html).toContain("Keep this exact original text.");
  expect(html).toContain("历史图片");
  expect(html).not.toContain("[@image]");
  expect(html).not.toContain("data:image/png;base64");
  expect(html).not.toContain('<img src="data:');
  expect(h.copied).toContain(text);
  expect(thread).toEqual(before);
  expect(image).not.toHaveBeenCalled();
  expect(h.invoke).not.toHaveBeenCalled();
});
