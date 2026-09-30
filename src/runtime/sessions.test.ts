import { describe, expect, it } from "vitest";
import { composerDrafts } from "./drafts";
import {
  applyConnectionLost,
  applyElicitation,
  applyTurnEnd,
  applyUpdate,
  freshThreadState,
  groupSidebarRows,
  modelConfigOption,
  normalizeConfigOptions,
  paneCards,
  threads,
  type IndexRow,
  type ThreadState,
} from "./sessions";

function state(): ThreadState {
  return freshThreadState("codex:/p:s1", "codex", "/p", "s1");
}

describe("applyUpdate · message chunks", () => {
  it("appends agent chunks into one streaming message", () => {
    const s = state();
    applyUpdate(s, {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "Hello " },
    });
    applyUpdate(s, {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "world" },
    });
    expect(s.items).toHaveLength(1);
    const item = s.items[0]!;
    expect(item.kind).toBe("agent");
    if (item.kind === "agent") {
      expect(item.text).toBe("Hello world");
      expect(item.streaming).toBe(true);
    }
  });

  it("starts a new message after a different update kind interleaves", () => {
    const s = state();
    applyUpdate(s, {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "a" },
    });
    applyUpdate(s, {
      sessionUpdate: "tool_call",
      toolCallId: "t1",
      title: "ls",
      kind: "execute",
      status: "in_progress",
    });
    applyUpdate(s, {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "b" },
    });
    expect(s.items).toHaveLength(3);
    const first = s.items[0]!;
    expect(first.kind === "agent" && first.streaming).toBe(false);
  });

  it("keeps user chunks merged but dedupes an optimistic echo", () => {
    const s = state();
    s.items.push({
      kind: "user",
      id: "u0",
      text: "fix the bug",
      attachments: [],
      streaming: false,
      time: 1,
    });
    applyUpdate(s, {
      sessionUpdate: "user_message_chunk",
      content: { type: "text", text: "fix the bug" },
    });
    expect(s.items).toHaveLength(1);
  });

  it("collects thought chunks into a thought block", () => {
    const s = state();
    applyUpdate(s, {
      sessionUpdate: "agent_thought_chunk",
      content: { type: "text", text: "thinking…" },
    });
    const item = s.items[0]!;
    expect(item.kind).toBe("thought");
  });
});

describe("applyUpdate · tool calls", () => {
  it("merges tool_call_update into the same tool item", () => {
    const s = state();
    applyUpdate(s, {
      sessionUpdate: "tool_call",
      toolCallId: "t1",
      title: "npm test",
      kind: "execute",
      status: "in_progress",
    });
    applyUpdate(s, {
      sessionUpdate: "tool_call_update",
      toolCallId: "t1",
      status: "completed",
      locations: [{ path: "/p/a.ts", line: 3 }],
      content: [{ type: "content", content: { type: "text", text: "ok" } }],
    });
    expect(s.items).toHaveLength(1);
    const item = s.items[0]!;
    if (item.kind !== "tool") throw new Error("expected tool item");
    expect(item.call.status).toBe("completed");
    expect(item.call.locations[0]).toEqual({ path: "/p/a.ts", line: 3 });
    expect(item.call.content[0]).toEqual({ type: "text", text: "ok" });
    expect(item.call.endedAt).toBeTypeOf("number");
  });

  it("renders diff content for file edits", () => {
    const s = state();
    applyUpdate(s, {
      sessionUpdate: "tool_call",
      toolCallId: "t2",
      title: "edit",
      kind: "edit",
      status: "completed",
      content: [
        { type: "diff", path: "/p/b.ts", oldText: "old", newText: "new" },
      ],
    });
    const item = s.items[0]!;
    if (item.kind !== "tool") throw new Error("expected tool item");
    expect(item.call.content[0]).toEqual({
      type: "diff",
      path: "/p/b.ts",
      oldText: "old",
      newText: "new",
    });
  });
});

