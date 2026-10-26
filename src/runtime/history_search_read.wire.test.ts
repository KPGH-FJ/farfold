import { afterEach, beforeEach, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: h.invoke,
  Channel: class {
    onmessage = (_event: unknown) => {};
  },
}));
vi.mock("./loaded_search_worker", async () => {
  const { loadedMarkdownFields } = await import("./loaded_search_markdown");
  return {
    createLoadedSearchParser: () => ({
      parse: async (text: string) => loadedMarkdownFields(text),
      dispose() {},
    }),
  };
});

import {
  readSelectedHistory,
  HISTORY_READ_LIMITS,
} from "./history_search_read";
import { loadedMarkdownFields } from "./loaded_search_markdown";
import type {
  HistoryReadInput,
  HistoryReadOperation,
  HistoryReadTarget,
} from "./history_search_types";

interface Wire {
  agentId: string;
  cwd: string;
  sessionId: string;
  openToken: string;
  channel: { onmessage(event: unknown): void };
}
const targets: HistoryReadTarget[] = ["one", "two", "unselected"].map((id) => ({
  rowId: id,
  agentId: "owned",
  cwd: "/owned",
  nativeSessionId: `native-${id}`,
  unavailable: null,
}));
const token = (wire: Wire) => `exact-${wire.sessionId}`;
function result(wire: Wire, purpose: unknown = "searchReadOnly") {
  return {
    cwd: wire.cwd,
    nativeSessionId: wire.sessionId,
    connectionId: "owned-connection",
    previewToken: token(wire),
    configOptions: [],
    purpose,
  };
}
function text(wire: Wire, body: string, role = "agent") {
  wire.channel.onmessage({
    update: {
      sessionUpdate: `${role}_message_chunk`,
      content: { type: "text", text: body },
    },
  });
}
function marker(wire: Wire) {
  wire.channel.onmessage({
    kind: "history_preview_complete",
    openToken: wire.openToken,
    previewToken: token(wire),
  });
}
function respond(
  deliver: (wire: Wire) => void = (wire) => {
    text(wire, "**Hello** visible reply");
    marker(wire);
  },
) {
  h.invoke.mockImplementation(async (command: string, wire: Wire) => {
    if (command === "session_read_preview") {
      deliver(wire);
      return result(wire);
    }
    if (command === "session_import_close") return;
    throw new Error(`Unexpected controlled command ${command}`);
  });
}
function input(overrides: Partial<HistoryReadInput> = {}): HistoryReadInput {
  return {
    agentId: "owned",
    requestId: "00000000-0000-4000-8000-000000000001",
    targets: targets.slice(0, 2),
    query: "hello",
    current: () => true,
    signal: new AbortController().signal,
    onProgress: vi.fn(),
    ...overrides,
  };
}
const commands = () => h.invoke.mock.calls.map(([command]) => command);
beforeEach(() => {
  h.invoke.mockReset();
});
afterEach(() => {
  vi.useRealTimers();
});

it("matches two selected official read prefixes and exact-closes each before the next, with no other command", async () => {
  respond((wire) => {
    text(wire, `User hello ${wire.sessionId}`, "user");
    text(wire, "**HELLO** visible reply");
    marker(wire);
    text(wire, "late unsealed body");
  });
  const answer = await readSelectedHistory(input());
  expect(commands()).toEqual([
    "session_read_preview",
    "session_import_close",
    "session_read_preview",
    "session_import_close",
  ]);
  expect(
    h.invoke.mock.calls
      .filter(([c]) => c === "session_read_preview")
      .map(([, w]) => w.sessionId),
  ).toEqual(["native-one", "native-two"]);
  expect(
    h.invoke.mock.calls
      .filter(([c]) => c === "session_import_close")
      .map(([, w]) => w),
  ).toEqual(
    targets.slice(0, 2).map((t) => ({
      agentId: t.agentId,
      cwd: t.cwd,
      sessionId: t.nativeSessionId,
      previewToken: `exact-${t.nativeSessionId}`,
    })),
  );
  expect(answer.hits).toHaveLength(4);
  expect(answer.rows.map((r) => r.coverage)).toEqual([
    "completeReturnedPrefix",
    "completeReturnedPrefix",
  ]);
  expect(answer.rows.every((r) => r.sourceStatus === "sourceUnconfirmed")).toBe(
    true,
  );
  expect(answer.hits.some((hit) => hit.text.includes("late unsealed"))).toBe(
    false,
  );
  expect(
    answer.hits.every(
      (hit) =>
        !Object.hasOwn(hit, "itemId") &&
        !Object.hasOwn(hit, "messageLocator") &&
        hit.locator.kind === "returnedText",
    ),
  ).toBe(true);
  expect(answer).toMatchObject({
    source: "officialSessionLoad",
    coverageScope: "acknowledgedLoadPrefix",
    textScope: "returnedVisibleFields",
    matchMode: "ecmascriptUnicodeLiteral",
    settled: true,
    pendingCleanup: null,
  });
});

