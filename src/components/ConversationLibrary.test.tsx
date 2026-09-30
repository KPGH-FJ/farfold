import { beforeEach, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { AgentCardModel } from "../runtime/agents";
import type { LibraryFilter } from "../runtime/collections";
import type { SidebarRow } from "../runtime/sidebar";
import { LIBRARY } from "../runtime/library_strings";
import { ConversationLibrary } from "./ConversationLibrary";
import { Sidebar } from "./Sidebar";
import { freshThreadState } from "../runtime/session_projection";
import type { ThreadState } from "../runtime/session_types";

const data = {
  groups: [{ id: "group-one", name: "产品设计" }],
  assignments: { idle: "group-one" },
  ready: true,
  saving: false,
  error: null,
};
let rows: SidebarRow[] = [];
let liveThreads = new Map<string, ThreadState>();

vi.mock("../runtime/collections", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../runtime/collections")>()),
  useCollections: () => data,
  useLibraryRows: (archived = false) =>
    rows.filter((row) => row.archived === archived),
}));
vi.mock("../runtime/sessions", async () => ({
  ...(await import("../runtime/sidebar")),
  threads: { archiveBlockReason: () => null },
  useThreadsSnapshot: () => ({ index: rows, threads: liveThreads }),
}));

const agent: AgentCardModel = {
  id: "codex",
  name: "Codex",
  description: "",
  status: "connected",
  version: null,
  authMethods: [],
  discoveredPath: null,
  registryVersion: null,
  source: "registry",
  installable: true,
  registerable: true,
  custom: false,
  handshake: null,
};
const row = (
  key: string,
  status: SidebarRow["status"],
  pinned = false,
): SidebarRow => ({
  key,
  title: `${key} conversation`,
  agentId: agent.id,
  cwd: "/ordinary",
  nativeSessionId: key,
  pinned,
  archived: false,
  updatedAt: 1,
  status,
  live: status !== "idle",
  source: "meta",
});
const renderLibrary = (filter: LibraryFilter = { kind: "all" }) =>
  renderToStaticMarkup(
    <ConversationLibrary
      agents={[agent]}
      filter={filter}
      onFilter={vi.fn()}
      onOpen={vi.fn()}
      onImport={vi.fn()}
      onNew={vi.fn()}
      defaultCwd="/ordinary"
    />,
  );

beforeEach(() => {
  liveThreads = new Map();
  rows = [
    row("idle", "idle", true),
    row("waiting", "need"),
    row("busy", "run"),
  ];
});

it.each([
  ["done", "已完成"],
  ["stopped", "已停止"],
  ["failed", "出错了"],
  ["unknown", "结果未知"],
] as const)(
  "shows the loaded latest %s result without inventing cold-history status",
  (status, label) => {
    rows = [row("loaded", "idle"), row("cold", "idle")];
    const state = freshThreadState("loaded", agent.id, "/ordinary", "loaded");
    state.items = [
      {
        kind: "settled",
        id: "end",
        status,
        replyReceived: true,
        diffCount: 0,
        artifactCount: 0,
        time: 1,
      },
    ];
    liveThreads.set("loaded", state);
    const html = renderLibrary();
    expect(html.match(new RegExp(`>${label}</span>`, "g"))).toHaveLength(1);
    expect(html).toContain("cold conversation");
  },
);

it("does not call a tool-only or empty completed request a completed answer", () => {
  rows = [row("tool-only", "idle"), row("empty", "idle")];
  for (const key of ["tool-only", "empty"]) {
    const state = freshThreadState(key, agent.id, "/ordinary", key);
    if (key === "tool-only")
      state.items.push({
        kind: "tool",
        id: "tool",
        call: {
          toolCallId: "call",
          title: "command",
          kind: "execute",
          status: "completed",
          locations: [],
          content: [],
          startedAt: 0,
        },
      });
    state.items.push({
      kind: "settled",
      id: "end",
      status: "done",
      replyReceived: false,
      artifactToolItemIds: key === "tool-only" ? ["tool"] : [],
      diffCount: 0,
      artifactCount: 0,
      time: 1,
    });
    liveThreads.set(key, state);
  }
  const html = renderLibrary();
  expect(html).toContain(">已结束</span>");
  expect(html).toContain(">未收到结果</span>");
  expect(html).not.toContain(">已完成</span>");
});

