import { beforeEach, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { freshThreadState } from "../runtime/session_projection";
import type { AccountIdentity } from "../runtime/agents";

const h = vi.hoisted(() => ({
  account: null as AccountIdentity | null,
  current: undefined as unknown,
  invoke: vi.fn(),
}));
vi.mock("../runtime/connection_account", () => ({
  useConnectionAccount: () => h.account,
}));
vi.mock("../runtime/sessions", () => ({
  threads: {
    thread: () => h.current,
    subscribe: () => () => {},
    getSnapshot: () => 0,
    readIdentity: h.invoke,
    clearIdentity: vi.fn(),
  },
}));
import { ConnectionAccount } from "./ConnectionAccount";

beforeEach(() => {
  h.account = { kind: "credential" };
  h.invoke.mockClear();
});
function owner() {
  const thread = Object.assign(
    freshThreadState("own", "fixture", "/work", "s"),
    {
      connectionId: "live",
      identityRead: { provenance: "reviewed-official-supplement" },
    },
  );
  h.current = thread;
  return thread;
}
function markup(thread = owner(), source?: string) {
  const props = {
    agentId: "fixture",
    cwd: "/work",
    active: true,
    thread,
    source,
  };
  return renderToStaticMarkup(<ConnectionAccount {...props} />);
}

it("offers an explicit current-conversation identity read only for its real reviewed owner", () => {
  const html = markup();
  expect(html).toContain("读取本次对话身份");
  expect(h.invoke).not.toHaveBeenCalled();
  expect(html).toContain("已检测到登录资料");
  expect(html).not.toContain(">账号登录<");
});

it("does not infer a session identity action from ordinary account reports or missing native ownership", () => {
  const thread = owner();
  thread.identityRead = null as never;
  expect(markup(thread)).not.toContain("读取本次对话身份");
  thread.identityRead = { provenance: "reviewed-official-supplement" };
  thread.nativeSessionId = "";
  expect(markup(thread)).not.toContain("读取本次对话身份");
  expect(h.invoke).not.toHaveBeenCalled();
});

it("keeps an existing reported account and plan unchanged while merely rendering the new action", () => {
  h.account = {
    kind: "account",
    email: "person@example.test",
    plan: "original",
  };
  const before = { ...h.account };
  const html = markup();
  expect(html).toContain("person@example.test");
  expect(html).toContain("original");
  expect(h.account).toEqual(before);
  expect(h.invoke).not.toHaveBeenCalled();
});

it("does not promote a conversation-reported email into the global authentication kind or plan", () => {
  const thread = owner();
  thread.sessionIdentityRead = {
    phase: "reported",
    identity: {
      email: "conversation@example.test",
      displayName: null,
      workspaceName: null,
      organizationName: null,
    },
  };
  h.account = { kind: "credential" };
  const html = markup(thread);
  expect(html).toContain("conversation@example.test");
  expect(html).toContain("已检测到登录资料");
  expect(html).not.toContain(">账号登录<");
  expect(h.account).toEqual({ kind: "credential" });
});

it("keeps a selected API source separate from the optional conversation identity report", () => {
  const thread = owner();
  h.account = {
    kind: "account",
    email: "unrelated@example.test",
    plan: "unrelated-plan",
  };
  const html = markup(thread, "explicit-selected-api");
  expect(html).toContain("读取本次对话身份");
  expect(html).not.toContain("unrelated@example.test");
  expect(html).not.toContain("unrelated-plan");
  expect(h.invoke).not.toHaveBeenCalled();
});