it("distinguishes an acknowledged empty prefix from a wrong-purpose reply without searching partial body", async () => {
  h.invoke.mockImplementation(async (command: string, wire: Wire) => {
    if (command === "session_import_close") return;
    if (wire.sessionId === "native-two")
      text(wire, "hello forbidden wrong-purpose body");
    marker(wire);
    return result(
      wire,
      wire.sessionId === "native-two" ? "importPreview" : "searchReadOnly",
    );
  });
  const answer = await readSelectedHistory(input());
  expect(answer.rows.map((r) => r.coverage)).toEqual([
    "completeEmpty",
    "incomplete",
  ]);
  expect(answer.hits).toEqual([]);
  expect(commands()).toEqual([
    "session_read_preview",
    "session_import_close",
    "session_read_preview",
    "session_import_close",
  ]);
});

it("keeps missing-marker history ineligible and closes its exact returned owner", async () => {
  vi.useFakeTimers();
  respond((wire) => text(wire, "hello incomplete"));
  const pending = readSelectedHistory(input({ targets: targets.slice(0, 1) }));
  await vi.runAllTimersAsync();
  const answer = await pending;
  expect(answer.rows[0]).toMatchObject({
    coverage: "incomplete",
    code: "coverageUnconfirmed",
  });
  expect(answer.hits).toEqual([]);
  expect(commands()).toEqual(["session_read_preview", "session_import_close"]);
});

it("retains only four-field cleanup authority after a rejected close and never reads the next selected row", async () => {
  let reject!: (reason: unknown) => void;
  const progress: HistoryReadOperation[] = [];
  h.invoke.mockImplementation((command: string, wire: Wire) => {
    if (command === "session_read_preview") {
      text(wire, "hello");
      marker(wire);
      return Promise.resolve(result(wire));
    }
    if (command === "session_import_close")
      return new Promise((_resolve, no) => {
        reject = no;
      });
    throw new Error("Unexpected command");
  });
  const pending = readSelectedHistory(
    input({ onProgress: (p) => progress.push(p) }),
  );
  await vi.waitFor(() =>
    expect(commands()).toEqual([
      "session_read_preview",
      "session_import_close",
    ]),
  );
  expect(progress.at(-1)).toMatchObject({ state: "settling", settled: false });
  reject(new Error("controlled close unknown"));
  const answer = await pending;
  expect(answer).toMatchObject({
    state: "pendingCleanup",
    settled: false,
    code: "pendingCleanup",
    pendingCleanup: {
      rowId: "one",
      receipt: {
        agentId: "owned",
        cwd: "/owned",
        nativeSessionId: "native-one",
        previewToken: "exact-native-one",
      },
    },
  });
  expect(Object.keys(answer.pendingCleanup!.receipt).sort()).toEqual([
    "agentId",
    "cwd",
    "nativeSessionId",
    "previewToken",
  ]);
  expect(answer.rows[1].coverage).toBe("unread");
  expect(commands()).toHaveLength(2);
});

it("discards a retired late body, closes only its own receipt and never dispatches the next load", async () => {
  let finish!: () => void;
  let interested = true;
  const abort = new AbortController();
  h.invoke.mockImplementation((command: string, wire: Wire) => {
    if (command === "session_read_preview")
      return new Promise((resolve) => {
        finish = () => {
          text(wire, "hello late body");
          marker(wire);
          resolve(result(wire));
        };
      });
    if (command === "session_import_close") return Promise.resolve();
    throw new Error("Unexpected command");
  });
  const pending = readSelectedHistory(
    input({ current: () => interested, signal: abort.signal }),
  );
  interested = false;
  abort.abort();
  finish();
  const answer = await pending;
  expect(answer.hits).toEqual([]);
  expect(answer.rows[1].coverage).toBe("unread");
  expect(commands()).toEqual(["session_read_preview", "session_import_close"]);
  expect(answer.settled).toBe(true);
});

