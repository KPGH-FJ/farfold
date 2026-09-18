import { describe, expect, it } from "vitest";
import {
  applyConnectionLost,
  applyTurnEnd,
  applyUpdate,
  freshThreadState,
  groupSidebarRows,
  modelConfigOption,
  normalizeConfigOptions,
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
    s.pendingPermission = {
      requestId: "r1",
      toolCallId: null,
      title: "x",
      kind: "other",
      locations: [],
      options: [],
      decision: null,
    };
    applyConnectionLost(s);
    expect(s.connectionLost).toBe(true);
    expect(s.running).toBe(false);
    expect(s.pendingPermission).toBeNull();
    const item = s.items[s.items.length - 1]!;
    if (item.kind === "settled") expect(item.status).toBe("unknown");
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
    needy.pendingPermission = {
      requestId: "r",
      toolCallId: null,
      title: "",
      kind: "other",
      locations: [],
      options: [],
      decision: null,
    };
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
    needy.pendingPermission = {
      requestId: "r",
      toolCallId: null,
      title: "",
      kind: "other",
      locations: [],
      options: [],
      decision: null,
    };
    live.set("a:/p:s2", needy);
    const attention = groupSidebarRows(rows, live, { attentionOnly: true });
    expect(attention[0]!.rows).toHaveLength(1);
    expect(attention[0]!.rows[0]!.key).toBe("a:/p:s2");
  });
});