describe("applyUpdate · plans/config/usage/raw", () => {
  it("stores plan entries and replaces on re-plan", () => {
    const s = state();
    applyUpdate(s, {
      sessionUpdate: "plan",
      entries: [{ content: "step 1", priority: "high", status: "pending" }],
    });
    applyUpdate(s, {
      sessionUpdate: "plan",
      entries: [
        { content: "step 1", priority: "high", status: "completed" },
        { content: "step 2", priority: "low", status: "in_progress" },
      ],
    });
    expect(s.items).toHaveLength(1);
    const item = s.items[0]!;
    if (item.kind !== "plan") throw new Error("expected plan item");
    expect(item.entries).toHaveLength(2);
    expect(item.entries[1]!.status).toBe("in_progress");
  });

  it("stores usage, commands and config updates", () => {
    const s = state();
    applyUpdate(s, {
      sessionUpdate: "usage_update",
      used: 1200,
      size: 200_000,
    });
    applyUpdate(s, {
      sessionUpdate: "available_commands_update",
      availableCommands: [{ name: "review", description: "r" }],
    });
    applyUpdate(s, {
      sessionUpdate: "config_option_update",
      configOptions: [
        {
          id: "model",
          name: "Model",
          category: "model",
          type: "select",
          currentValue: "m2",
          options: [
            { value: "m1", name: "M1" },
            { value: "m2", name: "M2" },
          ],
        },
      ],
    });
    expect(s.usage).toEqual({ used: 1200, size: 200_000 });
    expect(s.availableCommands[0]!.name).toBe("review");
    const model = modelConfigOption(s.configOptions);
    expect(model?.currentValue).toBe("m2");
  });

  it("preserves unknown update types as raw items", () => {
    const s = state();
    applyUpdate(s, { sessionUpdate: "_vendor_ext", data: { a: 1 } });
    const item = s.items[0]!;
    expect(item.kind).toBe("raw");
    if (item.kind === "raw") {
      expect(item.update).toMatchObject({ sessionUpdate: "_vendor_ext" });
    }
  });
});

describe("grouped select options", () => {
  it("flattens grouped select options with the group name", () => {
    const options = normalizeConfigOptions([
      {
        id: "model",
        name: "Model",
        category: "model",
        type: "select",
        currentValue: "x",
        options: [
          {
            group: "g1",
            name: "Group 1",
            options: [{ value: "x", name: "X" }],
          },
        ],
      },
    ]);
    expect(options[0]!.options).toEqual([
      { value: "x", name: "X", group: "Group 1" },
    ]);
  });
});

describe("round end / connection loss", () => {
  it("settles the round on turnEnd", () => {
    const s = state();
    s.running = true;
    applyTurnEnd(s, { stopReason: "end_turn" });
    expect(s.running).toBe(false);
    const item = s.items[s.items.length - 1]!;
    expect(item.kind).toBe("settled");
    if (item.kind === "settled") expect(item.status).toBe("done");
  });

  it("marks cancelled rounds as stopped", () => {
    const s = state();
    s.running = true;
    applyTurnEnd(s, { stopReason: "cancelled" });
    const item = s.items[s.items.length - 1]!;
    if (item.kind === "settled") expect(item.status).toBe("stopped");
  });

  it("marks a running round unknown on connection loss", () => {
    const s = state();
    s.running = true;
    s.pendingPermissions = [
      {
        requestId: "r1",
        status: "pending",
        error: null,
        toolCallId: null,
        title: "x",
        kind: "other",
        locations: [],
        options: [],
        decision: null,
      },
    ];
    applyConnectionLost(s);
    expect(s.connectionLost).toBe(true);
    expect(s.running).toBe(false);
    expect(s.pendingPermissions).toEqual([]);
    const item = s.items[s.items.length - 1]!;
    if (item.kind === "settled") expect(item.status).toBe("unknown");
  });
});

