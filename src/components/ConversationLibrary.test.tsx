import { beforeEach, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { AgentCardModel } from "../runtime/agents";
import { agentBrand } from "../runtime/agent_brands";
import type { LibraryFilter } from "../runtime/collections";
import { groupSidebarRows, type SidebarRow } from "../runtime/sidebar";
import { composerDrafts } from "../runtime/drafts";
import { LIBRARY } from "../runtime/library_strings";
import { STRINGS } from "../runtime/strings";
import { ConversationLibrary } from "./ConversationLibrary";
import { Sidebar } from "./Sidebar";
import {
  applyTurnEnd,
  applyUpdate,
  freshThreadState,
} from "../runtime/session_projection";
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
const renderLibrary = (
  filter: LibraryFilter = { kind: "all" },
  cards: AgentCardModel[] = [agent],
) =>
  renderToStaticMarkup(
    <ConversationLibrary
      agents={cards}
      filter={filter}
      onFilter={vi.fn()}
      onOpen={vi.fn()}
      onImport={vi.fn()}
      onNew={vi.fn()}
      defaultCwd="/ordinary"
    />,
  );
const renderSidebar = () =>
  renderToStaticMarkup(
    <Sidebar
      agents={[agent]}
      active="start"
      filter={{ kind: "all" }}
      currentKey={null}
      onNew={vi.fn()}
      onLibrary={vi.fn()}
      onOpenRow={vi.fn()}
      onAllAgents={vi.fn()}
      onSearch={vi.fn()}
      onSettings={vi.fn()}
      onExplore={vi.fn()}
      onCollapse={vi.fn()}
    />,
  );

function addUnconfirmedToolTail(status: "stopped" | "failed") {
  const state = freshThreadState("tail", agent.id, "/ordinary", "tail");
  state.activeToolCallIds = ["unfinished-tool"];
  state.items.push({
    kind: "settled",
    id: "end",
    status,
    replyReceived: false,
    diffCount: 0,
    artifactCount: 0,
    time: 1,
  });
  liveThreads.set(state.key, state);
  rows.push(
    ...groupSidebarRows(
      [
        {
          id: state.key,
          agentId: agent.id,
          cwd: state.cwd,
          nativeSessionId: state.nativeSessionId,
          title: "tail conversation",
          pinned: false,
          archived: false,
          createdAt: 1,
          updatedAt: 1,
          configOptions: null,
        },
      ],
      liveThreads,
    ).flatMap((group) => group.rows),
  );
}

beforeEach(() => {
  composerDrafts.clear("session:idle");
  composerDrafts.clear("resend:waiting");
  liveThreads = new Map();
  rows = [
    row("idle", "idle", true),
    row("waiting", "need"),
    row("busy", "run"),
  ];
});

it.each([
  ["completed", "整理已结束"],
  ["in_progress", "整理尚未结束"],
  ["failed", "整理未完成"],
  ["cancelled", "整理未完成"],
  ["_future", "整理结果待确认"],
])(
  "preserves compaction-only %s as its actual maintenance result in the library",
  (status, label) => {
    const state = freshThreadState("idle", agent.id, "/ordinary", "idle");
    applyUpdate(state, {
      sessionUpdate: "compaction_update",
      compactionId: "c",
      status,
    });
    applyTurnEnd(state, { stopReason: "end_turn" });
    liveThreads.set("idle", state);
    expect(renderLibrary()).toContain(label);
  },
);

it.each(["refusal", "cancelled"])(
  "does not override the library's %s round with successful maintenance",
  (stopReason) => {
    const state = freshThreadState("idle", agent.id, "/ordinary", "idle");
    applyUpdate(state, {
      sessionUpdate: "compaction_update",
      compactionId: "c",
      status: "completed",
    });
    applyTurnEnd(state, { stopReason });
    liveThreads.set("idle", state);
    expect(renderLibrary()).not.toContain("整理已结束");
    expect(renderLibrary()).toContain(
      stopReason === "cancelled"
        ? STRINGS.thread.stopped
        : STRINGS.thread.failed,
    );
  },
);

it.each(["stopped", "failed"] as const)(
  "labels an unfinished tool after a %s reply as unknown in the row and global count",
  (status) => {
    rows = [];
    addUnconfirmedToolTail(status);
    const library = renderLibrary({ kind: "attention" });
    expect(library).toContain("tail conversation");
    expect(library).toContain(`>${STRINGS.thread.unknown}</span>`);
    expect(library).not.toContain(`>${LIBRARY.running}</span>`);
    const sidebar = renderSidebar();
    expect(sidebar).toContain(`1 ${STRINGS.thread.unknown}</button>`);
    expect(sidebar).not.toContain(`1 ${LIBRARY.running}</button>`);
    expect(renderLibrary({ kind: "running" })).not.toContain(
      "tail conversation",
    );
    expect(liveThreads.get("tail")?.activeToolCallIds).toEqual([
      "unfinished-tool",
    ]);
  },
);

it("counts mixed unknown and pending work as needing attention without changing real running work", () => {
  rows = [row("waiting", "need"), row("busy", "run")];
  addUnconfirmedToolTail("stopped");
  const sidebar = renderSidebar();
  expect(sidebar).toContain(`2 ${STRINGS.thread.needYou}</button>`);
  expect(sidebar).toContain(`1 ${LIBRARY.running}</button>`);
  const attention = renderLibrary({ kind: "attention" });
  expect(attention).toContain("tail conversation");
  expect(attention).toContain("waiting conversation");
  expect(attention).not.toContain("busy conversation");
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
  expect(html).toContain(`src="${agentBrand(agent)!.logo}"`);
  expect(html).not.toContain('type="checkbox"');
  expect(html).not.toContain(`>${LIBRARY.archive}</button>`);
  expect(html).toContain(`aria-label="${LIBRARY.query}"`);
  expect(html.match(/role="tab"/g)).toHaveLength(6);
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

it("keeps retired directory names only when needed to access history or the current filter", () => {
  const retired = (id: string): AgentCardModel => ({
    ...agent,
    id,
    name: `Saved ${id}`,
    firstBatchVisible: false,
  });
  const kept = retired("retired-with-history");
  const empty = retired("retired-without-history");
  const cards = [agent, kept, empty];
  rows.push({
    ...row("saved-old", "idle"),
    agentId: kept.id,
    archived: true,
  });
  const html = renderLibrary({ kind: "all" }, cards);
  expect(html).toContain(`value="${kept.id}">${kept.name}</option>`);
  expect(html).not.toContain(`value="${empty.id}"`);
  const archived = renderLibrary(
    {
      kind: "selection",
      agent: kept.id,
      state: "archived",
      favorites: false,
      group: "",
      query: "",
    },
    cards,
  );
  expect(archived).toContain("saved-old conversation");
  const selected = renderLibrary({ kind: "agent", id: empty.id }, cards);
  expect(selected).toContain(
    `value="${empty.id}" selected="">${empty.name}</option>`,
  );
  expect(rows.some((row) => row.agentId === kept.id)).toBe(true);
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
      new RegExp(
        `role="tab" aria-selected="true"[^>]*>${label}<span class="library-tab-count">1</span></button>`,
      ),
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
      currentKey={null}
      onNew={vi.fn()}
      onLibrary={vi.fn()}
      onOpenRow={vi.fn()}
      onAllAgents={vi.fn()}
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

it("lists the eight newest conversations in 最近 with a 查看全部 link", () => {
  rows = Array.from({ length: 10 }, (_, index) => ({
    ...row(`r${index}`, index === 9 ? "need" : "idle"),
    updatedAt: index + 1,
  }));
  const onLibrary = vi.fn();
  const html = renderToStaticMarkup(
    <Sidebar
      agents={[agent]}
      active="thread"
      filter={{ kind: "all" }}
      currentKey="r9"
      onNew={vi.fn()}
      onLibrary={onLibrary}
      onOpenRow={vi.fn()}
      onAllAgents={vi.fn()}
      onSearch={vi.fn()}
      onSettings={vi.fn()}
      onExplore={vi.fn()}
      onCollapse={vi.fn()}
    />,
  );
  expect(html).toContain(LIBRARY.recent);
  expect(html).toContain("r9 conversation");
  expect(html).toContain("r2 conversation");
  expect(html).not.toContain("r1 conversation");
  expect(html).not.toContain("r0 conversation");
  expect(html).toContain(LIBRARY.viewAll);
});

it("hides 最近 when only unsent drafts or no conversations exist", () => {
  rows = [
    {
      ...row("unsent", "idle"),
      title: "",
      nativeSessionId: null,
      live: true,
    },
  ];
  expect(renderSidebar()).not.toContain(LIBRARY.recent);
  rows = [];
  expect(renderSidebar()).not.toContain(LIBRARY.recent);
});

it("filters all forms of retained unsent work without searching conversation bodies", () => {
  composerDrafts.update("session:idle", () => ({
    text: "body-only-search-marker",
    attachments: [],
  }));
  composerDrafts.update("resend:waiting", () => ({
    text: "retained input",
    attachments: [],
  }));
  const busy = freshThreadState("busy", agent.id, "/ordinary", "busy");
  busy.queued = [[{ type: "text", text: "paused message" }]];
  liveThreads.set("busy", busy);
  const filter: LibraryFilter = {
    kind: "selection",
    state: "drafts",
    agent: "",
    group: "",
    query: "",
    favorites: false,
  };
  const html = renderLibrary(filter);
  for (const key of ["idle", "waiting", "busy"])
    expect(html).toContain(`${key} conversation`);
  expect(html).toContain("待发 1 条");
  expect(
    renderLibrary({ ...filter, query: "body-only-search-marker" }),
  ).not.toContain("idle conversation");
  expect(composerDrafts.read("resend:waiting").text).toBe("retained input");
});

it("explains how to collect favorites in the empty state", () => {
  rows = [row("unstarred", "idle")];
  const html = renderLibrary({ kind: "favorites" });
  expect(html).toContain("还没有收藏对话");
  expect(html).toContain("点击对话右侧的星标收藏");
});