it("keeps current attention and running states ahead of older endings", () => {
  for (const current of rows) {
    const state = freshThreadState(
      current.key,
      agent.id,
      "/ordinary",
      current.key,
    );
    state.items = [
      {
        kind: "settled",
        id: "old",
        status: "done",
        replyReceived: true,
        diffCount: 0,
        artifactCount: 0,
        time: 1,
      },
    ];
    if (current.key === "idle") state.submitting = true;
    liveThreads.set(current.key, state);
  }
  const html = renderLibrary();
  expect(html).toContain(`>${LIBRARY.attention}</span>`);
  expect(html).toContain(`>${LIBRARY.running}</span>`);
  expect(html).not.toContain(">已完成</span>");
});

it("does not transfer an older result to a newer unanswered message", () => {
  rows = [row("loaded", "idle")];
  const state = freshThreadState("loaded", agent.id, "/ordinary", "loaded");
  state.items = [
    {
      kind: "settled",
      id: "old",
      status: "done",
      replyReceived: true,
      diffCount: 0,
      artifactCount: 0,
      time: 1,
    },
    {
      kind: "user",
      id: "new",
      text: "new request",
      attachments: [],
      streaming: false,
      time: 2,
    },
  ];
  liveThreads.set("loaded", state);
  expect(renderLibrary()).not.toContain(">已完成</span>");
});

it("does not equate a loaded ending without a received-result receipt with a completed answer", () => {
  rows = [row("loaded", "idle")];
  const state = freshThreadState("loaded", agent.id, "/ordinary", "loaded");
  state.items = [
    {
      kind: "settled",
      id: "end",
      status: "done",
      diffCount: 0,
      artifactCount: 0,
      time: 1,
    },
  ];
  liveThreads.set("loaded", state);
  const html = renderLibrary();
  expect(html).toContain(">已结束</span>");
  expect(html).not.toContain(">已完成</span>");
});

it("shows view-only only when readable content and a real continuation block are present", () => {
  rows = [
    row("readable", "need"),
    row("unloaded", "need"),
    row("history", "idle"),
  ];
  for (const key of ["readable", "unloaded", "history"]) {
    const state = freshThreadState(key, agent.id, "/ordinary", key);
    state.modelDrift = key !== "history";
    if (key !== "unloaded")
      state.items = [
        {
          kind: "agent",
          id: "message",
          text: "history reply",
          streaming: false,
          time: 0,
        },
      ];
    liveThreads.set(key, state);
  }
  const html = renderLibrary();
  expect(html.match(/>仅可查看<\/span>/g)).toHaveLength(1);
  expect(html).not.toContain(">已完成</span>");
});

it("starts in browsing mode with Agent artwork and explicit organize and new-conversation entries", () => {
  const html = renderLibrary();
  expect(html).toContain(`>${LIBRARY.organize}</button>`);
  expect(html).toContain(LIBRARY.newChat);
  expect(html).toContain(LIBRARY.import);
  expect(html).toContain('src="/agents/codex.svg"');
  expect(html).not.toContain('type="checkbox"');
  expect(html).not.toContain(`>${LIBRARY.archive}</button>`);
  expect(html).toContain(`aria-label="${LIBRARY.query}"`);
  expect(html.match(/role="tab"/g)).toHaveLength(5);
  expect(html).toContain("新回复");
  expect(html).not.toContain("已完成");
});