it("does not turn an unknown rejected invoke with no receipt into cleanup confirmation", async () => {
  h.invoke.mockRejectedValue(new Error("controlled lost reply"));
  const answer = await readSelectedHistory(input());
  expect(answer).toMatchObject({
    state: "unconfirmed",
    settled: false,
    pendingCleanup: null,
  });
  expect(answer.rows[0].coverage).toBe("incomplete");
  expect(answer.rows[1].coverage).toBe("unread");
  expect(commands()).toEqual(["session_read_preview"]);
});

it("uses original UTF-16 offsets for Unicode literal matches and returns the visible Markdown field", async () => {
  respond((wire) => {
    text(wire, "İ🙂 **K** exact visible field");
    marker(wire);
  });
  const answer = await readSelectedHistory(
    input({ query: "K", targets: targets.slice(0, 1) }),
  );
  expect(answer.hits[0].text).toBe("İ🙂 K exact visible field");
  expect(answer.hits[0].matches).toEqual([{ start: 4, end: 5 }]);
  expect(answer.hits[0].text.slice(4, 5)).toBe("K");
});

it("does not invent a word across a user media gap or treat the query as a regular expression", async () => {
  respond((wire) => {
    text(wire, "left[@image](data:image/png;base64,AQ==)RIGHT a.b", "user");
    marker(wire);
  });
  const joined = await readSelectedHistory(
    input({ query: "leftRIGHT", targets: targets.slice(0, 1) }),
  );
  expect(joined.hits).toEqual([]);
  const literal = await readSelectedHistory(
    input({ query: ".", targets: targets.slice(0, 1) }),
  );
  expect(literal.hits).toHaveLength(1);
  expect(
    literal.hits[0].matches.map((m) =>
      literal.hits[0].text.slice(m.start, m.end),
    ),
  ).toEqual(["."]);
});

it("reports an omitted oversized body instead of claiming complete empty history", async () => {
  respond((wire) => {
    text(wire, "x".repeat(HISTORY_READ_LIMITS.fieldCharacters + 1), "user");
    marker(wire);
  });
  const answer = await readSelectedHistory(
    input({ targets: targets.slice(0, 1) }),
  );
  expect(answer.rows[0]).toMatchObject({
    coverage: "limited",
    skippedFields: 1,
    code: "outputLimit",
  });
  expect(answer.hits).toEqual([]);
  expect(commands()).toEqual(["session_read_preview", "session_import_close"]);
});

it("bounds hits, marks omitted fields and leaves later selected rows unread without another load", async () => {
  const body = Array.from(
    { length: HISTORY_READ_LIMITS.hits + 1 },
    () => "hello",
  ).join("\n\n");
  const visible = loadedMarkdownFields(body);
  expect(visible).toHaveLength(401);
  expect(visible.filter((field) => field === "hello")).toHaveLength(201);
  expect(visible.filter((field) => field === "\n")).toHaveLength(200);
  respond((wire) => {
    text(wire, body);
    marker(wire);
  });
  const answer = await readSelectedHistory(input());
  expect(answer.hits).toHaveLength(HISTORY_READ_LIMITS.hits);
  expect(answer.rows[0]).toMatchObject({
    coverage: "limited",
    code: "resultLimit",
    // The unvisited newline field and final matching paragraph both count.
    skippedFields: 2,
  });
  expect(answer.rows[1].coverage).toBe("unread");
  expect(commands()).toEqual(["session_read_preview", "session_import_close"]);
});

it("still exact-closes an acquired owner if the result view fails while settling", async () => {
  respond();
  const answer = await readSelectedHistory(
    input({
      onProgress: (p) => {
        if (p.state === "settling") throw new Error("controlled retired view");
      },
    }),
  );
  expect(commands()).toEqual(["session_read_preview", "session_import_close"]);
  expect(answer.hits).toEqual([]);
  expect(answer.rows[1].coverage).toBe("unread");
});