describe("artifacts / elicitation", () => {
  it("keeps separate elicitation requests and clears them on connection loss", () => {
    const s = state();
    applyElicitation(s, {
      requestId: "r1",
      message: "fill this",
      schema: { type: "object", properties: {} },
    });
    applyElicitation(s, {
      requestId: "r2",
      message: "another form",
      schema: { type: "object", properties: {} },
    });
    expect(s.pendingElicitations[0]).toMatchObject({
      requestId: "r1",
      message: "fill this",
    });
    expect(s.pendingElicitations.map((p) => p.requestId)).toEqual(["r1", "r2"]);
    applyConnectionLost(s);
    expect(s.pendingElicitations).toEqual([]);
  });

  it("derives pane cards from tool_call diffs and execute calls", () => {
    const s = state();
    s.running = true;
    s.items.push({
      kind: "user",
      id: "u1",
      text: "go",
      attachments: [],
      streaming: false,
      time: 1,
    });
    s.roundItemBase = s.items.length;
    applyUpdate(s, {
      sessionUpdate: "tool_call",
      toolCallId: "t1",
      kind: "edit",
      status: "completed",
      content: [
        { type: "diff", path: "/p/b.ts", oldText: "x", newText: "y" },
        { type: "diff", path: "/p/a.txt", oldText: null, newText: "hi" },
      ],
    });
    applyUpdate(s, {
      sessionUpdate: "tool_call",
      toolCallId: "t2",
      title: "npm test",
      kind: "execute",
      status: "completed",
      rawOutput: { output: "ok\n" },
    });
    applyTurnEnd(s, { stopReason: "end_turn" });
    const settled = s.items[s.items.length - 1]!;
    if (settled.kind !== "settled") throw new Error("expected settled");
    expect(settled.artifactCount).toBe(3); // two diffs + one command card
    const cards = paneCards(s);
    const diffs = cards.filter((c) => c.kind === "diff");
    expect(diffs.map((c) => c.path)).toEqual(["/p/b.ts", "/p/a.txt"]);
    const command = cards.find((c) => c.kind === "command");
    expect(command).toMatchObject({ title: "npm test", output: "ok\n" });
  });

  it("command output falls back to text content and keeps a bounded tail", () => {
    const s = state();
    applyUpdate(s, {
      sessionUpdate: "tool_call",
      toolCallId: "t1",
      kind: "execute",
      status: "completed",
      content: [
        { type: "content", content: { type: "text", text: "a" } },
        { type: "content", content: { type: "text", text: "b" } },
      ],
    });
    const cards = paneCards(s);
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ kind: "command", output: "ab" });

    const big = state();
    applyUpdate(big, {
      sessionUpdate: "tool_call",
      toolCallId: "t2",
      kind: "execute",
      status: "completed",
      rawOutput: "x".repeat(100_000),
    });
    const card = paneCards(big)[0]!;
    if (card.kind !== "command") throw new Error("expected a command card");
    expect(card.output.length).toBeLessThanOrEqual(64 * 1024);
  });
});