it("filters unread replies independently of running and attention state", () => {
  rows[0] = { ...rows[0], unread: true };
  rows[1] = { ...rows[1], unread: true };
  const html = renderLibrary({ kind: "unread" });
  expect(html).toContain("idle conversation");
  expect(html).toContain("waiting conversation");
  expect(html).not.toContain("busy conversation");
  expect(html).toContain('class="library-status unread"');
});

it("keeps removed custom Agents available for filtering retained and archived conversations", () => {
  rows.push(
    { ...row("old-custom", "idle"), agentId: "custom:retired" },
    { ...row("other-custom", "idle"), agentId: "custom:retired" },
    {
      ...row("archived-custom", "idle"),
      agentId: "custom:archived",
      archived: true,
    },
  );
  const options = (html: string) =>
    html.match(
      new RegExp(
        `<select aria-label="${LIBRARY.allAgents}"[^>]*>(.*?)</select>`,
      ),
    )![1];
  const initial = options(renderLibrary());
  expect(initial).toContain(
    '<option value="custom:retired">custom:retired</option>',
  );
  expect(initial).toContain(
    '<option value="custom:archived">custom:archived</option>',
  );
  expect(initial.match(/value="custom:retired"/g)).toHaveLength(1);
  expect(initial).toContain('<option value="codex">Codex</option>');
  rows.reverse();
  expect(options(renderLibrary())).toBe(initial);
  const filtered = renderLibrary({ kind: "agent", id: "custom:retired" });
  expect(filtered).toContain(
    '<option value="custom:retired" selected="">custom:retired</option>',
  );
  expect(filtered).toContain("old-custom conversation");
  expect(filtered).toContain("other-custom conversation");
  expect(filtered).not.toContain("idle conversation");
  expect(filtered).not.toContain("archived-custom conversation");
  const archived = renderLibrary({
    kind: "selection",
    agent: "custom:archived",
    state: "archived",
    favorites: false,
    group: "",
    query: "",
  });
  expect(archived).toContain(
    '<option value="custom:archived" selected="">custom:archived</option>',
  );
  expect(archived).toContain("archived-custom conversation");
  expect(archived).not.toContain("old-custom conversation");
});

it.each([
  ["attention", "waiting", LIBRARY.attention],
  ["running", "busy", LIBRARY.running],
] as const)(
  "opens the %s sidebar entry on its matching live-status tab",
  (kind, key, label) => {
    const html = renderLibrary({ kind });
    expect(html).toContain(`${key} conversation`);
    expect(html).not.toContain("idle conversation");
    expect(html).not.toContain(
      `${key === "waiting" ? "busy" : "waiting"} conversation`,
    );
    expect(html).toMatch(
      new RegExp(`role="tab" aria-selected="true"[^>]*>${label}</button>`),
    );
  },
);

it("preserves favorite and group membership independently of the working folder", () => {
  for (const filter of [
    { kind: "favorites" },
    { kind: "group", id: "group-one" },
  ] satisfies LibraryFilter[]) {
    const html = renderLibrary(filter);
    expect(html).toContain("idle conversation");
    expect(html).not.toContain("waiting conversation");
    expect(html).not.toContain("busy conversation");
    expect(html).toContain(LIBRARY.ordinary);
    expect(html).toContain("产品设计");
  }
});

it("keeps the sidebar signature and hides empty live-activity shortcuts", () => {
  rows = [row("idle", "idle")];
  const html = renderToStaticMarkup(
    <Sidebar
      agents={[agent]}
      active="start"
      filter={{ kind: "all" }}
      onNew={vi.fn()}
      onLibrary={vi.fn()}
      onSearch={vi.fn()}
      onSettings={vi.fn()}
      onExplore={vi.fn()}
      onCollapse={vi.fn()}
    />,
  );
  expect(html).toContain('class="product-new" aria-current="page"');
  expect(html).toContain(LIBRARY.tagline);
  expect(html).not.toContain('class="activity-links"');
});