describe("sidebar grouping", () => {
  function row(overrides: Partial<IndexRow> = {}): IndexRow {
    return {
      id: "a:/p:s1",
      agentId: "codex",
      cwd: "/p",
      nativeSessionId: "s1",
      title: "t",
      configOptions: null,
      pinned: false,
      archived: false,
      createdAt: 0,
      updatedAt: 0,
      ...overrides,
    };
  }

  it("groups by project directory and sorts by updatedAt", () => {
    const rows = [
      row({ id: "a:/x:s1", cwd: "/x", updatedAt: 10, title: "old" }),
      row({ id: "a:/y:s2", cwd: "/y", updatedAt: 30, title: "new y" }),
      row({ id: "a:/x:s3", cwd: "/x", updatedAt: 20, title: "new x" }),
    ];
    const groups = groupSidebarRows(rows, new Map());
    expect(groups.map((g) => g.cwd)).toEqual(["/y", "/x"]);
    expect(groups[1]!.rows.map((r) => r.title)).toEqual(["new x", "old"]);
  });

  it("floats attention rows above running and idle", () => {
    const rows = [
      row({ id: "a:/p:s1", updatedAt: 30 }),
      row({ id: "a:/p:s2", updatedAt: 20, nativeSessionId: "s2" }),
      row({ id: "a:/p:s3", updatedAt: 10, nativeSessionId: "s3" }),
    ];
    const live = new Map<string, ThreadState>();
    const running = freshThreadState("a:/p:s2", "a", "/p", "s2");
    running.running = true;
    live.set("a:/p:s2", running);
    const needy = freshThreadState("a:/p:s3", "a", "/p", "s3");
    needy.pendingPermissions = [
      {
        requestId: "r",
        status: "pending",
        error: null,
        toolCallId: null,
        title: "",
        kind: "other",
        locations: [],
        options: [],
        decision: null,
      },
    ];
    live.set("a:/p:s3", needy);
    const groups = groupSidebarRows(rows, live);
    expect(groups[0]!.rows.map((r) => r.status)).toEqual([
      "need",
      "run",
      "idle",
    ]);
  });

  it("filters archived and attention modes", () => {
    const rows = [
      row({ id: "a:/p:s1", archived: true }),
      row({ id: "a:/p:s2", nativeSessionId: "s2" }),
    ];
    expect(
      groupSidebarRows(rows, new Map(), { archived: true })[0]!.rows,
    ).toHaveLength(1);
    const live = new Map<string, ThreadState>();
    const needy = freshThreadState("a:/p:s2", "a", "/p", "s2");
    needy.pendingPermissions = [
      {
        requestId: "r",
        status: "pending",
        error: null,
        toolCallId: null,
        title: "",
        kind: "other",
        locations: [],
        options: [],
        decision: null,
      },
    ];
    live.set("a:/p:s2", needy);
    const attention = groupSidebarRows(rows, live, { attentionOnly: true });
    expect(attention[0]!.rows).toHaveLength(1);
    expect(attention[0]!.rows[0]!.key).toBe("a:/p:s2");
  });

  it("merges agent-side rows and dedups against the index", () => {
    const rows = [row({ id: "a:/p:s1", updatedAt: 30 })];
    const agentRows = [
      {
        key: "a:/p:s1", // same native id as the meta row → deduped
        agentId: "a",
        cwd: "/p",
        nativeSessionId: "s1",
        title: "dup",
        updatedAt: 50,
      },
      {
        key: "a:/p:s9",
        agentId: "a",
        cwd: "/p",
        nativeSessionId: "s9",
        title: "agent only",
        updatedAt: 40,
      },
    ];
    const groups = groupSidebarRows(rows, new Map(), { agentRows });
    expect(groups[0]!.rows).toHaveLength(2);
    const agentRow = groups[0]!.rows.find((r) => r.key === "a:/p:s9");
    expect(agentRow?.source).toBe("agent");
    expect(agentRow?.title).toBe("agent only");
    // Meta row wins dedup — no second s1 entry.
    expect(
      groups[0]!.rows.filter((r) => r.nativeSessionId === "s1"),
    ).toHaveLength(1);
  });

  it("never invents archive membership from age or a live ending and protects unsent work in a saved archive", () => {
    const now = Date.now();
    const rows = [
      row({ id: "a:/p:old", updatedAt: now - 40 * 86_400_000 }),
      row({ id: "a:/p:fresh", updatedAt: now - 2 * 86_400_000 }),
      row({
        id: "a:/p:pinned-old",
        updatedAt: now - 40 * 86_400_000,
        pinned: true,
      }),
    ];
    // Missing live state is unknown, not proof that an Agent has finished.
    expect(
      groupSidebarRows(rows, new Map(), { autoArchiveDays: 30 })[0]!.rows,
    ).toHaveLength(3);
    const live = new Map<string, ThreadState>();
    const ended = freshThreadState("a:/p:old", "a", "/p", "old");
    applyUpdate(ended, {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "An actual result" },
    });
    applyTurnEnd(ended, { stopReason: "end_turn" });
    const terminal = ended.items[ended.items.length - 1]!;
    if (terminal.kind === "settled") terminal.time = now - 40 * 86_400_000;
    live.set(ended.key, ended);
    expect(
      groupSidebarRows(rows, live, {
        archived: true,
        autoArchiveDays: 30,
      }),
    ).toEqual([]);
    expect(rows[0]!.archived).toBe(false);
    rows[0]!.archived = true;
    expect(
      groupSidebarRows(rows, live, { archived: true })[0]!.rows.map(
        (row) => row.key,
      ),
    ).toEqual(["a:/p:old"]);
    composerDrafts.update(`session:${ended.key}`, () => ({
      text: "Unsent follow-up",
      attachments: [],
    }));
    expect(
      groupSidebarRows(rows, live, { autoArchiveDays: 30 })[0]!.rows,
    ).toHaveLength(3);
    composerDrafts.clear(`session:${ended.key}`);
    ended.queued = [[{ type: "text", text: "not sent" }]];
    expect(
      groupSidebarRows(rows, live, { autoArchiveDays: 30 })[0]!.rows,
    ).toHaveLength(3);
    ended.queued = [];
    ended.stopUnconfirmed = true;
    expect(
      groupSidebarRows(rows, live, { autoArchiveDays: 30 })[0]!.rows,
    ).toHaveLength(3);
  });
});

describe("resume failure state", () => {
  it("markOpenFailed keeps a non-empty unrecoverable thread", () => {
    const s = threads.markOpenFailed(
      "a:/p:sx",
      "a",
      "/p",
      "sx",
      "load failed",
      true,
    );
    expect(s.openError).toBe("load failed");
    expect(s.unrecoverable).toBe(true);
    expect(threads.thread("a:/p:sx")?.unrecoverable).toBe(true);
  });
});
